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
                parts.push(s.nfc().collect::<String>());
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
        || canonical.starts_with("//")
        || (canonical.len() >= 2 && canonical.as_bytes()[1] == b':')
    // drive letter
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
        if seg.is_empty() || seg == "." || seg == ".." {
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
}
