const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

test('production app: fresh migrations, registration switch, upload privacy, invitations, removal, backup restore', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidrama-smoke-'));
  Object.assign(process.env, {
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://studio.example.com',
    DATABASE_PATH: path.join(dir, 'data', 'drama.db'), STORAGE_PATH: path.join(dir, 'data', 'storage'),
    ALLOW_REGISTRATION: 'false', CONFIG_PATH: path.join(__dirname, '../../deploy/config.production.yaml'),
  });
  const { createApp } = require('../src/app');
  const { getDb, closeDb } = require('../src/db');
  const { app, config } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections(); server.close(); closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (route, body, token, method = 'POST') => fetch(base + '/api/v1' + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await api('/auth/register', { email: 'a@test.com', password: 'TestPass123!' })).status, 403);
  process.env.ALLOW_REGISTRATION = 'true';
  const register = async email => {
    const r = await api('/auth/register', { email, password: 'TestPass123!' });
    assert.equal(r.status, 201); assert.match(r.headers.get('set-cookie'), /Secure/);
    return (await r.json()).data;
  };
  const a = await register('a@test.com');
  const b = await register('b@test.com');
  const db = getDb(config.database);
  const ownDrama = await api('/dramas', { title: 'Owner project' }, a.session.token);
  assert.equal(ownDrama.status, 201);
  const ownDramaId = (await ownDrama.json()).data.id;
  const foreignDrama = await api('/dramas', { title: 'Other project' }, b.session.token);
  assert.equal(foreignDrama.status, 201);
  const foreignDramaId = (await foreignDrama.json()).data.id;
  // Empty draft reaches validation without AI calls; authentication and tenant checks still run first.
  const episodeId = db.prepare('INSERT INTO episodes(drama_id,episode_number) VALUES (?,1)').run(ownDramaId).lastInsertRowid;
  const storyboardId = db.prepare('INSERT INTO storyboards(episode_id,storyboard_number) VALUES (?,1)').run(episodeId).lastInsertRowid;
  const polishRoute = `/storyboards/${storyboardId}/universal-segment-polish-stream`;
  assert.equal((await api(polishRoute, {})).status, 401);
  assert.equal((await api(polishRoute, {}, b.session.token)).status, 404);
  const ownPolish = await api(polishRoute, {}, a.session.token);
  assert.equal(ownPolish.status, 400);
  assert.match((await ownPolish.json()).error.message, /编辑器内容不能为空/);
  const foreignCharacter = db.prepare('INSERT INTO characters(drama_id,organization_id,name) VALUES (?,?,?)').run(foreignDramaId, b.user.organization.id, 'Other character').lastInsertRowid;
  assert.equal((await api('/images', { drama_id: ownDramaId, character_id: foreignCharacter }, a.session.token)).status, 404);
  const forgedForm = new FormData();
  forgedForm.append('drama_id', foreignDramaId);
  forgedForm.append('file', new Blob(['not important'], { type: 'image/png' }), 'test.png');
  assert.equal((await fetch(base + '/api/v1/upload/image', { method: 'POST', headers: { Authorization: `Bearer ${a.session.token}` }, body: forgedForm })).status, 404);
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'pixel.png');
  const upload = await fetch(base + '/api/v1/upload/image', { method: 'POST', headers: { Authorization: `Bearer ${a.session.token}` }, body: form });
  assert.equal(upload.status, 200);
  const uploaded = (await upload.json()).data;
  const mediaPath = new URL(uploaded.url).pathname;
  assert.ok(mediaPath.startsWith(`/static/org/${a.user.organization.id}/`));
  assert.equal((await fetch(base + mediaPath)).status, 401);
  assert.equal((await fetch(base + mediaPath, { headers: { Authorization: `Bearer ${a.session.token}` } })).status, 200);
  assert.equal((await fetch(base + mediaPath, { headers: { Authorization: `Bearer ${b.session.token}` } })).status, 404);
  assert.equal((await api('/character-library', { name: 'stolen', local_path: uploaded.local_path }, b.session.token)).status, 403);
  assert.equal((await api('/organization/invitations', { email: b.user.email }, a.session.token)).status, 400);
  const invitationResponse = await api('/organization/invitations', { email: b.user.email, recipient_user_id: b.user.id }, a.session.token);
  assert.equal(invitationResponse.status, 201);
  const invitation = (await invitationResponse.json()).data;
  assert.equal((await api(`/auth/invitations/${invitation.id}/accept`, {}, b.session.token)).status, 200);
  const switched = (await (await api('/auth/switch-organization', { organization_id: a.user.organization.id }, b.session.token)).json()).data;
  const memberHeaders = { Authorization: `Bearer ${switched.session.token}` };
  assert.equal((await fetch(base + mediaPath, { headers: memberHeaders })).status, 200);
  assert.equal((await api('/organization/members/' + b.user.id, undefined, a.session.token, 'DELETE')).status, 200);
  assert.equal((await fetch(base + mediaPath, { headers: memberHeaders })).status, 401);
  // Restore into an isolated directory, including immutable media and signing keys.
  const restoredDir = path.join(dir, 'restore'); fs.mkdirSync(restoredDir);
  await db.backup(path.join(restoredDir, 'drama.db'));
  fs.cpSync(process.env.STORAGE_PATH, path.join(restoredDir, 'storage'), { recursive: true });
  for (const key of ['.media-signing-key', 'invitation-token.key']) fs.copyFileSync(path.join(dir, 'data', key), path.join(restoredDir, key));
  const restored = new Database(path.join(restoredDir, 'drama.db'));
  try {
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n, 2);
    const media = require('../src/services/privateMedia');
    const resolved = media.checkedPath(restored, path.join(restoredDir, 'storage'), uploaded.local_path, a.user.organization.id);
    assert.ok(fs.readFileSync(resolved.abs).length > 0);
  } finally { restored.close(); }
  // Existing database must survive a second migration pass without changing recipient bindings.
  require('../src/db/migrate').runMigrationsAndEnsure(db);
  assert.equal(db.prepare('SELECT recipient_user_id FROM organization_invitations WHERE id=?').get(invitation.id).recipient_user_id, b.user.id);
});
