const submissions = require('./videoSubmissionService');
/** 轮询/同步返回的 video_url 须为 http(s)，避免中转 FAILURE 时 result_url 为错误文案 */
function resolveRemoteVideoUrl(videoUrl, fallbackError) {
  if (videoUrl && videoClient.isPlausibleHttpVideoUrl(videoUrl)) {
    return { ok: true, video_url: String(videoUrl).trim() };
  }
  if (videoUrl) {
    return { ok: false, error: (fallbackError || String(videoUrl)).slice(0, 500) };
  }
  return { ok: false, error: (fallbackError || '超时或失败').slice(0, 500) };
}

/** 将 video_generations 标为失败；若无 error_msg 列则只更新 status/updated_at */
function setVideoGenFailed(db, videoGenId, errorMsg, now) {
  try {
    db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(
      'failed', (errorMsg || '').slice(0, 500), now, videoGenId
    );
  } catch (e) {
    if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, videoGenId);
    } else throw e;
  }
}

function list(db, query) {
  let sql = 'FROM video_generations WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  // 与 Go 前端行为对齐：请求 status=processing 时，同时包含“刚结束”的记录（5 分钟内变为 completed/failed），
  // 这样轮询刷新后任务不会从列表消失，无需改 Vue
  if (query.status === 'processing') {
    sql += " AND (status = 'processing' OR (status IN ('completed','failed') AND updated_at >= datetime('now', '-5 minutes')))";
  } else if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(row => getById(db,row.id)), total, page, pageSize };
}

function hasProviderTaskId(r) {
  return !!(r && r.provider_task_id && String(r.provider_task_id).trim());
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    duration: r.duration,
    image_gen_id: r.image_gen_id,
    image_url: r.image_url,
    video_url: r.video_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
    /** 失败且已有上游任务 ID 时可「继续查询」，不暴露原始 provider_task_id */
    can_resume_poll: r.status === 'failed' && (hasProviderTaskId(r) || !!r.video_url),
    can_retry_download: r.status === 'failed' && !!r.video_url,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!r) return null;
  const snap = submissions.get(db, r.id);
  return { ...rowToItem(r), actual_duration_ms: snap?.actual_duration_ms, duration_warning: snap?.warning, submission_state: snap?.state };
}

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const taskService = require('./taskService');
const storageLayout = require('./storageLayout');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');

/** @returns {{ dir: string, relPrefix: string }} 与图片 uploads 一致的工程子目录规则 */
function resolveVideosDir(storagePath, projectSubdir) {
  const sub = projectSubdir && String(projectSubdir).trim();
  if (sub) {
    const relPrefix = `${sub.replace(/\\/g, '/')}/videos`;
    return { dir: path.join(storagePath, sub, 'videos'), relPrefix };
  }
  return { dir: path.join(storagePath, 'videos'), relPrefix: 'videos' };
}

/**
 * 将远程 video_url 下载到本地
 * @returns {string|null} 相对 storage 根的路径，如 projects/.../videos/vg_1_xxx.mp4；无工程时为 videos/...
 */
async function downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir = null) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const { dir, relPrefix } = resolveVideosDir(storagePath, projectSubdir);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (videoUrl.split('?')[0].match(/\.(mp4|webm|mov)$/i) || [])[1] || 'mp4';
    const name = `vg_${videoGenId}_${randomUUID().slice(0, 8)}.${ext}`;
    const filePath = path.join(dir, name);
    const res = await fetch(videoUrl, { method: 'GET', signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      log.warn('Download video failed', { status: res.status, videoGenId });
      return null;
    }
    if (/text\/html|application\/json/i.test(res.headers.get('content-type') || '')) throw new Error('远端返回网页或 JSON，不是视频');
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    try { require('../utils/probeVideo').probeVideo(filePath); } catch (err) { fs.unlinkSync(filePath); throw err; }
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    log.info('Video saved to local', { videoGenId, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return relativePath;
  } catch (e) {
    log.warn('Download video error', { videoGenId, error: e.message });
    return null;
  }
}

/** 与图生 aspectRatioToSize 对齐的归一化分辨率（偶数像素，便于 H.264） */
function targetVideoPixelsForAspect(aspectRatio) {
  const r = String(aspectRatio || '16:9').trim();
  const map = {
    '16:9': { w: 2560, h: 1440 },
    '9:16': { w: 1440, h: 2560 },
    '1:1': { w: 1920, h: 1920 },
    '4:3': { w: 1920, h: 1440 },
    '3:4': { w: 1440, h: 1920 },
    '3:2': { w: 2560, h: 1708 },
    '2:3': { w: 1708, h: 2560 },
    '21:9': { w: 2560, h: 1080 },
  };
  if (map[r]) return map[r];
  const m = r.match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 0 && b > 0 && a !== b) {
      if (a > b) {
        const w = 2560;
        const h = Math.max(2, Math.round((w * b) / a / 2) * 2);
        return { w, h };
      }
      const h = 2560;
      const w = Math.max(2, Math.round((h * a) / b / 2) * 2);
      return { w, h };
    }
  }
  return { w: 1280, h: 720 };
}

