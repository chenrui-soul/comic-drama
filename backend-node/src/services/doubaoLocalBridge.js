const crypto = require('crypto');
const { getTenantId } = require('../utils/tenantContext');
const MAX_BODY = 48 * 1024 * 1024;
const MAX_TOTAL = 96 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function isDoubao(config) {
  return config?.service_type === 'video' && ['doubao_manager', 'doubao-video-manager'].includes(String(config.api_protocol || config.provider).toLowerCase());
}
function localOrigin(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('本地连接仅支持这台电脑的 localhost / 127.0.0.1 地址');
  return u.origin;
}
function allowedRequest(method, route) {
  return (method === 'GET' && (route === '/health' || /^\/api\/v1\/video\/jobs\/[A-Za-z0-9_-]{1,160}$/.test(route))) || (method === 'POST' && route === '/api/v1/video/generate');
}
function bridgeError(message) { return Object.assign(new Error(message), { code: 'DOUBAO_LOCAL_ACCESS' }); }
function buildCredential(server, token) {
  const url = new URL(server);
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('连接凭证需要线上 HTTPS 地址；本地开发仅允许 localhost / 127.0.0.1 的 HTTP 地址');
  }
  const payload = Buffer.from(JSON.stringify({ version: 1, server: url.origin, token }), 'utf8').toString('base64url');
  return `doubao-local-v1.${payload}`;
}

