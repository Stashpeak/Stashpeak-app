import type { ReactNode } from "react";
import type { Subscription } from "../lib/subscriptions";
import { formatCategoryLabel } from "../lib/categoryFormatting";

export function formatCurrency(amount: number, currency: string): string {
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

export function monthlyEquivalent(subscription: Subscription): number {
  return subscription.billingPeriod === "yearly"
    ? subscription.monthlyCost / 12
    : subscription.monthlyCost;
}

interface SubscriptionListProps {
  subscriptions: Subscription[];
  isLoading: boolean;
  editingId: number | null;
  inlineEditForm: ReactNode;
  onEdit: (sub: Subscription) => void;
  onDelete: (id: number) => void;
}

export function SubscriptionList({
  subscriptions,
  isLoading,
  editingId,
  inlineEditForm,
  onEdit,
  onDelete,
}: SubscriptionListProps) {
  return (
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
                    <span className="rounded-full border border-[#6750a4]/20 px-2 py-0.5 text-[9px] tracking-[0.12em] text-[#6750a4]/70">
                      {formatCategoryLabel(subscription.category)}
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

                {editingId !== subscription.id && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(subscription)}
                      className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(subscription.id)}
                      className="rounded-full border border-rose-200 px-3 py-1.5 text-xs text-rose-400 transition hover:bg-rose-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {editingId === subscription.id && inlineEditForm}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
