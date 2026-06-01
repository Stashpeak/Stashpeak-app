use async_trait::async_trait;
use chrono::{Datelike, Utc};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::connectors::{
    Auth, ConnectorCtx, ConnectorError, ConnectorRequest, CredentialView, Credentials,
    GcpBigQueryCoords, SignIntent, SpendConnector, SpendData,
};

const BQ_SCOPE: &str = "https://www.googleapis.com/auth/bigquery.readonly";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// GCP connector — fully host-brokered as of #121. The RS256 service-account key
/// is signed host-side via `ctx.sign`; the connector never sees the private key.
pub struct GcpConnector;

// ── Host-side credential handling (the connector never sees the private key) ──

/// Extract the JWT-signing inputs from the composite blob, host-side: the
/// (non-secret) service-account email and the private key in `Zeroizing`. Re-maps
/// the frozen parser's error to a FIXED message so a blob-echoing `{e}` can never
/// reach a `ConnectorError` value (the scrub layer only covers tracing emission).
pub(crate) fn extract_signing_inputs(
    blob: &str,
) -> Result<(String, Zeroizing<String>), ConnectorError> {
    let payload = parse_keychain_payload(blob)
        .map_err(|_| ConnectorError::Config("failed to parse GCP credential blob".into()))?;
    Ok((
        payload.service_account_key.client_email,
        Zeroizing::new(payload.service_account_key.private_key),
    ))
}

/// Extract the NON-SECRET BigQuery coordinates from the composite blob, host-side.
pub(crate) fn bigquery_coords(blob: &str) -> Result<GcpBigQueryCoords, ConnectorError> {
    let payload = parse_keychain_payload(blob)
        .map_err(|_| ConnectorError::Config("failed to parse GCP credential blob".into()))?;
    Ok(GcpBigQueryCoords {
        project_id: payload.project_id,
        dataset_id: payload.dataset_id,
        table_name: payload.table_name,
    })
}

/// Sign a GCP service-account RS256 JWT host-side. The private key is read from
/// the blob, registered for scrubbing, used to sign, and zeroized — it never
/// leaves this function. Called only via `ConnectorCtx::sign`. MUST NOT log the
/// claims, client_email, the key, or the returned assertion (it is
/// bearer-equivalent — exchanged for the access token).
pub(crate) fn sign_service_account_jwt(blob: &str) -> Result<String, ConnectorError> {
    #[derive(Serialize)]
    struct Claims {
        iss: String,
        scope: String,
        aud: String,
        exp: usize,
        iat: usize,
    }

    let (client_email, private_key) = extract_signing_inputs(blob)?;

    let now = Utc::now().timestamp() as usize;
    let claims = Claims {
        iss: client_email,
        scope: BQ_SCOPE.to_string(),
        aud: TOKEN_URL.to_string(),
        exp: now + 3600,
        iat: now,
    };

    // HARD CONSTRAINT: register the bare private key for scrubbing BEFORE
    // from_rsa_pem. The read-path scrub registers only the WHOLE blob, and the
    // logging regexes never match a bare PEM body; this registration is the only
    // thing that scrubs a PEM fragment a from_rsa_pem error Display might emit.
    crate::logging::remember_secret(&private_key);

    // De-interpolate the jsonwebtoken errors (no `{e}`): a from_rsa_pem error
    // Display can embed PEM fragments, and a ConnectorError VALUE is NOT covered
    // by the scrub layer (which runs only at tracing emission). The Config variant
    // is preserved; no frozen test asserts the message text. (Decision log E15.)
    let header = Header::new(Algorithm::RS256);
    let key = EncodingKey::from_rsa_pem(private_key.as_bytes()).map_err(|_| {
        ConnectorError::Config("failed to parse GCP service-account private key".into())
    })?;
    let jwt = encode(&header, &claims, &key)
        .map_err(|_| ConnectorError::Config("failed to encode GCP service-account JWT".into()))?;
    // private_key (Zeroizing) drops + zeroizes here; the caller receives only `jwt`.
    Ok(jwt)
}

