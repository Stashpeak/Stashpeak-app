# Stashpeak MCP KB Contract — Design Spec (local MCP server for KB read/write)

**Status:** Design locked — ready for phased implementation (no code yet)
**Created:** 2026-06-25
**Implements:** `ARCHITECTURE.md` Decisions #27 (KB-as-context core) + #31 (agent interop / MCP write path); owns the deferred THREAT_MODEL MCP-write-server row.
**Strategy source of truth:** KB `Resources/Decisions.md` (Stashpeak strategie) + `internal-docs/stashpeak-app/ARCHITECTURE.md §8`
**Peer specs:** `docs/SYNC_ENGINE.md` (the paid sync layer this writes through to) and `docs/EXTENSIONS_SPEC.md` §7 (the Action broker whose path-safety mechanics this **extends but does not inherit** — see §0 and §8).
**Decision-log home:** condensed entries to propagate into `ARCHITECTURE.md §8` + the new THREAT_MODEL **T13** (blocking close-out — see §17)

---

## 0. Provenance (how this spec was produced)

Brainstorming session 2026-06-25, grounded in the locked KB-as-context pivot (Decisions #27–#32), the merged `SYNC_ENGINE.md` (#210), and a structural read of the existing connector/broker code (`src-tauri/src/connectors/http.rs`, `secrets.rs`) and the Action contract in `EXTENSIONS_SPEC.md §7`.

Three load-bearing product forks were resolved with the founder (see §3), then the design was hardened in a **5-lens adversarial security review** (workflow `wf_22a9b0b2`; 5 reviewers → 50 raw findings → 18 distinct → synthesis):

1. **MCP-protocol correctness** — handshake, transport, primitive choice, capability negotiation.
2. **Auth / token threat model** — the inverse-T9 identity problem on stdio.
3. **Path / filesystem security** — traversal, Windows reparse points/junctions, TOCTOU, normalization.
4. **Sync interplay / data integrity** — write races, the path⇄fileId index, conflict-copy correctness.
5. **Read egress / confidentiality + prompt injection** — KB exfiltration, malicious note content.

Coverage map = §15.

> [!IMPORTANT]
> The review **verified two load-bearing facts against the actual files** and they changed the design:
>
> 1. **MCP stdio means the client *spawns* the server as a child process — there is no running Stashpeak app on the other end of the pipe.** The first-draft layering diagram (client → in-app server → broker) describes a system stdio cannot produce. **Resolved by the spawned-shim + local-IPC topology (§4).**
> 2. **The §7 file-write broker the first draft leaned on does not exist yet.** `EXTENSIONS_SPEC.md` §7 is explicitly *trusted-first-party-handler-only* (§13 box at L198: storage/`file_write` scopes "await a storage broker"), and is **not a hard sandbox** in v1. **So this spec OWNS the KB write-path algorithm normatively (§8); it is not inherited.**
>
> The product spine the reviewers endorse — **opt-in + explicit per-client write grant + a hardened write broker + recoverable `SYNC_ENGINE` history + a (read AND write) activity ledger** — holds. No fork was killed. The corrections are to the *description and the read-side rigor*, not the product decisions.

---

## 1. Understanding summary (locked)

- **What:** a **local MCP server**, shipped inside the Stashpeak desktop app, that exposes the user's Knowledge Base (markdown files on disk — the free, local, canonical core, Decision #27) to localhost AI agents (Claude Desktop, Cursor, Hermes) as MCP **resources** (read) and **tools** (read + write). This is the "agent interop" leg of the KB-as-context pivot; it is **not** part of the sync engine (Decision #31).
- **Why it matters strategically:** it is the mechanism behind "productized Hermes" — always-on agent access to the user's own KB (Decision #32). The agent reads context from the KB and writes context back; sync (the paid layer) then carries those writes across devices.
- **Security framing:** the **inverse of THREAT_MODEL T9.** T9 = Stashpeak is a *client* of untrusted localhost apps (Obsidian REST, etc.). Here **Stashpeak is the server** and untrusted localhost MCP clients connect to read/write the KB. This spec owns the deferred MCP-write-server threat row (T13, §12).
- **Canonical data:** the same on-disk markdown files the KB connector reads and `SYNC_ENGINE` syncs. The MCP server introduces **no new storage** — it is a protocol adapter over KB read + a KB write broker.
- **No-crippleware:** the local KB is fully usable with no MCP server; enabling it adds agent reach, never unlocks an existing capability (ARCHITECTURE §1).

---

## 2. Scope

**In scope (v1.0 — ships first):**

- An MCP server reachable over **stdio** via a thin spawned **shim binary** (§4).
- **Read** of the KB: MCP **resources** (`kb://` tree) + read **tools** (`kb_search`, `kb_read_note`, `kb_list`).
- The **`resolve_readable` confidentiality gate** (default-deny `.kbignore` + per-folder exposure scope + a default-excluded secret set) on **every** read primitive (§7) — ships **with** the read tools, not after.
- The **read activity ledger** + bulk-read brake (§7).
- **Per-client token** mint / scope / revocation (§6), opt-in enablement (§11).
- The MCP **handshake + stdout discipline** + capability declaration (§5).

**In scope (designed now, ships v1.x behind the write-broker hardening — F1):**

- **Write** tools: `kb_append_note`, `kb_create_note`, `kb_write_note` (full overwrite) — all through the **owned KB write broker** (§8).
- The same-device write-serialization broker + the watcher echo-filter (§8/§9).

**Explicitly out of scope (v1 — YAGNI):**

- **Destructive delete and rename/move as MCP tools.** An agent "delete" via truncation or an agent "rename" via write-new + truncate-old churns `fileId` identity and splits history (§9). v1 exposes **no** delete/rename tool; deletion stays a human action in the app UI. A broker-mediated `kb_move` (carrying a `renameHint`, §9) is the first v1.x candidate. [review P2-14]
- **Localhost HTTP / SSE transport** — designed as a forward-compat seam (§13/§12), not shipped. No network listener exists in v1.
- **A hard sandbox around the MCP server / write handlers** — v1 handlers are trusted/compiled-in (same honesty as `EXTENSIONS_SPEC` §7); the broker is a containment + audit boundary, not a capability jail until a future WASM pass.
- **Multi-vault / selective exposure beyond folder-level `.kbignore`.**
- **Neutralizing prompt injection** in KB note content (§10) — the server *labels* injection-shaped content but does not claim to defuse it.

---

## 3. The three load-bearing forks (resolved)

Chosen by the founder during the brainstorm; they govern everything below. **All three survived the adversarial review** (no fork was killed) — only the *implementation of F2/F3* was corrected by the topology fix.

| Fork                | Decision                                                                                                                                                                | Why                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1: scope**       | **Design read+write now; ship read first; turn write on later behind a hardened KB-write broker.**                                                                     | Read is the wedge (agent access to the KB). Write is powerful but is the dangerous surface; phasing it lets the broker (§8) be hardened first without rushing it.    |
| **F2: write trust** | **Per-client grant (explicit, one-time), then trusted; every read AND write logged.**                                                                                 | Balances the always-on agent loop with safety. The grant is the consent event; the ledger (§7) is the accountability. Per-write prompts stay available as a toggle. |
| **F3: transport**   | **stdio in v1 (no network listener); localhost HTTP designed as a forward-compat seam.**                                                                              | stdio is the MCP standard (Claude Desktop, Cursor) and has no listening socket to attack. HTTP (multi-client, true shared always-on) bolts on later (§13).          |

---

## 4. Topology — the spawned shim + local IPC (the load-bearing correction)

**On MCP stdio, the client launches the server as a child process and speaks JSON-RPC over its stdin/stdout.** There is no persistent "Stashpeak app" on the other end of that pipe. Any design where the MCP server *is* the Tauri app, or where the app mints/validates a token "on the MCP session," is physically impossible on stdio. [review P0-1]

So v1 ships a **thin stand-alone shim binary, `stashpeak-mcp`**, that clients spawn:

```text
MCP client (Claude Desktop / Cursor / Hermes)
   │  stdio: JSON-RPC over stdin/stdout      (client SPAWNS this process)
   ▼
stashpeak-mcp  (thin shim binary — NO app logic, NO keychain, NO direct fs writes)
   │  local IPC: named pipe (Windows) / unix domain socket (macOS/Linux)
   │  ── this hop is the T13 trust boundary ──
   ▼
Stashpeak app (running Tauri process)
   ├── KB read layer ───────────────► vault files on disk
   ├── resolve_readable gate (§7)    Settings · OS keychain · token store
   ├── KB write broker (§8) ────────► vault files on disk
   └── read + write activity ledger (§7) · #24 lifecycle
                                          │
vault files on disk ──► folder-watcher ──► SYNC_ENGINE reconcile ──► E2EE sync
```

- **The shim contains no app logic.** It speaks MCP on one side and a minimal internal IPC protocol on the other. All security-relevant state — Settings, the OS keychain, the token store, the `resolve_readable` gate, the write broker, the activity ledger, and the Decision-#24 lifecycle — lives **in the app**, reachable only across the IPC hop. [review P0-1]
- **The shim↔app IPC hop is the real T13 trust boundary** (§12), not the MCP session. The shim is untrusted-by-construction (a client could ship its own); the app authenticates and authorizes the hop.
- **If the app is not running**, the shim cannot serve. v1 behavior: the shim returns an MCP error ("Stashpeak is not running") and does not attempt to read or write the vault itself. (Auto-launching the app from the shim is a v1.x UX question, out of scope here.)
- **The vault root is server-owned, never client-supplied.** The app holds the configured vault path; the shim and the MCP client can never widen it (MCP `roots`, if honored at all, are advisory display only). [review P2 — roots]

---

## 5. Transport & MCP surface (v1: stdio)

### 5.1 Handshake, capabilities, and stdout discipline

- **`initialize` handshake:** the app declares a **pinned set of supported `protocolVersion`s** and negotiates the highest common one; it returns `serverInfo` (name + version). Unknown future versions degrade per the MCP negotiation rule, never crash. [review P1-10]
- **Capabilities are declared exactly as implemented** — advertising an unimplemented capability makes conformant clients call it and fail:
  - v1: `resources: { listChanged: true }`, `tools: { listChanged: false }`.
  - `resources.subscribe` (per-URI live subscription) is **v1.x** and its capability flag is advertised **only when implemented**. The first draft listed `subscribe` in the v1 read surface — **removed**; `listChanged` is the right primitive (the folder-watcher already emits it). [review P1-11]
- **`notifications/resources/list_changed`** is emitted by the folder-watcher on add / remove / rename — including a `SYNC_ENGINE` conflict-copy appearing (§9). Subscriptions/notifications key on **path**, not inode, so they survive the atomic temp→rename write (§8) and conflict-copy creation. [review P1-11]
- **Stdout discipline (the #1 real-world stdio breakage):** the shim writes **nothing** to stdout except framed JSON-RPC. All logging and **all Rust panics route to stderr** (a panic hook is installed); any Tauri/dependency stdout chatter is disabled in the shim build. A single stray banner or panic line on stdout corrupts the JSON-RPC stream and produces an opaque init failure. **CI smoke test:** pipe an `initialize` request into the built `stashpeak-mcp` binary and assert the first stdout bytes are a valid JSON-RPC response. [review P1-10]

### 5.2 Primitive split (resources vs tools) — stated, not hedged

MCP hosts differ in what they consume first: Claude Desktop is **resources-first** (the user attaches resources as context); Cursor and many tool-only agents are **tools-first**. The design serves both deliberately, over the same KB read layer: [review P2-13]

- **Resources are the primary read surface:** `kb://` tree, `resources/list` + `resources/read`. The URI grammar is pinned (§5.3).
- **Read tools are a compatibility shim + the model-driven search path:** `kb_search` (no resource equivalent — it is search, not addressing), `kb_read_note` and `kb_list` (mirror the resource primitives for tools-first hosts).

This duplication is intentional and declared; it is not the spec hedging.

### 5.3 Resource URIs

- Resources use a **`file://`-style URI rooted at the vault** (friendlier interop than a bespoke scheme) with a pinned normalization grammar: vault-relative, forward-slash, NFC, percent-encoded per RFC 3986. `"vault-relative path = URI"` is not, by itself, a valid URI — the grammar is specified so two clients address the same note identically. [review P3-18]
- The canonical *string* used for identity/comparison is `SYNC_ENGINE` §6.1 canonical form (NFC, forward-slash, vault-relative); the URI is a 1:1 encoding of it.

---

## 6. Identity, scope & consent (the auth model, reframed)

The first draft anchored security on **token confidentiality**, which provably does not hold on a single-user desktop (any same-user process can read the client config file and the keychain). The review's correction is folded in: **re-anchor on opt-in + explicit per-client write grant + the write broker + the ledger; demote the token to a scope + revocation handle.** [review P0-2, P1-7]

### 6.1 What the token is (and is not)

- **A per-client token** is minted in the Stashpeak app (Settings → KB access) and pasted by the user into the client's MCP config (env/arg the client passes to the spawned shim).
- **On stdio the token authenticates the shim→app IPC channel, not the MCP session.** The MCP "client identity" is simply the process the user configured to spawn the shim. [review P0-2]
- **The token provides no authentication benefit over the OS process boundary against a same-user adversary** (that adversary can read the token at rest anyway). It is a **per-config scope label + a revocation handle**, and a routing key for the ledger. The security claim does **not** rest on token confidentiality. [review P0-2, P1-7]
- **Token format:** opaque, ≥128-bit CSPRNG, prefixed `spk_mcp_`. Stored **server-side as a hash** (a verifier, not a reproducible secret). Registered with the **T10 log-scrubber** on both mint and validate so it never lands in a log. **Scope is keyed by the token-hash server-side, never embedded in the token body.** [review P1-7]

### 6.2 Scope, grant, and the consent event (F2)

- **Default scope = read-only.** A freshly minted token can read (subject to §7) and nothing else.
- **Granting read+write is the explicit, one-time per-client approval** (F2): the user flips the token to `read+write` in Settings. That flip **is** the consent event. After it, writes flow without per-call prompts (with two exceptions below), and every write is recorded in the ledger (§7).
- **An optional "confirm every write" toggle** is available per client for the cautious (this is the per-write-prompt model as a setting, not the default).
- **Higher-friction destructive ops:** `kb_write_note` (full overwrite) is a **separately-granted, higher-friction** capability than `kb_append_note`/`kb_create_note`, and overwrite-shaped operations **default to per-write confirm even when write is granted** (§10). [review P1-6]
- **`clientInfo` is display-only.** The MCP `clientInfo` name/version is spoofable and is used only as a label in the UI/ledger; the **human-readable client label is authored by the user at mint time**. Scope is **never** keyed on `clientInfo`. [review P2-16]

### 6.3 Revocation

- Tokens are **revocable per-client** from Settings (a stolen-laptop or rogue-client kill switch).
- **Scope is re-read per call**, not cached at shim startup: the app resolves the token's current scope at the moment of each read/write, and a revoked/downgraded token takes effect immediately. Scope resolution is folded into the write broker's re-validate-at-open step (§8) to close the TOCTOU. [review P2-17]

---

## 7. The read path (ships first — must carry the rigor the write side got)

The most uncomfortable finding: **reads ship first and are the highest-value attack on a private notes vault, yet the first draft gave them none of the rigor it gave writes** — no confidentiality gate, no scope below whole-vault, no ledger, no rate limit. Fixed here. [review P0-4, P0-5]

### 7.1 `resolve_readable` — one default-deny choke point on every read primitive

A single server-side function **`resolve_readable(path) → allow | deny`** sits on **every** read primitive — `resources/list`, `resources/read`, `kb_read_note`, `kb_list`, **and** `kb_search` indexing and snippet generation. There is no read path that bypasses it. [review P0-5]

- **Default-deny on match.** An excluded path **never** appears in a listing, is **never** readable by direct path, and **never** contributes a search index entry or snippet. (Absence is uniform — an excluded note is indistinguishable from a non-existent one to the client.)
- **`.kbignore` + per-folder "do not expose over MCP" ship in the same v1.0 release as the read tools** — the user's only confidentiality lever must not lag the surface it protects. It is **enforced server-side**, not advisory. [review P0-5]
- **A default-excluded set protects a brand-new KB before the user configures anything:** dotfiles, `*.key`, `*.pem`, `*.env`, and high-entropy secret-shaped patterns are excluded by default.
- **Snippet redaction:** `kb_search` snippets are run through the **T10 secret-scrubber** before they leave the server, so a secret embedded in an otherwise-exposed note does not leak via a search preview. [review P0-5]

### 7.2 The read ledger + bulk-read brake (symmetry with writes)

- **Reads are logged, symmetric to writes:** every read tool-call records `{ client label, tool, path or query, result size / note count, timestamp }`. A **"what agents read from your KB"** panel sits beside the write panel. Writes being logged while reads were not is an indefensible asymmetry for a vault. [review P0-4]
- **A bulk-read brake** converts a silent full-vault dump into an interactive decision: a heuristic (N notes in T seconds) raises a **non-dismissable notice**, and a **per-client read budget pauses + requires re-confirmation** past a hard threshold. [review P0-4]

### 7.3 Read = consented egress to the user's own agent (honest residual)

Once a paired agent reads a note, **what it then does with the content (e.g. sends it to its own LLM) is outside Stashpeak's control** — the same honest-residual class as **T11** (BYOK egress to the user's own provider), **not** Stashpeak cloud (which receives KB contents never). The first draft mislabeled this; it is now stated as a T11-class residual in T13 (§12). The claim boundary: *"only clients you pair can read your KB, and you can see what they read"* — **not** *"your notes can never leave your machine once an agent reads them."* [review P0-2 (T11 mislabel)]

---

## 8. The write path (designed now; this spec OWNS the algorithm)

**This spec owns the KB write-path algorithm. It is NOT inherited from `EXTENSIONS_SPEC` §7** — §7 is a trusted-first-party-handler boundary, explicitly not a hard sandbox, and the `file_write` storage broker it references **does not yet exist** (§13 box, L198: storage scopes "await a storage broker"). The MCP write path is the **first consumer of an attacker-influenced path** (an external agent supplies the path + content), so its containment is normative here and write tools do not ship until it passes the test matrix in §14. [review P0-3]

### 8.1 Path containment algorithm (normative)

Every write resolves its target path through these steps, in order; **any failure rejects + logs, never coerces to a "nearby" path:**

1. **Reject before any filesystem touch**, on **every** path component, after NFC normalization: absolute paths; drive letters; `..` segments; `\\`, `\\?\`, `\\.\` prefixes; UNC paths; NUL and control bytes; Windows reserved device stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitive, **ignoring extension** — `CON.md` is reserved); trailing dot or space; the reserved characters `<>:"|?*`.
2. **Resolve the real path from an opened handle** (`GetFinalPathNameByHandle` on Windows / `realpath`/`O_NOFOLLOW` semantics on POSIX), **never** by string concatenation, and assert **vault-root containment by path-segment prefix** (not a `startsWith` string check — `…/vault-evil` must not pass as inside `…/vault`).
3. **Open with symlink/reparse-following disabled.** Reject any in-vault path component that **is** a reparse point (Windows junction / symlink / mount point) or symlink, and refuse a final target whose **hard-link count > 1** (clobber-via-hardlink).
4. **Re-assert containment from the open handle *after* opening** — closes the TOCTOU window between resolve and open. (This is the same re-validate-at-open mechanic `SYNC_ENGINE` §6.7 relies on; here it is owned, not assumed.)
5. **Scope check at the same point** (§6.3): resolve the token's current write scope from the handle step, so a just-revoked token cannot complete an in-flight write.

The accompanying **normative test-vector matrix** (run in CI; §14) must include: junction/reparse escape, hardlink clobber, NFD/NFC collision, reserved device name (incl. with extension), trailing dot/space, 8.3 short-filename alias, and case-only collision. [review P0-3, P1-12]

### 8.2 Atomic, CAS-guarded write (no blind last-write-wins)

The write itself is an **atomic check-and-swap**, reusing `SYNC_ENGINE` §6.7's expected-prior-hash mechanic so an MCP write can never silently clobber a concurrent user edit or a sync apply: [review P1-8]

1. Write to a temp file → `fsync`.
2. Under folder-watcher suppression, **re-hash the on-disk target** and proceed **only if** it equals the expected-prior hash (for `append`/`write`, the hash the broker read at the start of the read-modify-write).
3. Atomic rename → `fsync` the directory.
4. On a **failed CAS**: `kb_append_note` **retries** the read-modify-write; `kb_write_note` **mints a same-device conflict copy** (deterministic name, §9) rather than overwriting the changed bytes.

- **`kb_append_note` is defined as an atomic CAS'd read-modify-write, or it is dropped from v1** — a naive append is a lost-update race under two concurrent agents. [review P1-8]
- **The broker is index-agnostic.** It writes canonical-path bytes and **never mutates `B` or the `path⇄fileId` index** — all identity assignment stays the `SYNC_ENGINE` reconcile loop's job (preserves single-writer-of-identity). The MCP write "reuses the canonical path **form**," not the index. [review P1-8]

### 8.3 Tool result contract

- **Write tools carry MCP annotations** (`readOnlyHint: false`; `destructiveHint: true` on `kb_write_note`) so hosts can gate/surface them correctly. [review P2-15]
- **Broker rejections are returned as `isError` tool-results**, not JSON-RPC protocol faults — the agent sees a structured, recoverable error ("path rejected: outside vault"), and the protocol stream stays valid. [review P2-15]
- **Write-ack means "durably on local disk," and is distinct from a queryable "committed / synced" state** (§9): an ack never implies cross-device availability.

---

## 9. Sync interplay (clean layering, no direct coupling)

- **The MCP server never calls the sync engine.** A write is just a file write through the broker (§8) → the folder-watcher picks it up → `SYNC_ENGINE` reconcile assigns/advances identity and propagates. The first draft's "MCP write is identical to a hand-edit" was **false** in one respect (identity assignment), now corrected: identity is the reconcile loop's job, and the broker stays index-agnostic (§8.2). [review P1-8]
- **One in-process write broker serializes all local writers** — every MCP client write **and** the `SYNC_ENGINE` remote-apply path — through a **per-path lock** held across the read→modify→rename critical section. **Conflict-copy is a cross-device mechanism and does not protect same-device concurrency; this broker does.** [review P1-8]
- **A watcher echo-filter** records `(path, resulting-hash)` for every local write so the folder-watcher recognizes a self-write versus a foreign edit and does not loop (write → watcher fires → looks like a new change → re-emit). [review P1-8]
- **Restore-from-history (a `SYNC_ENGINE` op) routes through the same per-path broker**, so an MCP write racing a restore is serialized, not interleaved. [review — restore ping-pong]
- **Ack vs committed/synced (§8.3):** the app exposes a queryable per-note sync state (on-disk / committed / synced) as a resource, so an agent never claims cross-device availability during an offline or quota-paused `SYNC_ENGINE` window.

---

## 10. Confused-deputy & prompt injection (the likeliest real attack)

The token model says **nothing** about the most realistic vector: a **legitimately paired, trusted agent weaponized by untrusted KB note content** (a poisoned note instructs the reading agent to exfiltrate other notes, or to overwrite/destroy). "Trusted client" means **trusted-not-buggy, not trusted-against-injection.** [review P1-6]

- **Recoverable history is a hard guarantee.** Every MCP write produces recoverable `SYNC_ENGINE` history; **no MCP path can hard-delete** (delete/rename are not v1 tools, §2). A destructive write is always reversible from history.
- **Overwrite/delete-shaped operations default to per-write confirm** even when write is granted (§6.2), and `kb_write_note` is separately granted and higher-friction than append/create.
- **Injection-shaped content is labeled, not neutralized.** The server may flag content that looks like an injection payload in the tool-output metadata, but it **does not claim to neutralize injection** — defusing prompt injection is the host agent's responsibility, and overclaiming would be dishonest.
- The read brake (§7.2) bounds an injection-driven mass-read; the ledger (§7) makes it visible after the fact.

---

## 11. Lifecycle & enablement

- **Opt-in / available-off.** Exposing the KB to external agents is a deliberate enable, not a default — consistent with Decision #26 (onboarding toggle picker; sensitive contributions ship available-off, like KB/Vault/Docker). The user enables **"KB access for AI agents"** in Settings; only then can tokens be minted.
- **Resource-holding contribution** (Decision #24): the in-app MCP service (the IPC listener + token store + ledger) **starts/stops with the KB connector** (~0.6.0 lifecycle). v1 **binds no network port** (stdio + local IPC only).
- **Shim installation/registration:** enabling the feature surfaces the exact MCP-client config snippet (the `stashpeak-mcp` command + the minted token) for Claude Desktop / Cursor, so the user can paste it in. Shipping/locating the shim binary alongside the app is an implementation detail for the plan.

---

## 12. Threat model — T13 (owned here) + residuals

> [!IMPORTANT] New THREAT_MODEL row required — **T13: the local MCP write-server exposed to localhost agents** (the inverse of T9)
> Here Stashpeak is the **server** other agents read/write *through*, not the client. The trust boundary is the **shim↔app local-IPC hop** (§4), not the MCP session.

**Threats & defenses:**

- **A hijacked / malicious localhost process connects** → opt-in feature (must be enabled), per-client token grant, default read-only, the `resolve_readable` gate (§7), the write broker (§8), and the read+write ledger (§7). The token is **not** the boundary (a same-user process can read it); the boundary is opt-in + grant + broker + audit.
- **Token theft from the client config / keychain** → **documented residual**, not a defended line: the config copy is plaintext-at-rest and the keychain is a flat per-user namespace with no per-process ACL (verified in `secrets.rs`). Token confidentiality is **defense-in-depth only**; revocation (§6.3) is the real mitigation. [review P1-7]
- **Path-traversal / reparse / TOCTOU write escaping the vault** → the owned containment algorithm + CI test matrix (§8.1). [review P0-3]
- **KB-content exfiltration by a paired agent** → bounded by per-client read scope + `resolve_readable` + the read brake + the ledger (§7); the **downstream** use of read content is a **T11-class consented-egress residual** (§7.3), honestly disclosed, distinct from Stashpeak cloud.
- **Confused-deputy / injection-driven destructive write** → recoverable history (hard guarantee) + overwrite confirm + no hard-delete (§10).
- **Locally-tamperable ledger** → noted residual: a fully compromised host (T1) can edit the local ledger; the real backstop is recoverable `SYNC_ENGINE` history, which is stronger than the log. This is the **T1 boundary the model already excludes**.

**Out of scope:** a fully compromised host (T1); a malicious *first-party* build (T6 covers it via open-source + reproducible builds).

**HTTP-transport security gates (forward-compat, §13):** when the localhost HTTP transport ships, it inherits these as **required-before-ship** gates (loopback HTTP introduces attacks stdio does not have): listener bound to `127.0.0.1` only; mandatory `Origin`/`Host` allowlist; reject browser `Origin`s; DNS-rebind defense; CORS deny-by-default; short-TTL credentials + a server-side revocation list; and it follows MCP's **OAuth / Protected-Resource** pattern rather than a static bearer. [review P1-9]

---

## 13. Forward-compat seams (design now, ship later)

- **The authorization *model* ports, not the wire credential.** What carries to the future HTTP transport is per-client **identity → scope → revocation → audit** — not the stdio token bytes. HTTP gets MCP OAuth/PRM (§12), not a reused static bearer. [review P1-9]
- **`resolve_readable` is the single read choke point** (§7) — folder-level `.kbignore` ships in v1; finer per-note exposure rules bolt on behind the same gate.
- **`resources.subscribe`** — capability flag + per-URI subscription, advertised only when implemented (§5.1).
- **`kb_move`** (broker-mediated rename carrying a `renameHint`) — the first v1.x write-tool addition (§2/§9).
- **`keyEpoch`-style nothing needed here** — the write broker is index-agnostic, so identity evolution lives entirely in `SYNC_ENGINE`.

---

## 14. Testing strategy

- **Path-containment matrix (gates write-tool ship):** junction/reparse escape, hardlink clobber, `..` traversal, absolute/drive/UNC/`\\?\` paths, NFD/NFC collision, reserved device names (incl. `CON.md`), trailing dot/space, 8.3 alias, case-only collision — each **rejected + logged**, never coerced. [review P0-3]
- **Write concurrency:** two agents `kb_append_note` the same note concurrently → **no lost update** (CAS retry); an MCP `kb_write_note` racing a `SYNC_ENGINE` remote-apply → serialized, no clobber, conflict-copy on CAS fail; the watcher echo-filter suppresses self-write loops.
- **`resolve_readable`:** an excluded note is absent from `list`, unreadable by path, and contributes no search index entry or snippet; default-excluded patterns protect an unconfigured KB; a secret embedded in an exposed note is scrubbed from snippets. [review P0-5]
- **Read ledger + brake:** every read tool-call is logged; a bulk read trips the non-dismissable notice and the per-client budget pause. [review P0-4]
- **Auth/scope:** default read-only; the write grant is the only path to a write; scope is re-read per call (a mid-session revoke blocks an in-flight write); `clientInfo` cannot escalate scope. [review P2-16, P2-17]
- **Handshake/stdout:** the CI smoke test pipes `initialize` into the built `stashpeak-mcp` and asserts the first stdout bytes are valid JSON-RPC; a forced panic goes to stderr, never stdout. [review P1-10]
- **Capabilities:** the server advertises only implemented capabilities; a client calling an unadvertised `subscribe` gets a clean method-not-found, not a crash. [review P1-11]
- **Topology/IPC:** with the app stopped, the shim returns "Stashpeak not running" and performs no direct vault I/O; the shim holds no keychain access. [review P0-1]
- **Injection/confused-deputy:** a destructive write is always recoverable from history; overwrite triggers confirm even under a write grant; no MCP path hard-deletes. [review P1-6]

---

## 15. Review coverage map (5-lens adversarial review → where resolved)

| #     | Finding                                                                                  | Sev    | Resolved in                                              |
| ----- | --------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| P0-1  | stdio topology: client spawns the server; no live app on the pipe                       | P0     | §4 (spawned shim + local IPC; shim↔app = T13 boundary)  |
| P0-2  | token authenticates nothing on stdio; T11 read-egress mislabel                          | P0     | §6.1 (token = scope/revoke handle) + §7.3 (T11-class)   |
| P0-3  | §7 write-broker is unspecified prose + the file-write broker does not exist yet         | P0     | §8 (owned containment algorithm + CI matrix)            |
| P0-4  | read path has no ledger + no rate limit (invisible, unbounded exfil)                     | P0     | §7.2 (read ledger + bulk-read brake)                    |
| P0-5  | `.kbignore` was a deferred "seam"; no read confidentiality choke point                  | P0     | §7.1 (`resolve_readable` default-deny, ships v1.0)      |
| P1-6  | confused-deputy / injection-driven write via a legit paired agent                       | P1     | §10 + §6.2 (overwrite friction, recoverable history)    |
| P1-7  | token-at-rest in config + flat keychain → confidentiality doesn't hold                  | P1     | §6.1 (token-as-hash) + §12 (documented residual)        |
| P1-8  | MCP write skips the path⇄fileId index; same-device concurrency = blind LWW              | P1     | §8.2 + §9 (index-agnostic broker, per-path CAS lock)    |
| P1-9  | "ports 1:1 to HTTP Bearer" forward-commits the weakest property                         | P1     | §13 + §12 (authz model ports; HTTP gets OAuth/PRM)      |
| P1-10 | `initialize`/capabilities unspecified + Rust stdout pollution breaks init               | P1     | §5.1 (handshake + stdout discipline + CI smoke)         |
| P1-11 | `subscribe` both demoted-to-seam and listed in v1; `listChanged` is right               | P1     | §5.1 (advertise only-if-implemented; `listChanged`)     |
| P1-12 | Windows reserved names / reparse / NFC / 8.3 / case-at-write                             | P1     | §8.1 (reject-list) + §14 (test matrix)                  |
| P2-13 | read tools duplicate the resources primitive without a stated rationale                 | P2     | §5.2 (resources primary; tools = compat + search)       |
| P2-14 | no delete/rename → agent "delete" = truncation, "rename" = fileId churn                 | P2     | §2 (scoped out v1) + §13 (`kb_move` v1.x)               |
| P2-15 | write tools lack MCP annotations + `isError` result contract                            | P2     | §8.3 (annotations + `isError` rejections)               |
| P2-16 | `clientInfo` is spoofable; must be display-only                                         | P2     | §6.2 (display-only; user-authored label; never keys scope) |
| P2-17 | revocation race: scope must be re-read per call                                         | P2     | §6.3 (scope re-read per call, folded into re-validate)  |
| P3-18 | `kb://` vs `file://` + URI normalization grammar hand-waved                             | P3     | §5.3 (`file://`-rooted, pinned grammar)                 |

---

## 16. Decision log (propagate condensed entries into `ARCHITECTURE.md §8`)

| #   | Decision                                                                                                                                                                          | Why                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M1  | **Topology = a thin spawned shim binary (`stashpeak-mcp`) brokering to the running app over local IPC.** The shim holds no app logic/keychain/fs-write; the shim↔app hop is the T13 trust boundary. | MCP stdio means the client spawns the server — there is no in-app server on the pipe; the shim is the only way the spec is physically realizable. |
| M2  | **Transport = stdio (v1); the token authenticates the shim↔app IPC, not the MCP session.** It is a scope + revocation handle, not authentication; security rests on opt-in + grant + broker + ledger. | stdio is the MCP standard and has no listener to attack; on a single-user host a token can't be an auth secret, so it must not be load-bearing. |
| M3  | **Per-client token: opaque ≥128-bit `spk_mcp_`, stored server-side as a hash, scope keyed server-side, scrubbed from logs, revocable, scope re-read per call.** Default read-only; write = explicit one-time grant (F2). | The grant is the consent event; revocation is the real mitigation; token confidentiality is defense-in-depth only. |
| M4  | **Read confidentiality = one default-deny `resolve_readable` gate on every read primitive (list/read/search/snippets), shipping in v1.0** with `.kbignore` + per-folder scope + a default-excluded secret set + T10 snippet scrubbing. | Reads ship first and are the highest-value attack on a vault; the only confidentiality lever must not lag the surface it protects. |
| M5  | **Read + write activity ledger + a bulk-read brake.** Reads are logged symmetric to writes; a bulk read trips a non-dismissable notice + a per-client budget pause. | Silent unbounded read of a private vault is indefensible; the brake turns a dump into an interactive decision. |
| M6  | **This spec owns the KB write-path algorithm** (not inherited from §7, which is trusted-handler-only and whose file-write broker doesn't exist): reject-list + handle-based resolve + reparse rejection + re-validate-after-open + atomic CAS temp→rename + CI test matrix. Write tools don't ship until it passes. | The MCP write is the first attacker-influenced path consumer; containment must be normative and owned, not assumed. |
| M7  | **The write broker is index-agnostic and serializes all local writers** (every MCP client + the sync remote-apply) via a per-path CAS lock + a watcher echo-filter. Identity assignment stays the `SYNC_ENGINE` reconcile loop's job; conflict-copy is cross-device only. | Prevents same-device blind LWW (which conflict-copy does not cover) and preserves single-writer-of-identity. |
| M8  | **No destructive delete/rename MCP tools in v1.** Recoverable `SYNC_ENGINE` history is a hard guarantee; overwrite is higher-friction + confirmed. Injection-shaped content is labeled, not neutralized. | The likeliest attack is a trusted agent weaponized by poisoned note content; bound the blast radius and keep every write reversible. |
| M9  | **Opt-in / available-off + resource-holding lifecycle** (Decisions #26/#24); v1 binds no network port. localhost HTTP is a forward-compat seam that ports the **authz model** (not the token) and lands loopback gates (127.0.0.1, Origin allowlist, DNS-rebind, OAuth/PRM) before it ships. | Exposing the KB to external agents must be deliberate; HTTP adds attacks stdio lacks, so its gates are pre-committed. |
| M10 | **New THREAT_MODEL row T13** (local MCP write-server, inverse of T9): boundary = the shim↔app IPC hop; token theft + locally-tamperable ledger are disclosed residuals (T1-class); read-egress downstream is a T11-class consented residual. | Closes the deferred MCP-write-server threat row and keeps the claim boundary honest. |

---

## 17. Follow-ups (separate PRs — propagation is a blocking close-out)

These land in the **same change-set** that flips this spec from "design locked" to "in implementation," so the canonical decision logs are never the stale source of truth for an in-flight build (same discipline as `SYNC_ENGINE` §14):

- **Add THREAT_MODEL row T13** (local MCP write-server, inverse of T9) — replacing the deferred `> [!TODO]` placeholder already in `THREAT_MODEL.md` (owned by this spec, Decision #31). Cross-reference T9 (inverse), T11 (read-egress residual class), and T1 (host-compromise out-of-scope).
- **Propagate M1–M10 into `ARCHITECTURE.md §8`** as condensed decision rows; mark Decision #31 ("agent interop / MCP") **refined** by this spec (the write path is an owned KB broker, not the §7 Action broker).
- **Add a note to `EXTENSIONS_SPEC.md` §7 / §13** that the KB write broker (this spec, §8) is the first realization of the long-deferred "storage broker" the §7 `file_write` scope was waiting on — and that it is core-owned (like the `SYNC_ENGINE` §6.7 write path), not effects-gated.
- **Then `writing-plans`** — the implementation plan for `SYNC_ENGINE.md` + this spec (the two foundations specs are now both design-locked).
