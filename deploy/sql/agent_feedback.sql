-- Migration: Agent Feedback (cashback issues)
-- Captures the user's rating after every agent run plus the context needed
-- by the analysis pipeline to suggest AgentLessons / AgentCodePatches.
-- Self-healing: ALTER TABLE additions for forward-compatible columns.

CREATE TABLE IF NOT EXISTS agent_feedback (
  id                  TEXT         PRIMARY KEY,
  project_id          TEXT         NOT NULL,
  user_id             INTEGER      NOT NULL,
  user_prompt         TEXT         NOT NULL,
  commit_num_before   INTEGER,
  commit_num_after    INTEGER,
  credits_charged     INTEGER      NOT NULL DEFAULT 0,
  is_correct          BOOLEAN      NOT NULL,
  quality_score       INTEGER      NOT NULL DEFAULT 0,
  speed_score         INTEGER      NOT NULL DEFAULT 0,
  user_description    TEXT,
  performance_tier    TEXT,
  cashback_credits    INTEGER      NOT NULL DEFAULT 0,
  cashback_paid_at    TIMESTAMPTZ,
  analysis_status     TEXT         NOT NULL DEFAULT 'pending',
  analysis_result     JSONB,
  analysis_model      TEXT,
  analysis_error      TEXT,
  applied_at          TIMESTAMPTZ,
  applied_lesson_ids  TEXT[]       NOT NULL DEFAULT '{}',
  applied_patch_ids   TEXT[]       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Self-healing column adds for environments where the table already exists.
ALTER TABLE agent_feedback ADD COLUMN IF NOT EXISTS analysis_error TEXT;
ALTER TABLE agent_feedback ADD COLUMN IF NOT EXISTS performance_tier TEXT;

CREATE INDEX IF NOT EXISTS agent_feedback_status_idx ON agent_feedback(analysis_status);
CREATE INDEX IF NOT EXISTS agent_feedback_user_idx   ON agent_feedback(user_id);
CREATE INDEX IF NOT EXISTS agent_feedback_project_idx ON agent_feedback(project_id);

-- One feedback per user per (project, post-run commit) — guards double cashback.
CREATE UNIQUE INDEX IF NOT EXISTS agent_feedback_unique_per_run_idx
  ON agent_feedback(user_id, project_id, commit_num_after);
