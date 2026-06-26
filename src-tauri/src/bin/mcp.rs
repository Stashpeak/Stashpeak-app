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

use serde_json::{json, Value};
use std::io::Write as _;
use std::sync::{Arc, Mutex};

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

/// Rebuild an IPC request with the real per-client token injected. `dispatch`
/// constructs requests with a placeholder token so it stays token-agnostic; the
/// transport layer stamps the actual token here just before the wire write.
fn with_token(req: IpcRequest, token: &str) -> IpcRequest {
    let token = token.to_string();
    match req {
        IpcRequest::Manifest { .. } => IpcRequest::Manifest { token },
        IpcRequest::List { .. } => IpcRequest::List { token },
        IpcRequest::ReadNote { canonical, .. } => IpcRequest::ReadNote { token, canonical },
        IpcRequest::Search { query, limit, .. } => IpcRequest::Search {
            token,
            query,
            limit,
        },
        IpcRequest::Subscribe { .. } => IpcRequest::Subscribe { token },
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
    let manifest = match fetch_manifest(&token) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("stashpeak-mcp: cannot initialize: {e}");
            std::process::exit(1);
        }
    };

    // (4) The shared stdout writer. The main loop AND the notify thread both
    //     write here — serialize every line through this Mutex so a notification
    //     can never interleave inside a response line.
    let out = Arc::new(Mutex::new(std::io::stdout()));

    // (5) The stdio JSON-RPC loop, until stdin EOF. The notify relay is NOT
    //     spawned here: it is started from inside the loop, only after the client
    //     sends `notifications/initialized` and only if the manifest advertises
    //     resources.listChanged (MCP forbids notifications before initialized).
    run_stdio_loop(&token, &manifest, out);
}

/// Spawn the notify relay: a dedicated std thread that opens a SECOND IPC
/// connection, subscribes, and on each `Changed` frame emits an MCP
/// notifications/resources/list_changed via the SHARED stdout writer. On connect
/// failure / EOF / any read error the thread just returns (no notifications; the
/// read path still errors cleanly). The path NEVER reaches the MCP client — v1
/// advertises only list-level listChanged, so the notification carries no params.
fn spawn_notify_relay(token: String, out: Arc<Mutex<std::io::Stdout>>) {
    let _ = std::thread::Builder::new()
        .name("mcp-notify".into())
        .spawn(move || {
            let name = match ipc_socket_name().to_ns_name::<GenericNamespaced>() {
                Ok(n) => n,
                Err(_) => return,
            };
            let mut conn = match Stream::connect(name) {
                Ok(c) => c,
                Err(_) => return, // app down: no notifications; the read path errors cleanly
            };
            if write_frame(&mut conn, &IpcRequest::Subscribe { token }).is_err() {
                return;
            }
            // Each Changed frame → one list-level MCP notification (no id, no path).
            loop {
                match read_frame::<_, IpcResponse>(&mut conn) {
                    Ok(IpcResponse::Changed { .. }) => {
                        write_message(
                            &out,
                            &json!({
                                "jsonrpc": "2.0",
                                "method": "notifications/resources/list_changed"
                            }),
                        );
                    }
                    Ok(_) => continue,
                    Err(_) => return, // app stopped / connection closed
                }
            }
        });
}

/// One line per JSON-RPC message; write the line + `\n` + flush atomically under
/// the shared lock so the notify thread's line can never split a response line.
fn write_message(out: &Arc<Mutex<std::io::Stdout>>, msg: &Value) {
    let line = msg.to_string();
    let mut guard = out.lock().expect("stdout lock poisoned");
    // A broken stdout pipe means the client is gone; nothing to do but drop it.
    let _ = guard.write_all(line.as_bytes());
    let _ = guard.write_all(b"\n");
    let _ = guard.flush();
}

