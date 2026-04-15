import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useSpendData } from "../hooks/useSpendData";
import {
  buildGraph,
  mergeNodePositions,
  movePinnedSubscriptionsWithProviders,
  type MapEdge,
  type MapNode,
} from "../lib/mapGraph";
import { formatCurrency } from "../lib/subscriptionMetrics";
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
import { ProviderNode } from "./map/ProviderNode";
import { SubscriptionNode } from "./map/SubscriptionNode";

const nodeTypes = {
  provider: ProviderNode,
  subscription: SubscriptionNode,
};

const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };

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
    const nextGraph = buildGraph({
      subscriptions,
      providers: mapProviders,
      states,
      suppressedLinkIds,
      pinnedSubscriptionIds,
      onToggleSubscriptionLink: toggleSubscriptionLink,
      onToggleSubscriptionPin: toggleSubscriptionPin,
      storedLayout: storedLayoutRef.current,
      currentNodesById,
    });

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
