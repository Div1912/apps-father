-- Add last_task_id column to projects (idempotent)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_task_id TEXT;
