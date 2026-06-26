//! stashpeak-mcp — the thin MCP stdio shim. The MCP client SPAWNS this process.
//! It holds NO app logic, NO keychain, NO direct vault fs — every read crosses
//! the local IPC hop to the running Stashpeak app (MCP_KB_CONTRACT.md §4).
//!
//! TRANSPORT: hand-rolled, line-delimited JSON-RPC on stdin/stdout (one JSON
//! message per line; no Content-Length headers) per the plan's P1 correction —
//! NO `rmcp`. The IPC to the app is the Phase-2 length-prefixed `wire` framing.
//!
//! STDOUT DISCIPLINE: nothing but line-delimited JSON-RPC ever reaches stdout.
//! All logs and all panics go to stderr (installed FIRST, before any stdout
//! touch). On a startup failure we `eprintln!` + exit non-zero with EMPTY stdout.

use stashpeak_lib::mcp::manifest::CapabilityManifest;
use stashpeak_lib::mcp::server::ipc_socket_name;
use stashpeak_lib::mcp::wire::{read_frame, write_frame, IpcRequest, IpcResponse};

use interprocess::local_socket::{traits::Stream as _, GenericNamespaced, Stream, ToNsName};

/// Install a panic hook + a stderr-only tracing writer BEFORE anything else, so
/// no panic message or log line can ever corrupt the stdout JSON-RPC stream.
fn install_stderr_only_diagnostics() {
    std::panic::set_hook(Box::new(|info| {
        // Stderr only — a panic on stdout would poison the MCP stream.
        eprintln!("stashpeak-mcp panic: {info}");
    }));
    // Route tracing to stderr; never to stdout.
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
}

/// Read the per-client token the user pasted into the MCP client config. The
/// client passes it as STASHPEAK_MCP_TOKEN (env) or `--token <t>` (arg).
fn read_token() -> Option<String> {
    if let Ok(t) = std::env::var("STASHPEAK_MCP_TOKEN") {
        if !t.is_empty() {
            return Some(t);
        }
    }
    let mut args = std::env::args();
    while let Some(a) = args.next() {
        if a == "--token" {
            return args.next();
        }
    }
    None
}

/// Open a fresh IPC connection to the app and run one request/response. The
/// client connection is BLOCKING (no nonblocking handling needed on this side).
fn ipc_call(req: &IpcRequest) -> Result<IpcResponse, String> {
    let name = ipc_socket_name()
        .to_ns_name::<GenericNamespaced>()
        .map_err(|e| e.to_string())?;
    let mut conn = Stream::connect(name).map_err(|_| "Stashpeak is not running".to_string())?;
    write_frame(&mut conn, req).map_err(|e| e.to_string())?;
    read_frame::<_, IpcResponse>(&mut conn).map_err(|e| e.to_string())
}

/// Fetch the app-supplied manifest that drives the MCP `initialize` handshake.
fn fetch_manifest(token: &str) -> Result<CapabilityManifest, String> {
    match ipc_call(&IpcRequest::Manifest {
        token: token.to_string(),
    })? {
        IpcResponse::Manifest(m) => Ok(m),
        IpcResponse::Error { kind, message } => Err(format!("{kind}: {message}")),
        _ => Err("unexpected response to Manifest".to_string()),
    }
}

fn main() {
    // (1) Diagnostics FIRST — before anything can touch stdout.
    install_stderr_only_diagnostics();

    // (2) Token (no token → exit 2, empty stdout).
    let token = match read_token() {
        Some(t) => t,
        None => {
            eprintln!("stashpeak-mcp: no token (set STASHPEAK_MCP_TOKEN or --token)");
            std::process::exit(2);
        }
    };

    // (3) The handshake data is app-owned. If the app is down, surface it on
    //     stderr and exit; never write anything to stdout.
    //     (The stdio JSON-RPC server + notify relay are wired in Tasks 5.2/5.3.)
    let manifest = match fetch_manifest(&token) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("stashpeak-mcp: cannot initialize: {e}");
            std::process::exit(1);
        }
    };

    tracing::info!(server = %manifest.server_name, "stashpeak-mcp: manifest fetched");
}
