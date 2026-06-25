# MCP KB Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan 1 of the MCP read-first series.** This plan builds the shared on-disk KB foundation. It contains **no MCP protocol, IPC, tokens, or write path** — those are Plans 2–4 (see `docs/MCP_KB_CONTRACT.md` §2 and the roadmap at the bottom of this file). Everything here is also a prerequisite for `SYNC_ENGINE.md`.

**Goal:** Build the on-disk KB foundation — vault-root config, a pure canonical-path module, a read-only KB read/search layer, and a folder-watcher — that the MCP read server (Plans 2–3) and the future sync engine both build on; and flip `MCP_KB_CONTRACT.md` to in-implementation via its §17 doc close-out.

**Architecture:** A new `kb` module (`src-tauri/src/kb/`) owns four small, single-responsibility files: `path.rs` (the pure canonical-path + containment logic, mirroring `SYNC_ENGINE.md` §6.1 — NFC, forward-slash, vault-relative), `read.rs` (list + read markdown through `path.rs`), `search.rs` (a simple ranked content search), and `watch.rs` (a `notify` folder-watcher with a self-write echo-filter). Vault-root config rides the existing `settings` key-value table. All file access is read-only and routes through `path.rs` containment.

**Tech Stack:** Rust (edition 2021), Tauri 2 commands (`async` + `spawn_blocking` via the existing `run_blocking` helper), `notify` (new dep), `unicode-normalization` (new dep, NFC), `rusqlite` (existing, settings), inline `#[cfg(test)]` tests with `tempfile` (new dev-dep).

## Global Constraints

