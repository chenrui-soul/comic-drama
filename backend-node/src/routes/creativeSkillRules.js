const response = require('../response');
const rules = require('../services/creativeSkillPacks');

function routes(db, log) {
  return {
    list: (req, res) => {
      try { response.success(res, { packs: rules.list(db) }); }
      catch (e) { log.error('creative skill list', { error: e.message }); response.badRequest(res, e.message); }
    },
    importPack: (req, res) => {
      try {
        const body = req.body || {};
        let pack;
        if (body.content_base64) pack = rules.readUpload(Buffer.from(String(body.content_base64), 'base64'), body.filename || 'creative-skill.zip', body.kind);
        else if (body.files) pack = rules.save(db, body);
        else return response.badRequest(res, '请提供创作 Skill 文件内容或 files');
        if (!pack.id || !rules.getPack(db, pack.id)) pack = rules.save(db, pack);
        response.created(res, { pack });
      } catch (e) { log.error('creative skill import', { error: e.message }); response.badRequest(res, e.message); }
    },
    exportPack: (req, res) => {
      try {
        const pack = rules.getPack(db, req.params.id);
        if (!pack) return response.notFound(res, '创作 Skill 不存在');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="creative-skill-${pack.kind}-${pack.version}.json"`);
        res.end(JSON.stringify(pack, null, 2));
      } catch (e) { log.error('creative skill export', { error: e.message }); response.internalError(res, e.message); }
    },
    getProject: (req, res) => {
      try { response.success(res, rules.getSettings(db, Number(req.params.id))); }
      catch (e) { log.error('creative skill project get', { error: e.message }); response.badRequest(res, e.message); }
    },
    setProject: (req, res) => {
      try { response.success(res, rules.setSettings(db, Number(req.params.id), req.body || {})); }
      catch (e) { log.error('creative skill project set', { error: e.message }); response.badRequest(res, e.message); }
    },
  };
}
module.exports = routes;
