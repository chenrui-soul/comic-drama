const { v4: uuidv4 } = require('uuid');
const { getTenantId } = require('../utils/tenantContext');

function createTask(db, log, taskType, resourceId) {
  const id = uuidv4();
  const now = new Date().toISOString();
  const organizationId = getTenantId() || 1;
  const maxPending = Number(process.env.AI_MAX_PENDING_PER_ORG) || 50;
  const pending = db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE organization_id=? AND status IN ('pending','processing') AND deleted_at IS NULL").get(organizationId).count;
  if (pending >= maxPending) throw new Error('工作区待处理任务过多，请等待现有任务完成');
  db.prepare(
    `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, organization_id, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, '', ?, ?, ?, ?)`
  ).run(id, taskType, resourceId || '', organizationId, now, now);
  log.info('Task created', { task_id: id, type: taskType, resource_id: resourceId });
  const task = getTask(db, id);
  return task || { id, type: taskType, status: 'pending', progress: 0, message: '', resource_id: resourceId || '', created_at: now, updated_at: now, completed_at: null };
}

function getTask(db, taskId) {
  const tenantId = getTenantId();
  const sql = tenantId
    ? 'SELECT * FROM async_tasks WHERE id = ? AND organization_id = ? AND deleted_at IS NULL'
    : 'SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL';
  const row = tenantId ? db.prepare(sql).get(taskId, tenantId) : db.prepare(sql).get(taskId);
  if (!row) return null;
  return rowToTask(row);
}

function getTasksByResource(db, resourceId) {
  const tenantId = getTenantId();
  const sql = tenantId
    ? 'SELECT * FROM async_tasks WHERE resource_id = ? AND organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
    : 'SELECT * FROM async_tasks WHERE resource_id = ? AND deleted_at IS NULL ORDER BY created_at DESC';
  const rows = tenantId ? db.prepare(sql).all(resourceId, tenantId) : db.prepare(sql).all(resourceId);
  return rows.map(rowToTask);
}

function updateTaskStatus(db, taskId, status, progress, message) {
  const now = new Date().toISOString();
  let completedAt = null;
  if (status === 'completed' || status === 'failed') completedAt = now;
  db.prepare(
    `UPDATE async_tasks SET status = ?, progress = ?, message = ?, updated_at = ?, completed_at = ?
     WHERE id = ?` + (getTenantId() ? ' AND organization_id = ?' : '')
  ).run(...[status, progress ?? 0, message || '', now, completedAt, taskId, ...(getTenantId() ? [getTenantId()] : [])]);
}

function updateTaskError(db, taskId, errMsg) {
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE async_tasks SET status = 'failed', error = ?, progress = 0, completed_at = ?, updated_at = ?
       WHERE id = ?` + (getTenantId() ? ' AND organization_id = ?' : '')
    ).run(...[errMsg || '', now, now, taskId, ...(getTenantId() ? [getTenantId()] : [])]);
  } catch (e) {
    if ((e.message || '').includes('error')) {
      updateTaskStatus(db, taskId, 'failed', 0, errMsg || '任务失败');
    } else throw e;
  }
}

function updateTaskResult(db, taskId, result) {
  const now = new Date().toISOString();
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result || {});
  db.prepare(
    `UPDATE async_tasks SET status = 'completed', progress = 100, result = ?, completed_at = ?, updated_at = ?
     WHERE id = ?` + (getTenantId() ? ' AND organization_id = ?' : '')
  ).run(...[resultStr, now, now, taskId, ...(getTenantId() ? [getTenantId()] : [])]);
}

function rowToTask(r) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    progress: r.progress ?? 0,
    message: r.message,
    error: r.error,
    result: r.result,
    resource_id: r.resource_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
    attempts: r.attempts ?? 0,
    max_attempts: r.max_attempts ?? 3,
    next_attempt_at: r.next_attempt_at,
    started_at: r.started_at,
    last_error: r.last_error,
  };
}

const ORPHAN_ASYNC_TASK_MSG = '服务重启后任务中断，请重新操作';
const USER_CANCEL_TASK_MSG = '用户已取消';

/**
 * 用户主动取消进行中的异步任务（无法中断已在执行的 AI 调用，但会停止前端轮询并防止恢复）。
 */
function cancelTask(db, log, taskId, reason) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'completed' || task.status === 'failed') {
    return { ok: true, already_done: true, task };
  }
  const msg = (reason || USER_CANCEL_TASK_MSG).toString().trim() || USER_CANCEL_TASK_MSG;
  updateTaskError(db, taskId, msg);
  log.info('Task cancelled by user', { task_id: taskId, type: task.type });
  return { ok: true, task: getTask(db, taskId) };
}

/**
 * 进程内 setImmediate 任务在重启后会丢失；启动时将遗留的 pending/processing 标为失败，避免前端无限轮询。
 */
function failOrphanedAsyncTasksOnStartup(db, log) {
  const rows = db.prepare(
    `SELECT id, type, status, resource_id, payload FROM async_tasks
     WHERE status IN ('pending', 'processing') AND deleted_at IS NULL`
  ).all();
  let activeVideoTasks = new Set();
  try {
    activeVideoTasks = new Set(db.prepare(
      `SELECT task_id FROM video_generations
       WHERE task_id IS NOT NULL AND status IN ('pending', 'processing') AND provider_task_id IS NOT NULL`
    ).all().map((row) => row.task_id));
  } catch (_) {
    // Older test databases and installations may not have video_generations yet.
  }
  const orphaned = rows.filter((row) => !row.payload && !activeVideoTasks.has(row.id));
  if (!orphaned.length) return 0;
  log.warn('Failing orphaned async tasks after startup', { count: orphaned.length });
  for (const row of orphaned) {
    updateTaskError(db, row.id, ORPHAN_ASYNC_TASK_MSG);
    log.info('Orphaned async task marked failed', {
      task_id: row.id,
      type: row.type,
      resource_id: row.resource_id,
      previous_status: row.status,
    });
  }
  return orphaned.length;
}

module.exports = {
  createTask,
  getTask,
  getTasksByResource,
  updateTaskStatus,
  updateTaskError,
  updateTaskResult,
  failOrphanedAsyncTasksOnStartup,
  cancelTask,
  ORPHAN_ASYNC_TASK_MSG,
  USER_CANCEL_TASK_MSG,
};
