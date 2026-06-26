use crate::kb::ledger::{self, Brake};
use crate::kb::{access, tokens};
use crate::mcp::manifest;
use crate::mcp::wire::{IpcRequest, IpcResponse};
use crate::settings;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// Poll cadence: a blocked per-connection read wakes this often to honor `stop`.
const POLL: Duration = Duration::from_millis(250);

/// Fan-out of changed canonical paths to connected notify (Subscribe) streams.
/// std mpsc, not tokio broadcast — the IPC workers are blocking threads.
#[derive(Default)]
pub struct Notifier {
    subs: Mutex<Vec<mpsc::Sender<String>>>,
}

impl Notifier {
    /// Fan a (already-GATED) changed canonical out to every notify stream, pruning
    /// hung-up receivers. Callers MUST gate the path first (see McpService::notify_changed).
    pub fn notify(&self, canonical: &str) {
        let mut subs = self.subs.lock().expect("notifier lock poisoned");
        subs.retain(|tx| tx.send(canonical.to_string()).is_ok());
    }

    /// Register a notify stream; returns its receiver.
    pub fn subscribe(&self) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel();
        self.subs.lock().expect("notifier lock poisoned").push(tx);
        rx
    }
}

enum FrameStep {
    Ok,
    Stopped,
    Closed,
    Bad,
}

/// Fill `buf` fully, waking every recv-timeout to re-check `stop`. Keeps bytes
/// across timeouts so a mid-frame timeout never desyncs framing.
/// On WouldBlock (non-blocking stream fallback), sleeps briefly before retrying
/// to avoid a busy spin.
fn read_exact_interruptible<S: std::io::Read>(
    stream: &mut S,
    buf: &mut [u8],
    stop: &AtomicBool,
) -> FrameStep {
    let mut filled = 0;
    while filled < buf.len() {
        if stop.load(Ordering::Relaxed) {
            return FrameStep::Stopped;
        }
        match stream.read(&mut buf[filled..]) {
            Ok(0) => {
                return if filled == 0 {
                    FrameStep::Closed
                } else {
                    FrameStep::Bad
                }
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // Non-blocking fallback (e.g. Windows named pipes where
                // set_recv_timeout is unsupported): sleep for one POLL cadence
                // before retrying so we don't spin 100% CPU.
                std::thread::sleep(POLL);
                continue;
            }
            Err(_) => return FrameStep::Bad,
        }
    }
    FrameStep::Ok
}

enum FrameRead {
    Got(IpcRequest),
    Stopped,
    Done,
}

/// Read one length-prefixed IpcRequest frame, interruptible by `stop`.
fn read_frame_interruptible<S: std::io::Read>(stream: &mut S, stop: &AtomicBool) -> FrameRead {
    let mut len_buf = [0u8; 4];
    match read_exact_interruptible(stream, &mut len_buf, stop) {
        FrameStep::Ok => {}
        FrameStep::Stopped => return FrameRead::Stopped,
        FrameStep::Closed | FrameStep::Bad => return FrameRead::Done,
    }
    let len = u32::from_be_bytes(len_buf);
    if len > crate::mcp::wire::MAX_FRAME {
        return FrameRead::Done;
    }
    let mut body = vec![0u8; len as usize];
    match read_exact_interruptible(stream, &mut body, stop) {
        FrameStep::Ok => {}
        FrameStep::Stopped => return FrameRead::Stopped,
        FrameStep::Closed | FrameStep::Bad => return FrameRead::Done,
    }
    match serde_json::from_slice::<IpcRequest>(&body) {
        Ok(req) => FrameRead::Got(req),
        Err(_) => FrameRead::Done,
    }
}

