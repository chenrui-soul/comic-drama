const authService = require('../services/authService');
const response = require('../response');
const { runWithTenant } = require('../utils/tenantContext');

function authenticate(db) {
  return (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = authService.resolveSession(db, token);
    if (!user) return response.error(res, 401, 'UNAUTHORIZED', '登录已失效，请重新登录');
    req.user = user;
    req.authToken = token;
    runWithTenant(user.organization.id, next);
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return response.error(res, 403, 'FORBIDDEN', '没有执行此操作的权限');
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
