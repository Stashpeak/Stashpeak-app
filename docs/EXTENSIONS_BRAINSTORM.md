# Stashpeak App — Extensions / Plugins Architecture Brainstorm

**Status:** Brainstorm (not a decision doc — pre-spec)
**Created:** 2026-05-21
**Trigger:** Inspirován Chase AI "Agentic OS" Obsidian Command Center video — custom plugin uvnitř Obsidianu co triggeruje LLM skills + renderuje dashboard. User chce stejnou volnost dát do **Stashpeak App** místo stavění úplně nového nástroje (jako byl plán pro Stashpeak Vault).
**Stashpeak Vault přehodnocení:** User: "nedava mi to smysl delit spise pridat moznosti neco jako extensions do stashpeak-app". Vault funkce může jít jako built-in nebo jako extension uvnitř stashpeak-app, ne separate sibling app.

---

## 1. Co už je locked (z internal-docs)

Z `internal-docs/stashpeak-app/ARCHITECTURE.md` Section 4:

- **v1 connectors:** First-party only, compiled into agent nebo signed bundles. Initial set: Docker, OpenAI, Anthropic, OpenRouter, LM Studio, Obsidian, HAOS.
- **v2 connectors:** Community, WASM sandbox přes **Extism**. Manifest s permission deklarací, capability-based security, user approval at install.
- **Distribution:** První party ship s agentem; community via signed registry; unsigned refuse to load.
- **Implementační framework:** `SpendConnector` trait existuje (`src-tauri/src/connectors/spend/openrouter.rs`), async, retry support.

Decision Log #8: "v1 connectors first-party only; v2 community with WASM sandbox" — **locked 2026-04-08**.

Open item z architecture (Section 7): **"Community connector sandbox design"** — to je přesně tahle brainstorm.

## 2. Vocabulary clarification (vyřešit první)

Aktuálně se míchá. Návrh terminologie:

| Term | Co to je | Příklad |
| --- | --- | --- |
| **Connector** | Backend data adapter — talks to external API, returns structured data | OpenAI spend connector, Docker monitor, HAOS sensor reader |
| **View** | Frontend UI panel — render dashboard data v konkrétní podobě | Subscriptions table, Visual Map, Spend chart, Token burn meter (Chase-style) |
| **Action** | Button/command co spustí workflow — možná zavolá LLM nebo connector chain | "Morning Brief", "Pull Metrics", "Inbox Triage" (Chase-style buttons) |
| **Extension** | Bundle co může obsahovat jeden nebo více Connectors / Views / Actions | "Content Creator Pack" = YouTube connector + audience view + plan-tomorrow action |

**Decision needed:** Souhlasíme s touto terminologií? Pokud ano, ARCHITECTURE.md update + glossary entry.

## 3. Tři vrstvy plugin systému

ARCHITECTURE.md má jen Connectors. Tvůj nápad přidává **Views** a **Actions**. Brainstorm pro každou:

### 3a. Connectors (existuje, jen rozšiřuje)

- Sandbox model už locked: WASM + Extism, manifest, capability scope
- Q: má smysl mít connector co je víc než data fetcher? Např. **bidirectional connector** (read + write back, jako "Send Discord message")?
- Q: kde žije retry/error handling — v connector kódu (každý sám) nebo v frameworku (sdíleně)?

### 3b. Views (NEW)

UI panely co renderují data. Otázky:

- **Render technologie:**
  - **Web components / custom elements** — extension dodá HTML/CSS/JS bundle, app ho mountne. Nejflexibilnější, ale security risk (každý view může utéct ze své zóny).
  - **JSON schema → app-rendered components** — extension deklaruje "ukaž stat hero s value=X, label=Y", app renderuje. Bezpečnější, omezenější.
  - **React component bundle** — typed, performant, ale tight coupling na React version.
- **Doporučení k brainstormu:** start s **JSON schema approach** pro v1 (omezený palette komponent: stat hero, table, chart, list, action button). Web components/React jako v2 pro power users.
- **Permission model:** view = read-only data access (z connectors). Žádný side-effect.

### 3c. Actions (NEW)

