const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const configPaths = [
  ...(process.env.CONFIG_PATH ? [path.resolve(process.env.CONFIG_PATH)] : []),
  path.join(process.cwd(), 'configs', 'config.yaml'),
  path.join(process.cwd(), 'config.yaml'),
  path.join(__dirname, '..', '..', 'configs', 'config.yaml'),
];

function loadConfig() {
  let raw = null;
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, 'utf8');
      break;
    }
  }
  if (!raw) {
    throw new Error('Config file not found: configs/config.yaml');
  }
  const parsed = yaml.load(raw);
  if (!parsed?.app?.name) {
    throw new Error('Invalid config: missing app section');
  }
  const configuredAdminIds = parsed.platform_admin_user_ids;
  if (!String(process.env.PLATFORM_ADMIN_USER_IDS || '').trim() && configuredAdminIds) {
    process.env.PLATFORM_ADMIN_USER_IDS = Array.isArray(configuredAdminIds)
      ? configuredAdminIds.join(',')
      : String(configuredAdminIds);
  }
  parsed.server ||= {};
  parsed.database ||= {};
  parsed.storage ||= {};
  if (process.env.HOST) parsed.server.host = process.env.HOST;
  if (process.env.DATABASE_PATH) parsed.database.path = process.env.DATABASE_PATH;
  if (process.env.STORAGE_PATH) parsed.storage.local_path = process.env.STORAGE_PATH;
  if (process.env.PUBLIC_ORIGIN) {
    const origin = new URL(process.env.PUBLIC_ORIGIN);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_ORIGIN 必须是站点源地址');
    parsed.server.cors_origins = [origin.origin];
    parsed.storage.base_url = origin.origin + '/static';
  }
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('生产环境必须配置 HTTPS PUBLIC_ORIGIN');
    if (parsed.server.insecure_tls || parsed.server.INSECURE_TLS || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('生产环境不能关闭 TLS 校验');
    if (!process.env.DATABASE_PATH || !process.env.STORAGE_PATH) throw new Error('生产环境必须配置持久化数据库和素材目录');
    parsed.app.debug = false;
  }
  return parsed;
}

module.exports = { loadConfig };
