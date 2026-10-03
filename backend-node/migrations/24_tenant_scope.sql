-- 将已有项目和 AI 配置归属到组织，为多租户隔离提供根字段
ALTER TABLE dramas ADD COLUMN organization_id INTEGER;
ALTER TABLE ai_service_configs ADD COLUMN organization_id INTEGER;

INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at)
VALUES (1, '系统工作区', 'system', datetime('now'), datetime('now'));

UPDATE dramas SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE ai_service_configs SET organization_id = 1 WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_dramas_org ON dramas(organization_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_ai_configs_org ON ai_service_configs(organization_id, deleted_at);
