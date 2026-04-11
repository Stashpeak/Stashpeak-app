use async_trait::async_trait;
use chrono::{Datelike, Duration, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;

use crate::connectors::{ConnectorError, SpendConnector, SpendData};
use crate::secrets;

const COSTS_URL: &str = "https://api.openai.com/v1/organization/costs";
const LEGACY_USAGE_URL: &str = "https://api.openai.com/v1/usage";

/// Connector for the OpenAI provider.
///
/// Primary endpoint: `GET https://api.openai.com/v1/organization/costs`
/// Requires an API key with **usage read** scope (not a project key).
/// Uses Unix timestamps for date range parameters.
///
/// Falls back to the legacy `GET /v1/usage?date=YYYY-MM-DD` endpoint if the
/// primary returns 404. The legacy endpoint does not expose cost data, so it
/// returns 0.0 for the affected period with a logged warning.
pub struct OpenAiConnector {
    client: Client,
}

impl OpenAiConnector {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    async fn fetch_period_cost(
        &self,
        api_key: &str,
        start_time: i64,
        end_time: i64,
    ) -> Result<f64, ConnectorError> {
        tracing::debug!(
            provider = "openai",
            start_time,
            end_time,
            "fetching costs via primary endpoint"
        );

        let response = self
            .client
            .get(COSTS_URL)
            .header("Authorization", format!("Bearer {api_key}"))
            .query(&[
                ("start_time", start_time.to_string()),
                ("end_time", end_time.to_string()),
                ("bucket_width", "1d".to_string()),
            ])
            .send()
            .await
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        let status = response.status();

        // 404 means the org does not have access to the new costs endpoint yet;
        // fall back to the legacy endpoint gracefully rather than surfacing an error.
        if status.as_u16() == 404 {
            tracing::warn!(
                provider = "openai",
                "primary costs endpoint returned 404 -- falling back to legacy /v1/usage"
            );
            return self.fetch_legacy_period(api_key, start_time).await;
        }

        match status.as_u16() {
            401 | 403 => return Err(ConnectorError::Unauthorized),
            429 => return Err(ConnectorError::RateLimited),
            s if s >= 400 => {
                let body = response.text().await.unwrap_or_default();
                return Err(ConnectorError::ApiError { status: s, body });
            }
            _ => {}
        }

        let parsed: CostsResponse =
            response
                .json()
                .await
                .map_err(|e| ConnectorError::ApiError {
                    status: status.as_u16(),
                    body: format!("failed to parse costs response: {e}"),
                })?;

        let total: f64 = parsed
            .data
            .iter()
            .flat_map(|bucket| &bucket.results)
            .map(|r| r.amount.value)
            .sum();

        Ok(total)
    }

    /// Legacy fallback: `GET /v1/usage?date=YYYY-MM-DD`.
    ///
    /// The legacy endpoint returns token usage but not cost data. We log a
    /// warning and return 0.0 rather than failing — the UI stale indicator
    /// will not trigger, but the spend field will show 0 until the user's
    /// account is migrated to the new endpoint.
    async fn fetch_legacy_period(
        &self,
        api_key: &str,
        start_time: i64,
    ) -> Result<f64, ConnectorError> {
        let date = chrono::DateTime::from_timestamp(start_time, 0)
            .map(|dt| dt.format("%Y-%m-%d").to_string())
            .unwrap_or_default();

        tracing::debug!(provider = "openai", date, "fetching legacy usage");

        let response = self
            .client
            .get(LEGACY_USAGE_URL)
            .header("Authorization", format!("Bearer {api_key}"))
            .query(&[("date", &date)])
            .send()
            .await
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        let status = response.status();
        match status.as_u16() {
            401 | 403 => return Err(ConnectorError::Unauthorized),
            429 => return Err(ConnectorError::RateLimited),
            s if s >= 400 => {
                let body = response.text().await.unwrap_or_default();
                return Err(ConnectorError::ApiError { status: s, body });
            }
            _ => {}
        }

        let _ = response.text().await; // consume body to avoid connection leaks

        tracing::warn!(
            provider = "openai",
            "legacy /v1/usage endpoint does not expose cost data; reporting 0.0"
        );
        Ok(0.0)
    }
}

// ── Response shapes ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CostsResponse {
    data: Vec<CostBucket>,
}

#[derive(Deserialize)]
struct CostBucket {
    results: Vec<CostResult>,
}

#[derive(Deserialize)]
struct CostResult {
    amount: CostAmount,
}

#[derive(Deserialize)]
struct CostAmount {
    value: f64,
}

// ── SpendConnector impl ──────────────────────────────────────────────────────

#[async_trait]
impl SpendConnector for OpenAiConnector {
    fn provider_id(&self) -> &'static str {
        "openai"
    }

    async fn fetch(&self) -> Result<SpendData, ConnectorError> {
        // Keychain access is a blocking OS call — run it on the thread pool.
        let api_key = tauri::async_runtime::spawn_blocking(|| {
            secrets::get_provider_api_key("openai")
                .map_err(|e| ConnectorError::Config(e.to_string()))
                .and_then(|opt| opt.ok_or(ConnectorError::Unauthorized))
        })
        .await
        .map_err(|e| ConnectorError::Config(format!("keychain task failed: {e}")))??;

        let now = Utc::now();

        // Current month: first of this month → now
        let current_start = Utc
            .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
            .unwrap();

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

        let current_month_usd =
            self.fetch_period_cost(&*api_key, current_start.timestamp(), now.timestamp())
                .await?;

        let previous_month_usd =
            self.fetch_period_cost(&*api_key, prev_start.timestamp(), prev_end.timestamp())
                .await?;

        tracing::debug!(
            provider = "openai",
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
    fn parses_costs_response_and_sums_buckets() {
        let json = r#"{
            "data": [
                {"results": [{"amount": {"value": 1.50}}, {"amount": {"value": 0.75}}]},
                {"results": [{"amount": {"value": 2.25}}]}
            ]
        }"#;
        let parsed: CostsResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed
            .data
            .iter()
            .flat_map(|b| &b.results)
            .map(|r| r.amount.value)
            .sum();
        assert!((total - 4.50).abs() < 0.001, "got {total}");
    }

    #[test]
    fn handles_empty_costs_response() {
        let json = r#"{"data": []}"#;
        let parsed: CostsResponse = serde_json::from_str(json).unwrap();
        let total: f64 = parsed
            .data
            .iter()
            .flat_map(|b| &b.results)
            .map(|r| r.amount.value)
            .sum();
        assert_eq!(total, 0.0);
    }
}
