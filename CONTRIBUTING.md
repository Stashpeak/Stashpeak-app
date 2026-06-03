# Contributing to Stashpeak

**Requirements:** Node.js 24+ and a stable Rust toolchain (with `rustfmt` and `clippy`).
**Stack:** Tauri 2, React 19, TypeScript, Tailwind CSS v4, Vite (frontend); Rust + SQLite (backend).

## Dev setup

```bash
git clone https://github.com/Stashpeak/stashpeak-app
cd stashpeak-app
npm install        # also wires git hooks via the prepare script
npm run tauri dev  # Vite + the Tauri shell
```

`npm run dev` runs the frontend alone (Vite, no Tauri shell).

## Project layout

- `src/` — React frontend. `src/lib/` holds thin wrappers around Tauri commands (no business logic there).
- `src-tauri/src/` — Rust backend: `db`, `secrets`, `connectors`, `providers`, and SQL migrations.
- [`AGENTS.md`](AGENTS.md) documents the conventions both humans and agents follow.

## Code style & checks

Run these before opening a PR — CI gates all of them:

```bash
npm run format:check   # Prettier (frontend code + config)
npm run lint           # ESLint
npm run build          # tsc + vite build (also the typecheck gate)
npm test               # vitest

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

`npm run format` and `cargo fmt --manifest-path src-tauri/Cargo.toml` auto-fix formatting.

## Commits

- Every commit message must reference an issue: `#N` (e.g. `fix: align labels (refs #29)`). The `commit-msg` hook enforces this; doc-only `docs:` commits are exempt.
- Keep changes focused — one feature or fix per PR.

## Pull requests

- Target the `main` branch unless the issue says otherwise.
- The description must link a closing keyword + issue (e.g. `Closes #123`) and include a `## Test plan` section — the PR quality gate enforces both.
- Describe what changed and why.
