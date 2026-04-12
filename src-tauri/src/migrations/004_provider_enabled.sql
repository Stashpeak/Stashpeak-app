-- migrations/004_provider_enabled.sql
ALTER TABLE provider_spend ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
