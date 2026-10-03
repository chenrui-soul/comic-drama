CREATE TABLE IF NOT EXISTS private_media_owners (
  path TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS security_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
