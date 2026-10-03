-- AI 异步任务队列：保存重试和恢复所需的运行信息
ALTER TABLE async_tasks ADD COLUMN payload TEXT;
ALTER TABLE async_tasks ADD COLUMN attempts INTEGER DEFAULT 0;
ALTER TABLE async_tasks ADD COLUMN max_attempts INTEGER DEFAULT 3;
ALTER TABLE async_tasks ADD COLUMN next_attempt_at TEXT;
ALTER TABLE async_tasks ADD COLUMN started_at TEXT;
ALTER TABLE async_tasks ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_async_tasks_queue
  ON async_tasks(status, next_attempt_at, created_at);