/// Park a notify (Subscribe) connection: block on the change channel, write a
/// Changed frame per readable change, honoring `stop` via recv_timeout.
fn run_notify_loop<S: std::io::Write>(stream: &mut S, stop: &AtomicBool, notifier: &Notifier) {
    use crate::mcp::wire::write_frame;
    let rx = notifier.subscribe();
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        match rx.recv_timeout(POLL) {
            Ok(canonical) => {
                if write_frame(stream, &IpcResponse::Changed { canonical }).is_err() {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

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
    // Subscribe is served by the notify channel, never via handle_request.
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
    stop: Arc<AtomicBool>,
    notifier: Arc<Notifier>,
) -> Result<(), crate::mcp::McpError> {
    use interprocess::local_socket::{
        traits::{Listener as _, Stream as _},
        GenericNamespaced, ListenerNonblockingMode, ListenerOptions, ToNsName,
    };

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
                // Try recv timeout so blocked reads wake to honor stop.
                // Windows named pipes return Unsupported; fall back to non-blocking
                // mode in that case (read_exact_interruptible handles WouldBlock with
                // a POLL sleep so it's not a busy-spin, just with 250ms granularity).
                // Any other error (e.g. OS resource exhaustion) drops the connection.
                match stream.set_recv_timeout(Some(POLL)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
                        if let Err(nb_err) = stream.set_nonblocking(true) {
                            tracing::warn!(
                                error = %nb_err,
                                "mcp: set_nonblocking fallback failed; dropping connection"
                            );
                            continue;
                        }
                        tracing::debug!(
                            "mcp: recv_timeout unsupported; using non-blocking fallback"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "mcp: set_recv_timeout failed; dropping connection");
                        continue;
                    }
                }
                let worker_stop = stop.clone();
                let worker_notifier = notifier.clone();
                workers.push(std::thread::spawn(move || {
                    handle_connection(stream, worker_stop, worker_notifier);
                }));
                // Reap any workers that finished on their own (closed connections)
                // so the tracking Vec does not grow unbounded over the session.
                workers.retain(|w| !w.is_finished());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                // Transient accept error: keep serving.
                std::thread::sleep(Duration::from_millis(50));
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
pub fn serve(stop: Arc<AtomicBool>, notifier: Arc<Notifier>) -> Result<(), crate::mcp::McpError> {
    serve_named(&ipc_socket_name(), stop, notifier)
}

/// One connection: frame in -> handle -> frame out, until EOF, error, or stop.
/// The shared `stop` flag is checked before every read so an idle long-lived
/// connection (e.g. a shim that pins the socket) is torn down promptly on stop.
/// On a Subscribe request, transitions to the notify push loop.
fn handle_connection<S: std::io::Read + std::io::Write>(
    mut stream: S,
    stop: Arc<AtomicBool>,
    notifier: Arc<Notifier>,
) {
    use crate::mcp::wire::write_frame;

    loop {
        match read_frame_interruptible(&mut stream, &stop) {
            FrameRead::Stopped => return,
            FrameRead::Done => return,
            FrameRead::Got(req) => {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                // Subscribe is auth-gated here since it never goes through handle_request.
                if let IpcRequest::Subscribe { token } = &req {
                    match tokens::validate(token) {
                        Ok(Some(_)) => {
                            run_notify_loop(&mut stream, &stop, &notifier);
                            return;
                        }
                        _ => {
                            let _ =
                                write_frame(&mut stream, &err("Unauthorized", "no valid token"));
                            return;
                        }
                    }
                }
                let resp = handle_request(&req);
                if write_frame(&mut stream, &resp).is_err() {
                    return;
                }
                // A Manifest exchange is one-shot in practice but we keep the loop so a
                // shim may reuse the connection for several reads.
            }
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
                let _ = serve_named(&sock2, stop2, Arc::new(Notifier::default()));
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

    /// Regression test for the stop()-hang gate: prove stop() does NOT hang on an
    /// idle-open connection. A worker blocked in read_frame_interruptible must wake
    /// within POLL (250ms) and exit; the join must therefore return promptly.
    #[test]
    fn stop_does_not_hang_on_idle_open_connection() {
        let sock = format!(
            "stashpeak-mcp-nohang-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );

        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let sock2 = sock.clone();

        // Start the server.
        let server = std::thread::spawn(move || {
            let _ = serve_named(&sock2, stop2, Arc::new(Notifier::default()));
        });
        let _stop_guard = StopGuard(stop.clone());

        // Connect a client and send NOTHING (worker blocks in read_frame_interruptible).
        let name = sock.to_ns_name::<GenericNamespaced>().unwrap();
        let mut last_err = None;
        let mut client = None;
        for _ in 0..50 {
            match Stream::connect(name.clone()) {
                Ok(s) => {
                    client = Some(s);
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        }
        let _conn = client.unwrap_or_else(|| panic!("failed to connect to listener: {last_err:?}"));

        // Sleep ~300ms so the worker is parked in the blocked read.
        std::thread::sleep(std::time::Duration::from_millis(300));

        // Signal stop WITHOUT closing the client connection — the key condition.
        stop.store(true, Ordering::Relaxed);

        // Join must return promptly (within the test harness timeout).
        // The test completing proves no hang — the worker woke within POLL.
        let _ = server.join();

        // Keep _conn alive until after join to prove an idle peer cannot pin stop().
        drop(_conn);
    }
}
