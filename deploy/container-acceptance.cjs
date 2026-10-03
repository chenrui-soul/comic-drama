// Real HTTPS checks against the isolated acceptance stack. Never calls an AI provider.
// ACCEPTANCE_CA and ACCEPTANCE_STATE must point to files outside the source tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');

const origin = new URL(process.env.ACCEPTANCE_ORIGIN || 'https://localhost:18443');
if (origin.protocol !== 'https:' || origin.hostname !== 'localhost') throw new Error('Acceptance tests are restricted to HTTPS localhost');
const ca = fs.readFileSync(process.env.ACCEPTANCE_CA);
const stateFile = process.env.ACCEPTANCE_STATE;
if (!stateFile) throw new Error('ACCEPTANCE_STATE is required');

function request(route, { method = 'GET', body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = https.request(new URL(route, origin), {
      method, ca, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
      }, timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json; try { json = JSON.parse(buffer); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, buffer, data: json?.data, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTPS request timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
const api = (route, body, token, method = 'POST') => request('/api/v1' + route, { method, body, token });
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json?.error || { status: r.status })); return r; };

async function seed() {
  ok(await request('/health'));
  const page = ok(await request('/'));
  assert.match(page.buffer.toString(), /<div id="app">/);
  const asset = page.buffer.toString().match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  assert.match(ok(await request(asset)).headers['content-type'], /javascript/);
  const suffix = Date.now();
  const password = crypto.randomBytes(18).toString('base64url');
  const a = ok(await api('/auth/register', { email: `owner-${suffix}@acceptance.invalid`, password }), 201).data;
  const b = ok(await api('/auth/register', { email: `member-${suffix}@acceptance.invalid`, password }), 201).data;
  const login = ok(await api('/auth/login', { email: a.user.email, password }));
  const setCookie = login.headers['set-cookie'].find(c => c.startsWith('media_session='));
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const drama = ok(await api('/dramas', { title: 'Container acceptance project' }, a.session.token), 201).data;
  ok(await api('/dramas/' + drama.id, undefined, b.session.token, 'GET'), 404);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
  const boundary = 'acceptance-' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`),
    png, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const uploaded = ok(await request('/api/v1/upload/image', { method: 'POST', body, token: a.session.token, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary } })).data;
  const mediaPath = new URL(uploaded.url).pathname;
  ok(await request(mediaPath), 401);
  ok(await request(mediaPath, { token: b.session.token }), 404);
  assert.deepEqual(ok(await request(mediaPath, { headers: { Cookie: cookie } })).buffer, png);
  const range = ok(await request(mediaPath, { token: a.session.token, headers: { Range: 'bytes=0-7' } }), 206);
  assert.match(range.headers['cache-control'], /no-store/);
  assert.equal(range.buffer.length, 8);
  ok(await api('/organization/invitations', { email: b.user.email }, a.session.token), 400);
  const invite = ok(await api('/organization/invitations', { email: b.user.email, recipient_user_id: b.user.id }, a.session.token), 201).data;
  ok(await api('/auth/invitations/' + invite.id + '/accept', {}, b.session.token));
  const member = ok(await api('/auth/switch-organization', { organization_id: a.user.organization.id }, b.session.token)).data;
  ok(await request(mediaPath, { token: member.session.token }));
  ok(await api('/organization/members/' + b.user.id, undefined, a.session.token, 'DELETE'));
  ok(await request(mediaPath, { token: member.session.token }), 401);
  for (let i = 0; i < 10; i++) ok(await api('/auth/login', { email: 'nonexistent@acceptance.invalid', password: 'wrong' }), 401);
  const limited = ok(await api('/auth/login', { email: 'NONEXISTENT@acceptance.invalid', password: 'wrong' }), 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  fs.writeFileSync(stateFile, JSON.stringify({ a, b, member, password, drama, uploaded, cookie }), { mode: 0o600 });
  console.log('PASS: HTTPS, frontend assets, Secure cookie, upload, ranges, tenant isolation, invitations, member removal, login throttling');
}

async function persisted() {
  const state = JSON.parse(fs.readFileSync(stateFile));
  const { a, b, member, uploaded, drama, cookie } = state;
  ok(await request('/health'));
  ok(await api('/auth/me', undefined, a.session.token, 'GET'));
  ok(await api('/dramas/' + drama.id, undefined, a.session.token, 'GET'));
  const mediaPath = new URL(uploaded.url).pathname;
  ok(await request(mediaPath, { headers: { Cookie: cookie } }));
  ok(await request(mediaPath, { token: b.session.token }), 404);
  ok(await request(mediaPath, { token: member.session.token }), 401);
  if (process.env.EXPECT_REGISTRATION_CLOSED === 'true') ok(await api('/auth/register', { email: 'closed@acceptance.invalid', password: 'Acceptance123!' }), 403);
  console.log('PASS: persisted account/session/project/media and membership revocation after container restart');
}

async function video() {
  const { a } = JSON.parse(fs.readFileSync(stateFile));
  const url = `/static/org/${a.user.organization.id}/library/acceptance.mp4`;
  const response = ok(await request(url, { token: a.session.token, headers: { Range: 'bytes=0-31' } }), 206);
  assert.equal(response.buffer.length, 32);
  assert.match(response.headers['content-type'], /video\/mp4/);
  ok(await request(url), 401);
  if (process.env.ACCEPTANCE_SIGNED_URL_FILE) {
    const signed = fs.readFileSync(process.env.ACCEPTANCE_SIGNED_URL_FILE, 'utf8').trim();
    assert.equal(new URL(signed).origin, origin.origin);
    ok(await request(signed));
    const bad = new URL(signed); bad.searchParams.set('signature', '0'.repeat(64));
    ok(await request(bad.href), 403);
  }
  console.log('PASS: real FFmpeg MP4 preview/range access and signed URL validation through HTTPS');
}

({ seed, persisted, video }[process.argv[2] || 'seed'] || (() => { throw new Error('Unknown mode'); }))().catch(err => { console.error(err.message); process.exitCode = 1; });
