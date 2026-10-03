const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');

const initialized = new WeakSet();
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_CHARS = 70000;

const MODULES = Object.freeze([
  'story_generation',
  'character_image_prompt',
  'scene_image_prompt',
  'prop_image_prompt',
]);

const ADAPTERS = {
  story_generation: `平台接入约定：你负责故事梗概到故事/剧本的创作质量。平台会保存你的结果，因此最终只输出 JSON，不要输出 Markdown 代码围栏或解释。格式必须是 [ { "episode": 1, "title": "第1集", "content": "剧本正文" } ]。content 使用可演出的中文剧本正文；不要生成分镜、图片提示词或视频提示词。若输入只要求一集，仍返回数组。`,
  character_image_prompt: `平台接入约定：你负责把人物描述整理成可直接交给图片模型的人物图提示词。只输出最终提示词正文，不输出资产审批报告、声音资产、JSON、文件名或执行计划。保留人物身份、服装、外观和用户给出的事实；平台会另外追加画风和四视图布局约束。`,
  scene_image_prompt: `平台接入约定：你负责把场景描述整理成可直接交给图片模型的场景图提示词。只输出最终提示词正文，不输出资产包、审批报告、JSON 或执行计划。必须保留空间关系、入口、门窗、固定物和方向信息；平台会根据当前模式追加单图或四视图布局约束。`,
  prop_image_prompt: `平台接入约定：你负责把道具描述整理成可直接交给图片模型的道具图提示词。只输出最终提示词正文，不输出资产审批报告、JSON、文件名或执行计划。只写输入中可见且有依据的外观、材质、结构和细节，不凭空增加剧情设定。`,
};

