const crypto = require('crypto');
const tokenStore = require('./invitationTokenStore');

const ROLES = new Set(['owner', 'admin', 'member']);
// Compatibility with the legacy NOT NULL column. Invitations no longer expire by time.
const NO_EXPIRY = '9999-12-31T23:59:59.999Z';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function publicMember(row) {
  return {
    id: row.member_id,
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    status: row.user_status,
    role: row.role,
    joined_at: row.joined_at,
  };
}

function listMembers(db, organizationId) {
  return db.prepare(`
    SELECT m.id AS member_id, m.user_id, m.role, m.created_at AS joined_at,
           u.email, u.display_name, u.status AS user_status
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at ASC
  `).all(organizationId).map(publicMember);
}

function listInvitations(db, organizationId) {
  return db.prepare(`
    SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.declined_at,
           i.created_at, i.recipient_user_id, i.token_encrypted, u.display_name AS invited_by_name
    FROM organization_invitations i
    JOIN users u ON u.id = i.invited_by
    WHERE i.organization_id = ?
      AND i.id = (SELECT MAX(latest.id) FROM organization_invitations latest
        WHERE latest.organization_id = i.organization_id AND latest.email = i.email)
    ORDER BY i.id DESC
  `).all(organizationId).map(({ token_encrypted, ...row }) => {
    const status = row.revoked_at ? 'revoked' : row.accepted_at ? 'accepted' : row.declined_at ? 'declined' : !row.recipient_user_id ? 'needs_confirmation' : 'pending';
    return { ...row, expires_at: null, status,
      token: status === 'pending' ? tokenStore.decrypt(db, token_encrypted) : null };
  });
}

function createInvitation(db, currentUser, input) {
  if (!['owner', 'admin'].includes(currentUser.role)) throw new Error('没有邀请成员的权限');
  const email = normalizeEmail(input.email);
  const role = String(input.role || 'member').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('请输入有效的邮箱地址');
  if (!ROLES.has(role) || role === 'owner') throw new Error('邀请角色只能是 admin 或 member');
  if (role === 'admin' && currentUser.role !== 'owner') throw new Error('只有工作区所有者可以邀请管理员');

  const recipient = db.prepare('SELECT id FROM users WHERE id=? AND email=? AND status=?')
    .get(Number(input.recipient_user_id) || 0, email, 'active');
  if (!recipient) {
    const error = new Error('请让对方先注册，并核对账号 ID 与邮箱后再发送邀请');
    error.code = 'RECIPIENT_UNCONFIRMED';
    throw error;
  }

  const existing = db.prepare(`
    SELECT m.id FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.email = ?
  `).get(currentUser.organization.id, email);
  if (existing) {
    const error = new Error('该用户已经是工作区成员');
    error.code = 'ALREADY_MEMBER';
    throw error;
  }

  const timestamp = nowIso();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const encrypted = tokenStore.encrypt(db, token);
  return db.transaction(() => {
  db.prepare(`
    UPDATE organization_invitations
    SET revoked_at = ?
    WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL
  `).run(timestamp, currentUser.organization.id, email);
  const info = db.prepare(`
    INSERT INTO organization_invitations
      (organization_id, email, role, token_hash, invited_by, expires_at, created_at, token_encrypted, recipient_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(currentUser.organization.id, email, role, tokenHash, currentUser.id, NO_EXPIRY, timestamp, encrypted, recipient.id);
  return { id: info.lastInsertRowid, email, role, token, recipient_user_id: recipient.id, expires_at: null };
  })();
}

function acceptInvitation(db, currentUser, token) {
  const tokenHash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  return db.transaction(() => {
  const row = db.prepare(`
    SELECT i.*, o.name AS organization_name, o.slug AS organization_slug
    FROM organization_invitations i
    JOIN organizations o ON o.id = i.organization_id
    WHERE i.token_hash = ?
  `).get(tokenHash);
  return acceptInvitationRow(db, currentUser, row);
  })();
}

function validateRecipient(row, currentUser) {
  if (!row || !row.recipient_user_id || Number(currentUser.id) !== Number(row.recipient_user_id)) {
    const error = new Error('邀请不存在或不属于当前账号');
    error.code = 'INVITE_EMAIL_MISMATCH';
    throw error;
  }
  if (row.revoked_at || row.accepted_at || row.declined_at) {
    const error = new Error('邀请已处理、已撤销或已被新的邀请替换');
    error.code = 'INVITE_INVALID';
    throw error;
  }
}

function acceptInvitationRow(db, currentUser, row) {
  validateRecipient(row, currentUser);
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at)
      VALUES (?, ?, ?, ?)
    `).run(row.organization_id, currentUser.id, row.role, timestamp);
    db.prepare('UPDATE organization_invitations SET accepted_at = ? WHERE id = ?').run(timestamp, row.id);
  })();
  return {
    organization: { id: row.organization_id, name: row.organization_name, slug: row.organization_slug },
    role: db.prepare('SELECT role FROM organization_members WHERE organization_id=? AND user_id=?').get(row.organization_id, currentUser.id).role,
  };
}

