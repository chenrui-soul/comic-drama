const crypto = require('crypto');

// Single-process deployment. Keep state bounded even under random-IP/account traffic.
function rateLimit({ limit, windowMs, key = req => req.ip, maxKeys = 10000, clock = Date.now }) {
  const buckets = new Map();
  let nextSweep = 0;
  return (req, res, next) => {
    const now = clock();
    if (now >= nextSweep) {
      for (const [id, entry] of buckets) if (entry.until <= now) buckets.delete(id);
      nextSweep = now + Math.min(windowMs, 60000);
    }
    const id = String(key(req));
    let entry = buckets.get(id);
    if (!entry || entry.until <= now) {
      if (!entry && buckets.size >= maxKeys) return reject(res, 60);
      entry = { count: 0, until: now + windowMs };
      buckets.set(id, entry);
    }
    if (++entry.count > limit) return reject(res, Math.ceil((entry.until - now) / 1000));
    next();
  };
}
function reject(res, seconds) {
  res.set('Retry-After', String(Math.max(1, seconds)));
  res.set('Cache-Control', 'no-store');
  return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } });
}
const accountKey = req => crypto.createHash('sha256').update(String(req.body?.email || '').trim().toLowerCase().slice(0, 254)).digest('hex');
module.exports = { rateLimit, accountKey };
