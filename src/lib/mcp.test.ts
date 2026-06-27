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

  // This only asserts the wrapper forwards its args verbatim — it is NOT an
  // endorsed product flow. The read-only phase offers no read_write UI and the
  // backend rejects read_write tokens; the wrapper stays scope-generic so the
  // write path (Plan 5) can reuse it unchanged.
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
    expect(calls).toEqual([{ cmd: "mcp_client_config_snippet", args: { token: "spk_mcp_x" } }]);
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
