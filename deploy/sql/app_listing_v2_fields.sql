-- Add new fields to app_listing for PF2 (single-form publish flow)
ALTER TABLE "app_listings"
  ADD COLUMN IF NOT EXISTS "app_name" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "initial_liquidity_ton" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "translations" JSONB;
