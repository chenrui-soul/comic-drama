const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');

const initialized = new WeakSet();
const MAX_BYTES = 1024 * 1024;
const ADAPTER = `平台接入约定（优先处理运行环境差异，不改写原技能的创作原则）：
当前任务仅编译一条视频的自然语言 main_prompt，不输出 JSON 生成包、审批报告或附件，不执行脚本或外部工具。
一个平台分镜记录对应一次独立视频请求，可在其时长内包含多个节拍。只使用给定当前分镜的剧情范围；整集与邻镜仅供连戏。
当前素材清单为拟提交图片，不代表已上传给视频模型。未提供声音/视频参考、已审批故事板包或视觉识别结果，禁止声称已有这些输入。
保留用户给定的时长、画幅、风格、台词和人物身份；不能自动更换模型或伪造 voice_ref、审批状态。
原技能的机器包、审批和附件命名要求由平台界面承担，不把这些执行指令写入视频提示词。
素材采用平台 @图片N 编号。可见绑定写成“绑定资产：@图片N 对象，锁定范围和必要边界”，编号及对象必须与本次参考清单对应。
没有参考图时不编造图片编号；素材不齐时只能作为待审核文字草稿。资产图只锁定身份/材质/场景，不机械复制其多视角拼图构图。
不继承内置的至少两步运镜、固定镜头比例、竖屏密度、重复润色必须换措辞、多子分镜固定行数要求。运镜和节拍以本规则包及导演意图为准。
润色保留原稿正确内容，只修正问题，无需为了不同而改写。原稿与规则冲突时按规则修复；禁止扩展剧情或挪用邻镜台词。
只输出可直接用于视频生成的中文提示词。时间轴使用 [0-5秒 | 镜头1] 这类起止区间，连续覆盖 0 到给定总秒数，不改时长。`;

