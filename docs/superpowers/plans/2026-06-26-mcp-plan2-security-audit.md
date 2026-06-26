# MCP Security & Audit Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan 2 of the MCP read-first series.** This plan builds the security & audit layer **on top of Plan 1** (`docs/superpowers/plans/2026-06-25-mcp-kb-foundation.md`, PR #213). It **depends on Plan 1** for the `kb::path`, `kb::read`, `kb::search`, `kb::watch` modules, the `kb::KbError` enum, the `settings::{get,set}_vault_root` helpers, and the `pub(crate) run_blocking` helper. It contains **no MCP protocol, IPC, or shim** (Plan 3), **no frontend** (Plan 4), and **no write path** (Plan 5). See `docs/MCP_KB_CONTRACT.md` §6 (tokens), §7 (read path / `resolve_readable` / ledger), §12 (T13) and the roadmap at the bottom of Plan 1.

**Goal:** Build the confidentiality + accountability layer the MCP read server (Plan 3) sits behind — a default-deny `resolve_readable` gate on every read primitive, a gated read facade (`kb::access`) that Plan 3 calls instead of raw `kb::read`/`kb::search`, a per-client token store (hash-at-rest, scope, revoke, T10-scrubbed), and a read activity ledger with a bulk-read brake — plus the `008_mcp.sql` migration that backs the token store and ledger.

