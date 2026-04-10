use reqwest::blocking::Client;
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

// ── Connector impl ───────────────────────────────────────────────────────────

impl SpendConnector for OpenRouterConnector {
    fn provider_id(&self) -> &'static str {
        "openrouter"
    }

    fn fetch(&self) -> Result<SpendData, ConnectorError> {
        // Load API key from OS keychain. `get_provider_api_key` calls
        // `logging::remember_secret`, so any subsequent log line that contains
        // this value will be redacted by the SecretScrubbingLayer.
        let api_key = secrets::get_provider_api_key("openrouter")
            .map_err(|e| ConnectorError::Config(e.to_string()))?
            .ok_or(ConnectorError::Unauthorized)?;

        tracing::debug!(provider = "openrouter", endpoint = "/api/v1/auth/key", "fetching spend");

        let response = self
            .client
            .get("https://openrouter.ai/api/v1/auth/key")
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        let status = response.status();

        match status.as_u16() {
            401 | 403 => return Err(ConnectorError::Unauthorized),
            429 => return Err(ConnectorError::RateLimited),
            s if s >= 400 => {
                let body = response.text().unwrap_or_default();
                return Err(ConnectorError::ApiError { status: s, body });
            }
            _ => {}
        }

        let parsed: AuthKeyResponse = response.json().map_err(|e| ConnectorError::ApiError {
            status: status.as_u16(),
            body: format!("failed to parse response: {e}"),
        })?;

        tracing::debug!(
            provider = "openrouter",
            current_month_usd = parsed.data.usage,
            "spend fetch successful"
        );

        Ok(SpendData {
            current_month_usd: parsed.data.usage,
            // OpenRouter's public API does not expose previous-month spend.
            previous_month_usd: 0.0,
            // Last-activity timestamp is not available from this endpoint.
            last_activity_at: None,
        })
    }
}