// ── Brokered multi-step legs (all egress goes through `ctx`) ──

/// Leg 2: exchange the signed JWT assertion for an OAuth access token. The token
/// endpoint takes a form body and NO injected credential (`Auth::None`) — the
/// composite keychain blob must never be sent as a Bearer here. The access token
/// is returned in `Zeroizing` (it is live bearer credential material).
async fn exchange_token(
    ctx: &ConnectorCtx,
    jwt: &str,
) -> Result<Zeroizing<String>, ConnectorError> {
    let resp = ctx
        .send(
            ConnectorRequest::post(TOKEN_URL)
                .auth(Auth::None)
                .form_body(vec![
                    (
                        "grant_type".into(),
                        "urn:ietf:params:oauth:grant-type:jwt-bearer".into(),
                    ),
                    ("assertion".into(), jwt.to_string()),
                ]),
        )
        .await?;

    // Preserve the original mapping: a non-2xx token response is Unauthorized,
    // decided from the status alone (the broker does not buffer the body here).
    if !(200..300).contains(&resp.status()) {
        return Err(ConnectorError::Unauthorized);
    }

    // 2xx: a body-read failure maps to a retryable Network inside .bytes(); a
    // token-body PARSE failure keeps the original literal ApiError{status:200}
    // (message de-interpolated — the body holds the access_token).
    let bytes = resp.bytes().await?;

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
    }
    let parsed: TokenResponse =
        serde_json::from_slice(&bytes).map_err(|_| ConnectorError::ApiError {
            status: 200,
            body: "Failed to parse token response".into(),
        })?;
    Ok(Zeroizing::new(parsed.access_token))
}

/// Leg 3: run one BigQuery month-spend query through the broker. The runtime
/// access token is attached as `Authorization: Bearer <token>` by the connector
/// (NOT `Auth::Bearer`, which would inject the composite blob and leak the key).
async fn fetch_month_spend(
    ctx: &ConnectorCtx,
    token: &str,
    coords: &GcpBigQueryCoords,
    year: i32,
    month: u32,
) -> Result<f64, ConnectorError> {
    validate_bq_identifier("project_id", &coords.project_id)?;
    validate_bq_identifier("dataset_id", &coords.dataset_id)?;
    validate_bq_identifier("table_name", &coords.table_name)?;
    let invoice_month = validate_invoice_month(year, month)?;

    // Filter globally for Google Cloud AI usage if possible, or just take total project spend
    // Here we just take the total cost for the invoice month.
    // We filter for Gemini/Vertex explicitly to accurately represent the AI connector.
    let query = format!(
        "SELECT sum(cost) as total_cost FROM `{}.{}.{}` WHERE invoice.month = '{}' AND (service.description LIKE '%Vertex AI%' OR service.description LIKE '%Gemini%')",
        coords.project_id, coords.dataset_id, coords.table_name, invoice_month
    );

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct QueryRequest {
        query: String,
        use_legacy_sql: bool,
    }
    let body = serde_json::to_string(&QueryRequest {
        query,
        use_legacy_sql: false,
    })
    .map_err(|_| ConnectorError::Config("failed to serialize BigQuery request".into()))?;

    let url = format!(
        "https://bigquery.googleapis.com/bigquery/v2/projects/{}/queries",
        coords.project_id
    );

    let resp = ctx
        .send(
            ConnectorRequest::post(url)
                .auth(Auth::None)
                .header("Authorization", format!("Bearer {token}"))
                .json_body(body),
        )
        .await?;

    let status = resp.status();
    let bytes = resp.bytes().await?;

    if let Some(err) = classify_bq_status(status, &String::from_utf8_lossy(&bytes)) {
        return Err(err);
    }

    parse_bq_total(status, &bytes)
}

// ── BigQuery response shapes ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct QueryResponse {
    rows: Option<Vec<Row>>,
}

#[derive(Deserialize)]
struct Row {
    f: Vec<Cell>,
}

#[derive(Deserialize)]
struct Cell {
    v: Option<String>,
}

