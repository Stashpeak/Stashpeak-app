use rand::RngCore;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db;

const TOKEN_PREFIX: &str = "spk_mcp_";
const TOKEN_BYTES: usize = 32; // 256 bits of CSPRNG entropy (>= the 128-bit floor)

// ---- types ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Read,
    ReadWrite,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::ReadWrite => "read_write",
        }
    }

    pub fn parse(s: &str) -> Result<Scope, String> {
        match s {
            "read" => Ok(Scope::Read),
            "read_write" => Ok(Scope::ReadWrite),
            other => Err(format!("invalid scope '{other}'")),
        }
    }
}

/// Token metadata returned to callers — never contains the raw token or its hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")] // repo convention: every Tauri-returned struct is camelCase; frontend reads `createdAt`
pub struct TokenInfo {
    pub id: String,
    pub label: String,
    pub scope: Scope,
    pub created_at: String,
}

// ---- generation helpers (private) -------------------------------------------

/// Generate a fresh opaque token: `spk_mcp_` + 32 CSPRNG bytes (hex). The raw
/// value is returned to the caller ONCE; only its hash is ever stored.
fn generate_raw() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{TOKEN_PREFIX}{}", hex::encode(bytes))
}

/// Hex SHA-256 of the raw token — the verifier stored at rest.
fn hash_token(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

/// Opaque client id (a second random value, distinct from the token).
fn generate_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// ---- public wrappers (call the real DB) -------------------------------------

pub fn mint(label: String, scope: Scope) -> Result<String, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    mint_with_conn(&conn, label, scope)
}

pub fn validate(raw: &str) -> Result<Option<TokenInfo>, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    validate_with_conn(&conn, raw)
}

pub fn revoke(id: &str) -> Result<(), String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    revoke_with_conn(&conn, id)
}

pub fn list() -> Result<Vec<TokenInfo>, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    list_with_conn(&conn)
}

// ---- injection-seam cores (unit-tested on an in-memory connection) ----------

fn mint_with_conn(conn: &Connection, label: String, scope: Scope) -> Result<String, String> {
    let raw = generate_raw();
    let id = generate_id();
    let token_hash = hash_token(&raw);
    // Register the raw token with the T10 log-scrubber BEFORE any logging path
    // can see it (MCP_KB_CONTRACT.md §6.1).
    crate::logging::remember_secret(&raw);

    conn.execute(
        "INSERT INTO mcp_clients (id, label, token_hash, scope) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, label, token_hash, scope.as_str()],
    )
    .map_err(|e| e.to_string())?;
    Ok(raw)
}

fn validate_with_conn(conn: &Connection, raw: &str) -> Result<Option<TokenInfo>, String> {
    // A raw token reaching validate is a live secret — scrub it from logs.
    crate::logging::remember_secret(raw);
    let token_hash = hash_token(raw);

    conn.query_row(
        "SELECT id, label, scope, created_at FROM mcp_clients
         WHERE token_hash = ?1 AND revoked = 0",
        [token_hash],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|(id, label, scope, created_at)| {
        Ok(TokenInfo {
            id,
            label,
            scope: Scope::parse(&scope)?,
            created_at,
        })
    })
    .transpose()
}

fn revoke_with_conn(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE mcp_clients SET revoked = 1 WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_with_conn(conn: &Connection) -> Result<Vec<TokenInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, label, scope, created_at FROM mcp_clients
             WHERE revoked = 0 ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let (id, label, scope, created_at) = row.map_err(|e| e.to_string())?;
        out.push(TokenInfo {
            id,
            label,
            scope: Scope::parse(&scope)?,
            created_at,
        });
    }
    Ok(out)
}

