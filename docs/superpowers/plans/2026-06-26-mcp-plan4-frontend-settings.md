# MCP KB Frontend Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan 4 of the MCP read-first series.** This plan builds the **frontend** "KB access for AI agents" Settings section: the opt-in enable toggle, the token mint flow, the token list + revoke, and the read activity-log view. It contains **no Rust/backend code** — it is a pure React/TypeScript layer that calls the Tauri commands produced by **Plan 3**. **Depends on Plans 2–3** (the `kb::tokens` / `kb::ledger` backend from Plan 2 and the `mcp_*` Tauri commands from Plan 3); it consumes those commands at their **exact pinned names and shapes** and must not be merged before them. The write path (Plan 5) is explicitly out of scope.

**Goal:** Add a self-contained "KB access for AI agents" Settings section so a user can (1) opt in (default OFF), (2) mint a per-client token (label + Read | Read+Write scope) and see the raw `spk_mcp_…` token **once** plus a paste-ready MCP-client config snippet, (3) list and revoke tokens, and (4) view recent read activity from the ledger — all wired into `src/components/SettingsView.tsx` using the existing section-component conventions.

**Architecture:** One new thin `invoke()` wrapper module `src/lib/mcp.ts` (mirroring `src/lib/settings.ts` / `src/lib/connectors.ts`) exposes typed async functions over the seven Plan 3 Tauri commands. One new **presentational** component `src/components/McpAccessSection.tsx` renders the whole section from props (mirroring `NotificationSettings.tsx`), and one new **container** component `src/components/McpAccessSectionContainer.tsx` owns the state + command calls (mirroring `NotificationSettingsSection.tsx` with the `onError` / `onReadyChange` contract). `SettingsView.tsx` mounts the container exactly like the other sections. Vitest covers the lib wrappers (via the project-native `@tauri-apps/api/mocks` IPC mock, which intercepts `invoke`) and the pure presentational helpers.

**Tech Stack:** React 19 + TypeScript (strict), Tauri `invoke` from `@tauri-apps/api/core`, Tailwind v4 with the shared surface-style constants in `src/lib/surfaceStyles.ts`, React hooks only (no external state lib), vitest + jsdom with `mockIPC`/`clearMocks` from `@tauri-apps/api/mocks` (the existing test harness; **no** `@testing-library/react` is a dependency — see Global Constraints).

## Global Constraints

- **Consume Plan 3's commands verbatim — do NOT redefine them.** The exact pinned Tauri command surface this plan calls (names + arg shapes + return shapes), against which Plans 2–3 are written:
  - `mcp_get_enabled() -> bool`
  - `mcp_set_enabled(enabled: boolean) -> void` (settings key `mcp_kb_access_enabled`; toggling starts/stops the IPC server, Plan 3)
  - `mcp_mint_token(label: string, scope: "read" | "read_write") -> string` (the **raw** `spk_mcp_…` token, returned **once**)
  - `mcp_list_tokens() -> TokenInfo[]` where `TokenInfo = { id: string; label: string; scope: "read" | "read_write"; createdAt: string }`
  - `mcp_revoke_token(id: string) -> void`
  - `mcp_recent_activity(limit: number) -> LedgerRow[]` where `LedgerRow = { clientLabel: string; tool: string; target: string; resultCount: number; at: string }`
  - `mcp_client_config_snippet(token: string) -> string` (the paste-ready Claude-Desktop / Cursor `mcpServers` block)
- **Tauri serde casing.** Rust structs serialize to **camelCase** across the IPC boundary in this app (see `SpendData`, `NotificationSettings`, `ExchangeRate` in `src/lib`), and snake_case args are accepted as the JS object keys the command declares. The `Scope` enum (Plan 2 `kb::tokens::Scope`, `serde`) serializes its variants as the lowercase strings `"read"` / `"read_write"` (Rust `#[serde(rename_all = "snake_case")]` on the enum — Plan 2's responsibility; this plan's TS union must match exactly). If Plan 2/3 land a different on-the-wire spelling, update the TS union in **one place** (`src/lib/mcp.ts`) — do not scatter it.
- **Show the raw token exactly once.** `mcp_mint_token` returns the raw secret only at mint time; the backend stores only its hash (Plan 2). The UI must surface it once with a copy affordance + an explicit "you will not see this again" warning, and discard it from React state the moment the mint dialog is dismissed. **Never** log it, never persist it to `localStorage`/`sessionStorage`, never re-render it after dismissal.
- **Opt-in, default OFF.** The section renders the enable toggle unconditionally; **all** token/mint/activity UI is gated behind `enabled === true`. A fresh install shows the toggle OFF and nothing else (matches `MCP_KB_CONTRACT.md` §11 "available-off").
- **Match the existing section contract.** The container takes `{ onError: (error: string) => void; onReadyChange?: (ready: boolean) => void }`, returns `null` until first load resolves, calls `onReadyChange?.(true)` exactly once after the initial fetch, and routes all failures to `onError(String(error))` — identical to `NotificationSettingsSection` / `ExchangeRatesSection`.
- **Styling = shared surfaces only.** Reuse `surfaceStyles.ts` (`ACCENT_BUTTON_SURFACE`, `SECONDARY_BUTTON_SURFACE`, `DANGER_BUTTON_SURFACE`, `TEXT_INPUT_SURFACE`, `CARD_SURFACE`, `EMPTY_STATE_SURFACE`) and the existing toggle markup from `NotificationSettings.tsx`. Do not invent new color literals.
- **Commit messages MUST reference the tracking issue `#N`** created in Task 0.1 (the `.githooks/commit-msg` hook rejects commits without `#N`; `docs:`-prefixed commits are exempt). Substitute the real number for `#<ISSUE>` throughout.
- **Frontend gates (run before every commit, all must pass):** `npm run format:check`, `npm run lint`, `npm run build` (`tsc && vite build`), `npm run test` (`vitest run`). The pre-commit hook runs `prettier --check`; run `npm run format` first if it complains.
- **No backend changes.** This plan adds/edits files only under `src/` (plus `docs/`). It does **not** touch `src-tauri/`. If a command is missing at runtime, that is a Plan 3 gap, not a Plan 4 fix.
- **No write-path UI.** Scope offers exactly two options — **Read** and **Read+Write** — because the token scope is set at mint time (Plan 2 `Scope::ReadWrite` exists as a handle), but **no `kb_append`/`kb_create`/`kb_write` controls, no per-write prompt UI** — those are Plan 5.

