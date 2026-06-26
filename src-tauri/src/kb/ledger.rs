use crate::db;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// The bulk-read brake decision returned by `check_read_budget`.
/// `Notice` = a non-dismissable warning (N reads in T seconds);
/// `Pause`  = a hard cap requiring re-confirmation (MCP_KB_CONTRACT.md §7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Brake {
    Allow,
    Notice,
    Pause,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")] // repo convention: camelCase to the frontend; Plan 4 reads `clientId` / `clientLabel` / `resultCount`
pub struct LedgerRow {
    pub client_id: String,
    pub client_label: String,
    pub tool: String,
    pub target: String,
    pub result_count: usize,
    pub at: String,
}

/// Bulk-read brake tuning (a single point of truth). A sliding window of
/// `WINDOW_SECS` seconds; `NOTICE_THRESHOLD` reads raises a non-dismissable
/// notice; `PAUSE_THRESHOLD` reads pauses the client pending re-confirmation.
const WINDOW_SECS: i64 = 60;
const NOTICE_THRESHOLD: i64 = 30;
const PAUSE_THRESHOLD: i64 = 100;

// ---- public wrappers --------------------------------------------------------

pub fn record_read(
    client_id: &str,
    client_label: &str,
    tool: &str,
    target: &str,
    result_count: usize,
) -> Result<(), String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    record_read_with_conn(&conn, client_id, client_label, tool, target, result_count)
}

pub fn recent(limit: usize) -> Result<Vec<LedgerRow>, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    recent_with_conn(&conn, limit)
}

pub fn check_read_budget(client_id: &str) -> Result<Brake, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    check_read_budget_with_conn(&conn, client_id)
}

// ---- injection-seam cores (unit-tested on an in-memory connection) ----------

fn record_read_with_conn(
    conn: &Connection,
    client_id: &str,
    client_label: &str,
    tool: &str,
    target: &str,
    result_count: usize,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mcp_activity_ledger (client_id, client_label, tool, target, result_count)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            client_id,
            client_label,
            tool,
            target,
            i64::try_from(result_count).unwrap_or(i64::MAX)
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn recent_with_conn(conn: &Connection, limit: usize) -> Result<Vec<LedgerRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT client_id, client_label, tool, target, result_count, at
             FROM mcp_activity_ledger ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            Ok(LedgerRow {
                client_id: row.get(0)?,
                client_label: row.get(1)?,
                tool: row.get(2)?,
                target: row.get(3)?,
                result_count: row.get::<_, i64>(4)?.max(0) as usize,
                at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Sum a client's read VOLUME within the recent window and map it to a `Brake`.
/// We count notes/hits returned (`result_count`), not just calls, so a single
/// `kb_search`/`kb_list` that returns many notes counts toward the bulk-read
/// brake by what it actually exposed; a zero-result probe still counts as one
/// activity. The window is expressed against SQLite's own clock so the test's
/// just-inserted rows (default `at = now`) all fall inside it.
fn check_read_budget_with_conn(conn: &Connection, client_id: &str) -> Result<Brake, String> {
    let volume: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN result_count > 0 THEN result_count ELSE 1 END), 0)
             FROM mcp_activity_ledger
             WHERE client_id = ?1
               AND at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?2)",
            rusqlite::params![client_id, format!("-{WINDOW_SECS} seconds")],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(if volume >= PAUSE_THRESHOLD {
        Brake::Pause
    } else if volume >= NOTICE_THRESHOLD {
        Brake::Notice
    } else {
        Brake::Allow
    })
}

