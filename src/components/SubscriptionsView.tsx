import { useEffect, useMemo, useState } from "react";
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
  type BillingPeriod,
  type Subscription,
  type SubscriptionInput,
} from "../lib/subscriptions";
import { SelectableErrorMessage } from "./SelectableErrorMessage";

type FormState = {
  name: string;
  provider: string;
  monthlyCost: string;
  currency: string;
  billingPeriod: BillingPeriod;
  nextBillingAt: string;
  category: string;
  notes: string;
};

type Preset = {
  id: string;
  name: string;
  provider: string;
  currency: string;
  category: string;
};

const PRESETS: Preset[] = [
  { id: "chatgpt-plus", name: "ChatGPT Plus", provider: "OpenAI", currency: "USD", category: "assistant" },
  { id: "claude-pro", name: "Claude Pro", provider: "Anthropic", currency: "USD", category: "assistant" },
  { id: "cursor", name: "Cursor", provider: "Cursor", currency: "USD", category: "coding" },
  { id: "github-copilot", name: "GitHub Copilot", provider: "GitHub", currency: "USD", category: "coding" },
  { id: "midjourney", name: "Midjourney", provider: "Midjourney", currency: "USD", category: "image" },
  { id: "perplexity-pro", name: "Perplexity Pro", provider: "Perplexity", currency: "USD", category: "research" },
  { id: "elevenlabs", name: "ElevenLabs", provider: "ElevenLabs", currency: "USD", category: "audio" },
  { id: "runway", name: "Runway", provider: "Runway", currency: "USD", category: "video" },
];

const EMPTY_FORM: FormState = {
  name: "",
  provider: "",
  monthlyCost: "",
  currency: "USD",
  billingPeriod: "monthly",
  nextBillingAt: "",
  category: "ai",
  notes: "",
};

function toFormState(subscription: Subscription): FormState {
  return {
    name: subscription.name,
    provider: subscription.provider,
    monthlyCost: subscription.monthlyCost.toString(),
    currency: subscription.currency,
    billingPeriod: subscription.billingPeriod,
    nextBillingAt: subscription.nextBillingAt ?? "",
    category: subscription.category,
    notes: subscription.notes,
  };
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Not set";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function monthlyEquivalent(subscription: Subscription): number {
  return subscription.billingPeriod === "yearly"
    ? subscription.monthlyCost / 12
    : subscription.monthlyCost;
}

function toPayload(form: FormState): SubscriptionInput {
  return {
    name: form.name.trim(),
    provider: form.provider.trim(),
    monthlyCost: Number(form.monthlyCost),
    currency: form.currency.trim().toUpperCase(),
    billingPeriod: form.billingPeriod,
    nextBillingAt: form.nextBillingAt.trim() || null,
    category: form.category.trim(),
    notes: form.notes,
  };
}

const inputClass =
  "w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition focus:border-[#6750a4] focus:ring-2 focus:ring-[#6750a4]/10 placeholder:text-zinc-300";

const labelClass = "text-xs text-[#625b71] tracking-wide";

