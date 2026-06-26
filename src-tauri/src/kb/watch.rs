use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

pub fn content_hash(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

#[derive(Default)]
pub struct EchoFilter {
    seen: Mutex<HashSet<(String, u64)>>,
}

impl EchoFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, path: &str, hash: u64) {
        self.seen.lock().unwrap().insert((path.to_string(), hash));
    }

    pub fn is_echo(&self, path: &str, hash: u64) -> bool {
        self.seen.lock().unwrap().contains(&(path.to_string(), hash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_filter_recognizes_self_writes() {
        let f = EchoFilter::new();
        let h = content_hash(b"hello");
        assert!(!f.is_echo("a.md", h));
        f.record("a.md", h);
        assert!(f.is_echo("a.md", h)); // same path+content = our own write
        assert!(!f.is_echo("a.md", content_hash(b"changed"))); // foreign edit
    }
}
