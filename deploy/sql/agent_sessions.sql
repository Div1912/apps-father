-- Migration: agent_sessions table + remove performance_tier from users
-- Run once on each environment after deploying the new code.

-- 1. Create agent_sessions table
CREATE TABLE IF NOT EXISTS agent_sessions (
  id              TEXT        PRIMARY KEY,
  project_id      TEXT        REFERENCES projects(id) ON DELETE SET NULL,
  user_id         INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  type            TEXT        NOT NULL,
  model           TEXT        NOT NULL DEFAULT '',
  input           TEXT        NOT NULL DEFAULT '',
  output          TEXT,
  credits_charged INTEGER     NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  input_tokens    INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  success         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_created ON agent_sessions (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_created    ON agent_sessions (user_id,    created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_type_created    ON agent_sessions (type,        created_at DESC);

-- 2. Drop performance_tier column from users (no longer needed)
ALTER TABLE users DROP COLUMN IF EXISTS performance_tier;

-- 3. Drop tier_id column from usage_logs (historical data kept, column removed)
ALTER TABLE usage_logs DROP COLUMN IF EXISTS tier_id;
