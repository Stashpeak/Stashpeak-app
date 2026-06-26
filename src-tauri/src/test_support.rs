//! Test-only shared harness for DB-touching tests. `STASHPEAK_DATA_DIR` is
//! process-global, so every test that opens the real DB must serialize on one
//! lock and redirect the data dir to a throwaway migrated temp DB.
#![cfg(test)]

use std::sync::Mutex;

/// Serializes all DB-touching tests (they race on the process-global env var).
pub(crate) static DB_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Run `f` with `STASHPEAK_DATA_DIR` pointed at a fresh migrated temp DB, holding
/// the global DB test lock for the duration. Restores the prior env on return.
pub(crate) fn with_temp_data_dir<F: FnOnce()>(f: F) {
    let _lock = DB_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let db_dir = tempfile::tempdir().expect("create temp data dir");
    let previous = std::env::var_os("STASHPEAK_DATA_DIR");
    // SAFETY: test-only; serialized by DB_TEST_LOCK above.
    unsafe {
        std::env::set_var("STASHPEAK_DATA_DIR", db_dir.path());
    }
    struct Guard(Option<std::ffi::OsString>);
    impl Drop for Guard {
        fn drop(&mut self) {
            // SAFETY: test-only cleanup; still under the lock.
            unsafe {
                match &self.0 {
                    Some(v) => std::env::set_var("STASHPEAK_DATA_DIR", v),
                    None => std::env::remove_var("STASHPEAK_DATA_DIR"),
                }
            }
        }
    }
    let _guard = Guard(previous);
    crate::db::open().expect("open + migrate temp db");
    f();
}