Buttony / commands co spustí workflow.

- **Action types:**
  - **LLM action** — pošle prompt + context do user-configured LLM, vrátí markdown / structured output. (Chase model.)
  - **Connector chain** — propojí 2+ connectors, např. "Pull GitHub trending → format → write to docs/research.md"
  - **Workflow** — multi-step s if/then logic
- **Trigger model:**
  - **Sync** — uživatel klikne, čeká na výsledek (do 10 s typicky)
  - **Async** — long-running, push notification když hotovo
  - **Scheduled** — cron-style ("denně v 7:00")
- **Cost / quota:** action může pálit LLM tokens — UI musí ukázat estimated/actual cost. Per-extension budget cap?
- **Permission model:** action si v manifestu vyžádá které connectors / data scopes potřebuje; user approves at install.

## 4. Official vs Community

| Model | Pros | Cons |
| --- | --- | --- |
| **Officiální only** | Quality control, security audit, brand consistency | Pomalý growth, závisí na tobě, neuživí ekosystem |
| **Community + signed** | Ekosystem, faster iteration, monetizace přes marketplace | Security risk, support burden, review queue |
| **Hybrid (doporučeno)** | Core extensions oficiální + community na vlastní riziko (s warningy) | Hraniční extensions = unclear support |

**Doporučení k brainstormu:** v1 = officiální only (rychlejší build, validate use cases), v2 = open community s manifestem + WASM sandbox per existing architecture decision. **Tohle už LOCKED v Decision Log #8** — jen extending coverage z connectors na views/actions.

**Open Q:** community extensions = free distribution (jako Obsidian plugins) nebo paid marketplace (jako VS Code Marketplace zatím free, ale možné v budoucnu)?

## 5. Manifest format (rozšíření současného sketch)

Existující v ARCHITECTURE.md je connector-only. Návrh expansion:

```yaml
name: content-creator-pack
version: 1.0.0
author: shieldxx
license: MIT
type: extension              # nový top-level type

# Co tahle extension dodává:
provides:
  connectors:
    - id: youtube-analytics
      permissions:
        - network: googleapis.com
        - storage: read:youtube-channel-id
      credentials:
        - { type: oauth2, label: "YouTube Data API" }

  views:
    - id: youtube-stats-hero
      slot: dashboard.metric-cards    # kde v UI se mountne
      schema: stat-hero               # použije app-rendered component
      data_source: youtube-analytics  # který connector pulluje

  actions:
    - id: plan-tomorrow-yt
      label: "Plan Tomorrow"
      icon: calendar
      trigger: button                 # button | scheduled | event
      runs:
        - llm: claude-haiku
          prompt: "..."
          context:
            - connector: youtube-analytics
            - file: daily-note
          output:
            - write_file: "outputs/{date}-yt-plan.md"
      cost_estimate: ~5000 tokens

# Sandbox & security
permissions_required:
  - network: googleapis.com
  - llm: claude-haiku            # which LLMs allowed
  - file_write: outputs/         # which paths writable
  - storage: 10MB

# Discoverability
category: content-creation
tags: [youtube, analytics, planning]
description: "..."
```

**Open Qs:**
- Pasted YAML, nebo TOML jako Tauri prefers? Nebo JSON pro web compatibility?
- Versioning & dependency model — extensions na sobě závislé (např. dva potřebují stejný connector)?
- Update mechanism — extension auto-update or user-approved?

## 6. Mobile / Tauri 2 mobile compatibility

Tauri 2 supports mobile (iOS/Android) — viz `package.json` `@tauri-apps/api ^2`. Pokud Stashpeak Tauri mobile build je v roadmapě:

- **Connectors:** Rust code → fine pokud nemají Linux-specific deps
- **Views:** JSON schema → fine; React component bundles možná restrict
- **Actions:** LLM calls fine; shell commands ne (mobile sandboxing)
- **WASM sandbox:** Extism má mobile runtime — solid choice

**Open Q:** je mobile cíl pro v1 / v2 / nikdy? Ovlivňuje to view technologii (web components = mobile OK, shell-dependent = ne).

