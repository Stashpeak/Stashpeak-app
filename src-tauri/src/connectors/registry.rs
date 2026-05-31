//! Per-capability connector registry (`docs/EXTENSIONS_SPEC.md` §5).
//!
//! The registry is the new **dispatch whitelist gate**: an id that is not
//! registered is rejected before any keychain or network I/O. This *moves*
//! (does not delete) the `crate::providers::ProviderId::parse` boundary — the
//! keychain/DB whitelist in `providers`/`secrets` stays, so the two whitelists
//! must agree (guarded by `registry_ids_match_provider_ids`).
//!
//! It replaces the hardcoded `match` that previously lived in
//! `fetch_provider_spend`. Migrating the connectors' internals onto the
//! host-broker is #123; this issue (#119) only inverts dispatch.

use reqwest::Client;

use super::descriptor::{
    ConnectorDescriptor, ConnectorPermissions, CredentialSchema, CONNECTOR_ABI_VERSION,
};
use super::spend::{
    anthropic::AnthropicConnector, gcp::GcpConnector, groq::GroqConnector,
    openai::OpenAiConnector, openrouter::OpenRouterConnector,
};
use super::SpendConnector;

/// Builds a connector instance from the shared HTTP client.
pub type SpendConnectorFactory = Box<dyn Fn(Client) -> Box<dyn SpendConnector> + Send + Sync>;

/// A registered connector: its descriptor plus the factory that builds it.
pub struct SpendConnectorRegistration {
    pub descriptor: ConnectorDescriptor,
    pub factory: SpendConnectorFactory,
}

/// Registry of spend connectors, keyed by descriptor id and preserving
/// registration order for deterministic listing (used by `list_connectors()`,
/// #124).
#[derive(Default)]
pub struct SpendConnectorRegistry {
    registrations: Vec<SpendConnectorRegistration>,
}

impl SpendConnectorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a connector. This is the seam where a v2 host would check
    /// `descriptor.abi_version` before accepting the connector (wired in #122).
    pub fn register(&mut self, descriptor: ConnectorDescriptor, factory: SpendConnectorFactory) {
        debug_assert!(
            self.get(descriptor.id).is_none(),
            "duplicate connector id registered: {}",
            descriptor.id
        );
        self.registrations
            .push(SpendConnectorRegistration { descriptor, factory });
    }

    /// Look up a registration by id. `None` means an unknown connector — the
    /// whitelist gate: callers must reject before any keychain/network I/O.
    pub fn get(&self, id: &str) -> Option<&SpendConnectorRegistration> {
        self.registrations.iter().find(|r| r.descriptor.id == id)
    }

    /// All descriptors in registration order — the spec's `list()` API,
    /// consumed by `list_connectors()` in #124.
    #[allow(dead_code)]
    pub fn descriptors(&self) -> impl Iterator<Item = &ConnectorDescriptor> {
        self.registrations.iter().map(|r| &r.descriptor)
    }
}

/// Build the registry of all built-in spend connectors.
///
/// Ids MUST match `crate::providers::ProviderId::as_str` — the two whitelists
/// are kept in lock-step (asserted by `registry_ids_match_provider_ids`).
pub fn spend_connector_registry() -> SpendConnectorRegistry {
    let mut registry = SpendConnectorRegistry::new();

    registry.register(
        ConnectorDescriptor {
            id: "anthropic",
            display_name: "Anthropic",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            permissions: ConnectorPermissions::default(),
            credential_schema: CredentialSchema::single_api_key(),
            available: true,
        },
        Box::new(|client| Box::new(AnthropicConnector::new(client))),
    );

    registry.register(
        ConnectorDescriptor {
            id: "openai",
            display_name: "OpenAI",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            permissions: ConnectorPermissions::default(),
            credential_schema: CredentialSchema::single_api_key(),
            available: true,
        },
        Box::new(|client| Box::new(OpenAiConnector::new(client))),
    );

    registry.register(
        ConnectorDescriptor {
            id: "openrouter",
            display_name: "OpenRouter",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            permissions: ConnectorPermissions::default(),
            credential_schema: CredentialSchema::single_api_key(),
            available: true,
        },
        Box::new(|client| Box::new(OpenRouterConnector::new(client))),
    );

    registry.register(
        ConnectorDescriptor {
            id: "groq",
            display_name: "Groq",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            permissions: ConnectorPermissions::default(),
            credential_schema: CredentialSchema::single_api_key(),
            // Groq exposes no public billing API yet (the connector returns an
            // informative error); surface it as not-yet-available.
            available: false,
        },
        Box::new(|client| Box::new(GroqConnector::new(client))),
    );

    registry.register(
        ConnectorDescriptor {
            id: "gcp",
            display_name: "Google Cloud",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            permissions: ConnectorPermissions::default(),
            // GCP needs a composite credential (service-account key + BigQuery
            // coordinates); its composite schema + handling land in #121.
            credential_schema: CredentialSchema::single_api_key(),
            available: true,
        },
        Box::new(|client| Box::new(GcpConnector::new(client))),
    );

    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderId;

    /// The canonical provider set — mirrors the `ProviderId` variants. The
    /// `registry_ids_match_provider_ids` test asserts these stay in lock-step.
    const PROVIDER_IDS: [&str; 5] = ["openai", "anthropic", "openrouter", "groq", "gcp"];

    #[test]
    fn registers_every_builtin_connector() {
        let registry = spend_connector_registry();
        assert_eq!(registry.descriptors().count(), PROVIDER_IDS.len());
        for id in PROVIDER_IDS {
            assert!(registry.get(id).is_some(), "missing connector: {id}");
        }
    }

    #[test]
    fn rejects_unknown_id_before_any_io() {
        let registry = spend_connector_registry();
        assert!(registry.get("not-a-provider").is_none());
        assert!(registry.get("").is_none());
        assert!(registry.get("Anthropic").is_none()); // case-sensitive, like the old match
    }

    #[test]
    fn factory_builds_a_connector_matching_its_descriptor_id() {
        let registry = spend_connector_registry();
        for registration in registry.descriptors().map(|d| d.id) {
            let reg = registry.get(registration).unwrap();
            let connector = (reg.factory)(Client::new());
            assert_eq!(
                connector.provider_id(),
                reg.descriptor.id,
                "factory produced a connector whose id differs from its descriptor"
            );
        }
    }

    #[test]
    fn descriptor_listing_is_deterministic() {
        let ids: Vec<&str> = spend_connector_registry()
            .descriptors()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, ["anthropic", "openai", "openrouter", "groq", "gcp"]);
    }

    #[test]
    fn groq_is_marked_unavailable() {
        let registry = spend_connector_registry();
        assert!(!registry.get("groq").unwrap().descriptor.available);
        assert!(registry.get("anthropic").unwrap().descriptor.available);
    }

    /// The registry (dispatch whitelist) and `ProviderId::parse` (keychain/DB
    /// whitelist) are a dual whitelist that must never drift apart.
    #[test]
    fn registry_ids_match_provider_ids() {
        let registry = spend_connector_registry();

        // Every registered id is a valid keychain provider.
        for descriptor in registry.descriptors() {
            assert!(
                ProviderId::parse(descriptor.id).is_ok(),
                "registry id {} is not a known ProviderId",
                descriptor.id
            );
        }

        // Every known provider is registered for dispatch.
        for id in PROVIDER_IDS {
            assert!(
                registry.get(id).is_some(),
                "ProviderId {id} has no registered connector"
            );
        }
        assert_eq!(registry.descriptors().count(), PROVIDER_IDS.len());
    }
}
