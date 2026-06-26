use crate::kb::{ledger, tokens};
use crate::mcp::config;
use crate::mcp::lifecycle::McpService;
use crate::settings;
use tauri::State;

#[tauri::command]
pub async fn mcp_get_enabled() -> Result<bool, String> {
    crate::run_blocking("mcp_get_enabled", settings::get_mcp_enabled).await
}

#[tauri::command]
pub async fn mcp_set_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    service: State<'_, McpService>,
) -> Result<(), String> {
    // Flip the live service FIRST, persist the setting only after it succeeds, so
    // a bind/watcher failure never leaves `mcp_kb_access_enabled = true` while the
    // server is actually down (settings always reflect the real running state).
    if enabled {
        service.start(&app).map_err(|e| e.to_string())?;
    } else {
        service.stop();
    }
    // Persist last (blocking). If this write fails after a successful start, roll
    // the service back so settings and the live state never disagree.
    if let Err(e) = crate::run_blocking("mcp_set_enabled", move || {
        settings::set_mcp_enabled(enabled)
    })
    .await
    {
        if enabled {
            service.stop();
        }
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_mint_token(label: String, scope: String) -> Result<String, String> {
    crate::run_blocking("mcp_mint_token", move || {
        let scope = match scope.as_str() {
            "read" => tokens::Scope::Read,
            "read_write" => tokens::Scope::ReadWrite,
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
