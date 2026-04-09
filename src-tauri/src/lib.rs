mod db;
mod logging;
mod secrets;

#[tauri::command]
fn db_path() -> String {
    db::data_dir()
        .join("stashpeak.db")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn store_provider_api_key(provider: String, value: String) -> Result<(), String> {
    secrets::store_provider_api_key(&provider, &value).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_provider_api_key(provider: String) -> Result<Option<String>, String> {
    secrets::get_provider_api_key(&provider).map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_provider_api_key(provider: String) -> Result<(), String> {
    secrets::delete_provider_api_key(&provider).map_err(|err| err.to_string())
}

#[tauri::command]
fn has_provider_api_key(provider: String) -> Result<bool, String> {
    secrets::has_provider_api_key(&provider).map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init().expect("failed to initialize logging");

    // Open (and migrate) the database before the window opens.
    // Panic early if the DB is broken rather than showing a corrupt UI.
    db::open().expect("failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            db_path,
            store_provider_api_key,
            get_provider_api_key,
            delete_provider_api_key,
            has_provider_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
