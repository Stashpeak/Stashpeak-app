use rusqlite::OptionalExtension;

use serde::Serialize;

use crate::db;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub days_before: u32,
    pub enabled: bool,
}

/// Reads both notification settings in a single DB connection.
/// Use this for the initial load to avoid parallel connection issues.
pub fn get_notification_settings() -> Result<NotificationSettings, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT key, value FROM settings
             WHERE key IN ('notification_days_before', 'notifications_enabled')",
        )
        .map_err(|e| e.to_string())?;

    let mut days_before = 3u32;
    let mut enabled = true;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        match key.as_str() {
            "notification_days_before" => {
                days_before = value.parse::<u32>().unwrap_or(3);
            }
            "notifications_enabled" => {
                enabled = value != "false";
            }
            _ => {}
        }
    }

    Ok(NotificationSettings {
        days_before,
        enabled,
    })
}

pub fn get_notification_days_before() -> Result<u32, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    let days: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'notification_days_before'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(days.and_then(|v| v.parse::<u32>().ok()).unwrap_or(3))
}

pub fn set_notification_days_before(days: u32) -> Result<(), String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('notification_days_before', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![days.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_notifications_enabled() -> Result<bool, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'notifications_enabled'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(val.map(|v| v != "false").unwrap_or(true))
}

pub fn set_notifications_enabled(enabled: bool) -> Result<(), String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('notifications_enabled', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![if enabled { "true" } else { "false" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns the user's chosen home currency (e.g. "USD", "CZK").
/// Defaults to "USD" if not set.
pub fn get_home_currency() -> Result<String, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'home_currency'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(val.unwrap_or_else(|| "USD".to_string()))
}

/// Persists the user's chosen home currency. The value is uppercased and
/// trimmed before storing (e.g. " czk " → "CZK").
pub fn set_home_currency(currency: String) -> Result<(), String> {
    let currency = currency.trim().to_uppercase();
    if currency.is_empty() {
        return Err("currency must not be empty".to_string());
    }
    let conn = db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('home_currency', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![currency],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
