// Run only inside the isolated acceptance app container. Writes a synthetic MP4.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.join(process.cwd(), 'package.json'));
const { loadConfig } = appRequire('./src/config');
const { getDb, closeDb } = appRequire('./src/db');
const media = appRequire('./src/services/privateMedia');
const { runWithTenant } = appRequire('./src/utils/tenantContext');
const config = loadConfig();
assert.equal(new URL(config.storage.base_url).origin, 'https://localhost:18443');
const organizationId = Number(process.env.ACCEPTANCE_ORG_ID);
assert.ok(Number.isSafeInteger(organizationId) && organizationId > 0);
const db = getDb(config.database);
try {
  const owner = db.prepare('SELECT u.email FROM users u JOIN organization_members m ON m.user_id=u.id WHERE m.organization_id=? AND m.role=?').get(organizationId, 'owner');
  assert.match(owner?.email || '', /^owner-\d+@acceptance\.invalid$/);
  const rel = `org/${organizationId}/library/acceptance.mp4`;
  const file = path.join(config.storage.local_path, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' }));
  assert.equal(probe.streams[0].codec_name, 'h264');
  assert.equal(probe.streams[0].width, 160);
  media.configure(db, config);
  fs.writeFileSync('/tmp/acceptance-signed-url.txt', runWithTenant(organizationId, () => media.signForProvider('/static/' + rel)), { mode: 0o600 });
  console.log('PASS: container FFmpeg H.264 generation, ffprobe and media signing');
} finally { closeDb(); }
