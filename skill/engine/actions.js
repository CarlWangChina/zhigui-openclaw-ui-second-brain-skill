/**
 * Shared application action layer.
 * Browser HTTP handlers and Electron IPC handlers both call this module.
 */
const crypto = require('crypto');
const Storage = require('./storage');
const { BrainIndex } = require('./brain-index');

let dataDir = null;
let brainIndex = null;

/**
 * 操作层异常类，携带 HTTP 状态码和业务错误码
 */
class ActionError extends Error {
  /**
   * @param {string} message - 错误描述
   * @param {number} [status=400] - HTTP 状态码
   * @param {string} [code='ACTION_FAILED'] - 业务错误码
   */
  constructor(message, status = 400, code = 'ACTION_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 初始化数据目录、存储模块和 BrainIndex
 * @param {string} dir - 数据存储目录的绝对路径
 */
function configure(dir) {
  dataDir = dir;
  Storage.setDataDir(dir);
  brainIndex = new BrainIndex(dir);
}

/**
 * 检查模块是否已配置，未配置则抛出异常
 * @throws {ActionError} 未配置时抛出
 */
function ensureConfigured() {
  if (!dataDir) throw new ActionError('Action service is not configured', 500, 'NOT_CONFIGURED');
}

/**
 * 生成带前缀的唯一 ID
 * @param {string} prefix - ID 前缀（如 'task'、'note'）
 * @returns {string} 格式为 "{prefix}_{uuid}" 的唯一标识符
 */
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
/**
 * 返回当前时间的 ISO 8601 字符串
 * @returns {string} ISO 格式时间戳
 */
function now() { return new Date().toISOString(); }

/**
 * 将值规范化为 YYYY-MM-DD 格式日期字符串
 * @param {*} value - 输入值
 * @param {{ optional?: boolean }} [opts] - 选项
 * @returns {string} YYYY-MM-DD 格式日期字符串，optional 且为空时返回空串
 * @throws {ActionError} 格式无效或日期不合法且非 optional 时抛出
 */
function normalizeDate(value, { optional = true } = {}) {
  if (value == null || value === '') {
    if (optional) return '';
    throw new ActionError('Date is required', 400, 'INVALID_DATE');
  }
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new ActionError('Invalid date format (expected YYYY-MM-DD)', 400, 'INVALID_DATE');
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const check = new Date(Date.UTC(y, month - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new ActionError('Invalid calendar date', 400, 'INVALID_DATE');
  }
  return text;
}

/**
 * 将值规范化为 HH:MM 格式时间字符串
 * @param {*} value - 输入值
 * @param {{ optional?: boolean }} [opts] - 选项
 * @returns {string} HH:MM 格式时间字符串，optional 且为空时返回空串
 * @throws {ActionError} 格式无效且非 optional 时抛出
 */
function normalizeTime(value, { optional = true } = {}) {
  if (value == null || value === '') {
    if (optional) return '';
    throw new ActionError('Time is required', 400, 'INVALID_TIME');
  }
  const text = String(value).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new ActionError('Invalid time format (expected HH:MM)', 400, 'INVALID_TIME');
  }
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/**
 * 校验并返回必填文本，为空或超长时抛出异常
 * @param {*} value - 输入值
 * @param {string} field - 字段名称（用于错误信息）
 * @param {number} [max=500] - 最大字符数
 * @returns {string} 去除首尾空白的文本
 * @throws {ActionError} 为空或超长时抛出
 */
function requiredText(value, field, max = 500) {
  const text = String(value || '').trim();
  if (!text) throw new ActionError(`${field} is required`, 400, 'MISSING_FIELD');
  if (text.length > max) throw new ActionError(`${field} is too long`, 400, 'INVALID_FIELD');
  return text;
}

/**
 * 将值规范化为分钟时长（5-1440）
 * @param {*} value - 输入值
 * @param {number} [fallback=60] - 非数值时的回退值
 * @returns {number} 5 到 1440 的整数分钟数
 * @throws {ActionError} 超出范围时抛出
 */
function durationValue(value, fallback = 60) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 5 || parsed > 1440) throw new ActionError('Duration must be between 5 and 1440 minutes');
  return parsed;
}

/**
 * 将值规范化为 0-100 的整数优先级
 * @param {*} value - 输入值
 * @param {number} [fallback=50] - 非数值时的回退值
 * @returns {number} 0 到 100 的整数
 */
function priorityNumber(value, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.max(0, Math.min(100, parsed)));
}

/**
 * 将值规范化为合法的保留级别
 * @param {*} value - 输入值
 * @param {string} [fallback='transient'] - 非法值时的回退值
 * @returns {string} 'transient' | 'review' | 'memory'
 */
function retentionLevel(value, fallback = 'transient') {
  return ['transient', 'review', 'memory'].includes(value) ? value : fallback;
}

/**
 * 读取并返回完整应用状态
 * @returns {Object} 完整应用状态对象
 * @throws {ActionError} 未配置时抛出
 */
function read() {
  ensureConfigured();
  return Storage.readFullState();
}

/**
 * 将状态写入存储并更新 lastUpdated 时间戳
 * @param {Object} state - 要持久化的完整应用状态
 */
function save(state) {
  state.meta = state.meta || {};
  state.meta.lastUpdated = now();
  Storage.writeState(state);
}

/**
 * 在状态锁内执行读-改-写操作，防止并发竞争
 *
 * 用法:
 *   const result = withStateLock(state => {
 *     const task = state.schedule.days[date].tasks.find(t => t.id === id);
 *     task.completed = true;
 *     return task;
 *   });
 *
 * 锁在读之前获取、写之后释放，保证原子性。
 * @param {function(Object): *} fn - 接收 state 并可修改的回调函数
 * @returns {*} fn 的返回值
 */
function withStateLock(fn) {
  return Storage.withLock('actions', () => {
    const state = Storage.readFullState();
    const result = fn(state);  // fn can modify state
    Storage.writeState(state);
    return result;
  });
}

