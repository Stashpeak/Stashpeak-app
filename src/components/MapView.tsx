import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
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
  type NodeChange,
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
import {
  getPinnedSubscriptionIds,
  getSuppressedLinkIds,
  listSubscriptions,
  setSubscriptionLinkPinned,
  setSubscriptionLinkSuppressed,
  type Subscription,
} from "../lib/subscriptions";
import {
  loadMapLayout,
  persistMapLayout,
  type StoredMapLayout,
} from "../lib/mapLayout";
import { EMPTY_DASHED_SURFACE, PILL_SURFACE } from "../lib/surfaceStyles";
import { SelectableErrorMessage } from "./SelectableErrorMessage";
import { findPresetForSubscription } from "./SubscriptionPresets";
import { ProviderNode, type ProviderGraphNode } from "./map/ProviderNode";
import { SubscriptionNode, type SubscriptionGraphNode } from "./map/SubscriptionNode";
import type { MapLinkState, MapNodeTone } from "./map/types";

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

function mergeNodePositions(currentNodes: MapNode[], nextNodes: MapNode[], resetPositionIds?: Set<string>): MapNode[] {
  const currentNodesById = new Map(currentNodes.map((node) => [node.id, node]));

  return nextNodes.map((node) => ({
    ...node,
    position:
      shouldResetNodePosition(currentNodesById.get(node.id), node, resetPositionIds)
        ? node.position
        : (currentNodesById.get(node.id)?.position ?? node.position),
  }));
}

function shouldResetNodePosition(
  currentNode: MapNode | undefined,
  nextNode: MapNode,
  resetPositionIds?: Set<string>,
) {
  if (resetPositionIds?.has(nextNode.id)) return true;
  if (!currentNode) return false;
  if (currentNode.type !== nextNode.type) return true;

  if (currentNode.type === "subscription" && nextNode.type === "subscription") {
    return currentNode.data.layoutKey !== nextNode.data.layoutKey;
  }

  return false;
}

function movePinnedSubscriptionsWithProviders(currentNodes: MapNode[], nextNodes: MapNode[]): MapNode[] {
  const providerDeltas = new Map<string, { x: number; y: number }>();
  const previousProviderPositions = new Map(
    currentNodes
      .filter((node): node is ProviderGraphNode => node.type === "provider")
      .map((node) => [node.id, node.position]),
  );

  nextNodes.forEach((node) => {
    if (node.type !== "provider") return;

    const previousPosition = previousProviderPositions.get(node.id);
    if (!previousPosition) return;

    const deltaX = node.position.x - previousPosition.x;
    const deltaY = node.position.y - previousPosition.y;
    if (deltaX === 0 && deltaY === 0) return;

    providerDeltas.set(node.id, { x: deltaX, y: deltaY });
  });

  if (providerDeltas.size === 0) {
    return nextNodes;
  }

  return nextNodes.map((node) => {
    if (node.type !== "subscription" || !node.data.isPinned || !node.data.linkedProviderNodeId) {
      return node;
    }

    const providerDelta = providerDeltas.get(node.data.linkedProviderNodeId);
    if (!providerDelta) {
      return node;
    }

    return {
      ...node,
      position: {
        x: node.position.x + providerDelta.x,
        y: node.position.y + providerDelta.y,
      },
    };
  });
}

function getStoredPosition(
  nodeId: string,
  storedLayout: StoredMapLayout,
  layoutKey?: string,
) {
  const storedNode = storedLayout[nodeId];
  if (!storedNode) return null;
  if (layoutKey && storedNode.layoutKey !== layoutKey) return null;

  return { x: storedNode.x, y: storedNode.y };
}

function getCurrentNodePosition(
  nodeId: string,
  currentNodesById: Map<string, MapNode>,
  layoutKey?: string,
) {
  const currentNode = currentNodesById.get(nodeId);
  if (!currentNode) return null;

  if (currentNode.type === "subscription" && layoutKey && currentNode.data.layoutKey !== layoutKey) {
    return null;
  }

  return currentNode.position;
}