/// Read line-delimited JSON-RPC from stdin, dispatch each request, and write a
/// single-line response (notifications produce no response). Returns on EOF.
fn run_stdio_loop(token: &str, manifest: &CapabilityManifest, out: Arc<Mutex<std::io::Stdout>>) {
    use std::io::BufRead as _;

    let stdin = std::io::stdin();
    // The IPC caller injects the real token into every outgoing request, so the
    // dispatch logic can build requests with a placeholder token and stay token-
    // agnostic (the token is a transport concern, not a dispatch concern).
    let mut call = |req: IpcRequest| ipc_call(&with_token(req, token));
    // The notify relay is started lazily: at most once, only after the client
    // sends `notifications/initialized`, and only if the manifest advertises
    // resources.listChanged. This prevents emitting a list_changed notification
    // before the handshake completes or when the capability is off.
    let mut relay_started = false;
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                // stdin closed / read error → treat as EOF.
                tracing::warn!(error = %e, "stashpeak-mcp: stdin read error; exiting");
                return;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(req) => {
                let id = req.get("id").cloned();
                let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                let params = req.get("params").cloned().unwrap_or(Value::Null);
                if method.is_empty() {
                    // A parsed-but-invalid request (object with no method): reply
                    // -32600. Per JSON-RPC, use the message's id if present, else
                    // null. Keep the stream alive.
                    let rid = id.unwrap_or(Value::Null);
                    write_message(&out, &rpc_error(rid, -32600, "invalid request: no method"));
                    continue;
                }
                // The client signalled it finished initializing: now it is safe to
                // start the notify relay (once), but only if the capability is on.
                if method == "notifications/initialized"
                    && manifest.resources_list_changed
                    && !relay_started
                {
                    spawn_notify_relay(token.to_string(), out.clone());
                    relay_started = true;
                }
                if let Some(resp) = dispatch(method, id, &params, manifest, &mut call) {
                    write_message(&out, &resp);
                }
            }
            Err(_) => {
                // Parse failure: per JSON-RPC, reply -32700 with id: null and keep
                // the stream alive so a caller is never left hanging on a reply.
                write_message(&out, &rpc_error(Value::Null, -32700, "parse error"));
            }
        }
    }
}

/// Build a JSON-RPC success response.
fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Build a JSON-RPC error response.
fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Wrap text as an MCP tool result (success).
fn tool_text(text: String) -> Value {
    json!({ "content": [ { "type": "text", "text": text } ], "isError": false })
}

/// Wrap text as an MCP tool result flagged isError (RECOVERABLE — §8.3).
fn tool_error(text: String) -> Value {
    json!({ "content": [ { "type": "text", "text": text } ], "isError": true })
}

/// The InputSchema (JSON Schema) for a tool, by name.
fn tool_input_schema(name: &str) -> Value {
    match name {
        "kb_search" => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "default": 10 }
            },
            "required": ["query"]
        }),
        "kb_read_note" => json!({
            "type": "object",
            "properties": { "canonical": { "type": "string" } },
            "required": ["canonical"]
        }),
        // kb_list (and any unknown) → no inputs.
        _ => json!({ "type": "object", "properties": {} }),
    }
}

