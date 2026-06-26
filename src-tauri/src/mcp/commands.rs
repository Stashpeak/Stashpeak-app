use crate::kb::{ledger, tokens};
use crate::mcp::config;
use crate::mcp::lifecycle::McpService;
use crate::settings;
use tauri::Manager;

#[tauri::command]
pub async fn mcp_get_enabled() -> Result<bool, String> {
    crate::run_blocking("mcp_get_enabled", settings::get_mcp_enabled).await
}

#[tauri::command]
pub async fn mcp_set_enabled(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    // The whole enable/disable transaction (snapshot -> flip -> persist -> rollback)
    // runs synchronously under McpService's toggle lock so two concurrent toggles
    // can't interleave; run it off the async executor via run_blocking. The service
    // is re-fetched from managed state inside the 'static closure (the State borrow
    // can't cross the spawn_blocking boundary).
    crate::run_blocking("mcp_set_enabled", move || {
        let service = app.state::<McpService>();
        service.set_enabled_txn(&app, enabled)
    })
    .await
}

#[tauri::command]
pub async fn mcp_mint_token(label: String, scope: String) -> Result<String, String> {
    crate::run_blocking("mcp_mint_token", move || {
        let scope = match scope.as_str() {
            "read" => tokens::Scope::Read,
            // Read-only phase: refuse to mint a higher-privilege credential that
            // would silently gain write power when write tools land. Plan 5
            // re-enables this alongside the write path + consent UI.
            "read_write" => {
                return Err(
                    "read_write MCP tokens are not supported yet (read-only phase)".to_string(),
                )
            }
            other => return Err(format!("unknown scope '{other}'")),
        };
        tokens::mint(label, scope)
    })
    .await
}

#[tauri::command]
pub async fn mcp_list_tokens() -> Result<Vec<tokens::TokenInfo>, String> {
    crate::run_blocking("mcp_list_tokens", tokens::list).await
}

#[tauri::command]
pub async fn mcp_revoke_token(id: String) -> Result<(), String> {
    crate::run_blocking("mcp_revoke_token", move || tokens::revoke(&id)).await
}

#[tauri::command]
pub async fn mcp_recent_activity(limit: usize) -> Result<Vec<ledger::LedgerRow>, String> {
    crate::run_blocking("mcp_recent_activity", move || ledger::recent(limit)).await
}

#[tauri::command]
pub async fn mcp_client_config_snippet(token: String) -> Result<String, String> {
    Ok(config::client_config_snippet(&token))
}
