-- 为每个组织提供独立的模型映射和全局设置命名空间
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS ai_model_map_v2 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER,
  key            TEXT NOT NULL,
  service_type   TEXT NOT NULL DEFAULT 'text',
  config_id      INTEGER,
  model_override TEXT,
  description    TEXT,
  created_at     TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO ai_model_map_v2
  (id, organization_id, key, service_type, config_id, model_override, description, created_at, updated_at)
SELECT id, organization_id, key, service_type, config_id, model_override, description, created_at, updated_at
FROM ai_model_map;

DROP TABLE ai_model_map;
ALTER TABLE ai_model_map_v2 RENAME TO ai_model_map;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_map_org_key ON ai_model_map(organization_id, key);

CREATE TABLE IF NOT EXISTS global_settings_v2 (
  organization_id INTEGER,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (organization_id, key)
);

INSERT OR IGNORE INTO global_settings_v2 (organization_id, key, value, updated_at)
SELECT organization_id, key, value, updated_at
FROM global_settings;

DROP TABLE global_settings;
ALTER TABLE global_settings_v2 RENAME TO global_settings;
CREATE INDEX IF NOT EXISTS idx_global_settings_org ON global_settings(organization_id, key);

PRAGMA foreign_keys = ON;
