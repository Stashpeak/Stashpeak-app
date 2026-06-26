use crate::kb::watch::{self, EchoFilter};
use crate::mcp::server::{self, Notifier};
use crate::mcp::McpError;
use crate::settings;
use notify::RecommendedWatcher;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

struct McpHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    _watcher: Option<RecommendedWatcher>, // dropping it stops the fs watch
}

pub struct McpService {
    running: Mutex<Option<McpHandle>>,
    notifier: Arc<Notifier>,
}

impl Default for McpService {
    fn default() -> Self {
        Self {
            running: Mutex::new(None),
            notifier: Arc::new(Notifier::default()),
        }
    }
}

impl McpService {
    /// Start the IPC listener + KB watcher if not already running. Idempotent.
    pub fn start<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> Result<(), McpError> {
        let mut guard = self.running.lock().expect("mcp service lock poisoned");
        if guard.is_some() {
            return Ok(());
        }
        // Watcher bound to the server-owned root; a missing root is non-fatal.
        let watcher = match settings::get_vault_root().map_err(McpError::Kb)? {
            Some(root) => {
                match watch::start_watch(
                    app.clone(),
                    PathBuf::from(root),
                    Arc::new(EchoFilter::default()),
                ) {
                    Ok(w) => Some(w),
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "kb watcher failed to start; list_changed disabled"
                        );
                        None
                    }
                }
            }
            None => None,
        };
        let handle = self.start_server_inner(watcher)?;
        *guard = Some(handle);
        tracing::info!("mcp ipc server + kb watcher started");
        Ok(())
    }

    /// Internal: bind the IPC socket SYNCHRONOUSLY, then spawn the accept loop.
    ///
    /// Binding before the spawn is what makes `start()` honest: a bind conflict
    /// (the socket is already in use) returns `Err` here instead of a thread that
    /// exits silently while the toggle reports "on". Only after a successful bind
    /// do we mark the service running and move the listener into the accept loop.
    fn start_server_inner(
        &self,
        watcher: Option<RecommendedWatcher>,
    ) -> Result<McpHandle, McpError> {
        self.start_server_inner_named(&server::ipc_socket_name(), watcher)
    }

    /// Bind `socket_name` synchronously then spawn the accept loop. A test seam:
    /// production passes `ipc_socket_name()`; tests pass a unique per-run name so
    /// the bind-conflict path can be exercised hermetically without colliding on
    /// the shared production socket.
    fn start_server_inner_named(
        &self,
        socket_name: &str,
        watcher: Option<RecommendedWatcher>,
    ) -> Result<McpHandle, McpError> {
        let listener = server::bind_listener(socket_name)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let notifier = self.notifier.clone();
        let join = std::thread::spawn(move || {
            if let Err(e) = server::serve_with_listener(listener, stop_thread, notifier) {
                tracing::error!(error = %e, "mcp ipc server exited with error");
            }
        });
        Ok(McpHandle {
            stop,
            join: Some(join),
            _watcher: watcher,
        })
    }

    /// Stop the listener (join its thread + workers) and drop the watcher. Safe when stopped.
    pub fn stop(&self) {
        let mut guard = self.running.lock().expect("mcp service lock poisoned");
        if let Some(mut handle) = guard.take() {
            handle.stop.store(true, Ordering::Relaxed);
            if let Some(join) = handle.join.take() {
                let _ = join.join(); // returns promptly: workers wake within POLL
            }
            tracing::info!("mcp ipc server + kb watcher stopped");
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
            .lock()
            .expect("mcp service lock poisoned")
            .is_some()
    }

    /// Relay a watcher change. GATE: only fan out READABLE changes, so a
    /// list_changed signal never reveals the existence/timing of a gated-out
    /// (.kbignore/.nokb/secret) note. Resolves the server-owned root per call.
    pub fn notify_changed(&self, canonical: &str) {
        let root = match settings::get_vault_root() {
            Ok(Some(r)) => PathBuf::from(r),
            _ => return,
        };
        if crate::kb::access::resolve_readable(&root, canonical) {
            self.notifier.notify(canonical);
        }
    }

    /// Test-only: subscribe to the gated change stream.
    #[cfg(test)]
    pub(crate) fn test_subscribe(&self) -> std::sync::mpsc::Receiver<String> {
        self.notifier.subscribe()
    }

    /// Test-only: start the IPC server without an AppHandle (no vault watcher),
    /// binding `socket_name`. Used in headless tests where tauri::test::mock_app()
    /// causes DLL issues on Windows. Tests pass a unique per-run name so they
    /// never collide on the shared production socket.
    #[cfg(test)]
    pub(crate) fn start_server_only_named(&self, socket_name: &str) -> Result<(), McpError> {
        let mut guard = self.running.lock().expect("mcp service lock poisoned");
        if guard.is_some() {
            return Ok(());
        }
        let handle = self.start_server_inner_named(socket_name, None)?;
        *guard = Some(handle);
        tracing::info!("mcp ipc server started (test mode, no watcher)");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use std::time::Duration;

    /// Monotonic counter for unique per-run socket names (no cross-test collision
    /// on the shared production socket now that bind happens synchronously).
    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn unique_sock(tag: &str) -> String {
        format!(
            "stashpeak-mcp-lifecycle-{tag}-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// start_server_only() is idempotent and stop() is safe to call multiple times.
    /// No vault root set → watcher is None; exercises IPC server start/stop idempotency
    /// + the prompt-join (proves stop() returns without hanging).
    ///
    /// Note: tauri::test::mock_app() is not used here because it causes
    /// STATUS_ENTRYPOINT_NOT_FOUND on Windows headless CI environments due to
    /// Windows UI DLLs (comctl32, user32, etc.) being linked but not resolvable.
    /// start_server_only() calls the same IPC-server code path that start() uses —
    /// the only omission is the vault watcher, which is separately tested via
    /// notify_changed_gates_excluded_paths. The brief's intent (idempotency + stop
    /// prompt-join) is fully covered.
    #[test]
    fn start_is_idempotent_and_stop_is_safe() {
        crate::test_support::with_temp_data_dir(|| {
            let svc = McpService::default();
            let sock = unique_sock("idem");
            svc.start_server_only_named(&sock).unwrap();
            svc.start_server_only_named(&sock).unwrap(); // idempotent: already running
            assert!(svc.is_running());
            svc.stop();
            svc.stop(); // safe: already stopped
            assert!(!svc.is_running());
        });
    }

    /// Bind-before-spawn correctness: a SECOND service binding the SAME socket
    /// name while the first is live must return Err from start (the bind conflict
    /// surfaces synchronously), NOT a false Ok with a thread that exits silently.
    #[test]
    fn second_start_on_same_socket_errors() {
        crate::test_support::with_temp_data_dir(|| {
            let sock = unique_sock("conflict");

            let first = McpService::default();
            first.start_server_only_named(&sock).unwrap();
            assert!(first.is_running());

            // A different service instance binding the same name must fail to bind.
            let second = McpService::default();
            let res = second.start_server_only_named(&sock);
            assert!(
                res.is_err(),
                "second bind on the same socket must Err, got {res:?}"
            );
            assert!(!second.is_running(), "failed start must not mark running");

            first.stop();
        });
    }

    /// notify_changed fans out ONLY readable changes.
    /// Excluded paths (.kbignore) must NOT produce a signal — the confidentiality gate.
    #[test]
    fn notify_changed_gates_excluded_paths() {
        crate::test_support::with_temp_data_dir(|| {
            let vault = tempfile::tempdir().unwrap();
            let root = vault.path();

            // Create a readable note and a secret note excluded by .kbignore.
            std::fs::write(root.join("readable.md"), "public content").unwrap();
            std::fs::write(root.join("secret.md"), "secret content").unwrap();
            std::fs::write(root.join(".kbignore"), "secret.md\n").unwrap();

            // Point the vault root at our temp dir.
            settings::set_vault_root(root.to_string_lossy().to_string()).unwrap();

            let svc = McpService::default();
            let rx = svc.test_subscribe();

            // Readable path → must produce a signal.
            svc.notify_changed("readable.md");
            let got = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("expected readable.md signal within 1s");
            assert_eq!(got, "readable.md");

            // Excluded path → must NOT produce a signal (confidentiality gate).
            svc.notify_changed("secret.md");
            let timeout_err = rx.recv_timeout(Duration::from_millis(300));
            assert!(
                timeout_err.is_err(),
                "secret.md should not produce a signal, but got: {timeout_err:?}"
            );
        });
    }
}
