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
    is_abi_compatible, ConnectorDescriptor, ConnectorPermissions, CredentialSchema,
    CONNECTOR_ABI_VERSION,
};
use super::spend::{
    anthropic::AnthropicConnector, gcp::GcpConnector, groq::GroqConnector, openai::OpenAiConnector,
    openrouter::OpenRouterConnector,
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

    /// Register a connector. Enforces the load-time ABI compatibility gate (spec
    /// E5): a descriptor whose `abi_version` the host cannot speak must not become
    /// dispatchable.
    ///
    /// In v1 every connector is first-party and compiled against
    /// [`CONNECTOR_ABI_VERSION`], so a mismatch can only be a programming mistake;
    /// a `debug_assert!` makes it a hard CI failure while staying panic-free in
    /// release. When the v2 `Native | Wasm` loader admits untrusted guests this
    /// gate hardens into a runtime reject — the same seam, a stricter failure mode.
    pub fn register(&mut self, descriptor: ConnectorDescriptor, factory: SpendConnectorFactory) {
        debug_assert!(
            is_abi_compatible(descriptor.abi_version),
            "connector '{}' declares abi_version {} but the host supports {}",
            descriptor.id,
            descriptor.abi_version,
            CONNECTOR_ABI_VERSION
        );
        debug_assert!(
            self.get(descriptor.id).is_none(),
            "duplicate connector id registered: {}",
            descriptor.id
        );
        self.registrations.push(SpendConnectorRegistration {
            descriptor,
            factory,
        });
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
            // Cost Report API — the only egress host.
            permissions: ConnectorPermissions {
                network: vec!["api.anthropic.com"],
                storage: vec![],
            },
            credential_schema: CredentialSchema::single_api_key(),
            available: true,
        },
        Box::new(|_client| Box::new(AnthropicConnector)),
    );

    registry.register(
        ConnectorDescriptor {
            id: "openai",
            display_name: "OpenAI",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            // /organization/costs + the legacy /v1/usage fallback share this host.
            permissions: ConnectorPermissions {
                network: vec!["api.openai.com"],
                storage: vec![],
            },
            credential_schema: CredentialSchema::single_api_key(),
            available: true,
        },
        Box::new(|_client| Box::new(OpenAiConnector)),
    );

    registry.register(
        ConnectorDescriptor {
            id: "openrouter",
            display_name: "OpenRouter",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            // /api/v1/auth/key — the only egress host.
            permissions: ConnectorPermissions {
                network: vec!["openrouter.ai"],
                storage: vec![],
            },
            credential_schema: CredentialSchema::single_api_key(),
            available: true,
        },
        Box::new(|_client| Box::new(OpenRouterConnector)),
    );

    registry.register(
        ConnectorDescriptor {
            id: "groq",
            display_name: "Groq",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            // No egress: Groq exposes no billing API, so the connector never calls
            // ctx.send. An empty allowlist denies all egress (fail-closed) — safe
            // here, and it would block any accidental future send until a host is
            // declared.
            permissions: ConnectorPermissions {
                network: vec![],
                storage: vec![],
            },
            credential_schema: CredentialSchema::single_api_key(),
            // Groq exposes no public billing API yet (the connector returns an
            // informative error); surface it as not-yet-available.
            available: false,
        },
        Box::new(|_client| Box::new(GroqConnector)),
    );

    registry.register(
        ConnectorDescriptor {
            id: "gcp",
            display_name: "Google Cloud",
            kind: "spend",
            abi_version: CONNECTOR_ABI_VERSION,
            // OAuth token exchange + BigQuery query — two distinct egress hosts.
            // NOT www.googleapis.com: that is only the bigquery.readonly *scope*
            // URI inside the signed JWT claims, never a request target.
            permissions: ConnectorPermissions {
                network: vec!["oauth2.googleapis.com", "bigquery.googleapis.com"],
                storage: vec![],
            },
            // Composite credential: service-account key (secret, signed host-side
            // via ctx.sign) + BigQuery coordinates (non-secret). Brokered in #121.
            credential_schema: CredentialSchema::gcp_service_account(),
            available: true,
        },
        Box::new(|_client| Box::new(GcpConnector)),
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

    // ── ABI gate + network allowlist (#122) ───────────────────────────────────

    /// Every built-in declares the host ABI, so the load-time gate is a no-op for
    /// them (and stays that way until the ABI is bumped).
    #[test]
    fn all_builtins_register_at_host_abi() {
        for d in spend_connector_registry().descriptors() {
            assert_eq!(d.abi_version, CONNECTOR_ABI_VERSION, "{} abi", d.id);
            assert!(is_abi_compatible(d.abi_version));
        }
    }

    /// The load-time ABI gate refuses a descriptor the host cannot speak. The gate
    /// is a `debug_assert!`, so this only fires in debug builds.
    #[cfg(debug_assertions)]
    #[test]
    fn register_rejects_incompatible_abi() {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // silence the expected panic backtrace
        let result = std::panic::catch_unwind(|| {
            let mut registry = SpendConnectorRegistry::new();
            registry.register(
                ConnectorDescriptor {
                    id: "future",
                    display_name: "Future",
                    kind: "spend",
                    abi_version: CONNECTOR_ABI_VERSION + 1,
                    permissions: ConnectorPermissions::default(),
                    credential_schema: CredentialSchema::single_api_key(),
                    available: true,
                },
                Box::new(|_client| Box::new(GroqConnector)),
            );
        });
        std::panic::set_hook(prev);
        assert!(
            result.is_err(),
            "a descriptor declaring an incompatible abi_version must trip the gate"
        );
    }

    /// Fail-closed safety net: every AVAILABLE connector declares at least one
    /// egress host (an empty allowlist denies all egress at runtime, which would
    /// brick an available connector that actually calls `ctx.send`).
    #[test]
    fn every_available_connector_declares_a_network_host() {
        for d in spend_connector_registry().descriptors() {
            if d.available {
                assert!(
                    !d.permissions.network.is_empty(),
                    "available connector {} declares no network host",
                    d.id
                );
            }
        }
    }

    /// Pin each connector's declared egress hosts to its real `send()` targets, so
    /// a URL change without a manifest update is caught (a missing host would brick
    /// that connector under the fail-closed gate; an extra host over-grants).
    #[test]
    fn registry_declares_real_egress_hosts() {
        let registry = spend_connector_registry();
        let hosts = |id: &str| {
            registry
                .get(id)
                .unwrap()
                .descriptor
                .permissions
                .network
                .clone()
        };
        assert_eq!(hosts("anthropic"), vec!["api.anthropic.com"]);
        assert_eq!(hosts("openai"), vec!["api.openai.com"]);
        assert_eq!(hosts("openrouter"), vec!["openrouter.ai"]);
        assert_eq!(
            hosts("gcp"),
            vec!["oauth2.googleapis.com", "bigquery.googleapis.com"]
        );
        assert!(hosts("groq").is_empty(), "groq has no egress");
    }
}
