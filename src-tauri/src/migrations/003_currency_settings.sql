-- ============================================================
-- Exchange rates: manually entered by user
-- Stores conversion rates between subscription currencies and the home currency.
-- Example: from_currency='USD', to_currency='CZK', rate=25.5
--          means 1 USD = 25.5 CZK
-- ============================================================
CREATE TABLE IF NOT EXISTS exchange_rates (
    from_currency TEXT NOT NULL,
    to_currency   TEXT NOT NULL,
    rate          REAL NOT NULL CHECK (rate > 0),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (from_currency, to_currency)
);
