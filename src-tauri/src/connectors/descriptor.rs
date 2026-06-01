//! In-code connector manifest — the in-binary projection of the capability
//! manifest in `internal-docs` ARCHITECTURE.md §4. The descriptor is the single
//! source of truth for a connector's identity and declared capabilities.
//!
//! Per `docs/EXTENSIONS_SPEC.md` §5 the descriptor carries a real,
//! forward-compatible schema; sibling 0.4.0 issues fill it in:
//!   - `permissions.network` hosts + `abi_version` load-time gate   ✅ #122
//!   - composite `credential_schema` (GCP service-account)          ✅ #121
//!
//! There is intentionally **no** `products[]` (spec E6): products are a frontend
//! taxonomy and are not 1:1 with connectors.

// Several descriptor fields are declared now for forward-compatibility (spec
// §13) but are not all consumed yet (e.g. `permissions.storage`, which awaits a
// storage broker). Allow the not-yet-read fields rather than understating the
// schema.
#![allow(dead_code)]

use serde::Serialize;

/// Current connector ABI version. Bumped when the descriptor/dispatch contract
/// changes in a way a v2 (WASM) guest must check at load time. The load-time
/// compatibility gate is enforced at registration (see
/// [`is_abi_compatible`] and `SpendConnectorRegistry::register`).
pub const CONNECTOR_ABI_VERSION: u32 = 1;

/// Whether the host (running [`CONNECTOR_ABI_VERSION`]) can speak a connector's
/// declared `abi_version`. v1 supports exactly one ABI; when v2 admits untrusted
/// guests over a supported range this widens to a `min..=max` check. Consulted by
/// the registry's load-time gate before a connector becomes dispatchable.
pub fn is_abi_compatible(abi_version: u32) -> bool {
    abi_version == CONNECTOR_ABI_VERSION
}

/// Declared capability manifest for a connector.
///
/// `network` is an **enforced** allowlist in v1: the broker (`ConnectorCtx::send`)
/// rejects egress to any host not listed, and an **empty list denies all egress**
/// (fail-closed). Matching is host-granularity (no port/path) in v1; v2/WASM
/// extends the same check to the full sandbox boundary. `storage` scopes remain
/// advisory until a storage broker exists (the first storage-touching connector —
/// the Vault folder reader, 0.7.0 — populates them).
#[derive(Debug, Clone, Default)]
pub struct ConnectorPermissions {
    /// Network hosts the connector may reach (e.g. `"api.anthropic.com"`). An
    /// empty list denies all egress (fail-closed).
    pub network: Vec<&'static str>,
    /// Storage scopes the connector may touch. Forward-compat schema; not yet
    /// enforced (no storage broker). Populated by the first storage connector.
    pub storage: Vec<&'static str>,
}

/// One input field of a connector's credential.
#[derive(Debug, Clone)]
pub struct CredentialField {
    pub name: &'static str,
    pub required: bool,
    /// `true` = the host NEVER hands this field's value to the connector via
    /// `ctx.credentials`; it is consumed only host-side (an API key via `Auth`
    /// injection, or an RS256 private key via `ctx.sign`). `false` = a non-secret
    /// coordinate (e.g. a BigQuery project id) the connector may read.
    /// Deliberately has no `Default` so every (esp. composite) schema must state it.
    pub secret: bool,
}

/// The credential a connector needs. The schema is **composite-capable** (n
/// input fields → one keychain blob); most connectors need a single API key,
/// while GCP needs a composite blob (see [`CredentialSchema::gcp_service_account`],
/// landed in #121).
#[derive(Debug, Clone, Default)]
pub struct CredentialSchema {
    pub fields: Vec<CredentialField>,
}

impl CredentialSchema {
    /// A single required API-key field — the shape for every connector except
    /// GCP. The key is `secret`: it is injected host-side via `Auth` and never
    /// returned to the connector through `ctx.credentials`.
    pub fn single_api_key() -> Self {
        Self {
            fields: vec![CredentialField {
                name: "api_key",
                required: true,
                secret: true,
            }],
        }
    }

