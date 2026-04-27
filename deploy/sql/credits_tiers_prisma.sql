-- Run once against the same DB as DATABASE_URL (dev/prod) if the Node app
-- crashes with Prisma errors about missing users.credits / performance_tier /
-- usage_logs.credits_charged / tier_id. Also used by deploy-full.ps1.
--
-- docker exec <db_container> psql -U <user> -d <db> -f /path/this file.sql

-- Projects: app profile fields
ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_description TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_long_description TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_menu_button_text TEXT;

-- Credits & performance tiers
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS performance_tier TEXT NOT NULL DEFAULT 'tier_1';
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS credits_charged INTEGER;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS tier_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = '_credits_backfill_v1_done') THEN
    UPDATE users SET credits = GREATEST(0, FLOOR((balance)::numeric * 50)::int)
      WHERE credits = 0;
    CREATE TABLE _credits_backfill_v1_done (applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  END IF;
END
$$;
