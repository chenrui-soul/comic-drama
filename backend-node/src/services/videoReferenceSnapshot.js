const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function capture(urls) {
  const cfg = require('../config').loadConfig();
  const root = path.resolve(cfg.storage?.local_path || './data/storage');
  const result = [];
  for (const value of new Set(urls.filter(Boolean))) {
    const raw = String(value);
    if (/^(?:data:|asset:)/i.test(raw)) continue;
    let relative = raw;
    if (/^https?:/i.test(raw)) {
      const url = new URL(raw), base = String(cfg.storage?.base_url || '').replace(/\/$/, '');
      if (!raw.startsWith(base + '/') && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) continue;
      if (!url.pathname.startsWith('/static/')) continue;
      relative = decodeURIComponent(url.pathname.slice('/static/'.length));
    } else relative = raw.replace(/^\/?static\//, '');
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error('参考图路径超出素材目录');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('本地参考图不存在，请重新选择素材');
    result.push({ file, sha256: digest(file) });
  }
  return result;
}
function verify(files = []) {
  for (const item of files) if (!fs.existsSync(item.file) || digest(item.file) !== item.sha256) throw new Error('排队期间参考图文件已变化，任务已暂停；请重新核对素材和提示词后提交');
}
module.exports = { capture, verify };
