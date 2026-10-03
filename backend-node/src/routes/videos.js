const submissions = require('../services/videoSubmissionService');
const response = require('../response');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');
const {
  normalizeAspectRatioForApi,
  getDefaultVideoConfig,
  validateVideoDuration,
} = require('../services/videoClient');

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        const query = { ...req.query };
        const { items, total, page, pageSize } = videoService.list(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('videos list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const job = submissions.enqueue(db, log, req.body || {});
        if (!job.duplicate) setImmediate(() => videoService.processVideoGeneration(db, log, job.id));
        response.created(res, { ...videoService.getById(db, job.id), duplicate: job.duplicate });
      } catch (err) { response.error(res, err.status || 500, 'VIDEO_SUBMISSION_ERROR', err.message); }
    },
    get: (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id);
        if (!item) return response.notFound(res, '记录不存在');
        response.success(res, item);
      } catch (err) {
        log.error('videos get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = videoService.deleteById(db, log, req.params.id);
        if (!ok) return response.notFound(res, '记录不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('videos delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    /** 失败后复用 provider_task_id 继续轮询上游，避免浪费已提交任务 */
    resumePoll: (req, res) => {
      try {
        const result = videoService.resumeFailedVideoPoll(db, log, req.params.id);
        if (!result.ok) {
          if (result.status === 404) return response.notFound(res, result.error);
          return response.badRequest(res, result.error);
        }
        response.success(res, result.item);
      } catch (err) {
        log.error('videos resumePoll', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    fromImage: (req, res) => {
      try {
        const image = db.prepare('SELECT * FROM image_generations WHERE id=? AND deleted_at IS NULL').get(Number(req.params.image_gen_id));
        if (!image) return response.notFound(res, '图片不存在');
        const job = submissions.enqueue(db, log, { ...req.body, drama_id: image.drama_id, storyboard_id: image.storyboard_id, image_url: image.image_url || image.local_path });
        if (!job.duplicate) setImmediate(() => videoService.processVideoGeneration(db, log, job.id));
        response.success(res, videoService.getById(db, job.id));
      } catch (err) { response.error(res, err.status || 500, 'VIDEO_SUBMISSION_ERROR', err.message); }
    },
    episodeBatch: (req, res) => {
      try {
        const episode = db.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL').get(Number(req.params.episode_id));
        if (!episode) return response.notFound(res, '剧集不存在');
        const items = req.body?.videos;
        if (!Array.isArray(items) || !items.length || items.length > 200) return response.badRequest(res, '请提供 videos 数组，每条包含分镜、提示词和时长，最多 200 条');
        const bodies = items.map(item => ({ ...item, drama_id: episode.drama_id }));
        for (const body of bodies) {
          const sb = db.prepare('SELECT episode_id FROM storyboards WHERE id=? AND deleted_at IS NULL').get(Number(body.storyboard_id));
          if (Number(sb?.episode_id) !== Number(episode.id)) return response.badRequest(res, '批量请求包含其他剧集的分镜');
          submissions.prepare(db, body);
        }
        const jobs = db.transaction(() => bodies.map(body => submissions.enqueue(db, log, body)))();
        for (const job of jobs) if (!job.duplicate) setImmediate(() => videoService.processVideoGeneration(db, log, job.id));
        response.success(res, jobs.map(job => videoService.getById(db, job.id)));
      } catch (err) { response.error(res, err.status || 500, 'VIDEO_SUBMISSION_ERROR', err.message); }
    },
  };
}

module.exports = routes;
