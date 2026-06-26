//! KB foundation: vault-relative canonical paths, read/search, folder-watch.
//! Read-only in this plan; the write path is owned by MCP_KB_CONTRACT.md §8.

pub mod access;
pub mod commands;
pub mod ledger;
pub mod path;
pub mod read;
pub mod search;
pub mod tokens;
pub mod watch;

#[derive(Debug, PartialEq, Eq)]
pub enum KbError {
    /// Path escaped or was not inside the vault, or used a rejected form.
    PathRejected(String),
    /// Vault root is not configured.
    NoVaultRoot,
    /// Filesystem error (read/list).
    Io(String),
}

impl std::fmt::Display for KbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KbError::PathRejected(p) => write!(f, "path rejected: {p}"),
            KbError::NoVaultRoot => write!(f, "vault root is not configured"),
            KbError::Io(e) => write!(f, "kb io error: {e}"),
        }
    }
}

impl std::error::Error for KbError {}
