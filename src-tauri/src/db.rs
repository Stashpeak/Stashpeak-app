use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use std::path::PathBuf;

/// Returns the platform-appropriate directory for Stashpeak data.
/// - Windows: %APPDATA%\Stashpeak
/// - macOS:   ~/Library/Application Support/Stashpeak
/// - Linux:   ~/.local/share/stashpeak
pub fn data_dir() -> PathBuf {
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
    ])
}
