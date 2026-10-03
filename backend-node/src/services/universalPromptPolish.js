const crypto = require('crypto');
const rules = require('./videoPromptRules');
const compiler = require('./customVideoPrompt');
const { validateSkillStructure } = require('./videoPromptValidation');
const initialized = new WeakSet();
const locks = new WeakMap();
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const revision = row => hash(JSON.stringify([row?.universal_segment_text, row?.duration, ...compiler.FIELDS.map(k => row?.[k]), row?.scene_id, row?.characters]));
function fail(message, status = 409) { const e = new Error(message); e.status = status; throw e; }
function init(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS universal_prompt_polish (
    storyboard_id INTEGER PRIMARY KEY, pack_id TEXT, rule_name TEXT, rule_version TEXT,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, output_hash TEXT,
    input_hash TEXT, updated_at TEXT NOT NULL)`);
  initialized.add(db);
}
function recover(db) {
  init(db);
  db.prepare("UPDATE universal_prompt_polish SET status='failed', error='服务重启中断润色，原文已保留，请补跑', updated_at=? WHERE status='processing'").run(new Date().toISOString());
}
function shot(db, id) { return db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(id); }
function settingsForShot(db, id, body = {}) {
  const row = shot(db, id);
  if (!row) fail('分镜不存在', 404);
  const ep = db.prepare('SELECT drama_id FROM episodes WHERE id=? AND deleted_at IS NULL').get(row.episode_id);
  if (!ep) fail('剧集不存在', 404);
  const settings = rules.getSettings(db, ep.drama_id);
  if (Object.hasOwn(body, 'expected_rule_pack_id') && (body.expected_rule_pack_id || null) !== settings.pack_id) {
    fail('项目规则已改变，本批次停止，避免混用规则。请按当前规则重新补跑');
  }
  return settings;
}
function list(db, episodeId) {
  init(db);
  const ep = db.prepare('SELECT drama_id FROM episodes WHERE id=? AND deleted_at IS NULL').get(Number(episodeId));
  if (!ep) fail('剧集不存在', 404);
  const settings = rules.getSettings(db, ep.drama_id);
  const pack = settings.custom ? rules.getPack(db, settings.pack_id) : null;
  const rows = db.prepare("SELECT * FROM storyboards WHERE episode_id=? AND creation_mode='universal' AND deleted_at IS NULL ORDER BY storyboard_number").all(Number(episodeId));
  return { settings, shots: rows.map(row => {
    const saved = db.prepare('SELECT * FROM universal_prompt_polish WHERE storyboard_id=?').get(row.id);
    const samePack = saved && saved.pack_id === settings.pack_id;
    const sameOutput = saved?.output_hash === hash(row.universal_segment_text);
    let status = samePack ? saved.status : 'pending';
    let error = samePack ? saved.error : '';
    if (status === 'completed' && (!sameOutput || saved.input_hash !== revision(row))) { status = 'pending'; error = '提示词或分镜字段已修改，需要重新核对'; }
    // Legacy prompts never receive invented provenance. Valid structure may be retained.
    if (!saved && pack && row.universal_segment_text) {
      const references = compiler.normalizeSlots(compiler.assetsForShot(db, row));
      const issues = [...compiler.validatePrompt(row.universal_segment_text, row.duration, references, { timelineRequired: true }), ...validateSkillStructure(row.universal_segment_text, pack)];
      if (!issues.length) status = 'legacy_valid';
      else error = issues.slice(0, 3).join('；');
    }
    return { storyboard_id: row.id, storyboard_number: row.storyboard_number, status, error, attempts: samePack ? saved.attempts : 0,
      rule_name: settings.name, rule_version: settings.version, pack_id: settings.pack_id };
  }) };
}

// Remains a per-shot operation, called at the existing post-storyboard polishing step.
async function run(db, log, id, settings, generate, finish, emit = () => {}, options = {}) {
  init(db);
  let busy = locks.get(db); if (!busy) { busy = new Set(); locks.set(db, busy); }
  if (busy.has(id)) fail('该分镜正在润色，请等待完成后再试');
  const original = shot(db, id);
  if (!original) fail('分镜不存在', 404);
  const originalRevision = revision(original);
  busy.add(id);
  const persist = (status, attempts, error = '', outputHash = null, inputHash = originalRevision) => db.prepare(`INSERT OR REPLACE INTO universal_prompt_polish
    (storyboard_id,pack_id,rule_name,rule_version,status,attempts,error,output_hash,input_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, settings.pack_id, settings.name, settings.version, status, attempts, error, outputHash, inputHash, new Date().toISOString());
  const send = event => { try { emit(event); } catch (_) { /* A closed tab does not corrupt the current shot. */ } };
  let error = '', attempt = 0;
  try {
    for (attempt = 1; attempt <= 3; attempt++) {
      settingsForShot(db, id, { expected_rule_pack_id: settings.pack_id });
      if (revision(shot(db, id)) !== originalRevision) fail('分镜或提示词在润色期间已修改，未覆盖你的编辑，请重新润色');
      persist('processing', attempt);
      send({ type: 'reset', attempt, message: attempt > 1 ? `第 ${attempt} 次尝试：修正上次错误` : '开始润色' });
      try {
        const raw = await generate(error, delta => send({ type: 'delta', text: delta }));
        const text = finish(raw);
        if (!text || text.trim().length < 20) throw new Error('AI 返回内容过短');
        // Compare again after AI call: stale requests may not overwrite newer edits/settings.
        db.transaction(() => {
          settingsForShot(db, id, { expected_rule_pack_id: settings.pack_id });
          if (revision(shot(db, id)) !== originalRevision) fail('分镜或提示词在润色期间已修改，未覆盖你的编辑，请重新润色');
          db.prepare('UPDATE storyboards SET universal_segment_text=?,updated_at=? WHERE id=? AND deleted_at IS NULL').run(text, new Date().toISOString(), id);
          persist('completed', attempt, '', hash(text), revision(shot(db, id)));
        })();
        send({ type: 'done', universal_segment_text: text, rule_pack: settings.name, rule_pack_version: settings.version, attempts: attempt });
        return text;
      } catch (e) {
        error = e.message || String(e);
        log.warn('Universal prompt polish attempt failed', { storyboard_id: id, pack_id: settings.pack_id, attempt, error });
        if (e.status === 409 || attempt === 3) throw e;
        await (options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000 * attempt);
      }
    }
  } catch (e) {
    persist('failed', Math.min(attempt, 3), e.message || String(e));
    throw e;
  } finally { busy.delete(id); }
}
module.exports = { init, recover, list, run, settingsForShot, hash, revision };
