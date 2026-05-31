pub mod descriptor;
pub mod http;
pub mod registry;
pub mod spend;

pub use http::{Auth, ConnectorCtx, ConnectorRequest};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::time::Duration;
use tokio::time::sleep;

/// Spend data returned by a successful provider fetch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendData {
    /// Spend in USD for the current calendar month.
    pub current_month_usd: f64,
    /// Spend in USD for the previous calendar month.
    pub previous_month_usd: f64,
    /// Timestamp of the most recent API activity, if known.
    pub last_activity_at: Option<DateTime<Utc>>,
}

/// Errors a connector can produce.
#[derive(Debug)]
pub enum ConnectorError {
    /// API key is invalid or rejected — do not retry.
    Unauthorized,
    /// Rate-limited by the provider — retry with backoff.
    RateLimited,
    /// Provider returned an unexpected HTTP error — do not retry.
    ApiError { status: u16, body: String },
    /// Network-level failure (timeout, DNS, TLS) — retry.
    Network(String),
    /// Local configuration problem (key not set, keychain unavailable) — do not retry.
    Config(String),
}

impl std::fmt::Display for ConnectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => write!(f, "unauthorized — check your API key"),
            Self::RateLimited => write!(f, "rate limited by provider"),
            Self::ApiError { status, body } => write!(f, "API error {status}: {body}"),
            Self::Network(msg) => write!(f, "network error: {msg}"),
            Self::Config(msg) => write!(f, "configuration error: {msg}"),
        }
    }
}

/// Common interface for all spend-tracking provider connectors.
///
/// Implementors do **not** touch `reqwest` or `secrets` directly: they build a
/// credential-free [`ConnectorRequest`] and call [`ConnectorCtx::send`], which
/// reads the keychain, injects the connector's identity-bound credential, and
/// performs the egress. All outbound calls are logged with `tracing::` macros so
/// the global `SecretScrubbingLayer` in `crate::logging` redacts any key values.
/// (GCP is the one connector not yet on the broker — see `spend::gcp`; #121.)
#[async_trait]
pub trait SpendConnector: Send + Sync {
    /// Stable provider identifier (e.g. `"openrouter"`). Must match the keychain key.
    fn provider_id(&self) -> &'static str;

    /// Fetch current spend data from the provider API, using `ctx` for all
    /// credential access and network egress.
    ///
    /// Returns `Err(ConnectorError::Unauthorized)` if the key is missing or rejected.
    /// Returns `Err(ConnectorError::Network(_))` on transient failures — these are
    /// eligible for retry via `with_retry`.
    async fn fetch(&self, ctx: &ConnectorCtx) -> Result<SpendData, ConnectorError>;
}

/// Retry policy for connector calls.
pub struct RetryConfig {
    /// Total number of attempts (first call + retries).
    pub max_attempts: u32,
    /// Delay before the first retry in milliseconds. Doubled each subsequent attempt.
    pub initial_delay_ms: u64,
}

/// Default policy: 3 attempts, 500 ms → 1 000 ms backoff (1.5 s max wait).
pub const DEFAULT_RETRY: RetryConfig = RetryConfig {
    max_attempts: 3,
    initial_delay_ms: 500,
};

/// Call `f` up to `config.max_attempts` times with exponential back-off.
///
/// - `Network` and `RateLimited` errors are retried.
/// - `Unauthorized`, `ApiError`, and `Config` errors return immediately.
/// - After all attempts are exhausted the final error is returned; callers
///   should treat this as a signal to mark the provider stale in the UI.
pub async fn with_retry<T, F, Fut>(config: &RetryConfig, mut f: F) -> Result<T, ConnectorError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, ConnectorError>>,
{
    for attempt in 0..config.max_attempts {
        match f().await {
            Ok(val) => return Ok(val),
            Err(err) => {
                let retryable = matches!(
                    err,
                    ConnectorError::Network(_) | ConnectorError::RateLimited
                );

                if !retryable {
                    return Err(err);
                }

                if attempt + 1 >= config.max_attempts {
                    tracing::error!(
                        attempts = config.max_attempts,
                        error = %err,
                        "connector fetch exhausted retries — provider will be marked stale"
                    );
                    return Err(err);
                }

                let delay_ms = config.initial_delay_ms * 2u64.pow(attempt);
                tracing::warn!(
                    attempt = attempt + 1,
                    max_attempts = config.max_attempts,
                    delay_ms,
                    error = %err,
                    "connector fetch failed, retrying"
                );
                sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn instant_retry() -> RetryConfig {
        RetryConfig {
            max_attempts: 3,
            initial_delay_ms: 0,
        }
    }

    #[tokio::test]
    async fn retries_network_errors_up_to_max_attempts() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let result = with_retry(&instant_retry(), || {
            c.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(ConnectorError::Network("timeout".into())) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn does_not_retry_unauthorized() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let result = with_retry(&instant_retry(), || {
            c.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(ConnectorError::Unauthorized) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn does_not_retry_config_errors() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let result = with_retry(&instant_retry(), || {
            c.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(ConnectorError::Config("key not set".into())) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn succeeds_on_second_attempt() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let result = with_retry(&instant_retry(), || {
            let attempt = c.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt == 0 {
                    Err(ConnectorError::Network("first failure".into()))
                } else {
                    Ok(42u32)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retries_rate_limited() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let result = with_retry(&instant_retry(), || {
            c.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(ConnectorError::RateLimited) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
}
