-- ============================================================
-- MCP per-client token store
-- One row per minted client token. The token itself is NEVER stored;
-- only its SHA-256 hash (a verifier). Scope is keyed here server-side,
-- never embedded in the token body. `revoked` is a soft-delete kill switch.
-- (MCP_KB_CONTRACT.md §6 / M3)
-- ============================================================
CREATE TABLE mcp_clients (
    id          TEXT    PRIMARY KEY,             -- opaque client id (UUID-like)
    label       TEXT    NOT NULL,                -- user-authored display label
    token_hash  TEXT    NOT NULL,               -- hex SHA-256 of the raw token
    scope       TEXT    NOT NULL DEFAULT 'read', -- 'read' | 'read_write'
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    revoked     INTEGER NOT NULL DEFAULT 0       -- 1 = revoked (kill switch)
);

-- Validation looks up by token_hash; index it for the per-call hot path.
CREATE INDEX mcp_clients_token_hash ON mcp_clients(token_hash);

-- ============================================================
-- MCP read activity ledger
-- One row per read tool-call. Symmetric to the (future) write ledger.
-- Backs the "what agents read from your KB" panel + the bulk-read brake.
-- (MCP_KB_CONTRACT.md §7.2 / M5)
-- ============================================================
CREATE TABLE mcp_activity_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT    NOT NULL,             -- stable routing key (mcp_clients.id); NOT a FK so rows survive client deletion
    client_label  TEXT    NOT NULL,             -- display snapshot of the token label at record time (may diverge from mcp_clients.label after rename)
    tool          TEXT    NOT NULL,             -- 'kb_list' | 'kb_read_note' | 'kb_search'
    target        TEXT    NOT NULL,             -- canonical path or query
    result_count  INTEGER NOT NULL,            -- note count / hit count
    at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- The bulk-read brake queries recent rows per client by time; key by client_id (stable).
CREATE INDEX mcp_activity_ledger_client_time ON mcp_activity_ledger(client_id, at);
