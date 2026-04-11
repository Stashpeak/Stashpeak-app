import { type BillingPeriod, type Subscription, type SubscriptionInput } from "../lib/subscriptions";
import { SelectableErrorMessage } from "./SelectableErrorMessage";

export type FormState = {
  name: string;
  provider: string;
  monthlyCost: string;
  currency: string;
  billingPeriod: BillingPeriod;
  nextBillingAt: string;
  category: string;
  notes: string;
};

export const EMPTY_FORM: FormState = {
  name: "",
  provider: "",
  monthlyCost: "",
  currency: "USD",
  billingPeriod: "monthly",
  nextBillingAt: "",
  category: "ai",
  notes: "",
};

export function toFormState(subscription: Subscription): FormState {
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

export function toPayload(form: FormState): SubscriptionInput {
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

interface SubscriptionFormProps {
  form: FormState;
  editingId: number | null;
  isSaving: boolean;
  error: string | null;
  onChange: (field: keyof FormState, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function SubscriptionForm({
  form,
  editingId,
  isSaving,
  error,
  onChange,
  onSubmit,
  onCancel,
}: SubscriptionFormProps) {
  return (
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
            onClick={onCancel}
            className="shrink-0 rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700"
          >
            Cancel
          </button>
        ) : null}
      </div>

      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className={labelClass}>Name</span>
            <input
              value={form.name}
              onChange={(e) => onChange("name", e.target.value)}
              placeholder="ChatGPT Plus"
              className={inputClass}
            />
          </label>
          <label className="space-y-1.5">
            <span className={labelClass}>Provider</span>
            <input
              value={form.provider}
              onChange={(e) => onChange("provider", e.target.value)}
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
              onChange={(e) => onChange("monthlyCost", e.target.value)}
              placeholder="20"
              className={inputClass}
            />
          </label>
          <label className="space-y-1.5">
            <span className={labelClass}>Currency</span>
            <input
              value={form.currency}
              onChange={(e) => onChange("currency", e.target.value.toUpperCase())}
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
              onChange={(e) => onChange("billingPeriod", e.target.value)}
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
              onChange={(e) => onChange("nextBillingAt", e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="space-y-1.5">
          <span className={labelClass}>Category</span>
          <input
            value={form.category}
            onChange={(e) => onChange("category", e.target.value)}
            placeholder="assistant"
            className={inputClass}
          />
        </label>

        <label className="space-y-1.5">
          <span className={labelClass}>Notes</span>
          <textarea
            value={form.notes}
            onChange={(e) => onChange("notes", e.target.value)}
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
  );
}