export function SubscriptionsView() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, []);

  const totals = useMemo(() => {
    return subscriptions.reduce<Map<string, number>>((acc, subscription) => {
      const current = acc.get(subscription.currency) ?? 0;
      acc.set(subscription.currency, current + monthlyEquivalent(subscription));
      return acc;
    }, new Map());
  }, [subscriptions]);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();

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
          category: preset.category,
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
            <p
              className="text-[10px] uppercase tracking-[0.3em] text-[#625b71]/60"
            >
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

          {/* Tracked count */}
          <div className="rounded-2xl border border-zinc-100 bg-zinc-50 px-5 py-3.5 text-right shadow-sm">
            <p className="text-[10px] uppercase tracking-[0.3em] text-[#625b71]/60">Tracked</p>
            <p className="mt-1 text-3xl text-[#6750a4]" style={{ fontWeight: 300 }}>
              {subscriptions.length}
            </p>
          </div>
        </div>

        {/* Currency totals */}
        <div className="mt-4 flex flex-wrap gap-2.5">
          {totals.size === 0 ? (
            <div className="rounded-full border border-dashed border-zinc-200 px-4 py-2 text-xs text-zinc-400">
              No totals yet
            </div>
          ) : (
            Array.from(totals.entries()).map(([currency, total]) => (
              <div
                key={currency}
                className="rounded-full border border-zinc-200 bg-white px-4 py-2 shadow-sm"
              >
                <span className="text-[10px] uppercase tracking-[0.2em] text-[#625b71]/60 mr-2">{currency}</span>
                <span className="text-sm font-medium text-[#6750a4]">{formatCurrency(total, currency)}/mo</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Body */}
      <div className="grid flex-1 gap-6 overflow-auto px-8 py-6 xl:grid-cols-[1.4fr_0.9fr]">
        {/* Left column */}
        <section className="space-y-5">
          {/* Quick-add presets */}
          <div className="rounded-3xl border border-zinc-100 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base text-[#6750a4]" style={{ fontWeight: 400 }}>
                  Quick-add presets
                </h3>
                <p className="mt-1 text-sm text-[#625b71]">
                  Add common subscriptions with one click. Presets start at zero cost so you can fill in your real
                  billing amount afterward.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleQuickAdd()}
                disabled={selectedPresets.length === 0 || isSaving}
                className="rounded-full border border-[#6750a4]/30 bg-[#6750a4]/8 px-4 py-2 text-sm text-[#6750a4] transition hover:bg-[#6750a4]/15 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ fontFamily: "'Roboto', sans-serif", fontWeight: 500 }}
              >
                Add selected
              </button>
            </div>

            <div className="mt-5 grid gap-2.5 md:grid-cols-2">
              {PRESETS.map((preset) => {
                const isChecked = selectedPresets.includes(preset.id);
                return (
                  <label
                    key={preset.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                      isChecked
                        ? "border-[#6750a4]/30 bg-[#6750a4]/5"
                        : "border-zinc-100 bg-zinc-50/50 hover:border-zinc-200"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(event) => {
                        setSelectedPresets((current) =>
                          event.target.checked
                            ? [...current, preset.id]
                            : current.filter((value) => value !== preset.id),
                        );
                      }}
                      className="h-4 w-4 rounded-full border-zinc-300 text-[#6750a4] accent-[#6750a4]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-zinc-800">{preset.name}</span>
                      <span className="mt-0.5 block text-[10px] uppercase tracking-[0.2em] text-[#625b71]/50">
                        {preset.provider}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Saved subscriptions */}
          <div className="rounded-3xl border border-zinc-100 bg-white p-6 shadow-sm">
            <h3 className="text-base text-[#6750a4]" style={{ fontWeight: 400 }}>
              Saved subscriptions
            </h3>
            <p className="mt-1 text-sm text-[#625b71]">Everything here is persisted in local SQLite storage.</p>

            {isLoading ? (
              <div className="mt-5 rounded-2xl border border-zinc-100 px-4 py-8 text-center text-sm text-[#625b71]/50">
                Loading subscriptions…
              </div>
            ) : subscriptions.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-zinc-200 px-4 py-10 text-center">
                <p className="text-sm text-zinc-500">No subscriptions yet</p>
                <p className="mt-1 text-xs text-zinc-400">
                  Use the form or quick-add presets to create your first entry.
                </p>
              </div>
            ) : (
              <div className="mt-5 space-y-2.5">
                {subscriptions.map((subscription) => (
                  <article
                    key={subscription.id}
                    className="rounded-2xl border border-zinc-100 bg-zinc-50/60 p-4 transition hover:border-zinc-200"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-medium text-zinc-900">{subscription.name}</h4>
                          <span className="rounded-full border border-[#6750a4]/20 px-2 py-0.5 text-[9px] uppercase tracking-[0.25em] text-[#6750a4]/70">
                            {subscription.category}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs text-[#625b71]">
                          {subscription.provider} ·{" "}
                          <span className="text-zinc-700">
                            {formatCurrency(subscription.monthlyCost, subscription.currency)} per{" "}
                            {subscription.billingPeriod === "yearly" ? "year" : "month"}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-[#625b71]/60">
                          Next billing: {formatDate(subscription.nextBillingAt)}
                        </p>
                        {subscription.notes ? (
                          <p className="mt-2.5 text-xs leading-relaxed text-[#625b71]/70 italic">
                            {subscription.notes}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(subscription.id);
                            setForm(toFormState(subscription));
                            setError(null);
                          }}
                          className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(subscription.id)}
                          className="rounded-full border border-rose-200 px-3 py-1.5 text-xs text-rose-400 transition hover:bg-rose-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Right column — form */}
        <aside className="rounded-3xl border border-zinc-100 bg-white p-6 shadow-sm self-start">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base text-[#6750a4]" style={{ fontWeight: 400 }}>
                {editingId === null ? "Add subscription" : "Edit subscription"}
              </h3>
              <p className="mt-1 text-sm text-[#625b71]">
                Store the original amount and billing cadence. Totals are grouped per currency.
              </p>
            </div>
            {editingId !== null ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_FORM);
                  setError(null);
                }}
                className="shrink-0 rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700"
              >
                Cancel
              </button>
            ) : null}
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Name</span>
                <input
                  value={form.name}
                  onChange={(e) => updateForm("name", e.target.value)}
                  placeholder="ChatGPT Plus"
                  className={inputClass}
                />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Provider</span>
                <input
                  value={form.provider}
                  onChange={(e) => updateForm("provider", e.target.value)}
                  placeholder="OpenAI"
                  className={inputClass}
                />
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Cost</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.monthlyCost}
                  onChange={(e) => updateForm("monthlyCost", e.target.value)}
                  placeholder="20"
                  className={inputClass}
                />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Currency</span>
                <input
                  value={form.currency}
                  onChange={(e) => updateForm("currency", e.target.value.toUpperCase())}
                  maxLength={8}
                  placeholder="USD"
                  className={inputClass}
                />
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className={labelClass}>Billing period</span>
                <select
                  value={form.billingPeriod}
                  onChange={(e) => updateForm("billingPeriod", e.target.value as BillingPeriod)}
                  className={inputClass}
                >
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Annual</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Next billing date</span>
                <input
                  type="date"
                  value={form.nextBillingAt}
                  onChange={(e) => updateForm("nextBillingAt", e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>

            <label className="space-y-1.5">
              <span className={labelClass}>Category</span>
              <input
                value={form.category}
                onChange={(e) => updateForm("category", e.target.value)}
                placeholder="assistant"
                className={inputClass}
              />
            </label>

            <label className="space-y-1.5">
              <span className={labelClass}>Notes</span>
              <textarea
                value={form.notes}
                onChange={(e) => updateForm("notes", e.target.value)}
                rows={3}
                placeholder="Seat count, billing quirks, or reminder notes…"
                className={inputClass}
                style={{ resize: "none" }}
              />
            </label>

            {error ? (
              <SelectableErrorMessage>
                {error}
              </SelectableErrorMessage>
            ) : null}

            <button
              type="submit"
              disabled={isSaving}
              className="w-full rounded-full bg-[#6750a4] px-4 py-3 text-sm text-white transition hover:bg-[#5a4490] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ fontFamily: "'Roboto', sans-serif", fontWeight: 500 }}
            >
              {isSaving ? "Saving…" : editingId === null ? "Create subscription" : "Save changes"}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}