/**
 * 记录审计日志（当前为空操作，保留接口）
 * @param {string} operation - 操作名称
 * @param {string} kind - 实体种类
 * @param {Object} entity - 关联的实体对象
 * @param {*=} [detail=null] - 附加详情
 */
function audit(operation, kind, entity, detail = null) {
  // The former append-only event stream duplicated the real entity state and
  // left deleted test records visible. Entity documents are now the only
  // source of truth; history is reserved for meaningful conversations.
}

/**
 * 在状态中查找指定日期的任务
 * @param {Object} state - 完整应用状态
 * @param {string} date - 日期字符串（YYYY-MM-DD）
 * @param {string} taskId - 任务 ID
 * @returns {Object} 找到的任务对象
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function findTask(state, date, taskId) {
  const day = state.schedule?.days?.[date];
  if (!day) throw new ActionError('Date not found', 404, 'NOT_FOUND');
  const task = (day.tasks || []).find(t => t.id === taskId);
  if (!task) throw new ActionError('Task not found', 404, 'NOT_FOUND');
  return task;
}

/**
 * 切换任务完成状态，完成时自动处理关联的一次性目标
 * @param {{ date: string, taskId: string }} payload - 日期和任务 ID
 * @returns {{ success: boolean, completed: boolean, task: Object }} 操作结果及更新后的任务对象
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function toggleTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  const state = read();
  const task = findTask(state, date, payload.taskId);
  task.completed = !task.completed;
  task.completedAt = task.completed ? now() : null;
  task.completedBy = task.completed ? 'user' : null;
  if (task.completed && task.relatedGoalId) {
    const goal = (state.currentGoals || []).find(g => g.id === task.relatedGoalId);
    if (goal?.isOneShot === true) {
      goal.completed = true;
      goal.completedAt = now();
      goal.completedDate = now().slice(0, 10);
    }
    // Task 1.4: Remove all future uncompleted tasks with the same relatedGoalId
    // (prevents stale tasks from lingering after the goal is done/completed)
    if (state.schedule && state.schedule.days) {
      for (const [dayDate, dayData] of Object.entries(state.schedule.days)) {
        if (dayDate > date && dayData.tasks) {
          dayData.tasks = dayData.tasks.filter(t => !(t.relatedGoalId === task.relatedGoalId && !t.completed));
        }
      }
    }
  }
  save(state);
  audit(task.completed ? 'complete' : 'reopen', 'task', task, { date });
  return { success: true, completed: task.completed, task };
}

/**
 * 更新任务的时间和时长，并标记为手动锁定
 * @param {{ date: string, taskId: string, time?: string, duration?: number }} payload - 日期、任务 ID 及要更新的字段
 * @returns {{ success: boolean, task: Object }} 操作结果及更新后的任务对象
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function updateTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  const state = read();
  const task = findTask(state, date, payload.taskId);
  if (payload.time !== undefined) task.time = normalizeTime(payload.time);
  if (payload.duration !== undefined) task.duration = durationValue(payload.duration, task.duration || 60);
  task.manualLocked = true;
  task.manualLockedAt = now();
  save(state);
  audit('update', 'task', task, { date, fields: ['time', 'duration'] });
  return { success: true, task };
}

/**
 * 删除指定日期的任务并清理索引
 * @param {{ date: string, taskId: string }} payload - 日期和任务 ID
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除标题
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function deleteTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  const state = read();
  const day = state.schedule?.days?.[date];
  if (!day) throw new ActionError('Date not found', 404, 'NOT_FOUND');
  const index = (day.tasks || []).findIndex(task => task.id === payload.taskId);
  if (index < 0) throw new ActionError('Task not found', 404, 'NOT_FOUND');
  const [task] = day.tasks.splice(index, 1);
  // A task can have been associated with a topic after an AI review. Remove that
  // reference too, so the lightweight index never exposes a deleted action.
  try { brainIndex.unlinkEntityCascade('tasks', task.id); } catch {}
  save(state);
  audit('delete', 'task', task, { date });
  return { success: true, deleted: task.title };
}

/**
 * 解锁任务，允许系统重新调度时间和优先级
 * @param {{ date: string, taskId: string }} payload - 日期和任务 ID
 * @returns {{ success: boolean, task: Object }} 操作结果及更新后的任务对象
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function unlockTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  const state = read();
  const task = findTask(state, date, payload.taskId);
  task.manualLocked = false;
  delete task.manualLockedAt;
  save(state);
  audit('release-preference', 'task', task, { date });
  return { success: true, task };
}

/**
 * 在全局状态中查找优先级目标实体（任务或目标）
 * @param {Object} state - 完整应用状态
 * @param {string} type - 实体类型（task/strategicGoal/currentGoal/constraint）
 * @param {string} targetId - 实体 ID
 * @returns {Object|null} 找到的实体对象，未找到返回 null
 */
function findPriorityTarget(state, type, targetId) {
  if (type === 'task') {
    for (const day of Object.values(state.schedule?.days || {})) {
      const task = (day.tasks || []).find(t => t.id === targetId);
      if (task) return task;
    }
  }
  const map = { strategicGoal: 'strategicGoals', currentGoal: 'currentGoals', constraint: 'constraints' };
  const list = state[map[type]];
  return Array.isArray(list) ? list.find(item => item.id === targetId) : null;
}

/**
 * 更新实体优先级并锁定为用户手动设置
 * @param {{ type: string, id: string, priority: number }} payload - 实体类型、ID 及新优先级
 * @returns {{ success: boolean, priority: number, locked: boolean }} 操作结果
 * @throws {ActionError} 目标不存在时抛出
 */
function updatePriority(payload) {
  const state = read();
  const target = findPriorityTarget(state, payload.type, payload.id);
  if (!target) throw new ActionError('Target not found', 404, 'NOT_FOUND');
  target.priority = priorityNumber(payload.priority);
  target.locked = true;
  target.prioritySource = 'user';
  target.priorityOverride = { strength: 'hard', source: 'user', setAt: now() };
  target.updatedAt = now();
  save(state);
  audit('update-priority', payload.type, target, { priority: target.priority });
  return { success: true, priority: target.priority, locked: true };
}

