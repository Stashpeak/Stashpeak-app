//! MCP transport: the app-side local-IPC server + the capability manifest the
//! `stashpeak-mcp` shim emits. The shim (src/bin/mcp.rs) speaks MCP on stdio and
//! this IPC on the other side. Read-only in this plan; the write path is Plan 5.
//!
//! Trust boundary = the shim<->app IPC hop (MCP_KB_CONTRACT.md §4, THREAT_MODEL T13).

pub mod commands;
pub mod config;
pub mod lifecycle;
pub mod manifest;
pub mod server;
pub mod uri;
pub mod wire;

#[derive(Debug, PartialEq, Eq)]
pub enum McpError {
    /// IPC framing / decode error.
    Protocol(String),
    /// The request carried no valid, unrevoked token.
    Unauthorized,
    /// A read was blocked by the bulk-read brake (Pause).
    RateLimited,
    /// The vault root is not configured (server-owned, from settings).
    NoVaultRoot,
    /// Underlying KB error surfaced from the gated facade.
    Kb(String),
    /// Transport / IPC I/O error.
    Io(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::Protocol(e) => write!(f, "mcp protocol error: {e}"),
            McpError::Unauthorized => write!(f, "unauthorized: no valid token"),
            McpError::RateLimited => write!(f, "rate limited: read budget paused"),
            McpError::NoVaultRoot => write!(f, "vault root is not configured"),
            McpError::Kb(e) => write!(f, "kb error: {e}"),
            McpError::Io(e) => write!(f, "mcp io error: {e}"),
        }
    }
}

impl std::error::Error for McpError {}
