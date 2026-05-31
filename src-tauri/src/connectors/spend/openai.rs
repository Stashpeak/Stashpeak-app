use async_trait::async_trait;
use chrono::{Datelike, Duration, TimeZone, Utc};
use serde::Deserialize;

use crate::connectors::{
    Auth, ConnectorCtx, ConnectorError, ConnectorRequest, SpendConnector, SpendData,
};

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
pub struct OpenAiConnector;

impl OpenAiConnector {
    async fn fetch_period_cost(
        &self,
        ctx: &ConnectorCtx,
        start_time: i64,
        end_time: i64,
    ) -> Result<f64, ConnectorError> {
        tracing::debug!(
            provider = "openai",
            start_time,
            end_time,
            "fetching costs via primary endpoint"
        );

        let (status, bytes) = ctx
            .send(
                ConnectorRequest::get(COSTS_URL)
                    .auth(Auth::Bearer)
                    .query_pair("start_time", start_time.to_string())
                    .query_pair("end_time", end_time.to_string())
                    .query_pair("bucket_width", "1d"),
            )
            .await?;

        // 404 means the org does not have access to the new costs endpoint yet;
        // fall back to the legacy endpoint gracefully rather than surfacing an
        // error. Decided from the raw status before any classification, exactly
        // as before — ctx.send returns 404 as Ok((404, _)), not an error.
        if status == 404 {
            tracing::warn!(
                provider = "openai",
                "primary costs endpoint returned 404 -- falling back to legacy /v1/usage"
            );
            return self.fetch_legacy_period(ctx, start_time).await;
        }

        if let Some(err) = classify_status(status, &String::from_utf8_lossy(&bytes)) {
            return Err(err);
        }

        parse_costs(status, &bytes)
    }

    /// Legacy fallback: `GET /v1/usage?date=YYYY-MM-DD`.
    ///
    /// The legacy endpoint returns token usage but not cost data. We log a
    /// warning and return 0.0 rather than failing — the UI stale indicator
    /// will not trigger, but the spend field will show 0 until the user's
    /// account is migrated to the new endpoint.
    async fn fetch_legacy_period(
        &self,
        ctx: &ConnectorCtx,
        start_time: i64,
    ) -> Result<f64, ConnectorError> {
        let date = chrono::DateTime::from_timestamp(start_time, 0)
            .map(|dt| dt.format("%Y-%m-%d").to_string())
            .unwrap_or_default();

        tracing::debug!(provider = "openai", date, "fetching legacy usage");

        let (status, bytes) = ctx
            .send(
                ConnectorRequest::get(LEGACY_USAGE_URL)
                    .auth(Auth::Bearer)
                    .query_pair("date", date),
            )
            .await?;

        // The legacy endpoint exposes no cost data, so a successful response
        // still reports 0.0; reuse the shared status classifier for errors.
        if let Some(err) = classify_status(status, &String::from_utf8_lossy(&bytes)) {
            return Err(err);
        }

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

// ── Pure response handling (offline-testable; see #118 parity harness) ────────

/// Map an HTTP status to a terminal [`ConnectorError`], or `None` to proceed to
/// body parsing. NOTE: status 404 is handled by the caller *before* this (it
/// triggers the legacy-endpoint fallback rather than an error). This is the
/// response→error contract the registry inversion (#123) must preserve.
fn classify_status(status: u16, body: &str) -> Option<ConnectorError> {
    match status {
        401 | 403 => Some(ConnectorError::Unauthorized),
        429 => Some(ConnectorError::RateLimited),
        s if s >= 400 => Some(ConnectorError::ApiError {
            status: s,
            body: body.to_string(),
        }),
        _ => None,
    }
}

/// Sum all per-bucket cost amounts (USD) from the `/organization/costs` body.
fn parse_costs(status: u16, body: &[u8]) -> Result<f64, ConnectorError> {
    let parsed: CostsResponse =
        serde_json::from_slice(body).map_err(|e| ConnectorError::ApiError {
            status,
            body: format!("failed to parse costs response: {e}"),
        })?;

    Ok(parsed
        .data
        .iter()
        .flat_map(|bucket| &bucket.results)
        .map(|r| r.amount.value)
        .sum())
}

// ── SpendConnector impl ──────────────────────────────────────────────────────

#[async_trait]
impl SpendConnector for OpenAiConnector {
    fn provider_id(&self) -> &'static str {
        "openai"
    }

    async fn fetch(&self, ctx: &ConnectorCtx) -> Result<SpendData, ConnectorError> {
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

        let current_month_usd = self
            .fetch_period_cost(ctx, current_start.timestamp(), now.timestamp())
            .await?;

        let previous_month_usd = self
            .fetch_period_cost(ctx, prev_start.timestamp(), prev_end.timestamp())
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
        let body = br#"{
            "data": [
                {"results": [{"amount": {"value": 1.50}}, {"amount": {"value": 0.75}}]},
                {"results": [{"amount": {"value": 2.25}}]}
            ]
        }"#;
        assert!((parse_costs(200, body).unwrap() - 4.50).abs() < 0.001);
    }

    #[test]
    fn handles_empty_costs_response() {
        assert_eq!(parse_costs(200, br#"{"data": []}"#).unwrap(), 0.0);
    }

    #[test]
    fn parse_failure_surfaces_as_api_error() {
        let err = parse_costs(200, b"not json").unwrap_err();
        assert!(matches!(err, ConnectorError::ApiError { status: 200, .. }));
    }

    #[test]
    fn classifies_auth_rate_limit_and_server_errors() {
        assert!(matches!(
            classify_status(401, ""),
            Some(ConnectorError::Unauthorized)
        ));
        assert!(matches!(
            classify_status(403, ""),
            Some(ConnectorError::Unauthorized)
        ));
        assert!(matches!(
            classify_status(429, ""),
            Some(ConnectorError::RateLimited)
        ));
        match classify_status(500, "boom") {
            Some(ConnectorError::ApiError { status, body }) => {
                assert_eq!(status, 500);
                assert_eq!(body, "boom");
            }
            other => panic!("expected ApiError, got {other:?}"),
        }
    }

    #[test]
    fn success_status_proceeds_and_404_is_caller_handled() {
        assert!(classify_status(200, "").is_none());
        // 404 is intentionally NOT routed here — fetch intercepts it for the
        // legacy fallback before ever consulting classify_status.
        assert!(matches!(
            classify_status(404, ""),
            Some(ConnectorError::ApiError { status: 404, .. })
        ));
    }
}
