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

export async function getProviderEnabled(provider: string): Promise<boolean> {
  try {
    return await invoke<boolean>("get_provider_enabled", { provider });
  } catch (e) {
    throw new Error(`Failed to get provider enabled: ${e}`);
  }
}

export async function setProviderEnabled(provider: string, enabled: boolean): Promise<void> {
  try {
    await invoke("set_provider_enabled", { provider, enabled });
  } catch (e) {
    throw new Error(`Failed to set provider enabled: ${e}`);
  }
}
