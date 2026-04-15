CREATE TABLE IF NOT EXISTS product_visibility (
    product_id TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1
);
