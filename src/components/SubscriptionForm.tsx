import { CARD_SURFACE, SECONDARY_BUTTON_SURFACE, TEXT_INPUT_SURFACE } from "../lib/surfaceStyles";
import {
  type BillingPeriod,
  type Subscription,
  type SubscriptionInput,
} from "../lib/subscriptions";
import { formatCategoryLabel } from "../lib/categoryFormatting";
import { CURRENCY_OPTIONS } from "../lib/currencies";
import { CategorySelector } from "./CategorySelector";
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
  category: "AI",
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
    category: formatCategoryLabel(subscription.category),
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
    category: formatCategoryLabel(form.category),
    notes: form.notes,
  };
}

const inputClass = `${TEXT_INPUT_SURFACE} px-4 py-3`;

const labelClass = "text-xs text-secondary tracking-wide";

interface SubscriptionFormProps {
  form: FormState;
  categories: string[];
  names: string[];
  providers: string[];
  editingId: number | null;
  isSaving: boolean;
  error: string | null;
  compact?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onChange: (field: keyof FormState, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function SubscriptionForm({
  form,
  categories,
  names,
  providers,
  editingId,
  isSaving,
  error,
  compact = false,
  collapsed = false,
  onToggleCollapse,
  onChange,
  onSubmit,
  onCancel,
}: SubscriptionFormProps) {
  const fields = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {/* Name + Provider */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <span className={labelClass}>Name</span>
          <CategorySelector
            value={form.name}
            categories={names}
            onChange={(value) => onChange("name", value)}
            placeholder="ChatGPT Plus"
          />
        </div>
        <div className="space-y-1.5">
          <span className={labelClass}>Provider</span>
          <CategorySelector
            value={form.provider}
            categories={providers}
            onChange={(value) => onChange("provider", value)}
            placeholder="OpenAI"
          />
        </div>
      </div>

      {/* Cost + Currency */}
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
          <CategorySelector
            value={form.currency}
            categories={CURRENCY_OPTIONS.map((o) => o.code)}
            onChange={(value) => onChange("currency", value.toUpperCase())}
            allowCreate={false}
            readonlyInput={true}
          />
        </label>
      </div>

      {/* Billing period + Next billing date */}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className={labelClass}>Billing period</span>
          <CategorySelector
            value={form.billingPeriod}
            categories={["monthly", "yearly"]}
            onChange={(value) => onChange("billingPeriod", value)}
            allowCreate={false}
            readonlyInput={true}
          />
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

      {/* Category */}
      <div className="space-y-1.5">
        <span className={labelClass}>Category</span>
        <CategorySelector
          value={form.category}
          categories={categories}
          onChange={(value) => onChange("category", value)}
          placeholder="Assistant"
        />
      </div>

      {/* Notes */}
      <label className="space-y-1.5">
        <span className={labelClass}>Notes</span>
        <textarea
          value={form.notes}
          onChange={(e) => onChange("notes", e.target.value)}
          rows={3}
          placeholder="Seat count, billing quirks, or reminder notes…"
          className={`${inputClass} resize-none`}
        />
      </label>

      {error ? <SelectableErrorMessage>{error}</SelectableErrorMessage> : null}

      <div className={compact ? "flex gap-2" : ""}>
        <button
          type="submit"
          disabled={isSaving}
          className="w-full rounded-full bg-primary px-4 py-3 text-sm font-medium text-white transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "Saving…" : editingId === null ? "Create subscription" : "Save changes"}
        </button>
        {compact && (
          <button
            type="button"
            onClick={onCancel}
            className={`shrink-0 px-4 py-3 text-sm ${SECONDARY_BUTTON_SURFACE}`}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );

  if (compact) {
    return <div className="mt-4 border-t border-zinc-100 pt-4">{fields}</div>;
  }

  return (
    <aside className={`${CARD_SURFACE} self-start`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base text-primary font-normal">
            {editingId === null ? "Add subscription" : "Edit subscription"}
          </h3>
          {!collapsed && (
            <p className="mt-1 text-sm text-secondary">
              Store the original amount and billing cadence. Totals are grouped per currency.
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {editingId !== null && !collapsed ? (
            <button type="button" onClick={onCancel} className={SECONDARY_BUTTON_SURFACE}>
              Cancel
            </button>
          ) : null}
          {onToggleCollapse ? (
            <button type="button" onClick={onToggleCollapse} className={SECONDARY_BUTTON_SURFACE}>
              {collapsed ? "+" : "−"}
            </button>
          ) : null}
        </div>
      </div>
      {!collapsed && <div className="mt-6">{fields}</div>}
    </aside>
  );
}