## 7. Stashpeak Vault rozhodnutí

User: "nedava mi to smysl delit spise pridat moznosti neco jako extensions do stashpeak-app".

Vault scope = AI context backup / migration / compression. Možnosti:

- **A: Vault jako built-in feature** stashpeak-app (component "AI Context Backup" v sidebar)
- **B: Vault jako oficiální extension** — first-party extension co ship s app, ale loaduje se přes extension systém (eat your own dog food)
- **C: Vault zůstává separate browser util** + stashpeak-app může mít extension co s ním integruje (worst of both)

**Doporučení k brainstormu:** **Volba B** — Vault = první "flagship" oficiální extension. Validates extension architecture (pokud Vault jde napsat jako extension, framework je dost flexibilní). Zachovává multi-format support (Vault funkce = output exporty) bez nutnosti separate app/web/domain.

Implication: dropnout `vault.stashpeak.com` subdomain plán, dropnout separate repo `stashpeak-vault` (folder zůstane jako historický CHANGELOG / strategy reference, ale active dev jde do `stashpeak-app/extensions/vault/`).

## 8. Otevřené otázky pro nový Claude Code session

Až otevřeš nové okno v `stashpeak-app` workspace, hand off these:

1. **Vocabulary lock** — souhlasíme s Connector / View / Action / Extension rozdělením? (Sekce 2)
2. **View technology pick** — JSON schema first, React/Web Components later? Nebo skip rovnou na flexibility? (Sekce 3b)
3. **Action runtime model** — synchronous-only v1, async/scheduled v2? (Sekce 3c)
4. **Manifest format** — YAML vs TOML vs JSON? (Sekce 5)
5. **Mobile commitment** — restricts view technology choices (Sekce 6)
6. **Vault folding** — A / B / C? Doporučeno B. (Sekce 7)
7. **MVP scope** — který first extension postavit jako proof of concept? Vault? Nebo něco menšího (např. "Local Markdown viewer" jako extension co ukáže že architecture works)?
8. **Permission UX** — jak user approves install? Modal s permission list? Implicit pro oficiální, explicit pro community?
9. **Extension storage** — kde žijí installed extensions? `%APPDATA%/Stashpeak/extensions/` per-user? Bundled v signed archive?
10. **Update flow** — extension manifest říká `version` — kdo checks for updates? App sám, nebo extension polluje update endpoint?

## 9. Suggested next steps (nestavět všechno najednou)

1. **Vyřešit vocabulary + manifest format** (dokument decision)
2. **Postavit minimální extension loader** v Rustu — read manifest, load WASM, expose 1 connector capability. **No view / action yet.** Validates technical foundation.
3. **První oficiální extension = "Hello World"** — jen connector co vrátí static string. Test sandbox + install flow.
4. **Druhá extension = jeden ze stávajících built-in** přepsaný jako extension (např. OpenRouter spend) — validates že extension API je dost mocné nahradit core code.
5. **Třetí extension = Vault MVP** — validates views/actions vrstvy.
6. **Otevři community** až je interní eating-our-own-dog-food potvrzené.

## 10. References / context pro novou session

Při handoff do nového Claude Code sessionu v `stashpeak-app` workspace, attach:

- `internal-docs/stashpeak-app/ARCHITECTURE.md` — Section 4 connector design už hotová
- `internal-docs/stashpeak-app/PRODUCT.md` — three feature categories (local-first / cloud-required / hybrid) — extensions musí toto respektovat
- `internal-docs/stashpeak-app/THREAT_MODEL.md` — security baseline
- `internal-docs/stashpeak-app/MVP.md` — current MVP scope
- Tento dokument (`docs/EXTENSIONS_BRAINSTORM.md`) — co brainstormujeme

**Z KB (Obsidian vault):**

- Private strategy / project notes in the founder's personal knowledge base (paths omitted).

---

**Status po brainstormu:** Až vyřešíš výše uvedené open otázky, převeď do formálního `EXTENSIONS_SPEC.md` který půjde rovnou implementovat. Decision Log entries do `ARCHITECTURE.md` Section 8.
