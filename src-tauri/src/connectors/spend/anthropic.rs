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

            let status = response.status();
            match status.as_u16() {
                401 | 403 => {
                    return Err(ConnectorError::Config(
                        "Requires an Admin API key (sk-ant-admin-…), not a regular user key. \
                         Generate one in Anthropic Console → Settings → API Keys → Create Key → Role: Admin."
                            .to_string(),
                    ))
                }
                429 => return Err(ConnectorError::RateLimited),
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

            let parsed: CostReportResponse =
                serde_json::from_slice(&bytes).map_err(|e| ConnectorError::ApiError {
                    status: status.as_u16(),
                    body: format!("failed to parse cost report wrapper: {e}"),
                })?;

            let page_results: Vec<&serde_json::Value> =
                parsed.data.iter().flat_map(|p| p.results.iter()).collect();

            if !first_nonempty_checked {
                if let Some(first) = page_results.first() {
                    if extract_cost(first).is_none() {
                        let keys: Vec<&str> = first
                            .as_object()
                            .map(|o| o.keys().map(String::as_str).collect())
                            .unwrap_or_default();
                        return Err(ConnectorError::ApiError {
                            status: 200,
                            body: format!("no cost field found. Result entry keys: {keys:?}"),
                        });
                    }
                    first_nonempty_checked = true;
                }
            }

            total_usd += page_results.iter().filter_map(|e| extract_cost(e)).sum::<f64>();

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
        let json = r#"{"data": [
            {"starting_at": "2026-04-01", "ending_at": "2026-04-11", "results": [{"cost": 1000.0}, {"cost": 500.0}]},
            {"starting_at": "2026-03-01", "ending_at": "2026-03-31", "results": [{"cost": 250.5}]}
        ], "has_more": false}"#;
        let parsed: CostReportResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed.data.iter().flat_map(|p| p.results.iter()).filter_map(extract_cost).sum();
        assert!((total - 17.505).abs() < 0.001, "got {total}");
    }

    #[test]
    fn handles_empty_cost_report() {
        let json = r#"{"data": []}"#;
        let parsed: CostReportResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed.data.iter().flat_map(|p| p.results.iter()).filter_map(extract_cost).sum();
        assert_eq!(total, 0.0);
    }
}
