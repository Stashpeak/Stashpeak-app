import { MarkerType, Position, type Edge } from "@xyflow/react";
import {
  CATEGORY_TONES,
  PROVIDER_TONES,
  type MapLinkState,
  type MapNodeTone,
  type ProductGraphNode,
  type ProviderGraphNode,
  type SubscriptionGraphNode,
} from "../components/map/types";
import { formatCategoryLabel } from "./categoryFormatting";
import { type StoredMapLayout } from "./mapLayout";
import {
  getProductById,
  getProductsForProvider,
  inferProductIds,
  isProductEnabled,
  type ProductDefinition,
  type ProductId,
  type ProductVisibilityState,
} from "./products";
import {
  formatProviderRefreshedAt,
  type ProviderDefinition,
  type ProviderId,
  type ProviderStatus,
} from "./spendProviders";
import { findPresetForSubscription } from "./subscriptionPresets";
import { formatCurrency, monthlyEquivalent } from "./subscriptionMetrics";
import { type Subscription } from "./subscriptions";

export type MapNode = ProviderGraphNode | ProductGraphNode | SubscriptionGraphNode;
export type MapEdge = Edge<{ relation: "uses" | "provides" | "covers" }, "smoothstep">;

interface BuildGraphOptions {
  subscriptions: Subscription[];
  providers: ProviderDefinition[];
  states: Record<ProviderId, ProviderStatus>;
  suppressedLinkIds: Record<number, boolean>;
  pinnedSubscriptionIds: Record<number, boolean>;
  productVisibility: ProductVisibilityState;
  onToggleSubscriptionLink: (subscriptionId: Subscription["id"]) => void;
  onToggleSubscriptionPin: (subscriptionId: Subscription["id"]) => void;
  storedLayout: StoredMapLayout;
  currentNodesById: Map<string, MapNode>;
}

interface ProviderLayout {
  position: { x: number; y: number };
  centerX: number;
  columnWidth: number;
  visibleProducts: ProductDefinition[];
}

interface LinkedSubscription {
  subscription: Subscription;
  visibleProductIds: ProductId[];
  matchedProductIds: ProductId[];
}

const PROVIDER_ALIASES: Record<ProviderId, string[]> = {
  anthropic: ["anthropic", "claude"],
  openai: ["openai", "chatgpt"],
  openrouter: ["openrouter"],
  groq: ["groq"],
  gcp: ["google cloud", "google ai", "gemini", "gcp", "google"],
};

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

export function mergeNodePositions(
  currentNodes: MapNode[],
  nextNodes: MapNode[],
  resetPositionIds?: Set<string>,
): MapNode[] {
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

  return getNodeLayoutKey(currentNode) !== getNodeLayoutKey(nextNode);
}

function getNodeLayoutKey(node: MapNode): string | undefined {
  if (node.type === "product" || node.type === "subscription") {
    return node.data.layoutKey;
  }

  return undefined;
}

export function moveAnchoredNodesWithProviders(currentNodes: MapNode[], nextNodes: MapNode[]): MapNode[] {
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
    if (node.type === "product") {
      const providerDelta = providerDeltas.get(node.data.parentProviderNodeId);
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
    }

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

  const currentLayoutKey = getNodeLayoutKey(currentNode);
  if (layoutKey && currentLayoutKey && currentLayoutKey !== layoutKey) {
    return null;
  }

  return currentNode.position;
}

function createProviderEdgeColor(providerId: ProviderId) {
  return PROVIDER_TONES[providerId].edgeColor;
}

function formatProductLabels(productIds: ProductId[]): string {
  return productIds.map((productId) => getProductById(productId).label).join(", ");
}

