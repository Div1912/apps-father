-- Migration: Agent training knowledge tables
-- Two kinds of "trained moments" stored separately but exported/imported together:
--   * agent_lessons       — text rules injected into the system prompt at runtime.
--   * agent_code_patches  — text suggestions for editing the agent's own code,
--                           applied manually in the IDE (never auto-applied).

CREATE TABLE IF NOT EXISTS agent_lessons (
  id              TEXT         PRIMARY KEY,
  rule            TEXT         NOT NULL,
  context         TEXT,
  tags            TEXT[]       NOT NULL DEFAULT '{}',
  enabled         BOOLEAN      NOT NULL DEFAULT false,
  notes           TEXT,
  source_case_id  TEXT,
  content_hash    TEXT         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  enabled_at      TIMESTAMPTZ,
  disabled_at     TIMESTAMPTZ,
  imported_from   TEXT
);
CREATE INDEX IF NOT EXISTS agent_lessons_enabled_idx ON agent_lessons(enabled);

CREATE TABLE IF NOT EXISTS agent_code_patches (
  id              TEXT         PRIMARY KEY,
  title           TEXT         NOT NULL,
  problem         TEXT         NOT NULL,
  target_files    TEXT[]       NOT NULL DEFAULT '{}',
  suggestion      TEXT         NOT NULL,
  cursor_prompt   TEXT         NOT NULL,
  tags            TEXT[]       NOT NULL DEFAULT '{}',
  status          TEXT         NOT NULL DEFAULT 'proposed',
  notes           TEXT,
  source_case_id  TEXT,
  content_hash    TEXT         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  applied_at      TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  applied_commit  TEXT,
  imported_from   TEXT
);
CREATE INDEX IF NOT EXISTS agent_code_patches_status_idx ON agent_code_patches(status);
