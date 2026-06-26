use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use std::path::PathBuf;

/// Returns the platform-appropriate directory for Stashpeak data.
/// - Windows: %APPDATA%\Stashpeak
/// - macOS:   ~/Library/Application Support/Stashpeak
/// - Linux:   ~/.local/share/stashpeak
///
/// Override via `STASHPEAK_DATA_DIR` (primarily a test seam; also allows relocating data).
pub fn data_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("STASHPEAK_DATA_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let base = dirs::data_dir().expect("could not locate platform data directory");
    base.join(if cfg!(debug_assertions) {
        "Stashpeak-dev"
    } else {
        "Stashpeak"
    })
}

/// Opens (or creates) the SQLite database, runs all pending migrations,
/// and returns the connection. Call this only once at startup.
pub fn open() -> rusqlite::Result<Connection> {
    let mut conn = connect()?;
    migrations()
        .to_latest(&mut conn)
        .expect("database migration failed");
    Ok(conn)
}

/// Opens a connection to the existing database without running migrations.
/// Use this for all runtime operations (commands, background checks).
pub fn connect() -> rusqlite::Result<Connection> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).expect("could not create Stashpeak data directory");

    let path = dir.join("stashpeak.db");
    let conn = Connection::open(path)?;

    // WAL mode: better concurrent read performance, safer crash recovery
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    Ok(conn)
}

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("migrations/001_initial.sql")),
        M::up(include_str!("migrations/002_settings.sql")),
        M::up(include_str!("migrations/003_currency_settings.sql")),
        M::up(include_str!("migrations/004_provider_enabled.sql")),
        M::up(include_str!(
            "migrations/005_subscription_link_overrides.sql"
        )),
        M::up(include_str!("migrations/006_subscription_link_pins.sql")),
        M::up(include_str!("migrations/007_product_visibility.sql")),
        M::up(include_str!("migrations/008_mcp.sql")),
    ])
}

#[cfg(test)]
pub(crate) fn open_in_memory_migrated() -> Connection {
    let mut conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch("PRAGMA foreign_keys=ON;").expect("pragma");
    migrations()
        .to_latest(&mut conn)
        .expect("migrations apply to in-memory db");
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_008_creates_mcp_tables() {
        let conn = open_in_memory_migrated();
        // Both tables exist and are empty.
        let clients: i64 = conn
            .query_row("SELECT COUNT(*) FROM mcp_clients", [], |r| r.get(0))
            .expect("mcp_clients table exists");
        let ledger: i64 = conn
            .query_row("SELECT COUNT(*) FROM mcp_activity_ledger", [], |r| r.get(0))
            .expect("mcp_activity_ledger table exists");
        assert_eq!(clients, 0);
        assert_eq!(ledger, 0);
    }
}
