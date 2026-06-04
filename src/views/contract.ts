// ============================================================================
// src/views/contract.ts — v1 View contribution contract (0.5.0 "View Slots")
//
// Mirrors the shipped 0.4.0 Connector descriptor/registry style
// (src-tauri/src/connectors/{descriptor,registry}.rs) onto the frontend View
// axis: stable string ids, an `abiVersion` load-time gate, a declared-capability
// manifest (`dataDeps` ⟂ connector `permissions.network`, E4), declared action
// handles (⟂ credential surface), a deterministic registry, and a camelCase
// serializable `ViewInfo` projection behind a future `list_views()`.
//
// FORWARD-COMPAT CONTRACT (spec §6 L80–94 / §13 L181–191 / §10 E9/E10): the
// surface below is shaped so the v2 (a) declarative-renderer interpreter and
// (b) Native | Wasm dispatch arm bolt on WITHOUT breaking any extension.
//   [FROZEN]  = un-retrofittable; [DEFERRED] = v2 fills this seam.
//
// HONEST ENFORCEMENT FRAMING (mirrors spec §7): in v1 ALL contributions are
// first-party, trusted, compiled-in. `dataDeps`/`actions` are DECLARATION +
// CONVENTION, host-checked at the broker, NOT a hard sandbox. The typed
// allowlists become *enforced* only when the v2 WASM loader admits untrusted
// guests. Do not oversell the v1 boundary as a security control.
//
// House style: every type/field cites docs/EXTENSIONS_SPEC.md §N / issue #NNN.
// Forward-compat fields are declared now (spec §13) but not all consumed in v1
// — the TS analog of descriptor.rs's `#![allow(dead_code)]` + doc note. Do not
// trim the schema; it is the one un-retrofittable surface (E4).
// ============================================================================

