function generationQuota(db, limit = Number(process.env.AI_DAILY_REQUEST_LIMIT) || 300) {
  const reserve = db.transaction((org, day) => {
    db.prepare('INSERT OR IGNORE INTO daily_request_usage VALUES (?,?,0)').run(org, day);
    return db.prepare('UPDATE daily_request_usage SET requests=requests+1 WHERE organization_id=? AND day=? AND requests<?').run(org, day, limit).changes;
  });
  return (req, res, next) => {
    if (!reserve(req.user.organization.id, new Date().toISOString().slice(0, 10))) {
      const seconds = Math.ceil((Date.parse(new Date().toISOString().slice(0, 10)) + 86400000 - Date.now()) / 1000);
      res.set('Retry-After', String(seconds));
      return res.status(429).json({ success: false, error: { code: 'DAILY_QUOTA', message: '工作区今日 AI 请求额度已用完，请明天再试' } });
    }
    next();
  };
}
module.exports = { generationQuota };
