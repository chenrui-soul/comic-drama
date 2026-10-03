const response = require('../response');

function firstNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolveDramaId(db, req) {
  const path = req.path || '';
  let match = path.match(/^\/dramas\/(\d+)(?:\/|$)/);
  if (match) return firstNumber(match[1]);

  match = path.match(/^\/(?:episodes|storyboards\/episode|images\/episode|videos\/episode)\/(\d+)/);
  if (match) {
    const row = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(firstNumber(match[1]));
    return row?.drama_id || null;
  }

  const resourceQueries = [
    [/^\/characters\/(\d+)/, 'SELECT drama_id FROM characters WHERE id = ? AND deleted_at IS NULL'],
    [/^\/scenes\/(\d+)/, 'SELECT drama_id FROM scenes WHERE id = ? AND deleted_at IS NULL'],
    [/^\/props\/(\d+)/, 'SELECT drama_id FROM props WHERE id = ? AND deleted_at IS NULL'],
    [/^\/storyboards\/(\d+)/, 'SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ? AND s.deleted_at IS NULL'],
    [/^\/images\/(\d+)/, 'SELECT drama_id FROM image_generations WHERE id = ? AND deleted_at IS NULL'],
    [/^\/videos\/(\d+)/, 'SELECT drama_id FROM video_generations WHERE id = ? AND deleted_at IS NULL'],
    [/^\/assets\/(\d+)/, 'SELECT drama_id FROM assets WHERE id = ? AND deleted_at IS NULL'],
    [/^\/video-merges\/(\d+)/, 'SELECT drama_id FROM video_merges WHERE id = ? AND deleted_at IS NULL'],
  ];
  for (const [pattern, sql] of resourceQueries) {
    match = path.match(pattern);
    if (match) return db.prepare(sql).get(firstNumber(match[1]))?.drama_id || null;
  }

  const body = req.body || {};
  if (body.drama_id) return firstNumber(body.drama_id);
  if (body.episode_id) {
    return db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(firstNumber(body.episode_id))?.drama_id || null;
  }
  if (body.storyboard_id) {
    return db.prepare('SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ? AND s.deleted_at IS NULL').get(firstNumber(body.storyboard_id))?.drama_id || null;
  }
  return null;
}

function authorizeTenantResource(db) {
  return (req, res, next) => {
    let dramaId;
    try {
      const queries = {
        drama: 'SELECT organization_id FROM dramas WHERE id=? AND deleted_at IS NULL',
        episode: 'SELECT d.organization_id FROM episodes x JOIN dramas d ON d.id=x.drama_id WHERE x.id=? AND x.deleted_at IS NULL AND d.deleted_at IS NULL',
        storyboard: 'SELECT d.organization_id FROM storyboards x JOIN episodes e ON e.id=x.episode_id JOIN dramas d ON d.id=e.drama_id WHERE x.id=? AND x.deleted_at IS NULL AND d.deleted_at IS NULL',
      };
      for (const [kind, table] of Object.entries({ character: 'characters', scene: 'scenes', prop: 'props', image_gen: 'image_generations', video_gen: 'video_generations', asset: 'assets' })) {
        queries[kind] = `SELECT COALESCE(d.organization_id,x.organization_id) AS organization_id FROM ${table} x LEFT JOIN dramas d ON d.id=x.drama_id WHERE x.id=? AND x.deleted_at IS NULL AND (x.drama_id IS NULL OR (d.id IS NOT NULL AND d.deleted_at IS NULL))`;
      }
      const check = (kind, value) => {
        if (value == null || value === '' || value === 0 || value === '0') return;
        const id = firstNumber(value);
        if (!id) throw new Error('Invalid resource id');
        const row = db.prepare(queries[kind]).get(id);
        if (!row || Number(row.organization_id) !== req.user.organization.id) throw new Error('Resource outside workspace');
      };
      const aliases = { image_id: 'image_gen', image_gen_id: 'image_gen', first_frame_image_id: 'image_gen', last_frame_image_id: 'image_gen', video_id: 'video_gen', video_gen_id: 'video_gen' };
      function visit(value, depth = 0) {
        if (!value || typeof value !== 'object') return;
        if (depth > 30) throw new Error('Too deeply nested');
        for (const [key, entry] of Object.entries(value)) {
          const singular = key.replace(/_ids$/, '_id');
          const kind = aliases[singular] || (/^(drama|episode|storyboard|character|scene|prop|asset)_id$/.exec(singular)?.[1]);
          if (kind) (Array.isArray(entry) ? entry : [entry]).forEach(id => check(kind, id));
          else visit(entry, depth + 1);
        }
      }
      visit(req.body); visit(req.query);
      const nested = [
        [/^\/images\/scene\/(\d+)/, 'scene'],
        [/^\/videos\/image\/(\d+)/, 'image_gen'],
        [/^\/assets\/import\/image\/(\d+)/, 'image_gen'],
        [/^\/assets\/import\/video\/(\d+)/, 'video_gen'],
      ];
      for (const [pattern, kind] of nested) {
        const match = req.path.match(pattern);
        if (match) check(kind, match[1]);
      }
      dramaId = resolveDramaId(db, req);
    } catch (err) {
      return response.notFound(res, '资源不存在');
    }
    if (!dramaId) return next();
    const row = db.prepare('SELECT organization_id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
    if (!row || Number(row.organization_id) !== Number(req.user.organization.id)) {
      return response.notFound(res, '资源不存在');
    }
    req.dramaId = dramaId;
    next();
  };
}

module.exports = { authorizeTenantResource };
