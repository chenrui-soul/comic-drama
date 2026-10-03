CREATE TABLE IF NOT EXISTS platform_admins (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
