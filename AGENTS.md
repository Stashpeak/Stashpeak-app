# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Overview

Tauri 2 desktop app: React 19 + TypeScript + Tailwind CSS v4 frontend, Rust backend with SQLite.

## Commands

- **Dev:** `npm run tauri dev` (Vite on port 1420, Tauri system tray)
- **Build:** `npm run tauri build`
- **Frontend only:** `npm run build` (tsc && vite build)
- **Preview:** `npm run preview`

## TypeScript / Frontend

- `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true` in [`tsconfig.json`](tsconfig.json)
- Tailwind CSS v4 via `@tailwindcss/vite` — no `tailwind.config.js`; use `@theme` in CSS
- Components: named exports (`export function ComponentName`) in `src/components/`
- Backend calls: use `invoke` from `@tauri-apps/api/core` — never `@tauri-apps/api/tauri`
- State: no external state library; use React context/hooks
- Graph view: `@xyflow/react` for the map/dependency visualization

## Rust / Backend

- DB migrations in `src-tauri/src/migrations/` — add new files numbered sequentially
- Secrets: use `keyring` crate (platform-specific features auto-selected by cfg)
- Connectors: implement `SpendConnector` trait in `src-tauri/src/connectors/spend/`
- WAL mode enabled on SQLite connections; foreign_keys=ON
- Dev data dir: `~/.local/share/Stashpeak-dev` (not `Stashpeak`)

## Git Hooks

- Commit messages MUST reference an issue: `#N` (e.g., `fix: label alignment (refs #29)`). Doc-only `docs:`-prefixed commits are exempt (see `CONTRIBUTING.md`).
- Hook at [`.githooks/commit-msg`](.githooks/commit-msg); auto-configured via `npm install`

## Architecture Notes

- `src/lib/` modules are thin wrappers around Tauri commands — no business logic here
- Business logic lives in `src-tauri/src/` (db, secrets, connectors, providers)
- `src/hooks/` for custom React hooks (useSpendData, useTheme, useUpcomingRenewals)
- Components in `src/components/map/` for graph visualization sub-components

## Frontend component conventions

Settings-style sections use a **presentational + container split** (canonical: `NotificationSettings` / `NotificationSettingsSection`; also `ExchangeRatesSection`, `McpAccessSection*`):

- **Presentational** (`XSection.tsx`): pure, props-only — no `invoke`, no state. Export the pure helpers (formatters, label maps) so they're unit-testable.
- **Container** (`XSectionContainer.tsx` / `XSectionSection.tsx`): owns state + calls the `src/lib` wrappers. Props are exactly `{ onError: (e: string) => void; onReadyChange?: (ready: boolean) => void }`. Returns `null` until the first load resolves; calls `onReadyChange?.(true)` **exactly once after the initial load settles — on BOTH the success and the error path** (so the page's `contentReady` reveal gate never hangs); routes every failure to `onError(String(error))`. Mounted in `SettingsView` behind the shared `contentReady` gate.
- **`src/lib/*.ts`**: thin typed `invoke` wrappers only — `try/catch` → `throw new Error(\`descriptive: ${e}\`)` (mirror `settings.ts`). No business logic.
- **Styling**: reuse the constants in `src/lib/surfaceStyles.ts` (`*_BUTTON_SURFACE`, `*_SURFACE`, …) and CSS tokens via `var(--…)` / Tailwind `(--…)`. Do NOT invent new color literals.
- **Toggle / switch**: a real `<button role="switch" aria-checked={on}>` with `focus-visible:ring-2 focus-visible:ring-(--focus-ring)` (see the `SettingsView` provider/theme toggles). NEVER an `sr-only` `<input type="checkbox">` toggle — a checkbox ignores Enter, so it fails keyboard activation. Visual/design conventions live in the `stashpeak-design-sync` skill + `internal-docs/Design/BRAND.md`.

## Tests

- Vitest + jsdom. Mock the Tauri boundary with `mockIPC` / `clearMocks` from `@tauri-apps/api/mocks` (it intercepts `invoke`). There is **no** `@testing-library/react` — do not add it; React components are not render-tested. Test the `src/lib` wrappers and the pure presentational helpers instead.

## Local gates (run ALL before every commit — CI runs the same set)

- **Frontend:** `npm run format:check` · `npm run lint` (0 errors) · `npm run build` (`tsc && vite build`) · `npm run test`.
- **Backend (only if `src-tauri/` changed), from `src-tauri/`:** `cargo fmt --check` · `cargo clippy --all-targets -- -D warnings` · `cargo test`.
- The pre-commit hook runs `prettier --check .` **only** (JS/TS/etc.) — it does NOT run `cargo fmt`/clippy. Run the Rust gate yourself or CI fails.
- Two binaries ship (`stashpeak` + `stashpeak-mcp`); `Cargo.toml` sets `default-run = "stashpeak"` so bare `cargo run` / `tauri dev` resolve.

## Conventions first

Before adding a UI element, helper, or pattern, GREP for how it's already done and follow the dominant, proven one. A plan saying "mirror component X" is not license to copy X if X is the inferior outlier — check for a better established pattern first. If two patterns exist, that's drift: converge to the better one (or file an issue), never add a third variation.

## Code documentation

- Comment the WHY, not the WHAT — explain non-obvious decisions, constraints, invariants, gotchas, and security-sensitive steps; never write comments that restate the code.
- Doc-comment public/exported items (Rust `///`, TS JSDoc). English only.
- Applies to AI agents too. Full policy: `Operations/Code Documentation Policy.md` in the `internal-docs` repo (a sibling repository, not part of this checkout).
