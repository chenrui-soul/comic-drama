const rules = require('./videoPromptRules');
const { validateSkillStructure } = require('./videoPromptValidation');
const FIELDS = ['title', 'description', 'location', 'time', 'action', 'dialogue', 'narration', 'result', 'atmosphere', 'shot_type', 'movement', 'layout_description', 'angle', 'lighting_style', 'depth_of_field'];
const mediaUrl = row => row?.local_path ? '/static/' + row.local_path.replace(/^\//, '') : row?.image_url || '';
function referenceKey(url) {
  const s = String(url || '').trim();
  try { const u = new URL(s, 'http://platform.local'); return u.pathname.startsWith('/static/') ? decodeURIComponent(u.pathname) : s; } catch (_) { return s; }
}
function assetsForShot(db, sb) {
  const assets = [];
  if (sb.scene_id) {
    const row = db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(sb.scene_id);
    if (row) assets.push({ kind: '场景', name: row.location || row.name || '场景', url: mediaUrl(row) });
  }
  let ids = []; try { ids = JSON.parse(sb.characters || '[]'); } catch (_) {}
  for (const item of ids) {
    const row = db.prepare('SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL').get(Number(item?.id ?? item));
    if (row) assets.push({ kind: '角色', name: row.name, url: mediaUrl(row) });
  }
  const props = db.prepare('SELECT p.* FROM storyboard_props sp JOIN props p ON p.id = sp.prop_id WHERE sp.storyboard_id = ? AND p.deleted_at IS NULL ORDER BY sp.prop_id').all(sb.id);
  for (const row of props) assets.push({ kind: '道具', name: row.name, url: mediaUrl(row) });
  return assets;
}
function normalizeSlots(raw) {
  if (!Array.isArray(raw) || raw.length > 10) rules.fail('参考图最多支持 10 张');
  const seen = new Set();
  return raw.filter(r => r.url).filter(r => { const key = referenceKey(r.url); if (seen.has(key)) return false; seen.add(key); return true; })
    .map((r, i) => ({ tag: `@图片${i + 1}`, kind: String(r.kind || '参考图'), name: String(r.name || '参考图'), url: String(r.url) }));
}
function build(db, sbId, body = {}, opts = {}) {
  const sb = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sbId);
  if (!sb) return null;
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ? AND deleted_at IS NULL').get(sb.episode_id);
  const settings = rules.getSettings(db, episode?.drama_id);
  if (!settings.custom) return null;
  const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(episode.drama_id);
  const pack = rules.getPack(db, settings.pack_id);
  let metadata = {}; try { metadata = JSON.parse(drama.metadata || '{}'); } catch (_) {}
  const fields = Object.fromEntries(FIELDS.map(k => [k, Object.hasOwn(body.field_overrides || {}, k) ? body.field_overrides[k] : sb[k] ?? null]));
  const assets = assetsForShot(db, sb);
  const references = normalizeSlots(body.reference_slots ?? assets);
  const missing = assets.filter(a => !a.url).map(a => `${a.kind}：${a.name}`);
  const duration = Number(body.duration ?? sb.duration ?? metadata.video_clip_duration ?? 10);
  if (!Number.isFinite(duration) || duration < 1 || duration > 120) rules.fail('视频时长应在 1–120 秒之间');
  const neighbor = direction => db.prepare(`SELECT title, action, result, dialogue, narration, layout_description FROM storyboards WHERE episode_id = ? AND storyboard_number ${direction === 'prev' ? '<' : '>'} ? AND deleted_at IS NULL ORDER BY storyboard_number ${direction === 'prev' ? 'DESC' : 'ASC'} LIMIT 1`).get(sb.episode_id, sb.storyboard_number) || null;
  const context = {
    task: opts.polish ? '按当前规则优化草稿，保留正确内容' : '按当前规则编译本段视频提示词',
    duration_seconds: duration, aspect_ratio: metadata.aspect_ratio || '16:9',
    visual_style: metadata.style_prompt_zh || metadata.style_prompt_en || drama.style || '',
    current_segment: fields,
    current_draft: opts.universalSegmentOverride ?? sb.universal_segment_text ?? '',
    previous_segment: neighbor('prev'), next_segment: neighbor('next'),
    episode_script_for_continuity_only: String(episode.script_content || '').slice(0, 20000),
    reference_images: references.map(({ tag, kind, name }) => ({ tag, kind, name })),
    missing_reference_assets: missing,
    input_limitations: ['未向文本模型提供图片像素，不能声称已看图核对布局', '无上游审批包、声音参考或视频参考；仅适配提示词编译'],
  };
  return { ok: true, custom: true, settings, pack, references, missing, context,
    systemPrompt: rules.systemPrompt(pack), userPrompt: JSON.stringify(context, null, 2),
    durationLabel: String(duration), durationSec: duration, sbId: Number(sbId), episodeId: sb.episode_id, storyboardNumber: sb.storyboard_number };
}
function validatePrompt(text, duration, references, { timelineRequired = false } = {}) {
  const issues = [];
  if (!String(text || '').trim()) issues.push('视频提示词为空');
  for (const match of String(text).matchAll(/@图片(\d+)/g)) {
    if (Number(match[1]) < 1 || Number(match[1]) > references.length) issues.push(`${match[0]} 没有对应的本次参考图`);
  }
  const intervals = [...String(text).matchAll(/[\[【]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[|｜]/g)].map(m => [Number(m[1]), Number(m[2])]);
  if (timelineRequired && !intervals.length) issues.push('缺少起止时间轴，请使用 [0-5秒 | 镜头1] 格式');
  let end = 0;
  for (const [a, b] of intervals) { if (Math.abs(a - end) > 0.02 || b <= a) { issues.push('时间轴存在重叠、空隙或倒序'); break; } end = b; }
  if (intervals.length && Math.abs(end - Number(duration)) > 0.02) issues.push(`时间轴结束于 ${end} 秒，与提交时长 ${duration} 秒不一致`);
  return [...new Set(issues)];
}
function finish(db, built, raw) {
  const text = String(raw || '').trim().replace(/^```(?:text|markdown)?\s*\n/i, '').replace(/\n```$/, '');
  if (text.length < 20) rules.fail('AI 返回内容过短');
  const issues = [...validatePrompt(text, built.durationSec, built.references, { timelineRequired: true }), ...validateSkillStructure(text, built.pack)];
  if (issues.length) rules.fail(`规则编译未通过：${issues.join('；')}。原提示词已保留，请调整后重试。`);
  return text;
}
module.exports = { build, finish, validatePrompt, assetsForShot, normalizeSlots, referenceKey, FIELDS };
