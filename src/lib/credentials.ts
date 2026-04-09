import { invoke } from "@tauri-apps/api/core";

export type ProviderId = "openai" | "anthropic" | "openrouter" | "groq";

export async function storeProviderApiKey(provider: ProviderId, value: string): Promise<void> {
  await invoke("store_provider_api_key", { provider, value });
}

export async function getProviderApiKey(provider: ProviderId): Promise<string | null> {
  return invoke<string | null>("get_provider_api_key", { provider });
}

export async function deleteProviderApiKey(provider: ProviderId): Promise<void> {
  await invoke("delete_provider_api_key", { provider });
}

export async function hasProviderApiKey(provider: ProviderId): Promise<boolean> {
  return invoke<boolean>("has_provider_api_key", { provider });
}
