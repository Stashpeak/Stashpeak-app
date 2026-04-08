-- ============================================================
-- Subscriptions
-- Tracks recurring AI-related subscriptions (ChatGPT Plus, etc.)
-- ============================================================
CREATE TABLE subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    provider        TEXT    NOT NULL DEFAULT '',
    monthly_cost    REAL    NOT NULL,           -- stored in original currency
    currency        TEXT    NOT NULL DEFAULT 'USD',
    billing_period  TEXT    NOT NULL DEFAULT 'monthly', -- 'monthly' | 'yearly'
    next_billing_at TEXT,                       -- ISO-8601 date string
    category        TEXT    NOT NULL DEFAULT 'ai',
    notes           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ============================================================
-- Docker containers
-- One row per known container (persists across restarts).
-- ============================================================
CREATE TABLE docker_containers (
    container_id    TEXT    PRIMARY KEY,        -- Docker short ID
    name            TEXT    NOT NULL,
    image           TEXT    NOT NULL,
    is_ai_detected  INTEGER NOT NULL DEFAULT 0, -- 1 if auto-detected as AI service
    is_ai_manual    INTEGER NOT NULL DEFAULT 0, -- 1 if user manually tagged as AI
    last_seen_at    TEXT,                       -- ISO-8601, updated each poll
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ============================================================
-- Docker snapshots
-- Periodic status snapshots for the 30-day uptime chart.
-- ============================================================
CREATE TABLE docker_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id    TEXT    NOT NULL REFERENCES docker_containers(container_id) ON DELETE CASCADE,
    snapped_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    status          TEXT    NOT NULL,           -- 'running' | 'exited' | 'paused' | ...
    cpu_percent     REAL,
    memory_mb       REAL
);

CREATE INDEX docker_snapshots_container_time
    ON docker_snapshots(container_id, snapped_at);

-- ============================================================
-- Provider spend (current state per provider)
-- ============================================================
CREATE TABLE provider_spend (
    provider            TEXT    PRIMARY KEY,    -- 'anthropic' | 'openai' | 'openrouter' | 'groq'
    current_month_usd   REAL,
    previous_month_usd  REAL,
    last_fetched_at     TEXT,                   -- ISO-8601
    is_stale            INTEGER NOT NULL DEFAULT 0  -- 1 if last fetch failed
);

-- ============================================================
-- Provider spend history
-- Daily data points for the 30-day trend chart.
-- ============================================================
CREATE TABLE provider_spend_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT    NOT NULL,
    date        TEXT    NOT NULL,               -- ISO-8601 date 'YYYY-MM-DD'
    spend_usd   REAL    NOT NULL,
    UNIQUE(provider, date)
);

-- ============================================================
-- Map nodes
-- Each node in the visual ecosystem map.
-- ============================================================
CREATE TABLE map_nodes (
    id          TEXT    PRIMARY KEY,            -- UUID
    node_type   TEXT    NOT NULL,               -- 'container' | 'subscription' | 'provider' | 'external'
    label       TEXT    NOT NULL,
    category    TEXT    NOT NULL DEFAULT 'other', -- 'llm' | 'local_model' | 'vector_db' | 'orchestration' | 'tooling' | 'subscription'
    pos_x       REAL    NOT NULL DEFAULT 0,
    pos_y       REAL    NOT NULL DEFAULT 0,
    data_json   TEXT    NOT NULL DEFAULT '{}',  -- extra node-specific metadata
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ============================================================
-- Map edges
-- Connections between nodes.
-- ============================================================
CREATE TABLE map_edges (
    id              TEXT    PRIMARY KEY,        -- UUID
    source_id       TEXT    NOT NULL REFERENCES map_nodes(id) ON DELETE CASCADE,
    target_id       TEXT    NOT NULL REFERENCES map_nodes(id) ON DELETE CASCADE,
    is_auto         INTEGER NOT NULL DEFAULT 0, -- 1 = detected from env vars, 0 = manual
    label           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
