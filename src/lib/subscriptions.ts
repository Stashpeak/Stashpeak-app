import { invoke } from "@tauri-apps/api/core";

export type BillingPeriod = "monthly" | "yearly";

export interface Subscription {
  id: number;
  name: string;
  provider: string;
  monthlyCost: number;
  currency: string;
  billingPeriod: BillingPeriod;
  nextBillingAt: string | null;
  category: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionInput {
  name: string;
  provider: string;
  monthlyCost: number;
  currency: string;
  billingPeriod: BillingPeriod;
  nextBillingAt: string | null;
  category: string;
  notes: string;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  return invoke<Subscription[]>("list_subscriptions");
}

export async function createSubscription(input: SubscriptionInput): Promise<Subscription> {
  return invoke<Subscription>("create_subscription", { input });
}

export async function updateSubscription(id: number, input: SubscriptionInput): Promise<Subscription> {
  return invoke<Subscription>("update_subscription", { id, input });
}

export async function deleteSubscription(id: number): Promise<void> {
  await invoke("delete_subscription", { id });
}