**Architecture:** A new layer in the existing `kb` module (`src-tauri/src/kb/`) owns three single-responsibility files: `access.rs` (the `resolve_readable` default-deny gate + the gated `list_readable`/`read_note`/`search` facade that wraps Plan 1's `kb::read`/`kb::search` and scrubs snippets), `tokens.rs` (mint/validate/revoke/list against the `mcp_clients` table, hashing the raw token with SHA-256 and registering it with the T10 log-scrubber), and `ledger.rs` (`record_read`/`recent`/`check_read_budget` against the `mcp_activity_ledger` table, with a sliding-window bulk-read `Brake`). The `.kbignore` parsing is a pure sub-module of `access.rs`. The token store and ledger are the first DB tables this feature touches → migration `008_mcp.sql`, registered in `db.rs`. DB-backed logic follows the established `secrets.rs` dependency-injection seam (a `_with_conn(&Connection, …)` core + a thin public wrapper calling `db::connect()`), so every function is unit-testable against an in-memory SQLite connection.

**Tech Stack:** Rust (edition 2021), `rusqlite` 0.32 (existing; `OptionalExtension` upsert pattern), `rusqlite_migration` 1.3 (existing; migration registered in `db.rs`), `rand` 0.8 (promote dev-dep → dependency, for the CSPRNG token), `sha2` 0.10 + `hex` 0.4 (new deps, token hash-at-rest), `chrono` 0.4 (existing, ISO-8601 timestamps), the existing `logging::remember_secret` T10 scrubber, inline `#[cfg(test)]` tests with `tempfile` (dev-dep from Plan 1).

## Global Constraints

- **Default-deny.** `resolve_readable` returns `false` unless a path is affirmatively allowed; the gate sits on **every** read primitive (`list_readable`, `read_note`, `search` indexing + snippets). An excluded note is **absent**, never a distinguishable error — absence is uniform with a non-existent note (`MCP_KB_CONTRACT.md` §7.1).
- **The token is a scope + revocation handle, not authentication.** It is stored server-side **as a SHA-256 hash** (a verifier, not a reproducible secret), is registered with the T10 log-scrubber on **both** mint and validate, and its scope is keyed by the token-hash server-side, never embedded in the token body (`MCP_KB_CONTRACT.md` §6.1 / M3).
- **Read-only.** No file writes anywhere in this plan. The write path is Plan 5 (v1.x), owned by `MCP_KB_CONTRACT.md` §8. `Scope::ReadWrite` is **defined** here (it is a token attribute Plan 4's mint UI exposes) but **no write op consumes it** in this plan.
- **DB access uses the `secrets.rs` injection seam.** Each DB function has a `_with_conn(conn: &Connection, …)` core (unit-tested against an in-memory connection running migration 008) and a thin public wrapper that calls `crate::db::connect()`. This matches `secrets.rs`'s `*_with_store(&dyn CredentialStore, …)` pattern, because `db::connect()` targets the real platform data dir and is not test-isolable.
- **All blocking fs/DB work runs via `spawn_blocking`** through `crate::run_blocking(name, work)` (made `pub(crate)` in Plan 1). This plan exposes **no new Tauri commands** — the gated facade + token + ledger fns are consumed by Plan 3's IPC layer, which wires them into commands. (The only async surface here is internal.)
- **Single crate** `stashpeak` (lib name `stashpeak_lib`); new files go under `src-tauri/src/kb/` and are declared `pub mod …;` in `src-tauri/src/kb/mod.rs`.
- **Commit messages MUST reference the tracking issue `#N`** created in Task 0.1 (the `.githooks/commit-msg` hook rejects commits without `#N`; `docs:`-prefixed commits are exempt). Substitute the real number for `#<ISSUE>` throughout.
- **CI gate (3-OS matrix):** `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` must all pass. Run them before every commit.
- **No new network, IPC, or MCP protocol** in this plan.

---

## File Structure

| File | Responsibility | New/Modify |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | promote `rand` to `[dependencies]`; add `sha2`, `hex` | Modify |
| `src-tauri/src/db.rs` | register `008_mcp.sql` in `migrations()` | Modify |
| `src-tauri/src/migrations/008_mcp.sql` | `mcp_clients` + `mcp_activity_ledger` tables | Create |
| `src-tauri/src/kb/mod.rs` | declare `pub mod access; pub mod tokens; pub mod ledger;` | Modify |
| `src-tauri/src/kb/access.rs` | `.kbignore` parse + default-excluded set + `resolve_readable` + gated `list_readable`/`read_note`/`search` (T10 snippet scrub) | Create |
| `src-tauri/src/kb/tokens.rs` | `Scope`, `TokenInfo`, `mint`/`validate`/`revoke`/`list` (hash-at-rest + `remember_secret`) | Create |
| `src-tauri/src/kb/ledger.rs` | `LedgerRow`, `Brake`, `record_read`/`recent`/`check_read_budget` | Create |

> [!NOTE]
> This plan adds **no `mod` line to `lib.rs`** (the `kb` module is already declared there by Plan 1) and **registers no Tauri commands** (Plan 3 does that). The only `lib.rs`-adjacent dependency is `pub(crate) run_blocking`, already made crate-visible by Plan 1.

---

## Phase 0 — Tracking issue

Plan 1 already performed the `MCP_KB_CONTRACT.md` §17 spec close-out (THREAT_MODEL T13, ARCHITECTURE §8 propagation, EXTENSIONS_SPEC §7 note) in its Phase 0. **Plan 2 does not repeat it.** This phase only creates the tracking issue this plan's commits reference.

### Task 0.1: Create the tracking issue

- [ ] **Step 1: Create the issue and capture its number**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
gh issue create \
  --title "feat(kb): MCP security & audit layer (resolve_readable gate, token store, read ledger)" \
  --label enhancement \
  --body "Implements Plan 2 of the MCP read-first series (docs/superpowers/plans/2026-06-26-mcp-plan2-security-audit.md). Builds the resolve_readable default-deny confidentiality gate (.kbignore + per-folder rule + default-excluded secret set), the gated read facade (list_readable/read_note/search with T10 snippet scrubbing), the per-client token store (hash-at-rest + remember_secret), and the read activity ledger + bulk-read brake, backed by migration 008_mcp.sql. Depends on Plan 1 (#<PLAN1-ISSUE>, PR #213). Out of scope: IPC/shim/MCP protocol (Plan 3), frontend (Plan 4), write path (Plan 5)."
```

Record the printed number as `#<ISSUE>` for every later commit. (Substitute Plan 1's issue for `#<PLAN1-ISSUE>` in the body, or drop that clause if unknown.)

---

## Phase 1 — Branch, dependencies & migration

### Task 1.1: Branch + dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Create the working branch off Plan 1**

Plan 2 depends on Plan 1's `kb` modules. If Plan 1 (PR #213) is **merged to `main`**, branch from `main`. If it is **not yet merged**, branch from Plan 1's branch so the `kb::path`/`read`/`search`/`watch` symbols exist.

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
# Preferred (Plan 1 merged):
git checkout main && git pull
# OR, if Plan 1 is still open:
#   git fetch origin && git checkout feat/kb-foundation-<PLAN1-ISSUE>
git checkout -b feat/kb-security-audit-<ISSUE>
```

- [ ] **Step 2: Promote `rand` and add `sha2` + `hex` to `[dependencies]`**

`rand` currently lives under `[dev-dependencies]` (used by the GCP signer test). The token CSPRNG needs it at runtime, so **move it to `[dependencies]`** (leave it out of `[dev-dependencies]` — a normal dependency is available to tests too). Under `[dependencies]` in `src-tauri/Cargo.toml`, add:

```toml
rand = "0.8"
sha2 = "0.10"
hex = "0.4"
```

Then **remove** the `rand = "0.8"` line from `[dev-dependencies]` (it would otherwise be a duplicate-key error). Leave the `rsa` dev-dep untouched.

- [ ] **Step 3: Verify it builds**

Run: `cd src-tauri && cargo build`
Expected: compiles (new crates downloaded), no errors; the GCP signer test still has `rand` available.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build(kb): promote rand to deps; add sha2, hex for token hashing (refs #<ISSUE>)"
```

### Task 1.2: Migration `008_mcp.sql`

**Files:**
- Create: `src-tauri/src/migrations/008_mcp.sql`
- Modify: `src-tauri/src/db.rs`

**Interfaces:**
- Produces: tables `mcp_clients(id TEXT PK, label TEXT, token_hash TEXT, scope TEXT, created_at TEXT, revoked INTEGER DEFAULT 0)` and `mcp_activity_ledger(id INTEGER PK AUTOINCREMENT, client_label TEXT, tool TEXT, target TEXT, result_count INTEGER, at TEXT)`. Consumed by `kb::tokens` and `kb::ledger`.

- [ ] **Step 1: Write the migration**

Create `src-tauri/src/migrations/008_mcp.sql` (timestamp default mirrors the `001_initial.sql` `strftime` idiom; the **exact** column set is pinned by the cross-plan contract — do not add/rename columns):

```sql
-- ============================================================
-- MCP per-client token store
-- One row per minted client token. The token itself is NEVER stored;
-- only its SHA-256 hash (a verifier). Scope is keyed here server-side,
-- never embedded in the token body. `revoked` is a soft-delete kill switch.
-- (MCP_KB_CONTRACT.md §6 / M3)
-- ============================================================
CREATE TABLE mcp_clients (
    id          TEXT    PRIMARY KEY,             -- opaque client id (UUID-like)
    label       TEXT    NOT NULL,                -- user-authored display label
    token_hash  TEXT    NOT NULL,               -- hex SHA-256 of the raw token
    scope       TEXT    NOT NULL DEFAULT 'read', -- 'read' | 'read_write'
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    revoked     INTEGER NOT NULL DEFAULT 0       -- 1 = revoked (kill switch)
);

-- Validation looks up by token_hash; index it for the per-call hot path.
CREATE INDEX mcp_clients_token_hash ON mcp_clients(token_hash);

-- ============================================================
-- MCP read activity ledger
-- One row per read tool-call. Symmetric to the (future) write ledger.
-- Backs the "what agents read from your KB" panel + the bulk-read brake.
-- (MCP_KB_CONTRACT.md §7.2 / M5)
-- ============================================================
CREATE TABLE mcp_activity_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_label  TEXT    NOT NULL,             -- routing key (the token's label)
    tool          TEXT    NOT NULL,             -- 'kb_list' | 'kb_read_note' | 'kb_search'
    target        TEXT    NOT NULL,             -- canonical path or query
    result_count  INTEGER NOT NULL,            -- note count / hit count
    at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- The bulk-read brake queries recent rows per client by time; index it.
CREATE INDEX mcp_activity_ledger_client_time ON mcp_activity_ledger(client_label, at);
```

- [ ] **Step 2: Register it in `db.rs`**

In `src-tauri/src/db.rs`, append to the `migrations()` `vec!` (after the `007_product_visibility.sql` line):

```rust
        M::up(include_str!("migrations/008_mcp.sql")),
```

- [ ] **Step 3: Write a failing test that the tables exist after migration**

Add an inline test to `db.rs` (it has no `#[cfg(test)]` module yet — create one at the end of the file). It runs the full migration set on an in-memory connection and asserts both tables are queryable. This test also becomes the shared in-memory-DB helper the token/ledger tests reuse, so define it as a `pub(crate)` test helper:

```rust
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
```

> [!NOTE]
> `open_in_memory_migrated()` is the test seam the rest of this plan relies on. The existing codebase has **no** DB-backed tests (settings/providers tests are pure-logic and `db::connect()` targets the real platform data dir), so this helper is the first one. Keeping it `#[cfg(test)] pub(crate)` lets `kb::tokens` and `kb::ledger` tests call `crate::db::open_in_memory_migrated()`.

- [ ] **Step 4: Run, verify it passes** — `cd src-tauri && cargo test db::tests::migration_008` → PASS (the migration runs and both tables exist).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migrations/008_mcp.sql src-tauri/src/db.rs
git commit -m "feat(kb): migration 008 (mcp_clients + mcp_activity_ledger) + in-memory test seam (refs #<ISSUE>)"
```

---

## Phase 2 — `resolve_readable` confidentiality gate

This is the load-bearing confidentiality file. It is **default-deny**: a path is readable only if it survives the `.kbignore` rules, the per-folder "do not expose" rule, and the default-excluded secret set. It is pure filesystem logic (reads `.kbignore` files + inspects path shape), fully unit-testable with `tempfile`.

### Task 2.1: `.kbignore` matching + default-excluded set

**Files:**
- Create/fill: `src-tauri/src/kb/access.rs`
- Modify: `src-tauri/src/kb/mod.rs` (declare `pub mod access;`)
- Test: inline `#[cfg(test)]` in `access.rs`

**Interfaces:**
- Produces (internal):
  - `fn is_default_excluded(canonical: &str) -> bool` — dotfiles, `*.key`, `*.pem`, `*.env`, high-entropy secret-shaped stems.
  - `struct KbIgnore { patterns: Vec<String> }` with `fn load(vault_root: &Path) -> KbIgnore` (parses the vault-root `.kbignore`, ignoring blank/`#` lines) and `fn matches(&self, canonical: &str) -> bool` (glob-ish: `dir/` prefix rule, `*.ext` suffix rule, exact path, and `*` wildcard segment).

- [ ] **Step 1: Declare the module**

In `src-tauri/src/kb/mod.rs`, add alongside the existing `pub mod path; …` declarations:

```rust
pub mod access;
pub mod ledger;
pub mod tokens;
```

(`ledger`/`tokens` files are created in later phases; declaring them now means `cargo build` fails until they exist. Create empty `// placeholder` stub files `src-tauri/src/kb/ledger.rs` and `src-tauri/src/kb/tokens.rs` now so the module tree compiles, and fill them in Phases 3–4. This mirrors Plan 1 Task 2.1 Step 3.)

- [ ] **Step 2: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn default_excludes_secret_shaped_paths() {
        assert!(is_default_excluded(".secret"));            // dotfile
        assert!(is_default_excluded("nested/.env"));        // dot segment anywhere
        assert!(is_default_excluded("creds.key"));          // *.key
        assert!(is_default_excluded("server.pem"));         // *.pem
        assert!(is_default_excluded("config.env"));         // *.env
        assert!(is_default_excluded("a/b/.git/config"));    // dot dir segment

        assert!(!is_default_excluded("notes/todo.md"));     // ordinary note
        assert!(!is_default_excluded("Projects/Q3 plan.md"));
    }

    #[test]
    fn default_excludes_high_entropy_stems() {
        // A long base64/hex-looking filename stem is treated as secret-shaped.
        assert!(is_default_excluded("A1b2C3d4E5f6G7h8I9j0K1l2.md"));
        // A normal word-y stem is not.
        assert!(!is_default_excluded("meeting-notes-2026.md"));
    }

    #[test]
    fn kbignore_parses_and_matches() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join(".kbignore"),
            "# private\nPrivate/\n*.draft.md\nProjects/secret.md\n\nArchive/*\n",
        )
        .unwrap();

        let ig = KbIgnore::load(root);
        assert!(ig.matches("Private/anything.md"));   // dir/ prefix
        assert!(ig.matches("a.draft.md"));            // *.ext suffix
        assert!(ig.matches("Projects/secret.md"));    // exact path
        assert!(ig.matches("Archive/2025.md"));       // single-segment wildcard
        assert!(!ig.matches("Archive/old/2025.md"));  // wildcard is one segment
        assert!(!ig.matches("Projects/public.md"));   // not matched
        assert!(!ig.matches("notes/todo.md"));
    }

    #[test]
    fn kbignore_absent_matches_nothing() {
        let dir = tempdir().unwrap();
        let ig = KbIgnore::load(dir.path());
        assert!(!ig.matches("notes/todo.md"));
    }
}
```

- [ ] **Step 3: Run, verify fail** — `cd src-tauri && cargo test kb::access::tests` → FAIL (`is_default_excluded`/`KbIgnore` not defined).

- [ ] **Step 4: Implement**

```rust
use crate::kb::{read, search, KbError};
use std::path::Path;