---

## File Structure

| File | Responsibility | New/Modify |
| --- | --- | --- |
| `src/lib/mcp.ts` | thin typed `invoke()` wrappers for the seven `mcp_*` commands + the `TokenInfo` / `LedgerRow` / `McpScope` types | Create |
| `src/lib/mcp.test.ts` | vitest: each wrapper sends the right command + args and surfaces errors (via `mockIPC`) | Create |
| `src/components/McpAccessSection.tsx` | presentational section (toggle + mint form + minted-token reveal + token list + activity log), driven entirely by props | Create |
| `src/components/McpAccessSection.test.ts` | vitest: pure presentational helpers (scope label, activity-target formatter) | Create |
| `src/components/McpAccessSectionContainer.tsx` | container: state, command calls, `onError`/`onReadyChange` contract | Create |
| `src/components/SettingsView.tsx` | mount the container as a new section | Modify |
| `docs/MCP_KB_CONTRACT.md` | §17 checklist: tick the Plan 4 frontend box | Modify (Phase 0) |

---

## Phase 0 — Tracking issue + spec checkbox

### Task 0.1: Create the tracking issue

- [ ] **Step 1: Create the issue and capture its number**

```powershell
gh issue create `
  --repo Stashpeak/app `
  --title "feat(mcp): frontend KB-access Settings (toggle, token mint/revoke, activity log)" `
  --label enhancement `
  --body "Implements Plan 4 of the MCP read-first series (docs/superpowers/plans/2026-06-26-mcp-plan4-frontend-settings.md). Frontend-only: the 'KB access for AI agents' Settings section. Consumes the Plan 3 Tauri commands (mcp_get_enabled/mcp_set_enabled/mcp_mint_token/mcp_list_tokens/mcp_revoke_token/mcp_recent_activity/mcp_client_config_snippet). Depends on Plans 2-3. Out of scope: backend, write path (Plan 5)."
```

> Run from the `stashpeak-app` repo root (`d:/Coding Projects/Stashpeak/stashpeak-app`). Record the printed number as `#<ISSUE>` for every later commit. If `--repo` is rejected, drop the flag and run from inside the repo.

### Task 0.2: Tick the Plan 4 box in the contract checklist

- [ ] **Step 1: Create the working branch first** (so the doc edit rides this plan's branch)

```powershell
cd "d:/Coding Projects/Stashpeak/stashpeak-app"
git checkout main; git pull
git checkout -b feat/mcp-frontend-settings-<ISSUE>
```

- [ ] **Step 2: Tick the box**

In `docs/MCP_KB_CONTRACT.md` §17 (the implementation/close-out checklist), mark the **Plan 4 — frontend KB-access settings** line as in-progress/done (`[x]`), referencing this plan file. If §17 has no per-plan checklist row yet, append one sentence under the roadmap: *"Plan 4 (frontend KB-access settings) — see `docs/superpowers/plans/2026-06-26-mcp-plan4-frontend-settings.md`; consumes the Plan 3 `mcp_*` commands."*

- [ ] **Step 3: Commit (docs: exempt from the `#N` hook)**

```powershell
git add docs/MCP_KB_CONTRACT.md
git commit -m "docs(mcp): mark Plan 4 (frontend KB-access settings) in the contract checklist"
```

---

## Phase 1 — The `invoke()` wrapper layer (`src/lib/mcp.ts`)

This is the single seam onto the Plan 3 Tauri commands. Every shape lives here once.

### Task 1.1: Write the failing wrapper tests

**Files:**
- Create: `src/lib/mcp.test.ts`

**Interfaces:**
- Consumes (under test): `mcp.ts` (next task).
- Produces: a test that pins each wrapper's command name + arg object + return passthrough, and the error-wrapping behavior, using the project-native IPC mock (`mockIPC` intercepts `invoke`, exactly the "mocked `@tauri-apps/api/core` invoke" requirement).

- [ ] **Step 1: Write the test file**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  getMcpEnabled,
  setMcpEnabled,
  mintMcpToken,
  listMcpTokens,
  revokeMcpToken,
  getMcpRecentActivity,
  getMcpClientConfigSnippet,
  type LedgerRow,
  type TokenInfo,
} from "./mcp";

// Each test registers a fake IPC handler. mockIPC intercepts the `invoke`
// transport, so the wrappers exercise the real `@tauri-apps/api/core` path.
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

