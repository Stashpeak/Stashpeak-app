import { describe, expect, it, vi } from "vitest";

import { buildGraph, type MapEdge, type MapNode } from "./mapGraph";
import {
  EMPTY_PROVIDER_STATES,
  type ProviderDefinition,
  type ProviderId,
  type ProviderStatus,
} from "./spendProviders";
import { createDefaultProductVisibility, mergeProductVisibility } from "./products";
import { createAbsoluteNodeLayout, createRelativeNodeLayout } from "./mapLayout";
import type { MapNodeTone } from "./mapTypes";
import type { Subscription } from "./subscriptions";

type BuildGraphOptions = Parameters<typeof buildGraph>[0];

// --- builders -------------------------------------------------------------

function makeSub(
  partial: Partial<Subscription> & Pick<Subscription, "id" | "name" | "provider">,
): Subscription {
  return {
    monthlyCost: 20,
    currency: "USD",
    billingPeriod: "monthly",
    nextBillingAt: "2026-06-15",
    category: "assistant",
    notes: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function statesWith(
  overrides: Partial<Record<ProviderId, ProviderStatus>>,
): Record<ProviderId, ProviderStatus> {
  return { ...EMPTY_PROVIDER_STATES, ...overrides };
}

function options(overrides: Partial<BuildGraphOptions> = {}): BuildGraphOptions {
  return {
    subscriptions: [],
    providers: [],
    states: EMPTY_PROVIDER_STATES,
    suppressedLinkIds: {},
    productVisibility: createDefaultProductVisibility(),
    onToggleSubscriptionLink: vi.fn(),
    onResetNodePosition: vi.fn(),
    storedLayout: {},
    currentNodesById: new Map(),
    ignoredCurrentPositionIds: undefined,
    ...overrides,
  };
}

const ANTHROPIC: ProviderDefinition = { id: "anthropic", name: "Anthropic" };
const OPENAI: ProviderDefinition = { id: "openai", name: "OpenAI" };

// --- deterministic projection ---------------------------------------------
// Snapshot a stable subset of the graph. Function-valued data fields (the
// onToggleLink / onResetPosition closures) are replaced with a "[fn]" sentinel
// rather than dropped: JSON-style serialization silently omits functions, which
// would make a regression that loses callback wiring look like a stable
// snapshot. The tone object is collapsed to its className (the rest is a
// constant style lookup that adds noise without adding coverage).

function projectData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "function") {
      out[key] = "[fn]";
    } else if (key === "tone") {
      out[key] = (value as MapNodeTone).className;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function projectNode(node: MapNode) {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: projectData(node.data),
  };
}

function projectEdge(edge: MapEdge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    targetHandle: edge.targetHandle ?? null,
    relation: edge.data?.relation ?? null,
  };
}

function projectGraph(graph: { nodes: MapNode[]; edges: MapEdge[] }) {
  return {
    nodes: graph.nodes.map(projectNode),
    edges: graph.edges.map(projectEdge),
  };
}

// --- fixtures --------------------------------------------------------------

const fixtures: Array<{ name: string; options: BuildGraphOptions }> = [
  {
    name: "multi-provider with linked and standalone subscriptions",
    options: options({
      providers: [ANTHROPIC, OPENAI],
      states: statesWith({ anthropic: { tag: "loading" }, openai: { tag: "loading" } }),
      subscriptions: [
        makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic", category: "assistant" }),
        makeSub({ id: 2, name: "ChatGPT Plus", provider: "OpenAI", category: "assistant" }),
        makeSub({ id: 3, name: "Midjourney", provider: "Midjourney", category: "image" }),
      ],
    }),
  },
  {
    name: "suppressed link forces a linked subscription into the unlinked column",
    options: options({
      providers: [ANTHROPIC],
      states: statesWith({ anthropic: { tag: "loading" } }),
      subscriptions: [makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic", category: "assistant" })],
      suppressedLinkIds: { 1: true },
    }),
  },
  {
    name: "hidden products collapse covers-edges into a single uses-edge",
    options: options({
      providers: [ANTHROPIC],
      states: statesWith({ anthropic: { tag: "loading" } }),
      subscriptions: [makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic", category: "assistant" })],
      productVisibility: mergeProductVisibility({
        "anthropic:claude-ai": false,
        "anthropic:claude-code": false,
      }),
    }),
  },
  {
    name: "stored absolute provider layout with relative child overrides",
    options: options({
      providers: [ANTHROPIC],
      states: statesWith({ anthropic: { tag: "loading" } }),
      subscriptions: [makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic", category: "assistant" })],
      storedLayout: {
        "provider:anthropic": createAbsoluteNodeLayout(500, 60),
        "product:anthropic:claude-ai": createRelativeNodeLayout(
          "provider:anthropic",
          10,
          300,
          "product:anthropic:3:0",
        ),
        "subscription:1": createRelativeNodeLayout(
          "provider:anthropic",
          0,
          500,
          "linked:anthropic:1:1:0:0",
        ),
      },
    }),
  },
  {
    name: "no providers renders a pure standalone grid",
    options: options({
      providers: [],
      states: EMPTY_PROVIDER_STATES,
      subscriptions: [
        makeSub({ id: 1, name: "Midjourney", provider: "Midjourney", category: "image" }),
        makeSub({ id: 2, name: "Perplexity Pro", provider: "Perplexity", category: "research" }),
      ],
    }),
  },
  {
    // Exercises the 'ok' status branch: statusLabel "Live", Intl-formatted
    // primary/secondary spend, and the formatProviderRefreshedAt note (which
    // uses Date.prototype.toLocale*). refreshedAt is a fixed past instant so
    // isToday is deterministically false; with TZ=UTC + the locale pins in
    // src/test/setup.ts the rendered strings are stable across machines.
    name: "live (ok) provider renders formatted spend and a refreshed-at note",
    options: options({
      providers: [ANTHROPIC],
      states: statesWith({
        anthropic: {
          tag: "ok",
          data: { currentMonthUsd: 1234.56, previousMonthUsd: 1000, lastActivityAt: null },
          refreshedAt: new Date("2020-01-15T08:30:00Z"),
        },
      }),
      subscriptions: [makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic", category: "assistant" })],
    }),
  },
];

describe("buildGraph golden snapshots", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(projectGraph(buildGraph(fixture.options))).toMatchSnapshot();
    });
  }

  it("is a pure function of its inputs (pinned locale/timezone)", () => {
    const fixture = fixtures[0].options;
    expect(projectGraph(buildGraph(fixture))).toEqual(projectGraph(buildGraph(fixture)));
  });
});

