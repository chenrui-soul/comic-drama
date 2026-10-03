const response = require('../response');
const aiConfigService = require('../services/aiConfigService');

const PLATFORM_SCOPE = 0;

function platformConfigCount(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM ai_service_configs WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1')
    .get(PLATFORM_SCOPE).count;
}

module.exports = function platformAiConfigRoutes(db, log) {
  return {
    policy(_req, res) {
      response.success(res, { allow_user_ai_config: aiConfigService.isUserConfigEnabled(db), configured_count: platformConfigCount(db) });
    },
    updatePolicy(req, res) {
      const value = req.body?.allow_user_ai_config;
      if (typeof value !== 'boolean') return response.badRequest(res, '开关值必须为布尔值');
      if (!value && platformConfigCount(db) === 0) return response.badRequest(res, '请先保存至少一个启用的平台 AI 配置');
      db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('allow_user_ai_config', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .run(JSON.stringify(value), new Date().toISOString());
      log.info('Platform AI config policy updated', { allow_user_ai_config: value, actor_user_id: req.user.id });
      response.success(res, { allow_user_ai_config: value });
    },
    list(req, res) {
      response.success(res, aiConfigService.listConfigs(db, req.query.service_type, PLATFORM_SCOPE));
    },
    get(req, res) {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
      const config = aiConfigService.getConfig(db, id, PLATFORM_SCOPE);
      if (!config) return response.notFound(res, '配置不存在');
      response.success(res, config);
    },
    create(req, res) {
      const body = req.body || {};
      if (!body.service_type || !body.name || !body.provider || !body.base_url) {
        return response.badRequest(res, '缺少必填字段: service_type, name, provider, base_url');
      }
      const manager = body.api_protocol === 'doubao_manager' || body.provider === 'doubao_manager';
      if ((body.api_key == null) && !manager) return response.badRequest(res, '缺少必填字段: api_key');
      try {
        const config = aiConfigService.createConfig(db, log, { ...body, model: body.model ?? [] }, PLATFORM_SCOPE);
        response.created(res, config);
      } catch (err) {
        log.errorw('Create platform AI config failed', { error: err.message });
        response.internalError(res, '创建失败');
      }
    },
    update(req, res) {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
      const config = aiConfigService.updateConfig(db, log, id, req.body || {}, PLATFORM_SCOPE);
      if (!config) return response.notFound(res, '配置不存在');
      response.success(res, config);
    },
    remove(req, res) {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
      if (!aiConfigService.deleteConfig(db, log, id, PLATFORM_SCOPE)) return response.notFound(res, '配置不存在');
      response.success(res, { message: '删除成功' });
    },
  };
};