- **Canonical path form** = vault-relative, `/`-separated, **no leading slash**, **NFC**-normalized Unicode (verbatim from `SYNC_ENGINE.md` §6.1 / Decision #40). OS-native ⇄ canonical conversion happens **only** at the filesystem boundary (`path.rs`).
- **Read-only.** No file writes anywhere in this plan. The write path is Plan 5 (v1.x) and is owned by `MCP_KB_CONTRACT.md` §8.
- **All blocking fs/DB work runs via `spawn_blocking`** (use the existing `run_blocking(name, work)` helper in `src-tauri/src/lib.rs`); Tauri commands return `Result<T, String>`.
- **Single crate** `stashpeak` (lib name `stashpeak_lib`); the `kb` module is added under `src-tauri/src/` and declared `mod kb;` in `lib.rs`.
- **Commit messages MUST reference the tracking issue `#N`** created in Task 0.1 (the `.githooks/commit-msg` hook rejects commits without `#N`; `docs:`-prefixed commits are exempt). Substitute the real number for `#<ISSUE>` throughout.
- **CI gate (3-OS matrix):** `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` must all pass. Run them before every commit.
- **No new secrets, tokens, network, or IPC** in this plan.

---

## File Structure

| File | Responsibility | New/Modify |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | add `notify`, `unicode-normalization`; add `tempfile` dev-dep | Modify |
| `src-tauri/src/lib.rs` | `mod kb;`; register new Tauri commands | Modify |
| `src-tauri/src/settings.rs` | `get_vault_root` / `set_vault_root` | Modify |
| `src-tauri/src/kb/mod.rs` | module root; re-exports; shared `KbError` | Create |
| `src-tauri/src/kb/path.rs` | canonical-path + containment (pure, the security crux) | Create |
| `src-tauri/src/kb/read.rs` | list + read markdown notes | Create |
| `src-tauri/src/kb/search.rs` | ranked content search + snippet | Create |
| `src-tauri/src/kb/watch.rs` | `notify` folder-watcher + echo-filter | Create |
| `src-tauri/src/kb/commands.rs` | Tauri commands (`kb_get_vault_root`, `kb_set_vault_root`, `kb_list`, `kb_read_note`, `kb_search`) | Create |
| `internal-docs/stashpeak-app/THREAT_MODEL.md` | add row **T13** (Phase 0) | Modify |
| `internal-docs/stashpeak-app/ARCHITECTURE.md` | propagate M1–M10 into §8 (Phase 0) | Modify |
| `docs/EXTENSIONS_SPEC.md` | §7/§13 storage-broker note (Phase 0) | Modify |

---

## Phase 0 — Spec close-out (flips `MCP_KB_CONTRACT.md` to in-implementation)

This is the `MCP_KB_CONTRACT.md` §17 close-out: the canonical decision logs must agree with the merged spec before code starts. Mirrors the `SYNC_ENGINE.md` §14 reconcile (committed as `0a0f4b6`). `internal-docs` commits go **direct to `main`** (it has no PR gate); the `EXTENSIONS_SPEC.md` edit is a `stashpeak-app` PR.

### Task 0.1: Create the tracking issue

- [ ] **Step 1: Create the issue and capture its number**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
gh issue create \
  --title "feat(kb): KB foundation (vault root, canonical path, read/search, watcher)" \
  --label enhancement \
  --body "Implements Plan 1 of the MCP read-first series (docs/superpowers/plans/2026-06-25-mcp-kb-foundation.md). Shared prerequisite for the MCP server (docs/MCP_KB_CONTRACT.md) and SYNC_ENGINE.md. Read-only; no MCP protocol/IPC/tokens (Plans 2-4)."
```

Record the printed number as `#<ISSUE>` for every later commit.

### Task 0.2: Add THREAT_MODEL row T13

- [ ] **Step 1: Replace the deferred placeholder with the T13 row**

In `internal-docs/stashpeak-app/THREAT_MODEL.md`, replace the existing `> [!TODO] Pending threat row (owned by MCP_KB_CONTRACT.md, Decision #31)` block (after T12) with a full **T13** section:

```markdown
### T13. The local MCP write-server exposed to localhost agents (inverse of T9)

**Applies to:** the local MCP KB server (`MCP_KB_CONTRACT.md`). The *inverse* of T9 — here Stashpeak is the **server** other localhost agents (Claude Desktop, Cursor, Hermes) read/write *through*, not the client.

**Scenario:** a hijacked/malicious localhost process connects to the KB server; or a paired agent is weaponized by untrusted note content; or an attacker-influenced path tries to escape the vault.

**Defense:**
- **Trust boundary = the shim↔app local-IPC hop**, not the MCP session (the shim is untrusted-by-construction; `MCP_KB_CONTRACT.md` §4).
- **Opt-in feature + per-client token grant + default read-only**; the token is a scope/revocation handle, **not** authentication (a same-user process can read it). Security rests on opt-in + grant + the write broker + the activity ledger (§6).
- **Read confidentiality:** a default-deny `resolve_readable` gate on every read primitive + a read ledger + a bulk-read brake (§7).
- **Write containment** (v1.x): an owned reject-list + handle-based resolve + reparse rejection + re-validate-after-open + atomic CAS (§8); recoverable `SYNC_ENGINE` history means no MCP path can hard-delete.

> [!WARNING] Verdict: Acceptable with honest residuals
> **Token theft** from client config / the flat keychain is a documented residual (defense-in-depth only; revocation is the real mitigation). A paired agent's **downstream** use of read content is a **T11-class consented egress**. A fully compromised host (T1) is out of scope.
```

Then add a Decision-log row at the bottom table:

```markdown
| T13: local MCP write-server (inverse of T9); boundary = shim↔app IPC; token = scope/revoke handle; honest residuals (token theft, read-egress = T11-class) | Locked | `MCP_KB_CONTRACT.md` M1–M10 / Decision #31 |
```

- [ ] **Step 2: Commit (internal-docs, direct to main)**

```bash
cd "d:/Coding Projects/Stashpeak/internal-docs"
git add stashpeak-app/THREAT_MODEL.md
git commit -m "docs(threat-model): add T13 (local MCP write-server, inverse of T9)"
git push
```

### Task 0.3: Propagate M1–M10 into ARCHITECTURE §8

- [ ] **Step 1: Append decision rows #44–#53**

In `internal-docs/stashpeak-app/ARCHITECTURE.md` §8 decision table, append condensed rows for M1–M10 (copy the "Decision" cells from `stashpeak-app/docs/MCP_KB_CONTRACT.md` §16, dated `2026-06-25`), and mark Decision #31 **refined** by this spec ("the MCP write path is an owned KB broker, not the §7 Action broker"). Update the trailing note block to reference `MCP_KB_CONTRACT.md` (PR #212) as the source, the same way #33–#43 reference `SYNC_ENGINE.md`. Update the frontmatter `updated:` to `2026-06-25`.

- [ ] **Step 2: Commit (internal-docs, direct to main)**

```bash
cd "d:/Coding Projects/Stashpeak/internal-docs"
git add stashpeak-app/ARCHITECTURE.md
git commit -m "docs(architecture): propagate MCP_KB_CONTRACT M1-M10 into section 8"
git push
```

### Task 0.4: EXTENSIONS_SPEC §7 storage-broker note

- [ ] **Step 1: Add the note**

In `stashpeak-app/docs/EXTENSIONS_SPEC.md` §7 (and the §13 forward-compat checklist box about the storage broker), add one sentence: the KB write broker (`MCP_KB_CONTRACT.md` §8) is the first realization of the long-deferred `file_write` storage broker, and it is **core-owned** (like the `SYNC_ENGINE.md` §6.7 write path), not effects-gated.

- [ ] **Step 2: Commit (on this plan's branch — see Task 1.1)**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
git add docs/EXTENSIONS_SPEC.md
git commit -m "docs(extensions): note KB write broker realizes the deferred storage broker (refs #<ISSUE>)"
```

---

## Phase 1 — Dependencies & vault-root config

### Task 1.1: Branch + dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Create the working branch**

```bash
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
git checkout main && git pull
git checkout -b feat/kb-foundation-<ISSUE>
```

- [ ] **Step 2: Add dependencies to `src-tauri/Cargo.toml`**

Under `[dependencies]`:

```toml
notify = "6"
unicode-normalization = "0.1"
```

Under `[dev-dependencies]` (create the section if absent):

```toml
tempfile = "3"
```

- [ ] **Step 3: Verify it builds**

Run: `cd src-tauri && cargo build`
Expected: compiles (new crates downloaded), no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build(kb): add notify, unicode-normalization, tempfile deps (refs #<ISSUE>)"
```

### Task 1.2: Vault-root setting

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Test: inline `#[cfg(test)]` in `settings.rs`

**Interfaces:**
- Produces: `settings::get_vault_root() -> Result<Option<String>, String>` and `settings::set_vault_root(path: String) -> Result<(), String>` (stored under the `settings` key `"kb_vault_root"`; `None` = not configured).

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)]` module in `settings.rs` (match the existing settings test style — they open a temp DB; reuse whatever helper the existing settings tests use):

```rust
#[test]
fn vault_root_round_trips() {
    // (use the same in-temp-dir DB setup the other settings tests use)
    assert_eq!(get_vault_root().unwrap(), None);
    set_vault_root("C:/Users/me/Vault".into()).unwrap();
    assert_eq!(get_vault_root().unwrap().as_deref(), Some("C:/Users/me/Vault"));
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd src-tauri && cargo test settings::tests::vault_root_round_trips`
Expected: FAIL (`get_vault_root` not found).

- [ ] **Step 3: Implement**

In `settings.rs`, following the existing `get_home_currency`/`set_home_currency` pattern (a `settings` key-value read/write):

```rust
const KEY_VAULT_ROOT: &str = "kb_vault_root";

pub fn get_vault_root() -> Result<Option<String>, String> {
    let conn = crate::db::connect().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [KEY_VAULT_ROOT],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn set_vault_root(path: String) -> Result<(), String> {
    let conn = crate::db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![KEY_VAULT_ROOT, path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
```

(Ensure `use rusqlite::OptionalExtension;` is in scope — match how the existing settings getters handle "row absent".)

- [ ] **Step 4: Run it, verify it passes**

Run: `cd src-tauri && cargo test settings::tests::vault_root_round_trips`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(kb): vault-root setting get/set (refs #<ISSUE>)"
```

---

## Phase 2 — Canonical-path module (the security crux)

This is the load-bearing, pure-logic file. It mirrors `SYNC_ENGINE.md` §6.1 so MCP and sync share one identity form, and it provides the **containment** guarantee every read (and later, write) relies on. No I/O — it operates on strings + a vault-root path, fully unit-testable.

### Task 2.1: Module skeleton + error type

**Files:**
- Create: `src-tauri/src/kb/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod kb;`)

**Interfaces:**
- Produces: `kb::KbError` (a `thiserror`-free plain enum returning `String` via `Display`), re-exports of `path`, `read`, `search`, `watch`.

- [ ] **Step 1: Create `src-tauri/src/kb/mod.rs`**

```rust
//! KB foundation: vault-relative canonical paths, read/search, folder-watch.
//! Read-only in this plan; the write path is owned by MCP_KB_CONTRACT.md §8.

pub mod path;
pub mod read;
pub mod search;
pub mod watch;
pub mod commands;

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
```

- [ ] **Step 2: Declare the module in `lib.rs`**

Add `mod kb;` alongside the other top-level `mod` declarations near the top of `src-tauri/src/lib.rs`.

- [ ] **Step 3: Verify it builds**

Run: `cd src-tauri && cargo build`
Expected: fails to compile because `path`/`read`/`search`/`watch`/`commands` don't exist yet. Create empty stubs (`// placeholder`) for `read.rs`, `search.rs`, `watch.rs`, `commands.rs` with nothing in them, and proceed — `path.rs` is filled next. Re-run `cargo build`; expected: compiles with empty modules.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/kb/ src-tauri/src/lib.rs
git commit -m "feat(kb): module skeleton + KbError (refs #<ISSUE>)"
```

### Task 2.2: `to_canonical` (OS path → canonical string)

**Files:**
- Create/fill: `src-tauri/src/kb/path.rs`
- Test: inline `#[cfg(test)]` in `path.rs`

**Interfaces:**
- Produces:
  - `pub struct CanonicalPath(String);` with `pub fn as_str(&self) -> &str`.
  - `pub fn to_canonical(vault_root: &Path, abs_path: &Path) -> Result<CanonicalPath, KbError>` — strips the vault-root prefix, converts separators to `/`, NFC-normalizes, rejects anything outside the vault.

- [ ] **Step 1: Write the failing tests (the containment matrix)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn root() -> &'static Path { Path::new("/vault") }

    #[test]
    fn strips_root_and_uses_forward_slashes() {
        let c = to_canonical(root(), Path::new("/vault/notes/todo.md")).unwrap();
        assert_eq!(c.as_str(), "notes/todo.md");
    }

    #[test]
    fn rejects_outside_vault() {
        assert!(to_canonical(root(), Path::new("/etc/passwd")).is_err());
        assert!(to_canonical(root(), Path::new("/vault-evil/x.md")).is_err()); // prefix, not parent
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(to_canonical(root(), Path::new("/vault/../etc/passwd")).is_err());
    }

    #[test]
    fn nfc_normalizes() {
        // "é" as NFD (e + combining accent) must canonicalize to NFC single codepoint
        let nfd = "/vault/cafe\u{0301}.md";
        let c = to_canonical(root(), Path::new(nfd)).unwrap();
        assert_eq!(c.as_str(), "caf\u{00e9}.md");
    }

    #[test]
    fn preserves_case() {
        let c = to_canonical(root(), Path::new("/vault/Note.md")).unwrap();
        assert_eq!(c.as_str(), "Note.md");
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cd src-tauri && cargo test kb::path::tests`
Expected: FAIL (`to_canonical` not defined).

- [ ] **Step 3: Implement**

```rust
use crate::kb::KbError;
use std::path::{Component, Path};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalPath(String);

impl CanonicalPath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Convert an absolute OS path into the vault-relative canonical form
/// (NFC, forward-slash, no leading slash). Rejects anything outside `vault_root`.
pub fn to_canonical(vault_root: &Path, abs_path: &Path) -> Result<CanonicalPath, KbError> {
    let reject = || KbError::PathRejected(abs_path.display().to_string());

    // Lexically reject parent-traversal before any prefix logic.
    if abs_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(reject());
    }

    // Containment by component prefix (NOT a string startsWith).
    let rel = abs_path.strip_prefix(vault_root).map_err(|_| reject())?;

    // Build the forward-slash, NFC string from path components only.
    let mut parts: Vec<String> = Vec::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(os) => {
                let s = os.to_str().ok_or_else(reject)?;
                parts.push(s.nfc().collect::<String>());
            }
            // No root/prefix/curdir/parentdir allowed in a relative vault path.
            _ => return Err(reject()),
        }
    }
    Ok(CanonicalPath(parts.join("/")))
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd src-tauri && cargo test kb::path::tests`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/path.rs
git commit -m "feat(kb): to_canonical with containment + NFC (refs #<ISSUE>)"
```

### Task 2.3: `to_os_path` (canonical string → safe absolute OS path)

**Files:**
- Modify: `src-tauri/src/kb/path.rs`

**Interfaces:**
- Produces: `pub fn to_os_path(vault_root: &Path, canonical: &str) -> Result<PathBuf, KbError>` — validates the canonical string (no `..`, no absolute, no drive/UNC, NFC) and joins it under the vault root; this is the gate every read uses to turn a client-supplied path into a real path.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn to_os_path_rejects_traversal_and_absolute() {
    assert!(to_os_path(root(), "../etc/passwd").is_err());
    assert!(to_os_path(root(), "/etc/passwd").is_err());
    assert!(to_os_path(root(), "C:/Windows/system32").is_err());
    assert!(to_os_path(root(), "a/../../b").is_err());
}

#[test]
fn to_os_path_joins_under_root() {
    let p = to_os_path(root(), "notes/todo.md").unwrap();
    assert_eq!(p, Path::new("/vault/notes/todo.md"));
}

#[test]
fn to_os_path_round_trips_with_to_canonical() {
    let p = to_os_path(root(), "notes/todo.md").unwrap();
    assert_eq!(to_canonical(root(), &p).unwrap().as_str(), "notes/todo.md");
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cd src-tauri && cargo test kb::path::tests::to_os_path`
Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
use std::path::PathBuf;

/// Validate a client-supplied canonical path and resolve it to an absolute
/// path under the vault root. Rejects traversal, absolute, drive, and UNC forms.
pub fn to_os_path(vault_root: &Path, canonical: &str) -> Result<PathBuf, KbError> {
    let reject = || KbError::PathRejected(canonical.to_string());

    if canonical.is_empty() {
        return Err(reject());
    }
    // Reject NUL/control bytes, backslashes, Windows drive/UNC/device prefixes.
    if canonical.contains('\u{0000}')
        || canonical.chars().any(|c| c.is_control())
        || canonical.contains('\\')
        || canonical.starts_with('/')
        || canonical.starts_with("//")
        || (canonical.len() >= 2 && canonical.as_bytes()[1] == b':') // drive letter
    {
        return Err(reject());
    }

    let mut out = vault_root.to_path_buf();
    for seg in canonical.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(reject());
        }
        out.push(seg);
    }
    Ok(out)
}
```

> [!NOTE]
> `to_os_path` does **not** follow symlinks or re-validate the opened handle — that hardening (reparse rejection, GetFinalPathNameByHandle, TOCTOU re-check) lives in the **write** path (`MCP_KB_CONTRACT.md` §8, Plan 5). For read-only access it is acceptable to resolve lexically; Plan 2's `resolve_readable` gate adds the confidentiality layer on top. A follow-up note: when the write broker lands, route reads through the same hardened resolver for symlink-escape parity.

- [ ] **Step 4: Run, verify pass**

Run: `cd src-tauri && cargo test kb::path::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/path.rs
git commit -m "feat(kb): to_os_path with lexical containment guard (refs #<ISSUE>)"
```

---

## Phase 3 — Read layer

### Task 3.1: `read_note`

**Files:**
- Create/fill: `src-tauri/src/kb/read.rs`
- Test: inline `#[cfg(test)]` in `read.rs` (uses `tempfile`)

**Interfaces:**
- Consumes: `path::to_os_path`.
- Produces: `pub fn read_note(vault_root: &Path, canonical: &str) -> Result<String, KbError>` — reads a UTF-8 note; rejects non-`.md` and out-of-vault paths.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn reads_a_note_and_rejects_escape() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/todo.md"), "# Hi\nbody").unwrap();

        assert_eq!(read_note(root, "notes/todo.md").unwrap(), "# Hi\nbody");
        assert!(read_note(root, "../escape.md").is_err());
        assert!(read_note(root, "notes/todo.txt").is_err()); // non-markdown
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cd src-tauri && cargo test kb::read::tests`
Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
use crate::kb::{path, KbError};
use std::path::Path;

const MD_EXT: &str = "md";

pub fn read_note(vault_root: &Path, canonical: &str) -> Result<String, KbError> {
    if !canonical.ends_with(&format!(".{MD_EXT}")) {
        return Err(KbError::PathRejected(canonical.to_string()));
    }
    let os = path::to_os_path(vault_root, canonical)?;
    std::fs::read_to_string(&os).map_err(|e| KbError::Io(e.to_string()))
}
```

- [ ] **Step 4: Run, verify pass** — `cargo test kb::read::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/read.rs
git commit -m "feat(kb): read_note (markdown-only, contained) (refs #<ISSUE>)"
```

### Task 3.2: `list`

**Files:**
- Modify: `src-tauri/src/kb/read.rs`

**Interfaces:**
- Produces: `pub fn list(vault_root: &Path) -> Result<Vec<String>, KbError>` — returns the sorted canonical paths of every `.md` file under the vault (recursive), skipping dotfiles/dot-dirs.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn lists_markdown_recursively_sorted_skipping_dotfiles() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("a")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join("z.md"), "z").unwrap();
    std::fs::write(root.join("a/b.md"), "b").unwrap();
    std::fs::write(root.join("note.txt"), "x").unwrap();        // skipped: not md
    std::fs::write(root.join(".git/config"), "x").unwrap();      // skipped: dotdir
    std::fs::write(root.join(".secret.md"), "x").unwrap();       // skipped: dotfile

    assert_eq!(list(root).unwrap(), vec!["a/b.md".to_string(), "z.md".to_string()]);
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test kb::read::tests::lists_markdown` → FAIL.

- [ ] **Step 3: Implement** (manual recursive walk to keep deps minimal; skip any component starting with `.`)

```rust
pub fn list(vault_root: &Path) -> Result<Vec<String>, KbError> {
    let mut out = Vec::new();
    walk(vault_root, vault_root, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(vault_root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), KbError> {
    let entries = std::fs::read_dir(dir).map_err(|e| KbError::Io(e.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|e| KbError::Io(e.to_string()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue; // skip dotfiles + dot-directories
        }
        let p = entry.path();
        if p.is_dir() {
            walk(vault_root, &p, out)?;
        } else if p.extension().and_then(|e| e.to_str()) == Some(MD_EXT) {
            out.push(path::to_canonical(vault_root, &p)?.as_str().to_string());
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run, verify pass** — `cargo test kb::read::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/read.rs
git commit -m "feat(kb): recursive markdown list (dotfile-skipping, sorted) (refs #<ISSUE>)"
```

---

## Phase 4 — Search

### Task 4.1: `search`

**Files:**
- Create/fill: `src-tauri/src/kb/search.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `read::list`, `read::read_note`.
- Produces:
  - `pub struct SearchHit { pub path: String, pub snippet: String, pub score: usize }` (all `Serialize`).
  - `pub fn search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError>` — case-insensitive whole-query substring match; `score` = number of occurrences; `snippet` = the first matching line trimmed to ~200 chars; results sorted by `score` desc then `path` asc, truncated to `limit`.

> YAGNI: v1 is a simple substring scan, not a real index. A tokenized/indexed search is a later optimization; the interface stays the same.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn ranks_by_occurrence_and_snippets_the_first_hit() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("one.md"), "alpha beta\nalpha again").unwrap(); // 2 hits
        fs::write(root.join("two.md"), "beta only").unwrap();               // 0 hits
        fs::write(root.join("three.md"), "ALPHA upper").unwrap();           // 1 hit (case-insensitive)

        let hits = search(root, "alpha", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "one.md");      // highest score first
        assert_eq!(hits[0].score, 2);
        assert!(hits[0].snippet.contains("alpha beta"));
        assert_eq!(hits[1].path, "three.md");
    }

    #[test]
    fn respects_limit() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "x x").unwrap();
        fs::write(root.join("b.md"), "x").unwrap();
        assert_eq!(search(root, "x", 1).unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test kb::search::tests` → FAIL.

- [ ] **Step 3: Implement**

```rust
use crate::kb::{read, KbError};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub snippet: String,
    pub score: usize,
}

const SNIPPET_MAX: usize = 200;

pub fn search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for path in read::list(vault_root)? {
        let body = match read::read_note(vault_root, &path) {
            Ok(b) => b,
            Err(_) => continue, // unreadable note: skip, never fail the whole search
        };
        let hay = body.to_lowercase();
        let score = hay.matches(&needle).count();
        if score == 0 {
            continue;
        }
        let snippet = body
            .lines()
            .find(|l| l.to_lowercase().contains(&needle))
            .unwrap_or("")
            .chars()
            .take(SNIPPET_MAX)
            .collect::<String>();
        hits.push(SearchHit { path, snippet, score });
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.path.cmp(&b.path)));
    hits.truncate(limit);
    Ok(hits)
}
```

- [ ] **Step 4: Run, verify pass** — `cargo test kb::search::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/search.rs
git commit -m "feat(kb): substring search with ranked snippets (refs #<ISSUE>)"
```

---

## Phase 5 — Folder-watcher + echo-filter

### Task 5.1: Content-hash helper + echo-filter

**Files:**
- Create/fill: `src-tauri/src/kb/watch.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `pub fn content_hash(bytes: &[u8]) -> u64` — a fast non-crypto hash (std `DefaultHasher`) used only to recognize self-writes. (Note: `SYNC_ENGINE` will use a real `contentHash`; this is echo-detection only.)
  - `pub struct EchoFilter { /* set of (canonical_path, hash) */ }` with `record(&self, path: &str, hash: u64)` and `is_echo(&self, path: &str, hash: u64) -> bool` (thread-safe via `Mutex`).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_filter_recognizes_self_writes() {
        let f = EchoFilter::new();
        let h = content_hash(b"hello");
        assert!(!f.is_echo("a.md", h));
        f.record("a.md", h);
        assert!(f.is_echo("a.md", h));            // same path+content = our own write
        assert!(!f.is_echo("a.md", content_hash(b"changed"))); // foreign edit
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test kb::watch::tests` → FAIL.

- [ ] **Step 3: Implement**

```rust
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

pub fn content_hash(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

#[derive(Default)]
pub struct EchoFilter {
    seen: Mutex<HashSet<(String, u64)>>,
}

impl EchoFilter {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn record(&self, path: &str, hash: u64) {
        self.seen.lock().unwrap().insert((path.to_string(), hash));
    }
    pub fn is_echo(&self, path: &str, hash: u64) -> bool {
        self.seen.lock().unwrap().contains(&(path.to_string(), hash))
    }
}
```

- [ ] **Step 4: Run, verify pass** — `cargo test kb::watch::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/kb/watch.rs
git commit -m "feat(kb): content-hash + echo-filter for self-write detection (refs #<ISSUE>)"
```

### Task 5.2: `notify` watcher emitting a Tauri event

**Files:**
- Modify: `src-tauri/src/kb/watch.rs`

**Interfaces:**
- Consumes: `notify`, `tauri::AppHandle`, `path::to_canonical`, `EchoFilter`.
- Produces: `pub fn start_watch(app: tauri::AppHandle, vault_root: PathBuf, echo: Arc<EchoFilter>) -> Result<notify::RecommendedWatcher, KbError>` — watches the vault recursively; on a non-echo change, emits a Tauri event `"kb://list_changed"` with the affected canonical path. (This event is what Plan 3 maps to MCP `notifications/resources/list_changed`.)

> [!NOTE]
> A `notify` watcher firing real filesystem events is timing-dependent and not reliably unit-testable cross-platform; verify it by a manual smoke step here and cover the pure logic (`content_hash`, `EchoFilter`) with the unit test above. The event wiring is exercised end-to-end in Plan 3.

- [ ] **Step 1: Implement the watcher**

```rust
use crate::kb::{path, KbError};
use notify::{Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;

pub fn start_watch(
    app: tauri::AppHandle,
    vault_root: PathBuf,
    echo: Arc<EchoFilter>,
) -> Result<notify::RecommendedWatcher, KbError> {
    let root = vault_root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        for p in event.paths {
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(canonical) = path::to_canonical(&root, &p) else { continue };
            // Skip our own writes (Plan 5 write path records into `echo`).
            if let Ok(bytes) = std::fs::read(&p) {
                if echo.is_echo(canonical.as_str(), content_hash(&bytes)) {
                    continue;
                }
            }
            let _ = app.emit("kb://list_changed", canonical.as_str());
        }
    })
    .map_err(|e| KbError::Io(e.to_string()))?;

    watcher
        .watch(&vault_root, RecursiveMode::Recursive)
        .map_err(|e| KbError::Io(e.to_string()))?;
    Ok(watcher)
}
```

- [ ] **Step 2: Build + manual smoke**

Run: `cd src-tauri && cargo build`
Manual smoke (documented in the PR description, not CI): with a configured vault, edit a `.md` file and confirm a `kb://list_changed` event fires once (not twice — the echo-filter is exercised by the Plan 5 write path; for now an external edit always emits).
Expected: builds; manual edit emits the event.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/kb/watch.rs
git commit -m "feat(kb): notify folder-watcher emitting kb://list_changed (refs #<ISSUE>)"
```

---

## Phase 6 — Tauri commands + wiring

### Task 6.1: KB Tauri commands

**Files:**
- Create/fill: `src-tauri/src/kb/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)

**Interfaces:**
- Consumes: `settings::{get_vault_root,set_vault_root}`, `read::{list,read_note}`, `search::search`, the `run_blocking` helper.
- Produces (Tauri commands): `kb_get_vault_root`, `kb_set_vault_root(path)`, `kb_list`, `kb_read_note(canonical)`, `kb_search(query, limit)`. All return `Result<_, String>`, resolve the vault root first, and error with `"vault root is not configured"` if unset.

- [ ] **Step 1: Implement the commands**

```rust
use crate::kb::{read, search, KbError};
use crate::settings;
use std::path::PathBuf;

fn vault_root() -> Result<PathBuf, String> {
    settings::get_vault_root()?
        .map(PathBuf::from)
        .ok_or_else(|| KbError::NoVaultRoot.to_string())
}

#[tauri::command]
pub async fn kb_get_vault_root() -> Result<Option<String>, String> {
    crate::run_blocking("kb_get_vault_root", || settings::get_vault_root()).await
}

#[tauri::command]
pub async fn kb_set_vault_root(path: String) -> Result<(), String> {
    crate::run_blocking("kb_set_vault_root", move || settings::set_vault_root(path)).await
}

#[tauri::command]
pub async fn kb_list() -> Result<Vec<String>, String> {
    crate::run_blocking("kb_list", || {
        let root = vault_root()?;
        read::list(&root).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn kb_read_note(canonical: String) -> Result<String, String> {
    crate::run_blocking("kb_read_note", move || {
        let root = vault_root()?;
        read::read_note(&root, &canonical).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn kb_search(query: String, limit: usize) -> Result<Vec<search::SearchHit>, String> {
    crate::run_blocking("kb_search", move || {
        let root = vault_root()?;
        search::search(&root, &query, limit).map_err(|e| e.to_string())
    })
    .await
}
```

> If `run_blocking` is currently a private fn in `lib.rs`, make it `pub(crate)` so `kb::commands` can call it.

- [ ] **Step 2: Register the commands in `lib.rs`**

Add to the `tauri::generate_handler![...]` list in `src-tauri/src/lib.rs`:

```rust
kb::commands::kb_get_vault_root,
kb::commands::kb_set_vault_root,
kb::commands::kb_list,
kb::commands::kb_read_note,
kb::commands::kb_search,
```

- [ ] **Step 3: Verify build + full test + lints**

Run:
```bash
cd src-tauri
cargo fmt
cargo clippy -- -D warnings
cargo test
```
Expected: fmt clean, clippy clean, all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/kb/commands.rs src-tauri/src/lib.rs
git commit -m "feat(kb): Tauri commands for vault-root/list/read/search (refs #<ISSUE>)"
```

### Task 6.2: Open the PR

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/kb-foundation-<ISSUE>
gh pr create --base main --title "feat(kb): KB foundation (vault root, canonical path, read/search, watcher)" --body-file <PR body with ## Test plan + Closes #<ISSUE>>
```

PR body must include `Closes #<ISSUE>` and a `## Test plan` section (the CI `validate-pr-body` gate requires both). List the unit tests added and the manual watcher smoke.

- [ ] **Step 2: Address CodeRabbit autonomously** (fix + reply + resolve thread; do **not** trigger Codex — usage-limit standing instruction). Then hand to the founder to merge.

---

## Self-Review (completed by the plan author)

- **Spec coverage (MCP_KB_CONTRACT v1.0 read-first, the foundation slice):** vault root ✓ (1.2/6.1); canonical path + containment ✓ (2.2/2.3, mirrors §6.1/Decision #40); read `kb_list`/`kb_read_note` ✓ (3.1/3.2/6.1); `kb_search` ✓ (4.1/6.1); `list_changed` watcher ✓ (5.2, maps to §5.1's `notifications/resources/list_changed`); §17 doc close-out ✓ (Phase 0). **Deferred to later plans (correctly out of this plan's scope):** `resolve_readable`/`.kbignore`/snippet-scrub (Plan 2, §7); tokens (Plan 2, §6); read ledger + bulk-read brake (Plan 2, §7); IPC + shim + MCP protocol + handshake/stdout (Plan 3, §4/§5); frontend (Plan 4); write path (Plan 5, §8).
- **Placeholder scan:** the only intentional substitutions are `#<ISSUE>` (real number from Task 0.1) and the PR-body file — both are explicit, not vague work. No "TBD"/"add error handling"/"similar to" placeholders; every code step carries complete code.
- **Type consistency:** `CanonicalPath::as_str` used consistently; `to_canonical`→`CanonicalPath`, `to_os_path`→`PathBuf`, `read_note`→`String`, `list`→`Vec<String>`, `search`→`Vec<SearchHit>`, `SearchHit{path,snippet,score}` consistent across read/search/commands; `EchoFilter`/`content_hash` consistent across 5.1/5.2.

---

## Roadmap — the remaining MCP read-first plans (to be written next)

- **Plan 2 — MCP security & audit layer:** `resolve_readable` default-deny gate (`.kbignore` + per-folder exposure + default-excluded secret set), routed onto `read::list`/`read_note`/`search`; T10 snippet scrubbing; per-client token store (`mcp_clients` table — hash + scope + label; `remember_secret` on mint/validate); read activity ledger (`mcp_activity_ledger` table) + bulk-read brake. (Depends on this plan.)
- **Plan 3 — MCP transport:** the app-side local-IPC server (named pipe / unix domain socket, token-authed) exposing the read ops + `resolve_readable`; the `stashpeak-mcp` shim `[[bin]]` (`rmcp` stdio, `initialize` handshake from an app-supplied manifest, stdout discipline + CI smoke, `kb://vault/` resources + `kb_search`/`kb_read_note`/`kb_list` tools, `notifications/resources/list_changed` from the watcher event). (Depends on Plans 1–2.)
- **Plan 4 — Frontend KB-access settings:** enable toggle (opt-in, `settings` key), mint/revoke token UI + config-snippet, the read/write activity-log view. (Depends on Plans 2–3.)
- **Plan 5 (v1.x) — Write path:** the owned write broker + containment algorithm (reject-list + handle-based resolve + reparse rejection + re-validate-after-open + atomic CAS) + `kb_append_note`/`kb_create_note`/`kb_write_note` + the echo-filter write integration. (`MCP_KB_CONTRACT.md` §8.)
