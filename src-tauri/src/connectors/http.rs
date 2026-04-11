use reqwest::Client;
use std::time::Duration;

/// Build the shared HTTP client used by all spend connectors.
///
/// - TLS via rustls (no OpenSSL dependency, consistent across platforms)
/// - 30-second timeout on all requests
/// - Stashpeak user-agent for provider analytics / API identification
///
/// The client is cheap to clone but relatively expensive to create — build it
/// once per command invocation for now. Move it to Tauri managed state when
/// polling is added.
pub fn build_client() -> Client {
    Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("Stashpeak/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("failed to build HTTP client")
}