/**
 * 用 ffmpeg 将视频缩放并加黑边到固定分辨率，避免 Grok 等返回实际像素不一致导致连播时画面跳动。
 */
function normalizeVideoFileToTargetPixels(absPath, tw, th, log, videoGenId) {
  if (!absPath || !tw || !th || !fs.existsSync(absPath)) return false;
  if (!hasLocalFfmpeg()) {
    log.info('[视频] 未找到 ffmpeg，跳过画幅归一化', { videoGenId });
    return false;
  }
  const ffmpeg = getFfmpegPath();
  const vf = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`;
  const tmpOut = absPath + '.norm-' + randomUUID().slice(0, 8) + (path.extname(absPath) || '.mp4');
  const baseArgs = ['-y', '-i', absPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  let r = spawnSync(ffmpeg, [...baseArgs, '-c:a', 'copy', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    r = spawnSync(ffmpeg, [...baseArgs, '-c:a', 'aac', '-b:a', '192k', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  if (r.status !== 0) {
    log.warn('[视频] 画幅归一化失败（保留原文件）', {
      videoGenId,
      stderr: (r.stderr || '').slice(-500),
    });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
  try {
    fs.unlinkSync(absPath);
    fs.renameSync(tmpOut, absPath);
    log.info('[视频] 已统一画幅尺寸', { videoGenId, w: tw, h: th });
    return true;
  } catch (e) {
    log.warn('[视频] 替换归一化文件失败', { videoGenId, error: e.message });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
}

function maybeNormalizeVideoAfterDownload(storagePath, localPath, row, videoGenId, log) {
  if (!localPath) return;
  const abs = path.join(storagePath, localPath);
  const dim = targetVideoPixelsForAspect(row.aspect_ratio);
  normalizeVideoFileToTargetPixels(abs, dim.w, dim.h, log, videoGenId);
}

/** 防止同一 videoGenId 重复发起 poll（含重启恢复） */
const activeVideoPolls = new Set();

function resolveStoragePath(cfg) {
  return path.isAbsolute(cfg.storage?.local_path)
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
}

async function finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, videoUrl, logLabel) {
  const now = new Date().toISOString();
  // Persist the result URL before downloading so restart/retry can recover without another generation.
  db.prepare('UPDATE video_generations SET video_url=?,updated_at=? WHERE id=?').run(videoUrl,now,videoGenId);
  submissions.mark(db,videoGenId,'downloading');
  if(row.task_id) taskService.updateTaskStatus(db,row.task_id,'processing',90,'远端已完成，正在下载并校验视频…');
  let localPath = null;
  try {
    const cfg = require('../config').loadConfig();
    const storagePath = resolveStoragePath(cfg);
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
    localPath = await downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir);
    maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
  } catch (_) {}
  if (!localPath) {
    const error = '远端视频已生成，但下载或媒体校验失败。点击继续查询可仅重试下载，不会重新生成。';
    db.prepare('UPDATE video_generations SET video_url=?,error_msg=?,status=?,updated_at=? WHERE id=?').run(videoUrl,error,'failed',now,videoGenId);
    submissions.mark(db,videoGenId,'download_failed',error);
    if(row.task_id) taskService.updateTaskError(db,row.task_id,error);
    return;
  }
  const cfgForProbe = require('../config').loadConfig();
  const measured = require('../utils/probeVideo').probeVideo(path.join(resolveStoragePath(cfgForProbe),localPath));
  submissions.init(db);
  const requested = Number(row.duration)*1000;
  const warning = requested && Math.abs(measured.duration_ms-requested)>300 ? `请求 ${row.duration} 秒，实际 ${measured.duration_ms/1000} 秒，偏差超过 0.3 秒；成片已保留` : null;
  db.prepare("UPDATE video_submission_snapshots SET state='completed',actual_duration_ms=?,warning=? WHERE video_id=?").run(measured.duration_ms,warning,videoGenId);
  try {
    db.prepare(
      'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, completed_at = ?, updated_at = ?, error_msg=NULL WHERE id = ?'
    ).run('completed', videoUrl, localPath, now, now, videoGenId);
  } catch (e) {
    if ((e.message || '').includes('completed_at')) {
      db.prepare(
        'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, updated_at = ? WHERE id = ?'
      ).run('completed', videoUrl, localPath, now, videoGenId);
    } else throw e;
  }
  if (row.storyboard_id) {
    try {
      db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(
        videoUrl, localPath, now, row.storyboard_id
      );
      log.info('Updated storyboard video' + (logLabel ? ` (${logLabel})` : ''), {
        storyboard_id: row.storyboard_id,
        video_url: videoUrl,
      });
    } catch (_) {}
  }
  if (row.task_id) {
    taskService.updateTaskResult(db, row.task_id, {
      video_generation_id: videoGenId,
      video_url: videoUrl,
      status: 'completed',
    });
  }
  log.info('Video generation completed' + (logLabel ? ` (${logLabel})` : ''), {
    id: videoGenId,
    video_url: videoUrl,
    local_path: localPath,
  });
}

async function pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config) {
  const cfg = require('../config').loadConfig();
  const POLL_INTERVAL_MS = 10000;
  const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
  const generationTimeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
  const pollMaxAttempts = Math.max(
    1,
    Math.ceil((generationTimeoutMinutes * 60 * 1000) / POLL_INTERVAL_MS)
  );
  const pollResult = await videoClient.pollVideoTask(
    db,
    log,
    videoGenId,
    providerTaskId,
    config,
    pollMaxAttempts,
    POLL_INTERVAL_MS
  );
  const now = new Date().toISOString();
  const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);
  if (pollResult.pending) {
    submissions.mark(db,videoGenId,'polling',pollResult.error);
    if(row.task_id) taskService.updateTaskStatus(db,row.task_id,'processing',10,pollResult.error);
    const timer=setTimeout(()=>resumePollForVideoGeneration(db,log,videoGenId).catch(err=>log.warn('继续查询失败',{error:err.message})),60000);
    timer.unref?.();
    return;
  }
  if (polledVideo.ok) {
    await finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, polledVideo.video_url, 'after poll');
  } else {
    setVideoGenFailed(db, videoGenId, polledVideo.error, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, polledVideo.error);
    log.error('Video generation failed (after poll)', { id: videoGenId, error: polledVideo.error });
  }
}

/**
 * 恢复对厂商异步任务的轮询（需已持久化 provider_task_id；调用方须先将记录置为 processing）
 */
async function resumePollForVideoGeneration(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video poll already active, skip resume', { videoGenId });
    return;
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row || row.status !== 'processing') return;
  const providerTaskId = row.provider_task_id && String(row.provider_task_id).trim();
  if (!providerTaskId) return;

  let config;
  try {
    const snapshot = submissions.get(db, videoGenId);
    config = snapshot ? submissions.configFor(db, snapshot) : videoClient.getDefaultVideoConfig(db, row.model);
  } catch (err) {
    setVideoGenFailed(db, videoGenId, err.message, new Date().toISOString());
    if (row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    return;
  }
  if (!config) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
    return;
  }

  activeVideoPolls.add(videoGenId);
  log.info('Resuming video generation poll', {
    videoGenId,
    provider_task_id: providerTaskId,
  });
  try {
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config);
  } catch (err) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, err.message, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation resume poll error', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

/**
 * 失败记录「继续查询」：复用 provider_task_id 再轮询，不重新提交上游任务。
 * @returns {{ ok: true, item: object } | { ok: false, status: number, error: string }}
 */
function resumeFailedVideoPoll(db, log, videoGenId) {
  const id = Number(videoGenId);
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return { ok: false, status: 404, error: '记录不存在' };
  if (row.status === 'failed' && row.video_url) {
    db.prepare("UPDATE video_generations SET status='processing',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    if(row.task_id) taskService.updateTaskStatus(db,row.task_id,'processing',80,'远端已完成，正在重试下载…');
    setImmediate(()=>finalizeSuccessfulVideo(db,log,id,row,row,row.video_url,'retry download').catch(err=>{
      setVideoGenFailed(db,id,err.message,new Date().toISOString());
      if(row.task_id) taskService.updateTaskError(db,row.task_id,err.message);
    }));
    return {ok:true,item:getById(db,id)};
  }
  if (row.status === 'processing' && hasProviderTaskId(row)) {
    if (!activeVideoPolls.has(id)) {
      setImmediate(() => {
        resumePollForVideoGeneration(db, log, id).catch((e) => {
          log.error('resumeFailedVideoPoll reattach unhandled', { videoGenId: id, error: e.message });
        });
      });
    }
    return { ok: true, item: getById(db, id) };
  }
  if (row.status !== 'failed') {
    return { ok: false, status: 400, error: '仅失败的视频任务可继续查询' };
  }
  if (!hasProviderTaskId(row)) {
    return { ok: false, status: 400, error: '缺少厂商任务 ID，无法继续查询，请重新生成' };
  }

  const now = new Date().toISOString();
  try {
    db.prepare(
      'UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
    ).run('processing', '', now, id);
  } catch (e) {
    if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run(
        'processing',
        now,
        id
      );
    } else throw e;
  }

  let taskId = row.task_id;
  if (!taskId) {
    const task = taskService.createTask(db, log, 'video_generation', String(row.drama_id || ''));
    taskId = task.id;
    db.prepare('UPDATE video_generations SET task_id = ?, updated_at = ? WHERE id = ?').run(taskId, now, id);
  }
  taskService.updateTaskStatus(db, taskId, 'processing', 10, '继续查询上游任务…');
  try {
    db.prepare('UPDATE async_tasks SET error = NULL WHERE id = ?').run(taskId);
  } catch (_) {}

  log.info('Resume failed video poll requested', {
    videoGenId: id,
    provider_task_id: String(row.provider_task_id).trim(),
    task_id: taskId,
  });
  setImmediate(() => {
    resumePollForVideoGeneration(db, log, id).catch((e) => {
      log.error('resumeFailedVideoPoll unhandled', { videoGenId: id, error: e.message });
    });
  });
  return { ok: true, item: getById(db, id) };
}

/** 启动时恢复 processing 视频任务；无 provider_task_id 的视为中断 */
function resumeProcessingVideoGenerations(db, log) {
  const downloads=db.prepare("SELECT * FROM video_generations WHERE status='processing' AND video_url IS NOT NULL AND TRIM(video_url)!='' AND deleted_at IS NULL").all();
  for(const row of downloads) {
    setImmediate(()=>finalizeSuccessfulVideo(db,log,row.id,row,row,row.video_url,'startup download recovery').catch(err=>{
      setVideoGenFailed(db,row.id,err.message,new Date().toISOString());
      if(row.task_id) taskService.updateTaskError(db,row.task_id,err.message);
    }));
  }
  const stuck = db
    .prepare(
      `SELECT id, task_id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (video_url IS NULL OR TRIM(video_url) = '')
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')`
    )
    .all();
  const stuckMsg = '服务重启后无法恢复轮询（缺少厂商任务 ID），请重新生成';
  for (const s of stuck) {
    const now = new Date().toISOString();
    const snapshot=submissions.get(db,s.id);
    const unknown = snapshot && snapshot.state !== 'queued';
    if (snapshot?.state === 'queued') { setImmediate(()=>processVideoGeneration(db,log,s.id)); continue; }
    if (unknown) submissions.mark(db,s.id,'submission_unknown','服务中断时正在提交，尚无远端任务 ID；请在管理器核对，禁止自动重发');
    setVideoGenFailed(db, s.id, unknown ? '提交状态未知，请在管理器核对，禁止重复生成' : stuckMsg, now);
    if (s.task_id) taskService.updateTaskError(db, s.task_id, stuckMsg);
    log.warn('Marked interrupted video generation as failed', { videoGenId: s.id });
  }

  const resumable = db
    .prepare(
      `SELECT id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (video_url IS NULL OR TRIM(video_url) = '')
         AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''`
    )
    .all();
  if (resumable.length) {
    log.info('Resuming video generation polls', { count: resumable.length });
  }
  for (const r of resumable) {
    setImmediate(() => {
      resumePollForVideoGeneration(db, log, r.id).catch((e) => {
        log.error('resumePollForVideoGeneration unhandled', { videoGenId: r.id, error: e.message });
      });
    });
  }
}