const KBIGNORE_FILE: &str = ".kbignore";

/// Filename extensions that are secret-shaped and excluded by default,
/// protecting a brand-new KB before the user configures `.kbignore`.
const SECRET_EXTS: &[&str] = &["key", "pem", "env"];

/// True if any path segment starts with `.` (dotfiles / dot-directories),
/// the file has a secret-shaped extension, or its filename stem looks
/// high-entropy (a secret blob committed as a note).
pub(crate) fn is_default_excluded(canonical: &str) -> bool {
    // Any dot segment anywhere in the path.
    if canonical.split('/').any(|seg| seg.starts_with('.')) {
        return true;
    }
    // Secret-shaped extension on the final segment.
    let last = canonical.rsplit('/').next().unwrap_or(canonical);
    if let Some((stem, ext)) = last.rsplit_once('.') {
        if SECRET_EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
            return true;
        }
        if is_high_entropy_stem(stem) {
            return true;
        }
    }
    false
}

/// Heuristic: a long stem made entirely of base64/hex-class characters with
/// no separators and a mix of upper/lower/digits is treated as secret-shaped.
fn is_high_entropy_stem(stem: &str) -> bool {
    if stem.len() < 20 {
        return false;
    }
    let only_token_chars = stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=');
    if !only_token_chars {
        return false;
    }
    let has_upper = stem.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = stem.chars().any(|c| c.is_ascii_lowercase());
    let has_digit = stem.chars().any(|c| c.is_ascii_digit());
    has_upper && has_lower && has_digit
}

