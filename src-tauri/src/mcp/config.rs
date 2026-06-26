/// The paste-ready MCP client config (Claude Desktop / Cursor share the
/// `mcpServers` shape). The token rides in `env`. The binary name matches the
/// [[bin]] target; the user points `command` at its installed path.
pub fn client_config_snippet(token: &str) -> String {
    let config = serde_json::json!({
        "mcpServers": {
            "stashpeak-kb": {
                "command": "stashpeak-mcp",
                "args": [],
                "env": { "STASHPEAK_MCP_TOKEN": token }
            }
        }
    });
    serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_includes_binary_and_token_and_is_valid_json() {
        let s = client_config_snippet("spk_mcp_abc123");
        assert!(s.contains("stashpeak-mcp"));
        assert!(s.contains("spk_mcp_abc123"));
        assert!(s.contains("STASHPEAK_MCP_TOKEN"));
        // The embedded mcpServers block must parse as JSON.
        let v: serde_json::Value = serde_json::from_str(&s).expect("snippet is valid json");
        assert!(v.get("mcpServers").is_some());
    }
}