class DoubaoLocalBridge {
  constructor(db, { now = Date.now, pollMs = 20000, timeoutMs = 150000 } = {}) {
    this.db = db; this.now = now; this.pollMs = pollMs; this.timeoutMs = timeoutMs;
    this.clients = new Map(); this.jobs = new Map(); this.waiters = new Map(); this.bytes = 0;
  }
  config(id, org) {
    const row = this.db.prepare('SELECT * FROM ai_service_configs WHERE id=? AND organization_id=? AND deleted_at IS NULL').get(Number(id), Number(org));
    if (!row || !isDoubao(row)) throw bridgeError('该本地连接只适用于豆包视频配置');
    localOrigin(row.base_url);
    return row;
  }
  access(id) { return this.db.prepare('SELECT * FROM doubao_local_access WHERE config_id=?').get(Number(id)); }
  isEnabled(id) {
    return !!this.db.prepare(`SELECT a.config_id FROM doubao_local_access a JOIN users u ON u.id=a.owner_user_id
      JOIN organization_members m ON m.user_id=u.id AND m.organization_id=a.organization_id
      JOIN ai_service_configs c ON c.id=a.config_id AND c.organization_id=a.organization_id
      WHERE a.config_id=? AND a.enabled=1 AND a.token_hash IS NOT NULL AND u.status='active' AND m.role='owner' AND c.deleted_at IS NULL`).get(Number(id));
  }
  status(id, org) {
    this.config(id, org);
    const a = this.access(id), client = this.clients.get(Number(id));
    const connected = !!client && this.now() - client.seen < 45000;
    return { enabled: !!a?.enabled, paired: !!a?.token_hash, connected, manager_online: connected && client.managerOnline, state: !a?.enabled ? 'disabled' : !connected ? 'offline' : !client.managerOnline ? 'manager_offline' : 'connected' };
  }
  setEnabled(id, org, owner, enabled) {
    this.config(id, org);
    if (typeof enabled !== 'boolean') throw bridgeError('开关值必须是布尔值');
    this.db.prepare(`INSERT INTO doubao_local_access(config_id,organization_id,owner_user_id,enabled,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(config_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`).run(Number(id), org, owner, enabled ? 1 : 0, new Date().toISOString());
    if (!enabled) this.cancel(id, '豆包本地访问已关闭；已提交的豆包任务可能仍在运行');
    this.wake(id);
    return this.status(id, org);
  }
  pair(id, org, owner) {
    const config = this.config(id, org), token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO doubao_local_access(config_id,organization_id,owner_user_id,enabled,token_hash,updated_at) VALUES(?,?,?,0,?,?)
      ON CONFLICT(config_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,token_hash=excluded.token_hash,updated_at=excluded.updated_at`).run(Number(id), org, owner, hash(token), new Date().toISOString());
    this.cancel(id, '本地连接凭据已更新，请在豆包管理工具中录入新凭证'); this.clients.delete(Number(id)); this.wake(id);
    return { token, localOrigin: localOrigin(config.base_url) };
  }
  authenticate(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const row = this.db.prepare(`SELECT a.* FROM doubao_local_access a JOIN users u ON u.id=a.owner_user_id
      JOIN organization_members m ON m.user_id=u.id AND m.organization_id=a.organization_id
      WHERE a.token_hash=? AND u.status='active' AND m.role='owner'`).get(hash(token));
    if (!row) return null;
    try { this.config(row.config_id, row.organization_id); return row; } catch (_) { return null; }
  }
  finish(job, error, value) {
    if (!this.jobs.delete(job.id)) return;
    clearTimeout(job.timer); this.bytes -= job.size;
    job.payload = null;
    error ? job.reject(bridgeError(error)) : job.resolve(value);
  }
  cancel(id, message) { for (const job of [...this.jobs.values()]) if (job.configId === Number(id)) this.finish(job, message); }
  take(id, clientId) {
    const a = this.access(id);
    if (!a?.enabled || !this.isEnabled(id)) return { enabled: false, job: null };
    for (const job of this.jobs.values()) if (job.configId === Number(id) && !job.clientId) {
      job.clientId = clientId;
      const result = { id: job.id, ...job.payload };
      Object.defineProperty(result, 'bodyReady', { value: job.bodyReady, enumerable: false });
      return { enabled: true, job: result };
    }
    return { enabled: true, job: null };
  }
  wake(id) { const waiter = this.waiters.get(Number(id)); if (waiter) waiter.send(); }
  poll(a, clientId, managerOnline, res) {
    const id = a.config_id;
    const previous = this.clients.get(id);
    if (previous && previous.id !== clientId && this.now()-previous.seen < 45000) return res.status(409).json({ error: '已有豆包管理工具连接此配置' });
    this.clients.set(id, { id: clientId, seen: this.now(), managerOnline: managerOnline === true });
    const old = this.waiters.get(id); if (old) old.send();
    const send = async () => {
      clearTimeout(timer);
      if (this.waiters.get(id)?.send === send) this.waiters.delete(id);
      if (res.destroyed) return;
      const result = this.take(id, clientId);
      if (result.job?.bodyReady) {
        try { await result.job.bodyReady; } catch (_) { return; }
      }
      if (!res.destroyed) res.json(result);
    };
    const timer = setTimeout(send, this.pollMs);
    this.waiters.set(id, { send });
    res.once('close', () => { clearTimeout(timer); if (this.waiters.get(id)?.send === send) this.waiters.delete(id); });
    if ([...this.jobs.values()].some(j => j.configId === id && !j.clientId)) send();
  }
  permitted(a, jobId, clientId) {
    const j = this.jobs.get(jobId);
    return this.isEnabled(a.config_id) && !!j && j.configId === a.config_id && j.org === a.organization_id && j.clientId === clientId;
  }
  result(a, jobId, clientId, result) {
    if (!this.permitted(a, jobId, clientId)) return false;
    const job = this.jobs.get(jobId);
    if (result.error) this.finish(job, '本地豆包管理器连接失败：' + String(result.error).slice(0,200));
    else {
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== 'string' || Buffer.byteLength(result.body) > 2*1024*1024) throw bridgeError('本地响应格式不正确');
      this.finish(job, null, new Response([204,205,304].includes(result.status) ? null : result.body, { status: result.status, headers: { 'content-type': 'application/json' } }));
    }
    return true;
  }
  async request(config, url, options = {}) {
    const org = getTenantId();
    const row = this.config(config.id, org);
    if (!this.access(row.id)?.enabled) throw bridgeError('豆包本地访问已关闭，请在 AI 配置中开启「允许连接本机豆包」');
    if (!this.isEnabled(row.id)) throw bridgeError('请由工作区所有者生成连接凭证，并在豆包管理工具中保持连接');
    const client = this.clients.get(row.id);
    if (!client || this.now()-client.seen >= 45000) throw bridgeError('豆包管理工具未识别连接凭证或已离线，请检查工具中的线上连接');
    const u = new URL(url), method = options.method || 'GET';
    if (u.origin !== localOrigin(row.base_url) || u.search || u.hash || !allowedRequest(method, u.pathname)) throw bridgeError('本地连接只允许豆包视频提交、任务查询和健康检查');
    if ([...this.jobs.values()].filter(j=>j.configId===row.id).length >= 8) throw bridgeError('本地连接任务繁忙，请稍后重试');
    const req = new Request(url, options);
    // Enqueue before undici finishes multipart encoding; the connector waits for bodyReady.
    return new Promise((resolve,reject)=>{
      const id = crypto.randomUUID();
      const job = { id, configId: row.id, org, resolve, reject, size: 0,
        payload: { method, path:u.pathname, contentType:req.headers.get('content-type'), body:'' } };
      job.bodyReady = req.arrayBuffer().then((buffer) => {
        const bytes = Buffer.from(buffer);
        if (bytes.length > MAX_BODY || this.bytes + bytes.length > MAX_TOTAL) throw bridgeError('本地连接参考图过大，请减少图片数量或大小');
        if (!this.isEnabled(row.id)) throw bridgeError('豆包本地访问已关闭');
        job.size = bytes.length;
        job.payload.body = bytes.toString('base64');
        this.bytes += bytes.length;
        return job.payload.body;
      }).catch((error) => {
        if (this.jobs.has(id)) this.finish(job, error.message || '本地请求正文读取失败');
        throw error;
      });
      job.timer = setTimeout(()=>this.finish(job,'本地请求超时；为避免重复生成，未自动重发提交请求'),this.timeoutMs);
      this.jobs.set(id,job); this.wake(row.id);
    });
  }
  close() { for(const j of [...this.jobs.values()]) this.finish(j,'连接服务已停止'); for(const w of this.waiters.values()) w.send(); }
}
let current;
function configure(db) { current?.close(); current = new DoubaoLocalBridge(db); return current; }
async function request(config, url, options) {
  if (!current) throw bridgeError('豆包本地连接尚未初始化');
  return current.request(config,url,options);
}
async function fetchDoubao(config, url, options) {
  // A desktop/local backend already runs on the manager's computer. Production must use the connector.
  if (process.env.NODE_ENV !== 'production' && !process.env.PUBLIC_ORIGIN) return fetch(url, options);
  return request(config,url,options);
}
module.exports = { DoubaoLocalBridge, configure, request, fetchDoubao, isDoubao, localOrigin, allowedRequest, buildCredential };
