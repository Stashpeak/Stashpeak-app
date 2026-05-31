use async_trait::async_trait;
use serde::Deserialize;

use crate::connectors::{
    Auth, ConnectorCtx, ConnectorError, ConnectorRequest, SpendConnector, SpendData,
};

/// Connector for the OpenRouter provider.
///
/// Endpoint: `GET https://openrouter.ai/api/v1/auth/key`
/// Returns current-period usage in USD. Previous-month data is not available
/// via the public API and defaults to 0.0 until OpenRouter exposes it.
pub struct OpenRouterConnector;

// ── Response shapes ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AuthKeyResponse {
    data: AuthKeyData,
}

#[derive(Deserialize)]
struct AuthKeyData {
    /// Total spend in USD for the current billing period.
    usage: f64,
}

// ── Pure response handling (offline-testable; see #118 parity harness) ────────

/// Map an HTTP status to a terminal [`ConnectorError`], or `None` to proceed to
/// body parsing. This is the response→error contract the registry inversion
/// (#123) must preserve unchanged.
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

/// Parse the `/auth/key` body into current-period usage (USD).
fn parse_usage(status: u16, body: &[u8]) -> Result<f64, ConnectorError> {
    let parsed: AuthKeyResponse =
        serde_json::from_slice(body).map_err(|e| ConnectorError::ApiError {
            status,
            body: format!("failed to parse response: {e}"),
        })?;
    Ok(parsed.data.usage)
}

// ── Connector impl ───────────────────────────────────────────────────────────

#[async_trait]
impl SpendConnector for OpenRouterConnector {
    fn provider_id(&self) -> &'static str {
        "openrouter"
    }

    async fn fetch(&self, ctx: &ConnectorCtx) -> Result<SpendData, ConnectorError> {
        tracing::debug!(
            provider = "openrouter",
            endpoint = "/api/v1/auth/key",
            "fetching spend"
        );

        let (status, bytes) = ctx
            .send(ConnectorRequest::get("https://openrouter.ai/api/v1/auth/key").auth(Auth::Bearer))
            .await?;

        if let Some(err) = classify_status(status, &String::from_utf8_lossy(&bytes)) {
            return Err(err);
        }

        let current_month_usd = parse_usage(status, &bytes)?;

        tracing::debug!(
            provider = "openrouter",
            current_month_usd,
            "spend fetch successful"
        );

        Ok(SpendData {
            current_month_usd,
            // OpenRouter's public API does not expose previous-month spend.
            previous_month_usd: 0.0,
            // Last-activity timestamp is not available from this endpoint.
            last_activity_at: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_period_usage() {
        let body = br#"{"data": {"usage": 12.5, "limit": 100.0}}"#;
        assert_eq!(parse_usage(200, body).unwrap(), 12.5);
    }

    #[test]
    fn parse_failure_surfaces_as_api_error() {
        let err = parse_usage(200, b"not json").unwrap_err();
        assert!(matches!(err, ConnectorError::ApiError { status: 200, .. }));
    }

    #[test]
    fn classifies_auth_and_rate_limit_statuses() {
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
    }

    #[test]
    fn classifies_other_4xx_5xx_as_api_error() {
        match classify_status(500, "boom") {
            Some(ConnectorError::ApiError { status, body }) => {
                assert_eq!(status, 500);
                assert_eq!(body, "boom");
            }
            other => panic!("expected ApiError, got {other:?}"),
        }
    }

    #[test]
    fn success_status_proceeds_to_parsing() {
        assert!(classify_status(200, "").is_none());
    }

    // ── Broker integration (design choice #1: with_retry wraps the WHOLE fetch) ──

    use crate::connectors::http::{test_descriptor, FakeTransport, RawResponse};
    use crate::connectors::{with_retry, RetryConfig};
    use std::sync::Arc;

    fn instant_retry() -> RetryConfig {
        RetryConfig {
            max_attempts: 3,
            initial_delay_ms: 0,
        }
    }

    /// A `Network` from `ctx.send` must retry the WHOLE `fetch`, not just the
    /// round-trip: the connector's `fetch` runs again and succeeds.
    #[tokio::test]
    async fn network_from_send_retries_the_whole_fetch() {
        let transport = Arc::new(FakeTransport::new(vec![
            Err("connection reset".to_string()),
            Ok(RawResponse {
                status: 200,
                body: Ok(br#"{"data": {"usage": 1.0}}"#.to_vec()),
            }),
        ]));
        let ctx = ConnectorCtx::with_transport(test_descriptor("openrouter"), transport.clone());
        ctx.seed_credential("sk-test");

        let connector = OpenRouterConnector;
        let result = with_retry(&instant_retry(), || connector.fetch(&ctx)).await;

        assert!((result.unwrap().current_month_usd - 1.0).abs() < 1e-9);
        assert_eq!(
            transport.captured.lock().unwrap().len(),
            2,
            "a Network from ctx.send should drive a whole-fetch retry"
        );
    }

    /// A terminal status (401 → Unauthorized) is NOT retried: the whole fetch
    /// runs exactly once.
    #[tokio::test]
    async fn unauthorized_from_send_is_not_retried() {
        let transport = Arc::new(FakeTransport::new(vec![Ok(RawResponse {
            status: 401,
            body: Ok(Vec::new()),
        })]));
        let ctx = ConnectorCtx::with_transport(test_descriptor("openrouter"), transport.clone());
        ctx.seed_credential("sk-test");

        let connector = OpenRouterConnector;
        let err = with_retry(&instant_retry(), || connector.fetch(&ctx))
            .await
            .unwrap_err();

        assert!(matches!(err, ConnectorError::Unauthorized));
        assert_eq!(transport.captured.lock().unwrap().len(), 1);
    }
}
