import { invoke } from "@tauri-apps/api/core";

export interface SpendData {
  currentMonthUsd: number;
  previousMonthUsd: number;
  lastActivityAt: string | null;
}

export async function fetchProviderSpend(provider: string): Promise<SpendData> {
  try {
    return await invoke<SpendData>("fetch_provider_spend", { provider });
  } catch (e) {
    throw new Error(`Failed to fetch spend for ${provider}: ${e}`);
  }
}
