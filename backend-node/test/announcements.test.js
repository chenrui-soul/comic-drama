const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('platform announcements: global visibility, platform-only mutations, audit and persistence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-announcements-test-'));
  Object.assign(process.env, {
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://studio.example.com',
    DATABASE_PATH: path.join(dir, 'data', 'drama.db'), STORAGE_PATH: path.join(dir, 'data', 'storage'),
    CONFIG_PATH: path.join(__dirname, '../../deploy/config.production.yaml'),
    PLATFORM_ADMIN_USER_IDS: '',
  });
  const { createApp } = require('../src/app');
  const { getDb, closeDb } = require('../src/db');
  const auth = require('../src/services/authService');
  const { app, config } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
  const db = getDb(config.database);
  const register = email => auth.register(db, { email, password: 'TestPass123!' });
  const owner = register('owner@test.com');
  const foreign = register('foreign@test.com');
  function join(email, role) {
    const person = register(email);
    db.prepare('INSERT INTO organization_members(organization_id,user_id,role,created_at) VALUES (?,?,?,?)')
      .run(owner.user.organization.id, person.user.id, role, new Date().toISOString());
    return auth.switchOrganization(db, person.user, owner.user.organization.id);
  }
  const orgAdmin = join('admin@test.com', 'admin');
  const member = join('member@test.com', 'member');
  const platformAdmin = join('platform@test.com', 'member');
  process.env.PLATFORM_ADMIN_USER_IDS = ` ${platformAdmin.user.id} ;`;
  assert.equal(auth.resolveSession(db, platformAdmin.session.token).is_platform_admin, true);
  const api = async (method, route, session, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.session.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
  };
  const notice = { title: '维护通知', content: '第一行\n<script>alert(1)</script>' };
  assert.equal((await api('GET', '/announcements')).status, 401);
  assert.equal((await api('POST', '/announcements', owner, notice)).status, 403);
  assert.equal((await api('POST', '/announcements', orgAdmin, notice)).status, 403);
  for (const input of [{ title: ' ', content: 'a' }, { title: 'a', content: ' ' }, { title: 3, content: 'a' }, { title: 'x'.repeat(121), content: 'a' }, { title: 'a', content: 'x'.repeat(10001) }, { ...notice, status: 'fake' }]) {
    assert.equal((await api('POST', '/announcements', platformAdmin, input)).status, 400);
  }
  const created = await api('POST', '/announcements', platformAdmin, notice);
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.content, notice.content);
  assert.equal((await api('GET', '/announcements/unread', member)).body.data.item.id, id);
  assert.equal((await api('GET', '/announcements/unread', foreign)).body.data.item.id, id);
  assert.equal((await api('POST', `/announcements/${id}/read`, member)).status, 200);
  assert.equal((await api('GET', '/announcements/unread', member)).body.data.item, null);
  assert.equal((await api('GET', '/announcements/unread', foreign)).body.data.item.id, id);
  assert.equal((await api('POST', `/announcements/${id}/read`, member)).status, 200);
  const visibleToMember = await api('GET', '/announcements?manage=true', member);
  assert.equal(visibleToMember.body.data.items.length, 1);
  assert.equal(visibleToMember.body.data.can_manage, false);
  assert.equal(visibleToMember.cache, 'no-store');
  const visibleToOtherWorkspace = await api('GET', '/announcements', foreign);
  assert.equal(visibleToOtherWorkspace.body.data.total, 1);
  assert.equal((await api('PUT', `/announcements/${id}`, owner, notice)).status, 403);
  assert.equal((await api('PUT', `/announcements/${id}`, orgAdmin, notice)).status, 403);
  assert.equal((await api('PUT', `/announcements/${id}`, platformAdmin, { ...notice, title: '已更新' })).status, 200);
  assert.equal((await api('PUT', `/announcements/${id}`, platformAdmin, { ...notice, status: 'withdrawn' })).status, 200);
  assert.equal((await api('GET', '/announcements', member)).body.data.total, 0);
  assert.equal((await api('GET', '/announcements?manage=true', platformAdmin)).body.data.total, 1);
  assert.equal((await api('PUT', `/announcements/${id}`, platformAdmin, { ...notice, status: 'published' })).status, 200);
  assert.equal((await api('GET', '/announcements', foreign)).body.data.total, 1);
  assert.equal((await api('POST', '/announcements', platformAdmin, { title: '第二条', content: '内容' })).status, 201);
  const paged = await api('GET', '/announcements?page_size=1&page=2', member);
  assert.equal(paged.body.data.total, 2);
  assert.equal(paged.body.data.items[0].id, id);
  const audit = db.prepare('SELECT action FROM platform_audit_logs ORDER BY id').all();
  assert.deepEqual(audit.map(row => row.action), ['announcement.published', 'announcement.updated', 'announcement.withdrawn', 'announcement.published', 'announcement.published']);

  process.env.PLATFORM_ADMIN_USER_IDS = String(foreign.user.id);
  assert.equal((await api('POST', '/announcements', platformAdmin, notice)).status, 403);
  assert.equal((await api('GET', '/announcements', platformAdmin)).body.data.can_manage, false);
  process.env.PLATFORM_ADMIN_USER_IDS = String(platformAdmin.user.id);

  const migration = fs.readFileSync(path.join(__dirname, '../migrations/37_platform_announcements.sql'), 'utf8');
  db.exec(migration);
  db.exec(fs.readFileSync(path.join(__dirname, '../migrations/40_platform_announcement_reads.sql'), 'utf8'));
  const Database = require('better-sqlite3');
  const reopened = new Database(process.env.DATABASE_PATH, { readonly: true });
  try { assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM platform_announcements').get().n, 2); }
  finally { reopened.close(); }
});
