use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolDecl {
    pub name: String,
    pub description: String,
    /// Maps to the MCP tool annotation `readOnlyHint`. All v1 tools are read-only.
    pub read_only: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CapabilityManifest {
    pub server_name: String,
    pub server_version: String,
    /// Pinned set of supported MCP protocol versions; the shim negotiates the
    /// highest common one and degrades per the MCP rule for unknown versions.
    pub protocol_versions: Vec<String>,
    /// resources: { listChanged } — the folder-watcher emits it (§5.1).
    pub resources_list_changed: bool,
    /// tools: { listChanged } — false in v1 (the tool set is static).
    pub tools_list_changed: bool,
    /// The read tools, exactly as implemented. No write tools in v1 (Plan 5).
    pub tools: Vec<ToolDecl>,
}

/// The v1 read-only manifest. The app owns this; the shim only emits it (§5.1).
pub fn current() -> CapabilityManifest {
    CapabilityManifest {
        server_name: "stashpeak-kb".to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        // Pin the MCP protocol revisions this build implements. Update when the
        // shim's rmcp version is bumped; the shim negotiates the highest common.
        protocol_versions: vec!["2025-06-18".to_string(), "2025-03-26".to_string()],
        resources_list_changed: true,
        tools_list_changed: false,
        tools: vec![
            ToolDecl {
                name: "kb_search".to_string(),
                description:
                    "Full-text search across the knowledge base. Returns ranked path + snippet hits."
                        .to_string(),
                read_only: true,
            },
            ToolDecl {
                name: "kb_read_note".to_string(),
                description:
                    "Read one note's markdown by its vault-relative canonical path.".to_string(),
                read_only: true,
            },
            ToolDecl {
                name: "kb_list".to_string(),
                description:
                    "List the canonical paths of every readable note in the vault.".to_string(),
                read_only: true,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_manifest_is_read_only_and_advertises_only_implemented() {
        let m = current();
        assert!(m.resources_list_changed); // the watcher emits list_changed
        assert!(!m.tools_list_changed); // the tool set is static in v1
        let names: Vec<&str> = m.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["kb_search", "kb_read_note", "kb_list"]);
        // No write tools, no subscribe capability in v1.
        assert!(m.tools.iter().all(|t| t.read_only));
        assert!(!m.protocol_versions.is_empty());
    }
}
