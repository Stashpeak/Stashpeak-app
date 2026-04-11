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
/// the previous month. Costs are returned in cents as decimal strings and
/// converted to USD.
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

        let parsed: CostReportResponse =
            response.json().map_err(|e| ConnectorError::ApiError {
                status: status.as_u16(),
                body: format!("failed to parse cost report: {e}"),
            })?;

        // Costs are decimal strings in cents (e.g. "1234.56" = $12.3456).
        let total_usd: f64 = parsed
            .data
            .iter()
            .filter_map(|e| e.cost.parse::<f64>().ok())
            .sum::<f64>()
            / 100.0;

        Ok(total_usd)
    }
}

// ── Response shapes ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CostReportResponse {
    data: Vec<CostEntry>,
}

#[derive(Deserialize)]
struct CostEntry {
    /// Cost in cents as a decimal string (e.g. "1234.56").
    cost: String,
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
    fn parses_cost_report_and_converts_cents_to_usd() {
        let json = r#"{"data": [{"cost": "1000.00"}, {"cost": "500.00"}, {"cost": "250.50"}]}"#;
        let parsed: CostReportResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed
            .data
            .iter()
            .filter_map(|e| e.cost.parse::<f64>().ok())
            .sum::<f64>()
            / 100.0;
        // 1000 + 500 + 250.50 = 1750.50 cents = $17.505
        assert!((total - 17.505).abs() < 0.001, "got {total}");
    }

    #[test]
    fn handles_empty_cost_report() {
        let json = r#"{"data": []}"#;
        let parsed: CostReportResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed
            .data
            .iter()
            .filter_map(|e| e.cost.parse::<f64>().ok())
            .sum::<f64>()
            / 100.0;
        assert_eq!(total, 0.0);
    }

    #[test]
    fn skips_unparseable_cost_entries() {
        let json = r#"{"data": [{"cost": "500.00"}, {"cost": "not-a-number"}]}"#;
        let parsed: CostReportResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed
            .data
            .iter()
            .filter_map(|e| e.cost.parse::<f64>().ok())
            .sum::<f64>()
            / 100.0;
        assert!((total - 5.0).abs() < 0.001, "got {total}");
    }
}
