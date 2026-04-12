import { useState, useEffect } from "react";
import { listSubscriptions, type Subscription } from "../lib/subscriptions";
import type { Section } from "../App";
import { SelectableErrorMessage } from "./SelectableErrorMessage";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function upcomingRenewals(subscriptions: Subscription[]): Subscription[] {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 7);
  return subscriptions
    .filter((s) => s.nextBillingAt && new Date(s.nextBillingAt) >= now && new Date(s.nextBillingAt) <= cutoff)
    .sort((a, b) => new Date(a.nextBillingAt!).getTime() - new Date(b.nextBillingAt!).getTime());
}

// ── Widget shell ─────────────────────────────────────────────────────────────

function Widget({ title, cta, onCta, children }: {
  title: string;
  cta: string;
  onCta: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-zinc-100 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-ink">
          {title}
        </h2>
        <button
          onClick={onCta}
          className="text-xs text-primary hover:text-primary/70 cursor-pointer transition-colors"
        >
          {cta}
        </button>
      </div>
      {children}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function DashboardView({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loadError, setLoadError]         = useState<string | null>(null);

  useEffect(() => {
    listSubscriptions()
      .then(setSubscriptions)
      .catch((e) => setLoadError(String(e)));
  }, []);

  const monthlyByCurrency = subscriptions.reduce(
    (acc, s) => { acc[s.currency] = (acc[s.currency] ?? 0) + s.monthlyCost; return acc; },
    {} as Record<string, number>
  );

  const renewals = upcomingRenewals(subscriptions);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Page header */}
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

      {/* Body */}
      <div className="flex-1 overflow-auto px-8 py-6">
        {loadError && (
          <SelectableErrorMessage className="mb-6">
            {loadError}
          </SelectableErrorMessage>
        )}

        <div className="space-y-4">
          {/* Spend widget */}
          <Widget title="Spend" cta="View API spend →" onCta={() => onNavigate("spend")}>
            {subscriptions.length === 0 ? (
              <p className="text-sm text-secondary">
                No subscriptions tracked yet.{" "}
                <button
                  onClick={() => onNavigate("subscriptions")}
                  className="text-primary hover:text-primary/70 cursor-pointer transition-colors"
                >
                  Add one →
                </button>
              </p>
            ) : (
              <div className="space-y-3">
                {/* Monthly totals */}
                <div className="flex flex-wrap gap-4">
                  {Object.entries(monthlyByCurrency).map(([currency, total]) => (
                    <div key={currency}>
                      <p className="text-[10px] text-secondary/60 uppercase tracking-[0.2em] mb-0.5">
                        {currency}/mo
                      </p>
                      <p className="text-xl text-ink" style={{ fontWeight: 300 }}>
                        {total.toFixed(2)}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Upcoming renewals */}
                {renewals.length > 0 && (
                  <div className="pt-3 border-t border-zinc-50">
                    <p className="text-[10px] text-secondary/60 uppercase tracking-[0.2em] mb-2">
                      Renewing in 7 days
                    </p>
                    <div className="space-y-1">
                      {renewals.map((s) => (
                        <div key={s.id} className="flex items-center justify-between">
                          <span className="text-sm text-ink">{s.name}</span>
                          <span className="text-xs text-secondary">
                            {formatDate(s.nextBillingAt!)} · {s.currency} {s.monthlyCost.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Widget>

          {/* Subscriptions widget */}
          <Widget title="Subscriptions" cta="Manage →" onCta={() => onNavigate("subscriptions")}>
            {subscriptions.length === 0 ? (
              <p className="text-sm text-secondary">No subscriptions added yet.</p>
            ) : (
              <div className="space-y-1">
                {subscriptions.slice(0, 5).map((s) => (
                  <div key={s.id} className="flex items-center justify-between">
                    <span className="text-sm text-ink">{s.name}</span>
                    <span className="text-xs text-secondary">{s.currency} {s.monthlyCost.toFixed(2)}/mo</span>
                  </div>
                ))}
                {subscriptions.length > 5 && (
                  <p className="text-xs text-secondary/60 pt-1">
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
