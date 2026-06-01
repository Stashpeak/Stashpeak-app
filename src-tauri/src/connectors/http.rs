//! Host-brokered egress for spend connectors (`docs/EXTENSIONS_SPEC.md` §5, E3).
//!
//! A connector never touches `reqwest` or `secrets` directly: it builds a
//! credential-free [`ConnectorRequest`] and hands it to [`ConnectorCtx::send`],
//! which alone reads the OS keychain, injects the connector's identity-bound
//! credential, performs the egress, and returns the raw `(status, bytes)` for the
//! connector's own (unchanged, #118-pinned) status classification.
//!
//! Retry is intentionally not brokered here — `fetch` as a whole is wrapped by
//! [`super::with_retry`] in dispatch, so a connector that issues several `send`s
//! retries as a single unit exactly as it did before the broker existed.
//!
//! As of #121 ALL connectors route egress through this broker — including GCP,
//! whose RS256 service-account key is signed host-side via `ctx.sign` and whose
//! BigQuery coordinates come back non-secret via `ctx.credentials`. No connector
//! touches `reqwest` or `secrets` directly.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, Url};
use zeroize::Zeroizing;

use super::descriptor::ConnectorDescriptor;
use super::ConnectorError;

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
        // Do NOT follow redirects. The broker validates (https) + advisory-logs +
        // injects the identity-bound credential for the ORIGINAL url only.
        // Following a 30x would re-issue the request — including injected secrets
        // such as Anthropic's `x-api-key`, which reqwest does NOT strip on
        // cross-host redirects — to a target the broker never validated, and would
        // make the egress log (original host) wrong. A 3xx is instead returned
        // as-is for the connector to classify. (Codex P2, PR #138.)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Stashpeak/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("failed to build HTTP client")
}

// ── Request model ─────────────────────────────────────────────────────────────

/// How the host injects the connector's identity-bound credential.
///
/// The connector declares the *scheme* only and never places the secret itself —
/// the host (the sole keychain reader) attaches the key in [`ConnectorCtx::send`].
/// `#[non_exhaustive]` so future variants (e.g. a v2 host-minted token) are
/// additive without breaking existing connectors.
#[non_exhaustive]
pub enum Auth {
    /// No host credential injection (an unauthenticated endpoint).
    None,
    /// Host sets `Authorization: Bearer <key>`.
    Bearer,
    /// Host sets `<name>: <key>` (e.g. Anthropic's `x-api-key`).
    Header { name: &'static str },
}

/// HTTP method for a brokered request. Crate-internal — only the `get`/`post`
/// constructors set it, so it is not part of the connector-facing API surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Method {
    Get,
    Post,
}

/// An optional request body. `#[non_exhaustive]` so future body kinds are additive.
#[derive(Debug)]
#[non_exhaustive]
pub enum RequestBody {
    /// `application/x-www-form-urlencoded` (e.g. GCP's OAuth token exchange).
    Form(Vec<(String, String)>),
    /// `application/json`, pre-serialized so the broker stays serde-free with
    /// respect to connector body types.
    Json(String),
}

/// A credential-free outbound request a connector hands to the broker.
///
/// Fields are private: connectors build it through the chained builder
/// (`get`/`post`/`header`/`query_pair`/`auth`/`form_body`/`json_body`) and the
/// broker (this module) reads it. New transport features land here by adding
/// private fields + builder methods (defaulted by the constructors) — existing
/// call-sites stay unchanged.
pub struct ConnectorRequest {
    url: String,
    method: Method,
    /// Connector-set NON-SECRET headers (e.g. `anthropic-version`). The
    /// identity-bound credential is never placed here — see [`Auth`].
    headers: Vec<(String, String)>,
    query: Vec<(String, String)>,
    body: Option<RequestBody>,
    auth: Auth,
}

