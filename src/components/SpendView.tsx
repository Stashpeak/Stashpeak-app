import { useEffect, useState } from "react";
import type { Section } from "../App";
import { deleteProviderApiKey, hasProviderApiKey, storeProviderApiKey } from "../lib/credentials";
import { fetchProviderSpend, getProviderEnabled, type SpendData } from "../lib/connectors";
import { listSubscriptions, type Subscription } from "../lib/subscriptions";
import { SelectableErrorMessage } from "./SelectableErrorMessage";
import {
  CARD_SURFACE,
  EMPTY_DASHED_SURFACE,
  HEADER_STAT_SURFACE,
  PILL_SURFACE,
  SUBTLE_PANEL_SURFACE,
  TEXT_INPUT_SURFACE,
} from "./surfaceStyles";

type ProviderId = "anthropic" | "openai" | "openrouter" | "groq" | "gcp";

type ProviderStatus =
  | { tag: "unconfigured" }
  | { tag: "loading" }
  | { tag: "ok"; data: SpendData; refreshedAt: Date; backgroundRefreshing?: boolean }
  | { tag: "stale"; error: string };

const PROVIDERS: { id: ProviderId; name: string; note?: string; comingSoon?: boolean }[] = [
  { id: "anthropic", name: "Anthropic", note: "Requires Admin API key (sk-ant-admin-...)" },
  { id: "openai", name: "OpenAI", note: "Requires API key with usage read scope" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "groq", name: "Groq", comingSoon: true },
  { id: "gcp", name: "Google Cloud", note: "Billing export to BigQuery required" },
];

const EMPTY_STATES: Record<ProviderId, ProviderStatus> = {
  anthropic: { tag: "unconfigured" },
  openai: { tag: "unconfigured" },
  openrouter: { tag: "unconfigured" },
  groq: { tag: "unconfigured" },
  gcp: { tag: "unconfigured" },
};

const CACHE_KEY = "spend_cache_v1";
const STALE_AFTER_MS = 5 * 60 * 1000;

interface CacheEntry {
  data: SpendData;
  fetchedAt: number;
}

type SpendCache = Partial<Record<ProviderId, CacheEntry>>;

function loadCache(): SpendCache {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as SpendCache;
  } catch {
    return {};
  }
}

