const { randomUUID } = require('crypto');
const { pipeline } = require('stream');
const response = require('../response');
const { buildPlan, publicPlan, createArchive } = require('../services/videoDownloadService');

module.exports = function videoDownloads(db, cfg, log) {
  const plans = new Map();
  const ttl = 30 * 60 * 1000;
  return {
    prepare(req, res) {
      try {
        for (const [key, value] of plans) if (value.expires <= Date.now()) plans.delete(key);
        const plan = buildPlan(db, cfg, req.params.id, req.body);
        const token = randomUUID();
        if (plans.size >= 50) plans.delete(plans.keys().next().value);
        plans.set(token, { plan, dramaId: String(req.params.id), expires: Date.now() + ttl });
        response.success(res, { ...publicPlan(plan), download_url: `/api/v1/dramas/${req.params.id}/video-downloads/${token}` });
      } catch (error) {
        response.error(res, error.status || 500, 'VIDEO_DOWNLOAD_ERROR', error.message);
      }
    },
    download(req, res) {
      const entry = plans.get(req.params.token);
      if (!entry || entry.dramaId !== String(req.params.id) || entry.expires <= Date.now()) {
        return response.badRequest(res, '下载清单已过期，请重新打开批量下载窗口');
      }
      if (!entry.plan.files.length) return response.badRequest(res, '没有可下载的本地视频');
      try {
        const zip = createArchive(entry.plan);
        zip.on('error', error => zip.outputStream.destroy(error));
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.plan.filename)}`);
        pipeline(zip.outputStream, res, error => {
          if (error) log.warn('Video download interrupted', { error: error.message });
        });
      } catch (error) {
        if (!res.headersSent) response.internalError(res, error.message);
        else res.destroy(error);
      }
    },
  };
};
