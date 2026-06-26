use crate::kb::{path, KbError};
use std::path::Path;

const MD_EXT: &str = "md";

/// Read the UTF-8 contents of a vault note identified by its canonical path.
///
/// Security guarantees:
/// 1. `.md` extension is required (lexical, before any I/O).
/// 2. `path::to_os_path` provides the lexical vault-containment gate (Phase 2).
/// 3. `std::fs::canonicalize` resolves ALL symlinks (including intermediate dirs)
///    and the result is re-asserted to be inside the canonicalized vault root.
///    `Path::starts_with` is component-wise, so a sibling like `<root>-evil`
///    cannot pass as being inside `<root>`.
/// 4. `real.is_file()` rejects directories, FIFOs, sockets, and device nodes —
///    `is_file()` returns true only for regular files.
pub fn read_note(vault_root: &Path, canonical: &str) -> Result<String, KbError> {
    if !canonical.ends_with(&format!(".{MD_EXT}")) {
        return Err(KbError::PathRejected(canonical.to_string()));
    }
    let os = path::to_os_path(vault_root, canonical)?;
    // Symlink-escape defense: resolve ALL symlinks (incl. intermediate dirs) and
    // re-assert vault containment before reading. `Path::starts_with` is component-wise,
    // so a sibling like `<root>-evil` cannot pass as inside `<root>`.
    let real = std::fs::canonicalize(&os).map_err(|e| KbError::Io(e.to_string()))?;
    let real_root = std::fs::canonicalize(vault_root).map_err(|e| KbError::Io(e.to_string()))?;
    if !real.starts_with(&real_root) {
        return Err(KbError::PathRejected(canonical.to_string()));
    }
    // Regular files only: a FIFO/socket/device named `*.md` would block or misbehave under
    // read_to_string. `is_file()` is true ONLY for regular files (false for those + dirs).
    if !real.is_file() {
        return Err(KbError::PathRejected(canonical.to_string()));
    }
    std::fs::read_to_string(&real).map_err(|e| KbError::Io(e.to_string()))
}

/// Return the sorted canonical paths of every `.md` file under `vault_root`
/// (recursive), skipping dotfiles and dot-directories.
///
/// Security guarantees:
/// - Uses `entry.file_type()` which is NO-FOLLOW: it reports the type of the
///   directory entry itself, not the target. Symlink entries are skipped entirely.
/// - Only entries that `is_file()` (regular files) are emitted; FIFOs etc. are
///   excluded.
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
        // Never follow symlinks: a vault-local link could escape the vault. `read_dir`
        // entry file-type reports the link itself (it does not traverse it).
        let ft = entry.file_type().map_err(|e| KbError::Io(e.to_string()))?;
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk(vault_root, &p, out)?;
        } else if ft.is_file() && p.extension().and_then(|e| e.to_str()) == Some(MD_EXT) {
            // `ft.is_file()` keeps FIFOs/sockets/devices out of the read surface.
            out.push(path::to_canonical(vault_root, &p)?.as_str().to_string());
        }
    }
    Ok(())
}

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

    // Regression for the symlink guards: a vault-local symlink must neither be listed
    // nor followed out of the vault. (FIFO/socket coverage would need a mkfifo dep; the
    // is_file() guard rejects them at runtime — see read_note / walk.)
    #[cfg(unix)]
    #[test]
    fn skips_and_rejects_escaping_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let root = dir.path();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "TOP SECRET").unwrap();
        fs::write(root.join("real.md"), "ok").unwrap();
        symlink(outside.path().join("secret.md"), root.join("link.md")).unwrap();

        // walk skips the symlink entry → only the real regular file is listed.
        assert_eq!(
            crate::kb::read::list(root).unwrap(),
            vec!["real.md".to_string()]
        );
        // read_note canonicalizes + re-asserts containment → the escaping symlink is rejected.
        assert!(read_note(root, "link.md").is_err());
        assert_eq!(read_note(root, "real.md").unwrap(), "ok");
    }

    #[test]
    fn read_note_rejects_directory_named_md() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("d.md")).unwrap();
        // A directory named like a note must be rejected by the is_file() guard, on every platform.
        assert!(read_note(root, "d.md").is_err());
    }

    #[test]
    fn lists_markdown_recursively_sorted_skipping_dotfiles() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("z.md"), "z").unwrap();
        std::fs::write(root.join("a/b.md"), "b").unwrap();
        std::fs::write(root.join("note.txt"), "x").unwrap(); // skipped: not md
        std::fs::write(root.join(".git/config"), "x").unwrap(); // skipped: dotdir
        std::fs::write(root.join(".secret.md"), "x").unwrap(); // skipped: dotfile

        assert_eq!(
            list(root).unwrap(),
            vec!["a/b.md".to_string(), "z.md".to_string()]
        );
    }
}