async function processVideoGeneration(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video generation already in progress, skip duplicate', { videoGenId });
    return;
  }
  activeVideoPolls.add(videoGenId);
  log.info('processVideoGeneration started', { videoGenId });
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row) {
    activeVideoPolls.delete(videoGenId);
    log.error('Video generation not found', { id: videoGenId });
    return;
  }
  const now = new Date().toISOString();
  try {
    db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('processing', now, videoGenId);
    const loadConfig = require('../config').loadConfig;
    const cfg = loadConfig();
    const filesBaseUrl = (cfg.storage && cfg.storage.base_url) ? String(cfg.storage.base_url).replace(/\/$/, '') : '';
    const storageLocalPath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const snapshot = submissions.get(db, videoGenId);
    const config = snapshot ? submissions.configFor(db, snapshot) : videoClient.getDefaultVideoConfig(db, row.model);
    if (!config) {
      setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      return;
    }
    let reference_urls = null;
    if (row.reference_image_urls) {
      try {
        reference_urls = JSON.parse(row.reference_image_urls);
        if (!Array.isArray(reference_urls)) reference_urls = null;
      } catch (_) {}
    }
    // The queued row and snapshot are authoritative; editing a storyboard never rewrites an in-flight request.
    const effectiveDuration = snapshot?.payload.duration ?? row.duration;
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    if (!aspectForVideo && row.drama_id) {
      try {
        const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
        if (dramaRow && dramaRow.metadata) {
          const meta =
            typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) {
            aspectForVideo = videoClient.normalizeAspectRatioForApi(meta.aspect_ratio);
          }
        }
      } catch (_) {}
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    const hasOmniRefs = !!(reference_urls && reference_urls.length > 0);
    if (row.task_id && hasOmniRefs) {
      taskService.updateTaskStatus(
        db,
        row.task_id,
        'processing',
        5,
        `正在上传 ${reference_urls.length} 张参考图到图床…`
      );
    }
    if (snapshot) require('./videoReferenceSnapshot').verify(snapshot.payload.reference_files);
    submissions.mark(db, videoGenId, 'submitting');
    const result = await videoClient.callVideoApi(db, log, {
      config_snapshot: config,
      submission_snapshot: !!snapshot,
      voice_reference_url: snapshot?.payload.voice_reference_url || undefined,
      prompt: row.prompt,
      model: row.model,
      duration: effectiveDuration,
      aspect_ratio: rowForAspect.aspect_ratio,
      resolution: row.resolution,
      seed: row.seed,
      camera_fixed: row.camera_fixed,
      watermark: row.watermark,
      provider: row.provider,
      drama_id: row.drama_id,
      storyboard_id: row.storyboard_id || undefined,
      image_url: hasOmniRefs ? undefined : row.image_url,
      first_frame_url: hasOmniRefs ? undefined : row.first_frame_url,
      last_frame_url: hasOmniRefs ? undefined : row.last_frame_url,
      reference_urls,
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
    });
    const now2 = new Date().toISOString();
    if (result.error) {
      submissions.mark(db, videoGenId, result.submission_unknown ? 'submission_unknown' : 'rejected', result.error);
      setVideoGenFailed(db, videoGenId, result.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
      log.error('Video generation failed', { id: videoGenId, error: result.error });
      return;
    }
    submissions.mark(db, videoGenId, 'accepted');
    const directVideo = resolveRemoteVideoUrl(result.video_url, result.error);
    if (directVideo.ok) {
      await finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, directVideo.video_url, '');
      return;
    }
    if (result.video_url) {
      setVideoGenFailed(db, videoGenId, directVideo.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, directVideo.error);
      log.error('Video generation failed', { id: videoGenId, error: directVideo.error });
      return;
    }
    if (result.task_id) {
      db.prepare(
        'UPDATE video_generations SET status = ?, provider_task_id = ?, updated_at = ? WHERE id = ?'
      ).run('processing', result.task_id, now2, videoGenId);
      await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, result.task_id, config);
      return;
    }
    setVideoGenFailed(db, videoGenId, '未返回 task_id 或 video_url', now2);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未返回 task_id 或 video_url');
  } catch (err) {
    const now2 = new Date().toISOString();
    const failedSnapshot = submissions.get(db, videoGenId);
    if (failedSnapshot?.state === 'submitting') submissions.mark(db,videoGenId,'submission_unknown','提交后连接异常，尚不能确定远端是否已受理；请先在管理器核对，禁止自动重发');
    setVideoGenFailed(db, videoGenId, err.message, now2);
    if (row && row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation error', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_generations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

module.exports = {
  list,
  getById,
  deleteById,
  processVideoGeneration,
  resumeProcessingVideoGenerations,
  resumeFailedVideoPoll,
  resumePollForVideoGeneration,
};
