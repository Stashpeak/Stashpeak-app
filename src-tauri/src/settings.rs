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

const KEY_VAULT_ROOT: &str = "kb_vault_root";

/// Returns the configured KB vault root directory, or `None` if not yet set.
pub fn get_vault_root() -> Result<Option<String>, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [KEY_VAULT_ROOT],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Persists the KB vault root directory. The path must be a non-empty, absolute,
/// existing directory. Symlinks are resolved before storing so the stored value
/// is always the canonical (symlink-free) real path.
pub fn set_vault_root(path: String) -> Result<(), String> {
    // Reject empty/relative roots up front; later containment checks would be ambiguous.
    let p = std::path::Path::new(&path);
    if path.trim().is_empty() || !p.is_absolute() {
        return Err("vault root must be a non-empty absolute path".into());
    }
    // Canonicalize before persisting: resolves symlinks and errors on a missing path.
    let real = std::fs::canonicalize(p)
        .map_err(|_| "vault root must be an existing directory".to_string())?;
    if !real.is_dir() {
        return Err("vault root must be an existing directory".into());
    }
    let canonical = real.to_string_lossy().to_string();
    let conn = db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![KEY_VAULT_ROOT, canonical],
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Hermetic round-trip test for get_vault_root / set_vault_root.
    ///
    /// Uses STASHPEAK_DATA_DIR to redirect all DB I/O to a throwaway tempdir so the
    /// developer's real DB is never touched and CI (no settings table) passes cleanly.
    ///
    /// NOTE (forward): this is the only DB-touching test in the crate. Plan 2 will add
    /// more and MUST serialize them — `std::env::set_var` is process-global, so parallel
    /// DB tests racing on `STASHPEAK_DATA_DIR` will stomp each other. Use a `Mutex` or
    /// `serial_test` crate at that point. Not needed here (YAGNI for one test).
    #[test]
    fn vault_root_round_trips() {
        let db_dir = tempfile::tempdir().unwrap();
        // SAFETY: test-only; single-threaded (see forward note above).
        unsafe {
            std::env::set_var("STASHPEAK_DATA_DIR", db_dir.path());
        }
        // Drop guard: ensures STASHPEAK_DATA_DIR is removed even if the test panics,
        // preventing the deleted tempdir from leaking into later tests that call
        // db::connect() / db::data_dir().
        struct StashpeakDataDirGuard;
        impl Drop for StashpeakDataDirGuard {
            fn drop(&mut self) {
                // SAFETY: test-only cleanup; mirrors the set_var above.
                unsafe {
                    std::env::remove_var("STASHPEAK_DATA_DIR");
                }
            }
        }
        let _guard = StashpeakDataDirGuard;

        // open() runs migrations so the `settings` table exists in the temp DB.
        crate::db::open().unwrap();

        let vault = tempfile::tempdir().unwrap();

        // Before any set: should return None.
        assert_eq!(get_vault_root().unwrap(), None);

        // Round-trip: compare against the canonicalized path (on Windows this is the
        // \\?\... extended form; on macOS /var tempdirs resolve to /private/var).
        let input = vault.path().to_string_lossy().to_string();
        let want = std::fs::canonicalize(vault.path())
            .unwrap()
            .to_string_lossy()
            .to_string();
        set_vault_root(input).unwrap();
        assert_eq!(get_vault_root().unwrap(), Some(want));

        // Rejection cases.
        assert!(set_vault_root("".into()).is_err(), "empty must be rejected");
        assert!(
            set_vault_root("relative/dir".into()).is_err(),
            "relative path must be rejected"
        );
        assert!(
            set_vault_root(vault.path().join("missing").to_string_lossy().to_string()).is_err(),
            "non-existent path must be rejected"
        );
    }
}