/**
 * 解锁实体优先级，允许系统重新计算
 * @param {{ type: string, id: string }} payload - 实体类型及 ID
 * @returns {{ success: boolean, locked: boolean }} 操作结果
 * @throws {ActionError} 目标不存在时抛出
 */
function unlockPriority(payload) {
  const state = read();
  const target = findPriorityTarget(state, payload.type, payload.id);
  if (!target) throw new ActionError('Target not found', 404, 'NOT_FOUND');
  target.locked = false;
  target.priorityOverride = { strength: 'soft', source: 'user', releasedAt: now() };
  target.updatedAt = now();
  save(state);
  audit('release-priority', payload.type, target);
  return { success: true, locked: false };
}

/**
 * 新增日程事件任务
 * @param {{ date: string, time: string, title: string, description?: string, duration?: number, priority?: number, category?: string, retention?: string, prioritySource?: string }} payload - 事件内容与元数据
 * @returns {{ success: boolean, task: Object }} 操作结果及创建的任务对象
 * @throws {ActionError} 日期、时间或标题无效时抛出
 */
function addEvent(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  const time = normalizeTime(payload.time, { optional: false });
  const title = requiredText(payload.title, 'Title', 200);
  const state = read();
  state.schedule = state.schedule || { days: {} };
  state.schedule.days = state.schedule.days || {};
  if (!state.schedule.days[date]) state.schedule.days[date] = { date, tasks: [], errands: [], dayNotes: [] };
  const task = {
    id: id('task'), date, time, duration: durationValue(payload.duration, 60), title,
    description: String(payload.description || '').trim(), priority: priorityNumber(payload.priority),
    completed: false, source: 'manual', prioritySource: payload.prioritySource || 'pending', category: payload.category || 'event',
    retention: retentionLevel(payload.retention, 'review'),
    manualLocked: true, manualLockedAt: now(), createdAt: now(),
  };
  state.schedule.days[date].tasks = state.schedule.days[date].tasks || [];
  state.schedule.days[date].tasks.push(task);
  state.schedule.days[date].tasks.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  save(state);
  audit('create', 'task', task, { date });
  return { success: true, task };
}

/**
 * 新增战略目标、当前目标或约束
 * @param {{ type: string, title: string, description?: string, priority?: number }} payload - 目标类型及内容
 * @returns {{ success: boolean, goal: Object }} 操作结果及创建的目标对象
 * @throws {ActionError} 类型未知时抛出
 */
function addGoal(payload) {
  const typeMap = { strategicGoal: ['strategicGoals', 'strategic'], currentGoal: ['currentGoals', 'current'], constraint: ['constraints', 'constraint'] };
  const mapping = typeMap[payload.type];
  if (!mapping) throw new ActionError('Unknown goal type');
  const title = requiredText(payload.title, 'Title', 240);
  const state = read();
  const goal = {
    id: id(mapping[1] === 'constraint' ? 'constraint' : 'goal'), type: mapping[1], title,
    description: String(payload.description || '').trim(), priority: priorityNumber(payload.priority),
    completed: false, locked: false, source: 'manual', createdAt: now(), updatedAt: now(),
  };
  state[mapping[0]] = state[mapping[0]] || [];
  state[mapping[0]].push(goal);
  save(state);
  audit('create', mapping[1], goal);
  return { success: true, goal };
}

/**
 * 完成或重新打开目标（支持 currentGoal 与 strategicGoal）
 * @param {{ id: string, completed: boolean }} payload - 目标 ID 及目标完成状态
 * @returns {{ success: boolean, completed: boolean, goal: Object, type: string }} 操作结果及更新后的目标对象
 * @throws {ActionError} 目标不存在时抛出
 */
function completeGoal(payload) {
  const state = read();
  let goal = (state.currentGoals || []).find(g => g.id === payload.id);
  let type = 'currentGoal';
  if (!goal) {
    goal = (state.strategicGoals || []).find(g => g.id === payload.id);
    type = 'strategicGoal';
  }
  if (!goal) throw new ActionError('Goal not found', 404, 'NOT_FOUND');
  goal.completed = payload.completed === true;
  goal.completedAt = goal.completed ? now() : null;
  goal.updatedAt = now();
  save(state);
  audit(goal.completed ? 'complete' : 'reopen', type === 'strategicGoal' ? 'strategicGoal' : 'goal', goal);
  return { success: true, completed: goal.completed, goal, type };
}

/**
 * 删除目标并清理关联任务及索引
 * @param {{ type: string, id: string }} payload - 目标类型（strategicGoal/currentGoal/constraint）及 ID
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除标题
 * @throws {ActionError} 类型无效或目标不存在时抛出
 */
function deleteGoal(payload) {
  const map = { strategicGoal: 'strategicGoals', currentGoal: 'currentGoals', constraint: 'constraints' };
  const state = read();
  const list = state[map[payload.type]];
  if (!Array.isArray(list)) throw new ActionError('Invalid goal type');
  const index = list.findIndex(g => g.id === payload.id);
  if (index < 0) throw new ActionError('Goal not found', 404, 'NOT_FOUND');
  const [goal] = list.splice(index, 1);
  for (const day of Object.values(state.schedule?.days || {})) {
    day.tasks = (day.tasks || []).filter(task => task.relatedGoalId !== payload.id && task.relatedStrategicGoalId !== payload.id);
  }
  try { brainIndex.unlinkEntityCascade('goals', payload.id); } catch {}
  save(state);
  audit('delete', payload.type, goal);
  return { success: true, deleted: goal.title };
}

/**
 * 新增一条待办事项
 * @param {{ title: string, date?: string, time?: string, duration?: number, priority?: string, category?: string, note?: string, retention?: string, prioritySource?: string }} payload - 待办内容与元数据
 * @returns {{ success: boolean, errand: Object }} 操作结果及创建的待办对象
 */
