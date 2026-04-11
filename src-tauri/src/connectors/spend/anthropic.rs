use chrono::{Datelike, Duration, TimeZone, Utc};
use reqwest::blocking::Client;
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

    fn fetch_period_cost(
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

        let response = self
            .client
            .get(COST_REPORT_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .query(&[("starting_at", starting_at), ("ending_at", ending_at)])
            .send()
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        let status = response.status();
        match status.as_u16() {
            401 | 403 => return Err(ConnectorError::Config(
                "Requires an Admin API key (sk-ant-admin-…), not a regular user key. \
                 Generate one in Anthropic Console → Settings → API Keys → Create Key → Role: Admin."
                    .to_string(),
            )),
            429 => return Err(ConnectorError::RateLimited),
            s if s >= 400 => {
                let body = response.text().unwrap_or_default();
                return Err(ConnectorError::ApiError { status: s, body });
            }
            _ => {}
        }

        let bytes = response
            .bytes()
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        tracing::info!(
            provider = "anthropic",
            body = %String::from_utf8_lossy(&bytes),
            "raw cost report response"
        );

        let parsed: CostReportResponse =
            serde_json::from_slice(&bytes).map_err(|e| ConnectorError::ApiError {
                status: status.as_u16(),
                body: format!("failed to parse cost report wrapper: {e}"),
            })?;

        let total_usd: f64 = if parsed.results.is_empty() {
            0.0
        } else {
            let first = &parsed.results[0];
            if extract_cost(first).is_none() {
                let keys: Vec<&str> = first
                    .as_object()
                    .map(|o| o.keys().map(String::as_str).collect())
                    .unwrap_or_default();
                return Err(ConnectorError::ApiError {
                    status: 200,
                    body: format!("no cost field found. Entry keys: {keys:?}"),
                });
            }
            parsed.results.iter().filter_map(extract_cost).sum()
        };

        Ok(total_usd)
    }
}

// ── Response shapes ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CostReportResponse {
    results: Vec<serde_json::Value>,
}

fn extract_cost(entry: &serde_json::Value) -> Option<f64> {
    for field in &["cost", "total_cost", "amount", "amount_usd"] {
        if let Some(v) = entry.get(field).and_then(|v| v.as_f64()) {
            return Some(v);
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

impl SpendConnector for AnthropicConnector {
    fn provider_id(&self) -> &'static str {
        "anthropic"
    }

    fn fetch(&self) -> Result<SpendData, ConnectorError> {
        let api_key = secrets::get_provider_api_key("anthropic")
            .map_err(|e| ConnectorError::Config(e.to_string()))?
            .ok_or(ConnectorError::Unauthorized)?;

        let now = Utc::now();

        // Current month: first of this month → now
        let current_start = Utc
            .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
            .unwrap();
        let current_month_usd =
            self.fetch_period_cost(&api_key, &current_start.to_rfc3339(), &now.to_rfc3339())?;

        // Previous month: first of last month → last second of last month
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
            .fetch_period_cost(&api_key, &prev_start.to_rfc3339(), &prev_end.to_rfc3339())?;

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

    #[test]
    fn extracts_cost_field() {
        let entry = serde_json::json!({"cost": 10.5, "model": "claude-3-5-sonnet"});
        assert!((extract_cost(&entry).unwrap() - 10.5).abs() < 0.001);
    }

    #[test]
    fn extracts_input_output_cost_split() {
        let entry = serde_json::json!({"input_cost": 3.0, "output_cost": 1.5});
        assert!((extract_cost(&entry).unwrap() - 4.5).abs() < 0.001);
    }

    #[test]
    fn returns_none_for_unknown_fields() {
        let entry = serde_json::json!({"model": "claude-3-5-sonnet", "tokens": 1000});
        assert!(extract_cost(&entry).is_none());
    }

    #[test]
    fn sums_across_entries() {
        let json = r#"{"results": [{"cost": 10.0}, {"cost": 5.0}, {"cost": 2.505}]}"#;
        let parsed: CostReportResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed.results.iter().filter_map(extract_cost).sum();
        assert!((total - 17.505).abs() < 0.001, "got {total}");
    }

    #[test]
    fn handles_empty_cost_report() {
        let json = r#"{"results": []}"#;
        let parsed: CostReportResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed.results.iter().filter_map(extract_cost).sum();
        assert_eq!(total, 0.0);
    }
}
