const response = require('../response');
const rules = require('../services/videoPromptRules');

function routes(db, log) {
  return {
    list: (req, res) => {
      try { response.success(res, { packs: rules.list(db) }); }
      catch (e) { log.error('video prompt rules list', { error: e.message }); response.badRequest(res, e.message); }
    },
    importPack: (req, res) => {
      try {
        const body = req.body || {};
        let pack;
        if (body.content_base64) pack = rules.readUpload(Buffer.from(String(body.content_base64), 'base64'), body.filename || 'rule-pack.zip');
        else if (body.files) pack = rules.save(db, body);
        else return response.badRequest(res, '请提供规则包文件内容或 files');
        if (!pack.id || !rules.getPack(db, pack.id)) pack = rules.save(db, pack);
        response.created(res, { pack });
      } catch (e) { log.error('video prompt rules import', { error: e.message }); response.badRequest(res, e.message); }
    },
    exportPack: (req, res) => {
      try {
        const pack = rules.getPack(db, req.params.id);
        if (!pack) return response.notFound(res, '规则包不存在');
        const body = JSON.stringify(pack, null, 2);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="video-prompt-rule-${pack.version}.json"`);
        res.end(body);
      } catch (e) { log.error('video prompt rules export', { error: e.message }); response.internalError(res, e.message); }
    },
    getProject: (req, res) => {
      try { response.success(res, rules.getSettings(db, Number(req.params.id))); }
      catch (e) { log.error('video prompt rules project get', { error: e.message }); response.badRequest(res, e.message); }
    },
    setProject: (req, res) => {
      try { response.success(res, rules.setSettings(db, Number(req.params.id), req.body || {})); }
      catch (e) { log.error('video prompt rules project set', { error: e.message }); response.badRequest(res, e.message); }
    },
  };
}
module.exports = routes;
