const organizationService = require('../services/organizationService');
const response = require('../response');
const { requireRole } = require('../middleware/auth');
const auditService = require('../services/auditService');
const fs = require('fs');
const path = require('path');
const { setMediaCookie } = require('../utils/mediaCookie');

function audit(db, req, action, resourceType, resourceId, metadata, organizationId) {
  try {
    auditService.write(db, {
      organizationId: organizationId || req.user.organization.id,
      actorUserId: req.user.id,
      action,
      resourceType,
      resourceId,
      metadata,
      ipAddress: req.ip,
    });
  } catch (_) {}
}

function handleError(res, err, fallback) {
  if (['ALREADY_MEMBER', 'RECIPIENT_UNCONFIRMED'].includes(err.code)) return response.badRequest(res, err.message);
  if (err.code === 'INVITE_INVALID' || err.code === 'INVITE_EMAIL_MISMATCH') return response.badRequest(res, err.message);
  if (/权限|所有者|角色/.test(err.message || '')) return response.forbidden(res, err.message);
  return response.internalError(res, fallback || err.message);
}

module.exports = function organizationRoutes(db, log, config) {
  const authService = require('../services/authService');
  const workspaceDeletionService = require('../services/workspaceDeletionService');
  return {
    createWorkspace: (req, res) => {
      try {
        const organization = authService.createOrganization(db, req.user, req.body?.name);
        response.created(res, organization);
      } catch (err) {
        if (/工作区名称/.test(err.message || '')) return response.badRequest(res, err.message);
        log.error('Create workspace failed', { error: err.message, user_id: req.user.id });
        response.internalError(res, '创建工作区失败');
      }
    },
    deleteWorkspace: (req, res) => {
      const organizationId = Number(req.params.id);
      if (!Number.isSafeInteger(organizationId) || organizationId <= 0) return response.badRequest(res, '无效的工作区 ID');
      try {
        const result = db.transaction(() => {
          const membership = db.prepare(`SELECT m.role, o.name FROM organization_members m
            JOIN organizations o ON o.id=m.organization_id
            WHERE m.organization_id=? AND m.user_id=?`).get(organizationId, req.user.id);
          if (!membership) return { error: '没有该工作区的访问权限', status: 403 };
          if (membership.role !== 'owner') return { error: '只有工作区所有者可以删除工作区', status: 403 };
          const workspaceCount = db.prepare('SELECT COUNT(*) AS count FROM organization_members WHERE user_id=?').get(req.user.id).count;
          if (workspaceCount <= 1) return { error: '账号至少需要保留一个工作区', status: 400 };

          const deleted = workspaceDeletionService.deleteWorkspaceData(db, organizationId);
          const activeWorkspaceDeleted = Number(req.user.organization.id) === organizationId;
          let replacementSession = null;
          let replacementUser = null;
          if (activeWorkspaceDeleted) {
            const next = db.prepare(`SELECT m.role, o.id, o.name, o.slug FROM organization_members m
              JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=? ORDER BY m.id LIMIT 1`).get(req.user.id);
            const row = db.prepare('SELECT id, email, display_name, status FROM users WHERE id=?').get(req.user.id);
            replacementUser = authService.publicUser(db, row, next, next.role);
            replacementSession = authService.createSession(db, req.user.id, next.id);
          }
          return { deleted, activeWorkspaceDeleted, replacementSession, replacementUser };
        })();

        if (result.error) {
          if (result.status === 403) return response.forbidden(res, result.error);
          return response.badRequest(res, result.error);
        }
        if (result.activeWorkspaceDeleted) setMediaCookie(res, result.replacementSession);
        const storageRoot = path.resolve(config?.storage?.local_path || './data/storage');
        for (const mediaPath of result.deleted.mediaFiles) {
          const file = path.resolve(storageRoot, String(mediaPath).replace(/[\\/]+/g, path.sep));
          if (!file.startsWith(`${storageRoot}${path.sep}`)) continue;
          try { if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.rmSync(file); }
          catch (err) { log.warn('Deleted workspace media cleanup failed', { error: err.message, file }); }
        }
        const orgDir = path.resolve(storageRoot, 'org', String(organizationId));
        if (orgDir.startsWith(`${path.resolve(storageRoot, 'org')}${path.sep}`)) {
          try { fs.rmSync(orgDir, { recursive: true, force: true }); }
          catch (err) { log.warn('Deleted workspace storage cleanup failed', { error: err.message, workspace_id: organizationId }); }
        }
        response.success(res, {
          message: '工作区及其项目、配置和素材已删除',
          ...(result.activeWorkspaceDeleted ? { session: result.replacementSession, user: result.replacementUser } : {}),
        });
      } catch (err) {
        log.error('Delete workspace failed', { error: err.message, organization_id: organizationId, user_id: req.user.id });
        response.internalError(res, '删除工作区失败');
      }
    },
    receivedInvitations: (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        response.success(res, organizationService.listReceivedInvitations(db, req.user));
      } catch (err) { handleError(res, err, '获取收到的邀请失败'); }
    },
    respondInvite: (req, res) => {
      try {
        const accept = req.params.decision === 'accept';
        const result = organizationService.respondToInvitation(db, req.user, req.params.id, accept);
        audit(db, req, accept ? 'organization.invitation_accepted' : 'organization.invitation_declined',
          'invitation', req.params.id, {}, result.organization.id);
        response.success(res, result);
      } catch (err) { handleError(res, err, '处理邀请失败'); }
    },
    members: (req, res) => {
      try {
        response.success(res, organizationService.listMembers(db, req.user.organization.id));
      } catch (err) {
        log.error('List organization members failed', { error: err.message });
        response.internalError(res, '获取成员列表失败');
      }
    },
    invitations: (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        response.success(res, organizationService.listInvitations(db, req.user.organization.id).map(({ token, ...invitation }) => invitation));
      } catch (err) {
        log.error('List organization invitations failed', { error: err.message });
        response.internalError(res, '获取邀请列表失败');
      }
    },
    invite: (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        const invitation = organizationService.createInvitation(db, req.user, req.body || {});
        audit(db, req, 'organization.invitation_created', 'invitation', invitation.id, { email: invitation.email, role: invitation.role });
        const { token, ...message } = invitation;
        response.created(res, message);
      } catch (err) {
        handleError(res, err, '创建邀请失败');
      }
    },
    acceptInvite: (req, res) => {
      try {
        const result = organizationService.acceptInvitation(db, req.user, req.body?.token || req.params.token);
        audit(db, req, 'organization.invitation_accepted', 'organization', result.organization.id, { role: result.role }, result.organization.id);
        response.success(res, result);
      } catch (err) {
        handleError(res, err, '接受邀请失败');
      }
    },
    updateRole: (req, res) => {
      try {
        const member = organizationService.updateMemberRole(db, req.user, req.params.userId, req.body?.role);
        if (!member) return response.notFound(res, '成员不存在');
        audit(db, req, 'organization.member_role_changed', 'user', member.user_id, { role: member.role });
        response.success(res, member);
      } catch (err) {
        handleError(res, err, '修改成员角色失败');
      }
    },
    removeMember: (req, res) => {
      try {
        const removed = organizationService.removeMember(db, req.user, req.params.userId);
        if (!removed) return response.notFound(res, '成员不存在');
        audit(db, req, 'organization.member_removed', 'user', req.params.userId);
        response.success(res, { message: '成员已移除' });
      } catch (err) {
        handleError(res, err, '移除成员失败');
      }
    },
    revokeInvitation: (req, res) => {
      try {
        const revoked = organizationService.revokeInvitation(db, req.user, req.params.id);
        if (!revoked) return response.notFound(res, '邀请不存在或已处理');
        audit(db, req, 'organization.invitation_revoked', 'invitation', req.params.id);
        response.success(res, { message: '邀请已撤销' });
      } catch (err) {
        handleError(res, err, '撤销邀请失败');
      }
    },
    auditLogs: (req, res) => {
      try {
        response.success(res, auditService.list(db, req.user.organization.id, req.query || {}));
      } catch (err) {
        log.error('List audit logs failed', { error: err.message });
        response.internalError(res, '获取审计日志失败');
      }
    },
    requireAdmin: requireRole('owner', 'admin'),
    requireOwner: requireRole('owner'),
  };
};
