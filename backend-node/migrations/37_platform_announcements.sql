CREATE TABLE IF NOT EXISTS platform_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 10000),
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published', 'withdrawn')),
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_announcements_status_created
  ON platform_announcements(status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_created
  ON platform_audit_logs(created_at DESC, id DESC);
