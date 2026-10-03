const response = require('../response');

module.exports = function announcementRoutes(db, log) {
  const fields = `a.*, u.display_name AS author_name`;
  const get = id => db.prepare(`SELECT ${fields} FROM platform_announcements a
    LEFT JOIN users u ON u.id=a.author_user_id WHERE a.id=?`).get(id);
  const guard = fn => (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { fn(req, res); }
    catch (err) {
      log.error('Platform announcement operation failed', { error: err.message });
      response.internalError(res, '公告操作失败，请稍后重试');
    }
  };
  const record = (req, action, id) => db.prepare(`INSERT INTO platform_audit_logs
    (actor_user_id,action,resource_type,resource_id,metadata,ip_address,created_at)
    VALUES (?,?, 'platform_announcement', ?, NULL, ?, ?)`).run(
    req.user.id, `announcement.${action}`, String(id), req.ip || null, new Date().toISOString()
  );
  const validate = (body, res) => {
    if (typeof body?.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) {
      response.badRequest(res, '公告标题需为 1–120 个字符'); return null;
    }
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.trim().length > 10000) {
      response.badRequest(res, '公告正文需为 1–10000 个字符'); return null;
    }
    if (body.status !== undefined && !['published', 'withdrawn'].includes(body.status)) {
      response.badRequest(res, '公告状态无效'); return null;
    }
    return { title: body.title.trim(), content: body.content.trim(), status: body.status };
  };
  return {
    list: guard((req, res) => {
      const canManage = !!req.user.is_platform_admin;
      const includeWithdrawn = canManage && req.query.manage === 'true';
      const page = Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
      const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size, 10) || 10));
      const where = includeWithdrawn ? '' : "WHERE a.status='published'";
      const total = db.prepare(`SELECT COUNT(*) AS count FROM platform_announcements a ${where}`).get().count;
      const items = db.prepare(`SELECT ${fields} FROM platform_announcements a
        LEFT JOIN users u ON u.id=a.author_user_id ${where}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);
      response.success(res, { items, total, page, page_size: pageSize, can_manage: canManage });
    }),
    unread: guard((req, res) => {
      const item = db.prepare(`SELECT ${fields} FROM platform_announcements a
        LEFT JOIN users u ON u.id=a.author_user_id
        WHERE a.status='published' AND NOT EXISTS (
          SELECT 1 FROM platform_announcement_reads r WHERE r.announcement_id=a.id AND r.user_id=?
        ) ORDER BY a.created_at DESC, a.id DESC LIMIT 1`).get(req.user.id) || null;
      response.success(res, { item });
    }),
    markRead: guard((req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return response.badRequest(res, '公告 ID 无效');
      const exists = db.prepare("SELECT id FROM platform_announcements WHERE id=? AND status='published'").get(id);
      if (!exists) return response.notFound(res, '公告不存在或已撤下');
      db.prepare(`INSERT INTO platform_announcement_reads(user_id,announcement_id,read_at) VALUES(?,?,?)
        ON CONFLICT(user_id,announcement_id) DO NOTHING`).run(req.user.id, id, new Date().toISOString());
      response.success(res, { announcement_id: id, read: true });
    }),
    create: guard((req, res) => {
      const value = validate(req.body, res);
      if (!value) return;
      const id = db.transaction(() => {
        const now = new Date().toISOString();
        const result = db.prepare(`INSERT INTO platform_announcements
          (title,content,status,author_user_id,created_at,updated_at) VALUES (?,?,'published',?,?,?)`)
          .run(value.title, value.content, req.user.id, now, now);
        record(req, 'published', result.lastInsertRowid);
        return result.lastInsertRowid;
      })();
      response.created(res, get(id));
    }),
    update: guard((req, res) => {
      const previous = get(req.params.id);
      if (!previous) return response.notFound(res, '公告不存在');
      const value = validate(req.body, res);
      if (!value) return;
      const status = value.status || previous.status;
      db.transaction(() => {
        db.prepare('UPDATE platform_announcements SET title=?,content=?,status=?,updated_at=? WHERE id=?')
          .run(value.title, value.content, status, new Date().toISOString(), previous.id);
        const action = status !== previous.status ? (status === 'published' ? 'published' : 'withdrawn') : 'updated';
        record(req, action, previous.id);
      })();
      response.success(res, get(previous.id));
    }),
  };
};