impl ConnectorRequest {
    /// Begin a `GET` request to `url` with no auth, headers, query, or body.
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            method: Method::Get,
            headers: Vec::new(),
            query: Vec::new(),
            body: None,
            auth: Auth::None,
        }
    }

    /// Begin a `POST` request to `url`.
    pub fn post(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            method: Method::Post,
            headers: Vec::new(),
            query: Vec::new(),
            body: None,
            auth: Auth::None,
        }
    }

    /// Add a non-secret request header.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Add a query-string pair (appended in call order).
    pub fn query_pair(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.push((key.into(), value.into()));
        self
    }

    /// Attach an `application/x-www-form-urlencoded` body.
    pub fn form_body(mut self, pairs: Vec<(String, String)>) -> Self {
        self.body = Some(RequestBody::Form(pairs));
        self
    }

    /// Attach a pre-serialized `application/json` body.
    pub fn json_body(mut self, json: impl Into<String>) -> Self {
        self.body = Some(RequestBody::Json(json.into()));
        self
    }

    /// Declare how the host should inject the identity-bound credential.
    pub fn auth(mut self, auth: Auth) -> Self {
        self.auth = auth;
        self
    }
}

// ── Transport seam ────────────────────────────────────────────────────────────

/// A fully-prepared outbound request: the host has already injected the
/// identity-bound credential into `headers`. NEVER logged verbatim (the body may
/// carry a bearer-equivalent JWT assertion or a SQL query).
pub(crate) struct PreparedRequest {
    pub(crate) url: String,
    pub(crate) method: Method,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) query: Vec<(String, String)>,
    pub(crate) body: Option<RequestBody>,
}

/// A brokered response whose body has NOT yet been read. The connector inspects
/// [`status`](BrokeredResponse::status) first and calls
/// [`bytes`](BrokeredResponse::bytes) only when it actually needs the body — so a
/// terminal status (401/403/429, or OpenAI's 404 fallback) is produced
/// immediately after the response headers, without buffering the body (matching
/// the per-status behaviour the connectors had before the broker).
#[derive(Debug)]
pub struct BrokeredResponse {
    status: u16,
    body: BodySource,
}

/// Where a response body is read from: the live reqwest response in production,
/// or a canned result in tests.
#[derive(Debug)]
enum BodySource {
    Live(reqwest::Response),
    #[cfg(test)]
    Canned(Result<Vec<u8>, String>),
}

impl BrokeredResponse {
    /// The HTTP status — available immediately after the response headers.
    pub fn status(&self) -> u16 {
        self.status
    }

    /// Read and buffer the response body. A body-read failure on a 2xx is a
    /// genuine transient truncation → retryable `Network` (preserves Anthropic's
    /// truncated-page behaviour); on a non-2xx the status is already terminal, so
    /// it falls back to an empty body and lets the connector classify by status
    /// (matches the old `bytes().unwrap_or_default()`).
    pub async fn bytes(self) -> Result<Vec<u8>, ConnectorError> {
        let status = self.status;
        let read = match self.body {
            BodySource::Live(response) => response
                .bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(|e| e.to_string()),
            #[cfg(test)]
            BodySource::Canned(result) => result,
        };
        match read {
            Ok(bytes) => Ok(bytes),
            Err(msg) if (200..300).contains(&status) => Err(ConnectorError::Network(msg)),
            Err(_) => Ok(Vec::new()),
        }
    }
}

/// The single egress primitive. Production uses reqwest; tests inject a fake so
/// the broker's credential injection + status/body discipline run offline.
/// `execute` returns once the response headers (status) are known; the body is
/// read lazily through [`BrokeredResponse::bytes`].
#[async_trait]
pub(crate) trait Transport: Send + Sync {
    /// `Err(msg)` = a pre-response transport failure (connect/DNS/TLS/timeout);
    /// `Ok(resp)` once the status is known (body unread).
    async fn execute(&self, request: PreparedRequest) -> Result<BrokeredResponse, String>;
}

struct ReqwestTransport {
    client: Client,
}

#[async_trait]
impl Transport for ReqwestTransport {
    async fn execute(&self, request: PreparedRequest) -> Result<BrokeredResponse, String> {
        let mut builder = match request.method {
            Method::Get => self.client.get(&request.url),
            Method::Post => self.client.post(&request.url),
        };
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if !request.query.is_empty() {
            builder = builder.query(&request.query);
        }
        builder = match request.body {
            None => builder,
            Some(RequestBody::Form(pairs)) => builder.form(&pairs),
            Some(RequestBody::Json(json)) => builder
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(json),
        };

        let response = builder.send().await.map_err(|e| e.to_string())?;
        Ok(BrokeredResponse {
            status: response.status().as_u16(),
            body: BodySource::Live(response),
        })
    }
}

