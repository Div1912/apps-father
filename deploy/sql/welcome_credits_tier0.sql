-- Welcome credits + tier_0 migration
-- Run once on dev and prod.

-- 1. Ensure columns exist (idempotent — safe to re-run)
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS performance_tier TEXT NOT NULL DEFAULT 'tier_1';

-- 2. Change column defaults to match new schema
ALTER TABLE users ALTER COLUMN credits SET DEFAULT 100;
ALTER TABLE users ALTER COLUMN performance_tier SET DEFAULT 'tier_0';

-- 3. (One-time) Convert existing USD balance → credits (50 credits per $1).
--    Guarded by a marker table so this block runs exactly once across all deploys.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = '_welcome_credits_v1_done') THEN

    -- Convert USD balance to credits (merge with any existing credits).
    UPDATE users
    SET credits = credits + GREATEST(0, FLOOR((balance)::numeric * 50)::int)
    WHERE balance > 0;

    -- Reset USD balance to 0 (already converted to credits).
    UPDATE users SET balance = 0 WHERE balance > 0;

    -- Set all existing users to tier_0 (new default starter tier).
    UPDATE users SET performance_tier = 'tier_0';

    CREATE TABLE _welcome_credits_v1_done (applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  END IF;
END
$$;
