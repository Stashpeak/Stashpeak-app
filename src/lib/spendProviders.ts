import type { SpendData } from "./connectors";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "groq" | "gcp";

export type ProviderStatus =
  | { tag: "unconfigured" }
  | { tag: "loading" }
  | { tag: "ok"; data: SpendData; refreshedAt: Date; backgroundRefreshing?: boolean }
  | { tag: "stale"; error: string };

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  note?: string;
  comingSoon?: boolean;
}

export const SPEND_PROVIDERS: ProviderDefinition[] = [
  { id: "anthropic", name: "Anthropic", note: "Requires Admin API key (sk-ant-admin-...)" },
  { id: "openai", name: "OpenAI", note: "Requires API key with usage read scope" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "groq", name: "Groq", comingSoon: true },
  { id: "gcp", name: "Google Cloud", note: "Billing export to BigQuery required" },
];

export const EMPTY_PROVIDER_STATES: Record<ProviderId, ProviderStatus> = {
  anthropic: { tag: "unconfigured" },
  openai: { tag: "unconfigured" },
  openrouter: { tag: "unconfigured" },
  groq: { tag: "unconfigured" },
  gcp: { tag: "unconfigured" },
};

export function formatProviderRefreshedAt(date: Date): string {
  const isToday = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return isToday
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
