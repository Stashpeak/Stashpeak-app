import type { Subscription } from "./subscriptions";

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

export function monthlyEquivalent(subscription: Subscription): number {
  return subscription.billingPeriod === "yearly"
    ? subscription.monthlyCost / 12
    : subscription.monthlyCost;
}
