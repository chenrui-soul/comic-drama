const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getTenantId } = require('../utils/tenantContext');
let context;

function relativePath(value) {
  let raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!url.pathname.startsWith('/static/')) return null;
    raw = url.pathname;
  }
  raw = raw.split(/[?#]/)[0];
  try { raw = decodeURIComponent(raw); } catch (_) { throw new Error('素材路径无效'); }
  if (raw.startsWith('/static/')) raw = raw.slice(8);
  if (!raw || raw.startsWith('/') || /[\\\x00-\x1f:%]/.test(raw) || raw.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) {
    throw new Error('素材路径无效');
  }
  return raw;
}

function ownerOf(db, rel) {
  const namespaced = /^org\/(\d+)\//.exec(rel);
  if (namespaced) return Number(namespaced[1]);
  const project = /^projects\/(\d+)_/.exec(rel);
  if (project) return db.prepare('SELECT organization_id FROM dramas WHERE id=? AND deleted_at IS NULL').get(Number(project[1]))?.organization_id;
  return db.prepare('SELECT organization_id FROM private_media_owners WHERE path=?').get(rel)?.organization_id;
}

function checkedPath(db, root, value, organizationId) {
  const rel = relativePath(value);
  if (!rel || !organizationId || Number(ownerOf(db, rel)) !== Number(organizationId)) throw new Error('没有权限访问素材');
  const abs = path.resolve(root, rel);
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(abs);
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.statSync(real).isFile()) throw new Error('素材路径无效');
  if (Number(ownerOf(db, inside.replace(/\\/g, '/'))) !== Number(organizationId)) throw new Error('没有权限访问素材');
  return { rel, abs: real };
}

