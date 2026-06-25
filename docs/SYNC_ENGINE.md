# Stashpeak Sync Engine — Design Spec (E2EE blob relay)

**Status:** Design locked — ready for phased implementation (no code yet)
**Created:** 2026-06-25
**Implements:** `ARCHITECTURE.md` Decisions #28–#32 (the 2026-06-21 KB-as-context pivot)
**Strategy source of truth:** KB `Resources/Decisions.md` (Stashpeak strategie) + `internal-docs/stashpeak-app/ARCHITECTURE.md §3, §8`
**Peer spec:** `docs/EXTENSIONS_SPEC.md` — the sync engine's remote→local writes reuse §7's **path-safety mechanics** (canonicalize + containment + no-follow + re-validate-at-open) via a core write path; see §6.7 and the §14 follow-up on reconciling this with the §7 effects-gated broker.
**Decision-log home:** condensed entries to propagate into `ARCHITECTURE.md §8` (blocking close-out — see §14)

---

## 0. Provenance (how this spec was produced)

Brainstorming session 2026-06-25, grounded in the locked KB-as-context pivot (Decisions #28–#32) and a structural read of the existing connector/broker code (`src-tauri/src/connectors/http.rs`, `secrets.rs`) and the View/Action contracts in `EXTENSIONS_SPEC.md`.

Three load-bearing forks were resolved with the founder (see §3), then the design was hardened in three adversarial rounds:

1. **Design review (2 reviewers):** distributed-systems (convergence / data-loss) + applied-cryptography (zero-knowledge / key management) → **25 findings** (14 sync + 11 crypto). Folded into the body; coverage map = §12.
2. **Spec verification (29 agents):** caught a **structural contradiction between two round-1 fixes** (per-entry CAS vs a client-signed full-set root) + second-order gaps → reworked to a **signed append-only operation log**. Coverage = §12b.
3. **Keystone re-verification (6 agents):** confirmed the signed-log model is structurally sound (anti-rollback **and** non-contending concurrency hold); found refinement gaps only (crash-safe re-encrypt, fresh-device rollback floor, read-skew tamper rule, `recoverySalt`, etc.). Coverage = §12c.

> [!IMPORTANT]
> The headline promise this spec must keep is **"sync never loses your data, and the relay can never read or undetectably tamper with it."** These corrections **require amending Locked Decision #3 (cipher) and #29 (conflict model) and reconciling the Locked THREAT_MODEL T3 / Core principle and Locked Decision #31 (write broker)** — all tracked as follow-ups in §14 — but change **no product decision** and **no zero-knowledge guarantee**. Every finding is folded into the body (primarily §4–§9; architecture-decision reconciles in §3/§13/§14).

---

## 1. Understanding summary (locked)

- **What:** the **paid** cross-device sync layer for the local, file-on-disk Knowledge Base. The KB itself is free and fully usable offline (Decision #27); sync **adds reach, never unlocks existing capability** (the no-crippleware rule, ARCHITECTURE §1).
- **Shape:** a **thin, zero-knowledge E2EE blob relay** — Rust on Cloudflare Workers + R2 (object store) + Durable Objects (per-user coordination). The relay stores and sees **ciphertext and opaque identifiers only**; it never holds a key (Decisions #2, #29, #30).
- **Canonical data:** markdown files on disk, git-coexistent. Sync is **not** git-as-transport and **not** a CRDT (Loro deferred). It is whole-file content sync with conflict-copy resolution (Decision #29, **amended** in §3 — block-LWW killed).
- **Subject of sync:** encrypted KB file **contents + names**. Plaintext contents, encryption keys/passphrases, provider API keys, and raw prompts/responses **never leave the device** (Decision #30).
- **Clients:** desktop (Tauri 2, continuous) and mobile (Tauri 2 iOS/Android, foreground-reconcile + push — Decision #32). One vault per account in v1.

---

## 2. Scope

**In scope (v1):** one vault folder per account; full mirror across a user's own devices (2+; one-device accounts allowed); whole-file sync; conflict-copy resolution; E2EE with single-password key derivation; encrypted paths; version history for restore; soft-delete/trash; anti-rollback freshness; **password change (O(1) re-wrap of a stable vault key)** (§4.4); paid-tier gating + quota semantics.

**Explicitly out of scope (v1 — YAGNI):**

- Real CRDT / block-level merge (deferred; Loro).
- Selective / partial sync; multiple vaults per account.
- Sharing / collaboration (multi-user on one vault).
- Block-level dedup / binary delta encoding / cross-file content dedup.
- **`VK` rotation** (suspected-compromise re-key = full re-encrypt) — deferred to v1.1; the `keyEpoch` seam ships now so it bolts on without a migration (§4.4). (Password change itself **is** in scope — it's an O(1) re-wrap, not a re-encrypt.)
- Background mobile sync (iOS does not allow it reliably — Decision #32).
- ORAM-style access-pattern hiding (see the metadata residual, §7).

**Recommended but deferrable to v1.1:** blob size-padding to buckets (blunts the size-leak residual in §7).

---

## 3. The three load-bearing forks (resolved)

These were chosen by the founder during the brainstorm and govern everything below.

| Fork               | Decision                                                                                                                                                                    | Why (and what it refines)                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conflict model** | **Whole-file + conflict-copy.** The file is the sync unit; a true concurrent conflict keeps **both** versions, never overwrites.                                            | Block-level LWW can stitch an incoherent file or silently drop an edit — fatal for a trust product. This **amends Decision #29**: kill "block-level last-write-wins," replace with whole-file + conflict-copy. |
| **Key model**      | **One account password, client-side domain-split (Bitwarden-style).** One secret stretches into a relay-visible auth verifier and a vault key that never leaves the device. | Single-secret UX with zero-knowledge; proven model. Pairs with a BIP-39 recovery code.                                                                                                                          |
| **Path privacy**   | **Encrypt paths too.** The relay sees only opaque IDs, ciphertext blobs, and an encrypted metadata layer — never names or tree.                                             | A KB's filenames are its table of contents. Plaintext paths would contradict the whole zero-knowledge positioning.                                                                                              |

---

## 4. Cryptography

All derivations and encryptions happen **client-side**. The relay never receives a key, a passphrase, or plaintext.

### 4.1 Key derivation

```text
Vault Key (VK)  = CSPRNG, 256-bit, generated ONCE at account creation   [random; STABLE for the account's life; never leaves the device]
   VK ──HKDF "stashpeak/obj/v1"────► Object Key (K_obj)             (keyed opaque object IDs)
   VK ──HKDF "stashpeak/sign/v1"───► Ed25519 signing key (SK)       (signs operation-log entries + checkpoints)

account password ──Argon2id(salt, params)──► Master Key (MK)        [client-side only, never stored]
   MK ──HKDF "stashpeak/auth/v1"───► auth secret      ──► relay login (relay stores a SERVER-SIDE Argon2id stretch of it)
   MK ──HKDF "stashpeak/wrap/v1"───► Key-Wrapping Key (KWK)
   wrappedVK = committing-AEAD(KWK, VK)                              ──► stored in {userId}/account (the only place VK persists, encrypted)
```

- **The real Bitwarden shape:** `VK` is a **random key wrapped under a password-derived `KWK`**, NOT `HKDF(password)`. This is the load-bearing choice — because `VK` is stable, a **password change is an O(1) re-wrap of `VK`** (re-derive `KWK`, re-upload `wrappedVK`), with **no data re-encryption, no signing-key change, no epoch transition** (§4.4). `K_obj` and `SK` are HKDF children of the stable `VK`, so they too survive a password change. [round-4 P0 — dissolves the re-encrypt cluster]
- **Argon2id** (variant id, version 0x13). **Salt** = 16-byte CSPRNG value generated client-side once at account creation; stored in `{userId}/account`. Not secret, but the client **pins** it (TOFU) and treats a relay serving a different salt for the same account as an attack.
- **Parameters are pinned**: `m ≥ 64 MiB, t ≥ 3, p = 1` (desktop floor; tune up where the device allows). **Deliberate divergence from ARCHITECTURE §2's "use library defaults, do not hand-tune"** — cross-device parameter-downgrade defense requires *authenticated pinned* params, which a runtime library default cannot provide. (The local at-rest path may keep library defaults; the sync path may not — §14 adds a scoping note to §2.)
- **Anti-downgrade binding:** `argon2Salt`/`argon2Params` live in `{userId}/account`, whose hash is **covered by every signed checkpoint** (§5.2). An established device detects weakened params. **Fresh-install bootstrap** authenticates params **out-of-band on first contact**: from the **recovery mnemonic blob** (carries the account-record hash) or an **already-provisioned device** (QR/code), else explicit TOFU with a surfaced warning. The provisioned-device path additionally transfers the current `(vaultVersion, headHash)` as a **pinned freshness floor**: on first contact the device rejects (tamper) any served head whose `vaultVersion < pinned` **or** whose recomputed `headHash` at the pinned version `≠` the pinned `headHash` (so the floor catches a same-version fork, not just a rollback — §5.2). [crypto P1-2; round-3 genesis; round-4 equivocation]
- **Auth/vault separation:** the relay stores **`Argon2id(serverSalt, auth secret)`** (server-side slow hash) → a breach pays a server-side Argon2 cost per guess on top of the client-side one. A **strong-password policy + zxcvbn meter is enforced at signup** — the vault's confidentiality reduces to password entropy. [crypto P1-1]

### 4.2 Content & metadata encryption

- **Cipher: XChaCha20-Poly1305** (192-bit nonce, random per encryption). A sync engine performs an unbounded number of encryptions under one long-lived `VK`; a random 96-bit GCM nonce crosses the NIST SP 800-38D 2³² bound (a single collision under one key = catastrophic forge-everything). A 192-bit nonce makes random-nonce collision negligible even at 2⁶⁴ messages. [crypto P0-1]
  - _Deliberate divergence:_ local at-rest uses AES-256-GCM (ARCHITECTURE §2/§3). `"or ChaCha20-Poly1305"` in Decision #3 does **not** cover XChaCha20 (different nonce/construction) → amending #3 is a §14 follow-up.
- **Associated Data (AAD), scoped by mutability:**
  - **Immutable content blobs:** `AAD = suiteId ‖ fileId ‖ blobId ‖ keyEpoch`. **No `vaultVersion`** — a blob is content-addressed and immutable, so binding the monotonic version would make the same content un-decryptable once it advances and break idempotent PUT / restore. `keyEpoch` (§4.4) is stable for a blob's life. Anti-rollback for blobs comes from the signed log binding `entry → blobId` (§5.2), not per-blob version. [crypto P2-2; round-3]
  - **Mutable pointer/meta layer:** `AAD = suiteId ‖ fileId ‖ entryVersion ‖ keyEpoch`. Rewritten per edit, so binding `entryVersion` here gives slot/version replay resistance.
- **Suite/version byte:** every ciphertext is prefixed with a 1-byte **suite ID** (cipher + KDF-params version), covered by AAD. Unknown/old suites rejected — the crypto-agility seam. [crypto P2-3]
- **Committing AEAD** for password/mnemonic-derived blobs (the **recovery blob**, §4.3, and any key-wrap): a key-commitment tag verified on decrypt, defeating partitioning-oracle attacks. (The auth *verifier* is an Argon2 hash, not an AEAD blob — it is protected by the server-side Argon2 stretch + password policy, §4.1, not by committing AEAD.) [crypto P2-1; round-3]

### 4.3 Recovery

- A **24-word BIP-39 mnemonic** (full 256-bit CSPRNG entropy, checksum-validated; not shortenable).
- `KEK = Argon2id(recoverySalt, mnemonic entropy)` — **not** BIP-39's weak 2048-round PBKDF2. `recoverySalt` = a 16-byte CSPRNG value stored in `{userId}/account` (so it is covered by `accountRecordHash`/checkpoints) **and** carried in the recovery blob's authenticated header; it is stable for the account's life (the mnemonic — like `VK` — never changes). [crypto P1-4; round-3 recoverySalt]
- `recovery blob = committing-AEAD(KEK, VK)`, stored on the relay, bound to the **immutable account record** — **not** to the per-commit `vaultVersion` (which would stale it). It also carries the **account-record hash** so a fresh device can authenticate `argon2Salt`/`argon2Params`/`recoverySalt` from it (§4.1). Because `VK` is stable (§4.1), the recovery blob is written **once** and never needs re-wrapping.
- **Forgot password** = recover `VK` from the mnemonic, then **set a new password** (the O(1) re-wrap of §4.4 — re-derive `KWK`, re-upload `wrappedVK`, rotate the auth verifier). The mnemonic thus restores **both** data access and login. **Forgot password AND lost mnemonic = data unrecoverable** — the honest cost of zero-knowledge, stated plainly in onboarding.

### 4.4 Password change (O(1) re-wrap) & key epochs

Because `VK` is random and wrapped (§4.1), a **password change touches only the small `wrappedVK` and the auth verifier — never the data, the signing key, or the operation log.** This dissolves the entire crash-safe-re-encrypt problem class that an earlier draft (`VK = HKDF(password)`) created. [round-4 P0 cluster]

- **Password change** = a single account-record update, performed under an **account-record CAS** at the DO (guards against two concurrent changes): re-derive `KWK` from the new password, compute the new `wrappedVK`, and rotate the server-side auth verifier `Argon2id(serverSalt, auth secret)` — both written together, bumping an `accountVersion`. The DO rejects a stale-`accountVersion` write (a second concurrent change → retry). Old device tokens are invalidated; **`VK`, `SK`, `K_obj`, all blobs, all meta, and the log are unchanged**, so every other device keeps working after it next logs in with the new password (its `VK` in memory is still valid; only the relay credential changed). No transition state machine, no mixed-epoch state, no data re-upload. [round-4 P0 resume + concurrent-init + verifier-rotation]
- **`keyEpoch`** (integer in `{userId}/account`, stamped into every blob/meta AAD, covered by `accountRecordHash`) is the **un-retrofittable seam for a genuine `VK` rotation** — needed only on suspected key compromise, which *does* require a full re-encrypt. In v1 `keyEpoch` is present and **fixed at 0** (it never changes, because password change doesn't touch `VK`); the full `VK`-rotation/re-encrypt protocol is **deferred to v1.1** (§2). Shipping the seam now means v1.1 bolts on without a data migration. [round-4 — scope cut]

---

## 5. Object model (on the relay)

The relay holds these opaque layers per user. **None is path-derived or content-readable.**

### 5.1 File identity

- A normal file gets a **random per-file UUID `fileId`** at creation, stored only inside the encrypted metadata; a **rename/move keeps the same `fileId`** (the path changes inside the encrypted meta — §6.5), so a rename is invisible to the relay. [crypto P1-3]
- A **deterministically-created conflict copy** gets a **deterministic** `fileId = HMAC(K_obj, canonicalPath ‖ contentHash)`, so two devices that independently create the same conflict copy mint the **same** `fileId` and converge (collapse to reconcile row 1). More generally: **two entries that share canonical path AND `contentHash` deduplicate to one identity** deterministically. [round-2 regressions]
- Each content version gets an opaque **`blobId = HMAC(K_obj, contentHash)`** — deterministic, so **idempotent PUT** holds (the same content re-uploads to the same key) and the relay cannot confirm a known file (the real `contentHash` lives only inside the encrypted meta). Blobs are `fileId`-namespaced (§5.2), so cross-file content **dedup is not a goal** (out of scope, §2) — "deterministic" buys idempotency + the confirmation-attack defense, not dedup. [crypto P0-3; round-3 dedup]

### 5.2 Layers and the signed operation log (the anti-rollback root)

```text
{userId}/account                  { argon2Salt, argon2Params, serverSalt, recoverySalt,
                                     wrappedVK, accountVersion, keyEpoch (=0 in v1) }
                                   — changes only on password change (wrappedVK + verifier, under accountVersion CAS);
                                     its hash (accountRecordHash) is covered by every checkpoint
{userId}/log                       append-only operation log (DO-maintained):
                                     each record = { fileId, entryVersion, blobId|tombstone, prevEntryVersion,
                                                     keyEpoch, sig_SK(over those fields) }
                                   headHash_n = H(headHash_{n-1} ‖ record_n)     [DO advances; NO key needed]
                                   vaultVersion = the DO-assigned monotonic index of the latest record
{userId}/checkpoint                latest signed checkpoint = sig_SK( vaultVersion, headHash, accountRecordHash )
                                   — written opportunistically by any device; OFF the commit critical path; monotonic
{userId}/entries/{fileId}          relay-visible pointer { currentBlobId, entryVersion, deleted? }
                                   + encryptedMeta = AEAD(VK, { path, contentHash, size, mtime, renameHint? })
{userId}/blobs/{fileId}/{blobId}   AEAD(VK, file bytes) — immutable, content-addressed by opaque blobId
{userId}/recovery                  committing-AEAD(KEK_from_mnemonic, VK) — written once; header: accountRecordHash + recoverySalt
```

This replaces the first draft's single client-signed full-set root, which could not coexist with per-entry commits. The fix is the standard **signed append-only log** (cf. Keybase sigchain / transparency logs): [keystone — verification round 2]

- **The relay (DO) is the linearization authority.** Per accepted record it performs, in **one atomic DO storage transaction**, the entry-pointer CAS+bump, the log append (`headHash`), and the `vaultVersion` increment — so head, log, and entry layer can never disagree (a crash mid-transaction rolls all three back). It needs **no key**: each record carries the device's own `sig_SK`, so the relay cannot forge, reorder, or drop a record without breaking the chain. [round-3 P2 atomicity]
- **A device signs only its own change** (`sig_SK` over `fileId ‖ entryVersion ‖ blobId|tombstone ‖ prevEntryVersion ‖ keyEpoch`) — never a snapshot of other entries. So non-overlapping commits never force a whole-set re-sign and there is no whole-manifest livelock. [sync P0-5]
- **`accountRecordHash` covers `{ argon2Salt, argon2Params, serverSalt, recoverySalt, wrappedVK, accountVersion, keyEpoch }`** — one canonical rule, all fixed-presence fields; the checkpoint binds that hash (no field is listed both inside and outside the hash). [round-3 P2 epoch coverage]
- **Anti-rollback / anti-fork.** A client persists the highest verified `(vaultVersion, headHash)` **as a tuple** and verifies the chain forward from its last trusted **checkpoint**. The **verification rule is precise** (a head fetch and a log fetch are separate requests, so concurrency must not read as tamper): recompute the chain and compare `headHash` *at the index equal to the fetched head's `vaultVersion`*. **"Tamper" is reserved for**: (1) a chain that fails to recompute up to the fetched index; (2) a served head/checkpoint whose `vaultVersion` is below the persisted highest; (3) a recomputed `headHash` at **any index ≤ the persisted highest that differs from the persisted `headHash` at that index** (proof of an equal-version fork / equivocation — a device that committed `v101a` and is later served a `v101b` holds cryptographic proof); or (4) a bad per-record signature. Trailing records at indices **strictly greater than both the fetched head and the persisted highest** are **benign concurrency → re-fetch-and-advance** — but are still fully chain- + signature-verified before `B` advances. [crypto P0-2; round-3 read-skew; round-4 equivocation]
- **Checkpoints** are anti-rollback anchors a device signs lazily (bounded chain-verification). They are **monotonic**: the DO rejects a checkpoint PUT whose `vaultVersion ≤` the stored one, and a client treats a served checkpoint below its own last-trusted as tamper. Checkpoint writes are **quota-exempt** (O(1) per user, replace-in-place, a safety primitive) and permitted during read-only tier-lapse grace, so the anti-rollback floor keeps advancing even when commits are blocked. [round-3 P2 checkpoint monotonicity + quota]
- **Genesis residual:** a brand-new device with no prior local state and no second live device has no authenticated freshness floor (it must TOFU-trust whatever head the relay serves). The provisioned-device bootstrap (§4.1) closes this when a second device exists; the mnemonic-only path discloses it as a residual (§7/§11). [round-3 P1 genesis]
- The **entries layer is relay-visible opaque pointers**; the DO does **per-file CAS** without decrypting. The **encrypted meta is per-file** → editing one file rewrites one small meta blob. [sync P0-5, crypto P2-4]

---

## 6. The reconcile protocol (the load-bearing logic)

### 6.1 Canonical path form & case policy (locked)

The string used to create a `fileId` and to compare paths is canonicalized **once**, identically on every OS: **vault-relative, forward-slash separators, no leading slash, NFC-normalized Unicode**. The device converts canonical ↔ OS-native only at the write path boundary (§6.7). [sync P1-6, P1-7]

**Case policy (mechanism):** identity preserves case (`Note.md` ≠ `note.md`), and the reconcile keeps a **case-folded collision index** (`casefold(path) → {fileIds}`) plus the local **path⇄fileId index** (§6.2).

- **Case-only collision on a case-insensitive target** (distinct Linux files `Note.md` + `note.md` syncing to Windows/macOS, which can't hold both): resolve **deterministically** — the file whose `fileId` sorts lower keeps its name; the other is written as a conflict copy (§6.4) whose suffix differs by more than case. The forced rename is recorded so it does not ping-pong.
- **Case-only rename** (`note.md`→`Note.md`, same `fileId`) is a metadata-only edit applied from the renameHint (§6.5), not inferred from a re-scan.

### 6.2 The base manifest `B` and the full 3-way table

Each device persists, fsync'd:

- **`B`** = `{ vaultVersion, per-fileId: { contentHash, entryVersion } }`. `entryVersion` is cached from the log delta on every pull/commit so the device reads `prevEntryVersion` from cache (not a re-fetch) — keeping the "non-overlapping commits never reject" guarantee true. [round-3 P2]
- **A local `canonicalPath ⇄ fileId` index** — on-disk markdown carries no embedded `fileId`, so this is the only thing tying a disk path to identity. Updated **atomically with `B`** on every commit and on applying a renameHint. [round-2 regressions]

> [!IMPORTANT] > **`B.vaultVersion` only ever advances to a DO-confirmed committed version and never regresses.** Per-fileId entries in `B` are updated as files converge; `B.vaultVersion` moves forward only. On startup, if `B.vaultVersion ≠ DO current` or an interrupted commit/rename is detected, run a full reconcile; the idempotent rule (row 1) makes recovery safe. **"Advance"** below means "update `B`'s per-`fileId` contentHash/entryVersion (for the entry resolved from the path) and never regress `vaultVersion`." [sync P0-2; round-3 wording]

Reconcile is a **3-way diff per canonical path** (resolved to `fileId` via the local index). Each side is `Missing | Hash | Tombstone`. The table is **complete** over those states. [sync P0-4]

| #   | L (local now) | B (base)   | R (remote)         | Action                                                                                                                                                                  |
| --- | ------------- | ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hash(x)       | _any_      | Hash(x)            | **Idempotent re-converge:** no-op; advance `B`. Identical content is never a conflict (covers crash recovery). [sync P0-2]                                              |
| 2   | Hash(x)       | Hash(x)    | Hash(x)            | Unchanged; skip.                                                                                                                                                        |
| 3   | Hash(y), y≠B  | Hash(x)    | Hash(x)            | **Local-only change:** PUT blob; per-entry commit (§6.3); advance `B`.                                                                                                  |
| 4   | Hash(x)       | Hash(x)    | Hash(y), y≠x       | **Remote-only change:** apply via the atomic check-and-swap write of §6.7 (re-hash on-disk target == expected before rename; if changed, re-classify); advance `B`. [sync P0-1] |
| 5   | Hash(a), a≠B  | Hash(x)    | Hash(b), b≠x,a≠b   | **Conflict (two-present):** ordered-hash resolution (§6.4a). Both kept. Advance `B`.                                                                                    |
| 6   | Hash(x)       | Hash(x)    | Tombstone          | **Remote delete, no local change:** move local → trash (outside the synced tree, §7); advance `B`.                                                                     |
| 7   | Hash(y), y≠B  | Hash(x)    | Tombstone          | **Edit-vs-delete:** keep the edit as a deterministic conflict copy (§6.4b); honor the tombstone on the canonical path. **Never silent-trash.** [sync P1-9]              |
| 8   | Missing       | Hash(x)    | Hash(y), y≠x       | **Local delete vs remote edit:** write the remote edit as a conflict copy (§6.4b); honor the local delete on the canonical path. **Never silently lose it.** [sync P0-4] |
| 9   | Missing       | Hash(x)    | Hash(x)            | **Local-only delete:** propagate (tombstone + per-entry commit).                                                                                                       |
| 10  | Missing/Tomb  | _any_      | Missing/Tomb       | Converged delete; no-op.                                                                                                                                                |
| 11  | _present_     | **Absent** | _present or Missing_ | **Fresh install / adoption:** both present + `L==R` → adopt; both present + `L≠R` → conflict (§6.4a); present-on-one-side → adopt that side (§6.4c). `B` is set only after the first full reconcile commits. [sync P1-11] |
| 12  | Hash(x)       | Hash(x)    | **Missing**        | **Lost tombstone (defensive):** should not occur — tombstones are permanent (§9). If seen, treat as **re-adoption with a surfaced warning**, never a silent resurrect-or-delete. [sync P1-9] |

A file may also be in the first-class state **`unsynced (oversize)`** — present locally, deliberately not synced — which rows treat as "not a sync candidate" until its `contentHash` changes (§9). (Over-quota is a *separate, retryable* paused state, not `unsynced` — §9.)

### 6.3 Commit (per-entry CAS over the signed log) and freshness

- A commit carries, per changed file, a **record** = `{ fileId, entryVersion (= prevEntryVersion + 1), blobId|tombstone, prevEntryVersion, keyEpoch, sig_SK }` plus the `vaultVersion` the device pulled from.
- **Entry-layer CAS:** the DO accepts a record iff the entry's current `entryVersion == prevEntryVersion`; otherwise that **entry** is returned and the device re-reconciles it at the content level (a real conflict → §6.4). Non-overlapping entries never reject. [sync P0-5]
- **Head-layer linearization:** the DO appends each accepted record (the atomic transaction of §5.2), advancing `headHash`/`vaultVersion` in serialized order. A concurrent non-overlapping commit just appends after; a device that based its pull on a now-superseded `vaultVersion` does a **bounded fast re-pull of only the changed entries** (cheap; not a data conflict, not a livelock). [sync P0-5]
- **Pinning:** uploaded-but-uncommitted blobs are recorded in the DO's pending-set (expiry T, §9) so GC can't delete them mid-retry, and a failed/exhausted commit never strands an unsynced edit. [sync P1-8]

### 6.4 Conflict resolution (split by case; deterministic; convergent)

Every conflict outcome is computed identically on every device → the tree converges and copies stop multiplying. Conflict-copy **`fileId`s are deterministic** (§5.1), and names use the **full `contentHash`** (enough bits that collision is cryptographically negligible) with **deterministic de-collision** (extend the prefix on a same-name/different-content clash) so a copy never clobbers another. [sync P0-3; round-2 regressions]

- **(a) Two-present conflict (rows 5, 11-both-present):** order the two `contentHash`es; the **lower keeps the canonical path**, the **higher** becomes `<base> (conflict <contentHash>).<ext>`. Next reconcile sees `L==R` (row 1) and stops.
- **(b) One-present after a delete (rows 7, 8):** one surviving content. The survivor is **always** written under the conflict name `<base> (conflict <contentHash>).<ext>`; the **canonical path stays deleted** (no resurrection). Deterministic; converges; does not use the two-hash ordering. [round-2 regressions]
- **(c) One-sided fresh adoption (row 11):** the side that exists is adopted as-is at the canonical path; no copy.

A conflict copy is thereafter an ordinary file (single origin); editing it later is a normal row-3 change.

### 6.5 Renames, restore, download integrity

- **Rename/move keeps the same `fileId`**; the new path goes into the encrypted meta and a **`renameHint = { oldPath → newPath }`** (same `fileId`) lets a peer apply a move (update its path⇄fileId index), not an independent delete+create. The blob is **not** re-uploaded. **Crash mid-rename** is recovered idempotently from the relay's renameHint + `B` keyed by `fileId` (never by path). [sync P0-4, crypto P1-3]
- **Restore-from-history** = materialize the old content as a **normal local edit** (write file → reconcile picks it up as row 3 → new commit pointing at the retained blob). Never edit the pointer underneath `B`. [sync P1-12]
- **Download integrity:** the AEAD tag is verified on every GET. A decrypt/auth failure is treated as **"blob unavailable" → fall back to the previous in-history version**, never write empty, never silent-corrupt. [sync P2-13]

### 6.6 Triggers & the freshness signal

- **Desktop:** fs-watch → debounce 2 s → reconcile. Every reconcile **re-fetches the DO's current `vaultVersion` at the start** (authoritative) and the client **polls it on an interval** independent of the WebSocket. WS push (`head → vN`) is a **latency optimization only**; on reconnect, always re-check. [sync P1-10]
- **Mobile (Decision #32):** foreground-reconcile on open/resume + APNs push wakes a foreground reconcile. No background sync.
- **Freeze detection** keys on **`vaultVersion` monotonic advance** (not wall-clock — there is no `ts` in the checkpoint to depend on): a frozen relay withholds version bumps it cannot forge (the log is append-only and monotonic). Staleness = "no `vaultVersion` advance within the expected window." **This requires ≥ 2 of the user's devices active in the window**; a single-device account cannot detect a freeze from the relay alone (the freeze residual, §7/§11). [round-3 read-skew/`ts` + single-device]

### 6.7 The local write path (atomic check-and-swap)

Remote→local writes (rows 4, 6, 7, 8, restore) go through a **core write path that reuses §7's path-safety mechanics** — canonicalize + containment + no-follow + re-validate-at-open — but is **not** the effects-gated Action broker (sync is a core subsystem, not an Action; §14 fidelity follow-up). The apply is an **atomic check-and-swap** so it cannot clobber a concurrent user edit: write temp → fsync → under fs-watch suppression, re-hash the on-disk target and proceed only if it still equals the expected-prior hash → atomic rename → fsync the directory. If the target changed, abort and re-classify (the true "local CAS" row 4 relies on). [sync P0-1]

**Pull-side crash atomicity:** the file is durably landed (temp → fsync → rename → dir-fsync) **before** `B` advances for that entry. On startup, any entry where `B` claims a hash but the on-disk file differs/absent is "not yet applied" and re-pulled (row 1 makes this safe). Mirrors the push-side `B` invariant. [round-3 completeness]

---

## 7. Security model & threat-model additions

- **T2 (MITM):** TLS 1.3 + certificate pinning (multi-pin rotation), per ARCHITECTURE §3 / THREAT_MODEL T2.
- **T3 (cloud breach):** a breach yields **opaque pointers + ciphertext + the E2EE recovery blob** — no contents, names, or tree. Residual: offline password-guessing, raised by client + server Argon2 + a strong-password policy. (T3's literal "even encrypted … rejected" wording needs the same reconcile #30 gave §3 — §14.)
- **Rollback / fork / mix / equivocation (malicious relay):** defeated by the **signed append-only log + monotonic checkpoints** + the **tuple floor** (a device rejects any served `headHash` that disagrees with its persisted `headHash` at a shared index — so an equal-version fork the device has evidence of is caught, §5.2), with the precise read-skew rule so honest concurrency is not misread as tamper. **Residuals:** (a) a fresh device with no prior state and no second live device must TOFU-trust the served head (genesis rollback) — mitigated by the provisioned-device floor (§4.1); (b) **cross-device equivocation with no shared evidence** (the relay shows two devices disjoint forks they can't compare) is the inherent non-ORAM residual, same as Proton/Mega. [crypto P0-2; round-3; round-4 equivocation]
- **Confirmation attack:** defeated by **keyed opaque `blobId`s**. [crypto P0-3]
- **Nonce-reuse forgery:** defeated by **XChaCha20-Poly1305**. [crypto P0-1]
- **Partitioning oracle** on the **recovery blob**: defeated by committing AEAD (the verifier is a server-side Argon2 hash, protected separately). [crypto P2-1]
- **Trash & conflict copies.** **Trash lives OUTSIDE the synced vault** (local-only quarantine) so a soft-delete never re-enters the sync set; deletes cross devices via the permanent tombstone (§9). **Per-platform trash root:** desktop = an app-data dir outside the vault; **iOS/Android = the app-private container** (e.g. `Library/Application Support/<app>/trash`, marked `isExcludedFromBackup`) — writable independently of the security-scoped vault folder. **If a writable out-of-vault location cannot be guaranteed** on a platform, the fallback is **tombstone-only delete with the recoverable copy fetched on-demand from 30-day history** (rows 6/7), never an in-tree trash file (which would resurrect) and never a silent destroy. **Conflict copies ARE in-tree and synced** (intended); their deterministic identity keeps that set convergent. [completeness; round-3 iOS trash]

> [!WARNING] New THREAT_MODEL row required — "relay/operator as adversary" (the honest residual)
> Even done perfectly, an E2EE blob relay learns the **shape** of a vault: blob **sizes** (≈ file sizes; mitigated by optional padding, §11), **file count**, **edit cadence / access patterns**, and **timing**. It learns **nothing** about contents, names, or tree. It can **freeze** (withhold the latest version) — undefeatable from an untrusted relay, detectable only with ≥ 2 active devices; mitigated by the `vaultVersion`-staleness check (§6.6) and documented as a residual (like the offline-revoke limitation in ARCHITECTURE §3). Inherent to non-ORAM E2EE storage (Proton Drive, Mega, etc.).
> **Marketing consequence (honesty):** we may claim _"we can never read your notes or even their names."_ We may **not** claim _"the relay learns literally nothing."_

This row is **distinct** from THREAT_MODEL T11 (BYOK consented egress, Decision #19) and from the MCP-write-server row (Decision #31, owned by `MCP_KB_CONTRACT.md`).

---

## 8. Worker API surface (v1)

All endpoints over TLS 1.3 + cert pinning; device-bound short-lived tokens (Decisions #6/#7); paid-tier + quota gated (§9), except checkpoint writes which are quota-exempt.

| Method + path                     | Purpose                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/login`             | auth secret → device-bound token; TOTP; relay verifies the server-side Argon2 stretch                             |
| `GET  /v1/head`                   | `{ vaultVersion, headHash, latest checkpoint }` + the `since`-delta in the **same DO read** (atomic snapshot)      |
| `GET  /v1/log?since={version}`    | log records since a version (client verifies chain + signatures up to the fetched head index)                      |
| `GET  /v1/entry/{fileId}`         | one pointer + its encrypted meta                                                                                   |
| `POST /v1/commit`                 | signed records (each with `prevEntryVersion`) → per-entry CAS + atomic log append; rejected entries returned; `413`/quota rejects leave `B` untouched (§9)                                                                  |
| `PUT  /v1/account`                | password change: new `wrappedVK` + rotated auth verifier, under an `accountVersion` CAS (§4.4); quota-exempt        |
| `PUT  /v1/checkpoint`             | a signed checkpoint (off the commit path; monotonic; quota-exempt)                                                 |
| `PUT  /v1/blob/{fileId}/{blobId}` | store ciphertext (immutable, idempotent)                                                                           |
| `GET  /v1/blob/{fileId}/{blobId}` | fetch ciphertext                                                                                                   |
| `WS   /v1/stream`                 | push `head → vN` (latency hint only; never source of truth)                                                        |

---

## 9. Storage lifecycle: history, GC, tombstones, quota

- **History:** immutable content-addressed blobs retain prior versions for free. **Default retention = 30 days** (or last-N per file), powering restore + conflict recovery.
- **`T` (GC grace period) = the pending-pin expiry, default 24 h** — a short safety margin distinct from the 30-day history window. A blob is GC-eligible only if **unreferenced ≥ T**, its **upload completed ≥ T ago**, and it is **not pinned**. [round-3 `T`]
- **GC root set (mark-and-sweep):** **the current head's full entry set, always, PLUS all entries within the 30-day history window, PLUS pinned in-flight blobs** — cited identically in §10 and §12. A blob referenced by the current head is **never** collectible. [sync P1-8; round-3 GC consistency]
- **Tombstones are permanent lightweight entries** (`fileId` + `deleted` marker, no blob) → an offline device always finds `R = Tombstone`, never `R = Missing` (sidesteps resurrection). The recoverable **trash copy** (outside the synced tree, §7) is purged after the history window; the marker persists. [sync P1-9]
- **Oversize (>50 MB):** the file stays **`unsynced (oversize)`** (a first-class `B` state); reconcile does not retry it until its `contentHash` changes. **On any `contentHash` change, re-evaluate the size threshold:** if now ≤ cap, clear the `unsynced` state atomically with the commit and process as row 3; if still > cap, refresh the surfaced "too large to sync (kept locally only)" notice. Never silently conflated with a synced file; never a retry livelock. [round-3 oversize]
- **Quota exceeded / tier lapse (distinct from oversize — retryable):** a quota-rejected commit **leaves `B` unchanged** (edits stay local + re-tryable) and surfaces a non-dismissable "sync paused — over quota" state; pending-pinned blobs from the failed attempt are **not** counted toward the wall that blocks the user. **Checkpoint writes remain allowed** (quota-exempt, §5.2) so the anti-rollback floor keeps advancing. On **paid-tier lapse**, relay data stays **readable/restorable** (read-only grace) and **local data is never touched**. [completeness; round-3]

---

## 10. Testing strategy

The reconcile/diff logic is a **pure function** `(L, B, R) → actions` — the engine's safety rests on it, tested exhaustively offline.

- **Reconcile truth table:** every `L × B × R` over `{Missing, Hash, Tombstone}` incl. all conflict/delete/rename/adoption/lost-tombstone rows (§6.2), each asserting "no silent loss."
- **Crypto round-trips:** XChaCha20-Poly1305 encrypt→relay-shape→decrypt; **immutable-blob AAD is version-stable** (`suiteId‖fileId‖blobId‖keyEpoch`) so `blobId` determinism + idempotent PUT + restore hold, while **mutable-meta AAD rejects wrong `entryVersion`**; suite-byte rejection; committing-AEAD check (recovery blob); Argon2 param pinning.
- **Signed log under concurrency:** N devices each commit a **distinct** file concurrently → **zero head rejections, zero retries**; chain verification + anti-rollback (reject lower version / broken chain / bad sig); **a head/log read-skew (trailing records beyond the fetched head) reads as benign re-fetch, NOT tamper**; checkpoint monotonicity (DO rejects regressing checkpoint).
- **Password change (O(1) re-wrap):** a change re-wraps `VK` + rotates the verifier under an `accountVersion` CAS; **`VK`/`SK`/blobs/log are unchanged** (another device keeps working after re-login); two concurrent changes → one wins the CAS, the loser retries, **no data touched**; recover-from-mnemonic → set-new-password works. (Full `VK` rotation / re-encrypt is a v1.1 surface — not tested here.)
- **Genesis / bootstrap:** a fresh device with a provisioned-device floor rejects a stale checkpoint below the floor; the mnemonic-only path surfaces the TOFU residual; `recoverySalt` recovers `KEK` and decrypts the recovery blob.
- **Malicious-relay harness:** rollback, fork/mix, **equal-version equivocation** (a device served a `headHash` that disagrees with its persisted one at a shared index), stale-head, stale-checkpoint, swapped-salt, param-downgrade all **detected**.
- **GC:** mark-sweep roots from current head **+ history window + pins**; pin protects in-flight; permanent tombstones prevent resurrection.
- **Crash atomicity:** pull-side (file lands before `B` advances; interrupted pull re-pulls); interrupted rename re-derives from renameHint + `B`-by-`fileId`; oversize/quota leave `B` correct.
- **Mobile:** trash in the app-private container is writable independently of a security-scoped vault; the tombstone-only fallback recovers from history.
- **Integration:** miniflare / workerd for Worker + DO + R2; an in-memory fake relay for client e2e.
- **Property test (the core invariant):** random multi-device edit/delete/rename sequences across 2–3 devices always **converge**, **never lose data**, and the relay **cannot tamper undetectably**.

---

## 11. Risks & deferred items

- **Password entropy is load-bearing** — the whole vault reduces to it. Mitigated by client+server Argon2 + an enforced strength policy; documented honestly.
- **Metadata residual** (sizes/count/cadence/timing) is real and inherent (§7). **Recommended v1.1:** pad blob sizes.
- **Freeze attack** is undefeatable from an untrusted relay and detectable only with ≥ 2 active devices — documented residual.
- **Genesis rollback residual:** a first device with no prior state and no second device must TOFU-trust the served head (§5.2/§7) — closed by the provisioned-device floor when a second device exists; disclosed otherwise.
- **Fresh-install KDF-param bootstrap** has an out-of-band residual (§4.1) — closed via recovery mnemonic / existing device, else surfaced TOFU.
- **Password change is O(1)** (re-wrap a stable `VK`, no data re-encrypt — §4.4). The heavy operation is a genuine **`VK` rotation** (suspected compromise = full re-encrypt), **deferred to v1.1**; the un-retrofittable `keyEpoch` seam ships now so it bolts on without a migration.
- **Cross-device equivocation with no shared evidence** is the inherent non-ORAM residual (§7) — a device catches a fork only when it holds a contradicting `headHash` for a shared index.
- **Single-vault, full-mirror v1**; selective sync / multi-vault deferred (§2).
- **Whole-file blobs** — any edit re-uploads the whole file (fine for markdown; 50 MB cap with an explicit `unsynced` disposition, §9). Block + cross-file dedup deferred.

---

## 12. Review coverage map — round 1 (the 25 findings → where resolved)

| Finding (review)                                        | Severity    | Resolved in                                       |
| ------------------------------------------------------ | ----------- | ------------------------------------------------- |
| Base manifest `B` atomicity / loss                     | sync P0-2   | §6.2 (`B` invariant + idempotent row 1)           |
| Incomplete reconcile table (delete×edit, create×create) | sync P0-4   | §6.2 (full table) + §6.5 rename hint              |
| Conflict storm / non-convergence                       | sync P0-3   | §5.1 + §6.4 (deterministic identity + name)       |
| Local TOCTOU on remote-write                           | sync P0-1   | §6.7 (atomic check-and-swap = local CAS)          |
| Whole-manifest CAS livelock                            | sync P0-5   | §5.2 + §6.3 (signed log + per-entry CAS)          |
| Case-insensitive FS collisions                         | sync P1-6   | §6.1 (case policy + collision index)              |
| Cross-platform path encoding                           | sync P1-7   | §6.1 (NFC + forward-slash + vault-relative)       |
| GC deletes live/in-flight blob                         | sync P1-8   | §6.3 (pinning) + §9 (root = head + window + pins)  |
| Tombstone resurrection                                 | sync P1-9   | §9 (permanent tombstones) + §6.2 rows 9/10/12      |
| WS push as sole freshness                              | sync P1-10  | §6.6 (DO `vaultVersion` is source of truth)       |
| Fresh-install / adoption undefined                     | sync P1-11  | §6.2 row 11 + §6.4c                               |
| Restore-from-history undoes itself                     | sync P1-12  | §6.5 (restore = normal local edit)                |
| Partial blob / decrypt-fail handling                   | sync P2-13  | §6.5 (fall back to prior version)                 |
| #29 doc contradiction (block-LWW)                      | sync P2-14  | §3 + §13 S1 + §14 (amend #29)                     |
| GCM nonce reuse at scale                               | crypto P0-1 | §4.2 (XChaCha20-Poly1305)                         |
| No freshness / rollback binding                        | crypto P0-2 | §5.2 (signed append-only log + checkpoints)       |
| Plaintext content-hash confirmation                    | crypto P0-3 | §5.1 (keyed opaque `blobId`)                      |
| auth/vault offline-guess surface                       | crypto P1-1 | §4.1 (server-side Argon2 stretch + policy)        |
| Argon2 salt / param downgrade                          | crypto P1-2 | §4.1 (pinned + checkpoint-bound + bootstrap path) |
| Deterministic `HMAC(path)` fingerprint                 | crypto P1-3 | §5.1 (random `fileId`) + §6.5 (stable on rename)  |
| Recovery-blob KDF strength                             | crypto P1-4 | §4.3 (Argon2id over mnemonic, not BIP-39 PBKDF2)  |
| AEAD not key-committing (partition oracle)             | crypto P2-1 | §4.2 (committing AEAD for the recovery blob)      |
| No AAD context binding                                 | crypto P2-2 | §4.2 (mutability-scoped AAD)                      |
| No crypto-agility versioning                           | crypto P2-3 | §4.2 (suite byte)                                 |
| Monolithic manifest write-amplification                | crypto P2-4 | §5.2 (per-file meta + per-entry pointers)         |

## 12b. Verification coverage — round 2 (29-agent pass)

| Issue (verification)                                                      | Resolved in                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Keystone:** per-entry CAS vs client-signed full-set root contradiction | §5.2 + §6.3 (signed append-only log)                    |
| AAD binds `vaultVersion` → breaks immutable-blob restore                  | §4.2 (version-binding scoped to the mutable layer)      |
| Conflict copies mint different random `fileId`s → never converge          | §5.1 (deterministic conflict-copy `fileId`) + §6.4      |
| `short-contentHash` name collisions                                       | §6.4 (full hash + deterministic de-collision)           |
| §6.4 ordering undefined when one side is Missing                          | §6.4b                                                   |
| `renameHint` contradicted stable `fileId`                                 | §5.1 + §6.5 (stable `fileId`; renameHint is path-only)  |
| `B` keyed by `fileId` but reconcile per path; no local index             | §6.2 (explicit fsync'd path⇄fileId index)               |
| No password-change / key-epoch protocol                                  | §4.4 (O(1) re-wrap; superseded by round-4 §4.1 key model) |
| Oversize 50 MB disposition undefined                                     | §9 + §6.2 (`unsynced (oversize)` state)                 |
| Quota / tier-lapse semantics undefined                                   | §9                                                      |
| Pull-side crash atomicity                                                | §6.7                                                    |
| Trash placement / resurrection loop                                      | §7 (trash outside the synced tree)                      |
| Freeze heartbeat depends on wall-clock                                   | §6.6 (`vaultVersion` monotonicity)                      |
| Recovery-blob binding to `vaultVersion` would stale it                   | §4.3 (bound to the immutable account record; written once) |
| `SK` parent stated two ways                                              | §4.1 (canonical: `SK` from `VK`)                        |
| Tombstone retention bound undefined                                      | §9 (permanent tombstones) + §6.2 row 12                 |
| `T` undefined / GC root inconsistent / "14 findings" / scope overstated  | §9, §0 (25 findings; amends #3+#29+T3+#31)              |

## 12c. Re-verification coverage — round 3 (6-agent keystone pass)

| Issue (re-verification)                                       | Severity | Resolved in                                                |
| ------------------------------------------------------------ | -------- | ---------------------------------------------------------- |
| Interrupted re-encrypt → mixed-epoch loss                    | P0       | superseded by round-4 key-model rework (§4.1/§4.4 — no re-encrypt on password change) |
| Head/log read-skew misread as tamper                         | P1       | §5.2 (verify up to fetched head index) + §8 (atomic snapshot) |
| Fresh-device genesis rollback                                 | P1       | §4.1 (provisioned-device floor) + §5.2/§7/§11 (residual)   |
| `recoverySalt` undefined                                     | P1       | §4.3 + §5.2 (in account record + recovery header)          |
| "intra-account dedup" contradicts fileId-namespaced blobs    | P1       | §5.1 (dedup dropped; idempotent PUT kept)                  |
| Checkpoint `ts` dangling                                     | P1       | §6.6 (`ts` removed; freshness = `vaultVersion`)            |
| §6.2 lumps over-quota into `unsynced`                        | P1       | §6.2 + §9 (oversize vs retryable over-quota split)         |
| iOS trash location unsatisfiable                             | P1       | §7 (app-private container + tombstone-only fallback)       |
| §0 scope undercount                                         | P1       | §0 (#3 + #29 + T3 + #31)                                   |
| `entryVersion` not cached in `B`; DO atomicity; checkpoint monotonicity; epoch-coverage asymmetry; verifier-AEAD wording; single-device freeze; row-11/§6.4c completeness; §1 "refined"→"amended"; §6.2 verb wording; Argon2 §2 divergence | P2 | §6.2, §5.2, §6.6, §7, §1, §14 (folded throughout)         |

## 12d. Re-verification coverage — round 4 (final 3-agent check)

| Issue (final check)                                                                 | Severity | Resolved in                                                |
| ---------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| **Key-model rework:** the whole re-encrypt P0 cluster (resume-needs-VK_new, concurrent-init, verifier-rotation, epoch-dispatch) came from `VK = HKDF(password)` | P0×2 + P1×2 | §4.1 (random `VK` wrapped under `KWK`) + §4.4 (password change = O(1) re-wrap; `VK` rotation deferred to v1.1) |
| Equal-version fork / equivocation not in the tamper set                             | P1       | §5.2 (tuple floor: `headHash`-mismatch at a shared index = tamper) + §4.1 (floor) + §7 |
| Provisioned-device floor was version-only                                           | P1       | §4.1 (compare `headHash` at the pinned version)            |
| Optional `keyEpochTransition` hashing ambiguity                                     | P2       | dissolved — no transition field (account record is fixed-presence) |

---

## 13. Decision log (propagate condensed entries into `ARCHITECTURE.md §8`)

| #   | Decision                                                                                                                                                                       | Why                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| S1  | **Conflict model = whole-file + conflict-copy** (never auto-merge, never lose). **Amends ARCHITECTURE #29** — kill "block-level LWW."                                          | Block-level LWW can corrupt or drop edits; whole-file + conflict-copy never loses data and converges (§6.4).  |
| S2  | **Key model = a random `VK` wrapped under a password-derived `KWK`** (true Bitwarden shape); `VK` is stable + never leaves the device; server stores a server-side Argon2 stretch of the auth secret.        | Single-secret UX + zero-knowledge; a stable `VK` makes password change an O(1) re-wrap (S11) and raises offline-guess cost. |
| S3  | **Identity = random per-file `fileId`** (deterministic for conflict copies); versions keyed by opaque `blobId = HMAC(K_obj, contentHash)`; paths encrypted.                   | Names are the KB's TOC; random IDs make renames invisible and close the known-file confirmation attack.       |
| S4  | **Content/metadata cipher = XChaCha20-Poly1305** (extended nonce) + mutability-scoped AAD + suite byte; committing AEAD for the recovery blob.                                | Defeats nonce-reuse-at-scale, slot/version replay, partitioning oracles; gives crypto-agility.                |
| S5  | **Anti-rollback = signed append-only operation log + monotonic checkpoints** (Ed25519 from `VK`); the DO appends/linearizes atomically without a key.                        | AEAD proves confidentiality+integrity, not freshness; the log gives freshness AND scales (no full-set re-sign). |
| S6  | **Coordination = per-user Durable Object** doing per-entry CAS over a relay-visible opaque pointer layer, atomically with the log append; per-file encrypted meta.            | Scales multi-device editing without losing zero-knowledge or re-encrypting the world.                         |
| S7  | **Reconcile = pure 3-way (`L,B,R`) function with a complete truth table**; `B` advances only to a DO-confirmed version (never regresses); idempotent re-converge on `L==R`.   | The engine's safety rests here; completeness + `B` discipline kill every silent-loss path.                    |
| S8  | **Canonical path form (NFC, forward-slash, vault-relative) + explicit case policy** + a local path⇄fileId index; OS-native only at the write path.                            | Prevents same-file-two-IDs and case-only data loss across Windows/macOS/Linux/iOS.                            |
| S9  | **GC mark-and-sweep rooted from current head + history window + pins; permanent tombstones; trash outside the synced tree; explicit oversize/quota dispositions.** | Prevents the relay deleting live content, delete-resurrection, and silent loss at the storage limits.         |
| S10 | **New THREAT_MODEL row: relay/operator as adversary** — learns vault shape, never contents/names; can freeze, cannot roll back. Honest marketing boundary.                    | Keeps the zero-knowledge claim defensible and the residual honest.                                            |
| S11 | **Password change = O(1) re-wrap** of the stable `VK` + verifier rotation under an `accountVersion` CAS — no data re-encrypt, no signing-key change, no epoch transition. A genuine `VK` rotation (compromise = full re-encrypt) is deferred to v1.1; the `keyEpoch` seam ships now (fixed at 0) so it bolts on without a migration. | A random wrapped `VK` (S2) makes the common case trivial and removes the whole crash-safe-re-encrypt failure class; the rare compromise case keeps an un-retrofittable seam. |

---

## 14. Follow-ups (separate PRs — propagation is a blocking close-out)

These must land in the **same change-set** that flips this spec from "design locked" to "in implementation," so the canonical decision logs are never the stale source of truth for an in-flight build:

- **Amend ARCHITECTURE Decision #29** → whole-file + conflict-copy (S1); propagate S1–S11 into §8.
- **Amend ARCHITECTURE Decision #3 + the §3 reconcile callout** → the sync-blob cipher is **XChaCha20-Poly1305** (extended-nonce), distinct from the AES-256-GCM local-at-rest path; `"or ChaCha20-Poly1305"` does not cover XChaCha20.
- **Add a scoping note to ARCHITECTURE §2** → the sync path pins authenticated Argon2 params; "do not hand-tune" applies to the local at-rest path only.
- **Add the relay/operator-adversary row to `THREAT_MODEL.md`** (S10) — alongside the still-pending T11 (BYOK egress) and the MCP-write-server row (Decision #31).
- **Reconcile `THREAT_MODEL.md` T3 + Core principle** the way ARCHITECTURE §3 was reconciled by #30: "secret" means relay-recoverable; an E2EE blob the relay cannot decrypt (recovery blob, content blobs) is permitted.
- **Reconcile ARCHITECTURE Decision #31's "every write through the §7 broker"** with an unscoped core sync writer: define the vault root as a first-class host **write-scope** that both the §7 Action broker and the core sync write path target, sharing the path-safety mechanics (§6.7) — the sync path is not effects-gated.
- `MCP_KB_CONTRACT.md` is its own spec (Decision #31) — the local MCP server is the agent-interop path, not part of the sync engine.
