import { useEffect, useState } from "react";
import type { Section } from "../App";
import { deleteProviderApiKey, storeProviderApiKey } from "../lib/credentials";
import {
  CARD_SURFACE,
  EMPTY_DASHED_SURFACE,
  PILL_SURFACE,
  SUBTLE_PANEL_SURFACE,
} from "../lib/surfaceStyles";
import { listSubscriptions, type Subscription } from "../lib/subscriptions";
import { formatProviderRefreshedAt, type ProviderId } from "../lib/spendProviders";
import { useSpendData } from "../hooks/useSpendData";
import { ProviderCard } from "./ProviderCard";
import { SelectableErrorMessage } from "./SelectableErrorMessage";
import { StatHero } from "./StatHero";

export function SpendView({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionsError, setSubscriptionsError] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<ProviderId | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ProviderId | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [gcpProject, setGcpProject] = useState("");
  const [gcpDataset, setGcpDataset] = useState("");
  const [gcpTable, setGcpTable] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const { clear, loadError, refresh, refreshAll, states, visibleProviders } = useSpendData();

  useEffect(() => {
    let cancelled = false;

    listSubscriptions()
      .then((data) => {
        if (!cancelled) setSubscriptions(data);
      })
      .catch((e) => {
        if (!cancelled) setSubscriptionsError(String(e));
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
      void refresh(id);
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
    clear(id);
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

  const apiTotal = visibleProviders.reduce((sum, { id }) => {
    const status = states[id];
    return status.tag === "ok" ? sum + status.data.currentMonthUsd : sum;
  }, 0);

  const hasAnyApiData = visibleProviders.some(({ id }) => states[id].tag === "ok");

  const monthlyByCurrency = subscriptions.reduce(
    (acc, subscription) => {
      acc[subscription.currency] = (acc[subscription.currency] ?? 0) + subscription.monthlyCost;
      return acc;
    },
    {} as Record<string, number>,
  );

  const hasConfiguredProviders = visibleProviders.some(({ id }) => states[id].tag !== "unconfigured");

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-100 px-8 py-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--purple-label)]">API Usage</p>
            <h2 className="mt-1.5 text-3xl text-[var(--text-primary)] font-light tracking-tight">Spend tracker</h2>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
              Monitor your API usage across various providers and track your monthly subscription costs in one place.
            </p>
          </div>

          <StatHero label="Providers" value={String(visibleProviders.length)} />
        </div>

        {(hasAnyApiData || subscriptions.length > 0) && (
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {hasAnyApiData && (
              <div className={`${PILL_SURFACE} flex items-center gap-1.5`}>
                <span className="text-[10px] uppercase tracking-[0.2em] text-secondary/60 mr-1">API this month</span>
                <span className="text-sm font-medium text-ink">${apiTotal.toFixed(2)}</span>
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

      <div className="flex flex-1 flex-col gap-6 overflow-auto px-8 py-6">
        {loadError && <SelectableErrorMessage>{loadError}</SelectableErrorMessage>}
        {subscriptionsError && <SelectableErrorMessage>{subscriptionsError}</SelectableErrorMessage>}

        <section className={CARD_SURFACE}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base text-primary font-normal">API Spend</h2>
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
              const status = states[id];
              return (
                <ProviderCard
                  key={id}
                  provider={{ id, name, note, comingSoon }}
                  status={status}
                  isAdding={addingKey === id}
                  isConfirmingRevoke={confirmRevoke === id}
                  keyInput={keyInput}
                  gcpProject={gcpProject}
                  gcpDataset={gcpDataset}
                  gcpTable={gcpTable}
                  addError={addError}
                  savingKey={savingKey}
                  onKeyInputChange={setKeyInput}
                  onGcpProjectChange={setGcpProject}
                  onGcpDatasetChange={setGcpDataset}
                  onGcpTableChange={setGcpTable}
                  onSaveKey={handleSaveKey}
                  onCancelAddKey={cancelAddKey}
                  onRefresh={(providerId) => void refresh(providerId)}
                  onRevokeKey={(providerId) => void handleRevokeKey(providerId)}
                  onToggleConfirmRevoke={(providerId) => {
                    if (confirmRevoke === providerId) {
                      setConfirmRevoke(null);
                      return;
                    }
                    if (addingKey === providerId) cancelAddKey();
                    setConfirmRevoke(providerId);
                  }}
                  onStartAddKey={(providerId) => {
                    setConfirmRevoke(null);
                    setAddingKey(providerId);
                    setAddError(null);
                    setKeyInput("");
                  }}
                  formatRefreshedAt={formatProviderRefreshedAt}
                />
              );
            })}
          </div>
        </section>

        <section className={CARD_SURFACE}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base text-primary font-normal">Subscriptions</h2>
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
