function nowIso() {
  return new Date().toISOString();
}

function write(db, event) {
  if (!event?.organizationId || !event.action) return;
  const metadata = event.metadata == null ? null : JSON.stringify(event.metadata);
  db.prepare(`
    INSERT INTO audit_logs
      (organization_id, actor_user_id, action, resource_type, resource_id, metadata, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(event.organizationId),
    event.actorUserId ? Number(event.actorUserId) : null,
    String(event.action).slice(0, 100),
    event.resourceType ? String(event.resourceType).slice(0, 80) : null,
    event.resourceId == null ? null : String(event.resourceId).slice(0, 120),
    metadata,
    event.ipAddress ? String(event.ipAddress).slice(0, 100) : null,
    nowIso()
  );
}

function list(db, organizationId, query = {}) {
  const params = [Number(organizationId)];
  let where = 'WHERE a.organization_id = ?';
  if (query.action) {
    where += ' AND a.action = ?';
    params.push(String(query.action));
  }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 30));
  const total = db.prepare(`SELECT COUNT(*) AS total FROM audit_logs a ${where}`).get(...params).total || 0;
  const rows = db.prepare(`
    SELECT a.*, u.email AS actor_email, u.display_name AS actor_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ${where}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);
  return {
    items: rows.map((row) => {
      let metadata = null;
      try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch (_) { metadata = row.metadata; }
      return { ...row, metadata };
    }),
    total,
    page,
    page_size: pageSize,
  };
}

module.exports = { write, list };
