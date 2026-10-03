const assetCompiler = require('./assetPromptCompiler');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
const creativeSkillPacks = require('./creativeSkillPacks');
const { getTenantId } = require('../utils/tenantContext');

function listByDramaId(db, dramaId) {
  const rows = db.prepare(
    'SELECT * FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC'
  ).all(Number(dramaId));
  return rows.map((r) => ({
    id: r.id,
    drama_id: r.drama_id,
    name: r.name,
    type: r.type,
    description: r.description,
    prompt: r.prompt,
    negative_prompt: r.negative_prompt || null,
    image_url: r.image_url,
    local_path: r.local_path,
    extra_images: r.extra_images || null,
    ref_image: r.ref_image || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const episodeId = req.episode_id != null ? Number(req.episode_id) : null;
  const info = db.prepare(
    `INSERT INTO props (organization_id, drama_id, episode_id, name, type, description, prompt, negative_prompt, image_url, local_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    getTenantId() || null,
    req.drama_id,
    episodeId,
    req.name || '',
    req.type ?? null,
    req.description ?? null,
    req.prompt ?? null,
    req.negative_prompt ?? null,
    req.image_url ?? null,
    req.local_path ?? null,
    now,
    now
  );
  log.info('Prop created', { prop_id: info.lastInsertRowid });
  return getById(db, info.lastInsertRowid);
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM props WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!r) return null;
  return {
    id: r.id,
    drama_id: r.drama_id,
    name: r.name,
    type: r.type,
    description: r.description,
    prompt: r.prompt,
    negative_prompt: r.negative_prompt || null,
    image_url: r.image_url,
    local_path: r.local_path,
    extra_images: r.extra_images || null,
    ref_image: r.ref_image || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function update(db, log, id, updates) {
  const existing = getById(db, id);
  if (!existing) return null;
  const set = [];
  const params = [];
  if (updates.name != null) { set.push('name = ?'); params.push(updates.name); }
  if (updates.type != null) { set.push('type = ?'); params.push(updates.type); }
  if (updates.description != null) { set.push('description = ?'); params.push(updates.description); }
  if (updates.prompt != null) { set.push('prompt = ?'); params.push(updates.prompt); }
  if (updates.negative_prompt !== undefined) { set.push('negative_prompt = ?'); params.push(updates.negative_prompt); }
  if (updates.image_url != null) { set.push('image_url = ?'); params.push(updates.image_url); }
  if (updates.local_path !== undefined) { set.push('local_path = ?'); params.push(updates.local_path ?? null); }
  if (updates.extra_images !== undefined) { set.push('extra_images = ?'); params.push(updates.extra_images ?? null); }
  if (updates.ref_image !== undefined) { set.push('ref_image = ?'); params.push(updates.ref_image ?? null); }
  if (set.length === 0) return existing;
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE props SET ' + set.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  log.info('Prop updated', { prop_id: id });
  return getById(db, id);
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE props SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
  if (result.changes === 0) return false;
  log.info('Prop deleted', { prop_id: id });
  return true;
}

/** 软删除本集「从剧本提取」写入的道具（props.episode_id），避免再次提取时与旧数据累加 */
function softDeletePropsByEpisodeId(db, log, episodeId) {
  const now = new Date().toISOString();
  try {
    const result = db.prepare(
      'UPDATE props SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL'
    ).run(now, Number(episodeId));
    log.info('Props soft-deleted by episode', { episode_id: episodeId, count: result.changes });
    return result.changes;
  } catch (e) {
    if ((e.message || '').includes('episode_id')) return 0;
    throw e;
  }
}

function associateWithStoryboard(db, log, storyboardId, propIds) {
  db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(storyboardId);
  const ins = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
  for (const pid of propIds || []) ins.run(storyboardId, pid);
  log.info('Props associated with storyboard', { storyboard_id: storyboardId });
  return true;
}

/**
 * 用文字 AI 生成道具图片提示词并保存到 props.prompt
 * 供「提取道具后异步预生成」和「重新生成提示词」按钮调用
 */
async function generatePropPromptOnly(db, log, cfg, id, modelName, style, options = {}) {
  return assetCompiler.compile(db, log, cfg, 'prop', id, { ...options, model: modelName, style, mode: 'single' });
}

/**
 * 从道具现有图片中反向提取外观描述，更新 description 字段。
 */
async function extractPropFromImage(db, log, cfg, propId) {
  const { generateTextWithVision, resolveEntityImageSource, EXTRACT_PROMPTS } = require('./aiClient');

  const prop = db.prepare(
    'SELECT id, name, type, image_url, local_path, extra_images, ref_image FROM props WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(propId));
  if (!prop) return { ok: false, error: 'prop not found' };

  const imgSrc = resolveEntityImageSource(prop, cfg);
  if (!imgSrc) return { ok: false, error: '该道具暂无参考图片，请先上传图片' };

  const propLabel = prop.name || '道具';
  const { system: systemPrompt, user: userFn } = EXTRACT_PROMPTS.prop;
  const userPrompt = userFn(propLabel);

  let description;
  try {
    description = await generateTextWithVision(db, log, 'text', userPrompt, systemPrompt, imgSrc, { max_tokens: 2000 });
  } catch (err) {
    log.error('[extractPropFromImage] AI 调用失败', { propId, error: err.message });
    const errMsg = /image|vision|visual|multimodal/i.test(err.message)
      ? `AI 模型不支持图片识别，请在「AI 配置」中使用支持视觉的模型（如 GPT-4o、Gemini 1.5 等）【原始错误：${err.message.slice(0, 120)}】`
      : `AI 分析失败：${err.message}`;
    return { ok: false, error: errMsg };
  }

  db.prepare('UPDATE props SET description = ?, updated_at = ? WHERE id = ?')
    .run(description, new Date().toISOString(), Number(propId));

  log.info('[extractPropFromImage] 道具描述提取成功', { propId, description_len: description.length });
  return { ok: true, description };
}

module.exports = {
  listByDramaId,
  create,
  getById,
  update,
  deleteById,
  softDeletePropsByEpisodeId,
  associateWithStoryboard,
  generatePropPromptOnly,
  extractPropFromImage,
};
