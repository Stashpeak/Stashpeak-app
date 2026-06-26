# MCP Transport & Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan 3 of the MCP read-first series.** This plan builds the **transport** — the app-side local-IPC server and the standalone `stashpeak-mcp` shim binary that MCP clients spawn — plus the Tauri commands the frontend (Plan 4) consumes. It contains **no `resolve_readable`/token/ledger logic of its own** (it CONSUMES Plan 2's facade at pinned signatures) and **no on-disk KB read/canonical-path logic** (it CONSUMES Plan 1). It contains **no write path** (Plan 5). See `docs/MCP_KB_CONTRACT.md` §4 (topology), §5 (transport), §6 (tokens), §11 (lifecycle), §12 (T13) and the roadmap at the bottom of Plan 1 (`docs/superpowers/plans/2026-06-25-mcp-kb-foundation.md`).

> **Dependency on Plans 1–2 (HARD):** this plan does **not** start until Plan 1 (PR #213) and Plan 2 are merged. It consumes their exact pinned signatures (see "Consumed interface contract" below) verbatim — do not redefine, re-implement, or fork them.

**Goal:** Stand up the v1 MCP **stdio** transport per `MCP_KB_CONTRACT.md` §4/§5: a thin spawned shim (`stashpeak-mcp`) that speaks MCP on stdin/stdout and a minimal length-prefixed token-authed JSON IPC to the running app; the app-side IPC server that validates the token (Plan 2), runs the **gated** read ops (Plan 2 `kb::access`), and records every read in the ledger + applies the bulk-read brake (Plan 2 `kb::ledger`); the shim's `initialize` handshake from an **app-supplied capability manifest**, the pinned `kb://vault/<canonical>` resource grammar, the `kb_search`/`kb_read_note`/`kb_list` tools, **stdout discipline** + a CI `initialize` smoke, and the watcher's `kb://list_changed` relayed to `notifications/resources/list_changed`. Finally, the Tauri commands Plan 4 needs (enable toggle + lifecycle start/stop, token mint/list/revoke, recent activity, client-config snippet).

**Architecture:** A new `mcp` module (`src-tauri/src/mcp/`) owns the app side, split by responsibility: `wire.rs` (the length-prefixed JSON framing + the request/response enums shared by the app server and the shim), `manifest.rs` (the app-owned capability manifest the shim emits in `initialize`), `server.rs` (the IPC listener over `interprocess` local sockets — named pipe on Windows, unix domain socket on macOS/Linux — that authenticates every request, routes to `kb::access`, and writes the ledger), `lifecycle.rs` (the start/stop service held in Tauri state, driven by the `mcp_kb_access_enabled` setting per Decision #24), `uri.rs` (the pinned `kb://vault/<canonical>` byte-for-byte grammar from §5.3), `config.rs` (the paste-ready client-config snippet generator), and `commands.rs` (the Tauri commands). The shim is a **separate binary**, `src-tauri/src/bin/mcp.rs`, built via a `[[bin]]` target named `stashpeak-mcp`, using `rmcp` for the stdio MCP server and the **same** `wire.rs`/`uri.rs` modules (it links `stashpeak_lib`). The shim holds **no app logic, no keychain, no direct fs access** — every read crosses the IPC hop (the T13 trust boundary, §4).

**Tech Stack:** Rust (edition 2021), Tauri 2 (commands via `run_blocking`; lifecycle held in `tauri::State`), `rmcp` (new dep — the official Rust MCP SDK; stdio server transport on the shim), `interprocess` (new dep — cross-platform local sockets: Windows named pipe + Unix domain socket, both blocking + async-capable), `serde`/`serde_json` (existing, the IPC wire + manifest), `tokio` (existing; the shim async runtime + the IPC accept loop), inline `#[cfg(test)]` tests with `tempfile` (dev-dep, added Plan 1), and a CI shell smoke that pipes `initialize` into the built `stashpeak-mcp`.

## Global Constraints

- **The shim is untrusted-by-construction and holds nothing security-relevant.** No keychain, no DB, no vault path, no `resolve_readable`, no direct `std::fs` of the vault. Every read flows app-ward over the IPC hop; the app is the only holder of the vault root, the token store, the gate, and the ledger (`MCP_KB_CONTRACT.md` §4).
- **The vault root is server-owned, never client-supplied.** The app resolves it from `settings::get_vault_root()` (Plan 1) on every request. Neither the shim nor the MCP client can widen or set it. MCP `roots`, if present, are advisory display-only and ignored by the read path. [§4 — roots]
- **Stdout discipline (the #1 stdio breakage):** the shim writes **nothing** to stdout except framed JSON-RPC. All logging and **all panics route to stderr** (a panic hook + a stderr-only tracing writer are installed in `bin/mcp.rs::main` before anything else). Any dependency that might print to stdout is configured silent. CI asserts this (Task 6.2).
- **Every read crosses the gate AND the ledger.** The IPC server calls **Plan 2's** `kb::access::{list_readable,read_note,search}` (never raw `kb::read`/`kb::search`), then `kb::ledger::record_read(...)` and consults `kb::ledger::check_read_budget(...)`. There is no read code path in this plan that bypasses Plan 2.
- **Token-authed IPC.** Every IPC request carries the `spk_mcp_` token (passed to the shim by the client as an env var / arg, forwarded by the shim, never logged). The app calls **Plan 2's** `kb::tokens::validate(raw)`; an absent/invalid/revoked token is rejected before any vault touch. Scope is re-read per request (§6.3) — the validate call is per-request, never cached at shim startup.
- **All blocking app-side fs/DB work runs via `spawn_blocking`** (the `pub(crate)` `run_blocking(name, work)` helper in `src-tauri/src/lib.rs`); Tauri commands return `Result<T, String>`.
- **Single crate** `stashpeak` (lib name `stashpeak_lib`); the `mcp` module is added under `src-tauri/src/` and declared `mod mcp;` in `lib.rs`. The shim binary is `src-tauri/src/bin/mcp.rs` and links `stashpeak_lib`.
- **Commit messages MUST reference the tracking issue `#N`** created in Task 0.1 (`.githooks/commit-msg` rejects commits without `#N`; `docs:`-prefixed commits are exempt). Substitute the real number for `#<ISSUE>` throughout.
- **CI gate (3-OS matrix):** `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` must all pass. `--all-targets` matters now — it builds the new `[[bin]]`. Run all three before every commit.
- **No write path.** This plan exposes only read resources/tools. Write tools (`kb_append_note`/`kb_create_note`/`kb_write_note`) + the owned containment algorithm are **Plan 5** (`MCP_KB_CONTRACT.md` §8) — out of scope.

---

## Consumed interface contract (DO NOT redefine — Plans 1 & 2 own these)

**From Plan 1 (`src-tauri/src/kb/`, merged in PR #213):**
- `settings::get_vault_root() -> Result<Option<String>, String>` — the server-owned vault root.
- `kb::path::CanonicalPath` (`.as_str()`), `kb::path::to_canonical`, `kb::path::to_os_path`.
- `kb::watch::{ content_hash, EchoFilter, start_watch(app, vault_root, echo) -> Result<RecommendedWatcher, KbError> }` + the Tauri event `"kb://list_changed"` carrying the changed canonical path string.
- `kb::KbError` (`PathRejected` / `NoVaultRoot` / `Io`).

**From Plan 2 (`src-tauri/src/kb/access.rs`, `kb/tokens.rs`, `kb/ledger.rs`; migration `008_mcp.sql`):**
- Gated read facade (call these, **never** raw `kb::read`/`kb::search`):
  - `kb::access::list_readable(vault_root: &Path) -> Result<Vec<String>, KbError>`
  - `kb::access::read_note(vault_root: &Path, canonical: &str) -> Result<String, KbError>` (excluded → `Err`-NotFound shape, never leaks)
  - `kb::access::search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError>` (snippets T10-scrubbed)
  - `kb::access::resolve_readable(vault_root: &Path, canonical: &str) -> bool` (used for the per-URI resource read gate)
- Tokens: `kb::tokens::{ Scope (Read|ReadWrite, serde), TokenInfo{ id, label, scope, created_at }, mint(label, scope) -> Result<String,String>, validate(raw: &str) -> Result<Option<TokenInfo>, String>, revoke(id: &str) -> Result<(),String>, list() -> Result<Vec<TokenInfo>,String> }`.
- Ledger: `kb::ledger::{ LedgerRow{ client_label, tool, target, result_count, at }, record_read(client_label, tool, target, result_count) -> Result<(),String>, recent(limit) -> Result<Vec<LedgerRow>,String>, check_read_budget(client_label) -> Result<Brake,String> }`, `Brake = Allow | Notice | Pause`.
- `SearchHit{ path: String, snippet: String, score: usize }` (defined Plan 1 `kb::search`, re-exported through `kb::access`).

If any signature above differs at implementation time, **stop and reconcile the plans** — do not adapt around a mismatch.

---

## File Structure

| File | Responsibility | New/Modify |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | add `rmcp`, `interprocess`; add the `[[bin]]` `stashpeak-mcp` target | Modify |
| `src-tauri/src/lib.rs` | `mod mcp;`; manage the lifecycle state; register the Tauri commands; relay `kb://list_changed` → IPC | Modify |
| `src-tauri/src/mcp/mod.rs` | module root; re-exports; shared `McpError` | Create |
| `src-tauri/src/mcp/wire.rs` | length-prefixed JSON framing + the `IpcRequest`/`IpcResponse` enums (shared app↔shim) | Create |
| `src-tauri/src/mcp/uri.rs` | the pinned `kb://vault/<canonical>` byte-for-byte grammar (§5.3) | Create |
| `src-tauri/src/mcp/manifest.rs` | the app-owned `CapabilityManifest` the shim emits in `initialize` | Create |
| `src-tauri/src/mcp/server.rs` | the IPC listener: auth → `kb::access` → `kb::ledger`; the per-connection handler | Create |
| `src-tauri/src/mcp/lifecycle.rs` | start/stop service held in Tauri state; driven by `mcp_kb_access_enabled` (Decision #24) | Create |
| `src-tauri/src/mcp/config.rs` | the paste-ready client-config snippet generator | Create |
| `src-tauri/src/mcp/commands.rs` | Tauri commands (enable toggle, token mint/list/revoke, recent activity, config snippet) | Create |
| `src-tauri/src/bin/mcp.rs` | the `stashpeak-mcp` shim: `rmcp` stdio server + IPC client + stdout discipline | Create |
| `.github/workflows/*` (existing Rust CI job) | add the `initialize` stdout-discipline smoke step | Modify |

---

## Phase 0 — Tracking issue

### Task 0.1: Create the tracking issue

- [ ] **Step 1: Create the issue and capture its number**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
gh issue create \
  --title "feat(mcp): transport — local-IPC server + stashpeak-mcp stdio shim" \
  --label enhancement \
  --body "Implements Plan 3 of the MCP read-first series (docs/superpowers/plans/2026-06-26-mcp-plan3-transport-shim.md). Depends on Plan 1 (#213, kb foundation) + Plan 2 (kb::access/tokens/ledger). Builds the app-side local-IPC server + the stashpeak-mcp shim (rmcp stdio) + the Tauri commands Plan 4 consumes. Read-only; no write path (Plan 5)."
```

Record the printed number as `#<ISSUE>` for every later commit.

- [ ] **Step 2: Confirm Plans 1 & 2 are merged**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
git checkout main && git pull
# Sanity: the consumed surfaces must exist before this plan compiles.
ls src-tauri/src/kb/access.rs src-tauri/src/kb/tokens.rs src-tauri/src/kb/ledger.rs src-tauri/src/migrations/008_mcp.sql
```

Expected: all four files exist. If any is missing, **stop** — Plan 2 is not merged; this plan cannot start.

---

## Phase 1 — Dependencies, branch, and the shim bin target

### Task 1.1: Branch + dependencies + `[[bin]]`

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: the `rmcp` + `interprocess` deps and the `stashpeak-mcp` binary target (built by `--all-targets`).

- [ ] **Step 1: Create the working branch**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
git checkout main && git pull
git checkout -b feat/mcp-transport-shim-<ISSUE>
```

- [ ] **Step 2: Add dependencies to `src-tauri/Cargo.toml`**

Under `[dependencies]` (the shim runtime + the IPC transport — both are used by the lib and the bin, so they live in `[dependencies]`, not dev):

```toml
# MCP stdio server (official Rust SDK) — used by the stashpeak-mcp shim binary.
# Pin a concrete version at implementation time (`cargo add rmcp --features server,transport-io`);
# the shim needs the server role + the stdio (stdin/stdout) transport.
rmcp = { version = "0.1", features = ["server", "transport-io"] }
# Cross-platform local IPC: Windows named pipe + Unix domain socket, one API.
interprocess = "2"
```

> [!NOTE]
> `rmcp`'s feature names evolve; resolve the exact crate version + the server/stdio feature flags with `cargo add` + `cargo doc -p rmcp` at implementation time. The plan depends only on: (a) a stdio server transport, (b) a `ServerHandler`-style trait to implement `initialize`/`resources`/`tools`, and (c) a way to push `notifications/resources/list_changed`. If `rmcp`'s server surface cannot drive a fully app-supplied manifest, the shim falls back to hand-rolled JSON-RPC over stdin/stdout using `wire.rs`'s framing (the IPC half is hand-rolled regardless); record which path was taken in the PR.

- [ ] **Step 3: Declare the shim binary target**

Append to `src-tauri/Cargo.toml`:

```toml
[[bin]]
name = "stashpeak-mcp"
path = "src/bin/mcp.rs"
```

> [!NOTE]
> The existing default app binary keeps its own `[[bin]]`/`src/main.rs` (or the Tauri default `main.rs`) untouched. Adding a second `[[bin]]` does **not** disturb the `cdylib`/`staticlib`/`rlib` lib targets the app already builds. The shim links the existing `stashpeak_lib` crate, so it reuses `mcp::wire`/`mcp::uri` without code duplication.

- [ ] **Step 4: Verify it builds**

Run: `cd src-tauri && cargo build --all-targets`
Expected: fails — `src/bin/mcp.rs` does not exist yet. Create a one-line stub so the workspace resolves while deps download:

```rust
// src-tauri/src/bin/mcp.rs
fn main() {}
```

Re-run `cargo build --all-targets`. Expected: compiles (new crates downloaded), the empty shim binary builds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/bin/mcp.rs
git commit -m "build(mcp): add rmcp + interprocess deps and stashpeak-mcp bin target (refs #<ISSUE>)"
```

---

## Phase 2 — The wire protocol + the URI grammar (pure, shared app↔shim)

These two files are **pure** (no I/O), fully unit-testable, and are linked by **both** the app server and the shim binary. They are the contract of the IPC hop and of the resource scheme.

### Task 2.1: Module skeleton + `McpError`

**Files:**
- Create: `src-tauri/src/mcp/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod mcp;`)

**Interfaces:**
- Produces: `mcp::McpError` (plain enum, `Display`); module declarations for `wire`, `uri`, `manifest`, `server`, `lifecycle`, `config`, `commands`.

- [ ] **Step 1: Create `src-tauri/src/mcp/mod.rs`**

```rust
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
```

- [ ] **Step 2: Declare the module in `lib.rs`**

Add `mod mcp;` alongside the other top-level `mod` declarations near the top of `src-tauri/src/lib.rs` (after `mod logging;`, keeping them roughly alphabetical):

```rust
mod logging;
mod mcp;
mod notifications;
```

- [ ] **Step 3: Verify it builds**

Run: `cd src-tauri && cargo build`
Expected: fails — the submodules don't exist. Create empty stubs (`// placeholder`) for `wire.rs`, `uri.rs`, `manifest.rs`, `server.rs`, `lifecycle.rs`, `config.rs`, `commands.rs`, then re-run. Expected: compiles with empty modules.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/ src-tauri/src/lib.rs
git commit -m "feat(mcp): module skeleton + McpError (refs #<ISSUE>)"
```

### Task 2.2: `uri.rs` — the pinned `kb://vault/<canonical>` grammar (§5.3)

**Files:**
- Create/fill: `src-tauri/src/mcp/uri.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `pub fn canonical_to_uri(canonical: &str) -> String` — `kb://vault/` + each `/`-separated segment RFC-3986 percent-encoded over its UTF-8 bytes (unreserved = `A–Z a–z 0–9 - . _ ~` kept; everything else `%XX` uppercase), separators never encoded; no query/fragment/trailing slash (root is `kb://vault/`).
  - `pub fn uri_to_canonical(uri: &str) -> Result<String, McpError>` — the exact 1:1 reverse; rejects a wrong scheme/authority, a query, a fragment, and percent-decodes per RFC 3986.
- The canonical string itself is assumed already NFC + forward-slash (Plan 1 `to_canonical` guarantees it); `uri.rs` does not re-normalize, it only encodes/decodes.

- [ ] **Step 1: Write the failing tests (the pinned grammar)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_space_as_uppercase_percent20() {
        // §5.3 example, byte-for-byte.
        assert_eq!(
            canonical_to_uri("Projects/Q3 plan.md"),
            "kb://vault/Projects/Q3%20plan.md"
        );
    }

    #[test]
    fn keeps_unreserved_and_separators_raw() {
        assert_eq!(
            canonical_to_uri("a-b_c.d~e/F.md"),
            "kb://vault/a-b_c.d~e/F.md"
        );
    }

    #[test]
    fn root_is_kb_vault_slash() {
        assert_eq!(canonical_to_uri(""), "kb://vault/");
    }

    #[test]
    fn encodes_non_ascii_utf8_bytes_uppercase() {
        // "é" (U+00E9) NFC = UTF-8 0xC3 0xA9 -> %C3%A9
        assert_eq!(canonical_to_uri("caf\u{00e9}.md"), "kb://vault/caf%C3%A9.md");
    }

    #[test]
    fn round_trips() {
        for c in ["Projects/Q3 plan.md", "caf\u{00e9}.md", "a/b/c.md", "100%done.md"] {
            assert_eq!(uri_to_canonical(&canonical_to_uri(c)).unwrap(), c);
        }
    }

    #[test]
    fn decode_rejects_wrong_scheme_authority_query_fragment() {
        assert!(uri_to_canonical("file:///etc/passwd").is_err());
        assert!(uri_to_canonical("kb://other/x.md").is_err());
        assert!(uri_to_canonical("kb://vault/x.md?q=1").is_err());
        assert!(uri_to_canonical("kb://vault/x.md#frag").is_err());
    }

    #[test]
    fn decode_rejects_traversal_after_decode() {
        // A percent-encoded ".." must not smuggle traversal back in.
        assert!(uri_to_canonical("kb://vault/%2E%2E/secret.md").is_err());
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test mcp::uri::tests` → FAIL (`canonical_to_uri` undefined).

- [ ] **Step 3: Implement**

```rust
use crate::mcp::McpError;

const SCHEME_AUTHORITY: &str = "kb://vault/";

/// True for RFC 3986 `unreserved`: A-Z a-z 0-9 - . _ ~
fn is_unreserved(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')
}

/// Percent-encode one path segment over its UTF-8 bytes, uppercase hex.
fn encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for &b in seg.as_bytes() {
        if is_unreserved(b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// canonical (NFC, `/`-separated, no leading slash) -> `kb://vault/<encoded>`.
pub fn canonical_to_uri(canonical: &str) -> String {
    if canonical.is_empty() {
        return SCHEME_AUTHORITY.to_string();
    }
    let encoded = canonical
        .split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/");
    format!("{SCHEME_AUTHORITY}{encoded}")
}

/// Percent-decode one segment's UTF-8 bytes back to a String.
fn decode_segment(seg: &str) -> Result<String, McpError> {
    let bytes = seg.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return Err(McpError::Protocol(format!("truncated percent escape in {seg}")));
                }
                let hi = (bytes[i + 1] as char)
                    .to_digit(16)
                    .ok_or_else(|| McpError::Protocol(format!("bad percent escape in {seg}")))?;
                let lo = (bytes[i + 2] as char)
                    .to_digit(16)
                    .ok_or_else(|| McpError::Protocol(format!("bad percent escape in {seg}")))?;
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| McpError::Protocol(format!("invalid utf8 in {seg}")))
}

/// `kb://vault/<encoded>` -> canonical string. Rejects wrong scheme/authority,
/// any query/fragment, and (after decode) any traversal/absolute form.
pub fn uri_to_canonical(uri: &str) -> Result<String, McpError> {
    if uri.contains('?') || uri.contains('#') {
        return Err(McpError::Protocol("query/fragment not allowed".into()));
    }
    let rest = uri
        .strip_prefix(SCHEME_AUTHORITY)
        .ok_or_else(|| McpError::Protocol(format!("not a kb://vault/ uri: {uri}")))?;
    if rest.is_empty() {
        return Ok(String::new()); // the root
    }
    let mut segs = Vec::new();
    for seg in rest.split('/') {
        let decoded = decode_segment(seg)?;
        // Reject smuggled traversal/empty/separators after decode.
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains('/')
            || decoded.contains('\\')
            || decoded.contains('\u{0000}')
        {
            return Err(McpError::Protocol(format!("rejected segment: {decoded}")));
        }
        segs.push(decoded);
    }
    Ok(segs.join("/"))
}
```

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test mcp::uri::tests` → PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/uri.rs
git commit -m "feat(mcp): pinned kb://vault/ uri grammar with rfc3986 encode/decode (refs #<ISSUE>)"
```

### Task 2.3: `wire.rs` — length-prefixed JSON framing + request/response enums

**Files:**
- Create/fill: `src-tauri/src/mcp/wire.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `pub struct WireToken(pub String);` (the `spk_mcp_` token field on every request; a newtype so it is never accidentally logged via `Debug` — `Debug` is hand-written to redact).
  - `pub enum IpcRequest { Manifest { token: String }, List { token: String }, ReadNote { token: String, canonical: String }, Search { token: String, query: String, limit: usize } }` (serde-tagged).
  - `pub enum IpcResponse { Manifest(crate::mcp::manifest::CapabilityManifest), List { paths: Vec<String> }, Note { content: String }, Search { hits: Vec<crate::kb::search::SearchHit> }, Error { kind: String, message: String } }` (serde-tagged).
  - `pub fn write_frame<W: Write>(w: &mut W, value: &impl Serialize) -> std::io::Result<()>` — a 4-byte big-endian length prefix + the JSON body.
  - `pub fn read_frame<R: Read, T: DeserializeOwned>(r: &mut R) -> Result<T, McpError>` — reads the length prefix (bounded by `MAX_FRAME`), then the exact body, then deserializes.
- The framing is transport-agnostic: it works over the `interprocess` local socket (app server) and is the exact format the shim writes/reads.

> [!NOTE]
> The token is carried **inside** each request rather than once per connection so the app can re-validate scope per call (§6.3) without trusting connection-level state, and so a single shim process that the client keeps alive cannot "pin" a stale scope. `IpcRequest`'s `Debug` is hand-implemented to print `token: "[REDACTED]"` — the raw token also goes through `logging::remember_secret` on the app side (Task 4.2), but defense-in-depth keeps it out of any accidental `{:?}`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_round_trips() {
        let req = IpcRequest::Search {
            token: "spk_mcp_test".into(),
            query: "alpha".into(),
            limit: 10,
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &req).unwrap();
        // 4-byte prefix present.
        assert!(buf.len() > 4);
        let mut cur = Cursor::new(buf);
        let back: IpcRequest = read_frame(&mut cur).unwrap();
        match back {
            IpcRequest::Search { token, query, limit } => {
                assert_eq!(token, "spk_mcp_test");
                assert_eq!(query, "alpha");
                assert_eq!(limit, 10);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn oversized_frame_is_rejected() {
        // A length prefix above MAX_FRAME must error, not allocate.
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME + 1).to_be_bytes());
        let mut cur = Cursor::new(buf);
        let res: Result<IpcRequest, _> = read_frame(&mut cur);
        assert!(res.is_err());
    }

    #[test]
    fn request_debug_redacts_token() {
        let req = IpcRequest::List { token: "spk_mcp_secret".into() };
        let dbg = format!("{req:?}");
        assert!(!dbg.contains("spk_mcp_secret"));
        assert!(dbg.contains("REDACTED"));
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test mcp::wire::tests` → FAIL.

- [ ] **Step 3: Implement**

```rust
use crate::mcp::McpError;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

/// Hard upper bound on a single IPC frame (16 MiB). A note larger than this is
/// not a sane MCP read; bounding the prefix prevents a hostile length from
/// triggering an unbounded allocation.
pub const MAX_FRAME: u32 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum IpcRequest {
    /// Fetch the app-supplied capability manifest (drives the shim handshake).
    Manifest { token: String },
    List { token: String },
    ReadNote { token: String, canonical: String },
    Search { token: String, query: String, limit: usize },
}

impl IpcRequest {
    pub fn token(&self) -> &str {
        match self {
            IpcRequest::Manifest { token }
            | IpcRequest::List { token }
            | IpcRequest::ReadNote { token, .. }
            | IpcRequest::Search { token, .. } => token,
        }
    }
}

// Hand-written Debug so a stray {:?} can never print the token.
impl std::fmt::Debug for IpcRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            IpcRequest::Manifest { .. } => "Manifest",
            IpcRequest::List { .. } => "List",
            IpcRequest::ReadNote { .. } => "ReadNote",
            IpcRequest::Search { .. } => "Search",
        };
        write!(f, "IpcRequest::{name} {{ token: \"[REDACTED]\", .. }}")
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "kind")]
pub enum IpcResponse {
    Manifest(crate::mcp::manifest::CapabilityManifest),
    List { paths: Vec<String> },
    Note { content: String },
    Search { hits: Vec<crate::kb::search::SearchHit> },
    Error { kind: String, message: String },
}

/// 4-byte big-endian length prefix, then the JSON body.
pub fn write_frame<W: Write>(w: &mut W, value: &impl Serialize) -> std::io::Result<()> {
    let body = serde_json::to_vec(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let len = body.len() as u32;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

/// Read one length-prefixed JSON frame; bound the length by MAX_FRAME.
pub fn read_frame<R: Read, T: DeserializeOwned>(r: &mut R) -> Result<T, McpError> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)
        .map_err(|e| McpError::Io(e.to_string()))?;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(McpError::Protocol(format!("frame too large: {len}")));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)
        .map_err(|e| McpError::Io(e.to_string()))?;
    serde_json::from_slice(&body).map_err(|e| McpError::Protocol(e.to_string()))
}
```

> The `WireToken` newtype mentioned in the interface is not needed once `IpcRequest` carries the token inline with a redacting `Debug`; dropped to keep the wire minimal (YAGNI). The token is a plain `String` field, never logged.

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test mcp::wire::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/wire.rs
git commit -m "feat(mcp): length-prefixed JSON wire protocol with token-redacting Debug (refs #<ISSUE>)"
```

### Task 2.4: `manifest.rs` — the app-owned capability manifest

**Files:**
- Create/fill: `src-tauri/src/mcp/manifest.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `pub struct CapabilityManifest { pub server_name: String, pub server_version: String, pub protocol_versions: Vec<String>, pub resources_list_changed: bool, pub tools_list_changed: bool, pub tools: Vec<ToolDecl> }` (`Serialize`/`Deserialize`/`Clone`).
  - `pub struct ToolDecl { pub name: String, pub description: String, pub read_only: bool }` (the read tools, with the `readOnlyHint: true` annotation hint the shim maps into the MCP tool schema).
  - `pub fn current() -> CapabilityManifest` — the v1 manifest: `resources.listChanged = true`, `tools.listChanged = false`, the three read tools, no write tools, no `subscribe` (advertised only when implemented, §5.1).
- The app owns *what* is supported; the shim owns *emitting* it (§5.1). The shim must never invent a capability — it serializes exactly this.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_manifest_is_read_only_and_advertises_only_implemented() {
        let m = current();
        assert!(m.resources_list_changed); // the watcher emits list_changed
        assert!(!m.tools_list_changed); // the tool set is static in v1
        let names: Vec<&str> = m.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["kb_search", "kb_read_note", "kb_list"]);
        // No write tools, no subscribe capability in v1.
        assert!(m.tools.iter().all(|t| t.read_only));
        assert!(!m.protocol_versions.is_empty());
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test mcp::manifest::tests` → FAIL.

- [ ] **Step 3: Implement**

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolDecl {
    pub name: String,
    pub description: String,
    /// Maps to the MCP tool annotation `readOnlyHint`. All v1 tools are read-only.
    pub read_only: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CapabilityManifest {
    pub server_name: String,
    pub server_version: String,
    /// Pinned set of supported MCP protocol versions; the shim negotiates the
    /// highest common one and degrades per the MCP rule for unknown versions.
    pub protocol_versions: Vec<String>,
    /// resources: { listChanged } — the folder-watcher emits it (§5.1).
    pub resources_list_changed: bool,
    /// tools: { listChanged } — false in v1 (the tool set is static).
    pub tools_list_changed: bool,
    /// The read tools, exactly as implemented. No write tools in v1 (Plan 5).
    pub tools: Vec<ToolDecl>,
}

/// The v1 read-only manifest. The app owns this; the shim only emits it (§5.1).
pub fn current() -> CapabilityManifest {
    CapabilityManifest {
        server_name: "stashpeak-kb".to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        // Pin the MCP protocol revisions this build implements. Update when the
        // shim's rmcp version is bumped; the shim negotiates the highest common.
        protocol_versions: vec!["2025-06-18".to_string(), "2025-03-26".to_string()],
        resources_list_changed: true,
        tools_list_changed: false,
        tools: vec![
            ToolDecl {
                name: "kb_search".to_string(),
                description: "Full-text search across the knowledge base. Returns ranked path + snippet hits.".to_string(),
                read_only: true,
            },
            ToolDecl {
                name: "kb_read_note".to_string(),
                description: "Read one note's markdown by its vault-relative canonical path.".to_string(),
                read_only: true,
            },
            ToolDecl {
                name: "kb_list".to_string(),
                description: "List the canonical paths of every readable note in the vault.".to_string(),
                read_only: true,
            },
        ],
    }
}
```

> [!NOTE]
> `protocol_versions` is a pinned list, not a single value, so unknown future client versions degrade per the MCP negotiation rule (§5.1) instead of crashing. Keep it in sync with the `rmcp` revision the shim links; the CI smoke (Task 6.2) catches a manifest the shim can't actually serve.

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test mcp::manifest::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/manifest.rs
git commit -m "feat(mcp): app-owned v1 capability manifest (read-only, listChanged) (refs #<ISSUE>)"
```

---

## Phase 3 — The IPC server (auth → gated read → ledger)

This is where the security spine lives: every request is authenticated (Plan 2 `tokens::validate`), routed only to the **gated** facade (Plan 2 `kb::access`), and recorded + brake-checked (Plan 2 `kb::ledger`). The vault root is resolved server-side from settings.

### Task 3.1: The request handler (pure routing over injected deps)

**Files:**
- Create/fill: `src-tauri/src/mcp/server.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `kb::tokens::validate`, `kb::access::{list_readable,read_note,search}`, `kb::ledger::{record_read,check_read_budget,Brake}`, `settings::get_vault_root`.
- Produces: `pub fn handle_request(req: &IpcRequest) -> IpcResponse` — the single, synchronous request→response function the accept loop calls per frame. It (1) validates the token, (2) resolves the server-owned vault root, (3) checks the read budget, (4) runs the gated op, (5) records the read in the ledger. A `Manifest` request only requires a valid token (no vault read, no ledger row).

- [ ] **Step 1: Write the failing test**

The handler depends on real DB/keychain state (tokens, ledger) and the filesystem (vault), so the unit test drives it through a configured temp vault + a freshly minted token. Reuse Plan 1/2's temp-DB test harness (the same in-temp-dir DB + `settings` the other tests use).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::kb::tokens::{self, Scope};
    use crate::settings;
    use std::fs;
    use tempfile::tempdir;

    // (Use the shared temp-DB harness Plan 1/2 tests use so tokens/ledger/settings
    // hit an isolated database. Pseudocode marker only — match the real helper.)
    fn with_temp_app<F: FnOnce()>(f: F) { /* set up temp data_dir + DB, then */ f() }

    #[test]
    fn rejects_request_without_valid_token() {
        with_temp_app(|| {
            let resp = handle_request(&IpcRequest::List { token: "spk_mcp_nope".into() });
            assert!(matches!(resp, IpcResponse::Error { ref kind, .. } if kind == "Unauthorized"));
        });
    }

    #[test]
    fn lists_through_the_gate_and_records_the_read() {
        with_temp_app(|| {
            let dir = tempdir().unwrap();
            fs::write(dir.path().join("a.md"), "alpha").unwrap();
            settings::set_vault_root(dir.path().to_string_lossy().into()).unwrap();

            let raw = tokens::mint("Claude Desktop".into(), Scope::Read).unwrap();
            let resp = handle_request(&IpcRequest::List { token: raw.clone() });
            match resp {
                IpcResponse::List { paths } => assert_eq!(paths, vec!["a.md".to_string()]),
                other => panic!("expected List, got {other:?}"),
            }
            // The read is in the ledger under the token's label.
            let recent = crate::kb::ledger::recent(10).unwrap();
            assert!(recent.iter().any(|r| r.tool == "kb_list" && r.client_label == "Claude Desktop"));
        });
    }

    #[test]
    fn manifest_needs_a_token_but_no_vault() {
        with_temp_app(|| {
            // No vault root set; a Manifest request still succeeds for a valid token.
            let raw = tokens::mint("Cursor".into(), Scope::Read).unwrap();
            let resp = handle_request(&IpcRequest::Manifest { token: raw });
            assert!(matches!(resp, IpcResponse::Manifest(_)));
        });
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test mcp::server::tests` → FAIL.

- [ ] **Step 3: Implement**

```rust
use crate::kb::ledger::{self, Brake};
use crate::kb::{access, tokens};
use crate::mcp::manifest;
use crate::mcp::wire::{IpcRequest, IpcResponse};
use crate::settings;
use std::path::PathBuf;

fn err(kind: &str, message: impl Into<String>) -> IpcResponse {
    IpcResponse::Error {
        kind: kind.to_string(),
        message: message.into(),
    }
}

/// Resolve the server-owned vault root. Never client-supplied (§4).
fn vault_root() -> Result<PathBuf, IpcResponse> {
    match settings::get_vault_root() {
        Ok(Some(p)) => Ok(PathBuf::from(p)),
        Ok(None) => Err(err("NoVaultRoot", "vault root is not configured")),
        Err(e) => Err(err("Io", e)),
    }
}

/// The single request handler. Validates the token (per call, §6.3), runs the
/// gated read op, and records it in the ledger. Synchronous; the accept loop
/// runs each connection on its own blocking thread.
pub fn handle_request(req: &IpcRequest) -> IpcResponse {
    // (1) Authenticate every request. Plan 2 hashes + looks up + remember_secrets.
    let info = match tokens::validate(req.token()) {
        Ok(Some(info)) => info,
        Ok(None) => return err("Unauthorized", "no valid token"),
        Err(e) => return err("Io", e),
    };
    let label = info.label;

    // A Manifest request needs only a valid token (no vault read, no ledger row).
    if let IpcRequest::Manifest { .. } = req {
        return IpcResponse::Manifest(manifest::current());
    }

    // (2) Server-owned vault root.
    let root = match vault_root() {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    // (3) Bulk-read brake (§7.2): a Pause stops the read until re-confirmed.
    match ledger::check_read_budget(&label) {
        Ok(Brake::Pause) => return err("RateLimited", "read budget paused; re-confirm in Stashpeak"),
        Ok(Brake::Notice) | Ok(Brake::Allow) => {}
        Err(e) => return err("Io", e),
    }

    // (4) Run the GATED op (never raw kb::read/kb::search) + (5) record the read.
    match req {
        IpcRequest::List { .. } => match access::list_readable(&root) {
            Ok(paths) => {
                let _ = ledger::record_read(&label, "kb_list", "", paths.len());
                IpcResponse::List { paths }
            }
            Err(e) => err("Kb", e.to_string()),
        },
        IpcRequest::ReadNote { canonical, .. } => match access::read_note(&root, canonical) {
            Ok(content) => {
                let _ = ledger::record_read(&label, "kb_read_note", canonical, 1);
                IpcResponse::Note { content }
            }
            Err(e) => {
                // A gated-out / missing note is recorded as a 0-result read for
                // visibility, then surfaced as a recoverable error.
                let _ = ledger::record_read(&label, "kb_read_note", canonical, 0);
                err("Kb", e.to_string())
            }
        },
        IpcRequest::Search { query, limit, .. } => match access::search(&root, query, *limit) {
            Ok(hits) => {
                let _ = ledger::record_read(&label, "kb_search", query, hits.len());
                IpcResponse::Search { hits }
            }
            Err(e) => err("Kb", e.to_string()),
        },
        IpcRequest::Manifest { .. } => unreachable!("handled above"),
    }
}
```

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test mcp::server::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/server.rs
git commit -m "feat(mcp): request handler — auth + gated read + ledger record/brake (refs #<ISSUE>)"
```

### Task 3.2: The IPC listener (interprocess local socket accept loop)

**Files:**
- Modify: `src-tauri/src/mcp/server.rs`

**Interfaces:**
- Consumes: `interprocess::local_socket`, `wire::{read_frame,write_frame}`, `handle_request`.
- Produces:
  - `pub fn ipc_socket_name() -> String` — the platform local-socket name, namespaced per build (`stashpeak-mcp` in release, `stashpeak-mcp-dev` in debug) so a dev and a release app never collide. On Windows this is a named-pipe name; on Unix a filesystem-namespaced socket path under the data dir.
  - `pub fn serve(stop: Arc<AtomicBool>) -> Result<(), McpError>` — binds the listener and accepts connections until `stop` is set; each accepted stream loops `read_frame::<IpcRequest>` → `handle_request` → `write_frame(IpcResponse)`; a per-connection error closes that connection only, never the listener.

- [ ] **Step 1: Implement the listener**

```rust
use crate::mcp::wire::{read_frame, write_frame, IpcRequest, IpcResponse};
use crate::mcp::McpError;
use interprocess::local_socket::{
    traits::{Listener, Stream},
    GenericNamespaced, ListenerOptions, ToNsName,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Build-namespaced local-socket name so a dev build and a release build never
/// share the IPC endpoint. The shim derives the same name the same way.
pub fn ipc_socket_name() -> String {
    if cfg!(debug_assertions) {
        "stashpeak-mcp-dev.sock".to_string()
    } else {
        "stashpeak-mcp.sock".to_string()
    }
}

/// Bind the local socket and serve requests until `stop` flips true.
/// One blocking thread per connection (KB reads are short, single-user volume).
///
/// Every per-connection worker shares the same `stop` flag and its `JoinHandle`
/// is tracked, so when `stop` flips true we both (a) make every in-flight worker
/// notice and exit between frames and (b) join them before returning — no client
/// connection survives a disable (the toggle truly stops the server).
pub fn serve(stop: Arc<AtomicBool>) -> Result<(), McpError> {
    let name = ipc_socket_name()
        .to_ns_name::<GenericNamespaced>()
        .map_err(|e| McpError::Io(e.to_string()))?;
    let listener = ListenerOptions::new()
        .name(name)
        .create_sync()
        .map_err(|e| McpError::Io(e.to_string()))?;
    // Non-blocking accept so the stop flag is honored promptly.
    listener
        .set_nonblocking(interprocess::local_socket::ListenerNonblockingMode::Accept)
        .map_err(|e| McpError::Io(e.to_string()))?;

    // Track every live per-connection worker so stop() can join them all.
    let mut workers: Vec<std::thread::JoinHandle<()>> = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok(stream) => {
                // Each worker shares the stop flag and checks it between frames,
                // so a disable interrupts even an idle long-lived connection.
                let worker_stop = stop.clone();
                workers.push(std::thread::spawn(move || {
                    handle_connection(stream, worker_stop);
                }));
                // Reap any workers that finished on their own (closed connections)
                // so the tracking Vec does not grow unbounded over the session.
                workers.retain(|w| !w.is_finished());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => {
                // Transient accept error: keep serving.
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    // Stopping: every worker sees `stop == true` between frames and returns;
    // join them all so no connection keeps serving reads after the toggle is off.
    for w in workers {
        let _ = w.join();
    }
    Ok(())
}

/// One connection: frame in -> handle -> frame out, until EOF, error, or stop.
/// The shared `stop` flag is checked before every read so an idle long-lived
/// connection (e.g. a shim that pins the socket) is torn down promptly on stop.
fn handle_connection<S: std::io::Read + std::io::Write>(mut stream: S, stop: Arc<AtomicBool>) {
    // A short read timeout would let a blocking read also notice `stop`; on the
    // `interprocess` blocking stream this is best-effort. The between-frame check
    // below is the guaranteed teardown point; pending shim reads end at EOF when
    // the app process tears down its end on shutdown.
    loop {
        if stop.load(Ordering::Relaxed) {
            return; // disabled while idle/between frames: drop this connection.
        }
        let req: IpcRequest = match read_frame(&mut stream) {
            Ok(r) => r,
            Err(_) => return, // EOF or bad frame: close this connection only.
        };
        if stop.load(Ordering::Relaxed) {
            return; // disabled mid-exchange: do not serve another read.
        }
        let resp = handle_request(&req);
        if write_frame(&mut stream, &resp).is_err() {
            return;
        }
        // A Manifest exchange is one-shot in practice but we keep the loop so a
        // shim may reuse the connection for several reads.
        if matches!(resp, IpcResponse::Error { .. }) && matches!(req, IpcRequest::Manifest { .. }) {
            return;
        }
    }
}
```

> [!NOTE]
> `interprocess` 2.x's exact type/trait names (`ListenerOptions`, `to_ns_name`, the nonblocking mode enum, the stream traits) may shift between minor versions — resolve them against `cargo doc -p interprocess` at implementation time. The contract is fixed: a build-namespaced local socket, a stop-flag-driven accept loop, one tracked+joinable thread per connection (workers share `stop` and check it between frames so a disable tears down even an idle long-lived connection), framed request/response. On Unix, prefer the namespaced form (or a socket path under `db::data_dir()`) and ensure the socket file is removed on a clean stop; on Windows the named pipe needs no cleanup.

- [ ] **Step 2: Build + a loopback integration test**

Add an inline test that binds the listener on a background thread, connects as a client, mints a token, and exchanges one `List` frame — proving the framing + accept loop end-to-end without the shim:

```rust
#[cfg(test)]
mod ipc_tests {
    use super::*;
    use crate::kb::tokens::{self, Scope};
    use crate::settings;
    use interprocess::local_socket::{traits::Stream as _, GenericNamespaced, Stream, ToNsName};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn loopback_list_round_trip() {
        // (Same temp-app harness as Task 3.1.)
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "alpha").unwrap();
        settings::set_vault_root(dir.path().to_string_lossy().into()).unwrap();
        let raw = tokens::mint("Test".into(), Scope::Read).unwrap();

        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let server = std::thread::spawn(move || {
            let _ = serve(stop2);
        });
        // Give the listener a moment to bind, then connect + exchange one frame.
        std::thread::sleep(std::time::Duration::from_millis(200));
        let name = ipc_socket_name().to_ns_name::<GenericNamespaced>().unwrap();
        let mut conn = Stream::connect(name).unwrap();
        write_frame(&mut conn, &IpcRequest::List { token: raw }).unwrap();
        let resp: IpcResponse = read_frame(&mut conn).unwrap();
        assert!(matches!(resp, IpcResponse::List { paths } if paths == vec!["a.md".to_string()]));

        stop.store(true, Ordering::Relaxed);
        let _ = server.join();
    }
}
```

> [!NOTE]
> A local-socket bind is environment-sensitive in CI sandboxes; if the loopback test proves flaky on a CI runner, gate it behind `#[cfg_attr(not(feature = "ipc-tests"), ignore)]` and run it in the dedicated Win/macOS CI job (the #517 pattern) rather than weakening it. The pure `handle_request` test (Task 3.1) carries the always-on coverage.

- [ ] **Step 3: Run** — `cd src-tauri && cargo test mcp::server` → PASS (handler + loopback).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/server.rs
git commit -m "feat(mcp): interprocess IPC listener with stop-flag accept loop (refs #<ISSUE>)"
```

---

## Phase 4 — Lifecycle (start/stop driven by the enable toggle)

### Task 4.1: The lifecycle service in Tauri state

**Files:**
- Create/fill: `src-tauri/src/mcp/lifecycle.rs`
- Modify: `src-tauri/src/lib.rs` (manage the state; wire enable→start/stop)
- Modify: `src-tauri/src/settings.rs` (the `mcp_kb_access_enabled` key get/set)
- Test: inline `#[cfg(test)]` in `lifecycle.rs` + `settings.rs`

**Interfaces:**
- Produces:
  - `settings::{ get_mcp_enabled() -> Result<bool,String>, set_mcp_enabled(enabled: bool) -> Result<(),String> }` (key `"mcp_kb_access_enabled"`, default `false`).
  - `pub struct McpService { running: Mutex<Option<McpHandle>> }` (held in Tauri state via `app.manage(McpService::default())`), with `pub fn start(&self, app: &AppHandle) -> Result<(), McpError>` (idempotent: spawn the `serve` thread + boot the KB watcher if not already running) and `pub fn stop(&self)` (flip the stop flag, join the `serve` thread + every worker, drop the watcher). `McpHandle` holds the `Arc<AtomicBool>` stop flag, the `serve` `JoinHandle`, and the held `RecommendedWatcher`. (The `AppHandle` parameter + the watcher field are added in Task 4.2 Step 3, which folds the watcher into this same lifecycle — implement them together.)
- Per Decision #24, the service is a resource-holding contribution: it starts/stops with the toggle and **binds no network port** (local IPC only).

- [ ] **Step 1: Write the failing test (settings round-trip + idempotent start/stop)**

```rust
// in settings.rs tests (reuse the temp-DB harness):
#[test]
fn mcp_enabled_defaults_false_and_round_trips() {
    assert_eq!(get_mcp_enabled().unwrap(), false);
    set_mcp_enabled(true).unwrap();
    assert_eq!(get_mcp_enabled().unwrap(), true);
}

// in lifecycle.rs tests:
#[test]
fn start_is_idempotent_and_stop_is_safe() {
    // `start` takes an AppHandle (it also boots the watcher — Task 4.2 Step 3);
    // a Tauri mock app provides one without a real window.
    let app = tauri::test::mock_app();
    let svc = McpService::default();
    svc.start(&app.handle()).unwrap();
    svc.start(&app.handle()).unwrap(); // second start is a no-op, not a double-bind
    svc.stop();
    svc.stop(); // stopping a stopped service is safe
}
```

> [!NOTE]
> The `start`/`stop` bodies shown in Step 4 below are the Task-4.1 baseline (listener only); Task 4.2 Step 3 extends them to take the `AppHandle` and fold the watcher into the same lifecycle. Write Step 4 with the extended signature directly if you implement Task 4.2 in the same pass — the test above already uses it.

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test mcp::lifecycle::tests settings::tests::mcp_enabled` → FAIL.

- [ ] **Step 3: Implement the settings keys**

In `settings.rs`, following the existing key-value pattern (e.g. `get_vault_root`/`set_vault_root` from Plan 1):

```rust
const KEY_MCP_ENABLED: &str = "mcp_kb_access_enabled";

pub fn get_mcp_enabled() -> Result<bool, String> {
    let conn = crate::db::connect().map_err(|e| e.to_string())?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [KEY_MCP_ENABLED],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(matches!(raw.as_deref(), Some("true")))
}

pub fn set_mcp_enabled(enabled: bool) -> Result<(), String> {
    let conn = crate::db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![KEY_MCP_ENABLED, if enabled { "true" } else { "false" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 4: Implement the lifecycle service**

```rust
use crate::mcp::server;
use crate::mcp::McpError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

struct McpHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct McpService {
    running: Mutex<Option<McpHandle>>,
}

impl McpService {
    /// Start the IPC listener thread if not already running. Idempotent.
    pub fn start(&self) -> Result<(), McpError> {
        let mut guard = self.running.lock().expect("mcp service lock poisoned");
        if guard.is_some() {
            return Ok(()); // already running
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let join = std::thread::spawn(move || {
            if let Err(e) = server::serve(stop_thread) {
                tracing::error!(error = %e, "mcp ipc server exited with error");
            }
        });
        *guard = Some(McpHandle {
            stop,
            join: Some(join),
        });
        tracing::info!("mcp ipc server started");
        Ok(())
    }

    /// Stop the listener and join its thread. Safe to call when stopped.
    ///
    /// Setting the shared `stop` flag both ends the accept loop AND signals every
    /// live per-connection worker (they check the same flag between frames);
    /// `serve` joins all of those workers before it returns, so joining the
    /// `serve` thread here guarantees no connection is still serving reads once
    /// `stop()` returns — the toggle truly stops the server.
    pub fn stop(&self) {
        let mut guard = self.running.lock().expect("mcp service lock poisoned");
        if let Some(mut handle) = guard.take() {
            handle.stop.store(true, Ordering::Relaxed);
            if let Some(join) = handle.join.take() {
                let _ = join.join(); // returns only after every worker is joined
            }
            tracing::info!("mcp ipc server stopped");
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
            .lock()
            .expect("mcp service lock poisoned")
            .is_some()
    }
}
```

- [ ] **Step 5: Manage the state + start-on-boot-if-enabled in `lib.rs`**

In the `tauri::Builder` `.setup(...)` closure in `src-tauri/src/lib.rs`, after the existing setup, manage the service and start it if the toggle is already on:

```rust
use crate::mcp::lifecycle::McpService;
// inside setup, after notifications::check_and_notify(...):
app.manage(McpService::default());
if settings::get_mcp_enabled().unwrap_or(false) {
    if let Some(svc) = app.try_state::<McpService>() {
        // `start` also boots the KB folder-watcher (Task 4.2 Step 3), so the
        // watcher only runs while MCP is enabled — this plan owns its lifecycle.
        if let Err(e) = svc.start(&app.handle()) {
            tracing::error!(error = %e, "failed to start mcp service at boot");
        }
    }
}
```

(Adjust the `use tauri::Manager;` import if not already in scope for `app.manage`/`app.try_state`.)

- [ ] **Step 6: Run, verify pass** — `cd src-tauri && cargo test mcp::lifecycle settings::tests::mcp_enabled` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mcp/lifecycle.rs src-tauri/src/settings.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): enable-toggle setting + lifecycle service (start/stop, managed state) (refs #<ISSUE>)"
```

### Task 4.2: Relay the watcher event → IPC `list_changed` push channel

**Files:**
- Modify: `src-tauri/src/mcp/lifecycle.rs` (the relay hookup)
- Modify: `src-tauri/src/lib.rs` (listen for `"kb://list_changed"` and notify the shim)

**Interfaces:**
- Consumes: the Plan 1 Tauri event `"kb://list_changed"` (payload = the changed canonical path), the `McpService`.
- Produces: a mechanism by which an active shim connection learns of a changed resource so it can emit MCP `notifications/resources/list_changed`. v1 design: the shim, while connected, may issue a `Manifest`/poll on a long-lived connection; but the **clean** path is a dedicated **notify connection** — the shim opens a second IPC stream and blocks reading `list_changed` frames the app pushes. This task adds the app-side push side; the shim's consume side is Task 5.3.

- [ ] **Step 1: Add a broadcast of changed paths to the service**

Extend `McpService` with a `tokio::sync::broadcast` (or a simple `std::sync::mpsc` fan-out) of changed canonical paths, set when the listener starts, so any connected notify-stream can subscribe:

```rust
// add to McpService:
use tokio::sync::broadcast;

pub struct McpService {
    running: Mutex<Option<McpHandle>>,
    // Changed canonical paths fan out to every connected notify stream.
    changed_tx: broadcast::Sender<String>,
}

impl Default for McpService {
    fn default() -> Self {
        let (changed_tx, _rx) = broadcast::channel(256);
        Self {
            running: Mutex::new(None),
            changed_tx,
        }
    }
}

impl McpService {
    /// Called from the app's Tauri "kb://list_changed" listener; fans the path
    /// out to every connected notify stream (no-op if none are connected).
    pub fn notify_changed(&self, canonical: &str) {
        let _ = self.changed_tx.send(canonical.to_string());
    }

    pub fn subscribe_changed(&self) -> broadcast::Receiver<String> {
        self.changed_tx.subscribe()
    }
}
```

> The IPC server's accept loop must distinguish a **read** connection (Task 3.2) from a **notify** connection. Add a first-frame discriminator: a notify stream sends a `Manifest`-shaped `{op:"Subscribe", token}` request; on a valid token the connection switches to push mode and writes a `list_changed` frame per change. Extend `IpcRequest` with a `Subscribe { token: String }` variant and `IpcResponse` with a `Changed { canonical: String }` variant in `wire.rs`, then have `handle_connection` branch: a `Subscribe` (valid token) parks the connection in a loop reading `subscribe_changed()` and writing `Changed` frames until the peer disconnects. (Wire the `McpService` handle into `serve` so `handle_connection` can subscribe — pass an `Arc<broadcast::Sender<String>>` into `serve`.)

- [ ] **Step 2: Wire the Tauri event listener in `lib.rs`**

In the `.setup(...)` closure, after managing `McpService`, listen for the watcher event and relay it:

```rust
use tauri::Listener;
let relay_handle = app.handle().clone();
app.listen("kb://list_changed", move |event| {
    if let Some(svc) = relay_handle.try_state::<McpService>() {
        // The Plan 1 watcher emits the changed canonical path as the payload.
        let canonical = event.payload().trim_matches('"').to_string();
        svc.notify_changed(&canonical);
    }
});
```

> [!NOTE]
> Plan 1 produces `kb::watch::start_watch` but never calls it at boot — **this plan owns the watcher lifecycle.** The watcher is bound to the MCP enable state: it starts when `mcp_kb_access_enabled` is true (at boot and on the enable-toggle) and stops on disable, so it only runs while MCP is enabled. Step 3 below folds `start_watch`/drop into `McpService::start`/`stop` so the watcher and the IPC listener share one lifecycle; this task's Tauri listener (Step 2 above) only relays the `kb://list_changed` *event* the running watcher emits into the notify broadcast.

- [ ] **Step 3: Fold the watcher into the lifecycle service (this plan owns it)**

The watcher shares the IPC listener's lifecycle: it starts inside `McpService::start` and is dropped inside `McpService::stop`. Because `kb::watch::start_watch` needs the Tauri `AppHandle` (to emit `kb://list_changed`) and the server-owned vault root, `start` takes the `AppHandle`; the returned `RecommendedWatcher` is held in `McpHandle` so dropping it on stop tears the watch down. Update `McpHandle`, `start`, and `stop` from Task 4.1:

```rust
use crate::kb::watch::{self, EchoFilter};
use crate::settings;
use notify::RecommendedWatcher;
use tauri::AppHandle;

struct McpHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    // Held for its lifetime: dropping the watcher stops the filesystem watch.
    _watcher: Option<RecommendedWatcher>,
}

impl McpService {
    /// Start the IPC listener thread AND the KB folder-watcher if not already
    /// running. Idempotent. The watcher emits `kb://list_changed`, which the
    /// app's listener relays into this service's notify broadcast (Step 2).
    pub fn start(&self, app: &AppHandle) -> Result<(), McpError> {
        let mut guard = self.running.lock().expect("mcp service lock poisoned");
        if guard.is_some() {
            return Ok(()); // already running
        }

        // Start the watcher first, bound to the server-owned vault root. A missing
        // root is not fatal: the listener still serves, and the watcher starts on
        // the next enable once a vault is configured.
        let watcher = match settings::get_vault_root().map_err(McpError::Kb)? {
            Some(root) => match watch::start_watch(app.clone(), &root, EchoFilter::default()) {
                Ok(w) => Some(w),
                Err(e) => {
                    tracing::warn!(error = %e, "kb watcher failed to start; list_changed disabled");
                    None
                }
            },
            None => None,
        };

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let join = std::thread::spawn(move || {
            if let Err(e) = server::serve(stop_thread) {
                tracing::error!(error = %e, "mcp ipc server exited with error");
            }
        });
        *guard = Some(McpHandle {
            stop,
            join: Some(join),
            _watcher: watcher,
        });
        tracing::info!("mcp ipc server + kb watcher started");
        Ok(())
    }

    /// Stop the listener (join its thread + every worker) and drop the watcher.
    pub fn stop(&self) {
        let mut guard = self.running.lock().expect("mcp service lock poisoned");
        if let Some(mut handle) = guard.take() {
            handle.stop.store(true, Ordering::Relaxed);
            if let Some(join) = handle.join.take() {
                let _ = join.join(); // returns only after every worker is joined
            }
            // `handle` (incl. `_watcher`) drops here, stopping the filesystem watch.
            tracing::info!("mcp ipc server + kb watcher stopped");
        }
    }
}
```

Update the two call sites accordingly: the boot wiring in `lib.rs` (Task 4.1 Step 5) becomes `svc.start(&app.handle())`, and `mcp_set_enabled` in `commands.rs` (Task 6.1) calls `service.start(&app_handle)` (the command takes `app: AppHandle`). The idempotency test in Task 4.1 Step 1 needs an `AppHandle`; drive it with Tauri's `tauri::test::mock_app()` (or gate the watcher start behind the existing temp-app harness) so `start`/`stop` remain unit-testable without a real window.

- [ ] **Step 4: Build + verify** — `cd src-tauri && cargo build && cargo test mcp::` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/lifecycle.rs src-tauri/src/mcp/wire.rs src-tauri/src/mcp/server.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): relay kb://list_changed + fold watcher into the mcp lifecycle (refs #<ISSUE>)"
```

---

## Phase 5 — The `stashpeak-mcp` shim binary

The shim is the process the MCP client spawns. It speaks MCP on stdio (`rmcp`) and the `wire.rs` IPC to the app. It holds nothing sensitive: every read is forwarded. Its handshake is driven by the app-supplied manifest.

### Task 5.1: Stdout discipline + IPC client + manifest fetch

**Files:**
- Create/fill: `src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Consumes: `stashpeak_lib::mcp::wire::{IpcRequest,IpcResponse,read_frame,write_frame}`, `stashpeak_lib::mcp::server::ipc_socket_name`, `stashpeak_lib::mcp::manifest::CapabilityManifest`, `interprocess` client, `rmcp` stdio server.
- Produces: the shim entrypoint that (1) installs a stderr-only panic hook + tracing before anything touches stdout, (2) reads the token from the env/arg the client passes, (3) connects to the app IPC socket, (4) fetches the manifest, (5) hands MCP on stdio to `rmcp`.

- [ ] **Step 1: Implement the stdout-discipline preamble + IPC client helpers**

```rust
//! stashpeak-mcp — the thin MCP stdio shim. The MCP client SPAWNS this process.
//! It holds NO app logic, NO keychain, NO direct vault fs — every read crosses
//! the local IPC hop to the running Stashpeak app (MCP_KB_CONTRACT.md §4).
//!
//! STDOUT DISCIPLINE: nothing but framed JSON-RPC ever reaches stdout. All logs
//! and all panics go to stderr (installed first, before any stdout touch).

use stashpeak_lib::mcp::manifest::CapabilityManifest;
use stashpeak_lib::mcp::server::ipc_socket_name;
use stashpeak_lib::mcp::wire::{read_frame, write_frame, IpcRequest, IpcResponse};

use interprocess::local_socket::{traits::Stream as _, GenericNamespaced, Stream, ToNsName};

/// Install a panic hook + a stderr-only tracing writer BEFORE anything else, so
/// no panic message or log line can ever corrupt the stdout JSON-RPC stream.
fn install_stderr_only_diagnostics() {
    std::panic::set_hook(Box::new(|info| {
        // Stderr only — a panic on stdout would poison the MCP stream.
        eprintln!("stashpeak-mcp panic: {info}");
    }));
    // Route tracing to stderr; never to stdout.
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
}

/// Read the per-client token the user pasted into the MCP client config. The
/// client passes it as STASHPEAK_MCP_TOKEN (env) or `--token <t>` (arg).
fn read_token() -> Option<String> {
    if let Ok(t) = std::env::var("STASHPEAK_MCP_TOKEN") {
        if !t.is_empty() {
            return Some(t);
        }
    }
    let mut args = std::env::args();
    while let Some(a) = args.next() {
        if a == "--token" {
            return args.next();
        }
    }
    None
}

/// Open a fresh IPC connection to the app and run one request/response.
fn ipc_call(req: &IpcRequest) -> Result<IpcResponse, String> {
    let name = ipc_socket_name()
        .to_ns_name::<GenericNamespaced>()
        .map_err(|e| e.to_string())?;
    let mut conn = Stream::connect(name).map_err(|_| "Stashpeak is not running".to_string())?;
    write_frame(&mut conn, req).map_err(|e| e.to_string())?;
    read_frame(&mut conn).map_err(|e| e.to_string())
}

/// Fetch the app-supplied manifest that drives the MCP `initialize` handshake.
fn fetch_manifest(token: &str) -> Result<CapabilityManifest, String> {
    match ipc_call(&IpcRequest::Manifest { token: token.to_string() })? {
        IpcResponse::Manifest(m) => Ok(m),
        IpcResponse::Error { kind, message } => Err(format!("{kind}: {message}")),
        _ => Err("unexpected response to Manifest".to_string()),
    }
}
```

- [ ] **Step 2: Build** — `cd src-tauri && cargo build --bin stashpeak-mcp`
Expected: compiles (no `main` body yet beyond the stub; replace the stub `fn main(){}` with the body in Task 5.2). For now, temporarily call the helpers from `main` behind `#[allow(dead_code)]` or proceed directly to 5.2.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): shim stdout discipline + IPC client + manifest fetch (refs #<ISSUE>)"
```

### Task 5.2: The MCP server (handshake from manifest, resources + tools, IPC-forwarded)

**Files:**
- Modify: `src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Produces: the `rmcp` `ServerHandler` (or hand-rolled JSON-RPC fallback) that:
  - emits `initialize` from the fetched `CapabilityManifest` (`serverInfo` = name+version, negotiated `protocolVersion`, `capabilities` = `resources.listChanged` / `tools.listChanged` exactly as the manifest states);
  - serves `resources/list` (IPC `List` → `kb://vault/<canonical>` URIs via `uri::canonical_to_uri`) and `resources/read` (URI → `uri_to_canonical` → IPC `ReadNote`);
  - serves the three tools `kb_search` / `kb_read_note` / `kb_list`, each forwarding to the matching IPC request, with `readOnlyHint: true`;
  - returns broker errors as `isError` tool-results / MCP errors (§8.3 contract — recoverable, stream stays valid), and a clean "Stashpeak is not running" when the IPC connect fails.

- [ ] **Step 1: Implement `main` + the handler**

```rust
#[tokio::main]
async fn main() {
    install_stderr_only_diagnostics();

    let token = match read_token() {
        Some(t) => t,
        None => {
            eprintln!("stashpeak-mcp: no token (set STASHPEAK_MCP_TOKEN or --token)");
            std::process::exit(2);
        }
    };

    // The handshake data is app-owned. If the app is down, surface it cleanly on
    // stderr and exit; never write anything to stdout.
    let manifest = match fetch_manifest(&token) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("stashpeak-mcp: cannot initialize: {e}");
            std::process::exit(1);
        }
    };

    // Build the rmcp stdio server from the app-supplied manifest. The exact rmcp
    // API is resolved at implementation time; the handler below is the contract.
    if let Err(e) = run_mcp_stdio(token, manifest).await {
        eprintln!("stashpeak-mcp: server error: {e}");
        std::process::exit(1);
    }
}

/// Drive the MCP stdio server. Each MCP call forwards to the app over IPC.
/// (Sketch of the rmcp ServerHandler wiring — fill in against the linked rmcp
/// version. The IPC forwarding + the URI mapping below are the load-bearing
/// parts and do not change regardless of how rmcp's trait is shaped.)
async fn run_mcp_stdio(token: String, manifest: CapabilityManifest) -> Result<(), String> {
    use stashpeak_lib::mcp::uri::{canonical_to_uri, uri_to_canonical};

    // resources/list -> IPC List -> kb:// URIs
    let _list_resources = {
        let token = token.clone();
        move || -> Result<Vec<String>, String> {
            match ipc_call(&IpcRequest::List { token: token.clone() })? {
                IpcResponse::List { paths } => Ok(paths.iter().map(|p| canonical_to_uri(p)).collect()),
                IpcResponse::Error { kind, message } => Err(format!("{kind}: {message}")),
                _ => Err("unexpected response".into()),
            }
        }
    };

    // resources/read(uri) -> canonical -> IPC ReadNote
    let _read_resource = {
        let token = token.clone();
        move |uri: &str| -> Result<String, String> {
            let canonical = uri_to_canonical(uri).map_err(|e| e.to_string())?;
            match ipc_call(&IpcRequest::ReadNote { token: token.clone(), canonical })? {
                IpcResponse::Note { content } => Ok(content),
                IpcResponse::Error { kind, message } => Err(format!("{kind}: {message}")),
                _ => Err("unexpected response".into()),
            }
        }
    };

    // tools/call:
    //   kb_list      -> IPC List   (returns the canonical paths)
    //   kb_read_note -> IPC ReadNote(canonical)
    //   kb_search    -> IPC Search(query, limit)
    // each maps an IpcResponse::Error to an MCP isError tool-result (§8.3),
    // and an IPC connect failure to "Stashpeak is not running".

    // Register `serverInfo`/capabilities from `manifest` (serverInfo name/version,
    // resources.listChanged = manifest.resources_list_changed, tools.listChanged =
    // manifest.tools_list_changed, tools = manifest.tools with readOnlyHint).
    let _ = &manifest;

    // The notify stream (Task 5.3) runs concurrently and pushes
    // notifications/resources/list_changed.

    // Hand stdin/stdout to rmcp's stdio transport and serve until the client
    // closes the pipe.
    Err("wire rmcp stdio transport here".into()) // replaced by the real rmcp serve() call
}
```

> [!IMPORTANT]
> The `run_mcp_stdio` body is the only place a sketch remains, and it is bounded: the **load-bearing logic is concrete** (token read, IPC forwarding, the `canonical_to_uri`/`uri_to_canonical` mapping, the `isError`/"not running" error contract, manifest-driven capabilities). What is deferred to implementation time is **only** the mechanical `rmcp` trait wiring (the exact `ServerHandler` method names and how `rmcp` exposes `serverInfo`/capabilities + the stdio transport handle) — because `rmcp`'s API is version-specific and must be read from `cargo doc -p rmcp`. If `rmcp` cannot drive a fully app-supplied manifest, hand-roll the JSON-RPC `initialize`/`resources/*`/`tools/*` handlers reading/writing line-delimited JSON-RPC on stdin/stdout (the CI smoke in Task 6.2 validates either path identically). Record which path was taken in the PR.

- [ ] **Step 2: Build** — `cd src-tauri && cargo build --bin stashpeak-mcp`
Expected: compiles once the `rmcp` serve call replaces the sketch line. Until then, keep the binary compiling by returning the placeholder `Err` (it builds; it just doesn't serve yet).

- [ ] **Step 3: Manual smoke (documented in the PR, not CI)**

With a configured vault + a minted token + the app running, configure Claude Desktop / Cursor with the snippet (Task 6.1), restart the client, and confirm: the server appears, `resources/list` shows `kb://vault/...` URIs, attaching one renders the note, and `kb_search` returns hits. Confirm the app's read-activity panel (Plan 4 surfaces it; the rows are written here) records each read.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): shim MCP server — manifest handshake, kb:// resources + read tools (refs #<ISSUE>)"
```

### Task 5.3: The shim's notify consumer → `notifications/resources/list_changed`

**Files:**
- Modify: `src-tauri/src/bin/mcp.rs`

**Interfaces:**
- Consumes: the app's notify stream (`IpcRequest::Subscribe` → `IpcResponse::Changed` frames, Task 4.2).
- Produces: a background task in the shim that opens a second IPC connection, sends `Subscribe { token }`, and on each `Changed` frame emits an MCP `notifications/resources/list_changed` to the client (v1 advertises only `listChanged`, not per-URI `subscribe`, so the notification is the list-level one — §5.1).

- [ ] **Step 1: Implement the notify task**

```rust
/// Open a dedicated IPC connection, subscribe, and relay each app-side change
/// to the MCP client as notifications/resources/list_changed.
async fn run_notify_relay(token: String, emit_list_changed: impl Fn() + Send + 'static) {
    // Run the blocking IPC read on a dedicated thread (the connection blocks
    // reading Changed frames); bridge each change to the MCP emit.
    let _ = std::thread::Builder::new()
        .name("mcp-notify".into())
        .spawn(move || {
            let name = match ipc_socket_name().to_ns_name::<GenericNamespaced>() {
                Ok(n) => n,
                Err(_) => return,
            };
            let mut conn = match Stream::connect(name) {
                Ok(c) => c,
                Err(_) => return, // app down: no notifications, the read path already errors cleanly
            };
            if write_frame(&mut conn, &IpcRequest::Subscribe { token }).is_err() {
                return;
            }
            // Each Changed frame -> one MCP list_changed notification.
            loop {
                match read_frame::<_, IpcResponse>(&mut conn) {
                    Ok(IpcResponse::Changed { .. }) => emit_list_changed(),
                    Ok(_) => continue,
                    Err(_) => return, // app stopped / connection closed
                }
            }
        });
}
```

Wire `run_notify_relay` into `run_mcp_stdio` so it starts alongside the stdio server, passing a closure that calls `rmcp`'s "emit `notifications/resources/list_changed`" API (resolve the exact method at implementation time).

- [ ] **Step 2: Build + verify** — `cd src-tauri && cargo build --all-targets` → compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/bin/mcp.rs
git commit -m "feat(mcp): shim notify relay -> notifications/resources/list_changed (refs #<ISSUE>)"
```

---

## Phase 6 — Tauri commands, client-config snippet, and the CI smoke

### Task 6.1: `config.rs` snippet + the Tauri commands Plan 4 consumes

**Files:**
- Create/fill: `src-tauri/src/mcp/config.rs`
- Create/fill: `src-tauri/src/mcp/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register the commands)
- Test: inline `#[cfg(test)]` in `config.rs`

**Interfaces:**
- Produces (`config.rs`): `pub fn client_config_snippet(token: &str) -> String` — a paste-ready JSON config block for Claude Desktop / Cursor pointing at the `stashpeak-mcp` binary with the token in `env`. The token is rendered verbatim (the user must see it once); it is **not** logged.
- Produces (`commands.rs`, all `#[tauri::command] async fn ... -> Result<_, String>`, via `run_blocking`, consumed by Plan 4):
  - `mcp_get_enabled() -> Result<bool,String>`
  - `mcp_set_enabled(enabled: bool) -> Result<(),String>` (persists the setting **and** starts/stops the service via managed state)
  - `mcp_mint_token(label: String, scope: String) -> Result<String,String>` (parses `"read"`/`"read_write"` → `tokens::Scope`, mints, returns the raw token once)
  - `mcp_list_tokens() -> Result<Vec<tokens::TokenInfo>,String>`
  - `mcp_revoke_token(id: String) -> Result<(),String>`
  - `mcp_recent_activity(limit: usize) -> Result<Vec<ledger::LedgerRow>,String>`
  - `mcp_client_config_snippet(token: String) -> Result<String,String>`

- [ ] **Step 1: Write the failing test for the snippet**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_includes_binary_and_token_and_is_valid_json() {
        let s = client_config_snippet("spk_mcp_abc123");
        assert!(s.contains("stashpeak-mcp"));
        assert!(s.contains("spk_mcp_abc123"));
        assert!(s.contains("STASHPEAK_MCP_TOKEN"));
        // The embedded mcpServers block must parse as JSON.
        let v: serde_json::Value = serde_json::from_str(&s).expect("snippet is valid json");
        assert!(v.get("mcpServers").is_some());
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test mcp::config::tests` → FAIL.

- [ ] **Step 3: Implement `config.rs`**

```rust
/// The paste-ready MCP client config (Claude Desktop / Cursor share the
/// `mcpServers` shape). The token rides in `env`. The binary name matches the
/// [[bin]] target; the user points `command` at its installed path.
pub fn client_config_snippet(token: &str) -> String {
    let config = serde_json::json!({
        "mcpServers": {
            "stashpeak-kb": {
                "command": "stashpeak-mcp",
                "args": [],
                "env": { "STASHPEAK_MCP_TOKEN": token }
            }
        }
    });
    serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".to_string())
}
```

> [!NOTE]
> `command` is the bare `stashpeak-mcp` name; the Settings UI (Plan 4) should show the absolute installed path of the shipped binary so the user can paste a working `command`. Where the shim binary is installed alongside the app is a packaging detail (§11) — note it in the PR for Plan 4 to surface.

- [ ] **Step 4: Implement `commands.rs`**

```rust
use crate::kb::{ledger, tokens};
use crate::mcp::config;
use crate::mcp::lifecycle::McpService;
use crate::settings;
use tauri::State;

#[tauri::command]
pub async fn mcp_get_enabled() -> Result<bool, String> {
    crate::run_blocking("mcp_get_enabled", settings::get_mcp_enabled).await
}

#[tauri::command]
pub async fn mcp_set_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    service: State<'_, McpService>,
) -> Result<(), String> {
    // Flip the live service FIRST, persist the setting only after it succeeds, so
    // a bind/watcher failure never leaves `mcp_kb_access_enabled = true` while the
    // server is actually down (settings always reflect the real running state).
    if enabled {
        service.start(&app).map_err(|e| e.to_string())?;
    } else {
        service.stop();
    }
    // Persist last (blocking). If this write fails after a successful start, roll
    // the service back so settings and the live state never disagree.
    if let Err(e) =
        crate::run_blocking("mcp_set_enabled", move || settings::set_mcp_enabled(enabled)).await
    {
        if enabled {
            service.stop();
        }
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_mint_token(label: String, scope: String) -> Result<String, String> {
    crate::run_blocking("mcp_mint_token", move || {
        let scope = match scope.as_str() {
            "read" => tokens::Scope::Read,
            "read_write" => tokens::Scope::ReadWrite,
            other => return Err(format!("unknown scope '{other}'")),
        };
        tokens::mint(label, scope)
    })
    .await
}

#[tauri::command]
pub async fn mcp_list_tokens() -> Result<Vec<tokens::TokenInfo>, String> {
    crate::run_blocking("mcp_list_tokens", tokens::list).await
}

#[tauri::command]
pub async fn mcp_revoke_token(id: String) -> Result<(), String> {
    crate::run_blocking("mcp_revoke_token", move || tokens::revoke(&id)).await
}

#[tauri::command]
pub async fn mcp_recent_activity(limit: usize) -> Result<Vec<ledger::LedgerRow>, String> {
    crate::run_blocking("mcp_recent_activity", move || ledger::recent(limit)).await
}

#[tauri::command]
pub async fn mcp_client_config_snippet(token: String) -> Result<String, String> {
    Ok(config::client_config_snippet(&token))
}
```

> [!NOTE]
> `mcp_set_enabled` takes `AppHandle` (to boot the watcher via `service.start(&app)`) + `State<'_, McpService>` (not via `run_blocking`, which would lose the borrow) — the setting persist is the only blocking work and is wrapped; `start()`/`stop()` are fast (spawn/join a thread) and run on the command task. **Order matters:** the live service is flipped *first* and the setting is persisted *only after* a successful `start()` (with a rollback `stop()` if the persist itself fails), so a bind/watcher failure can never leave `mcp_kb_access_enabled = true` while the server is down — settings always mirror the real running state. `mcp_mint_token` returns the raw token to the frontend exactly once (Plan 4 shows-then-discards); `tokens::mint` already `remember_secret`s it (Plan 2).

- [ ] **Step 5: Register the commands in `lib.rs`**

Add to the `tauri::generate_handler![...]` list:

```rust
mcp::commands::mcp_get_enabled,
mcp::commands::mcp_set_enabled,
mcp::commands::mcp_mint_token,
mcp::commands::mcp_list_tokens,
mcp::commands::mcp_revoke_token,
mcp::commands::mcp_recent_activity,
mcp::commands::mcp_client_config_snippet,
```

- [ ] **Step 6: Run full gate** — `cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test` → all clean / PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mcp/config.rs src-tauri/src/mcp/commands.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): client-config snippet + Tauri commands (enable, tokens, activity) (refs #<ISSUE>)"
```

### Task 6.2: The CI `initialize` stdout-discipline smoke

**Files:**
- Modify: the existing Rust CI workflow (`.github/workflows/<rust-ci>.yml`)

**Interfaces:**
- Produces: a CI step that builds `stashpeak-mcp`, pipes an `initialize` JSON-RPC request into it, and asserts the **first stdout bytes are valid JSON-RPC** (and that a forced panic goes to stderr, never stdout) — the §5.1 / §14 smoke.

> [!NOTE]
> The full `initialize` handshake needs a running app on the IPC hop (the manifest comes from the app). The smoke therefore has two layers: (a) an **app-independent** assertion that the shim writes nothing to stdout before/around an IPC-down failure (it must exit non-zero with a stderr message and an **empty stdout**); and (b) when feasible, a fuller smoke that starts a headless app stub exposing the IPC manifest endpoint, then asserts the first stdout frame is a valid JSON-RPC `initialize` result. Layer (a) is the always-on guard (it is what actually catches stdout pollution — a stray banner/panic line); layer (b) is best-effort in the dedicated Win/macOS job.

- [ ] **Step 1: Add a smoke script**

Create `src-tauri/scripts/mcp_smoke.sh` (referenced by CI; keep it POSIX so it runs on the Linux runner, with a PowerShell sibling `mcp_smoke.ps1` for the Windows job if needed):

```bash
#!/usr/bin/env bash
set -euo pipefail
# Build the shim and assert stdout discipline: with the app down, the shim must
# exit non-zero, print its diagnostic to STDERR, and write NOTHING to STDOUT.
cargo build --bin stashpeak-mcp --manifest-path src-tauri/Cargo.toml

BIN="src-tauri/target/debug/stashpeak-mcp"
OUT="$(mktemp)"; ERR="$(mktemp)"

# No token + app down: must fail, stdout must be empty.
set +e
STASHPEAK_MCP_TOKEN="spk_mcp_smoke" "$BIN" </dev/null >"$OUT" 2>"$ERR"
code=$?
set -e

if [ -s "$OUT" ]; then
  echo "FAIL: stashpeak-mcp wrote to stdout when it must not have:"; cat "$OUT"; exit 1
fi
if [ "$code" -eq 0 ]; then
  echo "FAIL: shim should exit non-zero when the app IPC is unavailable"; exit 1
fi
echo "OK: stdout empty on failure; diagnostics on stderr; non-zero exit."
echo "--- stderr was: ---"; cat "$ERR"
```

- [ ] **Step 2: Wire it into the CI job**

In the existing Rust CI job (the `cargo test` job; the 3-OS matrix), add a step after the build:

```yaml
      - name: MCP stdout-discipline smoke
        shell: bash
        run: bash src-tauri/scripts/mcp_smoke.sh
```

(The `shell: bash` makes the one script run on all three OSes since GitHub runners ship bash.)

- [ ] **Step 3: Verify locally** — `bash src-tauri/scripts/mcp_smoke.sh` → prints `OK: ...`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/scripts/mcp_smoke.sh .github/workflows/
git commit -m "ci(mcp): stdout-discipline smoke for the stashpeak-mcp shim (refs #<ISSUE>)"
```

### Task 6.3: Open the PR

- [ ] **Step 1: Final gate + push**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app/src-tauri"
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd ..
git push -u origin feat/mcp-transport-shim-<ISSUE>
```

- [ ] **Step 2: PR**

```bash
gh pr create --base main \
  --title "feat(mcp): transport — local-IPC server + stashpeak-mcp stdio shim" \
  --body-file <PR body with ## Test plan + Closes #<ISSUE>>
```

PR body must include `Closes #<ISSUE>` and a `## Test plan` (the CI `validate-pr-body` gate requires both). Test plan lists: the `uri`/`wire`/`manifest`/`server` unit tests, the loopback IPC round-trip, the lifecycle idempotency test, the CI stdout smoke, **and** the manual end-to-end smoke (Claude Desktop / Cursor → resources/list → read → search → activity-log rows). Note which `rmcp` path was taken (SDK vs hand-rolled JSON-RPC) and where the shim binary is expected to be installed (for Plan 4 to surface the absolute `command` path).

- [ ] **Step 3: Address CodeRabbit autonomously** (fix + reply + resolve thread). Check **all** comment surfaces (inline `gh api pulls/N/comments`, every review body `gh api pulls/N/reviews[].body`, top-level `issues/N/comments`) before considering the PR review-clean. Do **not** trigger Codex (usage-limit standing instruction) unless the founder asks. Then hand to the founder to merge.

---

## Self-Review (completed by the plan author)

- **Spec coverage (MCP_KB_CONTRACT v1.0 transport slice):** spawned-shim + local-IPC topology ✓ (§4 — Phase 5 shim, Phase 3 IPC server, T13 boundary = the hop); vault-root server-owned ✓ (`server::vault_root` from settings, never client-supplied); stdio MCP surface ✓ (§5 — shim handshake from app manifest, `resources`+`tools`, Phase 5); pinned `kb://vault/<canonical>` grammar ✓ (§5.3 — `uri.rs`, byte-for-byte tests); capabilities advertised only-if-implemented (`resources.listChanged:true`, `tools.listChanged:false`, no `subscribe`) ✓ (manifest.rs); stdout discipline + CI `initialize` smoke ✓ (Task 5.1 preamble + Task 6.2); `notifications/resources/list_changed` from the watcher event ✓ (Task 4.2 relay + Task 5.3 shim consumer); token authenticates the IPC hop + scope re-read per call ✓ (`server::handle_request` validates per request — §6.1/§6.3); read confidentiality + ledger + brake routed through Plan 2 ✓ (`access::*` + `ledger::record_read`/`check_read_budget`); opt-in available-off + resource-holding lifecycle ✓ (§11 — `mcp_kb_access_enabled` default false, `McpService` start/stop, no network port); the Tauri commands Plan 4 consumes ✓ (Task 6.1).
- **Consumed-not-redefined check:** every read goes through `kb::access` (Plan 2), never raw `kb::read`/`kb::search`; tokens via `kb::tokens` (Plan 2); ledger via `kb::ledger` (Plan 2); canonical paths + watcher via `kb::path`/`kb::watch` (Plan 1). No Plan 1/2 signature is redefined here. The "Consumed interface contract" section pins them; a mismatch is a stop-and-reconcile, not an adapt-around.
- **Out-of-scope kept out:** no `resolve_readable`/`.kbignore`/token/ledger *implementation* (Plan 2); no frontend components/`invoke` wrappers (Plan 4 — this plan only produces the commands they call); no write tools / containment algorithm (Plan 5, §8). The write surface is named only in the manifest's absence (no write tools) and the roadmap.
- **Placeholder scan:** the only intentional substitutions are `#<ISSUE>` (real number from Task 0.1), the PR-body file, and the **bounded** `rmcp` trait-wiring sketch in `run_mcp_stdio`/`run_notify_relay` — explicitly flagged as the one version-specific mechanical gap, with concrete load-bearing logic (IPC forwarding, URI mapping, error contract, manifest-driven capabilities) fully written and a hand-rolled JSON-RPC fallback specified so the task is completable either way. No vague "TBD"/"add error handling" placeholders elsewhere; every other code step carries complete, compiling code.
- **Type consistency:** `IpcRequest`/`IpcResponse` variants match across `wire.rs`, `server.rs`, and `bin/mcp.rs` (incl. the `Subscribe`/`Changed` additions in Task 4.2); `CapabilityManifest`/`ToolDecl` consistent across `manifest.rs`, `wire.rs`, and the shim; `McpService` (`start`/`stop`/`is_running`/`notify_changed`/`subscribe_changed`) consistent across `lifecycle.rs`, `commands.rs`, and the `lib.rs` setup; `canonical_to_uri`/`uri_to_canonical` consistent across `uri.rs` and the shim; the Tauri command return types match the Plan-2 types (`TokenInfo`, `LedgerRow`) the frontend (Plan 4) will consume.

---

## Roadmap — where this plan sits

- **Plan 1 — MCP KB foundation (PR #213, merged):** vault root, canonical path + containment, read/search, folder-watcher + `kb://list_changed`. **Consumed here.**
- **Plan 2 — MCP security & audit:** `resolve_readable` default-deny gate + `.kbignore` + default-excluded set + T10 snippet scrub; the `kb::access` gated facade; the `kb::tokens` store (`mcp_clients`, migration `008_mcp.sql`); the `kb::ledger` read ledger + bulk-read brake (`mcp_activity_ledger`). **Consumed here.**
- **Plan 3 — MCP transport (this plan):** the app-side local-IPC server + the `stashpeak-mcp` shim + the Tauri commands. **Depends on Plans 1–2.**
- **Plan 4 — Frontend KB-access settings:** the opt-in toggle, token mint/list/revoke UI + the config snippet, the read activity-log view. **Consumes this plan's Tauri commands.**
- **Plan 5 (v1.x) — Write path:** the owned write broker + containment algorithm (reject-list + handle-based resolve + reparse rejection + re-validate-after-open + atomic CAS) + `kb_append_note`/`kb_create_note`/`kb_write_note` + write tools in the manifest. (`MCP_KB_CONTRACT.md` §8.)

---

## Pre-execution corrections (from the cross-plan synthesis — apply while executing this plan)

A cross-plan review (Plans 1–4 + `MCP_KB_CONTRACT.md`) found the items below. The two cheap correctness fixes are already applied to the upstream plan docs; the rest are corrections to apply **in this plan** during execution.

- **[P0 — upstream, already fixed] `SearchHit: Deserialize`.** Plan 1's `kb::search::SearchHit` originally derived `Serialize` only; this plan's `wire.rs` `IpcResponse::Search { hits: Vec<SearchHit> }` derives `Deserialize` and the shim deserializes it, so the build would break. Plan 1's doc has been corrected to derive `Serialize, Deserialize`. **Consumed-interface requirement: `SearchHit: Serialize + Deserialize` — stop-and-reconcile if the merged Plan 1 lacks `Deserialize`.**
- **[P1 — upstream, already fixed] camelCase wire.** Plan 2's `TokenInfo` / `LedgerRow` now carry `#[serde(rename_all = "camelCase")]` (the repo-wide convention; Plan 4's TS reads `createdAt` / `clientLabel` / `resultCount`). Any new struct THIS plan returns to the frontend must do the same.
- **[P1 — apply here] Make the hand-rolled JSON-RPC stdio handler the PRIMARY path; demote `rmcp` to an optional swap-in.** Task 5.2's `run_mcp_stdio` currently ends in a bounded `rmcp` sketch (`Err("wire rmcp stdio transport here")`). Instead, write the complete line-delimited JSON-RPC handlers for `initialize` (from the app-supplied manifest), `resources/list`, `resources/read`, `tools/list`, `tools/call` directly on stdin/stdout, so every step compiles as written. (The CI smoke in Task 6.2 validates this path identically.) Keep `rmcp` only as an optional later refactor, and resolve its version then.
- **[P2 — apply here] Declare the notification wire variants up front.** Add `IpcRequest::Subscribe { token }` and `IpcResponse::Changed { canonical: String }` to `wire.rs` in **Task 2.3** (not retrofitted in Task 4.2), and make Task 3.2's `handle_connection` match include the new arm so it stays exhaustive. Task 4.2 then only wires the relay, not the enum.
- **[P2 — applied] This plan OWNS the watcher lifecycle.** `kb::watch::start_watch(...)` is folded into `McpService::start` (and the watcher is dropped in `McpService::stop`) so it runs exactly when `mcp_kb_access_enabled` is true — at boot and on the enable-toggle, stopped on disable (Task 4.2 Step 3). Plan 1 produces `start_watch` but never calls it at boot; there is no "if Plan 1 didn't start it" fallback path — the watcher start/stop are concrete lifecycle steps here.
- **[P2 — note] `usize` fields** (`SearchHit.score`, `LedgerRow.result_count`) serialize fine as JSON numbers and TS reads `number`; left as-is. Switch to `u32`/`u64` only if cross-arch determinism is ever wanted.
- **[confirmed defaults — no change needed]** Per-folder do-not-expose marker = Plan 2's **`.nokb`** file (plus `.kbignore *`) — accepted as the pinned convention (`MCP_KB_CONTRACT.md` §7.1 left the on-disk form open). Bulk-read brake thresholds = `WINDOW_SECS=60`, `NOTICE=30`, `PAUSE=100` — accepted defaults, tunable in one place (`kb::ledger`); this plan acts on the `Brake` verbatim.
- **[sequencing]** All four plan files live under `docs/superpowers/plans/`, which only exists on `main` once Plan 1 (PR #213) merges. Issue/PR cross-refs (`#<ISSUE>`, Plan 1 = PR #213) are placeholders — substitute real numbers at execution.