function listReceivedInvitations(db, currentUser) {
  return db.prepare(`SELECT i.id, i.role, i.created_at, o.id AS organization_id,
      o.name AS organization_name, u.display_name AS invited_by_name
    FROM organization_invitations i
    JOIN organizations o ON o.id=i.organization_id
    JOIN users u ON u.id=i.invited_by
    WHERE i.recipient_user_id=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL
      AND i.id=(SELECT MAX(j.id) FROM organization_invitations j WHERE j.organization_id=i.organization_id AND j.email=i.email)
      AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=i.organization_id AND m.user_id=?)
    ORDER BY i.id DESC`).all(currentUser.id, currentUser.id);
}

function respondToInvitation(db, currentUser, invitationId, accept) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT i.*, o.name AS organization_name, o.slug AS organization_slug
      FROM organization_invitations i JOIN organizations o ON o.id=i.organization_id WHERE i.id=?`)
      .get(Number(invitationId) || 0);
    validateRecipient(row, currentUser);
    if (accept) return acceptInvitationRow(db, currentUser, row);
    db.prepare('UPDATE organization_invitations SET declined_at=? WHERE id=?').run(nowIso(), row.id);
    return { organization: { id: row.organization_id }, invitation_id: row.id };
  })();
}

function updateMemberRole(db, currentUser, memberUserId, role) {
  if (currentUser.role !== 'owner') throw new Error('只有工作区所有者可以修改成员角色');
  if (!ROLES.has(role)) throw new Error('角色无效');
  const member = db.prepare(`
    SELECT m.id, m.user_id, m.role FROM organization_members m
    WHERE m.organization_id = ? AND m.user_id = ?
  `).get(currentUser.organization.id, Number(memberUserId));
  if (!member) return null;
  if (member.role === 'owner' && role !== 'owner') {
    const owners = db.prepare(`
      SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = ? AND role = 'owner'
    `).get(currentUser.organization.id);
    if (owners.count <= 1) throw new Error('工作区至少需要一名所有者');
  }
  db.prepare('UPDATE organization_members SET role = ? WHERE id = ?').run(role, member.id);
  const row = db.prepare(`
    SELECT m.id AS member_id, m.user_id, m.role, m.created_at AS joined_at,
           u.email, u.display_name, u.status AS user_status
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.id = ?
  `).get(member.id);
  return row ? publicMember(row) : null;
}

function removeMember(db, currentUser, memberUserId) {
  const member = db.prepare(`
    SELECT m.id, m.user_id, m.role FROM organization_members m
    WHERE m.organization_id = ? AND m.user_id = ?
  `).get(currentUser.organization.id, Number(memberUserId));
  if (!member) return false;
  if (member.role === 'owner') throw new Error('不能移除工作区所有者');
  if (currentUser.role !== 'owner' && (currentUser.role !== 'admin' || member.role !== 'member')) {
    throw new Error('没有移除该成员的权限');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM organization_members WHERE id = ?').run(member.id);
    db.prepare(`UPDATE auth_sessions SET revoked_at=?
      WHERE user_id=? AND organization_id=? AND revoked_at IS NULL`)
      .run(nowIso(), member.user_id, currentUser.organization.id);
  })();
  return true;
}

function revokeInvitation(db, currentUser, invitationId) {
  if (currentUser.role !== 'owner' && currentUser.role !== 'admin') throw new Error('没有撤销邀请的权限');
  const result = db.prepare(`
    UPDATE organization_invitations
    SET revoked_at = ?
    WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL
  `).run(nowIso(), Number(invitationId), currentUser.organization.id);
  return result.changes > 0;
}

module.exports = {
  listReceivedInvitations,
  respondToInvitation,
  listMembers,
  listInvitations,
  createInvitation,
  acceptInvitation,
  updateMemberRole,
  removeMember,
  revokeInvitation,
  ROLES,
};
