use crate::kb::{read, KbError};
use serde::{Deserialize, Serialize};
use std::path::Path;

// `Deserialize` is required so Plan 3's IPC layer can deserialize `Vec<SearchHit>` over the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub snippet: String,
    pub score: usize,
}

const SNIPPET_MAX: usize = 200;

/// Rank ONLY the supplied candidate paths (the caller has already gated them).
/// Excluded notes must be absent from `candidates` so they are never opened,
/// scored, or counted — preventing ranking/hit-count/timing side-channel leaks.
pub fn search_in(
    vault_root: &Path,
    candidates: &[String],
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, KbError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for path in candidates {
        let body = match read::read_note(vault_root, path) {
            Ok(b) => b,
            Err(_) => continue, // unreadable note: skip, never fail the whole search
        };
        let hay = body.to_lowercase();
        // `str::matches` counts NON-overlapping occurrences (e.g. "aa" in "aaa" = 1),
        // which is fine for a relevance rank — we only need a relative ordering signal.
        let score = hay.matches(&needle).count();
        if score == 0 {
            continue;
        }
        let snippet = body
            .lines()
            .find_map(|line| {
                let lower = line.to_lowercase();
                let hit = lower.find(&needle)?;
                let start = lower[..hit].chars().count().saturating_sub(SNIPPET_MAX / 2);
                Some(
                    line.chars()
                        .skip(start)
                        .take(SNIPPET_MAX)
                        .collect::<String>(),
                )
            })
            .unwrap_or_default();
        hits.push(SearchHit {
            path: path.clone(),
            snippet,
            score,
        });
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.path.cmp(&b.path)));
    hits.truncate(limit);
    Ok(hits)
}

/// Whole-vault search. Enumerates all notes via `read::list` and ranks them.
/// For a pre-gated search (e.g. access control), use `search_in` directly with
/// a filtered candidate slice so excluded notes are never opened or scored.
pub fn search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError> {
    search_in(vault_root, &read::list(vault_root)?, query, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn ranks_by_occurrence_and_snippets_the_first_hit() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("one.md"), "alpha beta\nalpha again").unwrap(); // 2 hits
        fs::write(root.join("two.md"), "beta only").unwrap(); // 0 hits
        fs::write(root.join("three.md"), "ALPHA upper").unwrap(); // 1 hit (case-insensitive)

        let hits = search(root, "alpha", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "one.md"); // highest score first
        assert_eq!(hits[0].score, 2);
        assert!(hits[0].snippet.contains("alpha beta"));
        assert_eq!(hits[1].path, "three.md");
    }

    #[test]
    fn respects_limit() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "x x").unwrap();
        fs::write(root.join("b.md"), "x").unwrap();
        assert_eq!(search(root, "x", 1).unwrap().len(), 1);
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "anything").unwrap();
        assert!(search(root, "", 10).unwrap().is_empty());
    }

    #[test]
    fn unreadable_note_is_skipped_not_fatal() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("good.md"), "alpha here").unwrap();
        fs::write(root.join("bad.md"), [0xFF, 0xFE, 0x00, 0x9C]).unwrap(); // invalid UTF-8
        let hits = search(root, "alpha", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "good.md");
    }

    #[test]
    fn snippet_truncates_to_max_chars() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("long.md"), "x".repeat(300)).unwrap();
        let hits = search(root, "x", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet.chars().count(), 200);
    }

    #[test]
    fn snippet_centers_on_match_in_long_line() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let line = format!("{}NEEDLE tail", "x".repeat(400));
        fs::write(root.join("long.md"), line).unwrap();
        let hits = search(root, "needle", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].snippet.to_lowercase().contains("needle"),
            "snippet must contain the match"
        );
        assert!(hits[0].snippet.chars().count() <= 200);
    }

    #[test]
    fn search_in_restricts_to_supplied_candidates() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // Two notes both match the query.
        fs::write(root.join("included.md"), "alpha content").unwrap();
        fs::write(root.join("excluded.md"), "alpha content").unwrap();
        // Only one is in the candidate slice — the other must not appear.
        let candidates = vec!["included.md".to_string()];
        let hits = search_in(root, &candidates, "alpha", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "included.md");
    }
}
