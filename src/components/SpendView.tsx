import { useState, useEffect } from "react";
import { listSubscriptions, type Subscription } from "../lib/subscriptions";
import { fetchProviderSpend, type SpendData } from "../lib/connectors";
import { deleteProviderApiKey, hasProviderApiKey, storeProviderApiKey } from "../lib/credentials";
import type { Section } from "../App";

// ── Types ────────────────────────────────────────────────────────────────────

type ProviderId = "anthropic" | "openai" | "openrouter" | "groq";

type ProviderStatus =
  | { tag: "unconfigured" }
  | { tag: "loading" }
  | { tag: "ok"; data: SpendData; refreshedAt: Date }
  | { tag: "stale"; error: string };

const PROVIDERS: { id: ProviderId; name: string; note?: string; comingSoon?: boolean }[] = [
  { id: "anthropic", name: "Anthropic", note: "Requires Admin API key (sk-ant-admin-…)" },
  { id: "openai",    name: "OpenAI",    note: "Requires API key with usage read scope" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "groq",      name: "Groq",      comingSoon: true },
];

const EMPTY_STATES: Record<ProviderId, ProviderStatus> = {
  anthropic:  { tag: "unconfigured" },
  openai:     { tag: "unconfigured" },
  openrouter: { tag: "unconfigured" },
  groq:       { tag: "unconfigured" },
};

// ── Component ────────────────────────────────────────────────────────────────