// ── Pure response handling (offline-testable; see #118 parity harness) ────────

/// Map a non-success BigQuery HTTP status (and body) to a [`ConnectorError`], or
/// `None` to proceed to parsing. A "Not found: Table" body means the billing
/// export is not populated yet (config issue) regardless of status code. This is
/// the response→error contract the registry inversion (#123) must preserve.
fn classify_bq_status(status: u16, body: &str) -> Option<ConnectorError> {
    if (200..300).contains(&status) {
        return None;
    }

    if body.contains("Not found: Table") {
        return Some(ConnectorError::Config(
            "BigQuery export not yet populated — allow up to 48h after initial setup".into(),
        ));
    }

    if status == 401 || status == 403 {
        return Some(ConnectorError::Unauthorized);
    }

    Some(ConnectorError::ApiError {
        status,
        body: body.to_string(),
    })
}

/// Parse a BigQuery `queries` response body into the summed cost (USD).
fn parse_bq_total(status: u16, body: &[u8]) -> Result<f64, ConnectorError> {
    let resp: QueryResponse =
        serde_json::from_slice(body).map_err(|e| ConnectorError::ApiError {
            status,
            body: format!("Failed to parse BQ response: {e}"),
        })?;
    Ok(extract_bq_total(&resp))
}

/// Extract `rows[0].f[0].v` as f64; missing rows or a null sum mean 0 spend.
fn extract_bq_total(resp: &QueryResponse) -> f64 {
    resp.rows
        .as_ref()
        .and_then(|rows| rows.first())
        .and_then(|row| row.f.first())
        .and_then(|cell| cell.v.as_ref())
        .and_then(|val| val.parse::<f64>().ok())
        .unwrap_or(0.0)
}

/// Parse the composite GCP keychain blob (service-account key + BQ coordinates).
fn parse_keychain_payload(raw: &str) -> Result<KeychainPayload, ConnectorError> {
    serde_json::from_str(raw)
        .map_err(|e| ConnectorError::Config(format!("Failed to parse GCP keychain payload: {e}")))
}

fn validate_bq_identifier(field_name: &str, value: &str) -> Result<(), ConnectorError> {
    if value.is_empty() || value.len() > 1024 {
        return Err(ConnectorError::Config(format!(
            "Invalid GCP {field_name}: must be 1-1024 characters"
        )));
    }

    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ConnectorError::Config(format!(
            "Invalid GCP {field_name}: only letters, numbers, underscores, and hyphens are allowed"
        )));
    }

    Ok(())
}

fn validate_invoice_month(year: i32, month: u32) -> Result<String, ConnectorError> {
    if !(0..=9999).contains(&year) {
        return Err(ConnectorError::Config(
            "Invalid invoice month: year must be between 0000 and 9999".into(),
        ));
    }

    if !(1..=12).contains(&month) {
        return Err(ConnectorError::Config(
            "Invalid invoice month: month must be between 01 and 12".into(),
        ));
    }

    Ok(format!("{year:04}{month:02}"))
}

#[derive(Deserialize)]
struct KeychainPayload {
    service_account_key: ServiceAccountKey,
    project_id: String,
    dataset_id: String,
    table_name: String,
}

#[derive(Deserialize)]
struct ServiceAccountKey {
    client_email: String,
    private_key: String,
}

