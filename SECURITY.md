# Security Policy

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use [GitHub Security Advisories](https://github.com/Stashpeak/stashpeak-app/security/advisories/new) to report privately. Only you and the maintainer will be able to see the report.

Include as much detail as you can: steps to reproduce, affected version, and potential impact.

## Response Time

|                   | Target         |
| ----------------- | -------------- |
| Acknowledgement   | Within 7 days  |
| Fix or mitigation | Within 90 days |

For critical vulnerabilities a fix will be prioritized sooner.

## Scope

Stashpeak is a local-first Tauri desktop app: a Rust backend (SQLite, the OS keychain, and an HTTP egress broker for spend connectors) behind a WebView frontend, communicating over Tauri's IPC. Reports are welcome for vulnerabilities in **Stashpeak itself**, including:

- The **Rust core** and its **Tauri IPC commands** — the `#[tauri::command]` surface in `src-tauri/` that the frontend can invoke.
- The **capability / permission model** (`src-tauri/capabilities/`) — anything that lets the WebView reach a command or OS resource it should not.
- **Credential handling** — API keys stored in the **OS keychain** via the `keyring` crate, and the invariant that a raw secret never enters a connector body.
- The **connector egress broker** (`src-tauri/src/connectors/`) — host-brokered network access, the per-connector network allowlist (fail-closed), and credential injection.
- The **dependency chain** (npm + cargo).

Out of scope: vulnerabilities in the third-party AI provider APIs and services Stashpeak connects to (e.g. Anthropic, OpenAI, Google Cloud), and issues in the underlying OS, hardware, or the system keychain implementation itself.

## Supported Versions

Only the latest release receives security fixes.