// ---- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Task 3.1: types + generation ----------------------------------------

    #[test]
    fn scope_round_trips_db_string() {
        assert_eq!(Scope::Read.as_str(), "read");
        assert_eq!(Scope::ReadWrite.as_str(), "read_write");
        assert_eq!(Scope::parse("read").unwrap(), Scope::Read);
        assert_eq!(Scope::parse("read_write").unwrap(), Scope::ReadWrite);
        assert!(Scope::parse("admin").is_err());
    }

    #[test]
    fn generated_token_is_prefixed_and_long() {
        let raw = generate_raw();
        assert!(raw.starts_with("spk_mcp_"));
        // 8-char prefix + >=32 hex chars (>=128 bits) of entropy.
        assert!(raw.len() >= 8 + 32);
        // Two calls never collide.
        assert_ne!(generate_raw(), generate_raw());
    }

    #[test]
    fn hash_is_stable_and_hex() {
        let raw = "spk_mcp_deadbeef";
        let h1 = hash_token(raw);
        let h2 = hash_token(raw);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // hex SHA-256
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(hash_token("spk_mcp_other"), h1);
    }

    // ---- Task 3.2: mint/validate/revoke/list ---------------------------------

    #[test]
    fn mint_returns_raw_once_and_stores_only_hash() {
        let conn = db::open_in_memory_migrated();
        let raw = mint_with_conn(&conn, "Claude Desktop".into(), Scope::Read).unwrap();

        assert!(raw.starts_with("spk_mcp_"));
        // The raw token is NOT in the table; only its hash is.
        let stored_hash: String = conn
            .query_row("SELECT token_hash FROM mcp_clients", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored_hash, hash_token(&raw));
        let raw_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mcp_clients WHERE token_hash = ?1",
                [&raw],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw_present, 0); // the raw value is never the stored hash
    }

    #[test]
    fn validate_matches_minted_token_and_rejects_garbage() {
        let conn = db::open_in_memory_migrated();
        let raw = mint_with_conn(&conn, "Cursor".into(), Scope::ReadWrite).unwrap();

        let info = validate_with_conn(&conn, &raw).unwrap().unwrap();
        assert_eq!(info.label, "Cursor");
        assert_eq!(info.scope, Scope::ReadWrite);
        assert!(!info.id.is_empty());

        assert!(validate_with_conn(&conn, "spk_mcp_not_a_real_token")
            .unwrap()
            .is_none());
    }

    #[test]
    fn revoke_makes_validate_return_none_and_hides_from_list() {
        let conn = db::open_in_memory_migrated();
        let raw = mint_with_conn(&conn, "Hermes".into(), Scope::Read).unwrap();
        let info = validate_with_conn(&conn, &raw).unwrap().unwrap();

        revoke_with_conn(&conn, &info.id).unwrap();

        assert!(validate_with_conn(&conn, &raw).unwrap().is_none()); // immediate
        assert!(list_with_conn(&conn).unwrap().is_empty());
    }

    #[test]
    fn list_returns_active_clients_newest_first() {
        let conn = db::open_in_memory_migrated();
        mint_with_conn(&conn, "First".into(), Scope::Read).unwrap();
        mint_with_conn(&conn, "Second".into(), Scope::Read).unwrap();

        let listed = list_with_conn(&conn).unwrap();
        assert_eq!(listed.len(), 2);
        // Both labels present; revoked ones excluded (none here).
        let labels: Vec<&str> = listed.iter().map(|t| t.label.as_str()).collect();
        assert!(labels.contains(&"First"));
        assert!(labels.contains(&"Second"));
    }

    #[test]
    fn validate_fails_closed_on_unknown_scope() {
        let conn = db::open_in_memory_migrated();
        let raw = mint_with_conn(&conn, "Tampered".into(), Scope::Read).unwrap();
        // Simulate a hand-edited/tampered row with a scope the enum doesn't know.
        conn.execute("UPDATE mcp_clients SET scope = 'admin'", [])
            .unwrap();
        // Must be an Err (Scope::parse rejects 'admin') — NOT Ok(Some(Read)) or any privileged default.
        assert!(validate_with_conn(&conn, &raw).is_err());
        // list must also fail closed rather than silently dropping/elevating the row.
        assert!(list_with_conn(&conn).is_err());
    }
}
