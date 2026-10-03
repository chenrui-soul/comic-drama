const response = require('../response');
const authService = require('../services/authService');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function platformUsersRoutes(db, log, config) {
  const audit = (req, action, user, source) => db.prepare(`INSERT INTO platform_audit_logs
    (actor_user_id, action, resource_type, resource_id, metadata, ip_address, created_at)
    VALUES (?, ?, 'platform_user', ?, ?, ?, ?)`)
    .run(req.user.id, action, String(user.id), JSON.stringify({ email: user.email, source }), req.ip || null, new Date().toISOString());

  function adminSource(userId) {
    if (authService.getConfiguredPlatformAdminIds().includes(Number(userId))) return 'environment';
    return db.prepare('SELECT 1 FROM platform_admins WHERE user_id = ?').get(userId) ? 'database' : null;
  }

  return {
    list(req, res) {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
      const query = String(req.query.q || '').trim().slice(0, 120);
      const where = query
        ? "WHERE u.status <> 'deleted' AND (u.email LIKE ? OR u.display_name LIKE ? OR CAST(u.id AS TEXT) LIKE ?)"
        : "WHERE u.status <> 'deleted'";
      const params = query ? [`%${query}%`, `%${query}%`, `%${query}%`] : [];
      const total = db.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).get(...params).count;
      const users = db.prepare(`SELECT u.id, u.email, u.display_name, u.status, u.created_at, u.last_login_at,
          (SELECT COUNT(DISTINCT organization_id) FROM organization_members m WHERE m.user_id = u.id) AS workspace_count,
          (SELECT COUNT(*) FROM organizations o WHERE o.created_by_user_id = u.id) AS created_workspace_count
        FROM users u ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize)
        .map(user => ({ ...user, is_platform_admin: !!adminSource(user.id), admin_source: adminSource(user.id) }));
      response.success(res, { items: users, total, page, page_size: pageSize });
    },

    setAdmin(req, res) {
      const userId = Number(req.params.id);
      const enabled = req.body?.enabled;
      if (!Number.isSafeInteger(userId) || userId <= 0) return response.badRequest(res, '无效的用户 ID');
      if (typeof enabled !== 'boolean') return response.badRequest(res, '管理员状态必须为布尔值');

      try {
        const result = db.transaction(() => {
          const user = db.prepare('SELECT id, email, display_name, status FROM users WHERE id = ?').get(userId);
          if (!user) return { error: '用户不存在', status: 404 };
          const source = adminSource(userId);
          if (enabled === !!source) return { user, source };
          if (enabled) {
            if (user.status !== 'active') return { error: '停用账号不能设置为平台管理员', status: 400 };
            db.prepare('INSERT INTO platform_admins (user_id, granted_by_user_id, created_at) VALUES (?, ?, ?)')
              .run(userId, req.user.id, new Date().toISOString());
            audit(req, 'user.admin_granted', user, 'database');
            return { user, source: 'database' };
          }
          if (source === 'environment') return { error: '超级管理员由启动配置指定，不能在用户列表中撤销', status: 400 };

          const configuredIds = authService.getConfiguredPlatformAdminIds();
          const storedIds = db.prepare('SELECT user_id FROM platform_admins').all().map(row => row.user_id);
          const admins = new Set([...configuredIds, ...storedIds]);
          if (admins.size <= 1) return { error: '至少保留一名平台管理员', status: 400 };
          db.prepare('DELETE FROM platform_admins WHERE user_id = ?').run(userId);
          audit(req, 'user.admin_revoked', user, 'database');
          return { user, source: null };
        })();

        if (result.error) {
          if (result.status === 404) return response.notFound(res, result.error);
          return response.badRequest(res, result.error);
        }
        response.success(res, {
          user: result.user,
          is_platform_admin: !!result.source,
          admin_source: result.source,
        });
      } catch (err) {
        log.error('Platform user admin update failed', { error: err.message, user_id: userId });
        response.internalError(res, '管理员权限更新失败');
      }
    },

    updateUser(req, res) {
      const userId = Number(req.params.id);
      const displayName = String(req.body?.display_name || '').trim();
      if (!Number.isSafeInteger(userId) || userId <= 0) return response.badRequest(res, '无效的用户 ID');
      if (!displayName || displayName.length > 80) return response.badRequest(res, '用户名称需为 1 到 80 个字符');
      try {
        const user = db.prepare(`UPDATE users SET display_name=?, updated_at=? WHERE id=? AND status <> 'deleted'
          RETURNING id, email, display_name, status`).get(displayName, new Date().toISOString(), userId);
        if (!user) return response.notFound(res, '用户不存在');
        audit(req, 'user.display_name_updated', user, null);
        response.success(res, { user });
      } catch (err) {
        log.error('Platform user name update failed', { error: err.message, user_id: userId });
        response.internalError(res, '用户名称更新失败');
      }
    },

    deleteUser(req, res) {
      const userId = Number(req.params.id);
      if (!Number.isSafeInteger(userId) || userId <= 0) return response.badRequest(res, '无效的用户 ID');
      if (userId === Number(req.user.id)) return response.badRequest(res, '不能删除当前登录账号');

      try {
        const result = db.transaction(() => {
          const user = db.prepare('SELECT id, email, display_name, status FROM users WHERE id = ?').get(userId);
          if (!user || user.status === 'deleted') return { error: '用户不存在', status: 404 };
          const source = adminSource(userId);
          if (source) return { error: source === 'environment' ? '超级管理员不能删除' : '请先撤销该用户的平台管理员权限', status: 400 };

          const ownedWorkspaces = db.prepare('SELECT id, name FROM organizations WHERE created_by_user_id = ?').all(userId);
          const ownedWorkspaceIds = new Set(ownedWorkspaces.map(row => Number(row.id)));
          const lastOwner = db.prepare(`SELECT o.id, o.name FROM organization_members m
            JOIN organizations o ON o.id = m.organization_id
            WHERE m.user_id = ? AND m.role = 'owner'
              AND COALESCE(o.created_by_user_id, 0) <> ?
              AND NOT EXISTS (SELECT 1 FROM organization_members other
                WHERE other.organization_id = m.organization_id AND other.role = 'owner' AND other.user_id <> m.user_id)
            LIMIT 1`).get(userId, userId);
          if (lastOwner) return { error: `该用户是工作区“${lastOwner.name}”的唯一所有者，请先转移所有权`, status: 400 };

          const timestamp = new Date().toISOString();
          const mediaFiles = [];
          const referenceTargets = {
            drama_id: 'dramas', episode_id: 'episodes', storyboard_id: 'storyboards',
            character_id: 'characters', scene_id: 'scenes', prop_id: 'props',
            image_gen_id: 'image_generations', video_gen_id: 'video_generations',
          };
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
            .map(row => row.name).filter(name => /^[a-z_][a-z0-9_]*$/i.test(name));
          const columnsByTable = new Map(tables.map(name => [name, db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name)]));
          const ownedIds = new Map();

          for (const [table, columns] of columnsByTable) {
            if (!columns.includes('organization_id')) continue;
            if (columns.includes('id')) {
              const ids = [...ownedWorkspaceIds];
              const placeholders = ids.map(() => '?').join(',');
              ownedIds.set(table, ids.length
                ? db.prepare(`SELECT id FROM ${table} WHERE organization_id IN (${placeholders})`).all(...ids).map(row => Number(row.id))
                : []);
            }
            if (table === 'private_media_owners') {
              const ids = [...ownedWorkspaceIds];
              if (ids.length) {
                const placeholders = ids.map(() => '?').join(',');
                mediaFiles.push(...db.prepare(`SELECT path FROM private_media_owners WHERE organization_id IN (${placeholders})`).all(...ids).map(row => row.path));
              }
            }
          }

          // Remove relationship rows without tenant columns before their referenced records.
          for (const [table, columns] of columnsByTable) {
            if (columns.includes('organization_id')) continue;
            const clauses = [];
            const params = [];
            for (const [column, parent] of Object.entries(referenceTargets)) {
              const ids = ownedIds.get(parent) || [];
              if (columns.includes(column) && ids.length) {
                clauses.push(`${column} IN (${ids.map(() => '?').join(',')})`);
                params.push(...ids);
              }
            }
            if (table === 'image_proxy_cache' && ownedWorkspaceIds.size) {
              for (const orgId of ownedWorkspaceIds) {
                clauses.push('cache_key LIKE ?');
                params.push(`org/${orgId}/%`);
              }
              for (const mediaPath of mediaFiles) {
                clauses.push('cache_key = ?');
                params.push(mediaPath);
              }
            }
            if (clauses.length) db.prepare(`DELETE FROM ${table} WHERE ${clauses.join(' OR ')}`).run(...params);
          }

          if (ownedWorkspaceIds.size) {
            const workspacePlaceholders = [...ownedWorkspaceIds].map(() => '?').join(',');
            db.prepare(`DELETE FROM auth_sessions WHERE organization_id IN (${workspacePlaceholders})`).run(...ownedWorkspaceIds);
            const scopedTables = [...columnsByTable]
              .filter(([table, columns]) => table !== 'organizations' && columns.includes('organization_id'))
              .map(([table]) => table);
            const scopedSet = new Set(scopedTables);
            const dependents = new Map(scopedTables.map(table => [table, []]));
            for (const child of scopedTables) {
              for (const foreignKey of db.prepare(`PRAGMA foreign_key_list(${child})`).all()) {
                if (scopedSet.has(foreignKey.table)) dependents.get(foreignKey.table).push(child);
              }
            }
            const orderedTables = [];
            const visited = new Set();
            const visit = table => {
              if (visited.has(table)) return;
              visited.add(table);
              for (const child of dependents.get(table) || []) visit(child);
              orderedTables.push(table);
            };
            scopedTables.forEach(visit);
            for (const table of orderedTables) {
              db.prepare(`DELETE FROM ${table} WHERE organization_id IN (${workspacePlaceholders})`).run(...ownedWorkspaceIds);
            }
            db.prepare(`DELETE FROM organizations WHERE id IN (${workspacePlaceholders})`).run(...ownedWorkspaceIds);
          }

          db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(timestamp, userId);
          db.prepare('DELETE FROM organization_members WHERE user_id = ?').run(userId);
          db.prepare(`UPDATE users SET email = ?, password_hash = ?, display_name = '已删除账号', status = 'deleted', updated_at = ? WHERE id = ?`)
            .run(`deleted-${userId}@deleted.invalid`, crypto.randomBytes(32).toString('hex'), timestamp, userId);
          audit(req, 'user.deleted', user, null);
          return { user, deletedWorkspaceCount: ownedWorkspaceIds.size, deletedWorkspaceIds: [...ownedWorkspaceIds], mediaFiles };
        })();

        if (result.error) {
          if (result.status === 404) return response.notFound(res, result.error);
          return response.badRequest(res, result.error);
        }
        const storageRoot = path.resolve(config?.storage?.local_path || './data/storage');
        for (const mediaPath of result.mediaFiles) {
          const file = path.resolve(storageRoot, String(mediaPath).replace(/[\\/]+/g, path.sep));
          if (!file.startsWith(`${storageRoot}${path.sep}`)) continue;
          try { if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.rmSync(file); }
          catch (err) { log.warn('Deleted workspace media cleanup failed', { error: err.message, file }); }
        }
        for (const workspaceId of result.deletedWorkspaceIds || []) {
          const orgDir = path.resolve(storageRoot, 'org', String(workspaceId));
          if (!orgDir.startsWith(`${path.resolve(storageRoot, 'org')}${path.sep}`)) continue;
          try { fs.rmSync(orgDir, { recursive: true, force: true }); }
          catch (err) { log.warn('Deleted workspace storage cleanup failed', { error: err.message, workspace_id: workspaceId }); }
        }
        response.success(res, { id: result.user.id, deleted_workspace_count: result.deletedWorkspaceCount, message: '账号及其创建的工作区已删除' });
      } catch (err) {
        log.error('Platform user deletion failed', { error: err.message, user_id: userId });
        response.internalError(res, '删除账号失败');
      }
    },
  };
};
