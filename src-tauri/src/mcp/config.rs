use std::path::Path;

#[cfg(windows)]
const SHIM_BIN_NAME: &str = "stashpeak-mcp.exe";
#[cfg(not(windows))]
const SHIM_BIN_NAME: &str = "stashpeak-mcp";

/// Build the absolute `command` for the config snippet: the shim binary sitting
/// in `dir` (the directory of the running app executable). Pure + deterministic
/// so it can be unit-tested without touching `current_exe()`.
fn shim_command_in(dir: &Path) -> String {
    dir.join(SHIM_BIN_NAME).to_string_lossy().into_owned()
}

/// Resolve the shim `command` to an absolute path next to the running app
/// executable. Falls back to the bare binary name if `current_exe()` (or its
/// parent) can't be resolved, so the snippet is always producible.
fn resolve_shim_command() -> String {
    match std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        Some(dir) => shim_command_in(&dir),
        None => SHIM_BIN_NAME.to_string(),
    }
}

/// The paste-ready MCP client config (Claude Desktop / Cursor share the
/// `mcpServers` shape). The token rides in `env`. The `command` is the
/// resolved absolute path of the stashpeak-mcp shim next to the app executable.
pub fn client_config_snippet(token: &str) -> String {
    let command = resolve_shim_command();
    let config = serde_json::json!({
        "mcpServers": {
            "stashpeak-kb": {
                "command": command,
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
    use std::path::Path;

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

    #[test]
    fn shim_command_in_joins_dir_and_binary() {
        // Use a platform-appropriate absolute directory for testing.
        #[cfg(windows)]
        let dir = Path::new("C:\\opt\\app");
        #[cfg(not(windows))]
        let dir = Path::new("/opt/app");

        let result = shim_command_in(dir);

        // The result must end with the shim binary name.
        assert!(
            result.ends_with(SHIM_BIN_NAME),
            "expected result to end with {SHIM_BIN_NAME}, got: {result}"
        );
        // The result must start with the directory string.
        assert!(
            result.starts_with(dir.to_str().unwrap()),
            "expected result to start with {:?}, got: {result}",
            dir
        );
        // An absolute dir input must produce an absolute path result.
        assert!(
            Path::new(&result).is_absolute(),
            "expected absolute path, got: {result}"
        );
    }

    #[test]
    fn snippet_command_is_absolute() {
        let s = client_config_snippet("spk_mcp_test");
        let v: serde_json::Value = serde_json::from_str(&s).expect("snippet is valid json");
        let cmd = v["mcpServers"]["stashpeak-kb"]["command"]
            .as_str()
            .expect("command field is a string");

        assert!(
            Path::new(cmd).is_absolute(),
            "expected command to be an absolute path, got: {cmd}"
        );
        assert!(
            cmd.ends_with(SHIM_BIN_NAME),
            "expected command to end with {SHIM_BIN_NAME}, got: {cmd}"
        );
    }
}
