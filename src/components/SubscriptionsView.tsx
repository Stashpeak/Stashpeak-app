import { useEffect, useMemo, useState } from "react";
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
  type Subscription,
} from "../lib/subscriptions";
import { formatCategoryLabel } from "../lib/categoryFormatting";
import { getHomeCurrency, getExchangeRates, type ExchangeRate } from "../lib/settings";
import { formatCurrency, monthlyEquivalent } from "../lib/subscriptionMetrics";
import { PRESETS, type Preset } from "../lib/subscriptionPresets";
import { ACCENT_PILL_SURFACE, PILL_SURFACE } from "../lib/surfaceStyles";
import { useUpcomingRenewals } from "../hooks/useUpcomingRenewals";
import { RenewalBanner } from "./RenewalBanner";
import { StatHero } from "./StatHero";
import { SubscriptionForm, EMPTY_FORM, toFormState, toPayload, type FormState } from "./SubscriptionForm";
import { SubscriptionList } from "./SubscriptionList";
import { SubscriptionPresets } from "./SubscriptionPresets";

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

  // Share subscription currencies with SettingsView via sessionStorage.
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

  // Build a lookup from currency to home-currency rate.
  const rateMap = useMemo(() => {
    const map = new Map<string, number>();
    map.set(homeCurrency, 1);
    for (const rate of exchangeRates) {
      if (rate.toCurrency === homeCurrency) {
        map.set(rate.fromCurrency, rate.rate);
      }
    }
    return map;
  }, [exchangeRates, homeCurrency]);

  // Aggregate total in home currency.
  const aggregateTotal = useMemo(() => {
    if (subscriptions.length === 0) return null;

    let total = 0;
    let hasMissingRate = false;
    let allSameCurrency = true;

    for (const subscription of subscriptions) {
      if (subscription.currency !== homeCurrency) allSameCurrency = false;
      const rate = rateMap.get(subscription.currency);
      if (rate === undefined) {
        hasMissingRate = true;
      } else {
        total += monthlyEquivalent(subscription) * rate;
      }
    }

    // Skip the aggregate when every subscription already matches the home currency.
    if (allSameCurrency) return null;

    return { total, hasMissingRate };
  }, [subscriptions, rateMap, homeCurrency]);

  const categories = useMemo(() => {
    const fromSubscriptions = subscriptions.map((s) => formatCategoryLabel(s.category)).filter(Boolean);
    const fromPresets = PRESETS.map((p) => formatCategoryLabel(p.category));
    return [...new Set([...SEED_CATEGORIES, ...fromPresets, ...fromSubscriptions])].sort((a, b) => a.localeCompare(b));
  }, [subscriptions]);

  const names = useMemo(() => {
    const fromSubscriptions = subscriptions.map((s) => s.name.trim()).filter(Boolean);
    const fromPresets = PRESETS.map((p) => p.name);
    return [...new Set([...fromPresets, ...fromSubscriptions])].sort();
  }, [subscriptions]);

  const providers = useMemo(() => {
    const fromSubscriptions = subscriptions.map((s) => s.provider.trim()).filter(Boolean);
    const fromPresets = PRESETS.map((p) => p.provider);
    return [...new Set([...fromPresets, ...fromSubscriptions])].sort();
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
    setForm({
      ...EMPTY_FORM,
      name: preset.name,
      provider: preset.provider,
      currency: preset.currency,
      category: formatCategoryLabel(preset.category),
    });
    setShowAddForm(true);
    setError(null);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-100 px-8 py-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-(--purple-label)">Recurring spend</p>
            <h2 className="mt-1.5 text-3xl font-light tracking-tight text-(--text-primary)">
              Subscription tracker
            </h2>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-(--text-secondary)">
              Track recurring AI subscriptions, quick-add common tools, and keep monthly totals grouped by currency.
              Annual plans are prorated in the totals below.
            </p>
          </div>

          <StatHero label="Tracked" value={String(subscriptions.length)} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {totals.size === 0 ? (
            <div className="rounded-full border border-dashed border-zinc-200 px-4 py-2 text-xs text-zinc-400">
              No totals yet
            </div>
          ) : (
            <>
              {aggregateTotal !== null && (
                <div className={`${ACCENT_PILL_SURFACE} flex items-center gap-1.5`}>
                  <span className="mr-1 text-[10px] uppercase tracking-[0.2em] text-primary/70">
                    ~{homeCurrency}
                  </span>
                  <span className="text-sm font-medium text-primary">
                    {formatCurrency(aggregateTotal.total, homeCurrency)}/mo
                  </span>
                  {aggregateTotal.hasMissingRate && (
                    <span
                      title={"Some currencies are missing exchange rates \u2014 set them in Settings"}
                      className="cursor-help text-xs text-(--warning-text)"
                    >
                      {"\u26A0\uFE0F"}
                    </span>
                  )}
                </div>
              )}

              {Array.from(totals.entries()).map(([currency, total]) => (
                <div key={currency} className={PILL_SURFACE}>
                  <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-secondary/60">{currency}</span>
                  <span className="text-sm font-medium text-primary">{formatCurrency(total, currency)}/mo</span>
                </div>
              ))}
            </>
          )}
        </div>

        <RenewalBanner renewals={upcomingRenewals} />
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-auto px-8 py-6">
        <section className="space-y-5">
          <SubscriptionPresets onPresetSelect={handlePresetSelect} />
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
              setShowAddForm((value) => !value);
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
            onEdit={(subscription) => {
              setShowAddForm(false);
              setEditingId(subscription.id);
              setForm(toFormState(subscription));
              setError(null);
            }}
            onDelete={handleDelete}
          />
        </section>
      </div>
    </div>
  );
}
