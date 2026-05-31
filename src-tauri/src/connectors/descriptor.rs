//! In-code connector manifest — the in-binary projection of the capability
//! manifest in `internal-docs` ARCHITECTURE.md §4. The descriptor is the single
//! source of truth for a connector's identity and declared capabilities.
//!
//! Per `docs/EXTENSIONS_SPEC.md` §5 the descriptor carries a real,
//! forward-compatible schema now; sibling 0.4.0 issues fill it in:
//!   - `permissions.network` hosts + `abi_version` enforcement → #122
//!   - composite `credential_schema` (GCP)                     → #121
//!
//! There is intentionally **no** `products[]` (spec E6): products are a frontend
//! taxonomy and are not 1:1 with connectors.

// Several descriptor fields are declared now for forward-compatibility (spec
// §13) but are not consumed until sibling 0.4.0 issues (#120/#121/#122/#124).
// Allow the not-yet-read fields rather than understating the schema.
#![allow(dead_code)]

/// Current connector ABI version. Bumped when the descriptor/dispatch contract
/// changes in a way a v2 (WASM) guest must check at load time. Enforcement of
/// this check is wired in #122.
pub const CONNECTOR_ABI_VERSION: u32 = 1;

/// Declared capability manifest for a connector. Hosts/scopes are advisory in
/// v1 and become a hard sandbox boundary at v2/WASM (spec §4). Network hosts are
/// populated in #122; left empty here so the schema is present without
/// overstating coverage.
#[derive(Debug, Clone, Default)]
pub struct ConnectorPermissions {
    /// Network hosts the connector may reach (e.g. `"api.anthropic.com"`).
    pub network: Vec<&'static str>,
    /// Storage scopes the connector may touch.
    pub storage: Vec<&'static str>,
}

/// One input field of a connector's credential.
#[derive(Debug, Clone)]
pub struct CredentialField {
    pub name: &'static str,
    pub required: bool,
}

/// The credential a connector needs. The schema is **composite-capable** (n
/// input fields → one keychain blob); most connectors need a single API key,
/// while GCP needs a composite blob. The composite GCP schema + its handling
/// land in #121.
#[derive(Debug, Clone, Default)]
pub struct CredentialSchema {
    pub fields: Vec<CredentialField>,
}

impl CredentialSchema {
    /// A single required API-key field — the shape for every connector except
    /// GCP (whose composite schema is defined in #121).
    pub fn single_api_key() -> Self {
        Self {
            fields: vec![CredentialField {
                name: "api_key",
                required: true,
            }],
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
    /// ABI version for v2 load-time compatibility checks (enforced in #122).
    pub abi_version: u32,
    /// Declared capability manifest (network hosts filled in #122).
    pub permissions: ConnectorPermissions,
    /// Credential shape (composite GCP handling in #121).
    pub credential_schema: CredentialSchema,
    /// `false` = coming soon / not yet usable (e.g. Groq exposes no billing API).
    pub available: bool,
}