function captureIPC<T>(result: T) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    return result as unknown as Promise<unknown>;
  });
  return calls;
}

describe("getMcpEnabled", () => {
  it("invokes mcp_get_enabled and returns the boolean", async () => {
    const calls = captureIPC(true);
    await expect(getMcpEnabled()).resolves.toBe(true);
    expect(calls).toEqual([{ cmd: "mcp_get_enabled", args: {} }]);
  });
});

describe("setMcpEnabled", () => {
  it("invokes mcp_set_enabled with the enabled flag", async () => {
    const calls = captureIPC(null);
    await setMcpEnabled(true);
    expect(calls).toEqual([{ cmd: "mcp_set_enabled", args: { enabled: true } }]);
  });
});

describe("mintMcpToken", () => {
  it("invokes mcp_mint_token with label + scope and returns the raw token", async () => {
    const calls = captureIPC("spk_mcp_deadbeef");
    await expect(mintMcpToken("Claude Desktop", "read")).resolves.toBe("spk_mcp_deadbeef");
    expect(calls).toEqual([
      { cmd: "mcp_mint_token", args: { label: "Claude Desktop", scope: "read" } },
    ]);
  });

  it("passes the read_write scope through verbatim", async () => {
    const calls = captureIPC("spk_mcp_x");
    await mintMcpToken("Cursor", "read_write");
    expect(calls[0].args).toEqual({ label: "Cursor", scope: "read_write" });
  });
});

describe("listMcpTokens", () => {
  it("invokes mcp_list_tokens and returns the rows", async () => {
    const rows: TokenInfo[] = [
      { id: "1", label: "Claude Desktop", scope: "read", createdAt: "2026-06-26T10:00:00Z" },
    ];
    const calls = captureIPC(rows);
    await expect(listMcpTokens()).resolves.toEqual(rows);
    expect(calls[0].cmd).toBe("mcp_list_tokens");
  });
});

describe("revokeMcpToken", () => {
  it("invokes mcp_revoke_token with the id", async () => {
    const calls = captureIPC(null);
    await revokeMcpToken("tok-1");
    expect(calls).toEqual([{ cmd: "mcp_revoke_token", args: { id: "tok-1" } }]);
  });
});

describe("getMcpRecentActivity", () => {
  it("invokes mcp_recent_activity with the limit and returns the rows", async () => {
    const rows: LedgerRow[] = [
      {
        clientLabel: "Claude Desktop",
        tool: "kb_search",
        target: "notes/",
        resultCount: 3,
        at: "2026-06-26T10:01:00Z",
      },
    ];
    const calls = captureIPC(rows);
    await expect(getMcpRecentActivity(50)).resolves.toEqual(rows);
    expect(calls).toEqual([{ cmd: "mcp_recent_activity", args: { limit: 50 } }]);
  });
});

describe("getMcpClientConfigSnippet", () => {
  it("invokes mcp_client_config_snippet with the token and returns the snippet", async () => {
    const snippet = '{\n  "mcpServers": { "stashpeak": {} }\n}';
    const calls = captureIPC(snippet);
    await expect(getMcpClientConfigSnippet("spk_mcp_x")).resolves.toBe(snippet);
    expect(calls).toEqual([
      { cmd: "mcp_client_config_snippet", args: { token: "spk_mcp_x" } },
    ]);
  });
});