/// Parsed `.kbignore` rules (vault-root file only in v1; per-folder is a §13 seam).
pub(crate) struct KbIgnore {
    patterns: Vec<String>,
}

impl KbIgnore {
    /// Load + parse the vault-root `.kbignore`. A missing file yields an empty
    /// rule set (matches nothing). Blank lines and `#` comments are ignored.
    pub(crate) fn load(vault_root: &Path) -> KbIgnore {
        let raw = std::fs::read_to_string(vault_root.join(KBIGNORE_FILE)).unwrap_or_default();
        let patterns = raw
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(|l| l.to_string())
            .collect();
        KbIgnore { patterns }
    }

    /// True if the canonical path matches any rule. Supported forms:
    /// - `dir/`        → excludes everything under `dir`
    /// - `*.ext`       → excludes any file with that extension
    /// - `prefix/*`    → excludes one segment directly under `prefix`
    /// - exact path    → excludes that one path
    pub(crate) fn matches(&self, canonical: &str) -> bool {
        self.patterns.iter().any(|p| rule_matches(p, canonical))
    }
}

fn rule_matches(rule: &str, canonical: &str) -> bool {
    if let Some(dir) = rule.strip_suffix('/') {
        // `dir/` → anything under that directory.
        return canonical == dir || canonical.starts_with(&format!("{dir}/"));
    }
    if let Some(prefix) = rule.strip_suffix("/*") {
        // `prefix/*` → exactly one segment directly under prefix.
        if let Some(rest) = canonical.strip_prefix(&format!("{prefix}/")) {
            return !rest.contains('/');
        }
        return false;
    }
    if let Some(ext) = rule.strip_prefix("*.") {
        // `*.ext` → suffix match on the dotted extension.
        return canonical.ends_with(&format!(".{ext}"));
    }
    // Exact path.
    canonical == rule
}
```

- [ ] **Step 5: Run, verify pass** — `cd src-tauri && cargo test kb::access::tests` → PASS (all 4).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/kb/mod.rs src-tauri/src/kb/access.rs src-tauri/src/kb/ledger.rs src-tauri/src/kb/tokens.rs
git commit -m "feat(kb): .kbignore parsing + default-excluded secret set (refs #<ISSUE>)"
```

### Task 2.2: `resolve_readable` (the single choke point)

**Files:**
- Modify: `src-tauri/src/kb/access.rs`

**Interfaces:**
- Produces: `pub fn resolve_readable(vault_root: &Path, canonical: &str) -> bool` — DEFAULT-DENY confidentiality gate; `false` if excluded by `.kbignore`, the per-folder rule, or the default-excluded secret set. (Consumed by Plan 3's IPC layer and by the gated facade in Task 2.3.)

> The "per-folder rule" in v1 is realized as a `.kbignore` entry **plus** a folder sentinel: a directory containing a `.kbignore` line `*` (i.e. the whole folder opted out) or a `.nokb` marker file is treated as not-exposed. v1 ships the vault-root `.kbignore`; the per-folder marker is the minimum per-folder lever §7.1 promises, layered behind the same gate.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn resolve_readable_is_default_deny_for_excluded_paths() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".kbignore"), "Private/\n*.draft.md\n").unwrap();

    // Excluded by .kbignore.
    assert!(!resolve_readable(root, "Private/x.md"));
    assert!(!resolve_readable(root, "a.draft.md"));
    // Excluded by the default secret set.
    assert!(!resolve_readable(root, ".secret.md"));
    assert!(!resolve_readable(root, "creds.key"));
    // Allowed: an ordinary note not matched by any rule.
    assert!(resolve_readable(root, "notes/todo.md"));
}

#[test]
fn resolve_readable_honors_per_folder_nokb_marker() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("Secrets")).unwrap();
    fs::write(root.join("Secrets/.nokb"), "").unwrap();

    assert!(!resolve_readable(root, "Secrets/plan.md"));
    assert!(resolve_readable(root, "Public/plan.md"));
}

#[test]
fn resolve_readable_rejects_malformed_paths() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    // A path that escapes / is absolute can never be readable.
    assert!(!resolve_readable(root, "../escape.md"));
    assert!(!resolve_readable(root, "/etc/passwd"));
    assert!(!resolve_readable(root, ""));
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test kb::access::tests::resolve_readable` → FAIL.

- [ ] **Step 3: Implement**

```rust
const NOKB_MARKER: &str = ".nokb";

/// DEFAULT-DENY confidentiality gate on every read primitive
/// (MCP_KB_CONTRACT.md §7.1). A path is readable only if it:
/// 1. survives `path::to_os_path` containment (no traversal/absolute), AND
/// 2. is not in the default-excluded secret set, AND
/// 3. is not matched by `.kbignore`, AND
/// 4. is not under a folder bearing a `.nokb` marker.
/// Any failure → `false` (deny). Absence is uniform with non-existence.
pub fn resolve_readable(vault_root: &Path, canonical: &str) -> bool {
    // (1) Must be a valid, contained canonical path. Reuses Plan 1's gate.
    if crate::kb::path::to_os_path(vault_root, canonical).is_err() {
        return false;
    }
    // (2) Default-excluded secret set.
    if is_default_excluded(canonical) {
        return false;
    }
    // (3) `.kbignore`.
    if KbIgnore::load(vault_root).matches(canonical) {
        return false;
    }
    // (4) Per-folder `.nokb` opt-out on any ancestor directory.
    if any_ancestor_has_nokb(vault_root, canonical) {
        return false;
    }
    true
}

/// True if any ancestor directory of `canonical` (within the vault) contains
/// a `.nokb` marker file.
fn any_ancestor_has_nokb(vault_root: &Path, canonical: &str) -> bool {
    let mut dir = vault_root.to_path_buf();
    let segments: Vec<&str> = canonical.split('/').collect();
    // Walk the directory chain, excluding the final (file) segment.
    for seg in &segments[..segments.len().saturating_sub(1)] {
        dir.push(seg);
        if dir.join(NOKB_MARKER).exists() {
            return true;
        }
    }
    false
}
```

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test kb::access::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/access.rs
git commit -m "feat(kb): resolve_readable default-deny gate (.kbignore + per-folder + secret set) (refs #<ISSUE>)"
```