function addErrand(payload) {
  const title = requiredText(payload.title, 'Title', 240);
  const date = normalizeDate(payload.date || new Date().toISOString().slice(0, 10), { optional: false });
  const priority = ['must', 'should', 'nice'].includes(payload.priority) ? payload.priority : 'should';
  const state = read();
  const errand = {
    id: id('errand'), title, date, time: normalizeTime(payload.time),
    duration: durationValue(payload.duration, 60), priority,
    prioritySource: payload.prioritySource || 'user',
    category: payload.category || 'misc', note: String(payload.note || '').trim(),
    retention: retentionLevel(payload.retention),
    completed: false, source: 'manual', createdAt: now(),
  };
  state.errands = state.errands || [];
  state.errands.push(errand);
  save(state);
  audit('create', 'errand', errand, { date });
  return { success: true, errand };
}

/**
 * 完成待办事项：完成后直接删除
 * @param {{ id: string }} payload - 包含待办 ID 的参数
 * @returns {{ success: boolean, completed: boolean, discarded: boolean, errand: Object }} 操作结果
 * @throws {ActionError} 待办不存在或已完成时抛出
 */
function completeErrand(payload) {
  const state = read();
  const index = (state.errands || []).findIndex(e => e.id === payload.id);
  const errand = state.errands?.[index];
  if (!errand) throw new ActionError('Errand not found', 404, 'NOT_FOUND');
  if (errand.completed) throw new ActionError('Errand already completed and deleted', 400, 'ALREADY_DONE');

  // Lifecycle: once done, erase from list and knowledge index.
  state.errands.splice(index, 1);
  try { brainIndex.unlinkEntityCascade('errands', errand.id); } catch {}
  save(state);
  audit('complete', 'errand', errand);
  return { success: true, completed: true, discarded: true, errand };
}

/**
 * 更新待办事项的日期、时间、时长或保留级别
 * @param {{ id: string, date?: string, time?: string, duration?: number, retention?: string }} payload - 待办 ID 及要更新的字段
 * @returns {{ success: boolean, errand: Object }} 操作结果及更新后的待办对象
 * @throws {ActionError} 待办不存在或字段无效时抛出
 */
function updateErrand(payload) {
  const state = read();
  const errand = (state.errands || []).find(e => e.id === payload.id);
  if (!errand) throw new ActionError('Action not found', 404, 'NOT_FOUND');
  if (payload.date !== undefined) errand.date = normalizeDate(payload.date, { optional: false });
  if (payload.time !== undefined) errand.time = normalizeTime(payload.time);
  if (payload.duration !== undefined) errand.duration = durationValue(payload.duration, errand.duration || 60);
  if (payload.retention !== undefined) errand.retention = retentionLevel(payload.retention);
  errand.manualLocked = true;
  errand.manualLockedAt = now();
  errand.updatedAt = now();
  save(state);
  audit('update', 'errand', errand, { fields: ['date', 'time', 'duration'] });
  return { success: true, errand };
}

/**
 * 删除指定待办事项并清理索引
 * @param {{ id: string }} payload - 包含待办 ID 的参数
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除标题
 * @throws {ActionError} 待办不存在时抛出
 */
function deleteErrand(payload) {
  const state = read();
  const index = (state.errands || []).findIndex(e => e.id === payload.id);
  if (index < 0) throw new ActionError('Errand not found', 404, 'NOT_FOUND');
  const [errand] = state.errands.splice(index, 1);
  try { brainIndex.unlinkEntityCascade('errands', payload.id); } catch {}
  save(state);
  audit('delete', 'errand', errand);
  return { success: true, deleted: errand.title };
}

/**
 * 新增一条笔记并关联主题索引
 * @param {{ content: string, title?: string, topic?: string, category?: string, domain?: string, source?: string, relatedDate?: string, relatedTime?: string }} payload - 笔记内容与元数据
 * @returns {{ success: boolean, note: Object }} 操作结果及创建的笔记对象
 */
function addNote(payload) {
  const content = requiredText(payload.content, 'Content', 10000);
  const suppliedTitle = String(payload.title || '').trim();
  const topicName = String(payload.topic || '').trim();
  let topicId = null;
  let domain = payload.domain || 'misc';
  if (topicName) {
    try {
      topicId = brainIndex.ensureTopic(topicName, { domain, category: payload.category });
      domain = brainIndex._readIndex().topics[topicId]?.domain || domain;
    } catch {}
  }
  const note = {
    id: id('note'),
    title: suppliedTitle || '待 AI 归纳',
    topicId,
    category: payload.category || null,
    domain,
    content,
    relatedDate: normalizeDate(payload.relatedDate), relatedTime: normalizeTime(payload.relatedTime),
    source: payload.source || 'User manual',
    needsEnrichment: !suppliedTitle || !topicId,
    organizationStatus: (!suppliedTitle || !topicId) ? 'pending' : 'confirmed',
    createdAt: now(),
  };
  const state = read();
  state.notes = Array.isArray(state.notes) ? state.notes : [];
  state.notes.push(note);
  save(state);
  if (topicId) {
    try { brainIndex.linkEntity(topicId, 'notes', note.id); brainIndex.reindexTopic(topicId); } catch (e) { require('./logger').error('brain-index', 'reindex failed for topic', { tid: topicId, error: e.message }); }
  }
  audit('create', 'note', note);
  return { success: true, note };
}

/**
 * 为笔记创建一条待确认的 AI 组织提案
 * @param {{ id: string, title: string, topic: string, category: string, domain?: string, signal?: string, reason?: string, conflicts?: string[] }} payload - 笔记 ID 及提案内容
 * @returns {{ success: boolean, review: Object, noteId: string }} 操作结果及审阅对象
 * @throws {ActionError} 笔记不存在时抛出
 */