// ---- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    // ---- Task 4.1 tests --------------------------------------------------------

    #[test]
    fn record_read_inserts_a_row() {
        let conn = db::open_in_memory_migrated();
        record_read_with_conn(&conn, "client-1", "Claude Desktop", "kb_search", "alpha", 3)
            .unwrap();

        let (id, label, tool, target, count): (String, String, String, String, i64) = conn
            .query_row(
                "SELECT client_id, client_label, tool, target, result_count FROM mcp_activity_ledger",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(id, "client-1");
        assert_eq!(label, "Claude Desktop");
        assert_eq!(tool, "kb_search");
        assert_eq!(target, "alpha");
        assert_eq!(count, 3);
    }

    // ---- Task 4.2 tests --------------------------------------------------------

    #[test]
    fn recent_returns_rows_newest_first() {
        let conn = db::open_in_memory_migrated();
        record_read_with_conn(&conn, "client-1", "A", "kb_list", "-", 5).unwrap();
        record_read_with_conn(&conn, "client-1", "A", "kb_read_note", "notes/x.md", 1).unwrap();

        let rows = recent_with_conn(&conn, 10).unwrap();
        assert_eq!(rows.len(), 2);
        // Newest (the read_note) first.
        assert_eq!(rows[0].tool, "kb_read_note");
        assert_eq!(rows[1].tool, "kb_list");
        // Both client_id and client_label must be present.
        assert_eq!(rows[0].client_id, "client-1");
        assert_eq!(rows[0].client_label, "A");
    }

    #[test]
    fn check_read_budget_escalates_allow_notice_pause() {
        let conn = db::open_in_memory_migrated();

        // Below the notice threshold → Allow.
        for _ in 0..(NOTICE_THRESHOLD - 1) {
            record_read_with_conn(&conn, "client-bulk", "Bulk", "kb_read_note", "n.md", 1).unwrap();
        }
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-bulk").unwrap(),
            Brake::Allow
        );

        // Cross the notice threshold → Notice.
        record_read_with_conn(&conn, "client-bulk", "Bulk", "kb_read_note", "n.md", 1).unwrap();
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-bulk").unwrap(),
            Brake::Notice
        );

        // Cross the pause threshold → Pause.
        for _ in 0..(PAUSE_THRESHOLD - NOTICE_THRESHOLD) {
            record_read_with_conn(&conn, "client-bulk", "Bulk", "kb_read_note", "n.md", 1).unwrap();
        }
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-bulk").unwrap(),
            Brake::Pause
        );

        // A DIFFERENT client_id is unaffected (per-client-id budget isolation).
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-quiet").unwrap(),
            Brake::Allow
        );
    }

    #[test]
    fn recent_respects_limit() {
        let conn = db::open_in_memory_migrated();
        for i in 0..5 {
            record_read_with_conn(&conn, "client-1", "A", "kb_list", &format!("t{i}"), 1).unwrap();
        }
        assert_eq!(recent_with_conn(&conn, 3).unwrap().len(), 3);
    }

    #[test]
    fn record_read_accepts_zero_result_count() {
        let conn = db::open_in_memory_migrated();
        record_read_with_conn(&conn, "client-1", "A", "kb_search", "nomatch", 0).unwrap();
        let rows = recent_with_conn(&conn, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].result_count, 0);
    }

    /// Fix 3: two tokens that share a label but have different client_ids must
    /// have independent budgets (the old label-keyed scheme would merge them).
    #[test]
    fn budget_is_isolated_by_client_id_not_label() {
        let conn = db::open_in_memory_migrated();

        // Two different client ids, same label "Shared".
        for _ in 0..NOTICE_THRESHOLD {
            record_read_with_conn(&conn, "client-a", "Shared", "kb_read_note", "n.md", 1).unwrap();
        }
        // client-a has crossed the notice threshold.
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-a").unwrap(),
            Brake::Notice
        );
        // client-b (same label, different id) is completely unaffected.
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-b").unwrap(),
            Brake::Allow
        );
    }

    #[test]
    fn budget_counts_result_volume_not_call_count() {
        let conn = db::open_in_memory_migrated();
        // A SINGLE call that returned a large result set must count by VOLUME, not as
        // one row — otherwise a broad search/list bypasses the bulk-read brake.
        record_read_with_conn(
            &conn,
            "client-x",
            "X",
            "kb_search",
            "broad",
            PAUSE_THRESHOLD as usize,
        )
        .unwrap();
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-x").unwrap(),
            Brake::Pause
        );
        // A zero-result probe still counts as one activity (not zero).
        record_read_with_conn(&conn, "client-z", "Z", "kb_search", "nomatch", 0).unwrap();
        assert_eq!(
            check_read_budget_with_conn(&conn, "client-z").unwrap(),
            Brake::Allow
        );
    }
}
