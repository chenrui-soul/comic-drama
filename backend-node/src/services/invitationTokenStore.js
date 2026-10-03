const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const memoryKeys = new WeakMap();

// Back up this key alongside the database. Never store it in the database or logs.
function keyFor(db, create) {
  if (!db.name || db.name === ':memory:') {
    if (!memoryKeys.has(db) && create) memoryKeys.set(db, crypto.randomBytes(32));
    return memoryKeys.get(db);
  }
  const file = path.join(path.dirname(path.resolve(db.name)), 'invitation-token.key');
  if (create && !fs.existsSync(file)) {
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('邀请加密密钥无效');
  return key;
}

function encrypt(db, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(db, true), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decrypt(db, value) {
  if (!value) return null;
  try {
    const [version, iv, tag, data] = value.split('.');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(db, false), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch (_) { return null; }
}

module.exports = { encrypt, decrypt };
