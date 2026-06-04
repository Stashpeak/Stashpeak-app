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

## Known accepted dependency risks

Two advisories surfaced by Dependabot cannot be resolved by a version bump today: the only patched version is unreachable because an upstream dependency pins an older line. Rather than silently closing them, they are tracked here — and dismissed in Dependabot with a link to this section — and re-evaluated on the trigger noted below. See #171 for the full Dependabot enablement sweep.

| Advisory | Package (locked) | Scope | Why accepted | Re-check trigger |
| --- | --- | --- | --- | --- |
| [GHSA-cq8v-f236-94qc](https://github.com/advisories/GHSA-cq8v-f236-94qc) | `rand` 0.7.3 | **Build-time only** | Reachable only across a **`[build-dependencies]`** edge: `selectors —(build-dep)→ phf_codegen → phf_generator → rand 0.7.3` (perfect-hash codegen run inside `selectors`' build script). `selectors` / `kuchikiki` / `tauri-utils` are pulled by the `tauri` runtime crate, but because the `selectors → phf_codegen` edge is a build dependency, `rand` 0.7.3 is **not linked into the runtime binary** — `cargo tree -i rand@0.7.3 -e normal` prints nothing. The advisory (unsoundness when a custom logger calls `rand::rng()`) is unreachable from compile-time codegen. No semver-compatible fix exists for the 0.7 line; the runtime copy (`rand` 0.9.3, via `tauri-plugin-notification`) and the build/dev copy (0.8.6) are already patched. | Next Tauri **minor/major** that drops `kuchikiki` or moves `tauri-utils` off `rand` 0.7. |
| [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) | `glib` 0.18.5 | **Linux target only** | Transitive via `gtk 0.18`, which is pinned by Tauri's Linux webview stack (`wry`/`tao`). `glib 0.20` is unreachable (`gtk 0.18.2` requires `glib ^0.18`), so the only fix is an upstream Tauri move to the gtk-0.20 stack. The crate does not compile on the Windows or macOS targets, and the soundness issue in `VariantStrIter` is not exercised by our usage. | Next Tauri **major** that moves the Linux webview stack to **gtk 0.20** (tracked in #51). |

_Last reviewed: 2026-06-03 (Dependabot enablement security sweep)._
