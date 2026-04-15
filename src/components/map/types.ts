import { type Node } from "@xyflow/react";
import { type ProviderId } from "../../lib/spendProviders";

export interface MapNodeTone {
  surfaceFill: string;
  badgeFill: string;
  badgeBorder: string;
  badgeText: string;
  metricFill: string;
  metricBorder: string;
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
  isPinned?: boolean;
  linkedProviderNodeId?: string;
  layoutKey: string;
  onTogglePin?: () => void;
  billingLabel: string;
  nextBillingLabel: string;
  statusLabel: string;
  tone: MapNodeTone;
}

export type ProviderGraphNode = Node<ProviderNodeData, "provider">;
export type ProductGraphNode = Node<ProductNodeData, "product">;
export type SubscriptionGraphNode = Node<SubscriptionNodeData, "subscription">;

function createTone(accent: string): MapNodeTone {
  return {
    surfaceFill: `color-mix(in srgb, ${accent} 16%, transparent)`,
    badgeFill: `color-mix(in srgb, ${accent} 22%, transparent)`,
    badgeBorder: `color-mix(in srgb, ${accent} 38%, transparent)`,
    badgeText: `color-mix(in srgb, var(--text-primary) 76%, ${accent} 24%)`,
    metricFill: `color-mix(in srgb, var(--bg-surface) 72%, ${accent} 14%)`,
    metricBorder: `color-mix(in srgb, ${accent} 18%, var(--glass-border) 82%)`,
    minimapColor: accent,
    edgeColor: `color-mix(in srgb, ${accent} 58%, var(--text-primary) 42%)`,
  };
}

export const PROVIDER_TONES: Record<ProviderId, MapNodeTone> = {
  anthropic: createTone("#f59e0b"),
  openai: createTone("#10b981"),
  openrouter: createTone("#6366f1"),
  groq: createTone("#ec4899"),
  gcp: createTone("#3b82f6"),
};

export const CATEGORY_TONES: Record<string, MapNodeTone> = {
  assistant: createTone("#ad46ff"),
  coding: createTone("#06b6d4"),
  image: createTone("#f97316"),
  research: createTone("#6366f1"),
  audio: createTone("#ea580c"),
  video: createTone("#f43f5e"),
  neutral: createTone("#94a3b8"),
};
