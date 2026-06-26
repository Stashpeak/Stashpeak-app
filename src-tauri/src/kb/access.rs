use crate::kb::{read, search, search::SearchHit, KbError};
use std::path::Path;

const KBIGNORE_FILE: &str = ".kbignore";
const NOKB_MARKER: &str = ".nokb";

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

/// DEFAULT-DENY confidentiality gate on every read primitive
/// (MCP_KB_CONTRACT.md §7.1). A path is readable only if it:
/// 1. survives `path::to_os_path` containment (no traversal/absolute), AND
/// 2. is not in the default-excluded secret set, AND
/// 3. is not matched by `.kbignore`, AND
/// 4. is not under a folder bearing a `.nokb` marker.
///
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

/// Gated `list`: Plan 1's recursive list, filtered through `resolve_readable`.
/// An excluded note is simply absent (default-deny, uniform with non-existence).
pub fn list_readable(vault_root: &Path) -> Result<Vec<String>, KbError> {
    let all = read::list(vault_root)?;
    Ok(all
        .into_iter()
        .filter(|c| resolve_readable(vault_root, c))
        .collect())
}

/// Gated `read_note`: denies excluded paths *before* touching the file, so an
/// excluded note is indistinguishable from a non-existent one and its bytes
/// never leave the server. The returned error is **path-free** — it carries a
/// fixed `"not found"` message, never the canonical path — so Plan 3 cannot
/// leak the path (or even its existence) by stringifying the error.
pub fn read_note(vault_root: &Path, canonical: &str) -> Result<String, KbError> {
    if !resolve_readable(vault_root, canonical) {
        // Path-free deny: same shape as a genuine miss. The canonical path
        // stays internal (logging/ledger may keep it); it is never embedded
        // in the returned error.
        return Err(KbError::PathRejected("not found".to_string()));
    }
    read::read_note(vault_root, canonical)
}

/// Gated `search`: gates the **candidate file list up front** — excluded notes
/// are never opened, scanned, or scored — then ranks only the readable notes
/// and scrubs every surviving snippet through the T10 scrubber.
/// (MCP_KB_CONTRACT.md §7.1 — an excluded note contributes nothing: no hit, no
/// influence on ranking, hit-counts, or timing; no snippet leaks an embedded
/// secret.)
pub fn search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError> {
    // Gate BEFORE ranking: build the readable candidate set, then hand only
    // those paths to the scorer. Excluded notes are never read or ranked, so
    // they cannot perturb scores, the hit count, or query timing.
    let candidates: Vec<String> = read::list(vault_root)?
        .into_iter()
        .filter(|c| resolve_readable(vault_root, c))
        .collect();

    // `search::search_in` scores ONLY the supplied candidates (Plan 1's ranker,
    // minus its own `read::list` enumeration). `limit` is applied inside, so no
    // over-fetch is needed now that the input is already gated.
    let raw = search::search_in(vault_root, &candidates, query, limit)?;
    Ok(raw
        .into_iter()
        .map(|mut hit| {
            hit.snippet = crate::logging::scrub_snippet(&hit.snippet);
            hit
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // ── Task 2.1 tests ────────────────────────────────────────────────────────

    #[test]
    fn default_excludes_secret_shaped_paths() {
        assert!(is_default_excluded(".secret")); // dotfile
        assert!(is_default_excluded("nested/.env")); // dot segment anywhere
        assert!(is_default_excluded("creds.key")); // *.key
        assert!(is_default_excluded("server.pem")); // *.pem
        assert!(is_default_excluded("config.env")); // *.env
        assert!(is_default_excluded("a/b/.git/config")); // dot dir segment

        assert!(!is_default_excluded("notes/todo.md")); // ordinary note
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
        assert!(ig.matches("Private/anything.md")); // dir/ prefix
        assert!(ig.matches("a.draft.md")); // *.ext suffix
        assert!(ig.matches("Projects/secret.md")); // exact path
        assert!(ig.matches("Archive/2025.md")); // single-segment wildcard
        assert!(!ig.matches("Archive/old/2025.md")); // wildcard is one segment
        assert!(!ig.matches("Projects/public.md")); // not matched
        assert!(!ig.matches("notes/todo.md"));
    }

    #[test]
    fn kbignore_absent_matches_nothing() {
        let dir = tempdir().unwrap();
        let ig = KbIgnore::load(dir.path());
        assert!(!ig.matches("notes/todo.md"));
    }

    // ── Task 2.2 tests ────────────────────────────────────────────────────────

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

    // ── Task 2.3 tests ────────────────────────────────────────────────────────

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

        // The note physically exists but the gate denies it → a path-free deny,
        // indistinguishable from a non-existent note. The body never leaks, and
        // the returned error must NOT embed the canonical path.
        let err = read_note(root, "Private/secret.md").unwrap_err();
        match err {
            KbError::PathRejected(msg) => {
                // Path-free: the canonical path is absent from the error string.
                assert!(!msg.contains("Private"));
                assert!(!msg.contains("secret.md"));
            }
            other => panic!("expected path-free PathRejected, got {other:?}"),
        }
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
}