function fail(message) { const e = new Error(message); e.status = 400; throw e; }
function safeName(name) {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some(p => p === '..' || p === '.') || n.includes('\0')) fail('创作 Skill 包含不安全的文件路径');
  return n;
}
function parseMeta(content) {
  const front = String(content || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!front) return {};
  try { return yaml.load(front[1], { schema: yaml.JSON_SCHEMA }) || {}; } catch (_) { fail('SKILL.md 的 YAML 头格式错误'); }
}
function classify(meta, files) {
  const name = `${meta.name || ''} ${meta.display_name || ''} ${files.map(f => f.path).join(' ')}`.toLowerCase();
  return /inspiration-to-short-drama|screenwriting|编剧|short-drama/.test(name) ? 'story' : 'asset';
}
function activePaths(kind, files) {
  const md = files.filter(f => /\.(md|ya?ml|txt)$/i.test(f.path));
  if (kind === 'story') return md.filter(f => /(^|\/)SKILL\.md$/i.test(f.path) || /inspiration-to-short-drama\/(references|SKILL\.md)/i.test(f.path));
  return md.filter(f => /(^|\/)SKILL\.md$/i.test(f.path) || /(^|\/)(docs|specs|rules|modules)\//i.test(f.path));
}
function normalizePack(input) {
  if (!input || !Array.isArray(input.files) || input.files.length > 160) fail('创作 Skill 包需包含 files，最多 160 个文本文件');
  const names = new Set(); let bytes = 0;
  const files = input.files.map(f => {
    const name = safeName(f.path);
    if (names.has(name.toLowerCase())) fail('创作 Skill 包文件路径重复');
    names.add(name.toLowerCase());
    if (typeof f.content !== 'string' || f.content.includes('\0')) fail('创作 Skill 包仅支持文本文件');
    bytes += Buffer.byteLength(f.content);
    if (bytes > MAX_BYTES) fail('创作 Skill 包解压后文本不能超过 2 MB');
    return { path: name, content: f.content };
  });
  const skill = files.find(f => /(^|\/)SKILL\.md$/i.test(f.path));
  if (!skill) fail('创作 Skill 包缺少 SKILL.md');
  const meta = parseMeta(skill.content);
  const kind = input.kind === 'story' || input.kind === 'asset' ? input.kind : classify(meta, files);
  const name = String(input.name || meta.display_name || meta.metadata?.display_name || meta.name || (kind === 'story' ? '故事剧本 Skill' : '资产提示词 Skill')).trim().slice(0, 120);
  const version = String(input.version || meta.version || meta.metadata?.version || '1.0').trim().slice(0, 60);
  const active = activePaths(kind, files);
  if (!active.length) fail('创作 Skill 没有可生效的说明文件');
  if (active.reduce((n, f) => n + f.content.length, 0) > MAX_ACTIVE_CHARS) fail('创作 Skill 生效规则超过 70000 字符，请精简后导入');
  const id = crypto.createHash('sha256').update(JSON.stringify({ name, version, kind, files })).digest('hex').slice(0, 24);
  return { id, name, version, kind, files, source: String(input.source || '用户导入').slice(0, 240), active_paths: active.map(f => f.path).sort((a, b) => a.localeCompare(b)) };
}
function readUpload(buffer, filename, kind, version) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES) fail('创作 Skill 导入文件不能超过 2 MB');
  if (/\.json$/i.test(filename)) {
    try { return normalizePack({ ...JSON.parse(buffer.toString('utf8')), kind, version }); } catch (e) { fail(e.status ? e.message : '创作 Skill JSON 格式错误'); }
  }
  if (/\.md$/i.test(filename)) return normalizePack({ kind, version, files: [{ path: 'SKILL.md', content: buffer.toString('utf8') }], source: filename });
  if (!/\.zip$/i.test(filename)) fail('支持 ZIP、SKILL.md 或导出的 JSON 创作 Skill 包');
  let entries;
  try { entries = new AdmZip(buffer).getEntries().filter(e => !e.isDirectory); } catch (_) { fail('无法读取创作 Skill ZIP 包'); }
  if (entries.length > 160) fail('创作 Skill 包最多支持 160 个文件');
  let bytes = 0;
  const files = entries.map(e => {
    safeName(e.entryName);
    if (!/\.(md|ya?ml|json|txt|mjs|js|py)$/i.test(e.entryName)) fail('创作 Skill 包含非文本附件，请移除后导入');
    const content = e.getData(); bytes += content.length;
    if (bytes > MAX_BYTES) fail('创作 Skill 包解压后不能超过 2 MB');
    return { path: e.entryName, content: content.toString('utf8') };
  });
  return normalizePack({ kind, version, files, source: filename });
}
function init(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS creative_skill_packs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS creative_skill_settings (drama_id INTEGER PRIMARY KEY, story_pack_id TEXT, asset_pack_id TEXT);`);
  const dir = path.join(__dirname, '../../resources/creative-skills');
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.zip$/i.test(file)) continue;
      try {
        const seedKind = /asset/i.test(file) ? 'asset' : 'story';
        const version = /inspiration-to-short-drama/i.test(file) ? '2.0-20260913' : ((file.match(/(\d+(?:\.\d+){1,2})/) || [])[1]);
        const pack = readUpload(fs.readFileSync(path.join(dir, file)), file, seedKind, version);
        db.prepare('INSERT OR IGNORE INTO creative_skill_packs VALUES (?, ?, ?)').run(pack.id, JSON.stringify(pack), new Date().toISOString());
      } catch (e) { console.warn('[creativeSkillPacks] seed failed:', file, e.message); }
    }
  }
  initialized.add(db);
}
function getPack(db, id) { init(db); const row = db.prepare('SELECT payload FROM creative_skill_packs WHERE id = ?').get(id); return row ? JSON.parse(row.payload) : null; }
function list(db) { init(db); return db.prepare('SELECT payload, created_at FROM creative_skill_packs ORDER BY created_at DESC').all().map(r => ({ ...JSON.parse(r.payload), created_at: r.created_at })); }
function save(db, input) { init(db); const pack = normalizePack(input); db.prepare('INSERT OR IGNORE INTO creative_skill_packs VALUES (?, ?, ?)').run(pack.id, JSON.stringify(pack), new Date().toISOString()); return pack; }
function getSettings(db, dramaId) {
  init(db);
  const row = db.prepare('SELECT * FROM creative_skill_settings WHERE drama_id = ?').get(Number(dramaId) || 0);
  const story = row?.story_pack_id ? getPack(db, row.story_pack_id) : null;
  const asset = row?.asset_pack_id ? getPack(db, row.asset_pack_id) : null;
  if (row?.story_pack_id && !story) fail('当前项目故事 Skill 丢失，请重新选择');
  if (row?.asset_pack_id && !asset) fail('当前项目资产 Skill 丢失，请重新选择');
  return { story_pack_id: story?.id || null, story_name: story?.name || '平台内置故事规则', story_version: story?.version || '', asset_pack_id: asset?.id || null, asset_name: asset?.name || '平台内置资产规则', asset_version: asset?.version || '' };
}
function setSettings(db, dramaId, body) {
  init(db);
  if (!db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId))) fail('项目不存在');
  for (const key of ['story_pack_id', 'asset_pack_id']) if (body[key] && !getPack(db, body[key])) fail('创作 Skill 不存在');
  db.prepare('INSERT OR REPLACE INTO creative_skill_settings VALUES (?, ?, ?)').run(Number(dramaId), body.story_pack_id || null, body.asset_pack_id || null);
  return getSettings(db, dramaId);
}
function modulePackId(settings, module) { return module === 'story_generation' ? settings.story_pack_id : settings.asset_pack_id; }
function getModulePrompt(db, dramaId, module) {
  if (!MODULES.includes(module)) return '';
  const settings = getSettings(db, dramaId);
  const pack = getPack(db, modulePackId(settings, module));
  if (!pack) return '';
  const body = pack.files.filter(f => pack.active_paths.includes(f.path)).map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
  return `${body}\n\n${ADAPTERS[module]}`;
}
function composeSystemPrompt(db, dramaId, module, basePrompt) {
  const custom = getModulePrompt(db, dramaId, module);
  return custom ? `${custom}\n\n平台内置格式规则（必须遵守）：\n${basePrompt || ''}` : (basePrompt || '');
}
module.exports = { MODULES, init, list, save, getPack, readUpload, normalizePack, getSettings, setSettings, getModulePrompt, composeSystemPrompt, fail };