/// The testable dispatch core. Pure over an injectable IPC caller so the inline
/// tests can pass a mock `call` returning canned `IpcResponse`s — no live socket.
/// Returns `Some(response_value)` for requests, `None` for notifications.
fn dispatch(
    method: &str,
    id: Option<Value>,
    params: &Value,
    manifest: &CapabilityManifest,
    call: &mut dyn FnMut(IpcRequest) -> Result<IpcResponse, String>,
) -> Option<Value> {
    use stashpeak_lib::mcp::uri::{canonical_to_uri, uri_to_canonical};

    // A message with NO id is a notification: it never gets a response.
    let is_notification = id.is_none();
    let rid = id.unwrap_or(Value::Null);

    match method {
        // ---- notifications (no response) ----
        "notifications/initialized" => None,
        _ if is_notification => {
            // Any other notification we don't act on: swallow silently.
            None
        }

        // ---- initialize: capabilities + version negotiation from the manifest ----
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            let negotiated = match requested {
                Some(v) if manifest.protocol_versions.iter().any(|p| p == v) => v.to_string(),
                // Unknown/absent → the shim's preferred (first in the pinned list).
                _ => manifest
                    .protocol_versions
                    .first()
                    .cloned()
                    .unwrap_or_default(),
            };
            Some(rpc_result(
                rid,
                json!({
                    "protocolVersion": negotiated,
                    "serverInfo": {
                        "name": manifest.server_name,
                        "version": manifest.server_version
                    },
                    "capabilities": {
                        "resources": { "listChanged": manifest.resources_list_changed },
                        "tools": { "listChanged": manifest.tools_list_changed }
                    }
                }),
            ))
        }

        // ---- ping ----
        "ping" => Some(rpc_result(rid, json!({}))),

        // ---- resources/list ----
        "resources/list" => match call(IpcRequest::List {
            token: String::new(),
        }) {
            Ok(IpcResponse::List { paths }) => {
                let resources: Vec<Value> = paths
                    .iter()
                    .map(|p| {
                        json!({
                            "uri": canonical_to_uri(p),
                            "name": p,
                            "mimeType": "text/markdown"
                        })
                    })
                    .collect();
                Some(rpc_result(rid, json!({ "resources": resources })))
            }
            Ok(IpcResponse::Error { kind, message }) => {
                Some(rpc_error(rid, -32603, &format!("{kind}: {message}")))
            }
            Ok(_) => Some(rpc_error(rid, -32603, "unexpected response to List")),
            Err(e) => Some(rpc_error(rid, -32603, &e)),
        },

        // ---- resources/read ----
        "resources/read" => {
            let uri = match params.get("uri").and_then(Value::as_str) {
                Some(u) => u.to_string(),
                None => return Some(rpc_error(rid, -32602, "invalid params: missing uri")),
            };
            let canonical = match uri_to_canonical(&uri) {
                Ok(c) => c,
                Err(e) => return Some(rpc_error(rid, -32602, &format!("invalid uri: {e}"))),
            };
            match call(IpcRequest::ReadNote {
                token: String::new(),
                canonical,
            }) {
                Ok(IpcResponse::Note { content }) => Some(rpc_result(
                    rid,
                    json!({
                        "contents": [ {
                            "uri": uri,
                            "mimeType": "text/markdown",
                            "text": content
                        } ]
                    }),
                )),
                Ok(IpcResponse::Error { kind, message }) => {
                    Some(rpc_error(rid, -32603, &format!("{kind}: {message}")))
                }
                Ok(_) => Some(rpc_error(rid, -32603, "unexpected response to ReadNote")),
                Err(e) => Some(rpc_error(rid, -32603, &e)),
            }
        }

        // ---- tools/list ----
        "tools/list" => {
            let tools: Vec<Value> = manifest
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "annotations": { "readOnlyHint": t.read_only },
                        "inputSchema": tool_input_schema(&t.name)
                    })
                })
                .collect();
            Some(rpc_result(rid, json!({ "tools": tools })))
        }

        // ---- tools/call ----
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            let result = dispatch_tool_call(name, &args, call);
            Some(rpc_result(rid, result))
        }

        // ---- unknown method ----
        _ => Some(rpc_error(
            rid,
            -32601,
            &format!("method not found: {method}"),
        )),
    }
}

