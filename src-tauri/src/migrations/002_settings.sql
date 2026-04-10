CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('notification_days_before', '3');

-- Tracks which subscriptions have already been notified for a given billing date,
-- preventing duplicate notifications on every app launch within the same billing cycle.
CREATE TABLE notification_log (
    subscription_id INTEGER NOT NULL,
    billing_date    TEXT    NOT NULL,
    notified_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (subscription_id, billing_date)
);
