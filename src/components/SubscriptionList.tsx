import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CARD_SURFACE,
  EMPTY_DASHED_SURFACE,
  EMPTY_STATE_SURFACE,
  SUBTLE_PANEL_SURFACE,
} from "../lib/surfaceStyles";
import { formatCurrency } from "../lib/subscriptionMetrics";
import { findPresetForSubscription } from "../lib/subscriptionPresets";
import type { Subscription } from "../lib/subscriptions";
import { formatCategoryLabel } from "../lib/categoryFormatting";

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
    <div className={CARD_SURFACE}>
      <h3 className="text-base text-primary font-normal">Saved subscriptions</h3>
      <p className="mt-1 text-sm text-secondary">
        Everything here is persisted in local SQLite storage.
      </p>

      {isLoading ? (
        <div className={`mt-5 ${EMPTY_STATE_SURFACE}`}>Loading subscriptions...</div>
      ) : subscriptions.length === 0 ? (
        <div className={`mt-5 ${EMPTY_DASHED_SURFACE}`}>
          <p className="text-sm text-zinc-500">No subscriptions yet</p>
          <p className="mt-1 text-xs text-zinc-400">
            Use the form or quick-add presets to create your first entry.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-2.5">
          {subscriptions.map((subscription) => {
            const usageUrl = findPresetForSubscription(subscription)?.usageUrl;

            return (
              <article key={subscription.id} className={SUBTLE_PANEL_SURFACE}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-medium text-zinc-900">{subscription.name}</h4>
                      <span className="rounded-full border border-primary/20 px-2 py-0.5 text-[9px] tracking-[0.12em] text-primary/70">
                        {formatCategoryLabel(subscription.category)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs text-secondary">
                      {subscription.provider} ·{" "}
                      <span className="text-zinc-700">
                        {formatCurrency(subscription.monthlyCost, subscription.currency)} per{" "}
                        {subscription.billingPeriod === "yearly" ? "year" : "month"}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-secondary/60">
                      Next billing: {formatDate(subscription.nextBillingAt)}
                    </p>
                    {subscription.notes ? (
                      <p className="mt-2.5 text-xs leading-relaxed text-secondary/70 italic">
                        {subscription.notes}
                      </p>
                    ) : null}
                  </div>

                  {editingId !== subscription.id && (
                    <div className="flex flex-wrap justify-end gap-2">
                      {usageUrl ? (
                        <button
                          type="button"
                          onClick={() => openUrl(usageUrl)}
                          title="Open provider usage page"
                          className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 px-3 py-1.5 text-xs text-primary transition hover:border-primary/35 hover:bg-primary/5"
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M6 3h7v7" />
                            <path d="M13 3 3 13" />
                            <path d="M13 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3" />
                          </svg>
                          View usage
                        </button>
                      ) : null}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