function proposeNoteEnrichment(payload) {
  const state = read();
  state.notes = Array.isArray(state.notes) ? state.notes : [];
  const note = state.notes.find(item => item.id === payload.id);
  if (!note) throw new ActionError('Note not found', 404, 'NOT_FOUND');
  const proposal = {
    title: requiredText(payload.title, 'Title', 160),
    topic: requiredText(payload.topic, 'Topic', 100),
    category: requiredText(payload.category, 'Category', 100),
    domain: String(payload.domain || note.domain || 'misc').trim() || 'misc',
    signal: payload.signal || null,
    reason: String(payload.reason || '').trim().slice(0, 600),
    conflicts: Array.isArray(payload.conflicts)
      ? payload.conflicts.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [],
  };
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];
  let review = state.pendingReviews.find(item => item.type === 'note_organization' && item.noteId === note.id && item.status === 'pending');
  if (review) {
    review.proposal = proposal;
    review.updatedAt = now();
  } else {
    review = {
      id: id('review'), type: 'note_organization', noteId: note.id,
      title: proposal.title, proposal, status: 'pending', createdAt: now(), source: 'ai',
    };
    state.pendingReviews.unshift(review);
  }
  note.organizationStatus = 'proposed';
  note.proposedReviewId = review.id;
  save(state);
  audit('propose-organization', 'note', note, { reviewId: review.id });
  return { success: true, review, noteId: note.id };
}

/**
 * 处理待审项的接受或拒绝决策
 * @param {{ reviewId: string, decision: 'accept' | 'reject' }} payload - 审阅 ID 及决策
 * @returns {{ success: boolean, review: Object }} 操作结果及更新后的审阅对象
 * @throws {ActionError} 决策无效、审阅不存在或关联笔记不存在时抛出
 */
function resolveReview(payload) {
  const decision = payload.decision === 'accept' ? 'accept' : payload.decision === 'reject' ? 'reject' : null;
  if (!decision) throw new ActionError('Decision must be accept or reject', 400, 'INVALID_DECISION');
  const state = read();
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];
  const review = state.pendingReviews.find(item => item.id === payload.reviewId && item.status === 'pending');
  if (!review) throw new ActionError('Pending review not found', 404, 'NOT_FOUND');
  review.status = decision === 'accept' ? 'accepted' : 'rejected';
  review.resolvedAt = now();
  review.resolvedBy = 'user';

  if (review.type === 'note_organization') {
    const note = (state.notes || []).find(item => item.id === review.noteId);
    if (!note) throw new ActionError('Note for review not found', 404, 'NOT_FOUND');
    if (decision === 'accept') {
      const proposal = review.proposal || {};
      let topicId = null;
      try {
        topicId = brainIndex.ensureTopic(proposal.topic, { domain: proposal.domain || note.domain || 'misc', category: proposal.category });
      } catch (error) {
        throw new ActionError(`Unable to classify note: ${error.message}`, 500, 'CLASSIFICATION_FAILED');
      }
      const oldTopicId = note.topicId || null;
      note.title = proposal.title;
      note.topicId = topicId;
      note.category = proposal.category;
      note.domain = proposal.domain || note.domain || 'misc';
      if (proposal.signal) note.signal = proposal.signal;
      note.needsEnrichment = false;
      note.organizationStatus = 'confirmed';
      note.enrichedAt = now();
      note.enrichedBy = 'ai-proposal-confirmed-by-user';
      delete note.proposedReviewId;
      if (oldTopicId && oldTopicId !== topicId) {
        try { brainIndex.unlinkEntityCascade('notes', note.id); } catch {}
      }
      try { brainIndex.linkEntity(topicId, 'notes', note.id); } catch {}
    } else {
      note.organizationStatus = 'pending';
      delete note.proposedReviewId;
    }
  }
  save(state);
  if (review.type === 'note_organization' && decision === 'accept') {
    const reindexTid = (state.notes || []).find(note => note.id === review.noteId)?.topicId;
    try { brainIndex.reindexTopic(reindexTid); } catch (e) { require('./logger').error('brain-index', 'reindex failed for topic', { tid: reindexTid, error: e.message }); }
  }

  // ── Topic reorganization actions (executed on user accept) ──
  if (decision === 'accept') {
    if (review.type === 'topic_split') {
      const proposal = review.proposal || {};
      const sourceTopicId = proposal.sourceTopicId;
      const noteMoves = proposal.noteMoves || []; // [{ noteId, targetTopicId }]
      for (const move of noteMoves) {
        const note = (state.notes || []).find(n => n.id === move.noteId);
        if (!note) continue;
        try { brainIndex.unlinkEntityCascade('notes', note.id); } catch {}
        note.topicId = move.targetTopicId;
        try { brainIndex.linkEntity(move.targetTopicId, 'notes', note.id); } catch {}
      }
      try { brainIndex.reindexTopic(sourceTopicId); } catch {}
      const targetTopicIds = [...new Set(noteMoves.map(m => m.targetTopicId))];
      for (const tid of targetTopicIds) {
        try { brainIndex.reindexTopic(tid); } catch {}
      }
    }
    if (review.type === 'topic_merge') {
      const proposal = review.proposal || {};
      // Support legacy single-source proposals as well as multi-source proposals.
      const sourceTopicIds = Array.isArray(proposal.sourceTopicIds) && proposal.sourceTopicIds.length
        ? proposal.sourceTopicIds
        : (proposal.sourceTopicId ? [proposal.sourceTopicId] : []);
      const targetTopicId = proposal.targetTopicId;
      for (const sourceTopicId of sourceTopicIds) {
        if (sourceTopicId === targetTopicId) continue;
        // Re-link all notes from source to target
        for (const note of (state.notes || [])) {
          if (note.topicId === sourceTopicId) {
            try { brainIndex.unlinkEntityCascade('notes', note.id); } catch {}
            note.topicId = targetTopicId;
            try { brainIndex.linkEntity(targetTopicId, 'notes', note.id); } catch {}
          }
        }
        // Re-link all goals from source to target
        for (const goal of [...(state.strategicGoals || []), ...(state.currentGoals || [])]) {
          if (goal.topicId === sourceTopicId) {
            goal.topicId = targetTopicId;
          }
        }
        // Delete the now-empty source topic
        try { brainIndex.cascadeDelete(sourceTopicId); } catch {}
      }
      try { brainIndex.reindexTopic(targetTopicId); } catch {}
    }
    if (review.type === 'topic_precipitation') {
      const proposal = review.proposal || {};
      const topicId = proposal.topicId;
      if (topicId) {
        try {
          const idx = brainIndex._readIndex();
          const t = idx.topics[topicId];
          if (t && !t.precipitated) {
            brainIndex._precipitate(topicId);
          }
        } catch (e) {
          require('./logger').error('brain-index', 'precipitation failed for topic', { tid: topicId, error: e.message });
        }
      }
    }
    if (review.type === 'topic_rename') {
      const proposal = review.proposal || {};
      const topicId = proposal.topicId;
      const newLabel = proposal.newLabel;
      try {
        // ensureTopic with the new label creates/updates; then we delete the old one
        brainIndex.ensureTopic(newLabel, { domain: proposal.domain, category: proposal.category });
      } catch {}
      // Update all notes pointing to old topic label (via topicId, not label)
      // The topicId stays the same — we update the label in the index
      const idx = brainIndex._readIndex();
      if (idx.topics[topicId]) {
        idx.topics[topicId].label = newLabel;
        idx.topics[topicId].updatedAt = now();
        brainIndex._writeIndex(idx);
      }
      try { brainIndex.reindexTopic(topicId); } catch {}
    }
  }

  audit(`review-${decision}`, review.type, { id: review.id, title: review.title || review.type }, { reviewId: review.id });
  return { success: true, review };
}

