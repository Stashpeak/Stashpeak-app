mod connectors;
mod currency;
mod db;
mod logging;
mod notifications;
mod products;
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

/// The OS *regional format* locale (e.g. "cs-CZ"), read via GetUserDefaultLocaleName.
/// We must use the regional format, NOT the UI language: a machine with an English
/// display language but Czech regional settings should still format dates the Czech
/// way. (sys-locale returns the UI language, "en-US" here, which is wrong for this.)
#[cfg(target_os = "windows")]
fn windows_regional_locale() -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    // LOCALE_NAME_MAX_LENGTH is 85 wide chars.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultLocaleName(lp_locale_name: *mut u16, cch_locale_name: i32) -> i32;
    }

    let mut buf = [0u16; 85];
    // Returns the length including the terminating null, or 0 on failure.
    let len = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 1 {
        return None;
    }
    let locale = OsString::from_wide(&buf[..(len as usize - 1)])
        .into_string()
        .ok()?;
    // Only accept a well-formed locale tag (ASCII letters/digits/hyphen) so the value
    // can never inject extra arguments into WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
    if locale.is_empty()
        || !locale
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    Some(locale)
}

#[tauri::command]
async fn store_provider_api_key(provider: String, value: String) -> Result<(), String> {
    run_blocking("store_provider_api_key", move || {
        secrets::store_provider_api_key(&provider, &value).map_err(|err| err.to_string())
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
async fn get_suppressed_link_ids() -> Result<Vec<i64>, String> {
    run_blocking("get_suppressed_link_ids", move || {
        subscriptions::get_suppressed_link_ids().map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn get_pinned_subscription_ids() -> Result<Vec<i64>, String> {
    run_blocking("get_pinned_subscription_ids", move || {
        subscriptions::get_pinned_subscription_ids().map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn get_product_visibility() -> Result<Vec<products::ProductVisibility>, String> {
    run_blocking("get_product_visibility", move || {
        products::get_product_visibility().map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn set_subscription_link_suppressed(id: i64, suppressed: bool) -> Result<(), String> {
    run_blocking("set_subscription_link_suppressed", move || {
        subscriptions::set_subscription_link_suppressed(id, suppressed)
            .map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn set_subscription_link_pinned(id: i64, pinned: bool) -> Result<(), String> {
    run_blocking("set_subscription_link_pinned", move || {
        subscriptions::set_subscription_link_pinned(id, pinned).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn set_product_visibility(product_id: String, enabled: bool) -> Result<(), String> {
    run_blocking("set_product_visibility", move || {
        products::set_product_visibility(product_id, enabled).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn get_notification_settings() -> Result<settings::NotificationSettings, String> {
    run_blocking(
        "get_notification_settings",
        settings::get_notification_settings,
    )
    .await
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
    use connectors::registry::spend_connector_registry;
    use connectors::{http, ConnectorCtx, SpendConnector, DEFAULT_RETRY};

    let registry = spend_connector_registry();

    // The registry is the dispatch whitelist gate: an unregistered id is
    // rejected here, before any keychain or network I/O. This moves (does not
    // delete) the ProviderId::parse boundary that still guards the keychain/DB.
    let registration = registry
        .get(&provider)
        .ok_or_else(|| format!("unknown provider '{provider}'"))?;

    let client = http::build_client();
    let connector: Box<dyn SpendConnector> = (registration.factory)();

    if !providers::is_provider_enabled(&provider)? {
        tracing::debug!(
            provider = connector.provider_id(),
            "provider is disabled, skipping fetch"
        );
        return Err(format!("Provider {} is disabled", provider));
    }

    // The host broker, bound to THIS connector's descriptor — the connector's
    // only path to its identity-bound credential and to network egress.
    let ctx = ConnectorCtx::new(registration.descriptor.clone(), client);

    // with_retry still wraps the whole fetch as one unit: a connector that issues
    // several `ctx.send`s (pagination, multi-period) retries together, exactly as
    // before the broker. ctx.send itself does a single round-trip.
    tracing::debug!(provider = connector.provider_id(), "spend fetch requested");
    connectors::with_retry(&DEFAULT_RETRY, || connector.fetch(&ctx))
        .await
        .map_err(|e| e.to_string())
}

/// List the registered spend connectors as their declared descriptors (#124).
/// Additive and read-only — the frontend stays on its static provider list during
/// the strangler; migrating the list source to this command is a separate later
/// step (spec §5/§9). Mirrors the registry's dispatch order.
#[tauri::command]
fn list_connectors() -> Vec<connectors::descriptor::ConnectorInfo> {
    connectors::registry::spend_connector_registry()
        .descriptors()
        .map(connectors::descriptor::ConnectorInfo::from)
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2 on Windows reports navigator.language as en-US regardless of the OS
    // regional format, so every Intl default and the native date input render in
    // English. Seed the WebView2 UI language from the regional-format locale before
    // the window is created; Chromium honours --lang for navigator.language and
    // locale-dependent rendering.
    #[cfg(target_os = "windows")]
    if let Some(locale) = windows_regional_locale() {
        // --lang sets the UI locale (drives the native date input and, verified by
        // smoke, navigator.language); --accept-lang sets Accept-Language /
        // navigator.languages per the WebView2 browser-flag docs. Append both to any
        // args the caller already set (e.g. --remote-debugging-port) rather than
        // overwriting them.
        let locale_args = format!("--lang={locale} --accept-lang={locale}");
        let args = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(existing) if !existing.trim().is_empty() => format!("{existing} {locale_args}"),
            _ => locale_args,
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
    }

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
                use tauri::tray::TrayIconBuilder;
                use tauri::Manager;

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
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
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
            delete_provider_api_key,
            has_provider_api_key,
            set_provider_enabled,
            get_provider_enabled,
            list_subscriptions,
            create_subscription,
            update_subscription,
            delete_subscription,
            get_suppressed_link_ids,
            get_pinned_subscription_ids,
            get_product_visibility,
            set_subscription_link_suppressed,
            set_subscription_link_pinned,
            set_product_visibility,
            get_notification_settings,
            set_notification_days,
            set_notifications_enabled,
            fetch_provider_spend,
            list_connectors,
            get_home_currency,
            set_home_currency,
            get_exchange_rates,
            upsert_exchange_rate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
