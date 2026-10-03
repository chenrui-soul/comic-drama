// Run inside the application image with a restored acceptance-only volume.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.join(process.cwd(), 'package.json'));
const state = JSON.parse(fs.readFileSync(process.env.ACCEPTANCE_STATE));
const { createApp } = appRequire('./src/app');
const { getDb, closeDb } = appRequire('./src/db');

(async () => {
  const { app, config } = createApp();
  const db = getDb(config.database);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(db.prepare('SELECT email FROM users WHERE id=?').get(state.a.user.id).email, state.a.user.email);
  assert.equal(db.prepare('SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=?').get(state.a.user.organization.id, state.b.user.id), undefined);
  assert.equal(fs.readFileSync(path.join(path.dirname(config.database.path), '.media-signing-key')).length, 32);
  assert.equal(fs.readFileSync(path.join(path.dirname(config.database.path), 'invitation-token.key')).length, 32);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const media = new URL(state.uploaded.url).pathname;
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + media)).status, 401);
    assert.equal((await fetch(base + media, { headers: { Authorization: `Bearer ${state.a.session.token}` } })).status, 200);
    assert.equal((await fetch(base + media, { headers: { Authorization: `Bearer ${state.member.session.token}` } })).status, 401);
    assert.equal((await fetch(base + '/api/v1/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'closed@acceptance.invalid', password: 'Acceptance123!' }) })).status, 403);
    const sharp = appRequire('sharp');
    const output = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#404040' } }).resize(16, 16).png().toBuffer();
    assert.ok(output.length > 0);
    console.log('PASS: restored Linux container boots, SQLite integrity, keys, sessions, private media, revoked access, closed registration and sharp native module');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closeDb(); }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
