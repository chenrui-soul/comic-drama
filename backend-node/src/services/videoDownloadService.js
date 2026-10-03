const fs = require('fs');
const path = require('path');
const { ZipFile } = require('yazl');

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function label(value, fallback) {
  return String(value || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '').slice(0, 48) || fallback;
}

// Only export existing video files under the configured storage root. In particular,
// storyboards.local_path is also used for images and must not be treated as a video.
function localVideo(root, value) {
  if (!value || typeof value !== 'string') return null;
  let relative = value;
  try {
    if (/^https?:\/\//i.test(relative)) return null;
    relative = decodeURIComponent(relative.replace(/^\/static\//, ''));
    const absolute = fs.realpathSync(path.resolve(root, relative));
    const fromRoot = path.relative(fs.realpathSync(root), absolute);
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return null;
    if (!/\.(mp4|webm|mov|m4v|mkv)$/i.test(absolute)) return null;
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size === 0) return null;
    return { absolute, size: stat.size, extension: path.extname(absolute).toLowerCase() };
  } catch (_) { return null; }
}

function buildPlan(db, cfg, dramaId, options = {}) {
  const id = Number(dramaId);
  if (!Number.isSafeInteger(id) || id <= 0) fail('项目编号无效');
  const scope = options.scope || 'episode';
  const mode = options.mode || 'selected';
  if (!['episode', 'all'].includes(scope) || !['selected', 'all'].includes(mode)) fail('下载选项无效');
  const drama = db.prepare('SELECT id, title FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!drama) fail('项目不存在', 404);
  const episodes = db.prepare('SELECT id, episode_number FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number, id').all(id);
  const chosen = scope === 'all' ? episodes : episodes.filter(ep => ep.id === Number(options.episode_id));
  if (!chosen.length) fail('所选剧集不存在或不属于此项目');
  const selected = options.selected_video_ids || {};
  if (typeof selected !== 'object' || Array.isArray(selected)) fail('主视频选择无效');
  const root = path.resolve(cfg?.storage?.local_path || './data/storage');
  const files = [];
  const skipped = [];
  for (const ep of chosen) {
    const epName = `第${String(ep.episode_number).padStart(3, '0')}集`;
    const boards = db.prepare('SELECT id, storyboard_number, title, video_url FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id').all(ep.id);
    for (const sb of boards) {
      const shot = `${epName}/镜头${String(sb.storyboard_number).padStart(3, '0')}_${label(sb.title, '未命名')}_s${sb.id}`;
      const history = db.prepare("SELECT id, video_url, local_path, created_at FROM video_generations WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC").all(sb.id);
      let candidates = history;
      if (mode === 'selected') {
        const selectedId = selected[sb.id];
        if (selectedId != null) {
          candidates = history.filter(v => v.id === Number(selectedId));
        } else if (sb.video_url) {
          const match = history.find(v => v.video_url === sb.video_url || v.local_path === sb.video_url || `/static/${v.local_path}` === sb.video_url);
          // A directly selected local video may not have a generation record.
          candidates = [match || { id: null, video_url: sb.video_url }];
        } else {
          candidates = history.filter(v => v.local_path || /^https?:\/\//i.test(v.video_url || '') || /^\/static\//.test(v.video_url || '')).slice(0, 1);
        }
      }
      if (!candidates.length) {
        skipped.push({ shot, reason: mode === 'selected' && selected[sb.id] != null ? '选中的主视频已不可用' : '尚无已完成的视频' });
      }
      for (const video of candidates) {
        const local = localVideo(root, video.local_path) || localVideo(root, video.video_url);
        if (!local) {
          skipped.push({ shot, video_id: video.id, reason: '视频尚未保存到本地或文件已缺失' });
          continue;
        }
        const suffix = mode === 'all' ? `_版本${String(history.length - history.indexOf(video)).padStart(3, '0')}_v${video.id}` : '';
        files.push({ name: `${shot}${suffix}${local.extension}`, absolute: local.absolute, size: local.size, video_id: video.id });
      }
    }
  }
  const scopeName = scope === 'all' ? '全部集' : `第${chosen[0].episode_number}集`;
  const filename = `${label(drama.title, '短剧')}_${scopeName}_${mode === 'all' ? '全部历史版本' : '选中主视频'}.zip`;
  return { filename, files, skipped, total_bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

function publicPlan(plan) {
  return { filename: plan.filename, count: plan.files.length, total_bytes: plan.total_bytes,
    files: plan.files.map(({ absolute, ...file }) => file), skipped: plan.skipped };
}

function createArchive(plan) {
  const zip = new ZipFile();
  // Lazy streams allow HTTP backpressure and cancellation without buffering videos.
  let activeInput;
  zip.outputStream.on('close', () => activeInput?.destroy());
  for (const file of plan.files) {
    zip.addReadStreamLazy(file.name, { size: file.size, compress: false }, callback => {
      if (zip.outputStream.destroyed) return callback(new Error('下载已取消'));
      activeInput = fs.createReadStream(file.absolute);
      callback(null, activeInput);
    });
  }
  zip.addBuffer(Buffer.from(JSON.stringify(publicPlan(plan), null, 2)), '下载清单.json');
  zip.end();
  return zip;
}

module.exports = { buildPlan, publicPlan, createArchive };
