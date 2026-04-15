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
import { getProductVisibility, setProductVisibility } from "../lib/api/products";
import {
  buildGraph,
  inferSubscriptionProviderId,
  mergeNodePositions,
  moveProviderRelativeNodesWithProviders,
  type MapEdge,
  type MapNode,
} from "../lib/mapGraph";
import {
  createDefaultProductVisibility,
  getProductsForProvider,
  type ProductId,
  type ProductVisibilityState,
} from "../lib/products";
import { SPEND_PROVIDERS } from "../lib/spendProviders";
import { formatCurrency } from "../lib/subscriptionMetrics";
import {
  getSuppressedLinkIds,
  listSubscriptions,
  setSubscriptionLinkSuppressed,
  type Subscription,
} from "../lib/subscriptions";
import {
  createAbsoluteNodeLayout,
  createRelativeNodeLayout,
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
  const [productVisibility, setProductVisibilityState] = useState<ProductVisibilityState>(
    createDefaultProductVisibility(),
  );
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<MapNode, MapEdge> | null>(null);
  const [nodes, setNodes] = useNodesState<MapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<MapEdge>([]);
  const { loadError, states, visibleProviders } = useSpendData();
  const pendingResetIdsRef = useRef<Set<string>>(new Set());
  const suppressedLinkIdsRef = useRef<Record<number, boolean>>({});
  const nodesRef = useRef<MapNode[]>([]);
  const storedLayoutRef = useRef<StoredMapLayout>(loadMapLayout());

  const mapProviders = useMemo(() => {
    const providerIds = new Set(
      visibleProviders
        .filter(({ id }) => states[id].tag !== "unconfigured")
        .map(({ id }) => id),
    );
    const knownProviderIds = new Set(SPEND_PROVIDERS.map(({ id }) => id));

    subscriptions.forEach((subscription) => {
      const inferredProviderId = inferSubscriptionProviderId(subscription, knownProviderIds);
      if (inferredProviderId) {
        providerIds.add(inferredProviderId);
      }
    });

    return SPEND_PROVIDERS.filter(
      ({ id, comingSoon }) => !comingSoon && providerIds.has(id),
    );
  }, [states, subscriptions, visibleProviders]);

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
    nodesRef.current = nodes;
  }, [nodes]);

  const writeStoredLayout = useCallback((nextLayout: StoredMapLayout) => {
    storedLayoutRef.current = nextLayout;
    persistMapLayout(nextLayout);
  }, []);

  const deleteStoredNodeLayout = useCallback((nodeId: string) => {
    if (!(nodeId in storedLayoutRef.current)) {
      return;
    }

    const nextLayout = { ...storedLayoutRef.current };
    delete nextLayout[nodeId];
    writeStoredLayout(nextLayout);
  }, [writeStoredLayout]);

  const setStoredNodeLayout = useCallback((nodeId: string, layout: ReturnType<typeof createAbsoluteNodeLayout>) => {
    writeStoredLayout({
      ...storedLayoutRef.current,
      [nodeId]: layout,
    });
  }, [writeStoredLayout]);

  const persistNodePositions = useCallback((nextNodes: MapNode[], changedPositionIds: Set<string>) => {
    if (changedPositionIds.size === 0) {
      return;
    }

    const nextLayout = { ...storedLayoutRef.current };
    const nextNodesById = new Map(nextNodes.map((node) => [node.id, node]));
    const providerPositions = new Map(
      nextNodes
        .filter((node): node is Extract<MapNode, { type: "provider" }> => node.type === "provider")
        .map((node) => [node.id, node.position]),
    );

    changedPositionIds.forEach((nodeId) => {
      const node = nextNodesById.get(nodeId);
      if (!node) {
        return;
      }

      if (node.type === "provider") {
        nextLayout[node.id] = createAbsoluteNodeLayout(node.position.x, node.position.y);
        return;
      }

      const parentNodeId =
        node.type === "product"
          ? node.data.parentProviderNodeId
          : node.data.linkedProviderNodeId;

      if (parentNodeId) {
        const parentPosition = providerPositions.get(parentNodeId);
        if (!parentPosition) {
          return;
        }

        nextLayout[node.id] = createRelativeNodeLayout(
          parentNodeId,
          node.position.x - parentPosition.x,
          node.position.y - parentPosition.y,
          node.data.layoutKey,
        );
        return;
      }

      nextLayout[node.id] = createAbsoluteNodeLayout(
        node.position.x,
        node.position.y,
      );
    });

    writeStoredLayout(nextLayout);
  }, [writeStoredLayout]);

  const toggleSubscriptionLink = useCallback((subscriptionId: Subscription["id"]) => {
    const nextSuppressed = !suppressedLinkIdsRef.current[subscriptionId];
    const nodeId = `subscription:${subscriptionId}`;
    const currentNode = nodesRef.current.find((node) => node.id === nodeId);

    if (nextSuppressed && currentNode?.type === "subscription") {
      setStoredNodeLayout(
        nodeId,
        createAbsoluteNodeLayout(currentNode.position.x, currentNode.position.y),
      );
    } else {
      deleteStoredNodeLayout(nodeId);
    }

    void setSubscriptionLinkSuppressed(subscriptionId, nextSuppressed).catch(() => {});

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
  }, [deleteStoredNodeLayout, setStoredNodeLayout]);

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

  const resetNodePosition = useCallback((nodeId: string) => {
    pendingResetIdsRef.current.add(nodeId);
    deleteStoredNodeLayout(nodeId);
    setLayoutVersion((current) => current + 1);
  }, [deleteStoredNodeLayout]);

  const handleNodeDragStop = useCallback((_event: unknown, node: MapNode) => {
    const isProviderLinkedChild =
      node.type === "product"
      || (node.type === "subscription" && Boolean(node.data.linkedProviderNodeId));

    if (!isProviderLinkedChild) {
      return;
    }

    setLayoutVersion((current) => current + 1);
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<MapNode>[]) => {
    const changedPositionIds = new Set(
      changes
        .filter((change): change is Extract<NodeChange<MapNode>, { type: "position" }> => change.type === "position")
        .map((change) => change.id),
    );

    setNodes((currentNodes) => {
      const nextNodes = applyNodeChanges(changes, currentNodes);
      const repositionedNodes = moveProviderRelativeNodesWithProviders(currentNodes, nextNodes);

      if (changedPositionIds.size > 0) {
        persistNodePositions(repositionedNodes, changedPositionIds);
      }

      return repositionedNodes;
    });
  }, [persistNodePositions, setNodes]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      listSubscriptions(),
      getSuppressedLinkIds(),
      getProductVisibility(),
    ])
      .then(([subscriptionData, suppressedIds, visibility]) => {
        if (cancelled) return;
        setSubscriptions(subscriptionData);
        setSuppressedLinkIds(Object.fromEntries(suppressedIds.map((id) => [id, true])));
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
      productVisibility,
      onToggleSubscriptionLink: toggleSubscriptionLink,
      onResetNodePosition: resetNodePosition,
      storedLayout: storedLayoutRef.current,
      currentNodesById,
      ignoredCurrentPositionIds: resetPositionIds,
    });

    pendingResetIdsRef.current = new Set();
    setNodes((currentNodes) => mergeNodePositions(currentNodes, nextGraph.nodes, resetPositionIds));
    setEdges(nextGraph.edges);
  }, [
    layoutVersion,
    mapProviders,
    productVisibility,
    resetNodePosition,
    setEdges,
    setNodes,
    states,
    subscriptions,
    suppressedLinkIds,
    toggleSubscriptionLink,
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
            Drag providers and child nodes to personalize the layout
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
                      const toggleClassName = `map-node-tone ${tone.className} rounded-full border px-3 py-1.5 text-xs transition-colors ${enabled ? "map-product-toggle-active" : "map-product-toggle-inactive"}`;

                      return (
                        <button
                          key={product.id}
                          type="button"
                          className={toggleClassName}
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
              onNodeDragStop={handleNodeDragStop}
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
