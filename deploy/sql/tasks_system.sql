-- Tasks / Earn Credits system migration
-- Run on the production database

CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  title         JSONB NOT NULL,
  description   JSONB NOT NULL,
  image_url     TEXT,
  reward        INTEGER NOT NULL,
  link          TEXT NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT,
  targeting     TEXT NOT NULL DEFAULT 'all',
  delay_seconds INTEGER NOT NULL DEFAULT 5,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_completions (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT task_completions_task_id_user_id_key UNIQUE (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS task_completions_task_id_idx ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS task_completions_user_id_idx ON task_completions(user_id);
