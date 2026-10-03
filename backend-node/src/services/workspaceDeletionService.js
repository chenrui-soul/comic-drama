function deleteWorkspaceData(db, organizationId) {
  const workspaceId = Number(organizationId);
  const organization = db.prepare('SELECT id, name FROM organizations WHERE id=?').get(workspaceId);
  if (!organization) return null;

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map(row => row.name).filter(name => /^[a-z_][a-z0-9_]*$/i.test(name));
  const columnsByTable = new Map(tables.map(name => [name, db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name)]));
  const ownedIds = new Map();
  const mediaFiles = columnsByTable.has('private_media_owners')
    ? db.prepare('SELECT path FROM private_media_owners WHERE organization_id=?').all(workspaceId).map(row => row.path)
    : [];
  const referenceTargets = {
    drama_id: 'dramas', episode_id: 'episodes', storyboard_id: 'storyboards',
    character_id: 'characters', scene_id: 'scenes', prop_id: 'props',
    image_gen_id: 'image_generations', video_gen_id: 'video_generations',
  };

  for (const [table, columns] of columnsByTable) {
    if (columns.includes('organization_id') && columns.includes('id')) {
      ownedIds.set(table, db.prepare(`SELECT id FROM ${table} WHERE organization_id=?`).all(workspaceId).map(row => Number(row.id)));
    }
  }

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
    if (table === 'image_proxy_cache') {
      clauses.push('cache_key LIKE ?');
      params.push(`org/${workspaceId}/%`);
      for (const mediaPath of mediaFiles) {
        clauses.push('cache_key = ?');
        params.push(mediaPath);
      }
    }
    if (clauses.length) db.prepare(`DELETE FROM ${table} WHERE ${clauses.join(' OR ')}`).run(...params);
  }

  db.prepare('DELETE FROM auth_sessions WHERE organization_id=?').run(workspaceId);
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
  for (const table of orderedTables) db.prepare(`DELETE FROM ${table} WHERE organization_id=?`).run(workspaceId);
  db.prepare('DELETE FROM organization_members WHERE organization_id=?').run(workspaceId);
  db.prepare('DELETE FROM organizations WHERE id=?').run(workspaceId);
  return { organization, mediaFiles };
}

module.exports = { deleteWorkspaceData };
