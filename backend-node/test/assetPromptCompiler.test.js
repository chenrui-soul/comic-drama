const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const compiler = require('../src/services/assetPromptCompiler');
const skills = require('../src/services/creativeSkillPacks');
const ai = require('../src/services/aiClient');
const log = { info() {}, warn() {}, error() {} };
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dramas (id INTEGER PRIMARY KEY, style TEXT, metadata TEXT, deleted_at TEXT);
    INSERT INTO dramas VALUES (1,'v1-oriental-xuanhuan','{}',NULL);
    CREATE TABLE characters(id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, appearance TEXT, description TEXT, polished_prompt TEXT, updated_at TEXT, deleted_at TEXT);
    INSERT INTO characters VALUES(1,1,'父亲','朴素衬衣','父亲','旧提示词','old',NULL);
    CREATE TABLE scenes(id INTEGER PRIMARY KEY, drama_id INTEGER, location TEXT, time TEXT, prompt TEXT, polished_prompt TEXT, polished_prompt_single TEXT, updated_at TEXT, deleted_at TEXT);
    INSERT INTO scenes VALUES(1,1,'客厅','日','东侧窗户',NULL,NULL,'old',NULL);
    CREATE TABLE props(id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, type TEXT, description TEXT, prompt TEXT, updated_at TEXT, deleted_at TEXT);
    INSERT INTO props VALUES(1,1,'缝包针','工具','金属针','提取草稿','old',NULL);`);
  const pack = skills.save(db, { kind: 'asset', name: '测试', files: [{ path: 'SKILL.md', content: '逐资产保留输入事实，TEST_SKILL' }] });
  skills.setSettings(db, 1, { asset_pack_id: pack.id });
  return { db, pack };
}
test('selected skill compiles current edits, records provenance and detects changed binding', async t => {
  const { db, pack } = fixture(); t.after(() => db.close());
  t.mock.method(ai, 'generateText', async (_db, _log, _kind, user, system, opts) => {
    assert.match(user, /白衬衣/); assert.match(system, /TEST_SKILL/);
    assert.doesNotMatch(system, /平台内置格式规则|群山|神像/);
    assert.equal(opts.scene_key, 'role_image_polish'); return '身穿白衬衣的父亲';
  });
  const base = compiler.status(db, {}, 'character', 1);
  const out = await compiler.compile(db, log, {}, 'character', 1, { input_revision: base.input_revision, input: { appearance: '白衬衣' } });
  assert.equal(out.ok, true); assert.equal(out.prompt_status.pack_id, pack.id);
  assert.equal(db.prepare('SELECT appearance FROM characters').get().appearance, '白衬衣');
  assert.equal(out.prompt_status.state, 'ready');
  skills.setSettings(db, 1, { asset_pack_id: null });
  assert.equal(compiler.status(db, {}, 'character', 1).state, 'stale');
  assert.equal(compiler.checkReuse(db, {}, 'character', 1).status, 409);
  assert.equal(compiler.checkReuse(db, {}, 'character', 1, undefined, undefined, 'keep_current').ok, true);
});
test('skill failures preserve existing prompt and are visible', async t => {
  const { db } = fixture(); t.after(() => db.close());
  t.mock.method(ai, 'generateText', async () => { throw new Error('模型不可用'); });
  const out = await compiler.compile(db, log, {}, 'prop', 1);
  assert.equal(out.ok, false); assert.match(out.error, /Skill.*模型不可用/);
  assert.equal(db.prepare('SELECT prompt FROM props').get().prompt, '提取草稿');
  assert.equal(compiler.status(db, {}, 'prop', 1).last_attempt.status, 'failed');
});
test('concurrent description or skill edits reject stale completion', async t => {
  const { db } = fixture(); t.after(() => db.close());
  t.mock.method(ai, 'generateText', async () => { db.prepare("UPDATE characters SET appearance='用户新编辑'").run(); return '过期结果'; });
  const out = await compiler.compile(db, log, {}, 'character', 1);
  assert.equal(out.status, 409);
  assert.equal(db.prepare('SELECT polished_prompt FROM characters').get().polished_prompt, '旧提示词');
});
test('single and quad scene revisions use scene model routing and separate slots', async t => {
  const { db } = fixture(); t.after(() => db.close());
  t.mock.method(ai, 'generateText', async (_d, _l, _k, _u, _s, opts) => { assert.equal(opts.scene_key, 'scene_image_polish'); return '东侧窗户的客厅'; });
  const single = await compiler.compile(db, log, {}, 'scene', 1, { mode: 'single' });
  const quad = await compiler.compile(db, log, {}, 'scene', 1, { mode: 'quad' });
  assert.equal(single.ok, true); assert.equal(quad.ok, true);
  assert.notEqual(single.prompt_status.revision_id, quad.prompt_status.revision_id);
  assert.equal(compiler.status(db, {}, 'scene', 1, 'single').state, 'ready');
});
