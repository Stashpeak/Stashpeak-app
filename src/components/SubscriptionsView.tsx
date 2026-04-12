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
import { EMPTY_FORM, SubscriptionForm, toFormState, toPayload, type FormState } from "./SubscriptionForm";
import { monthlyEquivalent, formatCurrency, SubscriptionList } from "./SubscriptionList";
import { PRESETS, SubscriptionPresets } from "./SubscriptionPresets";

const SEED_CATEGORIES = ["AI", "Assistant", "Audio", "Coding", "Image", "Research", "Video"];

export function SubscriptionsView() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [homeCurrency, setHomeCurrency] = useState<string>("USD");
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);

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

  async function handleQuickAdd() {
    if (selectedPresets.length === 0) return;

    try {
      setIsSaving(true);
      setError(null);

      for (const presetId of selectedPresets) {
        const preset = PRESETS.find((item) => item.id === presetId);
        if (!preset) continue;

        await createSubscription({
          name: preset.name,
          provider: preset.provider,
          monthlyCost: 0,
          currency: preset.currency,
          billingPeriod: "monthly",
          nextBillingAt: null,
          category: formatCategoryLabel(preset.category),
          notes: "Quick-added from presets. Fill in your actual billing details.",
        });
      }

      setSelectedPresets([]);
      await loadSubscriptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add presets");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      className="flex h-full flex-col bg-white"
      style={{ fontFamily: "'Kumbh Sans', sans-serif" }}
    >
      {/* Page header */}
      <div className="border-b border-zinc-100 px-8 py-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-[#625b71]/60">
              Recurring spend
            </p>
            <h2
              className="mt-1.5 text-3xl text-[#6750a4]"
              style={{ fontWeight: 300, letterSpacing: "-0.5px" }}
            >
              Subscription tracker
            </h2>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-[#625b71]">
              Track recurring AI subscriptions, quick-add common tools, and keep monthly totals grouped by currency.
              Annual plans are prorated in the totals below.
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-100 bg-zinc-50 px-5 py-3.5 text-right shadow-sm">
            <p className="text-[10px] uppercase tracking-[0.3em] text-[#625b71]/60">Tracked</p>
            <p className="mt-1 text-3xl text-[#6750a4]" style={{ fontWeight: 300 }}>
              {subscriptions.length}
            </p>
          </div>
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
                <div className="rounded-full border border-[#6750a4]/20 bg-[#6750a4]/6 px-4 py-2 shadow-sm flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-[#6750a4]/70 mr-1">
                    ~{homeCurrency}
                  </span>
                  <span className="text-sm font-medium text-[#6750a4]">
                    {formatCurrency(aggregateTotal.total, homeCurrency)}/mo
                  </span>
                  {aggregateTotal.hasMissingRate && (
                    <span
                      title="Some currencies are missing exchange rates — set them in Settings"
                      className="text-amber-500 text-xs cursor-help"
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
                  className="rounded-full border border-zinc-200 bg-white px-4 py-2 shadow-sm"
                >
                  <span className="text-[10px] uppercase tracking-[0.2em] text-[#625b71]/60 mr-2">{currency}</span>
                  <span className="text-sm font-medium text-[#6750a4]">{formatCurrency(total, currency)}/mo</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="grid flex-1 gap-6 overflow-auto px-8 py-6 xl:grid-cols-[1.4fr_0.9fr]">
        <section className="space-y-5">
          <SubscriptionPresets
            selectedPresets={selectedPresets}
            onSelectionChange={setSelectedPresets}
            onQuickAdd={() => void handleQuickAdd()}
            isSaving={isSaving}
          />
          <SubscriptionList
            subscriptions={subscriptions}
            isLoading={isLoading}
            onEdit={(sub) => {
              setEditingId(sub.id);
              setForm(toFormState(sub));
              setError(null);
            }}
            onDelete={handleDelete}
          />
        </section>

        <SubscriptionForm
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
      </div>
    </div>
  );
}