// ── Host capabilities (sign / credentials) ─────────────────────────────────────

/// A signing operation the host performs on the connector's behalf WITHOUT
/// exposing the private key — the connector receives only the signed assertion.
/// `#[non_exhaustive]` so future intents are additive. The broker dispatches the
/// intent to a provider-specific signer in `connectors::spend`; it knows nothing
/// about any provider's key format or signing scheme.
#[non_exhaustive]
pub enum SignIntent {
    /// RS256 service-account JWT for Google's OAuth token exchange. All JWT
    /// parameters (scope/audience/ttl/algorithm/issuer) are fixed inside the GCP
    /// signer, so a connector cannot widen scope or change the audience.
    GcpServiceAccountJwt,
}

/// A request for the NON-SECRET coordinates of a composite credential.
/// `#[non_exhaustive]` so future composite connectors are additive.
#[non_exhaustive]
pub enum CredentialView {
    /// GCP BigQuery coordinates (project/dataset/table) — never the private key.
    GcpBigQueryCoords,
}

/// GCP BigQuery coordinates extracted host-side from the composite credential.
#[derive(Debug, Clone)]
pub struct GcpBigQueryCoords {
    pub project_id: String,
    pub dataset_id: String,
    pub table_name: String,
}

/// The non-secret credential coordinates returned by [`ConnectorCtx::credentials`].
/// `#[non_exhaustive]` so future views are additive.
#[non_exhaustive]
pub enum Credentials {
    GcpBigQueryCoords(GcpBigQueryCoords),
}

// ── Host broker ───────────────────────────────────────────────────────────────

/// The host-side broker handed to every connector's `fetch`.
///
/// It is bound to ONE connector descriptor; [`send`](ConnectorCtx::send) resolves
/// THAT descriptor's identity-bound credential (via the crate-private `secrets`
/// path), injects it per the request's [`Auth`], performs the egress, and returns
/// raw `(status, bytes)`. The connector never receives the secret and never
/// performs I/O itself.
pub struct ConnectorCtx {
    descriptor: ConnectorDescriptor,
    transport: Arc<dyn Transport>,
    /// Resolve-once cache for this descriptor's credential: one keychain read per
    /// fetch even though a connector may call `send` many times (pagination,
    /// multi-period). Double-checked so no lock is held across the keychain await.
    credential: Mutex<Option<Zeroizing<String>>>,
}

impl ConnectorCtx {
    /// Build a production ctx bound to `descriptor`, performing egress over `client`.
    pub fn new(descriptor: ConnectorDescriptor, client: Client) -> Self {
        Self {
            descriptor,
            transport: Arc::new(ReqwestTransport { client }),
            credential: Mutex::new(None),
        }
    }

    /// Resolve this descriptor's identity-bound credential, caching it for the
    /// life of the ctx. Mirrors the mapping the connectors used before the broker:
    /// a missing key is `Unauthorized`; a backend failure is `Config`.
    async fn credential(&self) -> Result<Zeroizing<String>, ConnectorError> {
        if let Some(key) = self.credential.lock().unwrap().as_ref() {
            return Ok(key.clone());
        }

        let id = self.descriptor.id;
        let key = tauri::async_runtime::spawn_blocking(move || {
            crate::secrets::get_provider_api_key(id)
                .map_err(|e| ConnectorError::Config(e.to_string()))
                .and_then(|opt| opt.ok_or(ConnectorError::Unauthorized))
        })
        .await
        .map_err(|e| ConnectorError::Config(format!("keychain task failed: {e}")))??;

        // Re-lock and store; if another `send` won the race, keep its value.
        let mut guard = self.credential.lock().unwrap();
        Ok(guard.get_or_insert(key).clone())
    }

