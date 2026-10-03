const { runWithTenant, getTenantId } = require('../utils/tenantContext');

// 进程内消费者 + 数据库持久化状态。SQLite 单进程部署不需要额外的 Redis 依赖，
// 任务本身仍保存在 async_tasks，进程重启后可恢复带 payload 的任务。
const handlers = new Map();
const state = {
  pending: [],
  active: 0,
  timer: null,
  concurrency: Math.max(1, Number(process.env.AI_TASK_CONCURRENCY) || 4),
  defaultMaxAttempts: Math.max(1, Number(process.env.AI_TASK_MAX_ATTEMPTS) || 3),
  baseDelayMs: Math.max(1000, Number(process.env.AI_TASK_RETRY_DELAY_MS) || 3000),
};

function nowIso() { return new Date().toISOString(); }

function register(type, handler) {
  if (!type || typeof handler !== 'function') throw new Error('AI task handler is invalid');
  handlers.set(String(type), handler);
}

function parsePayload(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function isRetryable(message) {
  const text = String(message || '');
  return !/(用户已取消|不存在|无权限|没有权限|为空|必填|不支持|格式错误|参数错误|项目不存在|剧集不存在)/i.test(text);
}

function delayForAttempt(attempt) {
  return Math.min(state.baseDelayMs * (2 ** Math.max(0, attempt - 1)), 5 * 60 * 1000);
}

function updateFailure(db, row, message) {
  const attempts = Number(row.attempts || 0);
  const maxAttempts = Number(row.max_attempts || state.defaultMaxAttempts);
  if (attempts < maxAttempts && isRetryable(message)) {
    const delay = delayForAttempt(attempts);
    const next = new Date(Date.now() + delay).toISOString();
    db.prepare(`UPDATE async_tasks
      SET status = 'pending', message = ?, error = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?`).run(`第 ${attempts} 次失败，${Math.ceil(delay / 1000)} 秒后自动重试`, message, message, next, nowIso(), row.id);
    return { retry: true, delay };
  }
  db.prepare(`UPDATE async_tasks
    SET status = 'failed', message = ?, error = ?, last_error = ?, completed_at = ?, next_attempt_at = NULL, updated_at = ?
    WHERE id = ?`).run(message || '任务失败', message || '任务失败', message || '任务失败', nowIso(), nowIso(), row.id);
  return { retry: false };
}

function enqueue(db, log, taskId, type, payload = {}, options = {}) {
  const row = db.prepare('SELECT id, organization_id FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(taskId);
  if (!row) throw new Error('任务不存在');
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || state.defaultMaxAttempts);
  const organizationId = Number(options.organizationId || row.organization_id || getTenantId() || 1);
  const persistedPayload = options.volatile ? null : JSON.stringify(payload || {});
  db.prepare(`UPDATE async_tasks
    SET organization_id = ?, payload = ?, attempts = 0, max_attempts = ?, status = 'pending',
        error = NULL, last_error = NULL, next_attempt_at = NULL, started_at = NULL, updated_at = ?
    WHERE id = ?`).run(organizationId, persistedPayload, maxAttempts, nowIso(), taskId);
  state.pending.push({ db, log, taskId: String(taskId), type: String(type), organizationId, payload: payload || {}, handler: options.handler });
  pump();
  return taskId;
}

// 用于暂时还未完成持久化 handler 注册的旧异步入口；任务状态仍走同一套并发和重试逻辑。
function enqueueHandler(db, log, taskId, type, handler, payload = {}, options = {}) {
  return enqueue(db, log, taskId, type, payload, { ...options, handler, volatile: true });
}

function enqueueRecovered(db, log, row) {
  const handler = handlers.get(String(row.type));
  if (!handler) return false;
  state.pending.push({
    db, log, taskId: String(row.id), type: String(row.type), organizationId: Number(row.organization_id || 1),
    payload: parsePayload(row.payload), recovered: true,
  });
  return true;
}

function recover(db, log) {
  const rows = db.prepare(`SELECT * FROM async_tasks
    WHERE status IN ('pending', 'processing') AND payload IS NOT NULL AND deleted_at IS NULL
    ORDER BY COALESCE(next_attempt_at, created_at), created_at`).all();
  let count = 0;
  for (const row of rows) {
    if (!handlers.has(String(row.type))) continue;
    db.prepare(`UPDATE async_tasks SET status = 'pending', message = ?, updated_at = ? WHERE id = ?`)
      .run('服务恢复后继续处理', nowIso(), row.id);
    if (enqueueRecovered(db, log, row)) count += 1;
  }
  if (count) pump();
  return count;
}

async function execute(item) {
  const { db, log, taskId, type, organizationId, payload } = item;
  const handler = item.handler || handlers.get(type);
  if (!handler) return;
  const current = db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(taskId);
  if (!current || ['completed', 'failed'].includes(current.status)) return;
  if (current.next_attempt_at && new Date(current.next_attempt_at).getTime() > Date.now()) {
    const delay = new Date(current.next_attempt_at).getTime() - Date.now();
    setTimeout(() => { state.pending.push(item); pump(); }, delay);
    return;
  }
  const startedAt = nowIso();
  db.prepare(`UPDATE async_tasks SET status = 'processing', attempts = COALESCE(attempts, 0) + 1,
    started_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?`).run(startedAt, startedAt, taskId);
  try {
    await runWithTenant(organizationId, () => handler(db, log, taskId, payload));
    const after = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId);
    if (after && after.status === 'processing') {
      const result = updateFailure(db, after, '任务未返回完成状态');
      if (result.retry) scheduleRetry(item, result.delay);
    } else if (after && after.status === 'failed') {
      const result = updateFailure(db, after, after.error || after.message || '任务失败');
      if (result.retry) scheduleRetry(item, result.delay);
    } else if (after && after.status === 'completed') {
      db.prepare('UPDATE async_tasks SET error = NULL, last_error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso(), taskId);
    }
  } catch (err) {
    const after = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId) || current;
    const result = updateFailure(db, after, err.message || '任务执行失败');
    if (result.retry) {
      scheduleRetry(item, result.delay);
      log.warn('AI task failed, scheduled retry', { task_id: taskId, type, attempts: after.attempts, delay_ms: result.delay, error: err.message });
    }
    else log.error('AI task failed permanently', { task_id: taskId, type, attempts: after.attempts, error: err.message });
  }
}

function schedulePump(delay = 0) {
  if (state.timer) return;
  state.timer = setTimeout(() => { state.timer = null; pump(); }, Math.max(0, delay));
}

function scheduleRetry(item, delay) {
  setTimeout(() => {
    state.pending.push(item);
    pump();
  }, Math.max(0, delay || 0));
}

function pump() {
  while (state.active < state.concurrency && state.pending.length) {
    const item = state.pending.shift();
    state.active += 1;
    Promise.resolve(execute(item)).catch(() => {}).finally(() => {
      state.active -= 1;
      pump();
    });
  }
  if (state.pending.length && state.active < state.concurrency) schedulePump();
}

function stats() { return { pending: state.pending.length, active: state.active, concurrency: state.concurrency }; }

module.exports = { register, enqueue, enqueueHandler, recover, stats };