### Task 2.3: The gated read facade (`list_readable`/`read_note`/`search` + snippet scrub)

**Files:**
- Modify: `src-tauri/src/kb/access.rs`

**Interfaces:**
- Consumes: `kb::read::{list, read_note}`, `kb::search::{search, SearchHit}`, `resolve_readable`, `crate::logging` (T10 scrubber via `remember_secret` is for tokens; the snippet scrub reuses the same `scrub_text` path — see implementation note).
- Produces (the facade Plan 3 calls INSTEAD of raw `kb::read`/`kb::search`):
  - `pub fn list_readable(vault_root: &Path) -> Result<Vec<String>, KbError>` — `kb::read::list` filtered through `resolve_readable`.
  - `pub fn read_note(vault_root: &Path, canonical: &str) -> Result<String, KbError>` — denies excluded paths with `KbError::PathRejected` (indistinguishable from not-found; never leaks).
  - `pub fn search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError>` — searches only readable notes and **scrubs each snippet** through the T10 secret-scrubber before returning.

> [!IMPORTANT]
> The T10 scrubber's `scrub_text` is **private** to `logging.rs` today (the only public entry point is `remember_secret`). To scrub snippets, expose a `pub fn scrub_snippet(s: &str) -> String` in `logging.rs` that calls the existing private `scrub_text` (the regex pipeline: api-key, bearer, `KEY/TOKEN/SECRET/PASSWORD=…` env-value, and registered known-secrets). This is a one-line public wrapper — do **not** duplicate the regex logic. Add it next to `remember_secret`.

- [ ] **Step 1: Add the public scrubber wrapper to `logging.rs`**

In `src-tauri/src/logging.rs`, directly after `pub fn remember_secret`, add:

```rust
/// Public entry point for scrubbing a short, user-facing string (e.g. a KB
/// search snippet) through the same secret-redaction pipeline the log layer
/// uses. Reuses `scrub_text` so the redaction rules never diverge.
/// (MCP_KB_CONTRACT.md §7.1 — search snippets must not leak embedded secrets.)
pub fn scrub_snippet(s: &str) -> String {
    scrub_text(s)
}
```

- [ ] **Step 2: Write the failing tests (in `access.rs`)**

```rust
#[test]
fn list_readable_filters_excluded_notes() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".kbignore"), "Private/\n").unwrap();
    fs::create_dir_all(root.join("Private")).unwrap();
    fs::write(root.join("Private/secret.md"), "x").unwrap();
    fs::write(root.join("public.md"), "y").unwrap();

    let listed = list_readable(root).unwrap();
    assert_eq!(listed, vec!["public.md".to_string()]);
}

#[test]
fn read_note_denies_excluded_path_uniformly() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".kbignore"), "Private/\n").unwrap();
    fs::create_dir_all(root.join("Private")).unwrap();
    fs::write(root.join("Private/secret.md"), "TOP SECRET").unwrap();

    // The note physically exists but the gate denies it → PathRejected,
    // indistinguishable from a non-existent note. The body never leaks.
    let err = read_note(root, "Private/secret.md").unwrap_err();
    assert!(matches!(err, KbError::PathRejected(_)));
}

#[test]
fn search_skips_excluded_notes_and_scrubs_snippets() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".kbignore"), "Private/\n").unwrap();
    fs::create_dir_all(root.join("Private")).unwrap();
    // An excluded note containing the query must never surface.
    fs::write(root.join("Private/leak.md"), "alpha alpha alpha").unwrap();
    // An exposed note whose snippet contains a secret must be scrubbed.
    fs::write(root.join("ok.md"), "alpha OPENAI_API_KEY=sk-live-12345").unwrap();

    let hits = search(root, "alpha", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "ok.md");
    assert!(!hits[0].snippet.contains("sk-live-12345")); // T10-scrubbed
    assert!(hits[0].snippet.contains("[REDACTED]"));
}
```

- [ ] **Step 3: Run, verify fail** — `cd src-tauri && cargo test kb::access::tests` → FAIL (`list_readable`/`read_note`/`search` not defined).

- [ ] **Step 4: Implement (append to `access.rs`)**

```rust
/// Gated `list`: Plan 1's recursive list, filtered through `resolve_readable`.
/// An excluded note is simply absent (default-deny, uniform with non-existence).
pub fn list_readable(vault_root: &Path) -> Result<Vec<String>, KbError> {
    let all = read::list(vault_root)?;
    Ok(all
        .into_iter()
        .filter(|c| resolve_readable(vault_root, c))
        .collect())
}

/// Gated `read_note`: denies excluded paths with `PathRejected` *before*
/// touching the file, so an excluded note is indistinguishable from a
/// non-existent one and its bytes never leave the server.
pub fn read_note(vault_root: &Path, canonical: &str) -> Result<String, KbError> {
    if !resolve_readable(vault_root, canonical) {
        return Err(KbError::PathRejected(canonical.to_string()));
    }
    read::read_note(vault_root, canonical)
}

/// Gated `search`: runs Plan 1's search, then drops hits whose path is not
/// readable and scrubs every surviving snippet through the T10 scrubber.
/// (MCP_KB_CONTRACT.md §7.1 — no excluded note contributes a hit; no snippet
/// leaks an embedded secret.)
pub fn search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError> {
    // Over-fetch is unnecessary: filter first, then truncate to `limit`.
    let raw = search::search(vault_root, query, usize::MAX)?;
    let mut out: Vec<SearchHit> = raw
        .into_iter()
        .filter(|hit| resolve_readable(vault_root, &hit.path))
        .map(|mut hit| {
            hit.snippet = crate::logging::scrub_snippet(&hit.snippet);
            hit
        })
        .collect();
    out.truncate(limit);
    Ok(out)
}
```

> [!NOTE]
> `search::search(.., usize::MAX)` then post-filter is correct (not wasteful at KB scale) because `resolve_readable` must run **after** ranking to avoid leaking the existence of excluded notes via a short result list. If profiling ever shows this matters, push `resolve_readable` into `search::search`'s `read::list` step behind the same gate — the interface is unchanged. `SearchHit` is `read`/`write` on its fields (Plan 1 made them `pub`), so the in-place `hit.snippet = …` mutation compiles.

