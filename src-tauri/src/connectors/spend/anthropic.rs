use async_trait::async_trait;
use chrono::{Datelike, Duration, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;

use crate::connectors::{ConnectorError, SpendConnector, SpendData};
use crate::secrets;

const COST_REPORT_URL: &str = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Connector for the Anthropic provider.
///
/// Requires an **Admin API key** — not a regular user key. Admin keys begin
/// with `sk-ant-admin-` and are only available to the org owner/admin in the
/// Anthropic Console. A regular `sk-ant-api-` key will return 401.
///
/// Endpoint: `GET https://api.anthropic.com/v1/organizations/cost_report`
/// Two requests are made per fetch: one for the current month and one for
/// the previous month. Response uses `results` (not `data`) with per-entry
/// cost fields extracted via extract_cost().
pub struct AnthropicConnector {
    client: Client,
}

impl AnthropicConnector {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    async fn fetch_period_cost(
        &self,
        api_key: &str,
        starting_at: &str,
        ending_at: &str,
    ) -> Result<f64, ConnectorError> {
        tracing::debug!(
            provider = "anthropic",
            starting_at,
            ending_at,
            "fetching cost report"
        );

        let mut total_usd: f64 = 0.0;
        let mut next_page: Option<String> = None;
        let mut first_nonempty_checked = false;
        let mut page_count = 0u32;
        const MAX_PAGES: u32 = 50;

        loop {
            if page_count >= MAX_PAGES {
                tracing::warn!(
                    provider = "anthropic",
                    starting_at,
                    ending_at,
                    "hit page limit of {MAX_PAGES}, stopping pagination"
                );
                break;
            }
            page_count += 1;
            let mut query: Vec<(&str, &str)> =
                vec![("starting_at", starting_at), ("ending_at", ending_at)];
            let page_val; // keep owned string alive for the borrow
            if let Some(ref p) = next_page {
                page_val = p.clone();
                query.push(("page", &page_val));
            }

            let response = self
                .client
                .get(COST_REPORT_URL)
                .header("x-api-key", api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .query(&query)
                .send()
                .await
                .map_err(|e| ConnectorError::Network(e.to_string()))?;

            let status = response.status().as_u16();

            // Preserve the original per-arm body handling exactly: 401/403/429
            // are terminal and decided from the status code alone (never read
            // the body, so a body-read failure cannot turn an admin-key
            // rejection into a retry); the generic >=400 arm reads the body
            // failure-tolerantly for its ApiError message; only a 2xx response
            // reads the body fallibly (a transport failure there is Network).
            match status {
                401 | 403 | 429 => {
                    return Err(classify_status(status, "")
                        .expect("401/403/429 always classify to a terminal error"));
                }
                s if s >= 400 => {
                    let body = response.text().await.unwrap_or_default();
                    return Err(ConnectorError::ApiError { status: s, body });
                }
                _ => {}
            }

            let bytes = response
                .bytes()
                .await
                .map_err(|e| ConnectorError::Network(e.to_string()))?;

            tracing::debug!(
                provider = "anthropic",
                page = next_page.as_deref().unwrap_or("first"),
                body = %String::from_utf8_lossy(&bytes),
                "cost report page"
            );

            let parsed = deserialize_cost_report(status, &bytes)?;

            if !first_nonempty_checked {
                match first_result_cost_check(&parsed) {
                    FirstResultCheck::MissingCost(keys) => {
                        return Err(ConnectorError::ApiError {
                            status: 200,
                            body: format!("no cost field found. Result entry keys: {keys:?}"),
                        });
                    }
                    FirstResultCheck::HasCost => first_nonempty_checked = true,
                    FirstResultCheck::NoResults => {}
                }
            }

            total_usd += page_total_usd(&parsed);

            if parsed.has_more {
                next_page = parsed.next_page;
            } else {
                break;
            }
        }

        Ok(total_usd)
    }
}

// ── Response shapes ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CostReportResponse {
    data: Vec<PeriodEntry>,
    #[serde(default)]
    has_more: bool,
    next_page: Option<String>,
}

#[derive(Deserialize)]
struct PeriodEntry {
    results: Vec<serde_json::Value>,
}

/// Costs in the API response are in cents. Convert to USD by dividing by 100.
fn extract_cost(entry: &serde_json::Value) -> Option<f64> {
    let cents = extract_cost_cents(entry)?;
    Some(cents / 100.0)
}

fn extract_cost_cents(entry: &serde_json::Value) -> Option<f64> {
    for field in &["cost", "total_cost", "amount", "amount_usd"] {
        if let Some(v) = entry.get(field) {
            if let Some(f) = v.as_f64() {
                return Some(f);
            }
            if let Some(f) = v.as_str().and_then(|s| s.parse::<f64>().ok()) {
                return Some(f);
            }
        }
    }
    let input = entry.get("input_cost").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let output = entry.get("output_cost").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if input > 0.0 || output > 0.0 {
        return Some(input + output);
    }
    None
}

// ── Pure response handling (offline-testable; see #118 parity harness) ────────

/// Map an HTTP status to a terminal [`ConnectorError`], or `None` to proceed to
/// body parsing. Anthropic maps 401/403 to a `Config` error (admin-key guidance)
/// rather than `Unauthorized`. This is the response→error contract the registry
/// inversion (#123) must preserve unchanged.
fn classify_status(status: u16, body: &str) -> Option<ConnectorError> {
    match status {
        401 | 403 => Some(ConnectorError::Config(
            "Requires an Admin API key (sk-ant-admin-…), not a regular user key. \
             Generate one in Anthropic Console → Settings → API Keys → Create Key → Role: Admin."
                .to_string(),
        )),
        429 => Some(ConnectorError::RateLimited),
        s if s >= 400 => Some(ConnectorError::ApiError {
            status: s,
            body: body.to_string(),
        }),
        _ => None,
    }
}

/// Deserialize one cost-report page body.
fn deserialize_cost_report(status: u16, body: &[u8]) -> Result<CostReportResponse, ConnectorError> {
    serde_json::from_slice(body).map_err(|e| ConnectorError::ApiError {
        status,
        body: format!("failed to parse cost report wrapper: {e}"),
    })
}

/// Sum the per-result costs (USD) across one page.
fn page_total_usd(page: &CostReportResponse) -> f64 {
    page.data
        .iter()
        .flat_map(|p| p.results.iter())
        .filter_map(extract_cost)
        .sum()
}

/// Outcome of inspecting the first result of the first non-empty page — used to
/// reject a response whose result shape has no recognizable cost field.
enum FirstResultCheck {
    NoResults,
    HasCost,
    MissingCost(Vec<String>),
}

fn first_result_cost_check(page: &CostReportResponse) -> FirstResultCheck {
    match page.data.iter().flat_map(|p| p.results.iter()).next() {
        None => FirstResultCheck::NoResults,
        Some(entry) if extract_cost(entry).is_some() => FirstResultCheck::HasCost,
        Some(entry) => FirstResultCheck::MissingCost(
            entry
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default(),
        ),
    }
}

// ── SpendConnector impl ──────────────────────────────────────────────────────

#[async_trait]
impl SpendConnector for AnthropicConnector {
    fn provider_id(&self) -> &'static str {
        "anthropic"
    }

    async fn fetch(&self) -> Result<SpendData, ConnectorError> {
        // Keychain access is a blocking OS call — run it on the thread pool.
        let api_key = tauri::async_runtime::spawn_blocking(|| {
            secrets::get_provider_api_key("anthropic")
                .map_err(|e| ConnectorError::Config(e.to_string()))
                .and_then(|opt| opt.ok_or(ConnectorError::Unauthorized))
        })
        .await
        .map_err(|e| ConnectorError::Config(format!("keychain task failed: {e}")))??;

        let now = Utc::now();

        let current_start = Utc
            .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
            .unwrap();
        let current_month_usd = self
            .fetch_period_cost(&*api_key, &current_start.to_rfc3339(), &now.to_rfc3339())
            .await?;

        let (prev_year, prev_month) = if now.month() == 1 {
            (now.year() - 1, 12u32)
        } else {
            (now.year(), now.month() - 1)
        };
        let prev_start = Utc
            .with_ymd_and_hms(prev_year, prev_month, 1, 0, 0, 0)
            .unwrap();
        let prev_end = current_start - Duration::seconds(1);
        let previous_month_usd = self
            .fetch_period_cost(&*api_key, &prev_start.to_rfc3339(), &prev_end.to_rfc3339())
            .await?;

        tracing::debug!(
            provider = "anthropic",
            current_month_usd,
            previous_month_usd,
            "spend fetch successful"
        );

        Ok(SpendData {
            current_month_usd,
            previous_month_usd,
            last_activity_at: None,
        })
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Note: extract_cost returns USD (cents / 100). Test values reflect cents input → dollar output.

    #[test]
    fn extracts_amount_as_string() {
        // 0.315 cents → $0.00315
        let entry = serde_json::json!({"amount": "0.315", "currency": "USD", "token_type": "input"});
        assert!((extract_cost(&entry).unwrap() - 0.00315).abs() < 1e-9);
    }

    #[test]
    fn extracts_cost_field() {
        // 1050 cents → $10.50
        let entry = serde_json::json!({"cost": 1050.0, "model": "claude-3-5-sonnet"});
        assert!((extract_cost(&entry).unwrap() - 10.5).abs() < 0.001);
    }

    #[test]
    fn extracts_input_output_cost_split() {
        // 300 + 150 cents → $4.50
        let entry = serde_json::json!({"input_cost": 300.0, "output_cost": 150.0});
        assert!((extract_cost(&entry).unwrap() - 4.5).abs() < 0.001);
    }

    #[test]
    fn returns_none_for_unknown_fields() {
        let entry = serde_json::json!({"model": "claude-3-5-sonnet", "tokens": 1000});
        assert!(extract_cost(&entry).is_none());
    }

    #[test]
    fn sums_across_nested_results() {
        // 1000 + 500 + 250.5 cents = 1750.5 cents → $17.505
        let body = br#"{"data": [
            {"starting_at": "2026-04-01", "ending_at": "2026-04-11", "results": [{"cost": 1000.0}, {"cost": 500.0}]},
            {"starting_at": "2026-03-01", "ending_at": "2026-03-31", "results": [{"cost": 250.5}]}
        ], "has_more": false}"#;
        let page = deserialize_cost_report(200, body).unwrap();
        assert!((page_total_usd(&page) - 17.505).abs() < 0.001);
        assert!(matches!(first_result_cost_check(&page), FirstResultCheck::HasCost));
    }

    #[test]
    fn handles_empty_cost_report() {
        let page = deserialize_cost_report(200, br#"{"data": []}"#).unwrap();
        assert_eq!(page_total_usd(&page), 0.0);
        assert!(matches!(first_result_cost_check(&page), FirstResultCheck::NoResults));
    }

    #[test]
    fn preserves_pagination_signals() {
        let page = deserialize_cost_report(
            200,
            br#"{"data": [{"results": [{"cost": 100.0}]}], "has_more": true, "next_page": "page-2"}"#,
        )
        .unwrap();
        assert!(page.has_more);
        assert_eq!(page.next_page.as_deref(), Some("page-2"));
    }

    #[test]
    fn flags_first_result_with_no_cost_field() {
        let page = deserialize_cost_report(
            200,
            br#"{"data": [{"results": [{"model": "claude", "tokens": 1000}]}]}"#,
        )
        .unwrap();
        match first_result_cost_check(&page) {
            FirstResultCheck::MissingCost(keys) => {
                assert!(keys.contains(&"model".to_string()));
                assert!(keys.contains(&"tokens".to_string()));
            }
            _ => panic!("expected MissingCost"),
        }
    }

    #[test]
    fn deserialize_failure_surfaces_as_api_error() {
        let result = deserialize_cost_report(200, b"not json");
        assert!(matches!(
            result,
            Err(ConnectorError::ApiError { status: 200, .. })
        ));
    }

    #[test]
    fn maps_admin_key_rejection_to_config_not_unauthorized() {
        assert!(matches!(classify_status(401, ""), Some(ConnectorError::Config(_))));
        assert!(matches!(classify_status(403, ""), Some(ConnectorError::Config(_))));
        assert!(matches!(classify_status(429, ""), Some(ConnectorError::RateLimited)));
        assert!(matches!(
            classify_status(500, "boom"),
            Some(ConnectorError::ApiError { status: 500, .. })
        ));
        assert!(classify_status(200, "").is_none());
    }
}
