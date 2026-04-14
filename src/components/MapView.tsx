import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useSpendData } from "../hooks/useSpendData";
import { formatCategoryLabel } from "../lib/categoryFormatting";
import {
  formatProviderRefreshedAt,
  type ProviderDefinition,
  type ProviderId,
  type ProviderStatus,
} from "../lib/spendProviders";
import { formatCurrency, monthlyEquivalent } from "../lib/subscriptionMetrics";
import { listSubscriptions, type Subscription } from "../lib/subscriptions";
import { EMPTY_DASHED_SURFACE, PILL_SURFACE } from "../lib/surfaceStyles";
import { SelectableErrorMessage } from "./SelectableErrorMessage";
import { findPresetForSubscription } from "./SubscriptionPresets";
import { ProviderNode, type ProviderGraphNode } from "./map/ProviderNode";
import { SubscriptionNode, type SubscriptionGraphNode } from "./map/SubscriptionNode";
import type { MapNodeTone } from "./map/types";

type MapNode = ProviderGraphNode | SubscriptionGraphNode;
type MapEdge = Edge<{ relation: "uses" }, "smoothstep">;

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

const PROVIDER_TONES: Record<ProviderId, MapNodeTone> = {
  anthropic: createTone("#f59e0b"),
  openai: createTone("#10b981"),
  openrouter: createTone("#6366f1"),
  groq: createTone("#ec4899"),
  gcp: createTone("#3b82f6"),
};

const CATEGORY_TONES: Record<string, MapNodeTone> = {
  assistant: createTone("#ad46ff"),
  coding: createTone("#06b6d4"),
  image: createTone("#f97316"),
  research: createTone("#6366f1"),
  audio: createTone("#ea580c"),
  video: createTone("#f43f5e"),
  neutral: createTone("#94a3b8"),
};

const PROVIDER_ALIASES: Record<ProviderId, string[]> = {
  anthropic: ["anthropic", "claude"],
  openai: ["openai", "chatgpt"],
  openrouter: ["openrouter"],
  groq: ["groq"],
  gcp: ["google cloud", "google ai", "gemini", "gcp", "google"],
};

const nodeTypes = {
  provider: ProviderNode,
  subscription: SubscriptionNode,
};

const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };

function normalizeValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatShortDate(value: string | null): string {
  if (!value) return "Not set";

  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function getSubscriptionTone(category: string): MapNodeTone {
  return CATEGORY_TONES[normalizeValue(category)] ?? CATEGORY_TONES.neutral;
}

function stripProviderError(error: string): string {
  return error
    .replace(/^Error:\s*/i, "")
    .replace(/^Failed to fetch spend for \w+:\s*/i, "");
}

function getProviderNote(providerId: ProviderId, status: ProviderStatus): string | undefined {
  if (providerId === "gcp") {
    return "Billing export can lag by up to 48h.";
  }

  if (status.tag === "ok" && status.data.lastActivityAt) {
    return `Last API activity ${formatShortDate(status.data.lastActivityAt)}.`;
  }

  if (status.tag === "stale") {
    return stripProviderError(status.error);
  }

  return "Connected through the Spend view.";
}

function inferProviderId(subscription: Subscription, availableProviderIds: Set<ProviderId>): ProviderId | null {
  const presetProvider = findPresetForSubscription(subscription)?.provider ?? "";
  const candidates = [subscription.provider, presetProvider, subscription.name];

  for (const providerId of availableProviderIds) {
    const aliases = PROVIDER_ALIASES[providerId];
    for (const candidate of candidates) {
      const normalizedCandidate = normalizeValue(candidate);
      if (normalizedCandidate === "") continue;

      if (aliases.some((alias) => normalizedCandidate === alias || normalizedCandidate.includes(alias))) {
        return providerId;
      }
    }
  }

  return null;
}

function mergeNodePositions(currentNodes: MapNode[], nextNodes: MapNode[]): MapNode[] {
  const positionsById = new Map(currentNodes.map((node) => [node.id, node.position]));

  return nextNodes.map((node) => ({
    ...node,
    position: positionsById.get(node.id) ?? node.position,
  }));
}

function buildGraph(
  subscriptions: Subscription[],
  providers: ProviderDefinition[],
  states: Record<ProviderId, ProviderStatus>,
): { nodes: MapNode[]; edges: MapEdge[] } {
  const providerNodes: ProviderGraphNode[] = [];
  const edges: MapEdge[] = [];
  const providerXById = new Map<ProviderId, number>();
  const configuredProviderIds = new Set(providers.map(({ id }) => id));

  providers.forEach(({ id: providerId, name }, index) => {
    const status = states[providerId];
    const tone = PROVIDER_TONES[providerId];
    const spendUsd = status.tag === "ok" ? status.data.currentMonthUsd : 0;
    const width = 236 + Math.min(spendUsd, 500) * 0.14;
    const previousMonthUsd = status.tag === "ok" ? status.data.previousMonthUsd : 0;
    const position = { x: 120 + index * 320, y: 72 };
    providerXById.set(providerId, position.x);

    providerNodes.push({
      id: `provider:${providerId}`,
      type: "provider",
      position,
      targetPosition: Position.Bottom,
      style: { width, minHeight: 164 },
      data: {
        title: name,
        caption: "Configured provider",
        statusLabel:
          status.tag === "ok"
            ? "Live"
            : status.tag === "loading"
              ? "Loading"
              : status.tag === "stale"
                ? "Stale"
                : "Setup",
        primaryLabel: "This month",
        primaryValue:
          status.tag === "ok"
            ? formatCurrency(spendUsd, "USD")
            : status.tag === "loading"
              ? "Fetching..."
              : "Unavailable",
        secondaryLabel: "Last month",
        secondaryValue:
          status.tag === "ok"
            ? previousMonthUsd > 0
              ? formatCurrency(previousMonthUsd, "USD")
              : "No prior spend"
            : status.tag === "loading"
              ? "Syncing"
              : "Retry needed",
        note:
          status.tag === "ok"
            ? `Updated ${formatProviderRefreshedAt(status.refreshedAt)}. ${getProviderNote(providerId, status) ?? ""}`.trim()
            : getProviderNote(providerId, status),
        tone,
      },
    });
  });

  const groupedCounts = new Map<string, number>();
  const standaloneX = providers.length === 0 ? 120 : 120 + providers.length * 320;
  const subscriptionBaseY = providers.length === 0 ? 112 : 308;

  const subscriptionNodes: SubscriptionGraphNode[] = subscriptions.map((subscription) => {
    const linkedProviderId = inferProviderId(subscription, configuredProviderIds);
    const tone = getSubscriptionTone(subscription.category);
    const statusLabel = linkedProviderId ? "Linked" : "Standalone";
    const groupKey = linkedProviderId ?? "standalone";
    const groupIndex = groupedCounts.get(groupKey) ?? 0;
    groupedCounts.set(groupKey, groupIndex + 1);

    const anchorX = linkedProviderId ? (providerXById.get(linkedProviderId) ?? standaloneX) : standaloneX;
    const position = {
      x: anchorX + (groupIndex % 2) * 244,
      y: subscriptionBaseY + Math.floor(groupIndex / 2) * 170,
    };

    if (linkedProviderId) {
      edges.push({
        id: `edge:subscription:${subscription.id}->provider:${linkedProviderId}`,
        source: `subscription:${subscription.id}`,
        target: `provider:${linkedProviderId}`,
        type: "smoothstep",
        data: { relation: "uses" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: PROVIDER_TONES[linkedProviderId].edgeColor,
        },
        style: {
          stroke: PROVIDER_TONES[linkedProviderId].edgeColor,
          strokeWidth: 1.6,
        },
      });
    }

    return {
      id: `subscription:${subscription.id}`,
      type: "subscription",
      position,
      sourcePosition: Position.Top,
      style: { width: 228, minHeight: 172 },
      data: {
        title: subscription.name,
        caption: formatCategoryLabel(subscription.category) || "Subscription",
        providerLabel: `Provider: ${subscription.provider || "Manual"}`,
        billingLabel: `${formatCurrency(monthlyEquivalent(subscription), subscription.currency)}/mo`,
        nextBillingLabel: formatShortDate(subscription.nextBillingAt),
        statusLabel,
        tone,
      },
    };
  });

  return {
    nodes: [...providerNodes, ...subscriptionNodes],
    edges,
  };
}

export function MapView() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionsLoaded, setSubscriptionsLoaded] = useState(false);
  const [subscriptionsError, setSubscriptionsError] = useState<string | null>(null);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<MapNode, MapEdge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapEdge>([]);
  const { loadError, states, visibleProviders } = useSpendData();

  const mapProviders = useMemo(
    () => visibleProviders.filter(({ id }) => states[id].tag !== "unconfigured"),
    [states, visibleProviders],
  );

  const providerIds = useMemo(
    () => mapProviders.map(({ id }) => id),
    [mapProviders],
  );

  useEffect(() => {
    let cancelled = false;

    listSubscriptions()
      .then((data) => {
        if (cancelled) return;
        setSubscriptions(data);
        setSubscriptionsLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setSubscriptionsError(String(error));
        setSubscriptionsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const nextGraph = buildGraph(subscriptions, mapProviders, states);
    setNodes((currentNodes) => mergeNodePositions(currentNodes, nextGraph.nodes));
    setEdges(nextGraph.edges);
  }, [mapProviders, setEdges, setNodes, states, subscriptions]);

  useEffect(() => {
    if (!reactFlow || nodes.length === 0) return;

    const frame = window.requestAnimationFrame(() => {
      void reactFlow.fitView({ duration: 420, padding: 0.18 });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [edges.length, nodes.length, reactFlow]);

  const apiTotal = providerIds.reduce((sum, providerId) => {
    const status = states[providerId];
    return status.tag === "ok" ? sum + status.data.currentMonthUsd : sum;
  }, 0);

  const providerCount = nodes.filter((node) => node.type === "provider").length;
  const subscriptionCount = nodes.filter((node) => node.type === "subscription").length;
  const isEmpty = nodes.length === 0;
  const showLoading = !subscriptionsLoaded && isEmpty && !loadError;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-8 py-6 border-[var(--border-subtle)]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--purple-label)]">Visual graph</p>
            <h2 className="mt-1.5 text-3xl text-[var(--text-primary)] font-light tracking-tight">Ecosystem map</h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">
              Live AI subscriptions and configured spend providers rendered as draggable nodes. This first pass keeps
              layout deterministic while inferring basic subscription-to-provider links from existing data.
            </p>
          </div>

          <div className="flex flex-wrap gap-2.5">
            <div className={PILL_SURFACE}>
              <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Providers</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{providerCount}</span>
            </div>
            <div className={PILL_SURFACE}>
              <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Subscriptions</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{subscriptionCount}</span>
            </div>
            <div className={PILL_SURFACE}>
              <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Links</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{edges.length}</span>
            </div>
            <div className={PILL_SURFACE}>
              <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">API month</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{formatCurrency(apiTotal, "USD")}</span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <span className="rounded-full border px-3 py-1.5 text-xs text-[var(--text-secondary)] border-[rgba(16,185,129,0.28)] bg-[rgba(16,185,129,0.12)]">
            Provider nodes
          </span>
          <span className="rounded-full border px-3 py-1.5 text-xs text-[var(--text-secondary)] border-[rgba(173,70,255,0.28)] bg-[rgba(173,70,255,0.12)]">
            Subscription nodes
          </span>
          <span className="rounded-full border px-3 py-1.5 text-xs text-[var(--text-secondary)] border-[var(--glass-border)] bg-[var(--glass-bg)]">
            Drag nodes to personalize the layout
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto px-8 py-6">
        {subscriptionsError && <SelectableErrorMessage>{subscriptionsError}</SelectableErrorMessage>}
        {loadError && <SelectableErrorMessage>{loadError}</SelectableErrorMessage>}

        {showLoading ? (
          <div className={EMPTY_DASHED_SURFACE}>
            <p className="text-sm text-[var(--text-muted)]">Loading ecosystem data...</p>
          </div>
        ) : isEmpty ? (
          <div className={EMPTY_DASHED_SURFACE}>
            <p className="text-sm text-[var(--text-muted)]">No subscription or provider data available for the map yet.</p>
            <p className="mt-1 text-xs text-[var(--text-subtle)]">
              Add subscriptions or configure spend providers and the graph will populate automatically.
            </p>
          </div>
        ) : (
          <div className="glass-surface stashpeak-map min-h-0 flex-1 overflow-hidden rounded-[28px] p-2 [--glass-surface-fill:var(--glass-bg)]">
            <ReactFlow<MapNode, MapEdge>
              fitView
              minZoom={0.45}
              maxZoom={1.8}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              proOptions={REACT_FLOW_PRO_OPTIONS}
              nodesConnectable={false}
              elementsSelectable={false}
              onInit={setReactFlow}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
            >
              <Background
                id="stashpeak-map-grid"
                color="var(--border-subtle)"
                gap={20}
                size={1.15}
                variant={BackgroundVariant.Dots}
              />
              <Controls className="stashpeak-map__controls" position="top-right" showInteractive={false} />
              <MiniMap<MapNode>
                className="stashpeak-map__minimap"
                bgColor="transparent"
                maskColor="var(--map-minimap-mask)"
                nodeBorderRadius={14}
                nodeStrokeWidth={3}
                pannable
                zoomable
                nodeColor={(node) => node.data.tone.minimapColor}
                nodeStrokeColor={(node) => node.data.tone.edgeColor}
              />
            </ReactFlow>
          </div>
        )}
      </div>
    </div>
  );
}
