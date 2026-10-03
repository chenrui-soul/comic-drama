CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO platform_settings (key, value, updated_at)
VALUES ('allow_user_ai_config', 'true', datetime('now'));

CREATE INDEX IF NOT EXISTS idx_ai_configs_platform_scope
ON ai_service_configs(organization_id, service_type, deleted_at);