// --- behavioral invariants (readable failures independent of snapshot churn) -

describe("buildGraph behavioral invariants", () => {
  it("routes a suppressed link to a standalone 'unlinked' node with no edges", () => {
    const graph = buildGraph(
      options({
        providers: [ANTHROPIC],
        states: statesWith({ anthropic: { tag: "loading" } }),
        subscriptions: [makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic" })],
        suppressedLinkIds: { 1: true },
      }),
    );

    const sub = graph.nodes.find((node) => node.id === "subscription:1");
    expect(sub?.type).toBe("subscription");
    expect(sub?.type === "subscription" && sub.data.linkState).toBe("unlinked");
    expect(graph.edges.filter((edge) => edge.source === "subscription:1")).toHaveLength(0);
  });

  it("emits a single 'uses' edge (not covers-edges) when all matched products are hidden", () => {
    const graph = buildGraph(
      options({
        providers: [ANTHROPIC],
        states: statesWith({ anthropic: { tag: "loading" } }),
        subscriptions: [makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic" })],
        productVisibility: mergeProductVisibility({
          "anthropic:claude-ai": false,
          "anthropic:claude-code": false,
        }),
      }),
    );

    const subEdges = graph.edges.filter((edge) => edge.source === "subscription:1");
    expect(subEdges).toHaveLength(1);
    expect(subEdges[0]).toMatchObject({ target: "provider:anthropic", data: { relation: "uses" } });

    const sub = graph.nodes.find((node) => node.id === "subscription:1");
    expect(sub?.type === "subscription" && sub.data.statusLabel).toBe("Filtered");
  });

  it("lets ignoredCurrentPositionIds override the live node position back to default", () => {
    const base = options({
      providers: [ANTHROPIC],
      states: statesWith({ anthropic: { tag: "loading" } }),
      subscriptions: [makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic" })],
    });

    const seed = buildGraph(base).nodes.find((node) => node.id === "provider:anthropic")!;
    const defaultPosition = seed.position;
    const moved: MapNode = { ...seed, position: { x: 999, y: 111 } };
    const currentNodesById = new Map<string, MapNode>([["provider:anthropic", moved]]);

    const honoured = buildGraph({ ...base, currentNodesById });
    expect(honoured.nodes.find((node) => node.id === "provider:anthropic")?.position).toEqual({
      x: 999,
      y: 111,
    });

    const ignored = buildGraph({
      ...base,
      currentNodesById,
      ignoredCurrentPositionIds: new Set(["provider:anthropic"]),
    });
    expect(ignored.nodes.find((node) => node.id === "provider:anthropic")?.position).toEqual(
      defaultPosition,
    );
  });

  it("wires onToggleLink only for subscriptions that have an inferable provider", () => {
    const graph = buildGraph(
      options({
        providers: [ANTHROPIC],
        states: statesWith({ anthropic: { tag: "loading" } }),
        subscriptions: [
          makeSub({ id: 1, name: "Claude Pro", provider: "Anthropic" }), // linked -> has toggle
          makeSub({ id: 2, name: "Midjourney", provider: "Midjourney" }), // standalone -> no toggle
        ],
      }),
    );

    const linked = graph.nodes.find((node) => node.id === "subscription:1");
    const standalone = graph.nodes.find((node) => node.id === "subscription:2");
    expect(linked?.type === "subscription" && typeof linked.data.onToggleLink).toBe("function");
    expect(standalone?.type === "subscription" && standalone.data.linkState).toBe("standalone");
    expect(standalone?.type === "subscription" && standalone.data.onToggleLink).toBeUndefined();
  });
});
