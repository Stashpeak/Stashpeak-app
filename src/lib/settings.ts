import { invoke } from "@tauri-apps/api/core";

export interface NotificationSettings {
  daysBefore: number;
  enabled: boolean;
}

export interface ExchangeRate {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  try {
    return await invoke<NotificationSettings>("get_notification_settings");
  } catch (e) {
    throw new Error(`Failed to load notification settings: ${e}`);
  }
}

export async function setNotificationDays(days: number): Promise<void> {
  try {
    await invoke("set_notification_days", { days });
  } catch (e) {
    throw new Error(`Failed to set notification days: ${e}`);
  }
}

export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke("set_notifications_enabled", { enabled });
  } catch (e) {
    throw new Error(`Failed to set notifications enabled: ${e}`);
  }
}

export async function getHomeCurrency(): Promise<string> {
  try {
    return await invoke<string>("get_home_currency");
  } catch (e) {
    throw new Error(`Failed to load home currency: ${e}`);
  }
}

export async function setHomeCurrency(currency: string): Promise<void> {
  try {
    await invoke("set_home_currency", { currency });
  } catch (e) {
    throw new Error(`Failed to set home currency: ${e}`);
  }
}

export async function getExchangeRates(): Promise<ExchangeRate[]> {
  try {
    return await invoke<ExchangeRate[]>("get_exchange_rates");
  } catch (e) {
    throw new Error(`Failed to load exchange rates: ${e}`);
  }
}

export async function upsertExchangeRate(from: string, to: string, rate: number): Promise<void> {
  try {
    await invoke("upsert_exchange_rate", { from, to, rate });
  } catch (e) {
    throw new Error(`Failed to save exchange rate: ${e}`);
  }
}
