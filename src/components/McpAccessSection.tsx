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

/** Human-readable scope label (used to display existing tokens' scope). */
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

/**
 * Render an RFC3339/ISO timestamp as a locale-aware date+time. Falls back to the
 * raw string if it can't be parsed (an unexpected backend value), so the UI
 * never shows "Invalid Date".
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface McpAccessSectionProps {
  // Enable toggle.
  enabled: boolean;
  busy: boolean;
  onToggleEnabled: () => void;

  // Mint form. Scope is always Read in the read-only phase (no picker).
  mintLabel: string;
  onMintLabelChange: (label: string) => void;
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
  onMintLabelChange,
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
            className="peer sr-only"
          />
          <span
            className={`absolute inset-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-(--focus-ring) ${
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
              Name the client and mint a read-only token. You will see the token once — copy it into
              the client&apos;s MCP config right away. (Write access arrives with a later release.)
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
              <span className="text-sm text-secondary">
                Access: <span className="font-medium text-ink">Read</span>
              </span>
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
                        {scopeLabel(token.scope)} · added {formatTimestamp(token.createdAt)}
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
              <button
                type="button"
                onClick={onRefreshActivity}
                className={SECONDARY_BUTTON_SURFACE}
              >
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
                      {row.resultCount} · {formatTimestamp(row.at)}
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
