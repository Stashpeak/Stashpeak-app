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
