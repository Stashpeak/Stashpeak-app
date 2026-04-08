use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use std::path::PathBuf;

/// Returns the platform-appropriate directory for Stashpeak data.
/// - Windows: %APPDATA%\Stashpeak
/// - macOS:   ~/Library/Application Support/Stashpeak
/// - Linux:   ~/.local/share/stashpeak
pub fn data_dir() -> PathBuf {
    let base = dirs::data_dir().expect("could not locate platform data directory");
    base.join("Stashpeak")
}

/// Opens (or creates) the SQLite database, runs all pending migrations,
/// and returns the connection.
pub fn open() -> rusqlite::Result<Connection> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).expect("could not create Stashpeak data directory");

    let path = dir.join("stashpeak.db");
    let mut conn = Connection::open(path)?;

    // WAL mode: better concurrent read performance, safer crash recovery
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    migrations().to_latest(&mut conn).expect("database migration failed");

    Ok(conn)
}

fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("migrations/001_initial.sql")),
    ])
}
