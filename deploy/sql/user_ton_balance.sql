-- Add internal TON balance to users for App Store token creation
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "ton_balance" DECIMAL(18, 9) NOT NULL DEFAULT 0;

-- Track token-creation status on app_token: locked once user creates the token
-- (we already have status enum; just ensure the field exists for the new flow)
ALTER TABLE "app_tokens"
  ADD COLUMN IF NOT EXISTS "creation_paid_at" TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS "creation_locked_liquidity_ton" DECIMAL(18, 9) NULL;

-- App Store-specific avatar override (separate from the bot avatar)
ALTER TABLE "app_listings"
  ADD COLUMN IF NOT EXISTS "app_logo_filename" VARCHAR(255) NULL;
