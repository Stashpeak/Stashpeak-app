#!/usr/bin/env bash
set -euo pipefail
# Stdout discipline: with the app down, the shim must exit non-zero, diagnose on
# STDERR, and write NOTHING to STDOUT (a stray banner/panic line corrupts MCP).
cargo build --bin stashpeak-mcp --manifest-path src-tauri/Cargo.toml

BIN="src-tauri/target/debug/stashpeak-mcp"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"   # Windows

OUT="$(mktemp)"; ERR="$(mktemp)"
set +e
STASHPEAK_MCP_TOKEN="spk_mcp_smoke" "$BIN" </dev/null >"$OUT" 2>"$ERR"
code=$?
set -e

if [ -s "$OUT" ]; then
  echo "FAIL: stashpeak-mcp wrote to stdout when it must not have:"; cat "$OUT"; exit 1
fi
if [ "$code" -eq 0 ]; then
  echo "FAIL: shim should exit non-zero when the app IPC is unavailable"; exit 1
fi
if [ ! -s "$ERR" ]; then
  echo "FAIL: shim should diagnose the startup failure on stderr"; exit 1
fi
echo "OK: stdout empty on failure; diagnostics on stderr; non-zero exit (code $code)."
echo "--- stderr was: ---"; cat "$ERR"