    /// GCP composite credential: four logical input fields collapsing to one
    /// keychain JSON blob. `service_account_key` is the secret object (it holds
    /// the RS256 private key, consumed host-side via `ctx.sign`); the three
    /// BigQuery coordinates are non-secret and readable via `ctx.credentials`.
    /// Field names mirror the keychain blob's JSON keys, but this list does NOT
    /// drive parsing — `connectors::spend::gcp::parse_keychain_payload` stays the
    /// parse oracle (#118).
    pub fn gcp_service_account() -> Self {
        Self {
            fields: vec![
                CredentialField {
                    name: "service_account_key",
                    required: true,
                    secret: true,
                },
                CredentialField {
                    name: "project_id",
                    required: true,
                    secret: false,
                },
                CredentialField {
                    name: "dataset_id",
                    required: true,
                    secret: false,
                },
                CredentialField {
                    name: "table_name",
                    required: true,
                    secret: false,
                },
            ],
        }
    }

    /// True when more than one input field maps to a single keychain blob.
    pub fn is_composite(&self) -> bool {
        self.fields.len() > 1
    }
}

/// In-code manifest describing a connector's identity and declared capabilities.
#[derive(Debug, Clone)]
pub struct ConnectorDescriptor {
    /// Stable identifier; matches the keychain key and the `provider_spend` PK.
    pub id: &'static str,
    /// Human-readable name for UI surfaces.
    pub display_name: &'static str,
    /// Capability label only (e.g. `"spend"`) — NOT a dispatch axis; capability
    /// is expressed by the registry's connector trait.
    pub kind: &'static str,
    /// ABI version, checked at registration against [`CONNECTOR_ABI_VERSION`]
    /// (load-time compatibility gate; see [`is_abi_compatible`]).
    pub abi_version: u32,
    /// Declared capability manifest; `permissions.network` is an enforced egress
    /// allowlist in v1 (fail-closed — an empty list denies all egress).
    pub permissions: ConnectorPermissions,
    /// Credential shape (GCP composite handling landed in #121).
    pub credential_schema: CredentialSchema,
    /// `false` = coming soon / not yet usable (e.g. Groq exposes no billing API).
    pub available: bool,
}

// ── Serializable projection (the registry's `list()` surface, spec §5/§9) ──────

/// A serializable view of a [`ConnectorDescriptor`] returned by the
/// `list_connectors()` command (#124). Faithful projection of the declared
/// manifest minus the in-binary factory. Additive: the frontend stays on its
/// static provider list during the strangler and migrates to this in a later step.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInfo {
    pub id: &'static str,
    pub display_name: &'static str,
    pub kind: &'static str,
    pub abi_version: u32,
    pub available: bool,
    /// Declared egress allowlist (enforced host-side in v1 — see [`ConnectorPermissions`]).
    pub network: Vec<&'static str>,
    pub credential_fields: Vec<CredentialFieldInfo>,
}

/// A serializable view of one [`CredentialField`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialFieldInfo {
    pub name: &'static str,
    pub required: bool,
    /// `true` = consumed host-side only; its value is never returned to the
    /// connector or the UI (an API key injected via `Auth`, or an RS256 key signed
    /// via `ctx.sign`). `false` = a readable non-secret coordinate.
    pub secret: bool,
}

impl From<&ConnectorDescriptor> for ConnectorInfo {
    fn from(d: &ConnectorDescriptor) -> Self {
        Self {
            id: d.id,
            display_name: d.display_name,
            kind: d.kind,
            abi_version: d.abi_version,
            available: d.available,
            network: d.permissions.network.clone(),
            credential_fields: d
                .credential_schema
                .fields
                .iter()
                .map(|f| CredentialFieldInfo {
                    name: f.name,
                    required: f.required,
                    secret: f.secret,
                })
                .collect(),
        }
    }
}