/**
 * 提议将一个 topic 拆分（AI 读取 topic 内容后提出提案）
 * @param {{ sourceTopicId: string, noteMoves: Array<{ noteId: string, targetTopicLabel: string }>, newTopics: Array<{ label: string, category: string, domain?: string }>, reason: string }} payload - 拆分提案
 * @returns {{ success: boolean, review: Object }} 操作结果及审阅对象
 */
function proposeTopicSplit(payload) {
  const state = read();
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];

  const idx = brainIndex._readIndex();
  const sourceTopic = idx.topics[payload.sourceTopicId];
  if (!sourceTopic) throw new ActionError('Source topic not found', 404, 'NOT_FOUND');

  const newTopics = Array.isArray(payload.newTopics) ? payload.newTopics : [];
  // Pre-create target topics so we have IDs for the proposal
  const labelToTopicId = {};
  for (const nt of newTopics) {
    const tid = brainIndex.ensureTopic(nt.label, { domain: nt.domain || 'misc', category: nt.category });
    labelToTopicId[nt.label] = tid;
  }

  const noteMoves = Array.isArray(payload.noteMoves) ? payload.noteMoves.map(m => ({
    noteId: m.noteId,
    targetTopicId: labelToTopicId[m.targetTopicLabel] || null,
    targetTopicLabel: m.targetTopicLabel,
  })) : [];

  const proposal = {
    sourceTopicId: payload.sourceTopicId,
    sourceTopicLabel: sourceTopic.label,
    noteMoves,
    newTopics,
    reason: String(payload.reason || '').trim().slice(0, 600),
  };

  const review = {
    id: id('review'), type: 'topic_split',
    title: `拆分主题「${sourceTopic.label}」`,
    proposal, status: 'pending', createdAt: now(), source: 'ai',
  };
  state.pendingReviews.unshift(review);
  save(state);
  audit('propose-topic-split', 'topic', { sourceTopicId: payload.sourceTopicId }, { reviewId: review.id });
  return { success: true, review };
}

/**
 * 提议将多个相关 topic 合并为一个（AI 判断它们应归属同一主题时提出）
 * @param {{ sourceTopicId?: string, sourceTopicIds?: string[], targetTopicId: string, reason: string }} payload - 合并提案
 * @returns {{ success: boolean, review: Object }} 操作结果及审阅对象
 */
function proposeTopicMerge(payload) {
  const state = read();
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];

  const idx = brainIndex._readIndex();
  const rawSources = Array.isArray(payload.sourceTopicIds) && payload.sourceTopicIds.length
    ? payload.sourceTopicIds
    : (payload.sourceTopicId ? [payload.sourceTopicId] : []);
  if (rawSources.length === 0) throw new ActionError('At least one source topic is required', 400, 'MISSING_SOURCE');

  const sourceTopicIds = [...new Set(rawSources)];
  const targetTopicId = payload.targetTopicId;
  if (!idx.topics[targetTopicId]) throw new ActionError('Target topic not found', 404, 'NOT_FOUND');
  if (sourceTopicIds.includes(targetTopicId)) throw new ActionError('Cannot merge a topic into itself', 400, 'SAME_TOPIC');
  for (const tid of sourceTopicIds) {
    if (!idx.topics[tid]) throw new ActionError(`Source topic not found: ${tid}`, 404, 'NOT_FOUND');
  }

  const sourceLabels = sourceTopicIds.map(tid => idx.topics[tid].label);
  const proposal = {
    sourceTopicIds,
    sourceTopicId: sourceTopicIds[0], // backward compatibility
    sourceLabels,
    targetTopicId,
    targetTopicLabel: idx.topics[targetTopicId].label,
    reason: String(payload.reason || '').trim().slice(0, 600),
  };

  const title = sourceTopicIds.length === 1
    ? `合并「${sourceLabels[0]}」→「${proposal.targetTopicLabel}」`
    : `合并 ${sourceTopicIds.length} 个主题 →「${proposal.targetTopicLabel}」`;
  const review = {
    id: id('review'), type: 'topic_merge',
    title,
    proposal, status: 'pending', createdAt: now(), source: 'ai',
  };
  state.pendingReviews.unshift(review);
  save(state);
  audit('propose-topic-merge', 'topic', { sourceTopicIds, targetTopicId }, { reviewId: review.id });
  return { success: true, review };
}