- [ ] **Step 5: Run, verify pass** — `cd src-tauri && cargo test kb::access::tests` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/kb/access.rs src-tauri/src/logging.rs
git commit -m "feat(kb): gated read facade (list_readable/read_note/search) with T10 snippet scrub (refs #<ISSUE>)"
```

---

## Phase 3 — Per-client token store

The token store backs `mcp_clients`. The raw `spk_mcp_` token is shown **once** at mint and never stored — only its SHA-256 hash. Every raw token is registered with the T10 log-scrubber on mint and validate. DB logic uses the `secrets.rs` injection seam (`_with_conn` core + thin public wrapper).

### Task 3.1: `Scope`, `TokenInfo`, and token generation

**Files:**
- Create/fill: `src-tauri/src/kb/tokens.rs` (replace the Phase-2 stub)
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `pub enum Scope { Read, ReadWrite }` (serde, `rename_all = "snake_case"` → `"read"`/`"read_write"`, matching the migration default `'read'`), with `as_str`/`parse` round-tripping the DB string.
  - `pub struct TokenInfo { pub id: String, pub label: String, pub scope: Scope, pub created_at: String }` (serde).
  - internal `fn generate_raw() -> String` (`spk_mcp_` + 32 hex-ish CSPRNG bytes = ≥128-bit) and `fn hash_token(raw: &str) -> String` (hex SHA-256).

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

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
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test kb::tokens::tests` → FAIL.

- [ ] **Step 3: Implement (replace the stub `tokens.rs`)**

```rust
use crate::db;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const TOKEN_PREFIX: &str = "spk_mcp_";
const TOKEN_BYTES: usize = 32; // 256 bits of CSPRNG entropy (>= the 128-bit floor)

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")] // repo convention: every Tauri-returned struct is camelCase; the frontend (Plan 4) reads `createdAt`
pub struct TokenInfo {
    pub id: String,
    pub label: String,
    pub scope: Scope,
    pub created_at: String,
}

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
```

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test kb::tokens::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/tokens.rs
git commit -m "feat(kb): token Scope/TokenInfo + CSPRNG generation + SHA-256 hash (refs #<ISSUE>)"
```

### Task 3.2: `mint` / `validate` / `revoke` / `list`

**Files:**
- Modify: `src-tauri/src/kb/tokens.rs`
- Test: inline `#[cfg(test)]` (uses `db::open_in_memory_migrated()`)

**Interfaces:**
- Produces:
  - `pub fn mint(label: String, scope: Scope) -> Result<String, String>` — inserts a row, returns the **raw** `spk_mcp_…` token ONCE, stores only its hash, and calls `logging::remember_secret(raw)`.
  - `pub fn validate(raw: &str) -> Result<Option<TokenInfo>, String>` — hashes + looks up a non-revoked row, returns its `TokenInfo` (or `None`), and `remember_secret`s the raw.
  - `pub fn revoke(id: &str) -> Result<(), String>` — soft-deletes (`revoked = 1`).
  - `pub fn list() -> Result<Vec<TokenInfo>, String>` — non-revoked clients, newest first.
- Each public fn is a thin wrapper over a `_with_conn(conn, …)` core (the `secrets.rs` seam) so the logic is unit-testable on an in-memory DB.

- [ ] **Step 1: Write the failing tests**

```rust
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
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test kb::tokens::tests` → FAIL.

- [ ] **Step 3: Implement (append to `tokens.rs`)**

```rust
// ---- public wrappers (call the real DB) -----------------------------------

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

// ---- injection-seam cores (unit-tested on an in-memory connection) --------

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
    conn.execute(
        "UPDATE mcp_clients SET revoked = 1 WHERE id = ?1",
        [id],
    )
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
```

> [!NOTE]
> `validate` resolves scope **per call** by hashing the raw token and reading the current row — so a `revoke` (Task 3.2) or a future scope downgrade takes effect immediately, satisfying the §6.3 "scope is re-read per call" requirement. There is no shim-side cache.

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test kb::tokens::tests` → PASS (all 7 in this module).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/tokens.rs
git commit -m "feat(kb): token mint/validate/revoke/list (hash-at-rest, T10 remember, per-call scope) (refs #<ISSUE>)"
```

---

## Phase 4 — Read activity ledger + bulk-read brake

The ledger backs `mcp_activity_ledger`. Every read tool-call records a row; the bulk-read brake reads the recent window per client and returns a `Brake` decision. Same `_with_conn` injection seam.

### Task 4.1: `LedgerRow`, `Brake`, and `record_read`

**Files:**
- Create/fill: `src-tauri/src/kb/ledger.rs` (replace the Phase-2 stub)
- Test: inline `#[cfg(test)]` (uses `db::open_in_memory_migrated()`)

