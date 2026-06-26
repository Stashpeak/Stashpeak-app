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
    // Snapshot the live state BEFORE mutating so a persist-failure rollback
    // restores the PREVIOUS state, not the requested one — an idempotent toggle
    // (e.g. disabling an already-stopped service) must never flip the live server.
    let was_running = service.is_running();
    // Flip the live service FIRST, persist the setting only after it succeeds, so
    // a bind/watcher failure never leaves `mcp_kb_access_enabled = true` while the
    // server is actually down (settings always reflect the real running state).
    if enabled {
        service.start(&app).map_err(|e| e.to_string())?;
    } else {
        service.stop();
    }
    // Persist last (blocking). If this write fails, roll the live service back to
    // its PREVIOUS state so settings and the live state never disagree.
    if let Err(e) = crate::run_blocking("mcp_set_enabled", move || {
        settings::set_mcp_enabled(enabled)
    })
    .await
    {
        if enabled && !was_running {
            // We started it for this request; the persist failed, so undo the start.
            service.stop();
        } else if !enabled && was_running {
            // We stopped a running service; the persist failed, so the stored value
            // may still say `true`. Restart to keep settings and live state aligned
            // (boot reads the persisted value).
            if let Err(start_err) = service.start(&app) {
                tracing::error!(
                    error = %start_err,
                    "failed to restore mcp service after disable setting write failed"
                );
            }
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
