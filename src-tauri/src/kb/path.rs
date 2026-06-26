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
    if abs_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
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
                // Reject `:` for symmetry with to_os_path (drive-prefix safety on Windows; keeps list/read
                // symmetric so list never emits an ID that read_note/search would refuse).
                if s.contains(':') {
                    return Err(reject());
                }
                // Canonical form is NFC (Decision #40). Reject non-NFC on-disk names rather than
                // normalizing them: normalizing would list a name that can't be reopened on byte-exact
                // filesystems. Non-NFC names are outside the canonical surface in v1 (a future resolver
                // mapping NFC->real dir entry could add them).
                if s.nfc().collect::<String>() != s {
                    return Err(reject());
                }
                parts.push(s.to_string());
            }
            // No root/prefix/curdir/parentdir allowed in a relative vault path.
            _ => return Err(reject()),
        }
    }
    Ok(CanonicalPath(parts.join("/")))
}

/// Validate a client-supplied canonical path and resolve it to an absolute
/// path under the vault root. Resolves lexically (no handle re-validation);
/// symlink-escape defense lives in read.rs (Phase 3). The full no-follow /
/// handle-based hardening and the deliberate check-then-open TOCTOU residual
/// are owned by the write broker (MCP_KB_CONTRACT.md §8).
pub fn to_os_path(vault_root: &Path, canonical: &str) -> Result<std::path::PathBuf, KbError> {
    let reject = || KbError::PathRejected(canonical.to_string());

    if canonical.is_empty() {
        return Err(reject());
    }
    // Reject NUL/control bytes, backslashes, Windows drive/UNC/device prefixes.
    if canonical.contains('\u{0000}')
        || canonical.chars().any(|c| c.is_control())
        || canonical.contains('\\')
        || canonical.starts_with('/')
        // Fast-path reject for `X:`-style drive letters (e.g. "C:foo"). The real
        // containment guarantee comes from the per-segment `.`/`..`/empty checks
        // below and joining under the verbatim root — not from this byte check alone.
        || (canonical.len() >= 2 && canonical.as_bytes()[1] == b':')
    {
        return Err(reject());
    }

    // Enforce NFC on ingress: the canonical form is NFC (Decision #40); reject any
    // alternate byte sequence so one note can't be addressed two ways (cache/ledger sanity).
    if canonical.nfc().collect::<String>() != canonical {
        return Err(reject());
    }
    let mut out = vault_root.to_path_buf();
    for seg in canonical.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(':') {
            return Err(reject());
        }
        out.push(seg);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn root() -> &'static Path {
        Path::new("/vault")
    }

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
    fn rejects_non_nfc_os_component() {
        // "é" as NFD (e + combining accent) is not NFC → must be rejected, not normalized.
        // Normalizing would list a name that can't be reopened on byte-exact filesystems.
        assert!(to_canonical(root(), Path::new("/vault/cafe\u{0301}.md")).is_err());
    }

    #[test]
    fn preserves_case() {
        let c = to_canonical(root(), Path::new("/vault/Note.md")).unwrap();
        assert_eq!(c.as_str(), "Note.md");
    }

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

    #[cfg(windows)]
    #[test]
    fn verbatim_windows_root_contains_and_rejects_siblings() {
        use std::path::Path;
        let root = Path::new(r"\\?\C:\vault");
        // production stores the canonicalized (\\?\) root; the real code path must contain correctly
        assert_eq!(
            to_canonical(root, Path::new(r"\\?\C:\vault\notes\a.md"))
                .unwrap()
                .as_str(),
            "notes/a.md"
        );
        // sibling-prefix under the verbatim root must still be rejected (fails closed)
        assert!(to_canonical(root, Path::new(r"\\?\C:\vault-evil\x.md")).is_err());
        // round-trip under the verbatim root is identity
        let p = to_os_path(root, "notes/a.md").unwrap();
        assert_eq!(to_canonical(root, &p).unwrap().as_str(), "notes/a.md");
    }

    #[test]
    fn to_os_path_rejects_non_nfc_and_backslash() {
        // NFD form (e + combining accent) is not NFC → rejected on ingress
        assert!(to_os_path(root(), "cafe\u{0301}.md").is_err());
        // backslash is rejected outright (Windows would treat it as a separator)
        assert!(to_os_path(root(), "a\\b.md").is_err());
    }

    #[test]
    fn to_os_path_rejects_drive_relative_without_separator() {
        assert!(to_os_path(root(), "C:foo").is_err());
    }

    #[test]
    fn to_os_path_rejects_drive_prefix_in_segment() {
        assert!(to_os_path(root(), "notes/C:foo.md").is_err());
        assert!(to_os_path(root(), "a/b/D:evil").is_err());
    }

    #[test]
    fn empty_relative_is_root_and_not_round_trippable() {
        assert_eq!(to_canonical(root(), root()).unwrap().as_str(), "");
        assert!(to_os_path(root(), "").is_err());
    }

    #[test]
    fn to_canonical_rejects_colon_in_component() {
        assert!(to_canonical(root(), Path::new("/vault/notes/a:b.md")).is_err());
    }
}
