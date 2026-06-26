use std::collections::HashSet;
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{Map, Value};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::Registry;

const REDACTED: &str = "[REDACTED]";

static KNOWN_SECRETS: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();
static API_KEY_PATTERN: OnceLock<Regex> = OnceLock::new();
static BEARER_PATTERN: OnceLock<Regex> = OnceLock::new();
static ENV_VALUE_PATTERN: OnceLock<Regex> = OnceLock::new();

pub fn init() -> Result<(), LoggingInitError> {
    let log_dir = log_dir()?;
    create_dir_all(&log_dir).map_err(LoggingInitError::CreateLogDir)?;

    let log_file = open_log_file(&log_dir).map_err(LoggingInitError::OpenLogFile)?;
    let sink: Arc<dyn LogSink> = Arc::new(FileLogSink::new(log_file));
    let subscriber = Registry::default().with(SecretScrubbingLayer::new(sink));

    tracing::subscriber::set_global_default(subscriber).map_err(|_| LoggingInitError::SetGlobal)
}

pub fn remember_secret(secret: &str) {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return;
    }

    known_secrets()
        .write()
        .expect("known secret registry lock poisoned")
        .insert(trimmed.to_string());
}

/// Public entry point for scrubbing a short, user-facing string (e.g. a KB
/// search snippet) through the same secret-redaction pipeline the log layer
/// uses. Reuses `scrub_text` so the redaction rules never diverge.
/// (MCP_KB_CONTRACT.md §7.1 — search snippets must not leak embedded secrets.)
pub fn scrub_snippet(s: &str) -> String {
    scrub_text(s)
}

fn log_dir() -> Result<PathBuf, LoggingInitError> {
    Ok(crate::db::data_dir().join("logs"))
}

fn open_log_file(dir: &std::path::Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("stashpeak.log"))
}

fn known_secrets() -> &'static RwLock<HashSet<String>> {
    KNOWN_SECRETS.get_or_init(|| RwLock::new(HashSet::new()))
}

fn api_key_pattern() -> &'static Regex {
    API_KEY_PATTERN
        .get_or_init(|| Regex::new(r"\bsk-[A-Za-z0-9_-]+\b").expect("valid api key regex"))
}

fn bearer_pattern() -> &'static Regex {
    BEARER_PATTERN
        .get_or_init(|| Regex::new(r#"Bearer\s+[^\s"']+"#).expect("valid bearer token regex"))
}

fn env_value_pattern() -> &'static Regex {
    ENV_VALUE_PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?P<name>\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b)(?P<sep>\s*[:=]\s*)(?P<value>"[^"]*"|'[^']*'|[^\s,}]+)"#,
        )
        .expect("valid env var regex")
    })
}

fn scrub_text(input: &str) -> String {
    let with_api_keys = api_key_pattern().replace_all(input, REDACTED).into_owned();
    let with_bearer = bearer_pattern()
        .replace_all(&with_api_keys, format!("Bearer {REDACTED}"))
        .into_owned();
    let with_env_values = env_value_pattern()
        .replace_all(&with_bearer, |caps: &regex::Captures<'_>| {
            format!("{}{}{}", &caps["name"], &caps["sep"], REDACTED)
        })
        .into_owned();

    let mut known_secret_values = known_secrets()
        .read()
        .expect("known secret registry lock poisoned")
        .iter()
        .filter(|secret| !secret.is_empty())
        .cloned()
        .collect::<Vec<_>>();
    known_secret_values.sort_by_key(|secret| std::cmp::Reverse(secret.len()));

    known_secret_values
        .into_iter()
        .fold(with_env_values, |acc, secret| {
            acc.replace(&secret, REDACTED)
        })
}

#[derive(Debug)]
pub enum LoggingInitError {
    CreateLogDir(io::Error),
    OpenLogFile(io::Error),
    SetGlobal,
}

impl std::fmt::Display for LoggingInitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CreateLogDir(err) => write!(f, "failed to create log directory: {err}"),
            Self::OpenLogFile(err) => write!(f, "failed to open log file: {err}"),
            Self::SetGlobal => write!(f, "failed to configure tracing subscriber"),
        }
    }
}

impl std::error::Error for LoggingInitError {}

trait LogSink: Send + Sync {
    fn write_line(&self, line: &str) -> io::Result<()>;
}

struct FileLogSink {
    writer: Mutex<BufWriter<File>>,
}

impl FileLogSink {
    fn new(file: File) -> Self {
        Self {
            writer: Mutex::new(BufWriter::new(file)),
        }
    }
}

impl LogSink for FileLogSink {
    fn write_line(&self, line: &str) -> io::Result<()> {
        let mut writer = self.writer.lock().expect("log writer lock poisoned");
        writer.write_all(line.as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()
    }
}

struct SecretScrubbingLayer {
    sink: Arc<dyn LogSink>,
}

impl SecretScrubbingLayer {
    fn new(sink: Arc<dyn LogSink>) -> Self {
        Self { sink }
    }
}

impl<S> Layer<S> for SecretScrubbingLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = JsonVisitor::default();
        event.record(&mut visitor);

        let metadata = event.metadata();
        let log_record = serde_json::json!({
            "timestamp_unix_ms": unix_timestamp_ms(),
            "level": metadata.level().as_str(),
            "target": metadata.target(),
            "fields": visitor.fields,
        });

        if let Ok(serialized) = serde_json::to_string(&log_record) {
            let scrubbed = scrub_text(&serialized);
            let _ = self.sink.write_line(&scrubbed);
        }
    }
}

fn unix_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before unix epoch")
        .as_millis()
}

#[derive(Default)]
struct JsonVisitor {
    fields: Map<String, Value>,
}

impl tracing::field::Visit for JsonVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.fields
            .insert(field.name().to_string(), Value::String(value.to_string()));
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), Value::Bool(value));
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.fields.insert(
            field.name().to_string(),
            Value::String(format!("{value:?}")),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemorySink {
        lines: Mutex<Vec<String>>,
    }

    impl MemorySink {
        fn output(&self) -> String {
            self.lines
                .lock()
                .expect("memory sink lock poisoned")
                .join("\n")
        }
    }

    impl LogSink for MemorySink {
        fn write_line(&self, line: &str) -> io::Result<()> {
            self.lines
                .lock()
                .expect("memory sink lock poisoned")
                .push(line.to_string());
            Ok(())
        }
    }

    #[test]
    fn scrubs_known_patterns_from_text() {
        remember_secret("my-super-secret-value");

        let scrubbed = scrub_text(
            r#"Authorization=Bearer abc123 OPENAI_API_KEY=sk-test-123 local_token=my-super-secret-value"#,
        );

        assert!(!scrubbed.contains("abc123"));
        assert!(!scrubbed.contains("sk-test-123"));
        assert!(!scrubbed.contains("my-super-secret-value"));
        assert!(scrubbed.contains(REDACTED));
    }

    #[test]
    fn scrubs_logged_events_before_writing_output() {
        let sink = Arc::new(MemorySink::default());
        let subscriber = Registry::default().with(SecretScrubbingLayer::new(sink.clone()));
        let fake_key = "my-super-secret-value";

        remember_secret(fake_key);

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(
                message = "calling provider",
                authorization = "Bearer token-123",
                openai_api_key = "sk-live-123",
                keychain_value = fake_key
            );
        });

        let output = sink.output();

        assert!(output.contains("\"level\":\"INFO\""));
        assert!(!output.contains("token-123"));
        assert!(!output.contains("sk-live-123"));
        assert!(!output.contains(fake_key));
        assert!(output.contains(REDACTED));
    }
}
