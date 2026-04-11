mod connectors;
mod db;
mod logging;
mod notifications;
mod providers;
mod secrets;
mod settings;
mod subscriptions;

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
    secrets::get_provider_api_key(&provider)
        .map(|opt| opt.map(|z| (*z).clone()))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_provider_api_key(provider: String) -> Result<(), String> {
    secrets::delete_provider_api_key(&provider).map_err(|err| err.to_string())
}

#[tauri::command]
fn has_provider_api_key(provider: String) -> Result<bool, String> {
    secrets::has_provider_api_key(&provider).map_err(|err| err.to_string())
}

#[tauri::command]
fn list_subscriptions() -> Result<Vec<subscriptions::Subscription>, String> {
    subscriptions::list_subscriptions().map_err(|err| err.to_string())
}

#[tauri::command]
fn create_subscription(
    input: subscriptions::SubscriptionInput,
) -> Result<subscriptions::Subscription, String> {
    subscriptions::create_subscription(input).map_err(|err| err.to_string())
}

#[tauri::command]
fn update_subscription(
    id: i64,
    input: subscriptions::SubscriptionInput,
) -> Result<subscriptions::Subscription, String> {
    subscriptions::update_subscription(id, input).map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_subscription(id: i64) -> Result<(), String> {
    subscriptions::delete_subscription(id).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_notification_settings() -> Result<settings::NotificationSettings, String> {
    settings::get_notification_settings()
}

#[tauri::command]
fn set_notification_days(days: u32) -> Result<(), String> {
    settings::set_notification_days_before(days)
}

#[tauri::command]
fn set_notifications_enabled(enabled: bool) -> Result<(), String> {
    settings::set_notifications_enabled(enabled)
}

#[tauri::command]
fn fetch_provider_spend(provider: String) -> Result<connectors::SpendData, String> {
    use connectors::spend::anthropic::AnthropicConnector;
    use connectors::spend::groq::GroqConnector;
    use connectors::spend::openai::OpenAiConnector;
    use connectors::spend::openrouter::OpenRouterConnector;
    use connectors::{http, SpendConnector, DEFAULT_RETRY};

    let client = http::build_client();

    let connector: Box<dyn SpendConnector> = match provider.as_str() {
        "anthropic" => Box::new(AnthropicConnector::new(client)),
        "openai" => Box::new(OpenAiConnector::new(client)),
        "openrouter" => Box::new(OpenRouterConnector::new(client)),
        "groq" => Box::new(GroqConnector::new(client)),
        other => return Err(format!("unknown provider '{other}'")),
    };

    tracing::debug!(provider = connector.provider_id(), "spend fetch requested");
    connectors::with_retry(&DEFAULT_RETRY, || connector.fetch()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init().expect("failed to initialize logging");

    // Open (and migrate) the database before the window opens.
    // Panic early if the DB is broken rather than showing a corrupt UI.
    db::open().expect("failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            notifications::check_and_notify(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_path,
            store_provider_api_key,
            get_provider_api_key,
            delete_provider_api_key,
            has_provider_api_key,
            list_subscriptions,
            create_subscription,
            update_subscription,
            delete_subscription,
            get_notification_settings,
            set_notification_days,
            set_notifications_enabled,
            fetch_provider_spend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