describe("error wrapping", () => {
  it("rethrows IPC failures as descriptive Errors", async () => {
    mockIPC(() => {
      throw new Error("backend boom");
    });
    await expect(getMcpEnabled()).rejects.toThrow(/Failed to read KB access state/);
    await expect(mintMcpToken("x", "read")).rejects.toThrow(/Failed to mint KB access token/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -- src/lib/mcp.test.ts`
Expected: FAIL (cannot resolve `./mcp`).

### Task 1.2: Implement `src/lib/mcp.ts`

**Files:**
- Create: `src/lib/mcp.ts`

**Interfaces:**
- Consumes: `@tauri-apps/api/core` `invoke`; the seven Plan 3 `mcp_*` commands.
- Produces: `McpScope`, `TokenInfo`, `LedgerRow` types + `getMcpEnabled`, `setMcpEnabled`, `mintMcpToken`, `listMcpTokens`, `revokeMcpToken`, `getMcpRecentActivity`, `getMcpClientConfigSnippet`.

- [ ] **Step 1: Implement** (mirror the try/catch + descriptive-`Error` style of `src/lib/settings.ts`)

```ts
import { invoke } from "@tauri-apps/api/core";

/**
 * Wire spelling of the token scope. MUST match the serde serialization of
 * Plan 2's `kb::tokens::Scope` enum (snake_case): Read => "read",
 * ReadWrite => "read_write". This union is the single source of truth on the
 * frontend — if the backend spelling changes, change it here only.
 */
export type McpScope = "read" | "read_write";

/** One minted client token (the raw secret is NEVER stored server-side). */
export interface TokenInfo {
  id: string;
  label: string;
  scope: McpScope;
  /** RFC3339 / ISO-8601 timestamp string. */
  createdAt: string;
}

/** One recorded read in the activity ledger. */
export interface LedgerRow {
  clientLabel: string;
  tool: string;
  target: string;
  resultCount: number;
  /** RFC3339 / ISO-8601 timestamp string. */
  at: string;
}

export async function getMcpEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("mcp_get_enabled");
  } catch (e) {
    throw new Error(`Failed to read KB access state: ${e}`);
  }
}

export async function setMcpEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke("mcp_set_enabled", { enabled });
  } catch (e) {
    throw new Error(`Failed to set KB access state: ${e}`);
  }
}

/**
 * Mint a new per-client token. Returns the RAW `spk_mcp_...` secret ONCE.
 * The caller MUST display it a single time and then discard it — the backend
 * stores only its hash and cannot reproduce it.
 */
export async function mintMcpToken(label: string, scope: McpScope): Promise<string> {
  try {
    return await invoke<string>("mcp_mint_token", { label, scope });
  } catch (e) {
    throw new Error(`Failed to mint KB access token: ${e}`);
  }
}

export async function listMcpTokens(): Promise<TokenInfo[]> {
  try {
    return await invoke<TokenInfo[]>("mcp_list_tokens");
  } catch (e) {
    throw new Error(`Failed to list KB access tokens: ${e}`);
  }
}

export async function revokeMcpToken(id: string): Promise<void> {
  try {
    await invoke("mcp_revoke_token", { id });
  } catch (e) {
    throw new Error(`Failed to revoke KB access token: ${e}`);
  }
}

export async function getMcpRecentActivity(limit: number): Promise<LedgerRow[]> {
  try {
    return await invoke<LedgerRow[]>("mcp_recent_activity", { limit });
  } catch (e) {
    throw new Error(`Failed to load KB access activity: ${e}`);
  }
}

/** The paste-ready Claude Desktop / Cursor `mcpServers` config block. */
export async function getMcpClientConfigSnippet(token: string): Promise<string> {
  try {
    return await invoke<string>("mcp_client_config_snippet", { token });
  } catch (e) {
    throw new Error(`Failed to build the MCP client config snippet: ${e}`);
  }
}
```

- [ ] **Step 2: Run it, verify it passes**

Run: `npm run test -- src/lib/mcp.test.ts`
Expected: PASS (all wrapper + error tests).

- [ ] **Step 3: Gates + commit**

```powershell
npm run format:check
npm run lint
npm run build
npm run test
git add src/lib/mcp.ts src/lib/mcp.test.ts
git commit -m "feat(mcp): typed invoke wrappers for the mcp_* commands (refs #<ISSUE>)"
```

> If `format:check` flags the new files, run `npm run format` then re-stage.

---

## Phase 2 — Presentational section (`McpAccessSection.tsx`)

A pure, prop-driven component (mirrors `NotificationSettings.tsx`): all state lives in the container (Phase 3), all callbacks are passed in. This keeps it testable without `@testing-library/react` (not a dependency) — the pure helpers are unit-tested; the wiring is exercised by the lib tests + manual smoke. Splitting presentational/container is the established pattern (`NotificationSettings` vs `NotificationSettingsSection`).

### Task 2.1: Write the failing helper tests

**Files:**
- Create: `src/components/McpAccessSection.test.ts`

**Interfaces:**
- Consumes (under test): `scopeLabel`, `formatActivityTarget` exported from `McpAccessSection.tsx`.
- Produces: pinned behavior for the two pure formatters used in the render.

- [ ] **Step 1: Write the test file**

```ts
import { describe, expect, it } from "vitest";

import { scopeLabel, formatActivityTarget } from "./McpAccessSection";

describe("scopeLabel", () => {
  it("renders human labels for each scope", () => {
    expect(scopeLabel("read")).toBe("Read");
    expect(scopeLabel("read_write")).toBe("Read + Write");
  });
});

describe("formatActivityTarget", () => {
  it("returns the target unchanged when short", () => {
    expect(formatActivityTarget("notes/todo.md")).toBe("notes/todo.md");
  });

  it("middle-truncates an overlong target so both ends stay readable", () => {
    const long = "projects/" + "x".repeat(80) + "/end.md";
    const out = formatActivityTarget(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toContain("…");
    expect(out.startsWith("projects/")).toBe(true);
    expect(out.endsWith("/end.md")).toBe(true);
  });

  it("shows a dash for an empty target", () => {
    expect(formatActivityTarget("")).toBe("—");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm run test -- src/components/McpAccessSection.test.ts`
Expected: FAIL (cannot resolve `./McpAccessSection`).

### Task 2.2: Implement the presentational section

**Files:**
- Create: `src/components/McpAccessSection.tsx`

**Interfaces:**
- Consumes: `McpScope`, `TokenInfo`, `LedgerRow` from `../lib/mcp`; surface constants from `../lib/surfaceStyles`.
- Produces: the default-exported `McpAccessSection` component + the named pure helpers `scopeLabel`, `formatActivityTarget`, plus the `McpAccessSectionProps` interface.

- [ ] **Step 1: Implement** (toggle markup copied from `NotificationSettings.tsx`; buttons/inputs use `surfaceStyles`)

```tsx
import type { LedgerRow, McpScope, TokenInfo } from "../lib/mcp";
import {
  ACCENT_BUTTON_SURFACE,
  DANGER_BUTTON_SURFACE,
  EMPTY_STATE_SURFACE,
  SECONDARY_BUTTON_SURFACE,
  SUBTLE_PANEL_SURFACE,
  TEXT_INPUT_SURFACE,
} from "../lib/surfaceStyles";

const TARGET_MAX = 56;

/** Human-readable scope label. */
export function scopeLabel(scope: McpScope): string {
  return scope === "read_write" ? "Read + Write" : "Read";
}

/**
 * Keep an activity target readable: pass short values through, middle-truncate
 * long ones (preserve both ends), and show a dash for an empty target.
 */
export function formatActivityTarget(target: string): string {
  if (target.length === 0) {
    return "—";
  }
  if (target.length <= TARGET_MAX) {
    return target;
  }
  const keep = Math.floor((TARGET_MAX - 1) / 2);
  return `${target.slice(0, keep)}…${target.slice(target.length - keep)}`;
}

export interface McpAccessSectionProps {
  // Enable toggle.
  enabled: boolean;
  busy: boolean;
  onToggleEnabled: () => void;

  // Mint form.
  mintLabel: string;
  mintScope: McpScope;
  onMintLabelChange: (label: string) => void;
  onMintScopeChange: (scope: McpScope) => void;
  onMint: () => void;

  // One-time minted-token reveal (null when nothing was just minted).
  mintedToken: string | null;
  mintedSnippet: string | null;
  copiedToken: boolean;
  copiedSnippet: boolean;
  onCopyToken: () => void;
  onCopySnippet: () => void;
  onDismissMinted: () => void;

  // Token list + revoke.
  tokens: TokenInfo[];
  onRevoke: (id: string) => void;

  // Activity log.
  activity: LedgerRow[];
  onRefreshActivity: () => void;
}

export function McpAccessSection({
  enabled,
  busy,
  onToggleEnabled,
  mintLabel,
  mintScope,
  onMintLabelChange,
  onMintScopeChange,
  onMint,
  mintedToken,
  mintedSnippet,
  copiedToken,
  copiedSnippet,
  onCopyToken,
  onCopySnippet,
  onDismissMinted,
  tokens,
  onRevoke,
  activity,
  onRefreshActivity,
}: McpAccessSectionProps) {
  const scopes: McpScope[] = ["read", "read_write"];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-ink">KB access for AI agents</h2>
          <p className="mt-0.5 text-xs text-secondary">
            Let local AI agents (Claude Desktop, Cursor) read your knowledge base over MCP. Off by
            default — turn it on only when you want to grant access.
          </p>
        </div>
        <label className="relative block h-6 w-10 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={busy}
            aria-label="Toggle KB access for AI agents"
            onChange={onToggleEnabled}
            className="sr-only"
          />
          <span
            className={`absolute inset-0 rounded-full transition-colors ${
              enabled ? "bg-primary" : "bg-zinc-200"
            }`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-(--toggle-thumb) shadow-sm transition-all ${
                enabled ? "left-5" : "left-1"
              }`}
            />
          </span>
        </label>
      </div>

      {enabled && (
        <div className="space-y-6">
          {/* Mint a new token */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-ink">Grant a new client</p>
            <p className="text-xs leading-relaxed text-secondary">
              Name the client and pick its access level. You will see the token once — copy it into
              the client&apos;s MCP config right away.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={mintLabel}
                placeholder="e.g. Claude Desktop"
                aria-label="Client label"
                onChange={(e) => onMintLabelChange(e.target.value)}
                className={`${TEXT_INPUT_SURFACE} max-w-56`}
              />
              <div className="flex gap-2" role="radiogroup" aria-label="Access level">
                {scopes.map((scope, index) => {
                  const active = mintScope === scope;
                  return (
                    <button
                      key={scope}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      // Roving tabindex: only the selected option is in the tab
                      // order; arrow keys move selection within the group.
                      tabIndex={active ? 0 : -1}
                      onClick={() => onMintScopeChange(scope)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "ArrowRight" ||
                          e.key === "ArrowDown" ||
                          e.key === "ArrowLeft" ||
                          e.key === "ArrowUp"
                        ) {
                          e.preventDefault();
                          const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
                          const next =
                            (index + (forward ? 1 : -1) + scopes.length) % scopes.length;
                          onMintScopeChange(scopes[next]);
                          const sibling = e.currentTarget.parentElement?.children[next];
                          if (sibling instanceof HTMLElement) {
                            sibling.focus();
                          }
                        }
                      }}
                      className={
                        active
                          ? "rounded-full bg-primary px-4 py-1.5 text-sm text-white transition-all"
                          : "rounded-full bg-primary/8 px-4 py-1.5 text-sm text-primary transition-all hover:bg-primary/15"
                      }
                    >
                      {scopeLabel(scope)}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={busy || mintLabel.trim().length === 0}
                onClick={onMint}
                className={ACCENT_BUTTON_SURFACE}
              >
                Mint token
              </button>
            </div>
          </div>

          {/* One-time minted-token reveal */}
          {mintedToken && (
            <div className={`${SUBTLE_PANEL_SURFACE} space-y-3`}>
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-medium text-[var(--warning-text)]">
                  Copy this token now — it will not be shown again.
                </p>
                <button
                  type="button"
                  onClick={onDismissMinted}
                  aria-label="Dismiss token"
                  className={SECONDARY_BUTTON_SURFACE}
                >
                  Done
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-[10px] bg-black/5 px-3 py-2 font-mono text-xs text-[var(--text-primary)]">
                  {mintedToken}
                </code>
                <button type="button" onClick={onCopyToken} className={SECONDARY_BUTTON_SURFACE}>
                  {copiedToken ? "Copied" : "Copy token"}
                </button>
              </div>
              {mintedSnippet && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-secondary">Paste into your MCP client config:</p>
                    <button
                      type="button"
                      onClick={onCopySnippet}
                      className={SECONDARY_BUTTON_SURFACE}
                    >
                      {copiedSnippet ? "Copied" : "Copy config"}
                    </button>
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-[10px] bg-black/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-primary)]">
                    {mintedSnippet}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Token list + revoke */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-ink">Granted clients</p>
            {tokens.length === 0 ? (
              <p className={EMPTY_STATE_SURFACE}>No clients have been granted access yet.</p>
            ) : (
              <ul className="space-y-2">
                {tokens.map((token) => (
                  <li
                    key={token.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--glass-border)] px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">{token.label}</p>
                      <p className="text-xs text-secondary">
                        {scopeLabel(token.scope)} · added {token.createdAt}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRevoke(token.id)}
                      className={DANGER_BUTTON_SURFACE}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Read activity log */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-ink">Recent read activity</p>
              <button type="button" onClick={onRefreshActivity} className={SECONDARY_BUTTON_SURFACE}>
                Refresh
              </button>
            </div>
            {activity.length === 0 ? (
              <p className={EMPTY_STATE_SURFACE}>No reads recorded yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {activity.map((row, index) => (
                  <li
                    key={`${row.at}-${index}`}
                    className="flex items-center justify-between gap-3 text-xs text-secondary"
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-ink">{row.clientLabel}</span> {row.tool}{" "}
                      <span className="font-mono">{formatActivityTarget(row.target)}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {row.resultCount} · {row.at}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Run, verify pass**

Run: `npm run test -- src/components/McpAccessSection.test.ts`
Expected: PASS (3 helper tests).

- [ ] **Step 3: Gates + commit**

```powershell
npm run format:check
npm run lint
npm run build
npm run test
git add src/components/McpAccessSection.tsx src/components/McpAccessSection.test.ts
git commit -m "feat(mcp): presentational KB-access section + pure helpers (refs #<ISSUE>)"
```

---

## Phase 3 — Container (`McpAccessSectionContainer.tsx`)

State owner: matches the `NotificationSettingsSection` contract exactly (`onError` / `onReadyChange`, `null` until loaded). It owns the enable state, the mint form, the one-time minted-token reveal, the token list, and the activity log, and calls the `src/lib/mcp.ts` wrappers.

### Task 3.1: Implement the container

**Files:**
- Create: `src/components/McpAccessSectionContainer.tsx`

**Interfaces:**
- Consumes: `src/lib/mcp` wrappers; `McpAccessSection` (Phase 2).
- Produces: `McpAccessSectionContainer` taking `{ onError: (error: string) => void; onReadyChange?: (ready: boolean) => void }`.

- [ ] **Step 1: Implement**

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  getMcpClientConfigSnippet,
  getMcpEnabled,
  getMcpRecentActivity,
  listMcpTokens,
  mintMcpToken,
  revokeMcpToken,
  setMcpEnabled,
  type LedgerRow,
  type McpScope,
  type TokenInfo,
} from "../lib/mcp";
import { McpAccessSection } from "./McpAccessSection";

const ACTIVITY_LIMIT = 50;
const COPY_FLASH_MS = 2000;

interface McpAccessSectionContainerProps {
  onError: (error: string) => void;
  onReadyChange?: (ready: boolean) => void;
}

export function McpAccessSectionContainer({
  onError,
  onReadyChange,
}: McpAccessSectionContainerProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const [mintLabel, setMintLabel] = useState("");
  const [mintScope, setMintScope] = useState<McpScope>("read");

  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [mintedSnippet, setMintedSnippet] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [activity, setActivity] = useState<LedgerRow[]>([]);

  const refreshTokens = useCallback(async () => {
    setTokens(await listMcpTokens());
  }, []);

  const refreshActivity = useCallback(async () => {
    setActivity(await getMcpRecentActivity(ACTIVITY_LIMIT));
  }, []);

  // Initial load: enable state first, then (only if on) the lists.
  useEffect(() => {
    let cancelled = false;
    getMcpEnabled()
      .then(async (value) => {
        if (cancelled) {
          return;
        }
        setEnabled(value);
        if (value) {
          await Promise.all([refreshTokens(), refreshActivity()]);
        }
        onReadyChange?.(true);
      })
      .catch((error) => {
        onReadyChange?.(true);
        onError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [onError, onReadyChange, refreshTokens, refreshActivity]);

  async function handleToggleEnabled() {
    if (enabled === null || busy) {
      return;
    }
    const next = !enabled;
    setBusy(true);
    try {
      await setMcpEnabled(next);
      setEnabled(next);
      if (next) {
        await Promise.all([refreshTokens(), refreshActivity()]);
      } else {
        // Turning off: drop any in-flight minted-token reveal and lists.
        discardMinted();
        setTokens([]);
        setActivity([]);
      }
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleMint() {
    const label = mintLabel.trim();
    if (label.length === 0 || busy) {
      return;
    }
    setBusy(true);
    try {
      const raw = await mintMcpToken(label, mintScope);
      // Surface the raw token immediately — this is the only copy and it is shown
      // once. Commit it to state BEFORE fetching the snippet so a snippet-fetch
      // failure can never lose the secret.
      setMintedToken(raw);
      setCopiedToken(false);
      setCopiedSnippet(false);
      setMintLabel("");
      setMintScope("read");
      // Fetch the config snippet separately; a failure here still leaves the raw
      // token revealed above.
      const snippet = await getMcpClientConfigSnippet(raw);
      setMintedSnippet(snippet);
      await refreshTokens();
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  }

  function discardMinted() {
    // Drop the raw secret from React state; it is never persisted or re-shown.
    setMintedToken(null);
    setMintedSnippet(null);
    setCopiedToken(false);
    setCopiedSnippet(false);
  }

  async function handleCopyToken() {
    if (!mintedToken) {
      return;
    }
    try {
      await navigator.clipboard.writeText(mintedToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), COPY_FLASH_MS);
    } catch (error) {
      onError(String(error));
    }
  }

  async function handleCopySnippet() {
    if (!mintedSnippet) {
      return;
    }
    try {
      await navigator.clipboard.writeText(mintedSnippet);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), COPY_FLASH_MS);
    } catch (error) {
      onError(String(error));
    }
  }

  async function handleRevoke(id: string) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await revokeMcpToken(id);
      await refreshTokens();
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  }

  function handleRefreshActivity() {
    refreshActivity().catch((error) => onError(String(error)));
  }

  if (enabled === null) {
    return null;
  }

  return (
    <McpAccessSection
      enabled={enabled}
      busy={busy}
      onToggleEnabled={() => void handleToggleEnabled()}
      mintLabel={mintLabel}
      mintScope={mintScope}
      onMintLabelChange={setMintLabel}
      onMintScopeChange={setMintScope}
      onMint={() => void handleMint()}
      mintedToken={mintedToken}
      mintedSnippet={mintedSnippet}
      copiedToken={copiedToken}
      copiedSnippet={copiedSnippet}
      onCopyToken={() => void handleCopyToken()}
      onCopySnippet={() => void handleCopySnippet()}
      onDismissMinted={discardMinted}
      tokens={tokens}
      onRevoke={(id) => void handleRevoke(id)}
      activity={activity}
      onRefreshActivity={handleRefreshActivity}
    />
  );
}
```

> Why no container vitest: the project ships no `@testing-library/react`, so React components are not rendered in tests (consistent with the existing `NotificationSettingsSection`/`ExchangeRatesSection`, which have no component-render tests). The command seam (`src/lib/mcp.ts`) is fully tested in Phase 1, the pure render helpers in Phase 2, and the wiring is covered by the manual smoke in Task 4.2. Do **not** add `@testing-library/react` in this plan — that is a separate test-infra decision.

- [ ] **Step 2: Verify it builds** (no test yet for this file)

Run: `npm run build`
Expected: `tsc` clean (strict), `vite build` succeeds.

- [ ] **Step 3: Gates + commit**

```powershell
npm run format:check
npm run lint
npm run test
git add src/components/McpAccessSectionContainer.tsx
git commit -m "feat(mcp): KB-access section container (state + command calls) (refs #<ISSUE>)"
```

---

## Phase 4 — Wire into `SettingsView.tsx` + finish

### Task 4.1: Mount the section

**Files:**
- Modify: `src/components/SettingsView.tsx`

**Interfaces:**
- Consumes: `McpAccessSectionContainer`; the existing `loadError` / `setLoadError` + the `contentReady` ready-gate.
- Produces: the new section rendered inside the settings list, gated on its own ready flag exactly like the others.

- [ ] **Step 1: Import the container**

Add to the imports block in `src/components/SettingsView.tsx`:

```tsx
import { McpAccessSectionContainer } from "./McpAccessSectionContainer";
```

- [ ] **Step 2: Add a ready flag** (so the whole settings list reveals only once every async section has loaded — the existing `contentReady` discipline)

Add a state hook alongside the others:

```tsx
const [mcpReady, setMcpReady] = useState(false);
```

Update the `contentReady` derivation to include it:

```tsx
const contentReady = notificationReady && exchangeReady && mcpReady;
```

- [ ] **Step 3: Render the section** (after the `UpdateSection` block, with the standard divider above it)

```tsx
            <div className="border-t border-zinc-100" />

            <McpAccessSectionContainer onError={setLoadError} onReadyChange={setMcpReady} />
```

> Place it as the **last** section (after `UpdateSection`). The `onError={setLoadError}` reuses the section's existing top-of-page `SelectableErrorMessage`; `onReadyChange={setMcpReady}` plugs into the reveal gate.

- [ ] **Step 4: Verify build + lint + tests**

```powershell
npm run format:check
npm run lint
npm run build
npm run test
```
Expected: all green; the settings list still reveals (the MCP container resolves `onReadyChange?.(true)` on first load, including on error).

- [ ] **Step 5: Commit**

```powershell
git add src/components/SettingsView.tsx
git commit -m "feat(mcp): mount KB-access section in Settings (refs #<ISSUE>)"
```

### Task 4.2: Manual smoke (documented in the PR, not CI)

> Component wiring + clipboard + the IPC round-trip are not unit-tested (no `@testing-library/react`), so verify by hand against the Plan 3 backend. Record the result in the PR description.

- [ ] **Step 1: Run the app against the Plan 2+3 build** (`npm run tauri dev`) and confirm:
  1. Fresh state → the **"KB access for AI agents"** toggle is **OFF** and no token/mint/activity UI shows.
  2. Toggle ON → mint form, "Granted clients" (empty state), and "Recent read activity" (empty state) appear.
  3. Mint with a label + **Read** → the raw `spk_mcp_…` token + the config snippet appear once; **Copy token** / **Copy config** flash "Copied"; the new client shows in "Granted clients" with scope **Read**.
  4. **Done** dismisses the reveal; the raw token is gone and does not reappear on re-render.
  5. Mint with **Read + Write** → the client shows scope **Read + Write**.
  6. **Revoke** removes the client from the list.
  7. After a client performs reads (via the shim), **Refresh** shows ledger rows (client label, tool, target, count, time).
  8. Toggle OFF → all sub-UI disappears and the lists clear.

- [ ] **Step 2: If any step fails because a command is missing/mis-shaped**, that is a Plan 3 contract gap — file/flag it; do not patch the backend here.

### Task 4.3: Open the PR

- [ ] **Step 1: Push + PR**

```powershell
git push -u origin feat/mcp-frontend-settings-<ISSUE>
gh pr create --base main `
  --title "feat(mcp): frontend KB-access Settings (toggle, token mint/revoke, activity log)" `
  --body-file <PR body file>
```

PR body must include `Closes #<ISSUE>` and a `## Test plan` section (the CI `validate-pr-body` gate requires both). The Test plan lists: the `src/lib/mcp.ts` wrapper vitest, the `McpAccessSection` helper vitest, the four frontend gates, and the Task 4.2 manual smoke checklist. Add a **Depends on** note: this PR consumes the Plan 3 `mcp_*` commands and must merge **after** Plans 2–3.

- [ ] **Step 2: Address CodeRabbit autonomously** (fix + reply + resolve the thread). Per the multi-reviewer convention, for a frontend change of this size also request `@coderabbitai full review` if CodeRabbit posts nothing on a green check. Do **not** trigger Codex unless the founder asks (usage-limit standing instruction). Then hand to the founder to merge — **after** Plans 2–3 are merged.

---

## Self-Review (completed by the plan author)

- **Spec coverage (Plan 4 slice of `MCP_KB_CONTRACT.md`):** opt-in enable toggle, default OFF ✓ (§11 available-off; Task 2.2/3.1, gated on `mcp_get_enabled`/`mcp_set_enabled`); token mint with label + Read/Read+Write scope, raw token shown **once** + paste-ready config snippet ✓ (§6.1 mint, §5.1/§11 snippet; Task 1.2 `mintMcpToken`/`getMcpClientConfigSnippet`, Task 2.2 one-time reveal, Task 3.1 `discardMinted`); token list + revoke ✓ (§6 revocation handle; `listMcpTokens`/`revokeMcpToken`); read activity-log view ✓ (§7 ledger; `getMcpRecentActivity`). **Correctly out of scope:** backend/Rust (Plans 2–3), the write tools + per-write prompt UI (Plan 5) — scope offers Read+Write as a mint-time **handle** only, with no write controls.
- **Cross-plan contract fidelity:** every command is consumed at its pinned name/arg/return (`mcp_get_enabled`/`mcp_set_enabled(enabled)`/`mcp_mint_token(label,scope)`/`mcp_list_tokens`/`mcp_revoke_token(id)`/`mcp_recent_activity(limit)`/`mcp_client_config_snippet(token)`); `TokenInfo{id,label,scope,createdAt}` and `LedgerRow{clientLabel,tool,target,resultCount,at}` use the app's camelCase serde convention; `McpScope = "read" | "read_write"` matches Plan 2's snake_case `Scope` serialization, isolated to one file.
- **Convention fidelity:** `src/lib/mcp.ts` mirrors `settings.ts`/`connectors.ts` (thin `invoke` + descriptive `Error`); presentational/container split mirrors `NotificationSettings`/`NotificationSettingsSection`; `onError`/`onReadyChange`, `null`-until-loaded, the "Saved/Copied" flash, the toggle markup, and the `surfaceStyles` constants all reuse existing patterns; mounted in `SettingsView` behind the `contentReady` reveal gate.
- **Placeholder scan:** the only intentional substitutions are `#<ISSUE>` (real number from Task 0.1) and the PR-body file path — both explicit. Every code step carries complete, real code; no "TBD"/"add later"/"similar to" stubs.
- **Test honesty:** lib wrappers + pure render helpers are unit-tested with the project-native `mockIPC` (which mocks the `@tauri-apps/api/core` `invoke` transport); the container is intentionally not render-tested because `@testing-library/react` is not a dependency (consistent with the existing untested section containers) — wiring is covered by the documented manual smoke. No new test-infra is introduced.

---

## Roadmap — where this sits in the MCP read-first series

- **Plan 1 — KB foundation** (`2026-06-25-mcp-kb-foundation.md`): vault root, canonical path, read/search, watcher. *(merged via PR #213)*
- **Plan 2 — security & audit:** `resolve_readable` default-deny gate, gated read facade, `kb::tokens` (mint/validate/revoke/list), `kb::ledger` (record_read/recent/check_read_budget), migration `008_mcp.sql`. *(Plan 4 consumes its token/ledger shapes via Plan 3's commands.)*
- **Plan 3 — transport:** the app-side local-IPC server + the `stashpeak-mcp` shim (`rmcp` stdio) + the seven `mcp_*` Tauri commands. *(This plan's hard dependency.)*
- **Plan 4 — frontend KB-access settings (this plan):** enable toggle, token mint/revoke + config snippet, read activity-log view.
- **Plan 5 (v1.x) — write path:** the owned write broker + containment algorithm + `kb_append`/`kb_create`/`kb_write_note` + the write-grant + per-write prompt UI. *(`MCP_KB_CONTRACT.md` §8 — out of scope here.)*
