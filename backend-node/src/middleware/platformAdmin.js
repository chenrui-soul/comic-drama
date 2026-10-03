const response = require('../response');

function requirePlatformAdmin(req, res, next) {
  if (!req.user?.is_platform_admin) {
    return response.error(res, 403, 'FORBIDDEN', '仅平台管理员可执行此操作');
  }
  next();
}

module.exports = { requirePlatformAdmin };