function fail(message) { const e = new Error(message); e.status = 400; throw e; }
function safeName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some(p => p === '..' || p === '.') || n.includes('\0')) fail('规则包包含不安全的文件路径');
  return n;
}
function normalizePack(input) {
  if (!input || !Array.isArray(input.files) || input.files.length > 100) fail('规则包需包含 files，最多 100 个文本文件');
  const names = new Set(); let bytes = 0;
  const files = input.files.map(f => {
    const name = safeName(f.path);
    if (names.has(name.toLowerCase())) fail('规则包文件路径重复');
    names.add(name.toLowerCase());
    if (typeof f.content !== 'string' || f.content.includes('\0')) fail('规则包仅支持文本文件');
    bytes += Buffer.byteLength(f.content);
    if (bytes > MAX_BYTES) fail('规则包解压后文本不能超过 1 MB');
    return { path: name, content: f.content };
  });
  const skill = files.find(f => /(^|\/)SKILL\.md$/i.test(f.path));
  if (!skill) fail('规则包缺少 SKILL.md');
  let meta = {};
  const front = skill.content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  try { if (front) meta = yaml.load(front[1], { schema: yaml.JSON_SCHEMA }) || {}; } catch (_) { fail('SKILL.md 的 YAML 头格式错误'); }
  const name = String(input.name || meta.display_name || meta.name || '自定义视频提示词').trim().slice(0, 120);
  const version = String(input.version || meta.version || '1.0').trim().slice(0, 60);
  if (!name || !version) fail('规则名称与版本不能为空');
  // Only instructional documents are included in model context. Scripts and examples remain inspectable attachments.
  const activeFiles = files.filter(f => /(^|\/)SKILL\.md$/i.test(f.path) || /(^|\/)(rules|references)\/.*\.(md|ya?ml|txt)$/i.test(f.path));
  if (activeFiles.reduce((n, f) => n + f.content.length, 0) > 65000) fail('生效规则内容超过 65000 字符，请精简后导入');
  const id = crypto.createHash('sha256').update(JSON.stringify({ name, version, files })).digest('hex').slice(0, 24);
  return { id, name, version, files, source: String(input.source || '用户导入').slice(0, 240), active_paths: activeFiles.map(f => f.path).sort((a, b) => a.localeCompare(b)) };
}
function readUpload(buffer, filename) {
  if (buffer.length > MAX_BYTES) fail('导入文件不能超过 1 MB');
  if (/\.json$/i.test(filename)) { try { return normalizePack(JSON.parse(buffer.toString('utf8'))); } catch (e) { fail(e.status ? e.message : '规则 JSON 格式错误'); } }
  if (/\.md$/i.test(filename)) return normalizePack({ files: [{ path: 'SKILL.md', content: buffer.toString('utf8') }], source: filename });
  if (!/\.zip$/i.test(filename)) fail('支持 ZIP、SKILL.md 或导出的 JSON 规则包');
  let entries;
  try { entries = new AdmZip(buffer).getEntries().filter(e => !e.isDirectory); } catch (_) { fail('无法读取 ZIP 规则包'); }
  if (entries.length > 100) fail('规则包最多支持 100 个文件');
  let bytes = 0;
  const files = entries.map(e => {
    safeName(e.entryName);
    bytes += e.header.size;
    if (bytes > MAX_BYTES) fail('规则包解压后不能超过 1 MB');
    if (!/\.(md|ya?ml|json|txt|mjs|js|py)$/i.test(e.entryName) && !/(^|\/)VERSION$/i.test(e.entryName)) fail('规则包含非文本附件，请移除后导入');
    const content = e.getData();
    if (content.length > MAX_BYTES) fail('规则文件过大');
    return { path: e.entryName, content: content.toString('utf8') };
  });
  return normalizePack({ files, source: filename });
}
function init(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS video_prompt_rule_packs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS video_prompt_rule_settings (drama_id INTEGER PRIMARY KEY, pack_id TEXT, auto_polish INTEGER NOT NULL DEFAULT 0, append_style INTEGER NOT NULL DEFAULT 0);`);
  const source = path.join(__dirname, '../../resources/video-prompt-skills/video-generation-preparation-1.8.1.zip');
  if (fs.existsSync(source)) {
    const pack = readUpload(fs.readFileSync(source), 'Video_Generation_Preparation_Skill_v1.8.1.zip');
    db.prepare('INSERT OR IGNORE INTO video_prompt_rule_packs VALUES (?, ?, ?)').run(pack.id, JSON.stringify(pack), new Date().toISOString());
  }
  initialized.add(db);
}
function getPack(db, id) { init(db); const row = db.prepare('SELECT payload FROM video_prompt_rule_packs WHERE id = ?').get(id); return row ? JSON.parse(row.payload) : null; }
function list(db) { init(db); return db.prepare('SELECT payload, created_at FROM video_prompt_rule_packs ORDER BY created_at DESC').all().map(r => ({ ...JSON.parse(r.payload), created_at: r.created_at })); }
function save(db, input) {
  init(db); const pack = normalizePack(input);
  db.prepare('INSERT OR IGNORE INTO video_prompt_rule_packs VALUES (?, ?, ?)').run(pack.id, JSON.stringify(pack), new Date().toISOString());
  return pack;
}
function getSettings(db, dramaId) {
  init(db);
  const row = db.prepare('SELECT * FROM video_prompt_rule_settings WHERE drama_id = ?').get(Number(dramaId) || 0);
  const pack = row?.pack_id ? getPack(db, row.pack_id) : null;
  if (row?.pack_id && !pack) fail('当前项目规则包丢失，请重新选择规则');
  return { pack_id: pack?.id || null, name: pack?.name || '平台内置规则', version: pack?.version || '', auto_polish: row ? !!row.auto_polish : true, append_style: row ? !!row.append_style : true, custom: !!pack };
}
function setSettings(db, dramaId, body) {
  init(db);
  if (!db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId))) fail('项目不存在');
  if (body.pack_id && !getPack(db, body.pack_id)) fail('规则包不存在');
  if (typeof body.auto_polish !== 'boolean' || typeof body.append_style !== 'boolean') fail('请明确选择自动润色与风格追加开关');
  db.prepare('INSERT OR REPLACE INTO video_prompt_rule_settings VALUES (?, ?, ?, ?)').run(Number(dramaId), body.pack_id || null, +body.auto_polish, +body.append_style);
  return getSettings(db, dramaId);
}
function systemPrompt(pack) {
  return `${pack.files.filter(f => pack.active_paths.includes(f.path)).map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n')}\n\n${ADAPTER}`;
}
module.exports = { init, list, save, getPack, readUpload, normalizePack, getSettings, setSettings, systemPrompt, ADAPTER, fail };