// Only run once, using pre-existing database references. Unknown/ambiguous legacy files stay private.
function backfill(db) {
  if (db.prepare('SELECT 1 FROM security_migrations WHERE name=?').get('private-media-v1')) return;
  db.transaction(() => {
    const record = db.prepare(`INSERT INTO private_media_owners(path,organization_id,created_at) VALUES (?,?,?)
      ON CONFLICT(path) DO UPDATE SET organization_id=CASE WHEN organization_id=excluded.organization_id THEN organization_id ELSE 0 END`);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      if (!/^[a-z_]+$/.test(name) || name === 'private_media_owners') continue;
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
      const mediaColumns = columns.filter(c => /(?:local_path|image_url|video_url|audio_url|thumbnail|extra_images|reference_images|four_view_image_url|seedance2_voice_asset)$/.test(c));
      if (!mediaColumns.length) continue;
      let orgSql;
      if (columns.includes('organization_id')) orgSql = 't.organization_id';
      else if (columns.includes('drama_id')) orgSql = '(SELECT organization_id FROM dramas WHERE id=t.drama_id)';
      else if (columns.includes('episode_id')) orgSql = '(SELECT d.organization_id FROM episodes e JOIN dramas d ON d.id=e.drama_id WHERE e.id=t.episode_id)';
      else continue;
      for (const row of db.prepare(`SELECT ${orgSql} AS tenant, ${mediaColumns.map(c => `t."${c}"`).join(',')} FROM "${name}" t`).all()) {
        if (!row.tenant) continue;
        function collect(value) {
          if (Array.isArray(value)) return value.forEach(collect);
          if (value && typeof value === 'object') return Object.values(value).forEach(collect);
          if (typeof value !== 'string' || !value || value.startsWith('data:')) return;
          if (/^[\[{]/.test(value)) { try { collect(JSON.parse(value)); } catch (_) {} return; }
          try {
            const rel = relativePath(value);
            if (rel && !/^(org|projects)\//.test(rel)) record.run(rel, row.tenant, new Date().toISOString());
          } catch (_) {}
        }
        mediaColumns.forEach(c => collect(row[c]));
      }
    }
    db.prepare('INSERT INTO security_migrations VALUES (?,?)').run('private-media-v1', new Date().toISOString());
  })();
}

function configure(db, cfg) {
  const root = path.resolve(cfg.storage?.local_path || './data/storage');
  fs.mkdirSync(root, { recursive: true });
  const keyPath = path.join(path.dirname(path.resolve(cfg.database.path)), '.media-signing-key');
  try { fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const secret = fs.readFileSync(keyPath);
  if (secret.length !== 32) throw new Error('素材签名密钥无效');
  backfill(db);
  context = { db, root, secret, baseUrl: cfg.storage?.base_url || '' };
  return context;
}

function assertLocalAccess(value) {
  if (!context) {
    if (process.env.NODE_ENV === 'production') throw new Error('素材权限服务未初始化');
    return;
  }
  let raw = value;
  if (path.isAbsolute(String(value)) && !String(value).startsWith('/static/')) raw = path.relative(context.root, value).replace(/\\/g, '/');
  return checkedPath(context.db, context.root, raw, getTenantId());
}

function readLocalFile(value, ...options) {
  assertLocalAccess(value);
  return fs.readFileSync(value, ...options);
}

function providerUrlForFile(value) {
  const checked = assertLocalAccess(value);
  if (!checked) throw new Error('素材权限服务未初始化');
  return signForProvider('/static/' + checked.rel);
}

function signature(secret, rel, org, expires) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify([rel, org, expires])).digest('hex');
}

function signForProvider(value) {
  if (!context || !value || typeof value !== 'string' || value.startsWith('data:')) return value;
  let rel;
  if (/^https?:\/\//.test(value)) {
    const parsed = new URL(value);
    const legacyLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.pathname.startsWith('/static/');
    if (!legacyLocal && (!context.baseUrl || !value.startsWith(context.baseUrl.replace(/\/$/, '') + '/'))) return value;
    rel = relativePath(value);
  } else if (value.startsWith('/static/') || /^(org|projects|library|images|videos|audio|uploads|characters|scenes|props)\//.test(value)) rel = relativePath(value);
  else return value;
  const org = getTenantId();
  checkedPath(context.db, context.root, rel, org);
  if (!context.baseUrl) throw new Error('请配置 HTTPS 素材公网地址后使用外部参考素材');
  const expires = Math.floor(Date.now() / 1000) + 600;
  const url = new URL(context.baseUrl.replace(/\/$/, '') + '/' + rel.split('/').map(encodeURIComponent).join('/'));
  url.searchParams.set('expires', expires);
  url.searchParams.set('org', org);
  url.searchParams.set('signature', signature(context.secret, rel, org, expires));
  return url.href;
}

function providerPayload(value) {
  if (Array.isArray(value)) return value.map(providerPayload);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, providerPayload(v)]));
  // Only URLs are rewritten here; local files are read by provider-specific adapters.
  if (typeof value === 'string' && (value.startsWith('/static/') || /^https?:\/\//.test(value))) return signForProvider(value);
  return value;
}

function authorize(db, root, secret) {
  const auth = require('./authService');
  return (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
    try {
      const rel = relativePath(req.path.replace(/^\//, ''));
      let org;
      if (req.query.signature) {
        const expires = Number(req.query.expires);
        org = Number(req.query.org);
        const now = Math.floor(Date.now() / 1000);
        const expected = signature(secret, rel, org, expires);
        const given = String(req.query.signature);
        if (!Number.isInteger(expires) || expires <= now || expires > now + 600 || !/^[a-f0-9]{64}$/.test(given) || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return res.sendStatus(403);
      } else {
        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('media_session='))?.slice(14);
        const user = auth.resolveSession(db, bearer || cookie || '');
        if (!user) return res.sendStatus(401);
        org = user.organization.id;
      }
      const file = checkedPath(db, root, rel, org);
      if (!/\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|mp3|wav|ogg|m4a|aac|flac)$/i.test(rel)) res.attachment(path.basename(rel));
      res.sendFile(file.abs, { cacheControl: false, dotfiles: 'deny' }, err => { if (err && !res.headersSent) res.sendStatus(404); });
    } catch (_) { res.sendStatus(404); }
  };
}

function validateReferences(req, res, next) {
  try {
    function visit(value, key = '', depth = 0) {
      if (depth > 30) throw new Error('参数层级过深');
      if (Array.isArray(value)) return value.forEach(v => visit(v, key, depth + 1));
      if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => visit(v, k, depth + 1));
      if (typeof value !== 'string' || !value || value.startsWith('data:')) return;
      if (/local_path|image|video|audio|thumbnail|frame_url|^url$|^path$/.test(key)) {
        if (/^[\[{]/.test(value)) { visit(JSON.parse(value), key, depth + 1); return; }
        if (value.includes('/static/') || /^(org|projects|library|images|videos|audio|uploads|characters|scenes|props)\//.test(value) || /local_path|^path$/.test(key)) assertLocalAccess(value);
      }
    }
    visit(req.body); visit(req.query);
    next();
  } catch (_) { res.status(403).json({ success: false, error: { code: 'MEDIA_FORBIDDEN', message: '素材不存在或不属于当前工作区' } }); }
}

module.exports = { configure, relativePath, ownerOf, checkedPath, backfill, authorize, assertLocalAccess, readLocalFile, providerUrlForFile, signForProvider, providerPayload, validateReferences, signature };
