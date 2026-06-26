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
