const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const auth = require('../src/services/authService');
const media = require('../src/services/privateMedia');
const { runWithTenant } = require('../src/utils/tenantContext');
const { rateLimit, accountKey } = require('../src/middleware/rateLimit');
const { generationQuota } = require('../src/middleware/generationQuota');
const { authenticate } = require('../src/middleware/auth');
const { setMediaCookie } = require('../src/utils/mediaCookie');

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('private media: browser cookies, tenant isolation, revoked sessions, ranges and bounded signed URLs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidrama-security-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const file of ['23_auth_identity.sql', '33_private_media.sql']) db.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  db.exec('CREATE TABLE dramas(id INTEGER PRIMARY KEY, organization_id INTEGER, deleted_at TEXT);');
  const a = auth.register(db, { email: 'a@test.com', password: 'TestPass123!' });
  const b = auth.register(db, { email: 'b@test.com', password: 'TestPass123!' });
  const cfg = { database: { path: path.join(dir, 'db.sqlite') }, storage: { local_path: path.join(dir, 'storage'), base_url: 'https://test.example/static' } };
  const ctx = media.configure(db, cfg);
  const rel = `org/${a.user.organization.id}/library/test.mp4`;
  fs.mkdirSync(path.dirname(path.join(ctx.root, rel)), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, rel), '0123456789');
  fs.writeFileSync(path.join(ctx.root, 'unknown.png'), 'private');
  const app = express();
  app.use(express.json());
  app.get('/cookie', (req, res) => { setMediaCookie(res, a.session); res.sendStatus(204); });
  app.use('/static', media.authorize(db, ctx.root, ctx.secret));
  app.post('/reference', authenticate(db), media.validateReferences, (req, res) => res.sendStatus(204));
  const base = await listen(t, app);
  const url = `${base}/static/${rel}`;
  assert.equal((await fetch(url)).status, 401);
  const cookieResponse = await fetch(base + '/cookie');
  const setCookie = cookieResponse.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/static/);
  const cookie = setCookie.split(';')[0];
  const own = await fetch(url, { headers: { Cookie: cookie, Range: 'bytes=2-5' } });
  assert.equal(own.status, 206);
  assert.equal(await own.text(), '2345');
  assert.match(own.headers.get('cache-control'), /no-store/);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${b.session.token}` } })).status, 404);
  assert.equal((await fetch(base + '/static/unknown.png', { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(base + '/static/org%2F1%2F..%2F..%2Fsecret', { headers: { Cookie: cookie } })).status, 404);
  const signed = new URL(runWithTenant(a.user.organization.id, () => media.signForProvider('/static/' + rel)));
  assert.equal((await fetch(base + signed.pathname + signed.search)).status, 200);
  signed.searchParams.set('org', b.user.organization.id);
  assert.equal((await fetch(base + signed.pathname + signed.search)).status, 403);
  signed.searchParams.set('org', a.user.organization.id);
  signed.searchParams.set('expires', Math.floor(Date.now() / 1000) - 1);
  assert.equal((await fetch(base + signed.pathname + signed.search)).status, 403);
  assert.throws(() => runWithTenant(b.user.organization.id, () => media.signForProvider('/static/' + rel)), /权限/);
  assert.equal((await fetch(base + '/reference', { method: 'POST', headers: { Authorization: `Bearer ${b.session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ extra_images: JSON.stringify(['/static/' + rel]) }) })).status, 403);
  auth.revokeSession(db, a.session.token);
  assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 401);
});

test('legacy backfill only grants known unambiguous ownership and does not re-grant on restart', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/33_private_media.sql'), 'utf8'));
  db.exec(`CREATE TABLE dramas(id INTEGER PRIMARY KEY, organization_id INTEGER, deleted_at TEXT);
    CREATE TABLE characters(drama_id INTEGER, local_path TEXT);
    INSERT INTO dramas VALUES (1,10,NULL),(2,20,NULL);
    INSERT INTO characters VALUES (1,'library/a.png'),(1,'library/shared.png'),(2,'library/shared.png');`);
  media.backfill(db);
  assert.equal(media.ownerOf(db, 'library/a.png'), 10);
  assert.equal(media.ownerOf(db, 'library/shared.png'), 0);
  db.exec("INSERT INTO characters VALUES (2,'library/a.png')");
  media.backfill(db);
  assert.equal(media.ownerOf(db, 'library/a.png'), 10);
});

test('login account limiter cannot be bypassed by email case; state expires and IP headers are untrusted', async t => {
  let now = 1000;
  const app = express(); app.use(express.json());
  app.post('/login', rateLimit({ limit: 2, windowMs: 1000, key: accountKey, clock: () => now }), (req, res) => res.sendStatus(204));
  app.get('/ip', rateLimit({ limit: 1, windowMs: 1000, clock: () => now }), (req, res) => res.sendStatus(204));
  const base = await listen(t, app);
  const login = email => fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal((await login('A@test.com')).status, 204);
  assert.equal((await login(' a@test.com ')).status, 204);
  const limited = await login('a@test.com');
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal((await fetch(base + '/ip', { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status, 204);
  assert.equal((await fetch(base + '/ip', { headers: { 'X-Forwarded-For': '2.2.2.2' } })).status, 429);
  now += 1001;
  assert.equal((await login('a@test.com')).status, 204);
});

test('daily AI request quota persists across middleware instances and isolates organizations', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/34_usage_limits.sql'), 'utf8'));
  const app = express();
  app.use((req, res, next) => { req.user = { organization: { id: Number(req.query.org || 1) } }; next(); });
  app.post('/a', generationQuota(db, 1), (req, res) => res.sendStatus(204));
  app.post('/b', generationQuota(db, 1), (req, res) => res.sendStatus(204));
  const base = await listen(t, app);
  assert.equal((await fetch(base + '/a', { method: 'POST' })).status, 204);
  assert.equal((await fetch(base + '/b', { method: 'POST' })).status, 429);
  assert.equal((await fetch(base + '/b?org=2', { method: 'POST' })).status, 204);
});