export function buildGraph({
  subscriptions,
  providers,
  states,
  suppressedLinkIds,
  pinnedSubscriptionIds,
  productVisibility,
  onToggleSubscriptionLink,
  onToggleSubscriptionPin,
  storedLayout,
  currentNodesById,
}: BuildGraphOptions): { nodes: MapNode[]; edges: MapEdge[] } {
  const PROVIDER_X_START = 120;
  const PROVIDER_Y = 72;
  const PROVIDER_WIDTH = 272;
  const PROVIDER_COLUMN_GAP = 112;
  const PRODUCT_WIDTH = 172;
  const PRODUCT_ROW_GAP = 18;
  const PRODUCT_OFFSET_Y = 218;
  const SUBSCRIPTION_WIDTH = 236;
  const LINKED_SUBSCRIPTION_OFFSET_Y = 388;
  const SUBSCRIPTION_ROW_GAP = 194;
  const STANDALONE_COLUMN_GAP = 264;
  const STANDALONE_GROUP_GAP = providers.length > 0 ? 104 : 0;

  const providerNodes: ProviderGraphNode[] = [];
  const productNodes: ProductGraphNode[] = [];
  const subscriptionNodes: SubscriptionGraphNode[] = [];
  const edges: MapEdge[] = [];

  const providerLayouts = new Map<ProviderId, ProviderLayout>();
  const providerNameById = new Map(providers.map(({ id, name }) => [id, name]));
  const configuredProviderIds = new Set(providers.map(({ id }) => id));
  const linkedSubscriptionsByProvider = new Map<ProviderId, LinkedSubscription[]>();
  const linkedSubscriptionCountByProductId = new Map<ProductId, number>();
  const standaloneSubscriptions: Array<{
    subscription: Subscription;
    inferredProviderId: ProviderId | null;
  }> = [];

  let nextProviderColumnX = PROVIDER_X_START;

  providers.forEach(({ id: providerId, name }) => {
    const status = states[providerId];
    const tone = PROVIDER_TONES[providerId];
    const previousMonthUsd = status.tag === "ok" ? status.data.previousMonthUsd : 0;
    const providerNodeId = `provider:${providerId}`;
    const visibleProducts = getProductsForProvider(providerId).filter((product) =>
      isProductEnabled(product.id, productVisibility),
    );
    const productRowWidth = visibleProducts.length === 0
      ? 0
      : visibleProducts.length * PRODUCT_WIDTH + (visibleProducts.length - 1) * PRODUCT_ROW_GAP;
    const columnWidth = Math.max(PROVIDER_WIDTH, SUBSCRIPTION_WIDTH, productRowWidth);
    const defaultPosition = {
      x: nextProviderColumnX + (columnWidth - PROVIDER_WIDTH) / 2,
      y: PROVIDER_Y,
    };
    const position =
      getCurrentNodePosition(providerNodeId, currentNodesById)
      ?? getStoredPosition(providerNodeId, storedLayout)
      ?? defaultPosition;
    const centerX = position.x + PROVIDER_WIDTH / 2;

    providerLayouts.set(providerId, {
      position,
      centerX,
      columnWidth,
      visibleProducts,
    });

    providerNodes.push({
      id: providerNodeId,
      type: "provider",
      position,
      sourcePosition: Position.Bottom,
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

    nextProviderColumnX += columnWidth + PROVIDER_COLUMN_GAP;
  });

  subscriptions.forEach((subscription) => {
    const inferredProviderId = inferProviderId(subscription, configuredProviderIds);
    if (inferredProviderId && !suppressedLinkIds[subscription.id]) {
      const matchedProductIds = inferProductIds(subscription, inferredProviderId);
      const visibleProductIds = matchedProductIds.filter((productId) =>
        isProductEnabled(productId, productVisibility),
      );

      visibleProductIds.forEach((productId) => {
        linkedSubscriptionCountByProductId.set(
          productId,
          (linkedSubscriptionCountByProductId.get(productId) ?? 0) + 1,
        );
      });

      const groupedSubscriptions = linkedSubscriptionsByProvider.get(inferredProviderId) ?? [];
      groupedSubscriptions.push({
        subscription,
        visibleProductIds,
        matchedProductIds,
      });
      linkedSubscriptionsByProvider.set(inferredProviderId, groupedSubscriptions);
      return;
    }

    standaloneSubscriptions.push({ subscription, inferredProviderId });
  });

  providers.forEach(({ id: providerId }) => {
    const layout = providerLayouts.get(providerId);
    if (!layout) return;

    const providerNodeId = `provider:${providerId}`;
    const edgeColor = createProviderEdgeColor(providerId);
    const productCount = layout.visibleProducts.length;
    const productRowWidth = productCount === 0
      ? 0
      : productCount * PRODUCT_WIDTH + (productCount - 1) * PRODUCT_ROW_GAP;
    const productStartX = layout.centerX - productRowWidth / 2;

    layout.visibleProducts.forEach((product, index) => {
      const productNodeId = `product:${product.id}`;
      const linkedSubscriptionCount = linkedSubscriptionCountByProductId.get(product.id) ?? 0;
      const layoutKey = `product:${providerId}:${productCount}:${index}`;
      const defaultPosition = {
        x: productStartX + index * (PRODUCT_WIDTH + PRODUCT_ROW_GAP),
        y: layout.position.y + PRODUCT_OFFSET_Y,
      };
      const position =
        getCurrentNodePosition(productNodeId, currentNodesById, layoutKey)
        ?? defaultPosition;

      productNodes.push({
        id: productNodeId,
        type: "product",
        position,
        draggable: false,
        style: { width: PRODUCT_WIDTH, minHeight: 128 },
        data: {
          title: product.label,
          caption: providerNameById.get(providerId) ?? "Product",
          description: product.description,
          statusLabel: linkedSubscriptionCount > 0 ? "Active" : "Catalog",
          activityLabel:
            linkedSubscriptionCount > 0
              ? `${linkedSubscriptionCount} subscription${linkedSubscriptionCount === 1 ? "" : "s"} mapped`
              : "Visible, but not covered by a linked subscription",
          subscriptionCount: linkedSubscriptionCount,
          isLinked: linkedSubscriptionCount > 0,
          parentProviderNodeId: providerNodeId,
          layoutKey,
          tone: PROVIDER_TONES[providerId],
        },
      });

      edges.push({
        id: `edge:${providerNodeId}->${productNodeId}`,
        source: providerNodeId,
        target: productNodeId,
        targetHandle: "provider",
        type: "smoothstep",
        data: { relation: "provides" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edgeColor,
        },
        style: {
          stroke: edgeColor,
          strokeWidth: 1.5,
        },
      });
    });
  });

  providers.forEach(({ id: providerId }) => {
    const layout = providerLayouts.get(providerId);
    if (!layout) return;

    const groupedSubscriptions = linkedSubscriptionsByProvider.get(providerId) ?? [];

    groupedSubscriptions.forEach(({ subscription, visibleProductIds, matchedProductIds }, index) => {
      const tone = getSubscriptionTone(subscription.category);
      const isPinned = Boolean(pinnedSubscriptionIds[subscription.id]);
      const subscriptionNodeId = `subscription:${subscription.id}`;
      const providerNodeId = `provider:${providerId}`;
      const layoutKey = isPinned
        ? `pinned:${providerId}:${providers.length}:${index}`
        : `linked:${providerId}:${providers.length}:${index}`;
      const defaultPosition = {
        x: layout.centerX - SUBSCRIPTION_WIDTH / 2,
        y: layout.position.y + LINKED_SUBSCRIPTION_OFFSET_Y + index * SUBSCRIPTION_ROW_GAP,
      };
      const position = isPinned
        ? defaultPosition
        : (
          getCurrentNodePosition(subscriptionNodeId, currentNodesById, layoutKey)
          ?? getStoredPosition(subscriptionNodeId, storedLayout, layoutKey)
          ?? defaultPosition
        );

      if (visibleProductIds.length > 0) {
        visibleProductIds.forEach((productId) => {
          edges.push({
            id: `edge:${subscriptionNodeId}->product:${productId}`,
            source: subscriptionNodeId,
            target: `product:${productId}`,
            targetHandle: "subscription",
            type: "smoothstep",
            data: { relation: "covers" },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: PROVIDER_TONES[providerId].edgeColor,
            },
            style: {
              stroke: PROVIDER_TONES[providerId].edgeColor,
              strokeDasharray: "6 4",
              strokeWidth: 1.5,
            },
          });
        });
      } else {
        edges.push({
          id: `edge:${subscriptionNodeId}->${providerNodeId}`,
          source: subscriptionNodeId,
          target: providerNodeId,
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
      }

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
          linkLabel:
            visibleProductIds.length > 0
              ? `Products: ${formatProductLabels(visibleProductIds)}`
              : matchedProductIds.length > 0
                ? `Products hidden on map: ${formatProductLabels(matchedProductIds)}`
                : "Product match pending",
          linkActionLabel: "Unlink",
          linkedProviderNodeId: providerNodeId,
          linkState: "linked",
          isPinned,
          layoutKey,
          onToggleLink: () => onToggleSubscriptionLink(subscription.id),
          onTogglePin: () => onToggleSubscriptionPin(subscription.id),
          billingLabel: `${formatCurrency(monthlyEquivalent(subscription), subscription.currency)}/mo`,
          nextBillingLabel: formatShortDate(subscription.nextBillingAt),
          statusLabel:
            visibleProductIds.length > 0
              ? "Mapped"
              : matchedProductIds.length > 0
                ? "Filtered"
                : "Linked",
          tone,
        },
      });
    });
  });

  const standaloneColumnCount = standaloneSubscriptions.length <= 1 ? 1 : 2;
  const providerRightEdge = providers.reduce((maxRightEdge, { id: providerId }) => {
    const layout = providerLayouts.get(providerId);
    if (!layout) return maxRightEdge;

    return Math.max(maxRightEdge, layout.centerX + layout.columnWidth / 2);
  }, PROVIDER_X_START + PROVIDER_WIDTH);
  const standaloneX =
    providers.length === 0
      ? PROVIDER_X_START
      : providerRightEdge + STANDALONE_GROUP_GAP;
  const standaloneY = providers.length === 0 ? 112 : PROVIDER_Y + LINKED_SUBSCRIPTION_OFFSET_Y;

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
    nodes: [...providerNodes, ...productNodes, ...subscriptionNodes],
    edges,
  };
}
