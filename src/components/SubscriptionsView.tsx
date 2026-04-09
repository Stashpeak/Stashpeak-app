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
  if (!value) {
    return "Not set";
  }

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
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
    if (!window.confirm("Delete this subscription?")) {
      return;
    }

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
    if (selectedPresets.length === 0) {
      return;
    }

    try {
      setIsSaving(true);
      setError(null);

      for (const presetId of selectedPresets) {
        const preset = PRESETS.find((item) => item.id === presetId);
        if (!preset) {
          continue;
        }

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
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="border-b border-zinc-800 px-6 py-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Recurring spend</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Subscription tracker</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
              Track recurring AI subscriptions, quick-add common tools, and keep monthly totals grouped by
              currency. Annual plans are prorated in the totals below.
            </p>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 px-4 py-3 text-right">
            <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Tracked subscriptions</p>
            <p className="mt-2 text-3xl font-semibold text-white">{subscriptions.length}</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          {totals.size === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 px-4 py-3 text-sm text-zinc-500">
              No subscription totals yet.
            </div>
          ) : (
            Array.from(totals.entries()).map(([currency, total]) => (
              <div key={currency} className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">{currency}</p>
                <p className="mt-2 text-lg font-semibold text-white">{formatCurrency(total, currency)}/mo</p>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid flex-1 gap-6 overflow-auto px-6 py-6 xl:grid-cols-[1.4fr_0.9fr]">
        <section className="space-y-6">
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/70 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-white">Quick-add presets</h3>
                <p className="mt-1 text-sm text-zinc-400">
                  Add common subscriptions with one click. Presets start at zero cost so you can fill in your real
                  billing amount afterward.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleQuickAdd()}
                disabled={selectedPresets.length === 0 || isSaving}
                className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add selected
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {PRESETS.map((preset) => {
                const isChecked = selectedPresets.includes(preset.id);

                return (
                  <label
                    key={preset.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${
                      isChecked
                        ? "border-emerald-400/50 bg-emerald-500/10"
                        : "border-zinc-800 bg-zinc-950/70 hover:border-zinc-700"
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
                      className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-emerald-400"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-white">{preset.name}</span>
                      <span className="mt-1 block text-xs uppercase tracking-[0.25em] text-zinc-500">
                        {preset.provider}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/70 p-5">
            <div>
              <h3 className="text-lg font-semibold text-white">Saved subscriptions</h3>
              <p className="mt-1 text-sm text-zinc-400">Everything here is persisted in local SQLite storage.</p>
            </div>

            {isLoading ? (
              <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-8 text-center text-sm text-zinc-500">
                Loading subscriptions...
              </div>
            ) : subscriptions.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/50 px-4 py-8 text-center">
                <p className="text-base font-medium text-white">No subscriptions yet</p>
                <p className="mt-2 text-sm text-zinc-500">Use the form or quick-add presets to create your first entry.</p>
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {subscriptions.map((subscription) => (
                  <article key={subscription.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-base font-semibold text-white">{subscription.name}</h4>
                          <span className="rounded-full border border-zinc-700 px-2 py-1 text-[10px] uppercase tracking-[0.3em] text-zinc-400">
                            {subscription.category}
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-zinc-400">
                          {subscription.provider} · {formatCurrency(subscription.monthlyCost, subscription.currency)} per{" "}
                          {subscription.billingPeriod === "yearly" ? "year" : "month"}
                        </p>
                        <p className="mt-1 text-sm text-zinc-500">
                          Next billing: {formatDate(subscription.nextBillingAt)}
                        </p>
                        {subscription.notes ? (
                          <p className="mt-3 text-sm leading-relaxed text-zinc-400">{subscription.notes}</p>
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
                          className="rounded-full border border-zinc-700 px-3 py-2 text-sm text-zinc-200 transition hover:border-zinc-500 hover:text-white"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(subscription.id)}
                          className="rounded-full border border-rose-500/40 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/10"
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

        <aside className="rounded-3xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-white">
                {editingId === null ? "Add subscription" : "Edit subscription"}
              </h3>
              <p className="mt-1 text-sm text-zinc-400">
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
                className="rounded-full border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-white"
              >
                Cancel edit
              </button>
            ) : null}
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm text-zinc-300">Name</span>
                <input
                  value={form.name}
                  onChange={(event) => updateForm("name", event.target.value)}
                  placeholder="ChatGPT Plus"
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm text-zinc-300">Provider</span>
                <input
                  value={form.provider}
                  onChange={(event) => updateForm("provider", event.target.value)}
                  placeholder="OpenAI"
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm text-zinc-300">Cost</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.monthlyCost}
                  onChange={(event) => updateForm("monthlyCost", event.target.value)}
                  placeholder="20"
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm text-zinc-300">Currency</span>
                <input
                  value={form.currency}
                  onChange={(event) => updateForm("currency", event.target.value.toUpperCase())}
                  maxLength={8}
                  placeholder="USD"
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm text-zinc-300">Billing period</span>
                <select
                  value={form.billingPeriod}
                  onChange={(event) => updateForm("billingPeriod", event.target.value as BillingPeriod)}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
                >
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Annual</option>
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-sm text-zinc-300">Next billing date</span>
                <input
                  type="date"
                  value={form.nextBillingAt}
                  onChange={(event) => updateForm("nextBillingAt", event.target.value)}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
                />
              </label>
            </div>

            <label className="space-y-2">
              <span className="text-sm text-zinc-300">Category</span>
              <input
                value={form.category}
                onChange={(event) => updateForm("category", event.target.value)}
                placeholder="assistant"
                className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm text-zinc-300">Notes</span>
              <textarea
                value={form.notes}
                onChange={(event) => updateForm("notes", event.target.value)}
                rows={4}
                placeholder="Seat count, billing quirks, or reminder notes..."
                className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/50"
              />
            </label>

            {error ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={isSaving}
              className="w-full rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : editingId === null ? "Create subscription" : "Save changes"}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}