/// tools/call by name → the matching IPC request → an MCP tool result. An IPC
/// error (Error variant OR connect failure) yields an isError tool result —
/// RECOVERABLE; the stream stays valid (contract §8.3). Never exits the process.
fn dispatch_tool_call(
    name: &str,
    args: &Value,
    call: &mut dyn FnMut(IpcRequest) -> Result<IpcResponse, String>,
) -> Value {
    match name {
        "kb_list" => match call(IpcRequest::List {
            token: String::new(),
        }) {
            Ok(IpcResponse::List { paths }) => tool_text(paths.join("\n")),
            Ok(IpcResponse::Error { kind, message }) => tool_error(format!("{kind}: {message}")),
            Ok(_) => tool_error("unexpected response to List".to_string()),
            Err(e) => tool_error(e),
        },

        "kb_read_note" => {
            let canonical = match args.get("canonical").and_then(Value::as_str) {
                Some(c) if !c.is_empty() => c.to_string(),
                _ => return tool_error("missing required argument: canonical".to_string()),
            };
            match call(IpcRequest::ReadNote {
                token: String::new(),
                canonical,
            }) {
                Ok(IpcResponse::Note { content }) => tool_text(content),
                Ok(IpcResponse::Error { kind, message }) => {
                    tool_error(format!("{kind}: {message}"))
                }
                Ok(_) => tool_error("unexpected response to ReadNote".to_string()),
                Err(e) => tool_error(e),
            }
        }

        "kb_search" => {
            let query = match args.get("query").and_then(Value::as_str) {
                Some(q) if !q.is_empty() => q.to_string(),
                _ => return tool_error("missing required argument: query".to_string()),
            };
            // Schema advertises { integer, minimum: 1, default: 10 }. Mirror it:
            // a missing limit, or one below 1 (including negatives), falls back to
            // the documented default of 10 rather than silently becoming 0.
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .filter(|&n| n >= 1)
                .map(|n| n as usize)
                .unwrap_or(10);
            match call(IpcRequest::Search {
                token: String::new(),
                query,
                limit,
            }) {
                Ok(IpcResponse::Search { hits }) => {
                    if hits.is_empty() {
                        tool_text("No matches.".to_string())
                    } else {
                        let rendered = hits
                            .iter()
                            .map(|h| format!("{} (score {})\n  {}", h.path, h.score, h.snippet))
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        tool_text(rendered)
                    }
                }
                Ok(IpcResponse::Error { kind, message }) => {
                    tool_error(format!("{kind}: {message}"))
                }
                Ok(_) => tool_error("unexpected response to Search".to_string()),
                Err(e) => tool_error(e),
            }
        }

        // Unknown tool name → isError result (NOT a JSON-RPC error, NOT a crash).
        _ => tool_error(format!("unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stashpeak_lib::kb::search::SearchHit;
    use stashpeak_lib::mcp::manifest::{CapabilityManifest, ToolDecl};

    /// A manifest mirroring the v1 shape, with fixed values so the asserts are
    /// stable regardless of the crate version.
    fn test_manifest() -> CapabilityManifest {
        CapabilityManifest {
            server_name: "stashpeak-kb".to_string(),
            server_version: "9.9.9".to_string(),
            protocol_versions: vec!["2025-06-18".to_string(), "2025-03-26".to_string()],
            resources_list_changed: true,
            tools_list_changed: false,
            tools: vec![
                ToolDecl {
                    name: "kb_search".to_string(),
                    description: "search".to_string(),
                    read_only: true,
                },
                ToolDecl {
                    name: "kb_read_note".to_string(),
                    description: "read".to_string(),
                    read_only: true,
                },
                ToolDecl {
                    name: "kb_list".to_string(),
                    description: "list".to_string(),
                    read_only: true,
                },
            ],
        }
    }

    /// Wrap a closure as the injectable IPC caller `dispatch` expects.
    fn caller(
        mut f: impl FnMut(IpcRequest) -> Result<IpcResponse, String>,
    ) -> impl FnMut(IpcRequest) -> Result<IpcResponse, String> {
        move |req| f(req)
    }

    #[test]
    fn initialize_returns_serverinfo_and_capabilities() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("initialize must not hit IPC"));
        let resp = dispatch(
            "initialize",
            Some(json!(1)),
            &json!({ "protocolVersion": "2025-06-18" }),
            &m,
            &mut call,
        )
        .expect("initialize returns a response");
        assert_eq!(resp["id"], json!(1));
        let result = &resp["result"];
        assert_eq!(result["serverInfo"]["name"], "stashpeak-kb");
        assert_eq!(result["serverInfo"]["version"], "9.9.9");
        assert_eq!(result["capabilities"]["resources"]["listChanged"], true);
        assert_eq!(result["capabilities"]["tools"]["listChanged"], false);
        // Supported version is echoed back.
        assert_eq!(result["protocolVersion"], "2025-06-18");
    }

    #[test]
    fn initialize_negotiates_supported_version() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("no IPC"));
        // A supported but non-preferred version is echoed exactly.
        let resp = dispatch(
            "initialize",
            Some(json!(2)),
            &json!({ "protocolVersion": "2025-03-26" }),
            &m,
            &mut call,
        )
        .unwrap();
        assert_eq!(resp["result"]["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn initialize_unsupported_version_falls_back_to_preferred() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("no IPC"));
        let resp = dispatch(
            "initialize",
            Some(json!(3)),
            &json!({ "protocolVersion": "1999-01-01" }),
            &m,
            &mut call,
        )
        .unwrap();
        // Falls back to the shim's preferred (first pinned).
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
    }

    #[test]
    fn tools_list_has_three_readonly_tools_with_schemas() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("no IPC"));
        let resp = dispatch("tools/list", Some(json!(4)), &Value::Null, &m, &mut call).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
        for t in tools {
            assert_eq!(t["annotations"]["readOnlyHint"], true);
            assert_eq!(t["inputSchema"]["type"], "object");
        }
        // kb_search advertises a required "query".
        let search = tools.iter().find(|t| t["name"] == "kb_search").unwrap();
        assert_eq!(search["inputSchema"]["required"][0], "query");
    }

    #[test]
    fn resources_list_maps_paths_to_uris() {
        let m = test_manifest();
        let mut call = caller(|req| match req {
            IpcRequest::List { .. } => Ok(IpcResponse::List {
                paths: vec!["Projects/Q3 plan.md".to_string(), "a.md".to_string()],
            }),
            _ => panic!("unexpected request"),
        });
        let resp = dispatch(
            "resources/list",
            Some(json!(5)),
            &Value::Null,
            &m,
            &mut call,
        )
        .unwrap();
        let resources = resp["result"]["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[0]["uri"], "kb://vault/Projects/Q3%20plan.md");
        assert_eq!(resources[0]["name"], "Projects/Q3 plan.md");
        assert_eq!(resources[0]["mimeType"], "text/markdown");
    }

    #[test]
    fn tools_call_kb_read_note_maps_canonical_to_text() {
        let m = test_manifest();
        let mut call = caller(|req| match req {
            IpcRequest::ReadNote { canonical, .. } => {
                assert_eq!(canonical, "a.md");
                Ok(IpcResponse::Note {
                    content: "hello world".to_string(),
                })
            }
            _ => panic!("unexpected request"),
        });
        let resp = dispatch(
            "tools/call",
            Some(json!(6)),
            &json!({ "name": "kb_read_note", "arguments": { "canonical": "a.md" } }),
            &m,
            &mut call,
        )
        .unwrap();
        let result = &resp["result"];
        assert_eq!(result["isError"], false);
        assert_eq!(result["content"][0]["type"], "text");
        assert_eq!(result["content"][0]["text"], "hello world");
    }

    #[test]
    fn tools_call_ipc_error_is_an_iserror_result_not_a_jsonrpc_error() {
        let m = test_manifest();
        let mut call = caller(|req| match req {
            IpcRequest::ReadNote { .. } => Ok(IpcResponse::Error {
                kind: "Kb".to_string(),
                message: "note unreadable".to_string(),
            }),
            _ => panic!("unexpected request"),
        });
        let resp = dispatch(
            "tools/call",
            Some(json!(7)),
            &json!({ "name": "kb_read_note", "arguments": { "canonical": "x.md" } }),
            &m,
            &mut call,
        )
        .unwrap();
        // It's a successful JSON-RPC result whose payload is an isError tool result.
        assert!(resp.get("error").is_none(), "must NOT be a JSON-RPC error");
        let result = &resp["result"];
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Kb"));
    }

    #[test]
    fn tools_call_connect_failure_is_an_iserror_result() {
        let m = test_manifest();
        let mut call = caller(|_| Err("Stashpeak is not running".to_string()));
        let resp = dispatch(
            "tools/call",
            Some(json!(8)),
            &json!({ "name": "kb_list", "arguments": {} }),
            &m,
            &mut call,
        )
        .unwrap();
        assert!(resp.get("error").is_none());
        assert_eq!(resp["result"]["isError"], true);
        assert_eq!(
            resp["result"]["content"][0]["text"],
            "Stashpeak is not running"
        );
    }

    #[test]
    fn tools_call_unknown_tool_is_an_iserror_result() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("unknown tool must not hit IPC"));
        let resp = dispatch(
            "tools/call",
            Some(json!(9)),
            &json!({ "name": "kb_delete_everything", "arguments": {} }),
            &m,
            &mut call,
        )
        .unwrap();
        assert!(resp.get("error").is_none());
        assert_eq!(resp["result"]["isError"], true);
    }

    #[test]
    fn tools_call_kb_search_renders_hits() {
        let m = test_manifest();
        let mut call = caller(|req| match req {
            IpcRequest::Search { query, limit, .. } => {
                assert_eq!(query, "alpha");
                assert_eq!(limit, 10); // default
                Ok(IpcResponse::Search {
                    hits: vec![SearchHit {
                        path: "a.md".to_string(),
                        snippet: "alpha beta".to_string(),
                        score: 3,
                    }],
                })
            }
            _ => panic!("unexpected request"),
        });
        let resp = dispatch(
            "tools/call",
            Some(json!(10)),
            &json!({ "name": "kb_search", "arguments": { "query": "alpha" } }),
            &m,
            &mut call,
        )
        .unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("a.md"));
        assert!(text.contains("score 3"));
        assert!(text.contains("alpha beta"));
    }

    #[test]
    fn tools_call_kb_search_clamps_out_of_range_limit_to_default() {
        // Schema advertises minimum:1, default:10. A limit below 1 (here 0) must
        // fall back to the documented default rather than passing 0 to the parser.
        let m = test_manifest();
        let mut call = caller(|req| match req {
            IpcRequest::Search { query, limit, .. } => {
                assert_eq!(query, "alpha");
                assert_eq!(limit, 10, "limit < 1 should clamp to the default 10");
                Ok(IpcResponse::Search { hits: vec![] })
            }
            _ => panic!("unexpected request"),
        });
        let resp = dispatch(
            "tools/call",
            Some(json!(20)),
            &json!({ "name": "kb_search", "arguments": { "query": "alpha", "limit": 0 } }),
            &m,
            &mut call,
        )
        .unwrap();
        assert_eq!(resp["result"]["isError"], false);
    }

    #[test]
    fn kb_search_schema_advertises_minimum_and_default_limit() {
        // The advertised schema must match the parser's contract (minimum 1, default 10).
        let schema = tool_input_schema("kb_search");
        let limit = &schema["properties"]["limit"];
        assert_eq!(limit["type"], "integer");
        assert_eq!(limit["minimum"], 1);
        assert_eq!(limit["default"], 10);
    }

    #[test]
    fn resources_read_bad_uri_is_invalid_params() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("bad uri must not hit IPC"));
        let resp = dispatch(
            "resources/read",
            Some(json!(11)),
            &json!({ "uri": "file:///etc/passwd" }),
            &m,
            &mut call,
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32602);
    }

    #[test]
    fn resources_read_good_uri_returns_note_text() {
        let m = test_manifest();
        let mut call = caller(|req| match req {
            IpcRequest::ReadNote { canonical, .. } => {
                assert_eq!(canonical, "a.md");
                Ok(IpcResponse::Note {
                    content: "# Title\nbody".to_string(),
                })
            }
            _ => panic!("unexpected request"),
        });
        let resp = dispatch(
            "resources/read",
            Some(json!(12)),
            &json!({ "uri": "kb://vault/a.md" }),
            &m,
            &mut call,
        )
        .unwrap();
        let contents = &resp["result"]["contents"][0];
        assert_eq!(contents["uri"], "kb://vault/a.md");
        assert_eq!(contents["mimeType"], "text/markdown");
        assert_eq!(contents["text"], "# Title\nbody");
    }

    #[test]
    fn unknown_method_is_minus_32601() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("no IPC"));
        let resp = dispatch(
            "no/such/method",
            Some(json!(13)),
            &Value::Null,
            &m,
            &mut call,
        )
        .unwrap();
        assert_eq!(resp["error"]["code"], -32601);
        assert!(resp["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no/such/method"));
    }

    #[test]
    fn notifications_initialized_returns_none() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("no IPC"));
        let resp = dispatch(
            "notifications/initialized",
            None,
            &Value::Null,
            &m,
            &mut call,
        );
        assert!(resp.is_none());
    }

    #[test]
    fn ping_returns_empty_result() {
        let m = test_manifest();
        let mut call = caller(|_| panic!("no IPC"));
        let resp = dispatch("ping", Some(json!(14)), &Value::Null, &m, &mut call).unwrap();
        assert_eq!(resp["result"], json!({}));
    }
}
