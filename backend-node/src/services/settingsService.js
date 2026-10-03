const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { getTenantId } = require('../utils/tenantContext');

let configPath = null;
let configCache = null;

function setConfigPath(cfg) {
  const paths = [
    path.join(process.cwd(), 'configs', 'config.yaml'),
    path.join(process.cwd(), 'config.yaml'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      configPath = p;
      return p;
    }
  }
  return null;
}

function getLanguage(cfg) {
  return cfg?.app?.language || 'zh';
}

function updateLanguage(cfg, log, language) {
  if (language !== 'zh' && language !== 'en') {
    return { ok: false, error: '只支持 zh 或 en' };
  }
  if (!cfg.app) cfg.app = {};
  cfg.app.language = language;
  setConfigPath(cfg);
  if (configPath) {
    try {
      const current = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
      if (!current.app) current.app = {};
      current.app.language = language;
      fs.writeFileSync(configPath, yaml.dump(current, { lineWidth: -1 }), 'utf8');
    } catch (err) {
      log.warnw('Failed to write config file', { error: err.message });
    }
  }
  log.infow('System language updated', { language });
  return { ok: true, language };
}

/**
 * 从 global_settings 表读取一个键值，返回解析后的值，不存在时返回 defaultValue。
 */
function getGlobalSetting(db, key, defaultValue = null) {
  try {
    const tenantId = getTenantId();
    const row = tenantId
      ? db.prepare('SELECT value FROM global_settings WHERE organization_id = ? AND key = ?').get(tenantId, key)
      : db.prepare('SELECT value FROM global_settings WHERE key = ? ORDER BY organization_id LIMIT 1').get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch (_) { return row.value; }
  } catch (_) { return defaultValue; }
}

/**
 * 向 global_settings 表写入一个键值（value 会被 JSON.stringify）。
 */
function setGlobalSetting(db, key, value) {
  const now = new Date().toISOString();
  const str = JSON.stringify(value);
  const tenantId = getTenantId() || 1;
  db.prepare(
    `INSERT INTO global_settings (organization_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(tenantId, key, str, now);
}

module.exports = {
  setConfigPath,
  getLanguage,
  updateLanguage,
  getGlobalSetting,
  setGlobalSetting,
};