    /// Perform one brokered round-trip: enforce https, advisory-log the egress
    /// host, resolve + inject the credential per `auth`, and return the response
    /// once headers arrive. The connector reads the body via
    /// [`BrokeredResponse::bytes`] only when it needs it — so a terminal status is
    /// produced without buffering the body.
    pub async fn send(
        &self,
        request: ConnectorRequest,
    ) -> Result<BrokeredResponse, ConnectorError> {
        let url = Url::parse(&request.url)
            .map_err(|e| ConnectorError::Config(format!("invalid request url: {e}")))?;
        if url.scheme() != "https" {
            return Err(ConnectorError::Config(
                "connector egress must use https".to_string(),
            ));
        }

        // Advisory egress log: provider id + host + path + the declared network
        // allowlist ONLY. NEVER the headers or query — they carry the injected
        // credential. The allowlist is empty in v1 (populated #122, enforced
        // v2/WASM); this is a log of where egress actually went, not a violation
        // comparison.
        tracing::debug!(
            provider = self.descriptor.id,
            host = url.host_str().unwrap_or(""),
            path = url.path(),
            declared = ?self.descriptor.permissions.network,
            "connector egress"
        );

        let mut headers = request.headers;
        match request.auth {
            Auth::None => {}
            Auth::Bearer => {
                let key = self.credential().await?;
                headers.push((
                    "Authorization".to_string(),
                    format!("Bearer {}", key.as_str()),
                ));
            }
            Auth::Header { name } => {
                let key = self.credential().await?;
                headers.push((name.to_string(), key.as_str().to_string()));
            }
        }

        let prepared = PreparedRequest {
            url: request.url,
            method: request.method,
            headers,
            query: request.query,
            body: request.body,
        };

        // A pre-response transport failure (connect/DNS/TLS/timeout) is a
        // retryable Network; the body-read discipline lives in
        // BrokeredResponse::bytes so a terminal status need not buffer the body.
        self.transport
            .execute(prepared)
            .await
            .map_err(ConnectorError::Network)
    }

    /// Sign on the connector's behalf WITHOUT exposing the private key. The host
    /// resolves THIS descriptor's credential (resolve-once cache) and dispatches
    /// the raw blob to the provider-specific signer in `connectors::spend`; only
    /// the signed assertion (a `String`) is returned. The broker knows nothing
    /// about the key format, the signing scheme, or any provider URL.
    pub async fn sign(&self, intent: SignIntent) -> Result<String, ConnectorError> {
        let blob = self.credential().await?;
        crate::connectors::spend::sign_with(self.descriptor.id, intent, blob.as_str())
    }

    /// Return the NON-SECRET coordinates of this descriptor's composite credential.
    /// The provider-specific extractor (in `connectors::spend`) parses the blob and
    /// yields only fields the descriptor marks non-secret — never the private key.
    pub async fn credentials(&self, view: CredentialView) -> Result<Credentials, ConnectorError> {
        let blob = self.credential().await?;
        crate::connectors::spend::credentials_for(self.descriptor.id, view, blob.as_str())
    }
}

// ── Test seam ─────────────────────────────────────────────────────────────────

/// Build a ctx over a fake transport (no real keychain / network). Exposed to
/// sibling connector test modules so they can exercise `fetch(&ctx)` offline.
#[cfg(test)]
impl ConnectorCtx {
    pub(crate) fn with_transport(
        descriptor: ConnectorDescriptor,
        transport: Arc<dyn Transport>,
    ) -> Self {
        Self {
            descriptor,
            transport,
            credential: Mutex::new(None),
        }
    }

    /// Pre-seed the credential cache so `send` injects without a keychain read.
    pub(crate) fn seed_credential(&self, value: &str) {
        *self.credential.lock().unwrap() = Some(Zeroizing::new(value.to_string()));
    }

    /// A ctx whose transport panics if any egress is attempted — for connectors
    /// (Groq) that return without calling `send`.
    pub(crate) fn test_unused(id: &'static str) -> Self {
        Self::with_transport(
            test_descriptor(id),
            Arc::new(FakeTransport::new(Vec::new())),
        )
    }
}

#[cfg(test)]
pub(crate) fn test_descriptor(id: &'static str) -> ConnectorDescriptor {
    use super::descriptor::{CredentialSchema, CONNECTOR_ABI_VERSION};
    ConnectorDescriptor {
        id,
        display_name: id,
        kind: "spend",
        abi_version: CONNECTOR_ABI_VERSION,
        permissions: Default::default(),
        credential_schema: CredentialSchema::single_api_key(),
        available: true,
    }
}

