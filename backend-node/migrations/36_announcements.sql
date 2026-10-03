CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 10000),
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published', 'withdrawn')),
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_org_status ON announcements(organization_id, status, created_at DESC, id DESC);
