const { setMediaCookie, clearMediaCookie } = require('../utils/mediaCookie');
const authService = require('../services/authService');
const response = require('../response');
const auditService = require('../services/auditService');

function audit(db, req, user, action, metadata) {
  try {
    auditService.write(db, {
      organizationId: user?.organization?.id,
      actorUserId: user?.id,
      action,
      resourceType: 'auth',
      metadata,
      ipAddress: req.ip,
    });
  } catch (_) {}
}

function register(db, log) {
  return (req, res) => {
    try {
      const result = authService.register(db, req.body || {});
      audit(db, req, result.user, 'auth.registered', { email: result.user.email });
      setMediaCookie(res, result.session);
      response.created(res, result);
    } catch (err) {
      if (err.code === 'EMAIL_EXISTS' || /请输入|密码|邮箱/.test(err.message || '')) {
        return response.badRequest(res, err.message);
      }
      log.error('auth register failed', { error: err.message });
      response.internalError(res, '注册失败，请稍后重试');
    }
  };
}

function login(db, log) {
  return (req, res) => {
    try {
      const result = authService.login(db, req.body || {});
      audit(db, req, result.user, 'auth.logged_in');
      setMediaCookie(res, result.session);
      response.success(res, result);
    } catch (err) {
      if (err.code === 'INVALID_CREDENTIALS' || /请输入|错误|停用|加入工作区/.test(err.message || '')) {
        return response.error(res, 401, 'INVALID_CREDENTIALS', err.message);
      }
      log.error('auth login failed', { error: err.message });
      response.internalError(res, '登录失败，请稍后重试');
    }
  };
}

function me() {
  return (req, res) => {
    setMediaCookie(res, { token: req.authToken, expires_at: req.user.session_expires_at });
    response.success(res, { user: req.user });
  };
}

function logout(db) {
  return (req, res) => {
    authService.revokeSession(db, req.authToken);
    clearMediaCookie(res);
    audit(db, req, req.user, 'auth.logged_out');
    response.success(res, { message: '已退出登录' });
  };
}

function organizations(db) {
  return (req, res) => response.success(res, authService.listOrganizations(db, req.user.id));
}

function switchOrganization(db, log) {
  return (req, res) => {
    try {
      const result = authService.switchOrganization(db, req.user, req.body?.organization_id);
      audit(db, req, result.user, 'auth.organization_switched', { organization_id: result.user.organization.id });
      setMediaCookie(res, result.session);
      response.success(res, result);
    } catch (err) {
      if (err.code === 'ORG_FORBIDDEN') return response.forbidden(res, err.message);
      log.error('auth switch organization failed', { error: err.message });
      response.internalError(res, '切换工作区失败');
    }
  };
}

module.exports = function authRoutes(db, log) {
  return {
    register: register(db, log),
    login: login(db, log),
    me: me(),
    logout: logout(db),
    organizations: organizations(db),
    switchOrganization: switchOrganization(db, log),
  };
};