/// One queued fake round-trip: `Err(msg)` = a pre-response transport failure;
/// `Ok((status, body))` = a response with that status whose body reads as
/// `Ok(bytes)` or fails with `Err(msg)` (only observed if the connector reads it).
#[cfg(test)]
pub(crate) type FakeOutcome = Result<(u16, Result<Vec<u8>, String>), String>;

/// Fake transport: returns queued outcomes in order and records every prepared
/// request so tests can assert on the credential the host injected.
#[cfg(test)]
pub(crate) struct FakeTransport {
    outcomes: Mutex<Vec<FakeOutcome>>,
    pub(crate) captured: Mutex<Vec<PreparedRequest>>,
}

#[cfg(test)]
impl FakeTransport {
    pub(crate) fn new(outcomes: Vec<FakeOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes),
            captured: Mutex::new(Vec::new()),
        }
    }
}

#[cfg(test)]
#[async_trait]
impl Transport for FakeTransport {
    async fn execute(&self, request: PreparedRequest) -> Result<BrokeredResponse, String> {
        self.captured.lock().unwrap().push(request);
        let outcome = {
            let mut queue = self.outcomes.lock().unwrap();
            assert!(!queue.is_empty(), "FakeTransport: no more outcomes queued");
            queue.remove(0)
        };
        outcome.map(|(status, body)| BrokeredResponse {
            status,
            body: BodySource::Canned(body),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with(outcomes: Vec<FakeOutcome>) -> (ConnectorCtx, Arc<FakeTransport>) {
        let transport = Arc::new(FakeTransport::new(outcomes));
        let ctx = ConnectorCtx::with_transport(test_descriptor("openai"), transport.clone());
        (ctx, transport)
    }

    fn ok_200() -> FakeOutcome {
        Ok((200, Ok(b"{}".to_vec())))
    }

    #[tokio::test]
    async fn bearer_auth_injects_authorization_header() {
        let (ctx, transport) = ctx_with(vec![ok_200()]);
        ctx.seed_credential("sk-secret");

        let resp = ctx
            .send(ConnectorRequest::get("https://api.example.com/v1").auth(Auth::Bearer))
            .await
            .unwrap();

        assert_eq!(resp.status(), 200);
        let captured = transport.captured.lock().unwrap();
        assert!(captured[0]
            .headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v == "Bearer sk-secret"));
    }

    #[tokio::test]
    async fn header_auth_injects_named_header_not_bearer() {
        let (ctx, transport) = ctx_with(vec![ok_200()]);
        ctx.seed_credential("sk-admin");

        ctx.send(
            ConnectorRequest::get("https://api.example.com")
                .auth(Auth::Header { name: "x-api-key" }),
        )
        .await
        .unwrap();

        let captured = transport.captured.lock().unwrap();
        assert!(captured[0]
            .headers
            .iter()
            .any(|(k, v)| k == "x-api-key" && v == "sk-admin"));
        assert!(!captured[0]
            .headers
            .iter()
            .any(|(k, _)| k == "Authorization"));
    }

    #[tokio::test]
    async fn none_auth_injects_no_credential_but_keeps_connector_headers() {
        let (ctx, transport) = ctx_with(vec![ok_200()]);
        ctx.seed_credential("sk-should-not-appear");

        ctx.send(
            ConnectorRequest::get("https://api.example.com")
                .header("anthropic-version", "2023-06-01"),
        )
        .await
        .unwrap();

        let captured = transport.captured.lock().unwrap();
        assert!(captured[0]
            .headers
            .iter()
            .all(|(k, _)| k != "Authorization" && k != "x-api-key"));
        assert!(captured[0]
            .headers
            .iter()
            .any(|(k, v)| k == "anthropic-version" && v == "2023-06-01"));
    }

    #[tokio::test]
    async fn rejects_non_https_before_any_egress() {
        let (ctx, transport) = ctx_with(Vec::new());
        ctx.seed_credential("sk-secret");

        let err = ctx
            .send(ConnectorRequest::get("http://api.example.com").auth(Auth::Bearer))
            .await
            .unwrap_err();

        assert!(matches!(err, ConnectorError::Config(_)));
        assert!(
            transport.captured.lock().unwrap().is_empty(),
            "no request should reach the transport for a non-https url"
        );
    }

    #[tokio::test]
    async fn transport_failure_maps_to_network() {
        let (ctx, _t) = ctx_with(vec![Err("connection refused".to_string())]);
        let err = ctx
            .send(ConnectorRequest::get("https://api.example.com"))
            .await
            .unwrap_err();
        assert!(matches!(err, ConnectorError::Network(_)));
    }

    #[tokio::test]
    async fn non_2xx_status_is_returned_with_body_for_connector_classification() {
        let (ctx, _t) = ctx_with(vec![Ok((404, Ok(b"nope".to_vec())))]);
        let resp = ctx
            .send(ConnectorRequest::get("https://api.example.com"))
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
        assert_eq!(resp.bytes().await.unwrap(), b"nope");
    }

    /// The headline of the redirect/buffering fix: `send` returns once headers
    /// arrive and does NOT eagerly read the body — a connector classifying a
    /// terminal status from the code alone never pays to buffer the body. Here the
    /// body read would fail; because the test never calls `bytes()`, it never
    /// surfaces (an eager broker would have buffered it inside `send`).
    #[tokio::test]
    async fn terminal_status_is_available_without_reading_the_body() {
        let (ctx, _t) = ctx_with(vec![Ok((401, Err("body must not be read".to_string())))]);
        let resp = ctx
            .send(ConnectorRequest::get("https://api.example.com"))
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        // Intentionally no resp.bytes(): the terminal status is decided without it.
    }

    #[tokio::test]
    async fn body_read_failure_on_2xx_is_retryable_network() {
        let (ctx, _t) = ctx_with(vec![Ok((200, Err("truncated".to_string())))]);
        // send() returns once headers arrive — it does NOT eagerly read the body...
        let resp = ctx
            .send(ConnectorRequest::get("https://api.example.com"))
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        // ...the 2xx body-read failure surfaces only when the connector asks.
        assert!(matches!(
            resp.bytes().await,
            Err(ConnectorError::Network(_))
        ));
    }

    #[tokio::test]
    async fn body_read_failure_on_non_2xx_yields_empty_body() {
        let (ctx, _t) = ctx_with(vec![Ok((500, Err("truncated".to_string())))]);
        let resp = ctx
            .send(ConnectorRequest::get("https://api.example.com"))
            .await
            .unwrap();
        assert_eq!(resp.status(), 500);
        assert!(resp.bytes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn query_pairs_reach_the_transport() {
        let (ctx, transport) = ctx_with(vec![ok_200()]);
        ctx.send(ConnectorRequest::get("https://api.example.com").query_pair("date", "2026-06-01"))
            .await
            .unwrap();
        let captured = transport.captured.lock().unwrap();
        assert!(captured[0]
            .query
            .iter()
            .any(|(k, v)| k == "date" && v == "2026-06-01"));
    }

    // Note: the credential here is pre-seeded, so this exercises the cache
    // re-injection path, not the keychain read itself — it proves a cached
    // credential is re-attached to every send, not the resolve-once count (the
    // keychain path is gated behind `secrets` with no test seam in #120).
    #[tokio::test]
    async fn cached_credential_is_reinjected_on_every_send() {
        let (ctx, transport) = ctx_with(vec![ok_200(), ok_200()]);
        ctx.seed_credential("sk-secret");

        ctx.send(ConnectorRequest::get("https://api.example.com/a").auth(Auth::Bearer))
            .await
            .unwrap();
        ctx.send(ConnectorRequest::get("https://api.example.com/b").auth(Auth::Bearer))
            .await
            .unwrap();

        let captured = transport.captured.lock().unwrap();
        assert_eq!(captured.len(), 2);
        for cap in captured.iter() {
            assert!(cap
                .headers
                .iter()
                .any(|(k, v)| k == "Authorization" && v == "Bearer sk-secret"));
        }
    }
}
