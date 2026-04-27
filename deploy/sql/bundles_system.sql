-- Migration: Bundles topup system
-- Creates bundles table and adds bundle-related columns to payments

CREATE TABLE IF NOT EXISTS bundles (
  id             TEXT         PRIMARY KEY,
  name           TEXT         NOT NULL,
  credits        INTEGER      NOT NULL,
  bonus_credits  INTEGER      NOT NULL DEFAULT 0,
  price_usd      DECIMAL(12,4) NOT NULL,
  discount       INTEGER      NOT NULL DEFAULT 0,
  is_limited     BOOLEAN      NOT NULL DEFAULT false,
  limit_total    INTEGER,
  purchase_count INTEGER      NOT NULL DEFAULT 0,
  is_active      BOOLEAN      NOT NULL DEFAULT true,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS bundle_id      TEXT REFERENCES bundles(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credits_granted INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bonus_credits   INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS method          TEXT;
