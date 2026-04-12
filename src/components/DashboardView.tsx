import { useEffect, useState, type ReactNode } from "react";
import type { Section } from "../App";
import { listSubscriptions, type Subscription } from "../lib/subscriptions";
import { SelectableErrorMessage } from "./SelectableErrorMessage";
import { CARD_SURFACE, EMPTY_DASHED_SURFACE, PILL_SURFACE, SUBTLE_PANEL_SURFACE } from "./surfaceStyles";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function upcomingRenewals(subscriptions: Subscription[]): Subscription[] {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 7);

  return subscriptions
    .filter((subscription) => {
      if (!subscription.nextBillingAt) return false;
      const nextBilling = new Date(subscription.nextBillingAt);
      return nextBilling >= now && nextBilling <= cutoff;
    })
    .sort((a, b) => new Date(a.nextBillingAt!).getTime() - new Date(b.nextBillingAt!).getTime());
}

function Widget({
  title,
  cta,
  onCta,
  children,
}: {
  title: string;
  cta: string;
  onCta: () => void;
  children: ReactNode;
}) {
  return (
    <div className={CARD_SURFACE}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-base text-primary" style={{ fontWeight: 400 }}>
          {title}
        </h2>
        <button
          onClick={onCta}
          className="cursor-pointer text-xs text-primary transition-colors hover:text-primary/70"
        >
          {cta}
        </button>
      </div>
      {children}
    </div>
  );
}

export function DashboardView({ onNavigate }: { onNavigate: (section: Section) => void }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listSubscriptions()
      .then(setSubscriptions)
      .catch((error) => setLoadError(String(error)));
  }, []);

  const monthlyByCurrency = subscriptions.reduce(
    (accumulator, subscription) => {
      accumulator[subscription.currency] = (accumulator[subscription.currency] ?? 0) + subscription.monthlyCost;
      return accumulator;
    },
    {} as Record<string, number>,
  );

  const renewals = upcomingRenewals(subscriptions);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-zinc-100 px-8 py-6">
        <p className="text-[10px] uppercase tracking-[0.3em] text-secondary/60">
          At a glance
        </p>
        <h2
          className="mt-1.5 text-3xl text-primary"
          style={{ fontWeight: 300, letterSpacing: "-0.5px" }}
        >
          Dashboard
        </h2>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-secondary">
          Overview of your AI ecosystem. Monitor your spend, upcoming renewals, and active subscriptions.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-auto px-8 py-6">
        {loadError && <SelectableErrorMessage>{loadError}</SelectableErrorMessage>}

        <div className="space-y-6">
          <Widget title="Spend" cta="View API spend ->" onCta={() => onNavigate("spend")}>
            {subscriptions.length === 0 ? (
              <div className={EMPTY_DASHED_SURFACE}>
                <p className="text-sm text-zinc-500">No subscriptions tracked yet.</p>
                <button
                  onClick={() => onNavigate("subscriptions")}
                  className="mt-2 cursor-pointer text-xs text-primary transition-colors hover:text-primary/70"
                >
                  Add one {"->"}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2.5">
                  {Object.entries(monthlyByCurrency).map(([currency, total]) => (
                    <div key={currency} className={PILL_SURFACE}>
                      <p className="mb-0.5 text-[10px] uppercase tracking-[0.2em] text-secondary/60">
                        {currency}/mo
                      </p>
                      <p className="text-xl text-primary" style={{ fontWeight: 300 }}>
                        {total.toFixed(2)}
                      </p>
                    </div>
                  ))}
                </div>

                {renewals.length > 0 && (
                  <div className={SUBTLE_PANEL_SURFACE}>
                    <p className="mb-3 text-[10px] uppercase tracking-[0.2em] text-secondary/60">
                      Renewing in 7 days
                    </p>
                    <div className="space-y-2">
                      {renewals.map((subscription) => (
                        <div
                          key={subscription.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-zinc-100 bg-white/90 px-3 py-2"
                        >
                          <span className="text-sm text-zinc-900">{subscription.name}</span>
                          <span className="text-xs text-secondary">
                            {formatDate(subscription.nextBillingAt!)} - {subscription.currency}{" "}
                            {subscription.monthlyCost.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Widget>

          <Widget title="Subscriptions" cta="Manage ->" onCta={() => onNavigate("subscriptions")}>
            {subscriptions.length === 0 ? (
              <div className={EMPTY_DASHED_SURFACE}>
                <p className="text-sm text-zinc-500">No subscriptions added yet.</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {subscriptions.slice(0, 5).map((subscription) => (
                  <div key={subscription.id} className={SUBTLE_PANEL_SURFACE}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-zinc-900">{subscription.name}</span>
                      <span className="text-xs text-secondary">
                        {subscription.currency} {subscription.monthlyCost.toFixed(2)}/mo
                      </span>
                    </div>
                  </div>
                ))}
                {subscriptions.length > 5 && (
                  <p className="pt-1 text-xs text-secondary/60">
                    +{subscriptions.length - 5} more
                  </p>
                )}
              </div>
            )}
          </Widget>
        </div>
      </div>
    </div>
  );
}
