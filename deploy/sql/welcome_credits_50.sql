-- Welcome credits 100 → 50 migration
--
-- Two changes, idempotent and re-deploy safe:
--   1. Lower the column default from 100 → 50 so all newly-created users
--      receive 50 credits going forward.
--   2. (One-time) Reduce existing users with credits = 100 down to 50.
--      Guarded by a marker table so the bulk update runs exactly once
--      across all deploys (re-running this script is a no-op).
--
-- Rationale: previous welcome bonus of 100 credits was too generous for
-- the freemium funnel and harmed conversion to first deposit. 50 credits
-- still lets users complete an initial app build but nudges them toward
-- top-up sooner.

-- 1. Lower the column default for new signups.
ALTER TABLE users ALTER COLUMN credits SET DEFAULT 50;

-- 2. One-time bulk correction. The marker table guarantees this block
--    only ever executes once, even if the deploy script reruns.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = '_welcome_credits_50_done') THEN

    UPDATE users SET credits = 50 WHERE credits = 100;

    CREATE TABLE _welcome_credits_50_done (applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  END IF;
END
$$;
