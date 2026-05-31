use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;

use crate::connectors::{ConnectorError, SpendConnector, SpendData};
use crate::secrets;

/// Connector for the OpenRouter provider.
///
/// Endpoint: `GET https://openrouter.ai/api/v1/auth/key`
/// Returns current-period usage in USD. Previous-month data is not available
/// via the public API and defaults to 0.0 until OpenRouter exposes it.
pub struct OpenRouterConnector {
    client: Client,
}

impl OpenRouterConnector {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

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

    async fn fetch(&self) -> Result<SpendData, ConnectorError> {
        // Keychain access is a blocking OS call — run it on the thread pool.
        let api_key = tauri::async_runtime::spawn_blocking(|| {
            secrets::get_provider_api_key("openrouter")
                .map_err(|e| ConnectorError::Config(e.to_string()))
                .and_then(|opt| opt.ok_or(ConnectorError::Unauthorized))
        })
        .await
        .map_err(|e| ConnectorError::Config(format!("keychain task failed: {e}")))??;

        tracing::debug!(provider = "openrouter", endpoint = "/api/v1/auth/key", "fetching spend");

        let response = self
            .client
            .get("https://openrouter.ai/api/v1/auth/key")
            .header("Authorization", format!("Bearer {}", &*api_key))
            .send()
            .await
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        let status = response.status().as_u16();
        // Read the body failure-tolerantly: terminal statuses (401/403/429) are
        // decided from the status code alone, so a mid-body transport failure
        // must not flip them into a retryable error; on 2xx an empty body then
        // fails to parse → ApiError, matching the original `.json()` semantics.
        let bytes = response.bytes().await.unwrap_or_default();

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
        assert!(matches!(classify_status(401, ""), Some(ConnectorError::Unauthorized)));
        assert!(matches!(classify_status(403, ""), Some(ConnectorError::Unauthorized)));
        assert!(matches!(classify_status(429, ""), Some(ConnectorError::RateLimited)));
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
}
