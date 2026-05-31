# Stashpeak Extensions — Design Spec (Connector / View / Action)

**Status:** Design locked — ready for phased implementation (no code yet)
**Created:** 2026-05-31
**Supersedes (as the decision doc):** `docs/EXTENSIONS_BRAINSTORM.md` (that file was pre-spec; this resolves its 10 open questions)
**Strategy source of truth:** KB `Projects/Stashpeak/2026-05-31 — Stashpeak Premium Plan & Architecture.md`
**Decision-log home:** condensed entries to propagate into `internal-docs/stashpeak-app/ARCHITECTURE.md §8`

---

## 0. Provenance (how this spec was produced)

Brainstorming session 2026-05-31, grounded in the locked strategy + a full structural map of the current codebase (v0.2.4). Each of the three contracts and the rollout roadmap were put through **adversarial Opus review panels — 9 reviews total** (3 per contract, 3 on the roadmap), each grounded in the real code.

- All three contracts came back **GO-WITH-CHANGES**; every correction is folded into §5–§7.
- The roadmap review split: 2× GO-WITH-CHANGES on execution, **1× "validate first / don't build the foundation yet"** (priority/validation lens). That dissent is recorded in §11. **The founder chose to proceed with the foundation now, with corrections** — validation gate to run in parallel (see §9, §11).

---

## 1. Understanding Summary (locked)

