// Internal request guard. Keep the existing duration configuration UI and trust its declaration.
function settingsOf(cfg) {
  if (cfg?.settings && typeof cfg.settings === 'object') return cfg.settings;
  try { return JSON.parse(cfg?.settings || '{}') || {}; } catch (_) { return {}; }
}
function selectedModel(cfg, hint) {
  if (hint) return String(hint).trim();
  if (cfg?.default_model) return String(cfg.default_model).trim();
  let models = cfg?.model;
  if (typeof models === 'string') { try { models = JSON.parse(models); } catch (_) { return models.trim(); } }
  return Array.isArray(models) ? String(models[0] || '').trim() : '';
}
function isSeedance25(model) {
  return /^(?:doubao[-_ ]|jimeng[-_ ]video[-_ ])?seedance[-_ ]?2[._-]5(?:[-_ ](?:\d{6}|pro|lite|fast|preview))?$/i.test(String(model || '').trim());
}
function positiveInt(n) { return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 3600; }
function parseCapability(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('视频时长能力必须是对象');
  if (raw.mode === 'fixed') {
    if (!Array.isArray(raw.allowed_seconds) || !raw.allowed_seconds.length || !raw.allowed_seconds.every(positiveInt)) throw new Error('固定时长必须是正整数秒数组');
    const allowed = [...new Set(raw.allowed_seconds)].sort((a,b) => a-b);
    return { mode: 'fixed', min: allowed[0], max: allowed.at(-1), step: 1, allowed_seconds: allowed };
  }
  if (raw.mode !== 'range' || !positiveInt(raw.min_seconds) || !positiveInt(raw.max_seconds) || raw.min_seconds > raw.max_seconds || !positiveInt(raw.step_seconds ?? 1)) throw new Error('范围能力需要合法的最小值、最大值和正整数步长');
  return { mode: 'range', min: raw.min_seconds, max: raw.max_seconds, step: raw.step_seconds ?? 1 };
}
function resolve(cfg, hint, protocolHint) {
  const model = selectedModel(cfg, hint), s = settingsOf(cfg);
  const raw = s.video_duration || s.duration_capability || s.videoDurationCapability;
  if (raw) { try { return parseCapability(raw); } catch (err) { return { mode: 'invalid', min: 0, max: 0, step: 1, error: err.message }; } }
  const protocol = String(protocolHint || cfg?.api_protocol || cfg?.provider || '').toLowerCase();
  let min = 1, max = 15;
  if (isSeedance25(model)) { min=4; max=30; }
  else if (/volcengine|jimeng_ai_api/.test(protocol)) min=4;
  return { mode: 'range', min, max, step: 1 };
}
function validate(cfg, model, value, protocol) {
  const cap = resolve(cfg, model, protocol);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return { ok: false, value, capability: cap, message: '视频请求时长必须为正整数秒；不自动四舍五入、补默认值或压缩时长' };
  if (cap.mode === 'invalid') return { ok: false, value, capability: cap, message: cap.error };
  const legal = cap.mode === 'fixed' ? cap.allowed_seconds.includes(value) : value >= cap.min && value <= cap.max && (value - cap.min) % cap.step === 0;
  return legal ? { ok: true, value, capability: cap } : { ok: false, value, capability: cap, message: `当前视频通道支持 ${cap.mode === 'fixed' ? cap.allowed_seconds.join('、') : `${cap.min}-${cap.max}（步长 ${cap.step}）`} 秒，不能提交 ${value} 秒` };
}
module.exports = { settingsOf, selectedModel, isSeedance25, parseCapability, resolve, validate };
