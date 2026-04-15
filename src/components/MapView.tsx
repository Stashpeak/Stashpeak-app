import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import { getProductVisibility, setProductVisibility } from "../lib/api/products";
import {
  buildGraph,
  mergeNodePositions,
  moveAnchoredNodesWithProviders,
  type MapEdge,
  type MapNode,
} from "../lib/mapGraph";
import {
  createDefaultProductVisibility,
  getProductsForProvider,
  type ProductId,
  type ProductVisibilityState,
} from "../lib/products";
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
import { BusEdge } from "./map/BusEdge";
import { ProductNode } from "./map/ProductNode";
import { ProviderNode } from "./map/ProviderNode";
import { SubscriptionNode } from "./map/SubscriptionNode";
import { PROVIDER_TONES } from "./map/types";

const nodeTypes = {
  provider: ProviderNode,
  product: ProductNode,
  subscription: SubscriptionNode,
};

const edgeTypes = {
  bus: BusEdge,
};

const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };

export function MapView() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionsLoaded, setSubscriptionsLoaded] = useState(false);
  const [subscriptionsError, setSubscriptionsError] = useState<string | null>(null);
  const [suppressedLinkIds, setSuppressedLinkIds] = useState<Record<number, boolean>>({});
  const [pinnedSubscriptionIds, setPinnedSubscriptionIds] = useState<Record<number, boolean>>({});
  const [productVisibility, setProductVisibilityState] = useState<ProductVisibilityState>(
    createDefaultProductVisibility(),
  );
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

  const productGroups = useMemo(
    () => mapProviders.map((provider) => ({
      provider,
      products: getProductsForProvider(provider.id),
    })),
    [mapProviders],
  );

  const totalToggleableProducts = useMemo(
    () => productGroups.reduce((sum, { products }) => sum + products.length, 0),
    [productGroups],
  );

  const visibleProductToggleCount = useMemo(
    () =>
      productGroups.reduce(
        (sum, { products }) =>
          sum + products.filter((product) => productVisibility[product.id]).length,
        0,
      ),
    [productGroups, productVisibility],
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

  const toggleProductVisibility = useCallback((productId: ProductId) => {
    pendingResetIdsRef.current.add(`product:${productId}`);
    setProductVisibilityState((current) => {
      const nextEnabled = !current[productId];
      void setProductVisibility(productId, nextEnabled).catch(() => {});

      return {
        ...current,
        [productId]: nextEnabled,
      };
    });
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<MapNode>[]) => {
    setNodes((currentNodes) => {
      const nextNodes = applyNodeChanges(changes, currentNodes);
      const repositionedNodes = moveAnchoredNodesWithProviders(currentNodes, nextNodes);

      if (changes.some((change) => change.type === "position")) {
        persistNodePositions(repositionedNodes);
      }

      return repositionedNodes;
    });
  }, [persistNodePositions, setNodes]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      listSubscriptions(),
      getSuppressedLinkIds(),
      getPinnedSubscriptionIds(),
      getProductVisibility(),
    ])
      .then(([subscriptionData, suppressedIds, pinnedIds, visibility]) => {
        if (cancelled) return;
        setSubscriptions(subscriptionData);
        setSuppressedLinkIds(Object.fromEntries(suppressedIds.map((id) => [id, true])));
        setPinnedSubscriptionIds(Object.fromEntries(pinnedIds.map((id) => [id, true])));
        setProductVisibilityState(visibility);
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
      productVisibility,
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
    productVisibility,
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
  const productCount = nodes.filter((node) => node.type === "product").length;
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
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-[var(--text-secondary)]">
              Configured providers, their product tiers, and linked subscriptions rendered as a single map. Product
              visibility is adjustable inline so you can keep the hierarchy detailed without turning the canvas into
              noise.
            </p>
          </div>

          <div className="flex flex-wrap gap-2.5">
            <div className={PILL_SURFACE}>
              <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Providers</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{providerCount}</span>
            </div>
            <div className={PILL_SURFACE}>
              <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Products</span>
              <span className="text-sm font-medium text-[var(--text-primary)]">{productCount}</span>
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
          <span className="rounded-full border px-3 py-1.5 text-xs text-[var(--text-secondary)] border-[rgba(245,158,11,0.28)] bg-[rgba(245,158,11,0.12)]">
            Product nodes
          </span>
          <span className="rounded-full border px-3 py-1.5 text-xs text-[var(--text-secondary)] border-[rgba(173,70,255,0.28)] bg-[rgba(173,70,255,0.12)]">
            Subscription nodes
          </span>
          <span className="rounded-full border px-3 py-1.5 text-xs text-[var(--text-secondary)] border-[var(--glass-border)] bg-[var(--glass-bg)]">
            Drag providers and subscriptions to personalize the layout
          </span>
        </div>

        {productGroups.length > 0 ? (
          <div className="mt-4 rounded-[24px] border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">Product visibility</p>
                <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                  Hide product tiers you do not want rendered. Linked subscriptions stay attached to the provider even
                  when an intermediate product node is filtered out.
                </p>
              </div>
              <div className={PILL_SURFACE}>
                <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Visible</span>
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {visibleProductToggleCount}/{totalToggleableProducts}
                </span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              {productGroups.map(({ provider, products }) => (
                <div
                  key={provider.id}
                  className="min-w-[220px] rounded-[20px] border border-[var(--glass-border)] px-3.5 py-3"
                >
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">{provider.name}</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {products.map((product) => {
                      const enabled = productVisibility[product.id];
                      const tone = PROVIDER_TONES[provider.id];
                      const toggleStyle = (
                        enabled
                          ? {
                            backgroundColor: tone.badgeFill,
                            borderColor: tone.badgeBorder,
                            color: tone.badgeText,
                          }
                          : {
                            backgroundColor: tone.metricFill,
                            borderColor: tone.metricBorder,
                            color: "var(--text-secondary)",
                          }
                      ) as CSSProperties;

                      return (
                        <button
                          key={product.id}
                          type="button"
                          className="rounded-full border px-3 py-1.5 text-xs transition-colors"
                          style={toggleStyle}
                          onClick={() => toggleProductVisibility(product.id)}
                          aria-pressed={enabled}
                          title={enabled ? `Hide ${product.label}` : `Show ${product.label}`}
                        >
                          {product.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
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
              edgeTypes={edgeTypes}
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