function persistCache(id: ProviderId, data: SpendData) {
  const cache = loadCache();
  cache[id] = { data, fetchedAt: Date.now() };
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function evictCache(id: ProviderId) {
  const cache = loadCache();
  delete cache[id];
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function buildInitialStates(): Record<ProviderId, ProviderStatus> {
  const cache = loadCache();
  const result = { ...EMPTY_STATES };
  for (const [id, entry] of Object.entries(cache) as [ProviderId, CacheEntry][]) {
    if (entry) {
      result[id] = { tag: "ok", data: entry.data, refreshedAt: new Date(entry.fetchedAt) };
    }
  }
  return result;
}

function formatRefreshedAt(date: Date): string {
  const isToday = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function SpendView({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Record<ProviderId, ProviderStatus>>(buildInitialStates);
  const [enabledProviders, setEnabledProviders] = useState<Record<ProviderId, boolean> | null>(null);
  const [addingKey, setAddingKey] = useState<ProviderId | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ProviderId | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [gcpProject, setGcpProject] = useState("");
  const [gcpDataset, setGcpDataset] = useState("");
  const [gcpTable, setGcpTable] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);

  function setStatus(id: ProviderId, status: ProviderStatus) {
    setProviders((prev) => ({ ...prev, [id]: status }));
  }

  async function runFetch(id: ProviderId, showLoading = true) {
    if (showLoading) {
      setStatus(id, { tag: "loading" });
    } else {
      setProviders((prev) => {
        const status = prev[id];
        if (status.tag === "ok") return { ...prev, [id]: { ...status, backgroundRefreshing: true } };
        return prev;
      });
    }

    try {
      const data = await fetchProviderSpend(id);
      setStatus(id, { tag: "ok", data, refreshedAt: new Date() });
      persistCache(id, data);
    } catch (e) {
      setStatus(id, { tag: "stale", error: String(e) });
    }
  }

  useEffect(() => {
    let cancelled = false;

    listSubscriptions()
      .then((data) => {
        if (!cancelled) setSubscriptions(data);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });

    const cache = loadCache();
    const now = Date.now();

    Promise.all(PROVIDERS.map(({ id }) => getProviderEnabled(id).then((enabled) => ({ id, enabled }))))
      .then((results) => {
        if (cancelled) return;

        const nextEnabled = {} as Record<ProviderId, boolean>;
        for (const { id, enabled } of results) {
          nextEnabled[id] = enabled;
          if (!enabled) {
            setStatus(id, { tag: "unconfigured" });
            evictCache(id);
          }
        }
        setEnabledProviders(nextEnabled);

        PROVIDERS.forEach(({ id, comingSoon }) => {
          if (comingSoon || !nextEnabled[id]) return;

          hasProviderApiKey(id)
            .then((has) => {
              if (cancelled) return;
              if (!has) {
                setStatus(id, { tag: "unconfigured" });
                evictCache(id);
                return;
              }

              const entry = cache[id];
              const isStale = !entry || now - entry.fetchedAt > STALE_AFTER_MS;
              if (isStale) {
                runFetch(id, !entry);
              }
            })
            .catch(() => {});
        });
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function refreshAll() {
    visibleProviders.forEach(({ id }) => {
      const status = providers[id];
      if (status.tag === "ok" || status.tag === "stale") runFetch(id);
    });
  }

  async function handleSaveKey(id: ProviderId) {
    if (id !== "gcp" && !keyInput.trim()) return;
    if (id === "gcp" && (!keyInput.trim() || !gcpProject.trim() || !gcpDataset.trim() || !gcpTable.trim())) {
      setAddError("Please fill in all GCP fields");
      return;
    }

    setSavingKey(true);
    setAddError(null);
    try {
      let finalKey = keyInput.trim();

      if (id === "gcp") {
        try {
          const serviceAccountKey = JSON.parse(finalKey);
          finalKey = JSON.stringify({
            service_account_key: serviceAccountKey,
            project_id: gcpProject.trim(),
            dataset_id: gcpDataset.trim(),
            table_name: gcpTable.trim(),
          });
        } catch {
          throw new Error("Invalid Service Account JSON format");
        }
      }

      await storeProviderApiKey(id, finalKey);
      setKeyInput("");
      setGcpProject("");
      setGcpDataset("");
      setGcpTable("");
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
    } catch {
      // Key may already be gone.
    }
    evictCache(id);
    setStatus(id, { tag: "unconfigured" });
    setConfirmRevoke(null);
  }

  function cancelAddKey() {
    setAddingKey(null);
    setKeyInput("");
    setGcpProject("");
    setGcpDataset("");
    setGcpTable("");
    setAddError(null);
  }

  const visibleProviders =
    enabledProviders === null ? [] : PROVIDERS.filter(({ id }) => enabledProviders[id]);

  const apiTotal = visibleProviders.reduce((sum, { id }) => {
    const status = providers[id];
    return status.tag === "ok" ? sum + status.data.currentMonthUsd : sum;
  }, 0);

  const hasAnyApiData = visibleProviders.some(({ id }) => providers[id].tag === "ok");

  const monthlyByCurrency = subscriptions.reduce(
    (acc, subscription) => {
      acc[subscription.currency] = (acc[subscription.currency] ?? 0) + subscription.monthlyCost;
      return acc;
    },
    {} as Record<string, number>,
  );

  const hasConfiguredProviders = visibleProviders.some(({ id }) => providers[id].tag !== "unconfigured");

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Page header */}
      <div className="border-b border-zinc-100 px-8 py-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-secondary/60">
              API Usage
            </p>
            <h2
              className="mt-1.5 text-3xl text-primary"
              style={{ fontWeight: 300, letterSpacing: "-0.5px" }}
            >
              Spend tracker
            </h2>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-secondary">
              Monitor your API usage across various providers and track your monthly subscription costs in one place.
            </p>
          </div>

          <div className={HEADER_STAT_SURFACE}>
            <p className="text-[10px] uppercase tracking-[0.3em] text-secondary/60">Providers</p>
            <p className="mt-1 text-3xl text-primary" style={{ fontWeight: 300 }}>
              {visibleProviders.length}
            </p>
          </div>
        </div>

        {/* Totals row */}
        {(hasAnyApiData || subscriptions.length > 0) && (
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {hasAnyApiData && (
              <div className={`${PILL_SURFACE} flex items-center gap-1.5`}>
                <span className="text-[10px] uppercase tracking-[0.2em] text-secondary/60 mr-1">
                  API this month
                </span>
                <span className="text-sm font-medium text-ink">
                  ${apiTotal.toFixed(2)}
                </span>
              </div>
            )}
            {subscriptions.length > 0 &&
              Object.entries(monthlyByCurrency).map(([currency, total]) => (
                <div key={currency} className={PILL_SURFACE}>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-secondary/60 mr-2">
                    {currency}/mo
                  </span>
                  <span className="text-sm font-medium text-ink">{total.toFixed(2)}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-6 overflow-auto px-8 py-6">
        {loadError && <SelectableErrorMessage>{loadError}</SelectableErrorMessage>}

        <section className={CARD_SURFACE}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base text-primary" style={{ fontWeight: 400 }}>
              API Spend
            </h2>
            {hasConfiguredProviders && (
              <button
                onClick={refreshAll}
                className="text-xs text-primary hover:text-primary/70 transition-colors cursor-pointer"
              >
                Refresh all
              </button>
            )}
          </div>

          <div className="space-y-2">
            {visibleProviders.map(({ id, name, note, comingSoon }) => {
              const status = providers[id];
              const isAdding = addingKey === id;
              const staleMessage =
                status.tag === "stale"
                  ? status.error.replace(/^Error:\s*/i, "").replace(/^Failed to fetch spend for \w+:\s*/i, "")
                  : "";

              return (
                <div key={id} className={SUBTLE_PANEL_SURFACE}>
                  <div className="flex items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-ink">
                          {name}
                        </p>
                        {comingSoon && (
                          <span className="text-[10px] text-secondary/60 uppercase tracking-[0.18em] border border-zinc-200 rounded-full px-2 py-0.5">
                            Billing API coming soon
                          </span>
                        )}
                      </div>

                      {!comingSoon && status.tag === "unconfigured" && !isAdding && (
                        <p className="text-xs text-secondary mt-0.5">No API key configured</p>
                      )}
                      {!comingSoon && status.tag === "loading" && (
                        <p className="text-xs text-secondary mt-0.5 animate-pulse">Fetching...</p>
                      )}
                      {id === "gcp" && (
                        <p className="text-[10px] text-amber-600 mt-1">
                          Data delayed up to 48h
                        </p>
                      )}
                      {!comingSoon && status.tag === "ok" && (
                        <div className="mt-3 flex flex-wrap gap-2.5">
                          <div className={PILL_SURFACE}>
                            <p className="text-[10px] text-secondary/60 uppercase tracking-[0.2em]">This month</p>
                            <p className="text-base text-primary" style={{ fontWeight: 300 }}>
                              ${status.data.currentMonthUsd.toFixed(2)}
                            </p>
                          </div>
                          <div className={PILL_SURFACE}>
                            <p className="text-[10px] text-secondary/60 uppercase tracking-[0.2em]">Last month</p>
                            <p className="text-base text-primary" style={{ fontWeight: 300 }}>
                              {status.data.previousMonthUsd > 0 ? `$${status.data.previousMonthUsd.toFixed(2)}` : "-"}
                            </p>
                          </div>
                        </div>
                      )}
                      {!comingSoon && status.tag === "stale" && (
                        <SelectableErrorMessage
                          kind="inline"
                          className="mt-1 max-w-sm text-xs leading-relaxed"
                        >
                          {staleMessage}
                        </SelectableErrorMessage>
                      )}

                      {!comingSoon && isAdding && (
                        <div className="mt-3 space-y-2">
                          {note && <p className="text-xs text-secondary/70">{note}</p>}
                          {id === "gcp" ? (
                            <div className="space-y-2">
                              <input
                                type="text"
                                value={gcpProject}
                                onChange={(e) => setGcpProject(e.target.value)}
                                placeholder="Project ID (e.g. my-project-123)"
                                className={TEXT_INPUT_SURFACE}
                              />
                              <input
                                type="text"
                                value={gcpDataset}
                                onChange={(e) => setGcpDataset(e.target.value)}
                                placeholder="BigQuery Dataset ID (e.g. bq_billing_export)"
                                className={TEXT_INPUT_SURFACE}
                              />
                              <input
                                type="text"
                                value={gcpTable}
                                onChange={(e) => setGcpTable(e.target.value)}
                                placeholder="Table Name (e.g. gcp_billing_export_v1_...)"
                                className={TEXT_INPUT_SURFACE}
                              />
                              <textarea
                                value={keyInput}
                                onChange={(e) => setKeyInput(e.target.value)}
                                placeholder="Paste Service Account JSON Key..."
                                autoFocus
                                rows={3}
                                className={`${TEXT_INPUT_SURFACE} resize-y`}
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleSaveKey(id)}
                                  disabled={
                                    savingKey ||
                                    !keyInput.trim() ||
                                    !gcpProject.trim() ||
                                    !gcpDataset.trim() ||
                                    !gcpTable.trim()
                                  }
                                  className="px-4 py-1.5 rounded-full bg-primary text-white text-sm disabled:opacity-40 cursor-pointer hover:bg-primary/90 transition-colors"
                                >
                                  {savingKey ? "Saving..." : "Save"}
                                </button>
                                <button
                                  onClick={cancelAddKey}
                                  className="px-3 py-1.5 rounded-full text-sm text-secondary hover:bg-zinc-50 cursor-pointer transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-2">
                              <input
                                type="password"
                                value={keyInput}
                                onChange={(e) => setKeyInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleSaveKey(id)}
                                placeholder="Paste API key..."
                                autoFocus
                                className={`flex-1 ${TEXT_INPUT_SURFACE}`}
                              />
                              <button
                                onClick={() => handleSaveKey(id)}
                                disabled={savingKey || !keyInput.trim()}
                                className="px-4 py-1.5 rounded-full bg-primary text-white text-sm disabled:opacity-40 cursor-pointer hover:bg-primary/90 transition-colors"
                              >
                                {savingKey ? "Saving..." : "Save"}
                              </button>
                              <button
                                onClick={cancelAddKey}
                                className="px-3 py-1.5 rounded-full text-sm text-secondary hover:bg-zinc-50 cursor-pointer transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                          {addError && (
                            <SelectableErrorMessage kind="inline" className="text-xs">
                              {addError}
                            </SelectableErrorMessage>
                          )}
                        </div>
                      )}
                    </div>

                    {!comingSoon && (
                      <div className="shrink-0 flex flex-col items-end gap-1 pt-0.5">
                        {status.tag === "ok" && (
                          <>
                            <p className="text-[10px] text-secondary/50">
                              {status.backgroundRefreshing ? (
                                <span className="animate-pulse">Refreshing...</span>
                              ) : (
                                formatRefreshedAt(status.refreshedAt)
                              )}
                            </p>
                            <button
                              onClick={() => runFetch(id)}
                              disabled={status.backgroundRefreshing}
                              className="text-xs text-primary hover:text-primary/70 cursor-pointer transition-colors disabled:opacity-40"
                            >
                              Refresh
                            </button>
                            {confirmRevoke === id ? (
                              <div className="flex gap-1 items-center">
                                <button
                                  onClick={() => handleRevokeKey(id)}
                                  className="text-xs text-rose-500 hover:text-rose-400 cursor-pointer transition-colors"
                                >
                                  Revoke
                                </button>
                                <span className="text-[10px] text-secondary/40">
                                  /
                                </span>
                                <button
                                  onClick={() => setConfirmRevoke(null)}
                                  className="text-xs text-secondary hover:text-secondary/70 cursor-pointer transition-colors"
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
                                className="text-xs text-secondary/50 hover:text-rose-400 cursor-pointer transition-colors"
                              >
                                Revoke key
                              </button>
                            )}
                          </>
                        )}
                        {status.tag === "stale" && (
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
                                >
                                  Revoke
                                </button>
                                <span className="text-[10px] text-secondary/40">
                                  /
                                </span>
                                <button
                                  onClick={() => setConfirmRevoke(null)}
                                  className="text-xs text-secondary hover:text-secondary/70 cursor-pointer transition-colors"
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
                                className="text-xs text-secondary/50 hover:text-rose-400 cursor-pointer transition-colors"
                              >
                                Revoke key
                              </button>
                            )}
                          </>
                        )}
                        {(status.tag === "unconfigured" || status.tag === "stale") && !isAdding && (
                          <button
                            onClick={() => {
                              setConfirmRevoke(null);
                              setAddingKey(id);
                              setAddError(null);
                              setKeyInput("");
                            }}
                            className="text-xs text-primary hover:text-primary/70 cursor-pointer transition-colors"
                          >
                            {status.tag === "unconfigured" ? "Add key" : "Update key"}
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

        <section className={CARD_SURFACE}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base text-primary" style={{ fontWeight: 400 }}>
              Subscriptions
            </h2>
            <button
              onClick={() => onNavigate("subscriptions")}
              className="text-xs text-primary hover:text-primary/70 cursor-pointer transition-colors"
            >
              Manage {"->"}
            </button>
          </div>

          {subscriptions.length === 0 ? (
            <div className={EMPTY_DASHED_SURFACE}>
              <p className="text-sm text-zinc-500">No subscriptions tracked yet.</p>
              <button
                onClick={() => onNavigate("subscriptions")}
                className="mt-2 text-xs text-primary hover:text-primary/70 cursor-pointer transition-colors"
              >
                Add subscriptions {"->"}
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {Object.entries(monthlyByCurrency).map(([currency, total]) => {
                const count = subscriptions.filter((subscription) => subscription.currency === currency).length;
                return (
                  <div key={currency} className={SUBTLE_PANEL_SURFACE}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-secondary">
                        {count} subscription{count !== 1 ? "s" : ""} in {currency}
                      </span>
                      <span className="text-sm text-zinc-900">
                        {currency} {total.toFixed(2)}/mo
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
