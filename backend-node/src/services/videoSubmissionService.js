const crypto = require('crypto');
const client = require('./videoClient');
const tasks = require('./taskService');
const timeline = require('./videoTimelineValidation');
const { getTenantId } = require('../utils/tenantContext');
const initialized = new WeakSet();
function init(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS video_submission_snapshots (
    video_id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, config_id INTEGER NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', actual_duration_ms INTEGER, warning TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS video_submission_fingerprint ON video_submission_snapshots(fingerprint);`);
  initialized.add(db);
}
function fail(message, status = 422) { const err = new Error(message); err.status = status; throw err; }
function safeConfig(config) {
  const s = require('./videoDurationCapability').settingsOf(config);
  const settings = Object.fromEntries(Object.entries(s).filter(([key]) => !/key|token|secret|password|credential/i.test(key)));
  return { id: config.id, provider: config.provider, api_protocol: config.api_protocol, base_url: config.base_url, endpoint: config.endpoint, query_endpoint: config.query_endpoint, model: config.model, default_model: config.default_model, settings };
}
function prepare(db, body) {
  const dramaId = Number(body.drama_id), storyboardId = body.storyboard_id == null ? null : Number(body.storyboard_id);
  const tenantId = getTenantId();
  const drama = tenantId
    ? db.prepare('SELECT * FROM dramas WHERE id=? AND deleted_at IS NULL AND COALESCE(organization_id,1)=?').get(dramaId, tenantId)
    : db.prepare('SELECT * FROM dramas WHERE id=? AND deleted_at IS NULL').get(dramaId);
  if (!drama) fail('项目不存在', 404);
  const sb = storyboardId == null ? null : (tenantId
    ? db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL AND COALESCE(organization_id,1)=?').get(storyboardId, tenantId)
    : db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(storyboardId));
  if (storyboardId != null && !sb) fail('分镜不存在', 404);
  if (sb) {
    const ep = db.prepare('SELECT drama_id FROM episodes WHERE id=?').get(sb.episode_id);
    if (Number(ep?.drama_id) !== dramaId) fail('分镜不属于当前项目', 409);
  }
  const config = body.config_id
    ? (tenantId
      ? db.prepare("SELECT * FROM ai_service_configs WHERE id=? AND COALESCE(organization_id,1)=? AND service_type='video' AND is_active=1 AND deleted_at IS NULL").get(Number(body.config_id), tenantId)
      : db.prepare("SELECT * FROM ai_service_configs WHERE id=? AND service_type='video' AND is_active=1 AND deleted_at IS NULL").get(Number(body.config_id)))
    : client.getDefaultVideoConfig(db, body.model);
  if (!config) fail('未找到可用的视频 AI 配置');
  const model = require('./videoDurationCapability').selectedModel(config, body.model);
  const duration = Object.hasOwn(body, 'duration') ? body.duration : sb?.duration;
  const checked = client.validateVideoDuration(config, model, duration);
  if (!checked.ok) fail(checked.message);
  if (sb && Number(sb.duration) !== duration) fail(`提交时长 ${duration} 秒与分镜 ${sb.duration} 秒不一致，请更新分镜计划和提示词后提交`, 409);
  const unit = sb ? require('./narrativeUnitPlanner').forStoryboard(db, sb.id) : null;
  if (unit && unit.request_duration_ms !== duration*1000) fail('分镜时长已偏离已发布单元计划，请重新规划与编译提示词',409);
  if (unit) {
    const script=db.prepare('SELECT script_content FROM episodes WHERE id=?').get(sb.episode_id)?.script_content || '';
    if (crypto.createHash('sha256').update(script).digest('hex') !== unit.source_hash) fail('原剧本已变化，当前单元计划已过期，请重新规划后提交',409);
  }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) fail('视频提示词不能为空');
  timeline.assertTimeline(prompt, duration);
  if (unit && !timeline.validateTimeline(prompt,duration).recognized) fail('长段提示词缺少可识别时间轴，请重新润色为分镜时长或 [0-5秒 | 镜头1] 格式',409);
  for (const event of unit?.events || []) if (event.kind === 'dialogue' && (!prompt.includes(event.dialogue) || !prompt.includes(event.speaker))) fail(`提示词遗漏了原台词或说话人 ${event.speaker}，请重新润色`,409);
  const refs = body.reference_image_urls ?? [];
  if (!Array.isArray(refs) || refs.some(x => typeof x !== 'string' || !x.trim())) fail('参考图必须为非空地址数组');
  const protocol = client.resolveVideoProtocol(config, model);
  const maxRefs = /volcengine/.test(protocol) ? 9 : 10;
  if (refs.length > maxRefs) fail(`当前通道最多支持 ${maxRefs} 张参考图，已选择 ${refs.length} 张；请调整引用后提交，不会自动丢图`);
  let meta = {}; try { meta = JSON.parse(drama.metadata || '{}'); } catch (_) {}
  const style = String(body.style || '').trim();
  const finalPrompt = style && !prompt.toLowerCase().includes(style.toLowerCase()) ? `${prompt}\n渲染风格（不新增剧情或资产）：${require('./assetPromptPolicy').renderOnly(style)?.en || style}` : prompt;
  const references = client.prepareVideoReferences(db, { info() {} }, { ...body, drama_id: dramaId, model, reference_urls: refs }, config);
  const adapterError=client.validateAdapterRequest(config,model,{...references,prompt:finalPrompt,duration});
  if(adapterError) fail(adapterError);
  for(const match of finalPrompt.matchAll(/@图片(\d+)/g)) if(Number(match[1])<1 || Number(match[1])>(references.reference_urls || refs).length) fail(`${match[0]} 没有对应参考图，请重新核对引用`,409);
  return {
    drama_id: dramaId, storyboard_id: storyboardId, provider: config.provider, model, prompt: finalPrompt, duration,
    aspect_ratio: client.normalizeAspectRatioForApi(body.aspect_ratio || meta.aspect_ratio || '16:9'),
    resolution: body.resolution ?? null, seed: body.seed ?? null, camera_fixed: body.camera_fixed == null ? null : Number(!!body.camera_fixed), watermark: Number(!!body.watermark),
    image_url: references.image_url ?? null, first_frame_url: references.first_frame_url ?? body.first_frame_local_path ?? null,
    last_frame_url: references.last_frame_url ?? body.last_frame_local_path ?? null, reference_image_urls: references.reference_urls || refs, voice_reference_url: references.voice_reference_url || null,
    reference_files: require('./videoReferenceSnapshot').capture([...(references.reference_urls || refs), references.image_url, references.first_frame_url, references.last_frame_url, body.first_frame_local_path, body.last_frame_local_path]),
    config: safeConfig(config), storyboard_updated_at: sb?.updated_at || null, capability: checked.capability, narrative_unit: unit,
  };
}
function enqueue(db, log, body) {
  init(db);
  const snapshot = prepare(db, body);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return db.transaction(() => {
    const same = db.prepare("SELECT v.id FROM video_submission_snapshots s JOIN video_generations v ON v.id=s.video_id WHERE s.fingerprint=? AND v.deleted_at IS NULL AND (v.status IN ('processing','pending') OR s.state='submission_unknown') ORDER BY v.id DESC LIMIT 1").get(fingerprint);
    if (same) return { id: same.id, duplicate: true };
    const task = tasks.createTask(db, log, 'video_generation', String(snapshot.drama_id));
    const now = new Date().toISOString();
    const columns = ['organization_id','drama_id','storyboard_id','provider','prompt','model','duration','aspect_ratio','resolution','seed','camera_fixed','watermark','image_url','first_frame_url','last_frame_url'];
    const result = db.prepare(`INSERT INTO video_generations (${columns.join(',')},reference_image_urls,status,task_id,created_at,updated_at) VALUES (${columns.map(()=>'?').join(',')},?,'processing',?,?,?)`)
      .run(getTenantId() || 1, ...columns.slice(1).map(k=>snapshot[k]), JSON.stringify(snapshot.reference_image_urls), task.id, now, now);
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO video_submission_snapshots (video_id,fingerprint,config_id,payload,state,created_at) VALUES (?,?,?,?,?,?)').run(id,fingerprint,snapshot.config.id,JSON.stringify(snapshot),'queued',now);
    return { id, task_id: task.id, duplicate: false };
  })();
}
function get(db, id) {
  init(db);
  const tenantId = getTenantId();
  const row = tenantId
    ? db.prepare('SELECT s.* FROM video_submission_snapshots s JOIN video_generations v ON v.id=s.video_id WHERE s.video_id=? AND v.organization_id=?').get(Number(id), tenantId)
    : db.prepare('SELECT * FROM video_submission_snapshots WHERE video_id=?').get(Number(id));
  return row ? { ...row, payload: JSON.parse(row.payload) } : null;
}
function configFor(db, snap) {
  const tenantId = getTenantId();
  const current = tenantId
    ? db.prepare('SELECT * FROM ai_service_configs WHERE id=? AND COALESCE(organization_id,1)=? AND deleted_at IS NULL').get(snap.config_id, tenantId)
    : db.prepare('SELECT * FROM ai_service_configs WHERE id=? AND deleted_at IS NULL').get(snap.config_id);
  if (!current) fail('提交时使用的模型配置已删除，任务已暂停；请恢复该配置后继续查询',409);
  const auth = require('./videoDurationCapability').settingsOf(current);
  const secretFields = Object.fromEntries(Object.entries(auth).filter(([key])=>/key|token|secret|password|credential/i.test(key)));
  return { ...current, ...snap.payload.config, api_key: current.api_key, settings: JSON.stringify({ ...snap.payload.config.settings, ...secretFields }) };
}
function mark(db,id,state,warning) {
  init(db);
  const tenantId = getTenantId();
  if (tenantId) {
    db.prepare('UPDATE video_submission_snapshots SET state=?,warning=? WHERE video_id=? AND video_id IN (SELECT id FROM video_generations WHERE organization_id=?)').run(state, warning || null, Number(id), tenantId);
  } else {
    db.prepare('UPDATE video_submission_snapshots SET state=?,warning=? WHERE video_id=?').run(state, warning || null, Number(id));
  }
}
module.exports = { init, prepare, enqueue, get, configFor, mark };
