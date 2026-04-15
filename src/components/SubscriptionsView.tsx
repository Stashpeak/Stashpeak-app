import { useEffect, useMemo, useState } from "react";
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
  type Subscription,
} from "../lib/subscriptions";
import { getHomeCurrency, getExchangeRates, type ExchangeRate } from "../lib/settings";
import { formatCategoryLabel } from "../lib/categoryFormatting";
import { PRESETS, type Preset } from "../lib/subscriptionPresets";
import { formatCurrency, monthlyEquivalent } from "../lib/subscriptionMetrics";
import { EMPTY_FORM, SubscriptionForm, toFormState, toPayload, type FormState } from "./SubscriptionForm";
import { SubscriptionList } from "./SubscriptionList";
import { SubscriptionPresets } from "./SubscriptionPresets";
import { ACCENT_PILL_SURFACE, PILL_SURFACE, WARNING_PILL_SURFACE } from "../lib/surfaceStyles";
import { StatHero } from "./StatHero";
import { useUpcomingRenewals } from "../hooks/useUpcomingRenewals";

const SEED_CATEGORIES = ["AI", "Assistant", "Audio", "Coding", "Image", "Research", "Video"];

export function SubscriptionsView() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [homeCurrency, setHomeCurrency] = useState<string>("USD");
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const upcomingRenewals = useUpcomingRenewals(subscriptions);

  async function loadSubscriptions() {
    try {
      setError(null);
      setSubscriptions(await listSubscriptions());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscriptions");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadSubscriptions();
    getHomeCurrency().then(setHomeCurrency).catch(console.error);
    getExchangeRates().then(setExchangeRates).catch(console.error);
  }, []);

  // Share subscription currencies with SettingsView via sessionStorage
  useEffect(() => {
    const currencies = [...new Set(subscriptions.map((s) => s.currency))];
    sessionStorage.setItem("sub_currencies", JSON.stringify(currencies));
  }, [subscriptions]);

  const totals = useMemo(() => {
    return subscriptions.reduce<Map<string, number>>((acc, subscription) => {
      const current = acc.get(subscription.currency) ?? 0;
      acc.set(subscription.currency, current + monthlyEquivalent(subscription));
      return acc;
    }, new Map());
  }, [subscriptions]);

  // Build a lookup: fromCurrency → rate to homeCurrency
  const rateMap = useMemo(() => {
    const map = new Map<string, number>();
    // 1:1 for the home currency itself
    map.set(homeCurrency, 1);
    for (const r of exchangeRates) {
      if (r.toCurrency === homeCurrency) {
        map.set(r.fromCurrency, r.rate);
      }
    }
    return map;
  }, [exchangeRates, homeCurrency]);

  // Aggregate total in home currency
  const aggregateTotal = useMemo(() => {
    if (subscriptions.length === 0) return null;

    let total = 0;
    let hasMissingRate = false;
    let allSameCurrency = true;

    for (const sub of subscriptions) {
      if (sub.currency !== homeCurrency) allSameCurrency = false;
      const rate = rateMap.get(sub.currency);
      if (rate === undefined) {
        hasMissingRate = true;
      } else {
        total += monthlyEquivalent(sub) * rate;
      }
    }

    // If every subscription is already in the home currency, aggregate is same as the single pill — skip it
    if (allSameCurrency) return null;

    return { total, hasMissingRate };
  }, [subscriptions, rateMap, homeCurrency]);

  const categories = useMemo(() => {
    const fromSubs = subscriptions.map((s) => formatCategoryLabel(s.category)).filter(Boolean);
    const fromPresets = PRESETS.map((p) => formatCategoryLabel(p.category));
    return [...new Set([...SEED_CATEGORIES, ...fromPresets, ...fromSubs])].sort((a, b) => a.localeCompare(b));
  }, [subscriptions]);

  const names = useMemo(() => {
    const fromSubs = subscriptions.map((s) => s.name.trim()).filter(Boolean);
    const fromPresets = PRESETS.map((p) => p.name);
    return [...new Set([...fromPresets, ...fromSubs])].sort();
  }, [subscriptions]);

  const providers = useMemo(() => {
    const fromSubs = subscriptions.map((s) => s.provider.trim()).filter(Boolean);
    const fromPresets = PRESETS.map((p) => p.provider);
    return [...new Set([...fromPresets, ...fromSubs])].sort();
  }, [subscriptions]);

  function updateForm(key: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [key]: value } as FormState));
  }

  async function handleSubmit() {
    if (form.monthlyCost.trim() === "") {
      setError("Cost is required");
      return;
    }

    const payload = toPayload(form);
    if (Number.isNaN(payload.monthlyCost)) {
      setError("Cost must be a valid number");
      return;
    }

    try {
      setIsSaving(true);
      setError(null);

      if (editingId === null) {
        await createSubscription(payload);
      } else {
        await updateSubscription(editingId, payload);
      }

      setForm(EMPTY_FORM);
      setEditingId(null);
      setShowAddForm(false);
      await loadSubscriptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save subscription");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this subscription?")) return;

    try {
      setError(null);
      await deleteSubscription(id);
      if (editingId === id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      await loadSubscriptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete subscription");
    }
  }

  function handlePresetSelect(preset: Preset) {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, name: preset.name, provider: preset.provider, currency: preset.currency, category: formatCategoryLabel(preset.category) });
    setShowAddForm(true);
    setError(null);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Page header */}
      <div className="border-b border-zinc-100 px-8 py-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--purple-label)]">
              Recurring spend
            </p>
            <h2
              className="mt-1.5 text-3xl text-[var(--text-primary)] font-light tracking-tight"
            >
              Subscription tracker
            </h2>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
              Track recurring AI subscriptions, quick-add common tools, and keep monthly totals grouped by currency.
              Annual plans are prorated in the totals below.
            </p>
          </div>

          <StatHero label="Tracked" value={String(subscriptions.length)} />
        </div>

        {/* Totals row */}
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {totals.size === 0 ? (
            <div className="rounded-full border border-dashed border-zinc-200 px-4 py-2 text-xs text-zinc-400">
              No totals yet
            </div>
          ) : (
            <>
              {/* Aggregate home-currency chip — only shown when there are multiple currencies */}
              {aggregateTotal !== null && (
                <div className={`${ACCENT_PILL_SURFACE} flex items-center gap-1.5`}>
                  <span className="text-[10px] uppercase tracking-[0.2em] text-primary/70 mr-1">
                    ~{homeCurrency}
                  </span>
                  <span className="text-sm font-medium text-primary">
                    {formatCurrency(aggregateTotal.total, homeCurrency)}/mo
                  </span>
                  {aggregateTotal.hasMissingRate && (
                    <span
                      title="Some currencies are missing exchange rates — set them in Settings"
                      className="text-[var(--warning-text)] text-xs cursor-help"
                    >
                      ⚠️
                    </span>
                  )}
                </div>
              )}

              {/* Per-currency breakdown */}
              {Array.from(totals.entries()).map(([currency, total]) => (
                <div
                  key={currency}
                  className={PILL_SURFACE}
                >
                  <span className="text-[10px] uppercase tracking-[0.2em] text-secondary/60 mr-2">{currency}</span>
                  <span className="text-sm font-medium text-primary">{formatCurrency(total, currency)}/mo</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Upcoming renewals banner */}
        {upcomingRenewals.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {upcomingRenewals.map((renewal) => {
              const when =
                renewal.daysUntil === 0
                  ? "today"
                  : renewal.daysUntil === 1
                    ? "in 1 day"
                    : `in ${renewal.daysUntil} days`;
              return (
                <div
                  key={`${renewal.id}-${renewal.nextBillingAt}`}
                  className={`${WARNING_PILL_SURFACE} flex items-center gap-2`}
                >
                  <span className="shrink-0">⏰</span>
                  <span>
                    <span className="font-medium">{renewal.name}</span>
                    {" renews "}
                    <span className="font-medium">{when}</span>
                    {" — "}
                    {formatCurrency(renewal.cost, renewal.currency)}/{renewal.billingPeriod}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-6 overflow-auto px-8 py-6">
        <section className="space-y-5">
          <SubscriptionPresets
            onPresetSelect={handlePresetSelect}
          />
          <SubscriptionForm
            form={form}
            categories={categories}
            names={names}
            providers={providers}
            editingId={null}
            isSaving={isSaving}
            error={error}
            collapsed={!showAddForm}
            onToggleCollapse={() => {
              setShowAddForm((v) => !v);
              setForm(EMPTY_FORM);
              setError(null);
            }}
            onChange={updateForm}
            onSubmit={() => void handleSubmit()}
            onCancel={() => {
              setShowAddForm(false);
              setForm(EMPTY_FORM);
              setError(null);
            }}
          />
          <SubscriptionList
            subscriptions={subscriptions}
            isLoading={isLoading}
            editingId={editingId}
            inlineEditForm={
              editingId !== null ? (
                <SubscriptionForm
                  compact
                  form={form}
                  categories={categories}
                  names={names}
                  providers={providers}
                  editingId={editingId}
                  isSaving={isSaving}
                  error={error}
                  onChange={updateForm}
                  onSubmit={() => void handleSubmit()}
                  onCancel={() => {
                    setEditingId(null);
                    setForm(EMPTY_FORM);
                    setError(null);
                  }}
                />
              ) : null
            }
            onEdit={(sub) => {
              setShowAddForm(false);
              setEditingId(sub.id);
              setForm(toFormState(sub));
              setError(null);
            }}
            onDelete={handleDelete}
          />
        </section>
      </div>
    </div>
  );
}
