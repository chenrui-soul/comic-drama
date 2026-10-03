const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const express = require('express');
const { buildPlan, publicPlan, createArchive } = require('../src/services/videoDownloadService');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-download-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE dramas (id INTEGER, title TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER, drama_id INTEGER, episode_number INTEGER, deleted_at TEXT);
    CREATE TABLE storyboards (id INTEGER, episode_id INTEGER, storyboard_number INTEGER, title TEXT, video_url TEXT, deleted_at TEXT);
    CREATE TABLE video_generations (id INTEGER, storyboard_id INTEGER, video_url TEXT, local_path TEXT, status TEXT, created_at TEXT, deleted_at TEXT);
    INSERT INTO dramas VALUES (1, '测试/短剧', NULL), (2, '其他项目', NULL);
    INSERT INTO episodes VALUES (10, 1, 1, NULL), (11, 1, 2, NULL), (20, 2, 1, NULL);
    INSERT INTO storyboards VALUES (100,10,1,'镜头/一','https://example.com/old.mp4',NULL),
      (101,10,2,'未生成',NULL,NULL), (102,11,1,'第二集',NULL,NULL),
      (103,10,3,'已删除',NULL,'deleted');
    INSERT INTO video_generations VALUES
      (1,100,'https://example.com/old.mp4','old.mp4','completed','2026-01-01',NULL),
      (2,100,'https://example.com/new.mp4','new.mp4','completed','2026-01-02',NULL),
      (3,100,NULL,'failed.mp4','failed','2026-01-03',NULL),
      (4,100,NULL,'deleted.mp4','completed','2026-01-04','deleted'),
      (5,102,NULL,'episode2.mp4','completed','2026-01-01',NULL),
      (6,103,NULL,'deleted-board.mp4','completed','2026-01-01',NULL);
  `);
  for (const name of ['old.mp4', 'new.mp4', 'episode2.mp4']) fs.writeFileSync(path.join(root, name), `contents:${name}`);
  const cfg = { storage: { local_path: root } };
  const plan = options => buildPlan(db, cfg, 1, { scope: 'episode', episode_id: 10, ...options });
  return { db, root, cfg, plan };
}

test('selected main respects persisted selection and current UI selection, then defaults to newest', t => {
  const { db, plan } = fixture(t);
  assert.deepEqual(plan().files.map(f => f.video_id), [1]);
  assert.deepEqual(plan({ selected_video_ids: { 100: 2 } }).files.map(f => f.video_id), [2]);
  assert.equal(plan({ selected_video_ids: { 100: 5 } }).files.length, 0);
  db.exec('UPDATE storyboards SET video_url = NULL WHERE id = 100');
  assert.deepEqual(plan().files.map(f => f.video_id), [2]);
});

test('all episodes and history include only completed, undeleted videos in the project', t => {
  const { plan } = fixture(t);
  const result = plan({ scope: 'all', mode: 'all' });
  assert.deepEqual(result.files.map(f => f.video_id), [2, 1, 5]);
  assert.equal(new Set(result.files.map(f => f.name)).size, 3);
  assert.match(result.files[0].name, /^第001集\/镜头001_镜头_一_s100_版本002_v2.mp4$/);
  assert.match(result.files[2].name, /^第002集\//);
  assert.equal(result.skipped.length, 1);
  assert.throws(() => plan({ episode_id: 20 }), /不属于此项目/);
  assert.throws(() => plan({ mode: 'invalid' }), /选项无效/);
});

test('missing selected file is reported and never silently replaced by another version', t => {
  const { root, plan } = fixture(t);
  fs.unlinkSync(path.join(root, 'old.mp4'));
  const result = plan();
  assert.equal(result.files.length, 0);
  assert.match(result.skipped[0].reason, /文件已缺失/);
});

test('storage traversal and nonvideo files are excluded; local main URLs work', t => {
  const { db, root, plan } = fixture(t);
  fs.writeFileSync(path.join(root, 'image.png'), 'not video');
  db.exec("UPDATE video_generations SET local_path='../outside.mp4' WHERE id=1");
  assert.equal(plan().files.length, 0);
  db.exec("UPDATE video_generations SET local_path='image.png' WHERE id=1");
  assert.equal(plan().files.length, 0);
  db.exec("UPDATE storyboards SET video_url='/static/new.mp4' WHERE id=100");
  assert.equal(plan().files[0].video_id, 2);
});

test('streamed ZIP preserves file contents, readable Chinese names and a skip manifest', async t => {
  const { plan } = fixture(t);
  const result = plan({ scope: 'all', mode: 'all' });
  const zip = createArchive(result);
  zip.on('error', error => zip.outputStream.destroy(error));
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const archive = new AdmZip(Buffer.concat(chunks));
  assert.equal(archive.getEntries().length, 4);
  assert.equal(archive.readAsText(result.files[0].name), 'contents:new.mp4');
  assert.deepEqual(JSON.parse(archive.readAsText('下载清单.json')), publicPlan(result));
  assert.equal('absolute' in publicPlan(result).files[0], false);
});

test('prepare and native download HTTP routes serve a ZIP and reject empty/invalid downloads', async t => {
  const { db, cfg } = fixture(t);
  const handlers = require('../src/routes/videoDownloads')(db, cfg, { warn() {} });
  const app = express();
  app.use(express.json());
  app.post('/api/v1/dramas/:id/video-downloads', handlers.prepare);
  app.get('/api/v1/dramas/:id/video-downloads/:token', handlers.download);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/v1/dramas/1/video-downloads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'all', mode: 'all' }),
  });
  const { data } = await response.json();
  assert.equal(data.count, 3);
  const download = await fetch(base + data.download_url);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal(new AdmZip(Buffer.from(await download.arrayBuffer())).getEntries().length, 4);
  assert.equal((await fetch(base + data.download_url.replace('/dramas/1/', '/dramas/2/'))).status, 400);
  assert.equal((await fetch(`${base}/api/v1/dramas/1/video-downloads/missing`)).status, 400);
});