**Interfaces:**
- Produces:
  - `pub enum Brake { Allow, Notice, Pause }` (serde).
  - `pub struct LedgerRow { pub client_label: String, pub tool: String, pub target: String, pub result_count: usize, pub at: String }` (serde).
  - `pub fn record_read(client_label: &str, tool: &str, target: &str, result_count: usize) -> Result<(), String>` — inserts one ledger row.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn record_read_inserts_a_row() {
        let conn = db::open_in_memory_migrated();
        record_read_with_conn(&conn, "Claude Desktop", "kb_search", "alpha", 3).unwrap();

        let (label, tool, target, count): (String, String, String, i64) = conn
            .query_row(
                "SELECT client_label, tool, target, result_count FROM mcp_activity_ledger",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(label, "Claude Desktop");
        assert_eq!(tool, "kb_search");
        assert_eq!(target, "alpha");
        assert_eq!(count, 3);
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test kb::ledger::tests` → FAIL.

- [ ] **Step 3: Implement (replace the stub `ledger.rs`)**

```rust
use crate::db;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// The bulk-read brake decision returned by `check_read_budget`.
/// `Notice` = a non-dismissable warning (N reads in T seconds);
/// `Pause`  = a hard cap requiring re-confirmation (MCP_KB_CONTRACT.md §7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Brake {
    Allow,
    Notice,
    Pause,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")] // repo convention: camelCase to the frontend; Plan 4 reads `clientLabel` / `resultCount`
pub struct LedgerRow {
    pub client_label: String,
    pub tool: String,
    pub target: String,
    pub result_count: usize,
    pub at: String,
}

// ---- public wrappers ------------------------------------------------------

pub fn record_read(
    client_label: &str,
    tool: &str,
    target: &str,
    result_count: usize,
) -> Result<(), String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    record_read_with_conn(&conn, client_label, tool, target, result_count)
}

// ---- injection-seam core --------------------------------------------------

fn record_read_with_conn(
    conn: &Connection,
    client_label: &str,
    tool: &str,
    target: &str,
    result_count: usize,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mcp_activity_ledger (client_label, tool, target, result_count)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![client_label, tool, target, result_count as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test kb::ledger::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/ledger.rs
git commit -m "feat(kb): ledger LedgerRow/Brake + record_read (refs #<ISSUE>)"
```

### Task 4.2: `recent` + `check_read_budget` (the bulk-read brake)

**Files:**
- Modify: `src-tauri/src/kb/ledger.rs`

**Interfaces:**
- Produces:
  - `pub fn recent(limit: usize) -> Result<Vec<LedgerRow>, String>` — the most recent ledger rows, newest first (backs Plan 4's "what agents read" panel).
  - `pub fn check_read_budget(client_label: &str) -> Result<Brake, String>` — counts a client's reads in the recent sliding window and returns `Allow` / `Notice` (≥ `NOTICE_THRESHOLD` reads in `WINDOW_SECS`) / `Pause` (≥ `PAUSE_THRESHOLD`).

> Thresholds are constants here (a single tuning point): `WINDOW_SECS = 60`, `NOTICE_THRESHOLD = 30`, `PAUSE_THRESHOLD = 100`. The brake is **advisory state** the IPC layer (Plan 3) acts on; this plan only computes it.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn recent_returns_rows_newest_first() {
    let conn = db::open_in_memory_migrated();
    record_read_with_conn(&conn, "A", "kb_list", "-", 5).unwrap();
    record_read_with_conn(&conn, "A", "kb_read_note", "notes/x.md", 1).unwrap();

    let rows = recent_with_conn(&conn, 10).unwrap();
    assert_eq!(rows.len(), 2);
    // Newest (the read_note) first.
    assert_eq!(rows[0].tool, "kb_read_note");
    assert_eq!(rows[1].tool, "kb_list");
}

#[test]
fn check_read_budget_escalates_allow_notice_pause() {
    let conn = db::open_in_memory_migrated();

    // Below the notice threshold → Allow.
    for _ in 0..(NOTICE_THRESHOLD - 1) {
        record_read_with_conn(&conn, "Bulk", "kb_read_note", "n.md", 1).unwrap();
    }
    assert_eq!(check_read_budget_with_conn(&conn, "Bulk").unwrap(), Brake::Allow);

    // Cross the notice threshold → Notice.
    record_read_with_conn(&conn, "Bulk", "kb_read_note", "n.md", 1).unwrap();
    assert_eq!(check_read_budget_with_conn(&conn, "Bulk").unwrap(), Brake::Notice);

    // Cross the pause threshold → Pause.
    for _ in 0..(PAUSE_THRESHOLD - NOTICE_THRESHOLD) {
        record_read_with_conn(&conn, "Bulk", "kb_read_note", "n.md", 1).unwrap();
    }
    assert_eq!(check_read_budget_with_conn(&conn, "Bulk").unwrap(), Brake::Pause);

    // A different client is unaffected (per-client budget).
    assert_eq!(check_read_budget_with_conn(&conn, "Quiet").unwrap(), Brake::Allow);
}
```

- [ ] **Step 2: Run, verify fail** — `cd src-tauri && cargo test kb::ledger::tests` → FAIL.

- [ ] **Step 3: Implement (append to `ledger.rs`)**

```rust
/// Bulk-read brake tuning (a single point of truth). A sliding window of
/// `WINDOW_SECS` seconds; `NOTICE_THRESHOLD` reads raises a non-dismissable
/// notice; `PAUSE_THRESHOLD` reads pauses the client pending re-confirmation.
const WINDOW_SECS: i64 = 60;
const NOTICE_THRESHOLD: i64 = 30;
const PAUSE_THRESHOLD: i64 = 100;

// ---- public wrappers ------------------------------------------------------

pub fn recent(limit: usize) -> Result<Vec<LedgerRow>, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    recent_with_conn(&conn, limit)
}

pub fn check_read_budget(client_label: &str) -> Result<Brake, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    check_read_budget_with_conn(&conn, client_label)
}

// ---- injection-seam cores -------------------------------------------------

fn recent_with_conn(conn: &Connection, limit: usize) -> Result<Vec<LedgerRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT client_label, tool, target, result_count, at
             FROM mcp_activity_ledger ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |row| {
            Ok(LedgerRow {
                client_label: row.get(0)?,
                tool: row.get(1)?,
                target: row.get(2)?,
                result_count: row.get::<_, i64>(3)? as usize,
                at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Count a client's reads within the recent window and map the count to a
/// `Brake`. The window is expressed against SQLite's own clock so the test's
/// just-inserted rows (default `at = now`) all fall inside it.
fn check_read_budget_with_conn(conn: &Connection, client_label: &str) -> Result<Brake, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mcp_activity_ledger
             WHERE client_label = ?1
               AND at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?2)",
            rusqlite::params![client_label, format!("-{WINDOW_SECS} seconds")],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(if count >= PAUSE_THRESHOLD {
        Brake::Pause
    } else if count >= NOTICE_THRESHOLD {
        Brake::Notice
    } else {
        Brake::Allow
    })
}
```

> [!NOTE]
> The window query uses SQLite's `strftime(… 'now', '-N seconds')` against the same `at` column the rows default to, so it is timezone-consistent and needs no Rust-side clock. The thresholds are inclusive (`>=`) to match the test's exact-threshold assertions.

- [ ] **Step 4: Run, verify pass** — `cd src-tauri && cargo test kb::ledger::tests` → PASS.

- [ ] **Step 5: Full gate + commit**

Run:
```bash
cd src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```
Expected: fmt clean, clippy clean, all tests PASS (db migration, access gate, token store, ledger).

```bash
git add src-tauri/src/kb/ledger.rs
git commit -m "feat(kb): ledger recent + check_read_budget bulk-read brake (refs #<ISSUE>)"
```

---

## Phase 5 — PR

### Task 5.1: Open the PR

- [ ] **Step 1: Final whole-workspace verification**

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```
All three must be clean before pushing.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/kb-security-audit-<ISSUE>
gh pr create --base main \
  --title "feat(kb): MCP security & audit layer (resolve_readable gate, token store, read ledger)" \
  --body-file <PR body with ## Test plan + Closes #<ISSUE>>
```

PR body must include `Closes #<ISSUE>` and a `## Test plan` section (the CI `validate-pr-body` gate requires both). The Test plan lists: the migration-008 table test; the `.kbignore`/default-excluded/`resolve_readable`/per-folder `.nokb` tests; the gated-facade tests (excluded-note absence + uniform-deny + snippet scrub); the token mint/validate/revoke/list tests (hash-at-rest verified); the ledger record/recent/budget-escalation tests. Note that **no new Tauri command** is added (Plan 3 wires these into commands) and **no write path** is touched.

- [ ] **Step 3: Address CodeRabbit autonomously** (fix + reply + resolve thread; do **not** trigger Codex — usage-limit standing instruction). Then hand to the founder to merge.

---

## Self-Review (completed by the plan author)

- **Contract coverage (Plan 2 PRODUCES, per the pinned cross-plan interface):**
  - `kb::access::resolve_readable(vault_root, canonical) -> bool` ✓ (2.2) — default-deny via `.kbignore` (2.1) + per-folder `.nokb` (2.2) + default-excluded secret set (2.1).
  - gated facade `kb::access::{ list_readable, read_note, search }` ✓ (2.3) — each applies `resolve_readable` (excluded = absent / `PathRejected`, never leaks); `search` scrubs each snippet through T10 (`logging::scrub_snippet`) ✓.
  - `kb::tokens::{ Scope, TokenInfo, mint, validate, revoke, list }` ✓ (3.1/3.2) — raw `spk_mcp_` ≥128-bit token returned ONCE, only its SHA-256 hash stored, `remember_secret` on mint **and** validate, scope keyed server-side, per-call scope resolution ✓.
  - `kb::ledger::{ record_read, recent, check_read_budget, Brake (Allow|Notice|Pause), LedgerRow }` ✓ (4.1/4.2) — bulk-read brake = sliding-window count → Notice/Pause ✓.
  - migration `008_mcp.sql` with the **exact** `mcp_clients` + `mcp_activity_ledger` column sets ✓ (1.2), registered in `db.rs` ✓.
- **Signatures match the contract byte-for-byte:** `resolve_readable(&Path, &str)->bool`; `list_readable(&Path)->Result<Vec<String>,KbError>`; `read_note(&Path,&str)->Result<String,KbError>`; `search(&Path,&str,usize)->Result<Vec<SearchHit>,KbError>`; `mint(String,Scope)->Result<String,String>`; `validate(&str)->Result<Option<TokenInfo>,String>`; `revoke(&str)->Result<(),String>`; `list()->Result<Vec<TokenInfo>,String>`; `record_read(&str,&str,&str,usize)->Result<(),String>`; `recent(usize)->Result<Vec<LedgerRow>,String>`; `check_read_budget(&str)->Result<Brake,String>`. `TokenInfo{id,label,scope,created_at}` and `LedgerRow{client_label,tool,target,result_count,at}` match.
- **Dependency on Plan 1 is explicit and consumed, not redefined:** `kb::path::to_os_path` (resolve_readable containment), `kb::read::{list,read_note}` + `kb::search::{search,SearchHit}` (the facade wraps them), `kb::KbError` (return type), `settings` (untouched here — Plan 3 reads the vault root), `run_blocking` (not used here; this plan adds no command). Header + intro state "Plan 2 of the MCP read-first series" and the Plan 1 dependency.
- **Scope guardrails honored:** no MCP protocol / IPC / shim (Plan 3); no frontend (Plan 4); no write path (Plan 5 — `Scope::ReadWrite` is defined as a token attribute but no write op consumes it; the write-side ledger is the future symmetric half). Read-only throughout.
- **Codebase-fact fidelity:** migration number **008** (007 is the last existing); DB injection seam mirrors `secrets.rs` `*_with_store` because `db::connect()` is not test-isolable and the repo has no DB-backed tests today (the new `db::open_in_memory_migrated()` helper is the seam); `rand` promoted from dev-dep (was dev-only); `sha2`/`hex` added; `logging::scrub_snippet` is a one-line public wrapper over the existing private `scrub_text` (no regex duplication); timestamp defaults use the `strftime('%Y-%m-%dT%H:%M:%SZ','now')` idiom from `001_initial.sql`; commit-msg `#<ISSUE>` discipline; 3-OS CI gate before each commit.
- **Placeholder scan:** the only intentional substitutions are `#<ISSUE>` / `#<PLAN1-ISSUE>` (real numbers from Task 0.1 / Plan 1) and the PR-body file — all explicit. Every code step carries complete, compilable code; no "TBD"/"similar to"/"add handling" placeholders.

---

## Roadmap — the remaining MCP read-first plans

- **Plan 1 — MCP KB foundation (DONE / PR #213):** vault-root config, `kb::path` canonical/containment, `kb::read` list/read, `kb::search`, `kb::watch` folder-watcher + `kb://list_changed`. (This plan depends on it.)
- **Plan 3 — MCP transport:** the app-side local-IPC server (named pipe / unix domain socket, token-authed via `kb::tokens::validate`) that runs the **gated** `kb::access` ops and records `kb::ledger::record_read` + `check_read_budget` per call; the `stashpeak-mcp` shim `[[bin]]` (`rmcp` stdio, `initialize` handshake from an app-supplied manifest, stdout discipline + CI smoke, `kb://vault/` resources + `kb_search`/`kb_read_note`/`kb_list` tools, `notifications/resources/list_changed` from the Plan 1 watcher event); the `mcp_get_enabled`/`mcp_set_enabled` + token/activity Tauri commands. (Depends on Plans 1–2.)
- **Plan 4 — Frontend KB-access settings:** the opt-in "KB access for AI agents" toggle (default OFF, `settings` key `mcp_kb_access_enabled`), the token mint UI (label + `Read`/`Read+Write` `Scope` → raw token shown once + config snippet), token list + revoke, and the read activity-log view. (Depends on Plans 2–3.)
- **Plan 5 (v1.x) — Write path:** the owned write broker + containment algorithm (reject-list + handle-based resolve + reparse rejection + re-validate-after-open + atomic CAS) + `kb_append_note`/`kb_create_note`/`kb_write_note` + the write-side activity ledger (symmetric to this plan's read ledger) + the echo-filter write integration. (`MCP_KB_CONTRACT.md` §8; consumes `Scope::ReadWrite` defined here.)
