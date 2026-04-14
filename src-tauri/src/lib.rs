mod connectors;
mod currency;
mod db;
mod logging;
mod notifications;
mod providers;
mod secrets;
mod settings;
mod subscriptions;

async fn run_blocking<T, F>(task_name: &'static str, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| format!("{task_name} task failed: {err}"))?
}

#[tauri::command]
async fn get_upcoming_renewals() -> Result<Vec<notifications::UpcomingRenewal>, String> {
    run_blocking("get_upcoming_renewals", || {
        let days = settings::get_notification_days_before().map_err(|e| e.to_string())?;
        let enabled = settings::get_notifications_enabled().map_err(|e| e.to_string())?;
        if !enabled {
            return Ok(vec![]);
        }
        notifications::get_upcoming(days)
    })
    .await
}

#[tauri::command]
async fn db_path() -> String {
    db::data_dir()
        .join("stashpeak.db")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
async fn store_provider_api_key(provider: String, value: String) -> Result<(), String> {
    run_blocking("store_provider_api_key", move || {
        secrets::store_provider_api_key(&provider, &value).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn get_provider_api_key(provider: String) -> Result<Option<String>, String> {
    run_blocking("get_provider_api_key", move || {
        secrets::get_provider_api_key(&provider)
            .map(|opt| opt.map(|z| (*z).clone()))
            .map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn delete_provider_api_key(provider: String) -> Result<(), String> {
    run_blocking("delete_provider_api_key", move || {
        secrets::delete_provider_api_key(&provider).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn has_provider_api_key(provider: String) -> Result<bool, String> {
    run_blocking("has_provider_api_key", move || {
        secrets::has_provider_api_key(&provider).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn set_provider_enabled(provider: String, enabled: bool) -> Result<(), String> {
    run_blocking("set_provider_enabled", move || {
        providers::set_provider_enabled(&provider, enabled)
    })
    .await
}

#[tauri::command]
async fn get_provider_enabled(provider: String) -> Result<bool, String> {
    run_blocking("get_provider_enabled", move || {
        providers::is_provider_enabled(&provider)
    })
    .await
}

#[tauri::command]
async fn list_subscriptions() -> Result<Vec<subscriptions::Subscription>, String> {
    run_blocking("list_subscriptions", move || {
        subscriptions::list_subscriptions().map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn create_subscription(
    input: subscriptions::SubscriptionInput,
) -> Result<subscriptions::Subscription, String> {
    run_blocking("create_subscription", move || {
        subscriptions::create_subscription(input).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn update_subscription(
    id: i64,
    input: subscriptions::SubscriptionInput,
) -> Result<subscriptions::Subscription, String> {
    run_blocking("update_subscription", move || {
        subscriptions::update_subscription(id, input).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn delete_subscription(id: i64) -> Result<(), String> {
    run_blocking("delete_subscription", move || {
        subscriptions::delete_subscription(id).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn get_notification_settings() -> Result<settings::NotificationSettings, String> {
    run_blocking("get_notification_settings", settings::get_notification_settings).await
}

#[tauri::command]
async fn set_notification_days(days: u32) -> Result<(), String> {
    run_blocking("set_notification_days", move || {
        settings::set_notification_days_before(days)
    })
    .await
}

#[tauri::command]
async fn set_notifications_enabled(enabled: bool) -> Result<(), String> {
    run_blocking("set_notifications_enabled", move || {
        settings::set_notifications_enabled(enabled)
    })
    .await
}

#[tauri::command]
async fn get_home_currency() -> Result<String, String> {
    run_blocking("get_home_currency", settings::get_home_currency).await
}

#[tauri::command]
async fn set_home_currency(currency: String) -> Result<(), String> {
    run_blocking("set_home_currency", move || {
        settings::set_home_currency(currency)
    })
    .await
}

#[tauri::command]
async fn get_exchange_rates() -> Result<Vec<currency::ExchangeRate>, String> {
    run_blocking("get_exchange_rates", currency::get_exchange_rates).await
}

#[tauri::command]
async fn upsert_exchange_rate(from: String, to: String, rate: f64) -> Result<(), String> {
    run_blocking("upsert_exchange_rate", move || {
        currency::upsert_exchange_rate(from, to, rate)
    })
    .await
}

#[tauri::command]
async fn fetch_provider_spend(provider: String) -> Result<connectors::SpendData, String> {
    use connectors::spend::anthropic::AnthropicConnector;
    use connectors::spend::gcp::GcpConnector;
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
        "gcp" => Box::new(GcpConnector::new(client)),
        other => return Err(format!("unknown provider '{other}'")),
    };

    if !providers::is_provider_enabled(&provider)? {
        tracing::debug!(provider = connector.provider_id(), "provider is disabled, skipping fetch");
        return Err(format!("Provider {} is disabled", provider));
    }

    tracing::debug!(provider = connector.provider_id(), "spend fetch requested");
    connectors::with_retry(&DEFAULT_RETRY, || connector.fetch())
        .await
        .map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                use tauri::tray::TrayIconBuilder;

                if let Some(window) = app.get_webview_window("main") {
                    #[cfg(target_os = "macos")]
                    {
                        let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = window.set_decorations(false);
                    }
                }

                TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { .. } = event {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }
            notifications::check_and_notify(app.handle());

            // Periodic background check every 30 minutes so notifications fire
            // mid-session, not only at startup.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(30 * 60));
                interval.tick().await; // skip first tick — startup already ran
                loop {
                    interval.tick().await;
                    tauri::async_runtime::spawn_blocking({
                        let h = handle.clone();
                        move || notifications::check_and_notify(&h)
                    })
                    .await
                    .ok();
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_upcoming_renewals,
            db_path,
            store_provider_api_key,
            get_provider_api_key,
            delete_provider_api_key,
            has_provider_api_key,
            set_provider_enabled,
            get_provider_enabled,
            list_subscriptions,
            create_subscription,
            update_subscription,
            delete_subscription,
            get_notification_settings,
            set_notification_days,
            set_notifications_enabled,
            fetch_provider_spend,
            get_home_currency,
            set_home_currency,
            get_exchange_rates,
            upsert_exchange_rate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
