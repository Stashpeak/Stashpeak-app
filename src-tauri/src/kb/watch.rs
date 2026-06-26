use crate::kb::{path, KbError};
use notify::{Event, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

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
        self.seen
            .lock()
            .unwrap()
            .contains(&(path.to_string(), hash))
    }
}

/// Start a recursive filesystem watcher on `vault_root`.
///
/// On every external `.md` change (create / modify / rename), emits the
/// Tauri event `"kb://list_changed"` with the affected vault-relative
/// canonical path as payload.  Self-writes are suppressed via `echo`:
/// the write path must call `echo.record(canonical, content_hash(bytes))`
/// before writing so the subsequent watcher event is filtered out.
///
/// The returned `RecommendedWatcher` must be kept alive by the caller;
/// dropping it stops the watch.  Wiring into app startup is deferred to
/// Phase 6 — this function is pure construction and does not modify any
/// global state.
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
            let Ok(canonical) = path::to_canonical(&root, &p) else {
                continue;
            };
            // Skip our own writes (write path records into `echo`).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_filter_recognizes_self_writes() {
        let f = EchoFilter::new();
        let h = content_hash(b"hello");
        assert!(!f.is_echo("a.md", h));
        f.record("a.md", h);
        assert!(f.is_echo("a.md", h)); // same path+content = our own write
        assert!(!f.is_echo("a.md", content_hash(b"changed"))); // foreign edit
    }
}