#[async_trait]
impl SpendConnector for GcpConnector {
    fn provider_id(&self) -> &'static str {
        "gcp"
    }

    /// Brokered 3-leg loop: host-sign the RS256 JWT → exchange it for an OAuth
    /// access token → run the current + previous month BigQuery queries. The
    /// private key never enters this connector (it is consumed host-side inside
    /// `ctx.sign`); the BigQuery coordinates come back non-secret via
    /// `ctx.credentials`.
    async fn fetch(&self, ctx: &ConnectorCtx) -> Result<SpendData, ConnectorError> {
        // Leg 1: host signs the service-account JWT (private key stays host-side).
        let jwt = ctx.sign(SignIntent::GcpServiceAccountJwt).await?;

        // Leg 2: exchange the assertion for an OAuth access token.
        let token = exchange_token(ctx, &jwt).await?;

        // Non-secret coordinates for the BigQuery queries.
        let Credentials::GcpBigQueryCoords(coords) =
            ctx.credentials(CredentialView::GcpBigQueryCoords).await?;

        let now = Utc::now();
        let (prev_year, prev_month) = if now.month() == 1 {
            (now.year() - 1, 12u32)
        } else {
            (now.year(), now.month() - 1)
        };

        // Leg 3: current + previous month spend.
        let current_month_usd =
            fetch_month_spend(ctx, &token, &coords, now.year(), now.month()).await?;
        let previous_month_usd =
            fetch_month_spend(ctx, &token, &coords, prev_year, prev_month).await?;

        Ok(SpendData {
            current_month_usd,
            previous_month_usd,
            last_activity_at: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_bigquery_identifiers() {
        assert!(validate_bq_identifier("project_id", "my-gcp-project_123").is_ok());
        assert!(validate_bq_identifier("dataset_id", "billing_export").is_ok());
        assert!(validate_bq_identifier("table_name", "gcp_billing_export_v1").is_ok());
    }

    #[test]
    fn rejects_empty_bigquery_identifiers() {
        let err = validate_bq_identifier("project_id", "").unwrap_err();
        assert!(matches!(err, ConnectorError::Config(_)));
        assert_eq!(
            err.to_string(),
            "configuration error: Invalid GCP project_id: must be 1-1024 characters"
        );
    }

    #[test]
    fn rejects_bigquery_identifiers_with_invalid_characters() {
        let err = validate_bq_identifier("table_name", "billing`; DROP TABLE foo;--").unwrap_err();
        assert!(matches!(err, ConnectorError::Config(_)));
        assert_eq!(
            err.to_string(),
            "configuration error: Invalid GCP table_name: only letters, numbers, underscores, and hyphens are allowed"
        );
    }

    #[test]
    fn builds_valid_invoice_months() {
        assert_eq!(validate_invoice_month(2026, 4).unwrap(), "202604");
    }

    #[test]
    fn rejects_invalid_invoice_months() {
        let err = validate_invoice_month(2026, 13).unwrap_err();
        assert!(matches!(err, ConnectorError::Config(_)));
        assert_eq!(
            err.to_string(),
            "configuration error: Invalid invoice month: month must be between 01 and 12"
        );
    }

    #[test]
    fn extracts_bq_total_from_first_cell() {
        let body = br#"{"rows": [{"f": [{"v": "123.45"}]}]}"#;
        assert_eq!(parse_bq_total(200, body).unwrap(), 123.45);
    }

    #[test]
    fn null_or_missing_rows_mean_zero_spend() {
        assert_eq!(parse_bq_total(200, br#"{"rows": null}"#).unwrap(), 0.0);
        assert_eq!(parse_bq_total(200, br#"{}"#).unwrap(), 0.0);
        assert_eq!(
            parse_bq_total(200, br#"{"rows": [{"f": [{"v": null}]}]}"#).unwrap(),
            0.0
        );
    }

    #[test]
    fn bq_parse_failure_surfaces_as_api_error() {
        let err = parse_bq_total(200, b"not json").unwrap_err();
        assert!(matches!(err, ConnectorError::ApiError { status: 200, .. }));
    }

    #[test]
    fn classifies_missing_table_as_config_error() {
        let body = "Error: Not found: Table my-project:billing.export";
        assert!(matches!(
            classify_bq_status(404, body),
            Some(ConnectorError::Config(_))
        ));
    }

    #[test]
    fn classifies_auth_and_server_errors() {
        assert!(matches!(
            classify_bq_status(401, ""),
            Some(ConnectorError::Unauthorized)
        ));
        assert!(matches!(
            classify_bq_status(403, ""),
            Some(ConnectorError::Unauthorized)
        ));
        assert!(matches!(
            classify_bq_status(500, "boom"),
            Some(ConnectorError::ApiError { status: 500, .. })
        ));
        assert!(classify_bq_status(200, "").is_none());
    }

    #[test]
    fn parses_composite_keychain_blob() {
        let raw = r#"{
            "service_account_key": {
                "client_email": "svc@proj.iam.gserviceaccount.com",
                "private_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"
            },
            "project_id": "my-proj",
            "dataset_id": "billing_export",
            "table_name": "gcp_billing_v1"
        }"#;
        let payload = parse_keychain_payload(raw).unwrap();
        assert_eq!(payload.project_id, "my-proj");
        assert_eq!(payload.dataset_id, "billing_export");
        assert_eq!(payload.table_name, "gcp_billing_v1");
        assert_eq!(
            payload.service_account_key.client_email,
            "svc@proj.iam.gserviceaccount.com"
        );
    }

    #[test]
    fn rejects_malformed_keychain_blob() {
        let result = parse_keychain_payload("{ not valid");
        assert!(matches!(result, Err(ConnectorError::Config(_))));
    }
}

// ── Brokered multi-step loop tests (#121) ─────────────────────────────────────
// These exercise the full host-brokered flow offline via FakeTransport, with the
// RS256 sign path running for real against a runtime-generated throwaway key (no
// private key committed to the repo). The frozen pure-fn `tests` module above is
// untouched (the #118 parity oracle).
#[cfg(test)]
mod broker_loop_tests {
    use super::*;
    use crate::connectors::http::{
        test_descriptor, ConnectorCtx, FakeOutcome, FakeTransport, Method, PreparedRequest,
        RequestBody,
    };
    use std::sync::{Arc, OnceLock};

    /// A throwaway RSA key generated ONCE per test binary (no key in the repo).
    fn test_private_key_pem() -> &'static str {
        static PEM: OnceLock<String> = OnceLock::new();
        PEM.get_or_init(|| {
            use rsa::pkcs8::{EncodePrivateKey, LineEnding};
            use rsa::RsaPrivateKey;
            let mut rng = rand::thread_rng();
            let key = RsaPrivateKey::new(&mut rng, 2048).expect("test RSA keygen");
            key.to_pkcs8_pem(LineEnding::LF)
                .expect("encode test key to PKCS#8 PEM")
                .to_string()
        })
        .as_str()
    }

    fn composite_blob(private_key: &str) -> String {
        serde_json::json!({
            "service_account_key": {
                "client_email": "svc@test-proj.iam.gserviceaccount.com",
                "private_key": private_key,
            },
            "project_id": "test-proj",
            "dataset_id": "billing_export",
            "table_name": "gcp_billing_v1",
        })
        .to_string()
    }

    fn gcp_ctx(outcomes: Vec<FakeOutcome>, blob: &str) -> (ConnectorCtx, Arc<FakeTransport>) {
        let transport = Arc::new(FakeTransport::new(outcomes));
        let ctx = ConnectorCtx::with_transport(test_descriptor("gcp"), transport.clone());
        ctx.seed_credential(blob);
        (ctx, transport)
    }

    /// Flatten a captured request (url + headers + query + body) into one string,
    /// for the negative-leak assertion.
    fn flatten(req: &PreparedRequest) -> String {
        let mut s = req.url.clone();
        for (k, v) in &req.headers {
            s.push_str(k);
            s.push_str(v);
        }
        for (k, v) in &req.query {
            s.push_str(k);
            s.push_str(v);
        }
        match &req.body {
            Some(RequestBody::Form(pairs)) => {
                for (k, v) in pairs {
                    s.push_str(k);
                    s.push_str(v);
                }
            }
            Some(RequestBody::Json(j)) => s.push_str(j),
            None => {}
        }
        s
    }

    #[tokio::test]
    async fn brokered_loop_returns_spend_and_never_leaks_the_private_key() {
        let pem = test_private_key_pem();
        let blob = composite_blob(pem);
        let (ctx, transport) = gcp_ctx(
            vec![
                Ok((200, Ok(br#"{"access_token": "ya29.test-token"}"#.to_vec()))),
                Ok((200, Ok(br#"{"rows": [{"f": [{"v": "123.45"}]}]}"#.to_vec()))),
                Ok((200, Ok(br#"{"rows": [{"f": [{"v": "100.00"}]}]}"#.to_vec()))),
            ],
            &blob,
        );

        let spend = GcpConnector.fetch(&ctx).await.unwrap();
        assert!((spend.current_month_usd - 123.45).abs() < 1e-9);
        assert!((spend.previous_month_usd - 100.00).abs() < 1e-9);

        let captured = transport.captured.lock().unwrap();
        assert_eq!(captured.len(), 3, "token exchange + 2 BigQuery queries");
        for req in captured.iter() {
            assert_eq!(req.method, Method::Post);
        }

        // Leg 0: token exchange — form body (grant_type + JWT assertion); Auth::None
        // so NO Authorization header and NO composite blob on the wire.
        let token_req = &captured[0];
        assert!(token_req.url.contains("oauth2.googleapis.com/token"));
        assert!(token_req.headers.iter().all(|(k, _)| k != "Authorization"));
        match &token_req.body {
            Some(RequestBody::Form(pairs)) => {
                assert!(pairs.iter().any(|(k, v)| k == "grant_type"
                    && v == "urn:ietf:params:oauth:grant-type:jwt-bearer"));
                let assertion = pairs
                    .iter()
                    .find(|(k, _)| k == "assertion")
                    .map(|(_, v)| v.as_str())
                    .expect("assertion present");
                assert!(assertion.starts_with("ey"), "assertion should be a JWT");
            }
            other => panic!("expected a form body, got {other:?}"),
        }

        // Legs 1+2: BigQuery — json body, Bearer = the runtime access token.
        for bq in &captured[1..] {
            assert!(bq.url.contains("bigquery.googleapis.com"));
            assert!(bq
                .headers
                .iter()
                .any(|(k, v)| k == "Authorization" && v == "Bearer ya29.test-token"));
            assert!(matches!(bq.body, Some(RequestBody::Json(_))));
        }

        // Negative leak: the RS256 private key never appears on ANY leg — only the
        // JWT assertion (leg 0) and the access token (legs 1+2) reach the wire.
        for req in captured.iter() {
            let wire = flatten(req);
            assert!(!wire.contains(pem), "private key PEM leaked onto the wire");
            assert!(
                !wire.contains("PRIVATE KEY"),
                "a PEM fragment leaked onto the wire"
            );
        }
    }

    #[tokio::test]
    async fn token_exchange_non_2xx_is_unauthorized() {
        let blob = composite_blob(test_private_key_pem());
        let (ctx, _t) = gcp_ctx(vec![Ok((401, Ok(Vec::new())))], &blob);
        let err = GcpConnector.fetch(&ctx).await.unwrap_err();
        assert!(matches!(err, ConnectorError::Unauthorized));
    }

    #[tokio::test]
    async fn token_parse_failure_is_api_error_200() {
        let blob = composite_blob(test_private_key_pem());
        let (ctx, _t) = gcp_ctx(vec![Ok((200, Ok(b"not json".to_vec())))], &blob);
        let err = GcpConnector.fetch(&ctx).await.unwrap_err();
        assert!(matches!(err, ConnectorError::ApiError { status: 200, .. }));
    }

    #[test]
    fn malformed_private_key_yields_scrubbed_config_error() {
        // A blob whose private_key is not a valid PEM: the sign error must be a
        // Config with a FIXED message containing NO fragment of the key bytes.
        let blob = composite_blob(
            "-----BEGIN PRIVATE KEY-----\nSECRET-LOOKING-GARBAGE-abc123\n-----END PRIVATE KEY-----\n",
        );
        let err = sign_service_account_jwt(&blob).unwrap_err();
        match err {
            ConnectorError::Config(msg) => {
                assert_eq!(msg, "failed to parse GCP service-account private key");
                assert!(!msg.contains("SECRET-LOOKING-GARBAGE"));
            }
            other => panic!("expected Config, got {other:?}"),
        }
    }
}
