use crate::kb::{read, search, KbError};
use crate::settings;
use std::path::PathBuf;

fn vault_root() -> Result<PathBuf, String> {
    settings::get_vault_root()?
        .map(PathBuf::from)
        .ok_or_else(|| KbError::NoVaultRoot.to_string())
}

#[tauri::command]
pub async fn kb_get_vault_root() -> Result<Option<String>, String> {
    crate::run_blocking("kb_get_vault_root", settings::get_vault_root).await
}

#[tauri::command]
pub async fn kb_set_vault_root(path: String) -> Result<(), String> {
    crate::run_blocking("kb_set_vault_root", move || settings::set_vault_root(path)).await
}

#[tauri::command]
pub async fn kb_list() -> Result<Vec<String>, String> {
    crate::run_blocking("kb_list", || {
        let root = vault_root()?;
        read::list(&root).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn kb_read_note(canonical: String) -> Result<String, String> {
    crate::run_blocking("kb_read_note", move || {
        let root = vault_root()?;
        read::read_note(&root, &canonical).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn kb_search(query: String, limit: usize) -> Result<Vec<search::SearchHit>, String> {
    crate::run_blocking("kb_search", move || {
        let root = vault_root()?;
        search::search(&root, &query, limit).map_err(|e| e.to_string())
    })
    .await
}
