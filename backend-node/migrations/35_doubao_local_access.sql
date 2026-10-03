CREATE TABLE IF NOT EXISTS doubao_local_access (
  config_id INTEGER PRIMARY KEY REFERENCES ai_service_configs(id),
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT,
  updated_at TEXT NOT NULL
);
