import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMcpClientConfigSnippet,
  getMcpEnabled,
  getMcpRecentActivity,
  listMcpTokens,
  mintMcpToken,
  revokeMcpToken,
  setMcpEnabled,
  type LedgerRow,
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

  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [mintedSnippet, setMintedSnippet] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [activity, setActivity] = useState<LedgerRow[]>([]);

  // Monotonic id for the in-flight mint. Each mint's awaited results are only
  // applied while this still matches — so a dismiss (or a newer mint) during an
  // await invalidates the stale result and a discarded secret can't reappear.
  const mintRequestIdRef = useRef(0);

  // One copy-flash timer per button, so a quick second copy doesn't let the
  // first timer flip the "Copied" label back to false mid-flash.
  const copyTokenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copySnippetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    let minted = false;
    const requestId = ++mintRequestIdRef.current;
    setBusy(true);
    try {
      // Read-only phase: scope is always "read" (no picker; the backend rejects
      // read_write until the write path lands).
      const raw = await mintMcpToken(label, "read");
      // The grant now exists server-side, so the token list must refresh even if
      // the snippet step below fails or this request was superseded — otherwise a
      // minted token wouldn't appear in the revoke list until a reload.
      minted = true;
      // If a dismiss or a newer mint superseded this request during the await,
      // drop the result — never reveal a token the user already dismissed.
      if (mintRequestIdRef.current !== requestId) {
        return;
      }
      // Surface the raw token immediately — this is the only copy and it is shown
      // once. Commit it BEFORE fetching the snippet so a snippet-fetch failure
      // can never lose the secret. Clear any stale snippet from a prior mint so
      // it can't flash next to this token before the new snippet arrives.
      setMintedToken(raw);
      setMintedSnippet(null);
      setCopiedToken(false);
      setCopiedSnippet(false);
      setMintLabel("");
      // Fetch the config snippet separately; a failure here still leaves the raw
      // token revealed above. The snippet embeds the raw token, so apply it only
      // if this mint is still the active one (guards the dismiss-during-await race).
      const snippet = await getMcpClientConfigSnippet(raw);
      if (mintRequestIdRef.current === requestId) {
        setMintedSnippet(snippet);
      }
    } catch (error) {
      onError(String(error));
    } finally {
      // Always reflect a successful mint in the token list, even if the snippet
      // step threw or the reveal was superseded — the grant exists server-side.
      if (minted) {
        await refreshTokens().catch((error) => onError(String(error)));
      }
      setBusy(false);
    }
  }

  function discardMinted() {
    // Invalidate any in-flight mint so a late token/snippet resolve can't
    // repopulate the reveal after dismissal, then drop the raw secret from
    // React state; it is never persisted or re-shown.
    mintRequestIdRef.current += 1;
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
      if (copyTokenTimer.current) {
        clearTimeout(copyTokenTimer.current);
      }
      copyTokenTimer.current = setTimeout(() => setCopiedToken(false), COPY_FLASH_MS);
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
      if (copySnippetTimer.current) {
        clearTimeout(copySnippetTimer.current);
      }
      copySnippetTimer.current = setTimeout(() => setCopiedSnippet(false), COPY_FLASH_MS);
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
      onMintLabelChange={setMintLabel}
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
