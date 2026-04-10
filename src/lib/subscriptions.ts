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
  try {
    return await invoke<Subscription[]>("list_subscriptions");
  } catch (e) {
    throw new Error(`Failed to load subscriptions: ${e}`);
  }
}

export async function createSubscription(input: SubscriptionInput): Promise<Subscription> {
  try {
    return await invoke<Subscription>("create_subscription", { input });
  } catch (e) {
    throw new Error(`Failed to create subscription: ${e}`);
  }
}

export async function updateSubscription(id: number, input: SubscriptionInput): Promise<Subscription> {
  try {
    return await invoke<Subscription>("update_subscription", { id, input });
  } catch (e) {
    throw new Error(`Failed to update subscription ${id}: ${e}`);
  }
}

export async function deleteSubscription(id: number): Promise<void> {
  try {
    await invoke("delete_subscription", { id });
  } catch (e) {
    throw new Error(`Failed to delete subscription ${id}: ${e}`);
  }
}
