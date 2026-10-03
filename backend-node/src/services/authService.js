const crypto = require('crypto');

const SESSION_DAYS = 30;
const PASSWORD_MIN_LENGTH = 8;

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getConfiguredPlatformAdminIds() {
  return String(process.env.PLATFORM_ADMIN_USER_IDS || '')
    .split(/[;,\s]+/)
    .map(value => Number(value))
    .filter(value => Number.isSafeInteger(value) && value > 0);
}

function isPlatformAdminId(userId, db) {
  const id = Number(userId);
  if (getConfiguredPlatformAdminIds().includes(id)) return true;
  if (!db) return false;
  try {
    return !!db.prepare('SELECT 1 FROM platform_admins WHERE user_id = ?').get(id);
  } catch (error) {
    if (error.code === 'SQLITE_ERROR' && error.message.toLowerCase().includes('no such table')) return false;
    throw error;
  }
}

function validateCredentials(email, password) {
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail.length > 254 || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    throw new Error('请输入有效的邮箱地址');
  }
  if (typeof password !== 'string' || password.length > 256 || password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`密码长度至少为 ${PASSWORD_MIN_LENGTH} 位`);
  }
  return normalizedEmail;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, salt, expectedHex] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function slugify(value) {
  const base = String(value || 'workspace')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

function publicUser(db, row, organization, role) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    status: row.status,
    organization: organization ? { id: organization.id, name: organization.name, slug: organization.slug } : null,
    role: role || null,
    is_platform_admin: isPlatformAdminId(row.id, db),
  };
}

function createSession(db, userId, organizationId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const timestamp = now.toISOString();
  db.prepare(`INSERT INTO auth_sessions
    (token_hash, user_id, organization_id, expires_at, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(hashToken(token), userId, organizationId, expires, timestamp, timestamp);
  return { token, expires_at: expires };
}

function register(db, { email, password, display_name }) {
  const normalizedEmail = validateCredentials(email, password);
  const displayName = String(display_name || '').trim().slice(0, 80) || normalizedEmail.split('@')[0];
  const timestamp = nowIso();
  const transaction = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      const error = new Error('该邮箱已注册');
      error.code = 'EMAIL_EXISTS';
      throw error;
    }
    const userInfo = db.prepare(`INSERT INTO users (email, password_hash, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(normalizedEmail, hashPassword(password), displayName, timestamp, timestamp);
    const userId = userInfo.lastInsertRowid;
    const organizationName = `${displayName}的工作区`;
    const orgInfo = db.prepare(`INSERT INTO organizations (name, slug, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(organizationName, slugify(displayName), userId, timestamp, timestamp);
    const organizationId = orgInfo.lastInsertRowid;
    db.prepare(`INSERT INTO organization_members (organization_id, user_id, role, created_at)
      VALUES (?, ?, 'owner', ?)`).run(organizationId, userId, timestamp);
    return { userId, organizationId };
  });
  const { userId, organizationId } = transaction();
  const user = db.prepare('SELECT id, email, display_name, status FROM users WHERE id = ?').get(userId);
  const organization = db.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(organizationId);
  return { user: publicUser(db, user, organization, 'owner'), session: createSession(db, userId, organizationId) };
}

function login(db, { email, password }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || typeof password !== 'string' || !password || password.length > 256 || normalizedEmail.length > 254) {
    throw new Error('请输入邮箱和密码');
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const error = new Error('邮箱或密码错误');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }
  if (user.status !== 'active') throw new Error('账号已被停用');
  const membership = db.prepare(`SELECT m.role, o.id, o.name, o.slug
    FROM organization_members m JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ? ORDER BY m.id LIMIT 1`).get(user.id);
  if (!membership) throw new Error('账号尚未加入工作区');
  const timestamp = nowIso();
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, user.id);
  return {
    user: publicUser(db, user, membership, membership.role),
    session: createSession(db, user.id, membership.id),
  };
}

function resolveSession(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT s.*, u.email, u.display_name, u.status,
      o.name AS organization_name, o.slug AS organization_slug, m.role
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN organizations o ON o.id = s.organization_id
    JOIN organization_members m ON m.user_id = s.user_id AND m.organization_id = s.organization_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(hashToken(token), nowIso());
  if (!row || row.status !== 'active') return null;
  db.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return {
    id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    status: row.status,
    organization: { id: row.organization_id, name: row.organization_name, slug: row.organization_slug },
    role: row.role,
    is_platform_admin: isPlatformAdminId(row.user_id, db),
    session_id: row.id,
    session_expires_at: row.expires_at,
  };
}

function revokeSession(db, token) {
  if (!token) return;
  db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(nowIso(), hashToken(token));
}

function listOrganizations(db, userId) {
  return db.prepare(`
    SELECT o.id, o.name, o.slug, m.role
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ?
    ORDER BY m.id
  `).all(userId);
}

function switchOrganization(db, currentUser, organizationId) {
  const membership = db.prepare(`
    SELECT m.role, o.id, o.name, o.slug
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ? AND m.organization_id = ?
  `).get(currentUser.id, Number(organizationId));
  if (!membership) {
    const error = new Error('你不是该工作区成员');
    error.code = 'ORG_FORBIDDEN';
    throw error;
  }
  const user = db.prepare('SELECT id, email, display_name, status FROM users WHERE id = ?').get(currentUser.id);
  return {
    user: publicUser(db, user, membership, membership.role),
    session: createSession(db, currentUser.id, membership.id),
  };
}

function createOrganization(db, currentUser, name) {
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 80) throw new Error('工作区名称需为 1 到 80 个字符');
  const timestamp = nowIso();
  const result = db.transaction(() => {
    const inserted = db.prepare(`INSERT INTO organizations (name, slug, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(cleanName, slugify(cleanName), currentUser.id, timestamp, timestamp);
    db.prepare(`INSERT INTO organization_members (organization_id, user_id, role, created_at)
      VALUES (?, ?, 'owner', ?)`).run(inserted.lastInsertRowid, currentUser.id, timestamp);
    return { id: inserted.lastInsertRowid, name: cleanName, role: 'owner' };
  })();
  return result;
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  register,
  login,
  resolveSession,
  revokeSession,
  listOrganizations,
  switchOrganization,
  createOrganization,
  createSession,
  publicUser,
  isPlatformAdminId,
  getConfiguredPlatformAdminIds,
};
