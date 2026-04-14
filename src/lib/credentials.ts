import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "./spendProviders";

export async function storeProviderApiKey(provider: ProviderId, value: string): Promise<void> {
  try {
    await invoke("store_provider_api_key", { provider, value });
  } catch (e) {
    throw new Error(`Failed to store API key for ${provider}: ${e}`);
  }
}

export async function getProviderApiKey(provider: ProviderId): Promise<string | null> {
  try {
    return await invoke<string | null>("get_provider_api_key", { provider });
  } catch (e) {
    throw new Error(`Failed to get API key for ${provider}: ${e}`);
  }
}

export async function deleteProviderApiKey(provider: ProviderId): Promise<void> {
  try {
    await invoke("delete_provider_api_key", { provider });
  } catch (e) {
    throw new Error(`Failed to delete API key for ${provider}: ${e}`);
  }
}

export async function hasProviderApiKey(provider: ProviderId): Promise<boolean> {
  try {
    return await invoke<boolean>("has_provider_api_key", { provider });
  } catch (e) {
    throw new Error(`Failed to check API key for ${provider}: ${e}`);
  }
}
