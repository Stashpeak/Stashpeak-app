import { type Node } from "@xyflow/react";
import { type ProviderId } from "./spendProviders";

export interface MapNodeTone {
  className: string;
  minimapColor: string;
  edgeColor: string;
}

export type MapLinkState = "linked" | "unlinked" | "standalone";

export interface ProviderNodeData extends Record<string, unknown> {
  title: string;
  caption: string;
  statusLabel: string;
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
  note?: string;
  tone: MapNodeTone;
}

export interface ProductNodeData extends Record<string, unknown> {
  title: string;
  caption: string;
  description?: string;
  statusLabel: string;
  activityLabel: string;
  subscriptionCount: number;
  isLinked: boolean;
  parentProviderNodeId: string;
  layoutKey: string;
  hasPositionOverride?: boolean;
  onResetPosition?: () => void;
  tone: MapNodeTone;
}

export interface SubscriptionNodeData extends Record<string, unknown> {
  title: string;
  caption: string;
  providerLabel: string;
  linkLabel?: string;
  linkActionLabel?: string;
  linkState: MapLinkState;
  onToggleLink?: () => void;
  linkedProviderNodeId?: string;
  layoutKey: string;
  hasPositionOverride?: boolean;
  onResetPosition?: () => void;
  billingLabel: string;
  nextBillingLabel: string;
  statusLabel: string;
  note?: string;
  tone: MapNodeTone;
}

export type ProviderGraphNode = Node<ProviderNodeData, "provider">;
export type ProductGraphNode = Node<ProductNodeData, "product">;
export type SubscriptionGraphNode = Node<SubscriptionNodeData, "subscription">;

function createTone(className: string, accent: string): MapNodeTone {
  return {
    className,
    minimapColor: accent,
    edgeColor: `color-mix(in srgb, ${accent} 58%, var(--text-primary) 42%)`,
  };
}

export const PROVIDER_TONES: Record<ProviderId, MapNodeTone> = {
  anthropic: createTone("map-tone-anthropic", "#f59e0b"),
  openai: createTone("map-tone-openai", "#10b981"),
  openrouter: createTone("map-tone-openrouter", "#6366f1"),
  groq: createTone("map-tone-groq", "#ec4899"),
  gcp: createTone("map-tone-gcp", "#3b82f6"),
};

export const CATEGORY_TONES: Record<string, MapNodeTone> = {
  assistant: createTone("map-tone-assistant", "#ad46ff"),
  coding: createTone("map-tone-coding", "#06b6d4"),
  image: createTone("map-tone-image", "#f97316"),
  research: createTone("map-tone-research", "#6366f1"),
  audio: createTone("map-tone-audio", "#ea580c"),
  video: createTone("map-tone-video", "#f43f5e"),
  neutral: createTone("map-tone-neutral", "#94a3b8"),
};
