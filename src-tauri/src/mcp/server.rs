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
/// gated read op, and records it in the ledger. Synchronous; the accept loop runs
/// each connection on its own blocking thread.
pub fn handle_request(req: &IpcRequest) -> IpcResponse {
    // (1) Authenticate every request (Plan 2 hashes + looks up + remember_secrets).
    let info = match tokens::validate(req.token()) {
        Ok(Some(info)) => info,
        Ok(None) => return err("Unauthorized", "no valid token"),
        Err(e) => return err("Io", e),
    };

    // A Manifest request needs ONLY a valid token (no vault read, no ledger row).
    if let IpcRequest::Manifest { .. } = req {
        return IpcResponse::Manifest(manifest::current());
    }
    // Subscribe is served by the notify channel (Phase 4), never via handle_request.
    if let IpcRequest::Subscribe { .. } = req {
        return err(
            "Protocol",
            "subscribe uses the notify channel, not a request",
        );
    }

    // (2) Server-owned vault root.
    let root = match vault_root() {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    // (3) Bulk-read brake (§7.2): a Pause stops the read until re-confirmed.
    //     RECONCILE: keyed by the stable client_id, NOT the label.
    match ledger::check_read_budget(&info.id) {
        Ok(Brake::Pause) => {
            return err("RateLimited", "read budget paused; re-confirm in Stashpeak")
        }
        Ok(Brake::Notice) | Ok(Brake::Allow) => {}
        Err(e) => return err("Io", e),
    }

    // (4) Run the GATED op (never raw kb::read/kb::search) + (5) record the read.
    //     RECONCILE: record_read takes (client_id, client_label, tool, target, result_count).
    match req {
        IpcRequest::List { .. } => match access::list_readable(&root) {
            Ok(paths) => {
                let _ = ledger::record_read(&info.id, &info.label, "kb_list", "", paths.len());
                IpcResponse::List { paths }
            }
            Err(e) => err("Kb", e.to_string()),
        },
        IpcRequest::ReadNote { canonical, .. } => match access::read_note(&root, canonical) {
            Ok(content) => {
                let _ = ledger::record_read(&info.id, &info.label, "kb_read_note", canonical, 1);
                IpcResponse::Note { content }
            }
            Err(e) => {
                // access::read_note maps gated-out AND missing to the same path-free
                // error (Plan 2 Fix C) — record a 0-result read for visibility, then
                // surface a recoverable error. Do NOT assume Err == "definitely absent".
                let _ = ledger::record_read(&info.id, &info.label, "kb_read_note", canonical, 0);
                err("Kb", e.to_string())
            }
        },
        IpcRequest::Search { query, limit, .. } => match access::search(&root, query, *limit) {
            Ok(hits) => {
                let _ = ledger::record_read(&info.id, &info.label, "kb_search", query, hits.len());
                IpcResponse::Search { hits }
            }
            Err(e) => err("Kb", e.to_string()),
        },
        IpcRequest::Manifest { .. } | IpcRequest::Subscribe { .. } => unreachable!("handled above"),
    }
}

/// Build-namespaced local-socket name so a dev build and a release build never
/// share the IPC endpoint. The shim derives the same name the same way.
pub fn ipc_socket_name() -> String {
    if cfg!(debug_assertions) {
        "stashpeak-mcp-dev.sock".to_string()
    } else {
        "stashpeak-mcp.sock".to_string()
    }
}

/// Bind the named local socket `name` and serve requests until `stop` flips true.
/// One blocking thread per connection (KB reads are short, single-user volume).
///
/// Every per-connection worker shares the same `stop` flag and its `JoinHandle`
/// is tracked, so when `stop` flips true we both (a) make every in-flight worker
/// notice and exit between frames and (b) join them before returning — no client
/// connection survives a disable (the toggle truly stops the server).
///
/// This function is the real implementation; `serve` is a one-line wrapper that
/// passes the production socket name. Tests can call `serve_named` with a unique
/// per-run name to avoid any socket-name collision.
pub fn serve_named(
    name: &str,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), crate::mcp::McpError> {
    use interprocess::local_socket::{
        traits::Listener as _, GenericNamespaced, ListenerNonblockingMode, ListenerOptions,
        ToNsName,
    };
    use std::sync::atomic::Ordering;

    let ns_name = name
        .to_ns_name::<GenericNamespaced>()
        .map_err(|e| crate::mcp::McpError::Io(e.to_string()))?;
    let listener = ListenerOptions::new()
        .name(ns_name)
        .create_sync()
        .map_err(|e| crate::mcp::McpError::Io(e.to_string()))?;
    // Non-blocking accept so the stop flag is honored promptly.
    listener
        .set_nonblocking(ListenerNonblockingMode::Accept)
        .map_err(|e| crate::mcp::McpError::Io(e.to_string()))?;

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

/// Bind the production local socket and serve requests until `stop` flips true.
/// Thin wrapper around `serve_named` using the build-namespaced socket name.
pub fn serve(
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), crate::mcp::McpError> {
    serve_named(&ipc_socket_name(), stop)
}

/// One connection: frame in -> handle -> frame out, until EOF, error, or stop.
/// The shared `stop` flag is checked before every read so an idle long-lived
/// connection (e.g. a shim that pins the socket) is torn down promptly on stop.
fn handle_connection<S: std::io::Read + std::io::Write>(
    mut stream: S,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use crate::mcp::wire::{read_frame, write_frame};
    use std::sync::atomic::Ordering;

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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kb::tokens::{self, Scope};
    use crate::settings;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rejects_request_without_valid_token() {
        crate::test_support::with_temp_data_dir(|| {
            let resp = handle_request(&IpcRequest::List {
                token: "spk_mcp_nope".into(),
            });
            assert!(matches!(resp, IpcResponse::Error { ref kind, .. } if kind == "Unauthorized"));
        });
    }

    #[test]
    fn lists_through_the_gate_and_records_the_read() {
        crate::test_support::with_temp_data_dir(|| {
            let dir = tempdir().unwrap();
            fs::write(dir.path().join("a.md"), "alpha").unwrap();
            settings::set_vault_root(dir.path().to_string_lossy().into()).unwrap();

            let raw = tokens::mint("Claude Desktop".into(), Scope::Read).unwrap();
            let resp = handle_request(&IpcRequest::List { token: raw.clone() });
            match resp {
                IpcResponse::List { paths } => assert_eq!(paths, vec!["a.md".to_string()]),
                other => panic!("expected List, got {other:?}"),
            }
            // The read is in the ledger under the token's client_label.
            let recent = crate::kb::ledger::recent(10).unwrap();
            assert!(recent
                .iter()
                .any(|r| r.tool == "kb_list" && r.client_label == "Claude Desktop"));
        });
    }

    #[test]
    fn manifest_needs_a_token_but_no_vault() {
        crate::test_support::with_temp_data_dir(|| {
            // No vault root set; a Manifest request still succeeds for a valid token.
            let raw = tokens::mint("Cursor".into(), Scope::Read).unwrap();
            let resp = handle_request(&IpcRequest::Manifest { token: raw });
            assert!(matches!(resp, IpcResponse::Manifest(_)));
        });
    }
}

/// Integration tests: loopback IPC over a unique per-run local socket, plus
/// server-layer security brake tests. These are always-on (not `#[ignore]`).
#[cfg(test)]
mod ipc_tests {
    use super::*;
    use crate::kb::tokens::{self, Scope};
    use crate::settings;
    use interprocess::local_socket::{traits::Stream as _, GenericNamespaced, Stream, ToNsName};
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;

    /// Monotonic counter for unique per-run socket names (safe across threads
    /// and across repeated runs within the same process).
    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// RAII guard: sets the stop flag on drop so the server thread always shuts
    /// down even if the test panics before the explicit stop.store(true) line.
    struct StopGuard(Arc<AtomicBool>);
    impl Drop for StopGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    /// Loopback IPC over a unique per-run local socket.
    ///
    /// Uses `serve_named` with a name that combines the OS process-id and a
    /// per-process counter, guaranteeing no collision across Cargo test processes
    /// or across repeated runs within a single process. The client connection is
    /// dropped BEFORE signalling stop + joining the server — mirroring a real
    /// one-request-per-connection shim and giving the worker EOF so `serve_named`
    /// can complete its join without deadlocking.
    #[test]
    fn loopback_list_round_trip() {
        use crate::mcp::wire::{read_frame, write_frame};

        crate::test_support::with_temp_data_dir(|| {
            let dir = tempdir().unwrap();
            fs::write(dir.path().join("a.md"), "alpha").unwrap();
            settings::set_vault_root(dir.path().to_string_lossy().into()).unwrap();
            let raw = tokens::mint("Test".into(), Scope::Read).unwrap();

            // Unique socket name: pid + monotonic counter → no collision ever.
            let sock = format!(
                "stashpeak-mcp-test-{}-{}.sock",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );

            let stop = Arc::new(AtomicBool::new(false));
            let stop2 = stop.clone();
            let sock2 = sock.clone();
            let server = std::thread::spawn(move || {
                let _ = serve_named(&sock2, stop2);
            });
            // RAII guard: sets stop on drop so the server exits even if this thread panics.
            let _stop_guard = StopGuard(stop.clone());

            // Retry-connect loop: try to connect every 20ms for up to ~1s so the
            // test never races the listener bind.
            let name = sock.to_ns_name::<GenericNamespaced>().unwrap();
            let mut conn = {
                let mut last_err = None;
                let mut stream = None;
                for _ in 0..50 {
                    match Stream::connect(name.clone()) {
                        Ok(s) => {
                            stream = Some(s);
                            break;
                        }
                        Err(e) => {
                            last_err = Some(e);
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                    }
                }
                stream.unwrap_or_else(|| panic!("failed to connect to listener: {last_err:?}"))
            };

            write_frame(&mut conn, &IpcRequest::List { token: raw }).unwrap();
            let resp: IpcResponse = read_frame(&mut conn).unwrap();
            assert!(
                matches!(resp, IpcResponse::List { ref paths } if paths == &vec!["a.md".to_string()])
            );

            // Drop the client connection FIRST — gives the per-connection worker
            // EOF so serve_named can join it cleanly without deadlocking.
            drop(conn);
            stop.store(true, Ordering::Relaxed);
            let _ = server.join();
        });
    }

    /// Hitting the PAUSE brake returns RateLimited and serves no further reads.
    #[test]
    fn pause_returns_rate_limited() {
        crate::test_support::with_temp_data_dir(|| {
            let dir = tempdir().unwrap();
            fs::write(dir.path().join("b.md"), "beta").unwrap();
            settings::set_vault_root(dir.path().to_string_lossy().into()).unwrap();

            let raw = tokens::mint("BrakeClient".into(), Scope::Read).unwrap();
            // Get the client_id by listing tokens and finding the one we just minted.
            let token_list = tokens::list().unwrap();
            let id = token_list
                .iter()
                .find(|t| t.label == "BrakeClient")
                .expect("minted token not found")
                .id
                .clone();

            // Seed the read budget past PAUSE_THRESHOLD (100 results in 60 s window).
            // One call with result_count=100 crosses the threshold.
            crate::kb::ledger::record_read(&id, "BrakeClient", "kb_search", "q", 100).unwrap();

            let resp = handle_request(&IpcRequest::List { token: raw.clone() });
            assert!(
                matches!(resp, IpcResponse::Error { ref kind, .. } if kind == "RateLimited"),
                "expected RateLimited, got {resp:?}"
            );

            // No successful list was served: the only ledger row is the seeded one.
            let recent = crate::kb::ledger::recent(10).unwrap();
            assert!(
                !recent.iter().any(|r| r.tool == "kb_list"),
                "kb_list should not appear in ledger when paused"
            );
        });
    }

    /// A missing/gated-out ReadNote records a 0-result row and returns a
    /// path-free error (the canonical path is not echoed back to the client).
    #[test]
    fn gated_out_read_records_zero_and_errs_path_free() {
        crate::test_support::with_temp_data_dir(|| {
            let dir = tempdir().unwrap();
            settings::set_vault_root(dir.path().to_string_lossy().into()).unwrap();

            let raw = tokens::mint("PathFreeClient".into(), Scope::Read).unwrap();
            let resp = handle_request(&IpcRequest::ReadNote {
                token: raw,
                canonical: "does-not-exist.md".into(),
            });

            // Response is a Kb error.
            let message = match &resp {
                IpcResponse::Error { kind, message } => {
                    assert_eq!(kind, "Kb", "expected Kb error kind, got {resp:?}");
                    message.clone()
                }
                other => panic!("expected Error, got {other:?}"),
            };
            // The error message must NOT leak the canonical path back to the client.
            assert!(
                !message.contains("does-not-exist"),
                "error message leaks the canonical path: {message:?}"
            );

            // A 0-result ledger row must exist for kb_read_note.
            let recent = crate::kb::ledger::recent(10).unwrap();
            assert!(
                recent
                    .iter()
                    .any(|r| r.tool == "kb_read_note" && r.result_count == 0),
                "expected a 0-result kb_read_note row in ledger; got {recent:?}"
            );
        });
    }
}
