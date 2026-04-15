import { type UpcomingRenewal } from "../lib/subscriptions";
import { formatCurrency } from "../lib/subscriptionMetrics";
import { WARNING_PILL_SURFACE } from "../lib/surfaceStyles";

interface RenewalBannerProps {
  renewals: UpcomingRenewal[];
}

export function RenewalBanner({ renewals }: RenewalBannerProps) {
  if (renewals.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 space-y-1.5">
      {renewals.map((renewal) => {
        const when =
          renewal.daysUntil === 0
            ? "today"
            : renewal.daysUntil === 1
              ? "in 1 day"
              : `in ${renewal.daysUntil} days`;

        return (
          <div
            key={`${renewal.id}-${renewal.nextBillingAt}`}
            className={`${WARNING_PILL_SURFACE} flex items-center gap-2`}
          >
            <span className="shrink-0">{"\u23F0"}</span>
            <span>
              <span className="font-medium">{renewal.name}</span>
              {" renews "}
              <span className="font-medium">{when}</span>
              {" \u2014 "}
              {formatCurrency(renewal.cost, renewal.currency)}/{renewal.billingPeriod}
            </span>
          </div>
        );
      })}
    </div>
  );
}
