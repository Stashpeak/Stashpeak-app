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

pub fn search(vault_root: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, KbError> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for path in read::list(vault_root)? {
        let body = match read::read_note(vault_root, &path) {
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
            .find(|l| l.to_lowercase().contains(&needle))
            .unwrap_or("")
            .chars()
            .take(SNIPPET_MAX)
            .collect::<String>();
        hits.push(SearchHit {
            path,
            snippet,
            score,
        });
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.path.cmp(&b.path)));
    hits.truncate(limit);
    Ok(hits)
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
}
