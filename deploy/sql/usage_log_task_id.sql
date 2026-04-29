-- Add task_id column to usage_logs for session-level cost tracking (idempotent)
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS task_id TEXT;
CREATE INDEX IF NOT EXISTS usage_logs_task_id_idx ON usage_logs (task_id);