- **What:** Stashpeak = a local-first desktop "AI command center" (Tauri 2 + React 19 + Rust + SQLite + OS keychain). A thin core + features delivered as **first-party extensions** along three contracts: **Connector / View / Action**. One product, named "Stashpeak".
- **Shipped today (v0.2.4):** spend dashboard + subscriptions + ecosystem map + settings. **Chat, KB, and Vault do not exist in code yet** — they are greenfield extensions. (The premium-plan table's "free: basic chat aggregation, basic KB" is aspirational, not current.)
- **For whom:** technically strong AI power users (prosumer); B2B/team later.
- **Platform:** core = native desktop (forced by local-first / zero-knowledge — a browser cannot read disk/Docker/keychain). Web = marketing + a future cloud dashboard (metadata-only, v0.3+). Mobile deferred.
- **Infra:** v0.1/v0.2 fully local. Supabase introduced only later as a hybrid (accounts + premium gating + state-only sync) — never secrets, never content.
- **Extension model scope:** **internal-first, forward-compatible** — first-party compiled-in now; v2 (WASM/Extism sandbox + code signing + marketplace) bolts on later **without an API rewrite**.
- **Vault = flagship extension:** "own your AI context" = portability + control + KB-as-context. Chat = an optional later "+" extension that *consumes* the context layer, never the core/moat.
- **Monetization:** premium = always NEW functionality, never paywalls existing. Validate (5 DMs → fake-door + Stripe) before any premium build; first premium feature after GO = spend forecasting + budget alerts.

## 2. Assumptions

- **A1:** Core stays desktop-only; web-app-as-product and mobile are explicit non-goals *for now*.
- **A2:** This architectural rework is internal plumbing — it adds no premium capability and touches no cloud secrets, so it is not itself blocked by the premium-validation gate (but see §11 — a review argues it should be).
- **A3:** Chat is low-priority; built after the context/portability layer, if at all.
- **A4:** Vault sync (when it exists) preserves zero-knowledge via Git-sync or E2E — never plaintext content in the cloud.

## 3. Scope decision

**Internal-first, forward-compatible.** v1 = first-party extensions compiled into the binary/bundle. v2 = community extensions in a WASM/Extism sandbox via a signed registry/marketplace, permissions approved at install. The promise: same `Descriptor` + `Registry` + capability enforcement; only the dispatch backend changes (`Native` handler → `Wasm` host-call). Consistent with locked Decision #8 (`ARCHITECTURE.md`).

## 4. The unifying principle (the one idea behind every correction)

> **An extension never touches resources directly. All I/O goes through the host (a broker), which grants only what the extension declared.**

- **Connector:** the host holds the key and makes the API call; the connector asks via a capability context and gets only the result. The key never enters the connector.
- **View:** the host fetches data (per the view's declared deps) and hands it to the view as already-serialized data; the view does not self-fetch.
- **Action:** the host writes files / calls the LLM / reads connectors on the action's behalf, enforcing the action's declared `effects`.

Why it matters: it is **cheap in v1** (the broker *is* the enforcement point we need anyway), it is the **forward-compat seam** (v2 WASM is a tightening of an existing boundary, not a new one), and it **closes a live secret leak** today (see §9 pull-forward).

---

## 5. Connector contract (revised)

**Problem today:** adding a connector edits 4 places — the `match` in `lib.rs:~237`, the `ProviderId` enum (`providers.rs`), static `SPEND_PROVIDERS` (`spendProviders.ts`), static `PRODUCT_CATALOG` (`products.ts`).

**`ConnectorDescriptor`** (in-code manifest; the in-binary projection of `ARCHITECTURE.md §4`'s manifest — descriptor is the single source of truth, the YAML sketch should be regenerated from it):
- `id`, `display_name`
- `kind: String` — a **label only**, not a dispatch axis (capability is expressed by the trait)
- `abi_version`
- `permissions { network: [host(+port/path)], storage: [scope] }` — a real capability manifest, declared now
- `credential_schema` — **composite-capable** (n input fields → one keychain blob; models GCP's `{service_account_key, project_id, dataset_id, table_name}`)
- `available` / `coming_soon` flag (Groq depends on this today)
- **No `products[]`** — products are a frontend/map taxonomy, not 1:1 with connectors (Anthropic = 3 products / 1 connector) and are user-mutable (`product_visibility`); keep the product catalog separate.

**`ConnectorRegistry`** (per capability, e.g. `SpendConnectorRegistry`): `register(descriptor, factory)`, `get(id)`, `list()`. `list_by_kind` deferred until a 2nd kind exists. **The registry is the new whitelist gate** — an `id` not registered is rejected before any keychain/network I/O (this *moves*, does not delete, the `ProviderId::parse` security boundary).

**Host-brokered fetch (the key change):** the trait gains a capability context — `fetch(&self, ctx: &ConnectorCtx)`. The connector **never receives the raw secret**. Instead `ctx` exposes **brokered operations**: the connector builds a request and the host attaches the credential and performs egress (`ctx.send(request)` → response), and where the connector must sign (e.g. GCP's service-account JWT) the host signs on its behalf (`ctx.sign(...)`). The credential is referenced only by an **opaque, identity-bound handle** (scoped to the descriptor `id`, not a string the connector chooses) that the connector may pass to `ctx` operations but can never read. **The raw key never enters the connector body** — which is exactly what makes the future `Native | Wasm` boundary safe (a WASM guest holds no secret). `secrets::get_provider_api_key` becomes crate-private; all egress flows through `connectors::http` as the sole broker, checked against `permissions.network` (advisory-logged in v1, enforced in v2).

**Multi-step invocation:** the serializable invocation is a **re-entrant host-call loop** (request → host returns bytes → next request …), not one-shot — required by GCP's OAuth→BigQuery chain. Decide where JWT signing lives (host-side preferred so the private key never transits the connector). Retry (`with_retry`) wraps the **host I/O step**, not the parse step; the host maps HTTP-status → `ConnectorError`.

**Migration (strangler, must be behavior-preserving — guarded by tests):**
- Keep connector `id`s stable (`provider_spend` rows are PK'd on them).
- Do **not** reshape the GCP keychain blob; keep `logging::remember_secret(private_key)` firing (else log-scrub regresses).
- Preserve the enabled-gate location and the dual whitelist.
- **Keep the frontend on static `SPEND_PROVIDERS` during the strangler**; expose `list_connectors()` as an *additive* command and migrate the frontend list source in a **separate later step**.
- Add **per-connector parity tests** (identical `SpendData`/`ConnectorError` pre/post inversion) — see §9 harness.

## 6. View contract (revised)

**Problem today:** hardcoded view-switch in `App.tsx:~194`; `DashboardView` hardcodes its widgets; `buildGraph()` is a monolithic global layout solver.

**Slots (v1 — only the pure wins):** `nav.section`, `dashboard.widget`. **`settings.panel` dropped from v1** (it hides readiness-coordination state). **The map is NOT a slot host** (see below).

**`ViewContribution`:** `id`, `slot`, `title`/`icon`, `order`, `abi_version`, `renderer`, `data_deps` (declared read capability) + declared **action handles** (the side-effecting callbacks it may invoke — replaces the unenforceable "read-only invariant"; matches today's `onToggle*`/`onReset*` pattern, host-injected, v2-enforceable).

**Host-fed data (critical):** views **stop self-fetching** (today `DashboardView` calls `listSubscriptions()` in its own effect). The host fetches per `data_deps` and passes **serialized props**. Without this, a SlotRegistry is just a component portal and the v2 declarative renderer would be a rewrite, not an add-on.

**`renderer` = discriminated union** `{ mode: "react"; component } | { mode: "declarative"; schema }`, resolved by a single host-side `resolveRenderer(contribution) → ReactElement` so **consumers stay agnostic** (no per-site branching). v1 implements `"react"` only; the `ViewSchema` type + palette names (`stat-hero`, `table`, `chart`, `list`) are **frozen now**, the interpreter is built in v2. Declarative props are pure serializable data — **no live callbacks** (declarative interactions = declared intents `{action, target}` dispatched by the host).

**The map is a first-party-React surface — do not pretend it is sandboxable.** `buildGraph()` is a global constraint solver (column X accumulates across all providers; cross-source counts; `layoutKey`s encode global structure; edges are relational across sources). A per-contributor "node-source" **cannot self-place its nodes**. If the map ever joins the contribution model it needs a **separate "subgraph → central layout/edge coordinator" contract** (sources emit node/edge *intents* into a shared build context; a layout pass runs after all sources), and at most a "declarative node *data* → fixed host node palette" tier — never arbitrary community node renderers. **Map decomposition is parked** (conditional, after the layout-heavy features land, behind the test harness).

**Registry semantics (specify before build):** deterministic order tiebreak (`order`, then registration index); dup-`id`-in-slot = reject + warn; **per-contribution error boundary** (one widget crash must not kill the dashboard); **node-id namespacing** (`${sourceId}:${localId}`) to protect `mapLayout` persistence.

## 7. Action contract (revised)

**Guiding principle:** an Action never touches disk / network / secrets directly — everything goes through `ActionContext`, which the host checks against the declared `effects`.

**Types (v1, YAGNI):** rules-based (deterministic IO, no LLM) and LLM (BYOK call). Connector-chain / if-then workflow engine **deferred** (`data_deps` is read-only, unordered — explicitly *not* an orchestrator). Trigger v1 = **sync + progress + cancel** only (async/background and scheduled deferred — scheduled later reuses the 30-min notification scheduler).

**`ActionDescriptor`:** `id`, `label`, `icon`, `abi_version`, `kind` (rules|llm — **UX hint only; `effects` is authoritative**), `data_deps`, **`effects`** = capability manifest `{ net: [hosts], llm: {budget, providers}, file_write: [named_scope], secrets: [read:provider] }`. `cost_estimate` is **computed at confirm-time** from actual input size × model rate — not a static field.

**`ActionContext` (broker):** `read_connector()`, `llm_call(intent) → completion` (**host resolves the key and makes the call; key never enters the handler**), `write_file(scope-relative)` (host canonicalizes + containment-checks + no-follow + re-validates at open), `report_progress()`, `is_cancelled()` (**cooperative polling**, not future-drop — future-drop does not port to WASM). Handlers may not import `std::fs` / `reqwest` / `secrets`. Inputs/outputs are `Serialize`/`Deserialize`; no live handles (`AppHandle`, DB conn) in the signature.

**Honest enforcement framing:** in v1, native (Rust/TS) handlers are *trusted* and compiled in — they retain ambient access to `std::fs` / `reqwest` / `secrets`, so `effects` is a **declaration + convention + code-review boundary, not a hard sandbox**: handlers are *expected* to use only the `ActionContext` broker, but nothing physically prevents bypass yet. Optional v1 hardening: put handlers in a separate crate that exposes only the broker API, and/or a lint forbidding direct `std::fs` / `reqwest` / `secrets` imports in handler modules. The broker becomes a **hard enforcement boundary only at v2/WASM**, where the guest has no other reach. The descriptor schema (esp. `effects` naming network **hosts** + read/write scopes) must still be complete **now** — it is the one thing that cannot change without breaking every extension.

**Cost ledger (corrected):** a **separate `action_runs` table** (`id, action_id, extension_id, kind, provider, model, est_cost_usd, actual_cost_usd, status, started_at, finished_at`) — **never merged into `provider_spend*`** (the spend dashboard is provider-billing-derived; merging double-counts). Surface as a distinct **"Activity / what the app spent on your key"** panel — framed as a trust feature. New table + migration + broker write-path is an explicit deliverable.

**Zero-knowledge / egress:** the LLM action is an **intentional, user-consented egress** to the user's own BYOK provider — distinct from Stashpeak cloud (which receives secrets/content **never**). Document this carve-out (add a THREAT_MODEL row, e.g. T11). UX has **confirm-before-spend** *and* **confirm-before-egress** ("this will send your selected context to anthropic.com"). For Vault, **redact-before-LLM is a runtime guarantee** (clean → compress ordering), not the user's responsibility.

**Also define:** the `ActionResult` return contract (where output goes), partial-failure / atomicity semantics (temp-then-rename), and LLM-action → provider/model matching (which BYOK providers do chat completions — GCP/OpenRouter are billing connectors, not necessarily chat backends).

## 8. Vault — flagship extension ("own your AI context")

Functional identity (validated against the KB research): **portability + control + KB-as-context** — deliberately **not** a multi-provider chat shell (saturated; Open WebUI 137k★). Chat is an optional later "+" extension consuming this layer.

- **Connectors (local, zero-secret):** (i) AI-export importer (ChatGPT/Claude/Gemini `.zip`/json parser — re-homes the paused Vault v0.1 scope); (ii) markdown/Obsidian folder reader (KB-as-context).
- **Views:** conversation/archive browser + search (mounts via `nav.section` + `dashboard.widget`).
- **Actions:** **free/rules-based** "Clean & Export" (PII redaction, pick conversations, export to vendor-neutral formats + local archive); **BYOK/premium** "Compress to primer" (LLM summarize/dedupe) — the first action that *truly* exercises the brokered Action contract (brokered secret + named-host egress + `action_runs` row).

**Two tensions to resolve at build time:**
1. **Mobile:** Vault's original killer (cross-device synced chat incl. mobile) cannot ship in a desktop-only Tauri app. Desktop-Vault delivers ownership/portability/control, not live mobile sync. (Mobile sync = when the app gets a mobile build, or v2.)
2. **Sync vs zero-knowledge:** "vault sync" of chat content conflicts with the metadata-only cloud invariant. Resolve via (a) E2E-encrypted sync, (b) Git-sync to the user's own repo (Vault's original free-tier model), or (c) local archive only. **Decide at v0.3, not now.**

## 9. Roadmap (corrected — milestone split, harness blocking)

**Pull-forward (do now):**
- 🔒 **Fix `get_provider_api_key` leak** — `lib.rs:52-59` clones the secret out of `Zeroizing` into a plain `String` returned to JS. Keys must be used host-side only (as the connectors already do). Standalone, security-positive, **not** blocked on the harness. Grep `src/` for residual `getProviderApiKey` callers first.
- 🧪 **Stand up the test harness** — there is **zero** JS test infra today. This is a **BLOCKING prerequisite** to the foundation (not "parallel"): vitest + jsdom + `@tauri-apps/api` invoke mock; a **golden `buildGraph` snapshot** with ~4–6 representative fixtures (multi-provider, linked/standalone subs, hidden products, stored absolute+relative layout); and **Rust connector parity tests** (extend the existing `MockStore` / `with_retry` patterns).

**0.3.0 (in flight) — map polish on the monolith:** ship the cleanly-shippable map work — #60, #33, #102, #106, #92, #105, #104, #99, #91*, #90, #108, #18. **Cap `buildGraph` investment** (every solver refinement now is re-absorbed at decomposition). Move **OUT**: #16, #88 (blocked on Docker / file-scan connectors that don't exist → post-Connector-foundation), #17, #89 (need persistence / layout-engine / harness). *Verify #91's spend-history dependency isn't a hidden blocker.

**Foundation (split into shippable milestones — each is the only new thing in its release):**
- **0.4.0 "Connector Foundation"** — host-broker inversion + descriptor/registry; migrate all 5 connectors (GCP is ~50% of the effort: multi-call + composite credential + JWT-signing decision); delete the `match`. App behaves identically; user-invisible, fully testable.
- **0.5.0 "View Slots"** — `nav.section` + `dashboard.widget` registry + the host-fed-data inversion; kill the `App.tsx` switch + `DashboardView` hardcoding. Makes Vault's views mountable. (Proves slot mounting — *not* the hard View case; the map stays parked.)
- **0.6.0 "Action Runtime"** — `ActionContext` broker, `action_runs` ledger + migration, capability-gated egress + confirm-before-egress/spend, cooperative cancellation, one dogfood rules-based action. The most under-counted subsystem; its own milestone + test surface.
- **0.7.0 "Vault"** — built as **assembly of three hardened primitives**, not co-developed with them. Importer + folder Connectors, conversation/archive View, Clean&Export + Compress-to-primer Actions. First true end-to-end test of the brokered Action contract — budget for some contract churn here.

**Later / conditional:** Docker + file-scan connectors → then #16/#88; map decomposition (subgraph→coordinator) after layout features + harness; Supabase hybrid + premium (forecasting + alerts) **gated on validation**; v2 WASM/Extism sandbox + signing + marketplace (bolts on the proven contracts).

**Validation (recommended to run in parallel):** the founder's own gate — 5 user DMs + fake-door + Stripe link; GO = ≥1 paid OR ≥30 waitlist in 2 weeks. Cheap, and a NO-GO would re-prioritize everything below 0.4.0. See §11.

## 10. Decision Log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| E1 | Extension scope = internal-first, forward-compatible | minimal internal-only / full v2 platform now | first-party value now without security-heavy platform; v2 bolts on, no API rewrite |
| E2 | Three contracts: Connector / View / Action | connectors only / collapse View+Action | clean capability tiers (read-external / read-render / write); matches threat-model partition |
| E3 | Host-brokered, capability-scoped I/O in v1 | trusted ambient access | cheap now, is the v2 seam, closes the key leak; the one principle behind all corrections |
| E4 | `effects` / `permissions` = real capability manifest **now** (network hosts + read/write scopes) | budget/`llm`-only, expand later | descriptor schema is the one thing un-retrofittable without breaking every extension |
| E5 | Descriptors carry `abi_version`; dispatch via registry with `Native\|Wasm` arms | no version / hardcoded match | additive WASM arm; load-time compatibility check |
| E6 | Drop `products[]` from ConnectorDescriptor | weld products onto connectors | products aren't 1:1 with connectors and are user-mutable; keep catalog separate |
| E7 | Action cost → separate `action_runs` ledger | merge into spend dashboard | spend is provider-billing-derived; merging double-counts; separate ledger = trust feature |
| E8 | BYOK provider = consented egress carve-out (vs Stashpeak cloud = never) | treat all egress as forbidden | resolves the literal zero-knowledge contradiction; add confirm-before-egress + T11 |
| E9 | Map is first-party-React; map decomposition parked → separate subgraph→coordinator contract | force map into the slot model now | `buildGraph` is a global solver; node-sources can't self-place; highest-risk module |
| E10 | View v1 slots = `nav.section` + `dashboard.widget` only; views host-fed | include settings/map; views self-fetch | the two pure wins; host-fed data is what makes the contract real + forward-compatible |
| E11 | Vault identity = portability + control + KB-as-context; chat = optional "+" | chat-shell core / full workspace | moat is the context layer; chat is saturated and merely consumes it |
| E12 | Split 0.4.0 into 0.4/0.5/0.6 + Vault as 0.7 | one "Extensions Foundation" milestone | it's 3 disjoint systems; each ships independently; Vault on hardened primitives |
| E13 | Test harness = blocking prerequisite; leak fix standalone now | harness parallel | the refactor's safety rests on it; zero tests exist today |
| E14 | Build foundation now, with corrections (validation in parallel) | validate-first / hybrid | founder's informed call after the dissent in §11 |

## 11. Risks & acknowledged dissent

- **Validate-first dissent (recorded, NOT adopted):** one roadmap reviewer concluded the foundation should not be built before validation — it adds zero user-facing value to a product with no validated demand, and (per the founder's own strategy) the rework exists only to enable premium/extensions, so it arguably belongs behind the same validation gate. The leaner alternative: build a **minimal Vault feature in the monolith** (import → clean → export) as both a value test and a fake-door, and refactor to the extension model only on GO. Opportunity cost: the founder's separate car-dealer SaaS is a more validated bet (6/6, 62% built). **Mitigation chosen:** proceed with the foundation, but run the validation gate **in parallel**; a NO-GO re-prioritizes everything below 0.4.0.
- **Shallow moat:** LLM cost-tracking is commoditizing (Helicone/Langfuse/Datadog) + first-party dashboard threat (OpenAI/Anthropic). The differentiator is local-first + zero-knowledge + breadth + trust.
- **Effort under-counts:** GCP connector inversion (OAuth chain + composite credential + JWT signing) and the Action runtime (broker + ledger + egress confirm + cancellation) are larger than one bullet each — hence the milestone split.
- **Half-migrated coexistence:** old + new worlds coexist during the strangler; keep each milestone independently shippable.
- **Double-work on the map:** 0.3.0 layout features (#108/#89/#90) will be partly re-absorbed by a later decomposition — accepted, capped, and the reason decomposition is parked.

## 12. Open items (deferred decisions)

- Vault sync vs zero-knowledge mechanics (Git-sync vs E2E) — decide at v0.3.
- The map "subgraph → coordinator" contract — design when/if decomposition is justified.
- JSON-schema view renderer + palette interpreter — v2.
- v2 WASM/Extism sandbox, code signing, marketplace trust/abuse model — v2.
- Community vs paid marketplace distribution — after the core validates.

## 13. Forward-compat checklist (what must be in the v1 contracts so v2 bolts on)

- [ ] `abi_version` on every Descriptor.
- [ ] Capability manifests name **network hosts** + read/write scopes (not just budgets/booleans).
- [ ] All I/O host-brokered; handlers never touch fs/net/secrets; **keys never enter handlers**.
- [ ] Dispatch via a registry with a `Native | Wasm` arm (WASM is additive).
- [ ] Connector invocation is a **serializable, multi-step** host-call loop (GCP proves re-entrancy).
- [ ] View data is **host-fed serialized props**; declarative interactions are **declared intents**, not callbacks.
- [ ] Progress/cancel are **cooperative broker calls**, not closures/future-drop.
- [ ] Node/contribution ids are **namespaced** (`${sourceId}:${localId}`).
- [ ] Secret access is **identity-bound** to the declaring extension, enforced by the registry/broker.