/**
 * 提议重命名一个 topic（AI 发现主题演变时提出）
 * @param {{ topicId: string, newLabel: string, reason: string }} payload - 重命名提案
 * @returns {{ success: boolean, review: Object }} 操作结果及审阅对象
 */
function proposeTopicRename(payload) {
  const state = read();
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];

  const idx = brainIndex._readIndex();
  const topic = idx.topics[payload.topicId];
  if (!topic) throw new ActionError('Topic not found', 404, 'NOT_FOUND');

  const newLabel = requiredText(payload.newLabel, 'New label', 100);
  if (newLabel === topic.label) throw new ActionError('New label is the same as current', 400, 'NO_CHANGE');

  const proposal = {
    topicId: payload.topicId,
    currentLabel: topic.label,
    newLabel,
    domain: topic.domain || 'misc',
    category: topic.category || null,
    reason: String(payload.reason || '').trim().slice(0, 600),
  };

  const review = {
    id: id('review'), type: 'topic_rename',
    title: `重命名主题「${topic.label}」→「${newLabel}」`,
    proposal, status: 'pending', createdAt: now(), source: 'ai',
  };
  state.pendingReviews.unshift(review);
  save(state);
  audit('propose-topic-rename', 'topic', { topicId: payload.topicId }, { reviewId: review.id });
  return { success: true, review };
}

/**
 * 提议把某个 topic 的笔记沉淀为独立文件（AI 判断该主题已足够庞大、需要拆分时提出）
 * @param {{ topicId: string, reason: string }} payload - 沉淀提案
 * @returns {{ success: boolean, review: Object }} 操作结果及审阅对象
 */
function proposeTopicPrecipitation(payload) {
  const state = read();
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];

  const idx = brainIndex._readIndex();
  const topic = idx.topics[payload.topicId];
  if (!topic) throw new ActionError('Topic not found', 404, 'NOT_FOUND');

  const proposal = {
    topicId: payload.topicId,
    topicLabel: topic.label,
    reason: String(payload.reason || '').trim().slice(0, 600),
  };

  const review = {
    id: id('review'), type: 'topic_precipitation',
    title: `沉淀主题「${topic.label}」为独立文件`,
    proposal, status: 'pending', createdAt: now(), source: 'ai',
  };
  state.pendingReviews.unshift(review);
  save(state);
  audit('propose-topic-precipitation', 'topic', { topicId: payload.topicId }, { reviewId: review.id });
  return { success: true, review };
}

/**
 * 创建一个设定冲突的待审项，供用户决策
 * @param {{ title: string, question: string, options?: string[] }} payload - 冲突描述与可选方案
 * @returns {{ success: boolean, review: Object }} 操作结果及创建的审阅对象
 */
function raiseSettingConflict(payload) {
  const title = requiredText(payload.title, 'Title', 160);
  const question = requiredText(payload.question, 'Question', 1000);
  const state = read();
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];
  const review = {
    id: id('review'), type: 'setting_conflict', title, question,
    options: Array.isArray(payload.options) ? payload.options.map(option => String(option || '').trim()).filter(Boolean).slice(0, 6) : [],
    status: 'pending', source: 'ai', createdAt: now(),
  };
  state.pendingReviews.unshift(review);
  save(state);
  audit('raise-conflict', 'setting-conflict', { id: review.id, title }, { reviewId: review.id });
  return { success: true, review };
}

/**
 * 上报笔记之间的矛盾或不一致，放入用户审阅队列
 * @param {{ title: string, description: string, noteIds?: string[], reasoning?: string }} payload - 矛盾描述
 * @returns {{ success: boolean, review: Object }} 操作结果及创建的审阅对象
 */
function raiseNoteConflict(payload) {
  const title = requiredText(payload.title, 'Title', 160);
  const description = requiredText(payload.description, 'Description', 2000);
  const state = read();
  state.pendingReviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : [];
  const review = {
    id: id('review'), type: 'note_conflict', title, description,
    noteIds: Array.isArray(payload.noteIds) ? payload.noteIds.slice(0, 20) : [],
    reasoning: String(payload.reasoning || '').trim(),
    status: 'pending', source: 'ai', createdAt: now(),
  };
  state.pendingReviews.unshift(review);
  save(state);
  audit('raise-note-conflict', 'note-conflict', { id: review.id, title, noteIds: review.noteIds }, { reviewId: review.id });
  return { success: true, review };
}

/**
 * 直接为笔记设置标题、主题和分类（AI 侧调用）
 * @param {{ id: string, title: string, topic: string, category: string, domain?: string, signal?: string }} payload - 笔记丰富化参数
 * @returns {{ success: boolean, note: Object }} 操作结果及更新后的笔记对象
 * @throws {ActionError} 笔记不存在或分类失败时抛出
 */
function enrichNote(payload) {
  const state = read();
  state.notes = Array.isArray(state.notes) ? state.notes : [];
  const note = state.notes.find(n => n.id === payload.id);
  if (!note) throw new ActionError('Note not found', 404, 'NOT_FOUND');
  const title = requiredText(payload.title, 'Title', 160);
  const topic = requiredText(payload.topic, 'Topic', 100);
  const category = requiredText(payload.category, 'Category', 100);
  const oldTopicId = note.topicId || null;
  let topicId = null;
  try {
    topicId = brainIndex.ensureTopic(topic, { domain: payload.domain || note.domain || 'misc', category });
  } catch (error) {
    throw new ActionError(`Unable to classify note: ${error.message}`, 500, 'CLASSIFICATION_FAILED');
  }
  note.title = title;
  note.topicId = topicId;
  note.category = category;
  note.domain = payload.domain || note.domain || 'misc';
  if (payload.signal) note.signal = payload.signal;
  note.needsEnrichment = false;
  note.enrichedAt = now();
  note.enrichedBy = 'ai';
  if (oldTopicId && oldTopicId !== topicId) {
    try { brainIndex.unlinkEntityCascade('notes', note.id); } catch {}
  }
  save(state);
  try {
    brainIndex.linkEntity(topicId, 'notes', note.id);
    brainIndex.reindexTopic(topicId);
    if (oldTopicId && oldTopicId !== topicId) brainIndex.reindexTopic(oldTopicId);
  } catch (e) { require('./logger').error('brain-index', 'reindex failed for topic', { tid: topicId, oldTopicId, error: e.message }); }
  audit('enrich', 'note', note, { oldTopicId });
  return { success: true, note };
}