import type { ComponentType, ReactElement, ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────
// 0. ABI gate — forward seam for the v2 Native | Wasm loader (§13 L183, E5)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] Single source of truth (mirrors CONNECTOR_ABI_VERSION). Bump when
 *  the contribution/dispatch contract changes in a way a v2 (WASM) guest must
 *  check at load time. The gate lives in `SlotRegistry.register`. */
export const VIEW_ABI_VERSION = 1 as const;

/** [FROZEN] Whether the host can speak a contribution's declared abiVersion.
 *  v1 supports exactly one ABI; v2 widens this to `min <= v && v <= max` — same
 *  seam, stricter failure. Mirrors connectors' is_abi_compatible. */
export function isViewAbiCompatible(abiVersion: number): boolean {
  return abiVersion === VIEW_ABI_VERSION;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Slots — v1 surface is EXACTLY two (§6 L84, E10 L157)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] The two v1 slots — "the two pure wins". `settings.panel` is DROPPED
 *  (it would hide readiness-coordination state, E10). The Map is NOT a slot
 *  host (E9): buildGraph is a global constraint solver; if it ever joins it
 *  needs a SEPARATE subgraph→coordinator contract, never a widget-style slot.
 *  Adding slots later is ADDITIVE (the union widens); these two names are
 *  stable. `slot` is a MOUNT-POINT LABEL, not a dispatch axis — the analog of
 *  the connector descriptor's `kind`. How a view DRAWS is decided by
 *  `renderer`, never by matching on `slot`. */
export type ViewSlot = "nav.section" | "dashboard.widget";

// ─────────────────────────────────────────────────────────────────────────
// 2. Serializable value — the type-level §13-L188 guarantee
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] The ONLY data shape that may cross the view boundary. PLAIN
 *  JSON-serializable — NO functions, class instances, Dates, Promises, or
 *  React nodes — so the identical payload crosses the v2 WASM boundary
 *  unchanged. A recursive type, NOT `unknown`: serializability is enforced at
 *  the type level, not on an honor system (this is the load-bearing §13-L188
 *  invariant — without it a live closure can leak across the boundary and only
 *  fail at v2 WASM-lowering runtime).
 *
 *  `number` is FINITE-ONLY: `NaN` / `±Infinity` are not stable JSON
 *  (`JSON.stringify(NaN) === "null"`), so they would NOT cross the v2/WASM wire
 *  as the identical data this contract promises (Codex P2, #187). TypeScript's
 *  `number` cannot express finiteness, so `isSerializableValue` (below) is the
 *  runtime guard the host applies at the boundary (the "honest enforcement
 *  framing" again: the type DECLARES, the broker ENFORCES). */
export type SerializedValue =
  | string
  | number
  | boolean
  | null
  | readonly SerializedValue[]
  | { readonly [key: string]: SerializedValue };

export type SerializedProps = Readonly<Record<string, SerializedValue>>;

/** [FROZEN] Runtime guard for the serialized boundary (Codex P2, #187). The
 *  `SerializedValue` TYPE cannot exclude non-finite numbers, symbol keys, or
 *  closures, and structural types cannot prove acyclicity — so the host runs
 *  this on host-fed props (#183) and dispatched intent args (#182) at the
 *  boundary, rejecting any value that would not cross the v2/WASM wire as the
 *  IDENTICAL payload the contract promises. It FAILS CLOSED: anything JSON
 *  would rewrite, drop, or choke on is rejected (the host serializer in #183
 *  decides how to handle a rejection — reject vs normalize). */
export function isSerializableValue(value: unknown): value is SerializedValue {
  return isSerializable(value, new WeakSet<object>());
}

/** Recursive worker for {@link isSerializableValue}. `seen` tracks the current
 *  DFS path, so a true CYCLE fails closed while a shared *acyclic* reference is
 *  still allowed (JSON duplicates those). */
function isSerializable(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value); // NaN / ±Infinity JSON-coerce to null
    case "object": {
      const obj = value as object;
      if (seen.has(obj)) return false; // circular reference on this path
      seen.add(obj);
      try {
        if (Array.isArray(obj)) {
          for (let i = 0; i < obj.length; i++) {
            if (!(i in obj)) return false; // sparse hole -> JSON null
            if (!isSerializable(obj[i], seen)) return false;
          }
          return true;
        }
        // Only a plain object literal (or null-prototype bag) — reject Date,
        // Map/Set, class instances: JSON rewrites or strips their semantics.
        const proto = Object.getPrototypeOf(obj);
        if (proto !== Object.prototype && proto !== null) return false;
        // Reflect.ownKeys sees symbol + non-enumerable keys that Object.values
        // skips; reject any non-string key, non-enumerable prop, or accessor
        // (a getter is not plain data and may run code / be dropped by JSON).
        for (const key of Reflect.ownKeys(obj)) {
          if (typeof key === "symbol") return false;
          const desc = Object.getOwnPropertyDescriptor(obj, key);
          if (!desc || !desc.enumerable || !("value" in desc)) return false;
          if (!isSerializable(desc.value, seen)) return false;
        }
        return true;
      } finally {
        seen.delete(obj);
      }
    }
    default:
      return false; // function | undefined | symbol | bigint
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3. data_deps (read capability) + action handles — STRUCTURED records (E4)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] A declared READ dependency — the View analog of a connector's
 *  enforced `permissions.network` allowlist (E4: "the descriptor schema is the
 *  one thing un-retrofittable without breaking every extension"). STRUCTURED
 *  record `{ id }`, NOT a host-baked string union: a future/3rd-party extension
 *  (e.g. Vault, 0.7.0) can declare a new dep WITHOUT editing a host enum —
 *  which is exactly the schema-break E4 warns against. The host owns a
 *  whitelist of known source ids (the registry-get-is-the-gate pattern,
 *  ⟂ ProviderId): an unregistered id is rejected before any fetch. The host
 *  fetches each dep and feeds the SERIALIZED result into
 *  `ViewRenderProps.data[id]`. The view NEVER fetches itself (§6 L88). */
export interface ViewDataDep {
  /** [FROZEN] Stable host-known data-source id, e.g. "list_subscriptions". The
   *  key under which the serialized result appears in `ViewRenderProps.data`. */
  readonly id: string;
}

/** [FROZEN] A declared ACTION HANDLE — the side-effecting host callback a view
 *  may invoke. STRUCTURED record (same retrofit-safe reasoning as ViewDataDep).
 *  REPLACES the unenforceable "read-only invariant" (§6 L86, §13 L185): a
 *  view's effects are an explicit, host-injected, v2-enforceable allowlist,
 *  mirroring a connector's egress allowlist. Matches today's onNavigate /
 *  onToggle* / onReset* prop pattern. keys/fs/net NEVER enter handlers
 *  (§13 L185 — the invariant carried over from the 0.4.0 Connector Foundation). */
export interface ViewActionHandle {
  /** [FROZEN] Stable handle id, e.g. "navigate". Also the `ViewIntent.action`
   *  value a declarative schema dispatches against. */
  readonly id: string;
}

// NOTE (YAGNI graft from Design 3): Design 2's speculative `ViewDataDep.as?`,
// `required?`, and `ViewActionHandle.action` indirection are DROPPED — recon
// shows NO v1 view needs them. The structured `{ id }` shape (the retrofit-safe
// part) is kept; the speculative fields are not. Re-add additively if a real
// view ever needs key-aliasing or an action-name indirection.

// ─────────────────────────────────────────────────────────────────────────
// 4. Host-fed serialized props + broker context (the §6-L88 data inversion)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] What a React-mode contribution component receives. The single most
 *  load-bearing forward-compat decision (§6 L88, "critical"): views STOP
 *  self-fetching — the host resolves every declared `dataDeps`, fetches it, and
 *  passes the SERIALIZED result here, plus a brokered effect context. Without
 *  this inversion the registry is "just a component portal" and the v2
 *  declarative renderer becomes a rewrite, not an add-on. */
export interface ViewRenderProps {
  /** [FROZEN] Host-fetched serialized data, keyed by declared `dataDeps[].id`.
   *  Always serializable so the v2 declarative arm consumes the SAME inputs. */
  readonly data: SerializedProps;
  /** [FROZEN] Brokered side-effect surface — the ONLY channel for effects
   *  (the ConnectorCtx analog). v1 binds React closures; v2 lowers the SAME
   *  call shapes to host-dispatched intents for the WASM/declarative arms. */
  readonly ctx: ViewContext;
}

/** [FROZEN] Brokered side-effect surface handed to a contribution. Looks up a
 *  declared handle by id and dispatches it. HONEST FRAMING: in v1 the host
 *  checks the id against the contribution's declared `actions` at runtime
 *  (warn + no-op on undeclared) — declaration + convention, not a sandbox.
 *  Additive-growth only (new methods, never changed signatures) so transport /
 *  cancel features land without breaking call sites. */
export interface ViewContext {
  /** [FROZEN] Invoke a declared action handle. `args` MUST be SerializedValue so
   *  the call shape ports unchanged to the v2 host-dispatch / WASM arm.
   *  Returns void in v1; cooperative progress for long work arrives additively
   *  (never as a returned closure / dropped future). */
  dispatch(handleId: string, args?: SerializedValue): void;
  /** [FROZEN] Cooperative cancel token for handles that trigger work (§13 L189):
   *  a broker-ISSUED token, NEVER a dropped future ("future-drop does not port
   *  to WASM"). Advisory in v1 — present so a v1 widget that triggers work has a
   *  cancel shape to grow into without a contract edit. */
  readonly signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Declarative renderer: FROZEN ViewSchema + palette (§6 L90) — v2 interprets
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] The four palette names. Frozen literal surface even though NOTHING
 *  interprets them in v1; the v2 interpreter maps each to a fixed host renderer.
 *  A fifth palette later is ADDITIVE (the union widens). */
export type ViewPalette = "stat-hero" | "table" | "chart" | "list";

/** [FROZEN] A declared interaction. NO live callbacks EVER in declarative props
 *  (§6 L90, §13 L188) — interactions are inert {action, target} DATA the host
 *  dispatches against declared `actions`. `action` is a `ViewActionHandle.id`;
 *  `target` is a serializable selector/payload. */
export interface ViewIntent {
  readonly action: string;
  readonly target?: SerializedValue;
}

/** [FROZEN] One node in a declarative view tree. `props` are inert serialized
 *  data; `on` maps event names to declared intents (no closures); `children`
 *  nest. `#[non_exhaustive]`-equivalent: v1 consumers must treat unknown future
 *  fields as additive (do NOT exhaustively destructure). */
export interface ViewSchemaNode {
  readonly palette: ViewPalette;
  readonly props?: SerializedProps;
  readonly on?: Readonly<Record<string, ViewIntent>>;
  readonly children?: readonly ViewSchemaNode[];
}

/** [FROZEN] The frozen declarative view document. `schemaVersion` is the
 *  per-schema escape hatch that evolves the v2 interpreter's node grammar
 *  WITHOUT touching `VIEW_ABI_VERSION` — decoupled DELIBERATELY (welding them,
 *  as Design 1 did, would force an ABI bump that invalidates every react-mode
 *  contribution whenever the palette grows). v1 writes `1`; v1 ships NO
 *  interpreter. */
export interface ViewSchema {
  readonly schemaVersion: 1;
  readonly root: ViewSchemaNode;
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Renderer discriminated union (FROZEN shape, react-only impl in v1; §6 L90)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] React-arm renderer. The component is a plain in-binary reference;
 *  it NEVER appears in the serializable `ViewInfo` projection. */
export interface ReactRenderer {
  readonly mode: "react";
  readonly component: ComponentType<ViewRenderProps>;
}

/** [FROZEN] Declarative-arm renderer. The schema is FROZEN now; the interpreter
 *  that consumes it is [DEFERRED] to v2 (§6 L90, §12 L177). */
export interface DeclarativeRenderer {
  readonly mode: "declarative";
  readonly schema: ViewSchema;
}

/** [FROZEN] The union shape exists now even though only the React arm is
 *  implemented in v1. A SINGLE host resolver (§8) is the ONLY consumer that
 *  branches on `mode` — every other call site is mode-agnostic, which is what
 *  lets v2 add the declarative interpreter with zero consumer churn. */
export type ViewRenderer = ReactRenderer | DeclarativeRenderer;

// ─────────────────────────────────────────────────────────────────────────
// 7. ViewContribution — the in-binary descriptor (mirrors ConnectorDescriptor)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] In-app manifest describing one view contribution. The descriptor
 *  FIELD SET and shape are the un-retrofittable part (E4); concrete encodings
 *  of `title`/`icon`/`order` are [V1-IMPL]. */
export interface ViewContribution {
  /** [FROZEN] Stable id, UNIQUE WITHIN A SLOT (see SlotRegistry identity model).
   *  The node-id namespace root for any nodes this contribution emits:
   *  `${id}:${localId}` via `namespaceNodeId`. GRAMMAR: MUST NOT contain the
   *  reserved `:` delimiter — that keeps namespaced node ids injective and is
   *  enforced by `namespaceNodeId` (Codex P2, #187). */
  readonly id: string;
  /** [FROZEN] Mount point. Names WHERE it draws; `renderer` (NOT slot) decides
   *  HOW — exactly as connector `kind` is a label, not a dispatch axis. */
  readonly slot: ViewSlot;
  /** [FROZEN] UI label (nav text / widget title). */
  readonly title: string;
  /** [V1-IMPL] Icon KEY into the host's static icon map (recon §1 ICONS).
   *  A key, not a ReactElement — so the descriptor survives the ViewInfo / v2
   *  WASM projection (a raw React node could not cross the boundary). */
  readonly icon?: string;
  /** [FROZEN] Sort weight within the slot; deterministic tiebreak = registration
   *  index (rule lives in the registry, §6 L94). */
  readonly order: number;
  /** [FROZEN] Load-time compatibility gate; checked vs VIEW_ABI_VERSION at
   *  register() (E5, §13 L183). Forward seam for the v2 Native | Wasm loader. */
  readonly abiVersion: number;
  /** [FROZEN] How it draws. The single resolver consumes it (§8). */
  readonly renderer: ViewRenderer;
  /** [FROZEN] Declared read capability — host fetches → serialized props (§6 L88).
   *  Empty array = no data needed (a dep not declared is never fetched). */
  readonly dataDeps: readonly ViewDataDep[];
  /** [FROZEN] Declared side-effecting handles the view may invoke (§6 L86,
   *  §13 L185). Empty array = a pure presentational view. */
  readonly actions: readonly ViewActionHandle[];

  // Deliberate omissions (documented per descriptor.rs house style):
  //   - NO self-fetch hook / live data on the descriptor: data is host-fed at
  //     render (§6 L88), never baked into the manifest.
  //   - NO `enabled`/`available` flag: a coming-soon view is simply NOT
  //     registered (registry-get-is-the-gate). (Connectors put `available` on
  //     the capability; a View has no coming-soon-but-registered state in v1.)
  //   - NO per-view ad-hoc prop signature: the non-uniform App.tsx props
  //     (onNavigate / 5-prop settings bundle / nothing) collapse into the
  //     two-channel `data` + `ctx.dispatch(actions)` model.
}

// ─────────────────────────────────────────────────────────────────────────
// 8. resolveRenderer — the SINGLE host-side resolution path (§6 L90)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] Named host error the v1 `resolveRenderer` throws on the
 *  not-yet-implemented "declarative" arm. A NAMED type (not a bare Error) so
 *  the per-contribution error boundary can switch on it for diagnostics. */
export class ViewRendererNotImplemented extends Error {
  constructor(mode: ViewRenderer["mode"]) {
    super(`view renderer mode "${mode}" is not implemented until v2`);
    this.name = "ViewRendererNotImplemented";
  }
}

/** [FROZEN] The ONLY renderer-resolution path. Consumers call this and NEVER
 *  branch on `renderer.mode`. v1 implements "react" and THROWS
 *  `ViewRendererNotImplemented` on "declarative"; v2 fills the declarative arm
 *  IN PLACE — no signature change, no consumer change.
 *
 *  SIGNATURE NOTE (FROZEN deviation from spec §6-L90 text, see ADR): the spec
 *  text wrote `resolveRenderer(contribution) -> ReactElement`. The host-fed
 *  data inversion (§6 L88) FORCES the props in, so the frozen signature is
 *  `(contribution, props)`. The single-branch-site invariant is preserved. The
 *  spec §6 text is reconciled to this BEFORE freeze.
 *
 *  The per-contribution error boundary (§9) wraps the RETURNED element at the
 *  call site (so the boundary owns the contribution id), not inside this fn. */
export type ResolveRenderer = (
  contribution: ViewContribution,
  props: ViewRenderProps,
) => ReactElement;

// v1 reference shape (design intent, not an edit):
//   const resolveRenderer: ResolveRenderer = (c, props) => {
//     switch (c.renderer.mode) {
//       case "react":       return <c.renderer.component {...props} />;
//       case "declarative": throw new ViewRendererNotImplemented("declarative");
//       default:            return assertNever(c.renderer);
//     }
//   };

// ─────────────────────────────────────────────────────────────────────────
// 9. SlotRegistry — deterministic, "specify before build" (§6 L94)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] Typed outcome of a register() call — explicit reason, never silent
 *  (graft from Design 1). Lets the dev warning / error boundary distinguish
 *  an ABI reject from a duplicate-id reject. */
export type RegisterResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "abi" | "duplicate-id" };

export interface SlotRegistryOptions {
  /** [V1-IMPL] Injected so registration warnings are testable; default
   *  console.warn. */
  readonly warn?: (message: string) => void;
}

/** [FROZEN] Registry SEMANTICS (internal storage map-vs-array is [V1-IMPL]):
 *   1. IDENTITY MODEL: an id is unique PER SLOT (NOT globally). Lookup is
 *      `get(slot, id)`. This is a DELIBERATE divergence from the shipped
 *      Connector `get(id)` (which dedups globally): §6 L94 says
 *      "dup-`id`-in-slot", and Views legitimately have two slots that may share
 *      an id (e.g. a "dashboard" nav.section AND a "dashboard" widget). Frozen
 *      now — it is the registry's identity model (see ADR + judge gap #1).
 *   2. ORDER: list(slot) is sorted by `order` ASC, then registration index
 *      (deterministic, observable contract).
 *   3. DUPLICATE id WITHIN A SLOT → reject + warn (NOT silent last-wins);
 *      returns { ok:false, reason:"duplicate-id" }. The same id in a DIFFERENT
 *      slot is allowed.
 *   4. ABI gate at register() (the connector `debug_assert!` analog) → reject +
 *      warn; returns { ok:false, reason:"abi" }. Panic-free (the right idiom for
 *      a browser host); hardens to a hard runtime reject in v2.
 *   5. Per-contribution error boundary on render (§9 wrapper below).
 *   6. Node-id namespacing helper `${sourceId}:${localId}` (below). */
export interface SlotRegistry {
  /** [FROZEN] Register one contribution. Enforces the ABI gate and the
   *  per-slot duplicate-id policy; returns a typed RegisterResult; never throws
   *  in release. */
  register(contribution: ViewContribution): RegisterResult;

  /** [FROZEN] Per-slot lookup IS the whitelist gate: an (slot, id) pair not
   *  registered is rejected before any data fetch or render. `undefined` =
   *  unknown. */
  get(slot: ViewSlot, id: string): ViewContribution | undefined;

  /** [FROZEN] Contributions for a slot, in deterministic order (order ASC, then
   *  registration index). Stable across runs. */
  list(slot: ViewSlot): readonly ViewContribution[];

  /** [FROZEN] Serializable projection of every contribution, slot-grouped,
   *  deterministic order — the `list_views()` source. */
  describe(): readonly ViewInfo[];
}

/** [FROZEN] Build the registry of all built-in view contributions — the
 *  `spend_connector_registry()` analog: ONE builder fn assembles all built-ins;
 *  a test pins the exact ordered id list PER SLOT (the
 *  `descriptor_listing_is_deterministic` analog). v1 BUILT-INS (recon §1/§3):
 *    nav.section (recon nav order): dashboard, map, spend, subscriptions, docker
 *    dashboard.widget: spend-summary, subscriptions-summary
 *  `settings` STAYS a footer special-case OUTSIDE the slot system in v1 (recon
 *  §1; settings.panel dropped per E10) — it is NOT registered. */
export type BuildViewRegistry = (options?: SlotRegistryOptions) => SlotRegistry;

// ─────────────────────────────────────────────────────────────────────────
// 10. Node-id namespacing — protects mapLayout persistence (§6 L94, §13 L190)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] Namespaces a contribution-emitted node id as `${sourceId}:${localId}`.
 *  REQUIRED to protect mapLayout persistence: the Map's bare `provider:` /
 *  `product:` / `subscription:` node ids AND their `layoutKey`s
 *  (buildGraph ↔ mapLayout, a CLOSED pair) MUST reach localStorage
 *  BYTE-IDENTICAL — loadMapLayout() does NO migration, so any id change SILENTLY
 *  orphans every saved layout (recon §4).
 *
 *  The Map is NOT a slot host (§1, E9), and is the IDENTITY CASE: its source
 *  passes its ids through UNCHANGED (graft from Design 3 — its sourceId-
 *  equivalent is the empty/identity case; an implementer must NOT prefix map
 *  ids). This helper namespaces nodes emitted by NEW slot surfaces only
 *  (dashboard.widget / declarative nodes).
 *
 *  ENFORCEMENT (judge gap #2 — the helper alone discharges nothing): the v1
 *  call-site obligation is a registry CONVENTION + a test that a
 *  dashboard.widget cannot emit a bare `provider:`/`product:`/`subscription:`
 *  id (every widget node id MUST be `${contribution.id}:${localId}`). Since no
 *  v1 dashboard.widget emits persisted nodes, this is enforced by test fixture,
 *  not yet by a live consumer — flagged so the helper is not a latent no-op. */
export function namespaceNodeId(sourceId: string, localId: string): string {
  // INJECTIVITY (Codex P2, #187): `:` is the RESERVED delimiter, so `sourceId`
  // (a contribution id) MUST NOT contain it — else namespaceNodeId("a:b","c")
  // and namespaceNodeId("a","b:c") both yield "a:b:c" and two widgets collide
  // on persisted node ids. `localId` MAY contain `:` (the Map's hierarchical
  // ids do, e.g. "product:anthropic:claude-ai") and stays unambiguous because
  // the FIRST `:` always delimits sourceId. This is the persistence-key format,
  // so the constraint is part of the frozen ViewContribution.id grammar.
  if (sourceId.includes(":")) {
    throw new Error(
      `namespaceNodeId: sourceId must not contain the reserved ':' delimiter (got ${JSON.stringify(sourceId)})`,
    );
  }
  return `${sourceId}:${localId}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 11. Per-contribution error boundary (isolation guarantee — §6 L94)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] One widget/nav crash must NOT kill the dashboard or sidebar. The
 *  host wraps every resolveRenderer output in this boundary; it owns the
 *  contribution id for diagnostics and can switch on ViewRendererNotImplemented
 *  (§8). */
export interface ViewErrorBoundaryProps {
  readonly contributionId: string;
  readonly children: ReactNode;
  /** [V1-IMPL] Optional host fallback; defaults to an inert "unavailable" card
   *  so the surrounding slot keeps rendering. */
  readonly fallback?: ReactElement;
}

// ─────────────────────────────────────────────────────────────────────────
// 12. Serializable projection — `list_views()` return (mirrors ConnectorInfo)
// ─────────────────────────────────────────────────────────────────────────

/** [FROZEN] Wire projection of a ViewContribution: identity + declared
 *  capabilities MINUS the in-binary renderer.component / schema. The renderer
 *  reduces to its `mode` tag (a guest knows HOW a view draws without receiving
 *  the closure). camelCase is native in TS; if Views ever grow a Rust mirror,
 *  pin it with a `view_info_serializes_camel_case` test (the
 *  ConnectorInfo `connector_info_serializes_camel_case` analog). */
export interface ViewInfo {
  readonly id: string;
  readonly slot: ViewSlot;
  readonly title: string;
  readonly icon?: string;
  readonly order: number;
  readonly abiVersion: number;
  /** "react" | "declarative" — tag only; no component/schema body crosses. */
  readonly rendererMode: ViewRenderer["mode"];
  readonly dataDeps: readonly ViewDataDep[];
  readonly actions: readonly ViewActionHandle[];
}

/** [FROZEN] Concrete projection fn (graft from Design 1 — a real exported fn,
 *  not just a referenced future Rust type). The `list_views()` body. */
export function toViewInfo(c: ViewContribution): ViewInfo {
  return {
    id: c.id,
    slot: c.slot,
    title: c.title,
    icon: c.icon,
    order: c.order,
    abiVersion: c.abiVersion,
    rendererMode: c.renderer.mode,
    dataDeps: c.dataDeps,
    actions: c.actions,
  };
}
