use async_trait::async_trait;
use reqwest::Client;

use crate::connectors::{ConnectorError, SpendConnector, SpendData};

/// Connector for the Groq provider.
///
/// **Groq does not currently expose a public billing API** (as of 2026).
/// Usage data is only available via the Groq Console dashboard at
/// https://console.groq.com. Two community feature requests for a billing
/// API were open as of early 2026.
///
/// This connector returns an informative `ApiError` so the framework and stale
/// indicator in the UI still function correctly. Update `fetch()` when Groq
/// ships the endpoint — the rest of the framework requires no changes.
pub struct GroqConnector {
    // Retained for when the API becomes available.
    #[allow(dead_code)]
    client: Client,
}

impl GroqConnector {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl SpendConnector for GroqConnector {
    fn provider_id(&self) -> &'static str {
        "groq"
    }

    async fn fetch(&self) -> Result<SpendData, ConnectorError> {
        tracing::info!(
            provider = "groq",
            "fetch called but Groq has no public billing API yet"
        );
        Err(ConnectorError::ApiError {
            status: 0,
            body: "Groq does not currently expose a public billing API. \
                   View usage manually at https://console.groq.com. \
                   This connector will be updated when Groq ships the endpoint."
                .to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pins the deliberate "no public billing API yet" contract so the registry
    // migration (#123) cannot silently change Groq's behavior. fetch() makes no
    // network or keychain call, so it is fully offline.
    #[tokio::test]
    async fn fetch_reports_no_billing_api() {
        let connector = GroqConnector::new(Client::new());
        let err = connector.fetch().await.unwrap_err();
        match err {
            ConnectorError::ApiError { status, body } => {
                assert_eq!(status, 0);
                assert!(body.contains("Groq does not currently expose a public billing API"));
            }
            other => panic!("expected ApiError, got {other:?}"),
        }
    }
}
