mod db;

#[tauri::command]
fn db_path() -> String {
    db::data_dir()
        .join("stashpeak.db")
        .to_string_lossy()
        .to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Open (and migrate) the database before the window opens.
    // Panic early if the DB is broken rather than showing a corrupt UI.
    db::open().expect("failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![db_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
