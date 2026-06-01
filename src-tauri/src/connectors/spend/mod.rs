pub mod anthropic;
pub mod gcp;
pub mod groq;
pub mod openai;
pub mod openrouter;

use super::http::{CredentialView, Credentials, SignIntent};
use super::ConnectorError;

/// Host-side signer dispatch: map `(descriptor id, intent)` to a provider signer.
/// This is the ONE place that couples a [`SignIntent`] to a concrete connector,
/// and it lives in `spend` (the parent that legitimately owns the connector
/// modules), NOT in the generic broker `http.rs`. An id whose registration asks
/// for an intent no signer serves is a registration bug, surfaced as `Config`
/// (never a silent wrong-key sign).
pub(crate) fn sign_with(
    id: &str,
    intent: SignIntent,
    blob: &str,
) -> Result<String, ConnectorError> {
    match (id, intent) {
        ("gcp", SignIntent::GcpServiceAccountJwt) => gcp::sign_service_account_jwt(blob),
        (other, _) => Err(ConnectorError::Config(format!(
            "connector '{other}' has no signer for the requested intent"
        ))),
    }
}

/// Host-side credential-view dispatch: map `(descriptor id, view)` to the
/// provider extractor that yields ONLY the non-secret coordinates of the blob.
pub(crate) fn credentials_for(
    id: &str,
    view: CredentialView,
    blob: &str,
) -> Result<Credentials, ConnectorError> {
    match (id, view) {
        ("gcp", CredentialView::GcpBigQueryCoords) => {
            gcp::bigquery_coords(blob).map(Credentials::GcpBigQueryCoords)
        }
        (other, _) => Err(ConnectorError::Config(format!(
            "connector '{other}' has no credential view for the request"
        ))),
    }
}
