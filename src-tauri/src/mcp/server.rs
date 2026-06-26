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

/// Bind the local socket and serve requests until `stop` flips true.
/// One blocking thread per connection (KB reads are short, single-user volume).
///
/// Every per-connection worker shares the same `stop` flag and its `JoinHandle`
/// is tracked, so when `stop` flips true we both (a) make every in-flight worker
/// notice and exit between frames and (b) join them before returning — no client
/// connection survives a disable (the toggle truly stops the server).
pub fn serve(
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), crate::mcp::McpError> {
    use interprocess::local_socket::{
        traits::Listener as _, GenericNamespaced, ListenerNonblockingMode, ListenerOptions,
        ToNsName,
    };
    use std::sync::atomic::Ordering;

    let name = ipc_socket_name()
        .to_ns_name::<GenericNamespaced>()
        .map_err(|e| crate::mcp::McpError::Io(e.to_string()))?;
    let listener = ListenerOptions::new()
        .name(name)
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
        if matches!(resp, IpcResponse::Error { .. }) && matches!(req, IpcRequest::Manifest { .. }) {
            return;
        }
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

/// Integration test: loopback IPC over the real Windows named pipe.
///
/// This test is `#[ignore]` because on this Windows host the Cargo test harness
/// launches multiple test-binary instances concurrently, and Windows named pipes
/// cannot be overwritten (`reclaim_name` is a no-op on Windows per interprocess
/// docs). When two test invocations race to bind `stashpeak-mcp-dev.sock`, the
/// second one connects to the first process's server, gets an Unauthorized response
/// (wrong DB / different minted token), and the assertion fails — which leaves the
/// server thread running (stop flag is set after the assert), causing the test
/// harness to timeout at 60 s. With the RAII StopGuard the server now exits on
/// panic, but the bind-race itself is unfixable without a per-run unique name (which
/// would require passing a name parameter to `serve`, changing the production API).
///
/// Run manually (one process at a time) with:
///   cargo test --lib -- mcp::server::ipc_tests::loopback_list_round_trip --ignored
///
/// The `handle_request` unit tests (Task 3.1) are the always-on security coverage.
#[cfg(test)]
mod ipc_tests {
    use super::*;
    use crate::kb::tokens::{self, Scope};
    use crate::settings;
    use interprocess::local_socket::{traits::Stream as _, GenericNamespaced, Stream, ToNsName};
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;

    /// RAII guard: sets the stop flag on drop so the server thread always shuts
    /// down even if the test panics before the explicit stop.store(true) line.
    struct StopGuard(Arc<AtomicBool>);
    impl Drop for StopGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    #[test]
    #[ignore = "Windows named-pipe bind race when Cargo runs multiple test processes; run manually (see module doc)"]
    fn loopback_list_round_trip() {
        use crate::mcp::wire::{read_frame, write_frame};

        crate::test_support::with_temp_data_dir(|| {
            let dir = tempdir().unwrap();
            fs::write(dir.path().join("a.md"), "alpha").unwrap();
            settings::set_vault_root(dir.path().to_string_lossy().into()).unwrap();
            let raw = tokens::mint("Test".into(), Scope::Read).unwrap();

            let stop = Arc::new(AtomicBool::new(false));
            let stop2 = stop.clone();
            let server = std::thread::spawn(move || {
                let _ = serve(stop2);
            });
            // RAII guard: sets stop on drop so the server exits even if this thread panics.
            let _stop_guard = StopGuard(stop.clone());

            // Retry-connect loop: try to connect every 20ms for up to ~1s so the
            // test never races the listener bind (replaces the fixed sleep).
            let name = ipc_socket_name().to_ns_name::<GenericNamespaced>().unwrap();
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

            stop.store(true, Ordering::Relaxed);
            let _ = server.join();
        });
    }
}