export function SpendView({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const [subscriptions, setSubscriptions]     = useState<Subscription[]>([]);
  const [loadError, setLoadError]             = useState<string | null>(null);
  const [providers, setProviders]             = useState<Record<ProviderId, ProviderStatus>>(EMPTY_STATES);
  const [addingKey, setAddingKey]             = useState<ProviderId | null>(null);
  const [confirmRevoke, setConfirmRevoke]     = useState<ProviderId | null>(null);
  const [keyInput, setKeyInput]               = useState("");
  const [addError, setAddError]               = useState<string | null>(null);
  const [savingKey, setSavingKey]             = useState(false);

  useEffect(() => {
    listSubscriptions()
      .then(setSubscriptions)
      .catch((e) => setLoadError(String(e)));

    // Check which providers have keys and fetch them concurrently (skip comingSoon)
    PROVIDERS.forEach(({ id, comingSoon }) => {
      if (comingSoon) return;
      hasProviderApiKey(id)
        .then((has) => { if (has) runFetch(id); })
        .catch(() => {});
    });
  }, []);

  function setStatus(id: ProviderId, status: ProviderStatus) {
    setProviders((prev) => ({ ...prev, [id]: status }));
  }

  async function runFetch(id: ProviderId) {
    setStatus(id, { tag: "loading" });
    try {
      const data = await fetchProviderSpend(id);
      setStatus(id, { tag: "ok", data, refreshedAt: new Date() });
    } catch (e) {
      setStatus(id, { tag: "stale", error: String(e) });
    }
  }

  function refreshAll() {
    PROVIDERS.forEach(({ id }) => {
      const s = providers[id];
      if (s.tag === "ok" || s.tag === "stale") runFetch(id);
    });
  }

  async function handleSaveKey(id: ProviderId) {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    setAddError(null);
    try {
      await storeProviderApiKey(id, keyInput.trim());
      setKeyInput("");
      setAddingKey(null);
      runFetch(id);
    } catch (e) {
      setAddError(String(e));
    } finally {
      setSavingKey(false);
    }
  }

  async function handleRevokeKey(id: ProviderId) {
    try {
      await deleteProviderApiKey(id);
      setStatus(id, { tag: "unconfigured" });
      setConfirmRevoke(null);
    } catch {
      // silently reset - key may already be gone
      setStatus(id, { tag: "unconfigured" });
      setConfirmRevoke(null);
    }
  }

  function cancelAddKey() {
    setAddingKey(null);
    setKeyInput("");
    setAddError(null);
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const apiTotal = PROVIDERS.reduce((sum, { id }) => {
    const s = providers[id];
    return s.tag === "ok" ? sum + s.data.currentMonthUsd : sum;
  }, 0);

  const hasAnyApiData = PROVIDERS.some(({ id }) => providers[id].tag === "ok");

  const monthlyByCurrency = subscriptions.reduce(
    (acc, s) => { acc[s.currency] = (acc[s.currency] ?? 0) + s.monthlyCost; return acc; },
    {} as Record<string, number>
  );

  const hasConfiguredProviders = PROVIDERS.some(({ id }) => providers[id].tag !== "unconfigured");

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-8 max-w-2xl">

      {/* Header */}
      <h1
        className="text-xl text-[#6750a4] mb-1"
        style={{ fontFamily: "'Kumbh Sans', sans-serif", fontWeight: 300 }}
      >
        Spend
      </h1>
      <p className="text-sm text-[#625b71] mb-6">API usage and subscription costs</p>

      {loadError && (
        <div className="mb-6 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      {/* Headline totals */}
      {(hasAnyApiData || subscriptions.length > 0) && (
        <div className="flex flex-wrap gap-3 mb-8">
          {hasAnyApiData && (
            <div className="rounded-2xl border border-zinc-100 bg-white px-5 py-3">
              <p className="text-[10px] text-[#625b71]/60 uppercase tracking-[0.2em] mb-0.5" style={{ fontFamily: "'Kumbh Sans', sans-serif" }}>
                API this month
              </p>
              <p className="text-2xl text-[#1c1b1f]" style={{ fontFamily: "'Kumbh Sans', sans-serif", fontWeight: 300 }}>
                ${apiTotal.toFixed(2)}
              </p>
            </div>
          )}
          {subscriptions.length > 0 && Object.entries(monthlyByCurrency).map(([currency, total]) => (
            <div key={currency} className="rounded-2xl border border-zinc-100 bg-white px-5 py-3">
              <p className="text-[10px] text-[#625b71]/60 uppercase tracking-[0.2em] mb-0.5" style={{ fontFamily: "'Kumbh Sans', sans-serif" }}>
                Subscriptions/mo
              </p>
              <p className="text-2xl text-[#1c1b1f]" style={{ fontFamily: "'Kumbh Sans', sans-serif", fontWeight: 300 }}>
                {currency} {total.toFixed(2)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Section 1: API Spend ─────────────────────────────────────────── */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-[#1c1b1f]" style={{ fontFamily: "'Kumbh Sans', sans-serif" }}>
            API Spend
          </h2>
          {hasConfiguredProviders && (
            <button
              onClick={refreshAll}
              className="text-xs text-[#6750a4] hover:text-[#6750a4]/70 transition-colors cursor-pointer"
              style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
            >
              Refresh all
            </button>
          )}
        </div>

        <div className="space-y-2">
          {PROVIDERS.map(({ id, name, note, comingSoon }) => {
            const s = providers[id];
            const isAdding = addingKey === id;

            // Strip verbose Rust error prefix from stale messages
            const staleMessage = s.tag === "stale"
              ? s.error.replace(/^Error:\s*/i, "").replace(/^Failed to fetch spend for \w+:\s*/i, "")
              : "";

            return (
              <div key={id} className="rounded-2xl border border-zinc-100 bg-white px-5 py-4">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">

                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[#1c1b1f]" style={{ fontFamily: "'Kumbh Sans', sans-serif" }}>
                        {name}
                      </p>
                      {comingSoon && (
                        <span className="text-[10px] text-[#625b71]/60 uppercase tracking-[0.18em] border border-zinc-200 rounded-full px-2 py-0.5" style={{ fontFamily: "'Kumbh Sans', sans-serif" }}>
                          Billing API coming soon
                        </span>
                      )}
                    </div>

                    {/* Status — hidden for comingSoon providers */}
                    {!comingSoon && s.tag === "unconfigured" && !isAdding && (
                      <p className="text-xs text-[#625b71] mt-0.5">No API key configured</p>
                    )}
                    {!comingSoon && s.tag === "loading" && (
                      <p className="text-xs text-[#625b71] mt-0.5 animate-pulse">Fetching…</p>
                    )}
                    {!comingSoon && s.tag === "ok" && (
                      <div className="mt-2 flex gap-6">
                        <div>
                          <p className="text-[10px] text-[#625b71]/60 uppercase tracking-[0.2em]">This month</p>
                          <p className="text-base text-[#1c1b1f]" style={{ fontWeight: 300 }}>
                            ${s.data.currentMonthUsd.toFixed(2)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-[#625b71]/60 uppercase tracking-[0.2em]">Last month</p>
                          <p className="text-base text-[#1c1b1f]" style={{ fontWeight: 300 }}>
                            {s.data.previousMonthUsd > 0 ? `$${s.data.previousMonthUsd.toFixed(2)}` : "—"}
                          </p>
                        </div>
                      </div>
                    )}
                    {!comingSoon && s.tag === "stale" && (
                      <p className="text-xs text-rose-500 mt-1 leading-relaxed max-w-sm">{staleMessage}</p>
                    )}

                    {/* Add/update key form — hidden for comingSoon providers */}
                    {!comingSoon && isAdding && (
                      <div className="mt-3 space-y-2">
                        {note && (
                          <p className="text-xs text-[#625b71]/70">{note}</p>
                        )}
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleSaveKey(id)}
                            placeholder="Paste API key…"
                            autoFocus
                            className="flex-1 px-3 py-1.5 rounded-xl border border-zinc-200 text-sm text-[#1c1b1f] outline-none focus:border-[#6750a4] transition-colors"
                            style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                          />
                          <button
                            onClick={() => handleSaveKey(id)}
                            disabled={savingKey || !keyInput.trim()}
                            className="px-4 py-1.5 rounded-full bg-[#6750a4] text-white text-sm disabled:opacity-40 cursor-pointer hover:bg-[#6750a4]/90 transition-colors"
                            style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                          >
                            {savingKey ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={cancelAddKey}
                            className="px-3 py-1.5 rounded-full text-sm text-[#625b71] hover:bg-zinc-50 cursor-pointer transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                        {addError && <p className="text-xs text-rose-500">{addError}</p>}
                      </div>
                    )}
                  </div>

                  {/* Right-side actions — hidden for comingSoon providers */}
                  {!comingSoon && (
                    <div
                      className="shrink-0 flex flex-col items-end gap-1 pt-0.5"
                      style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                    >
                      {s.tag === "ok" && (
                        <>
                          <p className="text-[10px] text-[#625b71]/50">
                            {s.refreshedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </p>
                          <button
                            onClick={() => runFetch(id)}
                            className="text-xs text-[#6750a4] hover:text-[#6750a4]/70 cursor-pointer transition-colors"
                          >
                            Refresh
                          </button>
                          {confirmRevoke === id ? (
                            <div className="flex gap-1 items-center">
                              <button
                                onClick={() => handleRevokeKey(id)}
                                className="text-xs text-rose-500 hover:text-rose-400 cursor-pointer transition-colors"
                                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                              >
                                Revoke
                              </button>
                              <span
                                className="text-[10px] text-[#625b71]/40"
                                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                              >
                                /
                              </span>
                              <button
                                onClick={() => setConfirmRevoke(null)}
                                className="text-xs text-[#625b71] hover:text-[#625b71]/70 cursor-pointer transition-colors"
                                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                if (addingKey === id) cancelAddKey();
                                setConfirmRevoke(id);
                              }}
                              className="text-xs text-[#625b71]/50 hover:text-rose-400 cursor-pointer transition-colors"
                              style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                            >
                              Revoke key
                            </button>
                          )}
                        </>
                      )}
                      {s.tag === "stale" && (
                        <>
                          <button
                            onClick={() => runFetch(id)}
                            className="text-xs text-rose-400 hover:text-rose-300 cursor-pointer transition-colors"
                          >
                            Retry
                          </button>
                          {confirmRevoke === id ? (
                            <div className="flex gap-1 items-center">
                              <button
                                onClick={() => handleRevokeKey(id)}
                                className="text-xs text-rose-500 hover:text-rose-400 cursor-pointer transition-colors"
                                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                              >
                                Revoke
                              </button>
                              <span
                                className="text-[10px] text-[#625b71]/40"
                                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                              >
                                /
                              </span>
                              <button
                                onClick={() => setConfirmRevoke(null)}
                                className="text-xs text-[#625b71] hover:text-[#625b71]/70 cursor-pointer transition-colors"
                                style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                if (addingKey === id) cancelAddKey();
                                setConfirmRevoke(id);
                              }}
                              className="text-xs text-[#625b71]/50 hover:text-rose-400 cursor-pointer transition-colors"
                              style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
                            >
                              Revoke key
                            </button>
                          )}
                        </>
                      )}
                      {(s.tag === "unconfigured" || s.tag === "stale") && !isAdding && (
                        <button
                          onClick={() => {
                            setConfirmRevoke(null);
                            setAddingKey(id);
                            setAddError(null);
                            setKeyInput("");
                          }}
                          className="text-xs text-[#6750a4] hover:text-[#6750a4]/70 cursor-pointer transition-colors"
                        >
                          {s.tag === "unconfigured" ? "Add key" : "Update key"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Section 2: Subscriptions summary ──────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-[#1c1b1f]" style={{ fontFamily: "'Kumbh Sans', sans-serif" }}>
            Subscriptions
          </h2>
          <button
            onClick={() => onNavigate("subscriptions")}
            className="text-xs text-[#6750a4] hover:text-[#6750a4]/70 cursor-pointer transition-colors"
            style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
          >
            Manage →
          </button>
        </div>

        {subscriptions.length === 0 ? (
          <div className="rounded-2xl border border-zinc-100 bg-white px-5 py-4">
            <p className="text-sm text-[#625b71]">No subscriptions tracked yet.</p>
            <button
              onClick={() => onNavigate("subscriptions")}
              className="mt-2 text-xs text-[#6750a4] hover:text-[#6750a4]/70 cursor-pointer transition-colors"
            >
              Add subscriptions →
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-zinc-100 bg-white px-5 py-4 space-y-1.5">
            {Object.entries(monthlyByCurrency).map(([currency, total]) => {
              const count = subscriptions.filter((s) => s.currency === currency).length;
              return (
                <div key={currency} className="flex items-baseline justify-between">
                  <span className="text-sm text-[#625b71]">
                    {count} subscription{count !== 1 ? "s" : ""} in {currency}
                  </span>
                  <span className="text-sm text-[#1c1b1f]">
                    {currency} {total.toFixed(2)}/mo
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
