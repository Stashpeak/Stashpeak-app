CREATE TABLE IF NOT EXISTS subscription_link_overrides (
    subscription_id INTEGER PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
    suppress_link   INTEGER NOT NULL DEFAULT 1
);