function buildGraph(
  subscriptions: Subscription[],
  providers: ProviderDefinition[],
  states: Record<ProviderId, ProviderStatus>,
  suppressedLinkIds: Record<number, boolean>,
  pinnedSubscriptionIds: Record<number, boolean>,
  onToggleSubscriptionLink: (subscriptionId: Subscription["id"]) => void,
  onToggleSubscriptionPin: (subscriptionId: Subscription["id"]) => void,
  storedLayout: StoredMapLayout,
  currentNodesById: Map<string, MapNode>,
): { nodes: MapNode[]; edges: MapEdge[] } {
  const PROVIDER_X_START = 120;
  const PROVIDER_Y = 72;
  const PROVIDER_WIDTH = 272;
  const PROVIDER_COLUMN_GAP = 336;
  const LINKED_SUBSCRIPTION_Y = 328;
  const LINKED_SUBSCRIPTION_OFFSET_Y = LINKED_SUBSCRIPTION_Y - PROVIDER_Y;
  const SUBSCRIPTION_WIDTH = 236;
  const SUBSCRIPTION_ROW_GAP = 194;
  const STANDALONE_COLUMN_GAP = 264;
  const STANDALONE_GROUP_GAP = providers.length > 0 ? 76 : 0;

  const providerNodes: ProviderGraphNode[] = [];
  const edges: MapEdge[] = [];
  const providerPositionById = new Map<ProviderId, { x: number; y: number }>();
  const providerNameById = new Map(providers.map(({ id, name }) => [id, name]));
  const configuredProviderIds = new Set(providers.map(({ id }) => id));
  const linkedSubscriptionsByProvider = new Map<ProviderId, Subscription[]>();
  const standaloneSubscriptions: Array<{
    subscription: Subscription;
    inferredProviderId: ProviderId | null;
  }> = [];

  providers.forEach(({ id: providerId, name }, index) => {
    const status = states[providerId];
    const tone = PROVIDER_TONES[providerId];
    const previousMonthUsd = status.tag === "ok" ? status.data.previousMonthUsd : 0;
    const providerNodeId = `provider:${providerId}`;
    const defaultPosition = { x: PROVIDER_X_START + index * PROVIDER_COLUMN_GAP, y: PROVIDER_Y };
    const position =
      getCurrentNodePosition(providerNodeId, currentNodesById)
      ?? getStoredPosition(providerNodeId, storedLayout)
      ?? defaultPosition;
    providerPositionById.set(providerId, position);

    providerNodes.push({
      id: providerNodeId,
      type: "provider",
      position,
      targetPosition: Position.Bottom,
      style: { width: PROVIDER_WIDTH, minHeight: 184 },
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
            ? formatCurrency(status.data.currentMonthUsd, "USD")
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

  subscriptions.forEach((subscription) => {
    const inferredProviderId = inferProviderId(subscription, configuredProviderIds);
    if (inferredProviderId && !suppressedLinkIds[subscription.id]) {
      const groupedSubscriptions = linkedSubscriptionsByProvider.get(inferredProviderId) ?? [];
      groupedSubscriptions.push(subscription);
      linkedSubscriptionsByProvider.set(inferredProviderId, groupedSubscriptions);
      return;
    }

    standaloneSubscriptions.push({ subscription, inferredProviderId });
  });

  const subscriptionNodes: SubscriptionGraphNode[] = [];
  const linkedSubscriptionOffset = (PROVIDER_WIDTH - SUBSCRIPTION_WIDTH) / 2;

  providers.forEach(({ id: providerId }) => {
    const providerPosition = providerPositionById.get(providerId) ?? { x: PROVIDER_X_START, y: PROVIDER_Y };
    const groupedSubscriptions = linkedSubscriptionsByProvider.get(providerId) ?? [];

    groupedSubscriptions.forEach((subscription, index) => {
      const tone = getSubscriptionTone(subscription.category);
      const isPinned = Boolean(pinnedSubscriptionIds[subscription.id]);
      const subscriptionNodeId = `subscription:${subscription.id}`;
      const layoutKey = isPinned
        ? `pinned:${providerId}:${providers.length}:${index}`
        : `linked:${providerId}:${providers.length}:${index}`;
      const defaultPosition = {
        x: providerPosition.x + linkedSubscriptionOffset,
        y: providerPosition.y + LINKED_SUBSCRIPTION_OFFSET_Y + index * SUBSCRIPTION_ROW_GAP,
      };
      const position = isPinned
        ? defaultPosition
        : (
          getCurrentNodePosition(subscriptionNodeId, currentNodesById, layoutKey)
          ?? getStoredPosition(subscriptionNodeId, storedLayout, layoutKey)
          ?? defaultPosition
        );

      edges.push({
        id: `edge:subscription:${subscription.id}->provider:${providerId}`,
        source: subscriptionNodeId,
        target: `provider:${providerId}`,
        type: "smoothstep",
        data: { relation: "uses" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: PROVIDER_TONES[providerId].edgeColor,
        },
        style: {
          stroke: PROVIDER_TONES[providerId].edgeColor,
          strokeWidth: 1.6,
        },
      });

      subscriptionNodes.push({
        id: subscriptionNodeId,
        type: "subscription",
        position,
        sourcePosition: Position.Top,
        draggable: !isPinned,
        style: { width: SUBSCRIPTION_WIDTH, minHeight: 172 },
        data: {
          title: subscription.name,
          caption: formatCategoryLabel(subscription.category) || "Subscription",
          providerLabel: `Provider: ${subscription.provider || "Manual"}`,
          linkLabel: isPinned
            ? `Pinned to ${providerNameById.get(providerId) ?? "matched"} spend`
            : `Connected to ${providerNameById.get(providerId) ?? "matched"} spend`,
          linkActionLabel: "Unlink",
          linkedProviderNodeId: `provider:${providerId}`,
          linkState: "linked",
          isPinned,
          layoutKey,
          onToggleLink: () => onToggleSubscriptionLink(subscription.id),
          onTogglePin: () => onToggleSubscriptionPin(subscription.id),
          billingLabel: `${formatCurrency(monthlyEquivalent(subscription), subscription.currency)}/mo`,
          nextBillingLabel: formatShortDate(subscription.nextBillingAt),
          statusLabel: "Linked",
          tone,
        },
      });
    });
  });

  const standaloneColumnCount = standaloneSubscriptions.length <= 1 ? 1 : 2;
  const standaloneX =
    providers.length === 0
      ? PROVIDER_X_START
      : PROVIDER_X_START + providers.length * PROVIDER_COLUMN_GAP + STANDALONE_GROUP_GAP;
  const standaloneY = providers.length === 0 ? 112 : LINKED_SUBSCRIPTION_Y;

  standaloneSubscriptions.forEach(({ subscription, inferredProviderId }, index) => {
    const tone = getSubscriptionTone(subscription.category);
    const row = Math.floor(index / standaloneColumnCount);
    const column = index % standaloneColumnCount;
    const linkState: MapLinkState = inferredProviderId ? "unlinked" : "standalone";
    const linkedProviderName = inferredProviderId ? providerNameById.get(inferredProviderId) : null;
    const subscriptionNodeId = `subscription:${subscription.id}`;
    const layoutKey = inferredProviderId
      ? `unlinked:${inferredProviderId}:${providers.length}:${standaloneColumnCount}:${row}:${column}`
      : `standalone:${providers.length}:${standaloneColumnCount}:${row}:${column}`;
    const defaultPosition = {
      x: standaloneX + column * STANDALONE_COLUMN_GAP,
      y: standaloneY + row * SUBSCRIPTION_ROW_GAP,
    };
    const position =
      getCurrentNodePosition(subscriptionNodeId, currentNodesById, layoutKey)
      ?? getStoredPosition(subscriptionNodeId, storedLayout, layoutKey)
      ?? defaultPosition;

    subscriptionNodes.push({
      id: subscriptionNodeId,
      type: "subscription",
      position,
      sourcePosition: Position.Top,
      style: { width: SUBSCRIPTION_WIDTH, minHeight: 172 },
      data: {
        title: subscription.name,
        caption: formatCategoryLabel(subscription.category) || "Subscription",
        providerLabel: `Provider: ${subscription.provider || "Manual"}`,
        linkLabel: linkedProviderName ? `Suggested link: ${linkedProviderName}` : undefined,
        linkActionLabel: inferredProviderId ? "Relink" : undefined,
        linkState,
        layoutKey,
        onToggleLink: inferredProviderId ? () => onToggleSubscriptionLink(subscription.id) : undefined,
        billingLabel: `${formatCurrency(monthlyEquivalent(subscription), subscription.currency)}/mo`,
        nextBillingLabel: formatShortDate(subscription.nextBillingAt),
        statusLabel: inferredProviderId ? "Unlinked" : "Standalone",
        tone,
      },
    });
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
  const [suppressedLinkIds, setSuppressedLinkIds] = useState<Record<number, boolean>>({});
  const [pinnedSubscriptionIds, setPinnedSubscriptionIds] = useState<Record<number, boolean>>({});
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<MapNode, MapEdge> | null>(null);
  const [nodes, setNodes] = useNodesState<MapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapEdge>([]);
  const { loadError, states, visibleProviders } = useSpendData();
  const pendingResetIdsRef = useRef<Set<string>>(new Set());
  const suppressedLinkIdsRef = useRef<Record<number, boolean>>({});
  const pinnedSubscriptionIdsRef = useRef<Record<number, boolean>>({});
  const nodesRef = useRef<MapNode[]>([]);
  const storedLayoutRef = useRef<StoredMapLayout>(loadMapLayout());

  const mapProviders = useMemo(
    () => visibleProviders.filter(({ id }) => states[id].tag !== "unconfigured"),
    [states, visibleProviders],
  );

  const providerIds = useMemo(
    () => mapProviders.map(({ id }) => id),
    [mapProviders],
  );

  useEffect(() => {
    suppressedLinkIdsRef.current = suppressedLinkIds;
  }, [suppressedLinkIds]);

  useEffect(() => {
    pinnedSubscriptionIdsRef.current = pinnedSubscriptionIds;
  }, [pinnedSubscriptionIds]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const persistNodePositions = useCallback((nextNodes: MapNode[]) => {
    const nextLayout = { ...storedLayoutRef.current };

    nextNodes.forEach((node) => {
      if (node.type === "provider") {
        nextLayout[node.id] = {
          x: node.position.x,
          y: node.position.y,
        };
        return;
      }

      if (node.type === "subscription" && !node.data.isPinned) {
        nextLayout[node.id] = {
          x: node.position.x,
          y: node.position.y,
          layoutKey: node.data.layoutKey,
        };
      }
    });

    storedLayoutRef.current = nextLayout;
    persistMapLayout(nextLayout);
  }, []);

  const toggleSubscriptionLink = useCallback((subscriptionId: Subscription["id"]) => {
    const nextSuppressed = !suppressedLinkIdsRef.current[subscriptionId];
    pendingResetIdsRef.current.add(`subscription:${subscriptionId}`);
    void setSubscriptionLinkSuppressed(subscriptionId, nextSuppressed).catch(() => {});

    if (nextSuppressed && pinnedSubscriptionIdsRef.current[subscriptionId]) {
      setPinnedSubscriptionIds((current) => {
        const next = { ...current };
        delete next[subscriptionId];
        return next;
      });
    }

    setSuppressedLinkIds((current) => {
      if (current[subscriptionId]) {
        const next = { ...current };
        delete next[subscriptionId];
        return next;
      }

      return {
        ...current,
        [subscriptionId]: true,
      };
    });
  }, []);

  const toggleSubscriptionPin = useCallback((subscriptionId: Subscription["id"]) => {
    const nextPinned = !pinnedSubscriptionIdsRef.current[subscriptionId];
    if (nextPinned) {
      pendingResetIdsRef.current.add(`subscription:${subscriptionId}`);
    }

    void setSubscriptionLinkPinned(subscriptionId, nextPinned).catch(() => {});

    setPinnedSubscriptionIds((current) => {
      if (current[subscriptionId]) {
        const next = { ...current };
        delete next[subscriptionId];
        return next;
      }

      return {
        ...current,
        [subscriptionId]: true,
      };
    });
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<MapNode>[]) => {
    setNodes((currentNodes) => {
      const nextNodes = applyNodeChanges(changes, currentNodes);
      const repositionedNodes = movePinnedSubscriptionsWithProviders(currentNodes, nextNodes);

      if (changes.some((change) => change.type === "position")) {
        persistNodePositions(repositionedNodes);
      }

      return repositionedNodes;
    });
  }, [persistNodePositions, setNodes]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([listSubscriptions(), getSuppressedLinkIds(), getPinnedSubscriptionIds()])
      .then(([subscriptionData, suppressedIds, pinnedIds]) => {
        if (cancelled) return;
        setSubscriptions(subscriptionData);
        setSuppressedLinkIds(Object.fromEntries(suppressedIds.map((id) => [id, true])));
        setPinnedSubscriptionIds(Object.fromEntries(pinnedIds.map((id) => [id, true])));
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
    const resetPositionIds = pendingResetIdsRef.current;
    const currentNodesById = new Map(nodesRef.current.map((node) => [node.id, node]));
    const nextGraph = buildGraph(
      subscriptions,
      mapProviders,
      states,
      suppressedLinkIds,
      pinnedSubscriptionIds,
      toggleSubscriptionLink,
      toggleSubscriptionPin,
      storedLayoutRef.current,
      currentNodesById,
    );

    pendingResetIdsRef.current = new Set();
    setNodes((currentNodes) => mergeNodePositions(currentNodes, nextGraph.nodes, resetPositionIds));
    setEdges(nextGraph.edges);
  }, [
    mapProviders,
    pinnedSubscriptionIds,
    setEdges,
    setNodes,
    states,
    subscriptions,
    suppressedLinkIds,
    toggleSubscriptionLink,
    toggleSubscriptionPin,
  ]);

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
              layout deterministic while inferring subscription-to-provider links from existing data, with inline
              unlink controls when you want a cleaner overview.
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
              onNodesChange={handleNodesChange}
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