/**
 * 删除指定笔记并清理索引
 * @param {{ noteId: string }} payload - 包含笔记 ID 的参数
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除笔记内容
 * @throws {ActionError} 笔记不存在时抛出
 */
function deleteNote(payload) {
  const state = read();
  state.notes = Array.isArray(state.notes) ? state.notes : [];
  const index = state.notes.findIndex(n => n.id === payload.noteId);
  if (index < 0) throw new ActionError('Note not found', 404, 'NOT_FOUND');
  const [note] = state.notes.splice(index, 1);
  save(state);
  try { brainIndex.unlinkEntityCascade('notes', payload.noteId); } catch {}
  audit('delete', 'note', note);
  return { success: true, deleted: note.content };
}

/**
 * 更新笔记内容
 * @param {{ noteId: string, content: string }} payload - 笔记 ID 和新内容
 * @returns {{ success: boolean, note: Object }} 操作结果及更新后的笔记对象
 * @throws {ActionError} 笔记不存在时抛出
 */
function updateNote(payload) {
  const state = read();
  state.notes = Array.isArray(state.notes) ? state.notes : [];
  const note = state.notes.find(n => n.id === payload.noteId);
  if (!note) throw new ActionError('Note not found', 404, 'NOT_FOUND');
  const newContent = requiredText(payload.content, 'Content', 10000);
  note.content = newContent;
  save(state);
  audit('update', 'note', note);
  return { success: true, note };
}

/**
 * 更新用户价值体系的权重与决策风格
 * @param {{ priorities?: string[], decisionStyle?: string, learnedFrom?: string[] }} payload - 权重更新参数
 * @returns {{ success: boolean }} 操作结果
 */
function updateWeights(payload) {
  const state = read();
  state.userProfile = state.userProfile || {};
  const system = state.userProfile.valueSystem = state.userProfile.valueSystem || {};
  if (Array.isArray(payload.priorities)) system.priorities = payload.priorities;
  if (payload.decisionStyle) system.decisionStyle = payload.decisionStyle;
  if (Array.isArray(payload.learnedFrom)) system.learnedFrom = [...(system.learnedFrom || []), ...payload.learnedFrom];
  state.userProfile.updatedAt = now();
  save(state);
  audit('update', 'value-system', { id: 'value-system', title: 'Value system' });
  return { success: true };
}

/**
 * 删除指定提醒
 * @param {{ id: string }} payload - 包含提醒 ID 的参数
 * @returns {{ success: boolean }} 操作结果
 * @throws {ActionError} 提醒不存在时抛出
 */
function deleteReminder(payload) {
  const state = read();
  const index = (state.reminders || []).findIndex(r => r.id === payload.id);
  if (index < 0) throw new ActionError('Reminder not found', 404, 'NOT_FOUND');
  const [reminder] = state.reminders.splice(index, 1);
  save(state);
  audit('delete', 'reminder', reminder);
  return { success: true };
}

/**
 * 设置用户偏好项并持久化
 * @param {string} key - 偏好键名
 * @param {*} value - 偏好值
 * @returns {{ success: boolean }} 操作结果
 */
function setPreference(key, value) {
  const state = read();
  state.meta = state.meta || {};
  state.meta[key] = value;
  save(state);
  return { success: true, [key]: value };
}

const ACTIONS = {
  'task.toggle': toggleTask, 'task.update': updateTask, 'task.delete': deleteTask, 'task.unlock': unlockTask,
  'priority.update': updatePriority, 'priority.unlock': unlockPriority,
  'event.add': addEvent, 'goal.add': addGoal, 'goal.complete': completeGoal, 'goal.delete': deleteGoal,
  'errand.add': addErrand, 'errand.complete': completeErrand, 'errand.update': updateErrand, 'errand.delete': deleteErrand,
  'note.add': addNote, 'note.enrich': enrichNote, 'note.propose_enrichment': proposeNoteEnrichment, 'note.delete': deleteNote, 'note.update': updateNote,
  'topic.propose_split': proposeTopicSplit, 'topic.propose_merge': proposeTopicMerge, 'topic.propose_rename': proposeTopicRename, 'topic.propose_precipitation': proposeTopicPrecipitation,
  'review.resolve': resolveReview, 'review.raise_conflict': raiseSettingConflict, 'review.raise_note_conflict': raiseNoteConflict, 'weights.update': updateWeights,
  'reminder.delete': deleteReminder,
  'theme.set': payload => setPreference('theme', payload.theme === 'light' ? 'light' : 'dark'),
  'lang.set': payload => setPreference('lang', payload.lang === 'en' ? 'en' : 'zh'),
};

/**
 * 根据 action 字符串分派到对应的处理函数并执行
 * @param {string} action - 操作标识符，对应 ACTIONS 映射表中的键（如 'task.toggle'）
 * @param {Object} [payload={}] - 传递给处理函数的参数对象
 * @returns {*} 对应处理函数的返回值
 * @throws {ActionError} 未配置或 action 不存在时抛出
 */
function execute(action, payload = {}) {
  ensureConfigured();
  const handler = ACTIONS[action];
  if (!handler) throw new ActionError(`Unknown action: ${action}`, 404, 'UNKNOWN_ACTION');
  return handler(payload || {});
}

module.exports = { configure, execute, ActionError, normalizeDate, normalizeTime, withStateLock };
