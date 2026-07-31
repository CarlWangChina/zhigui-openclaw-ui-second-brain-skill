/**
 * Shared application action layer.
 * Browser HTTP handlers and Electron IPC handlers both call this module.
 */
const crypto = require('crypto');
const Storage = require('./storage');
const { BrainIndex } = require('./brain-index');
const { todayStr } = require('./utils');
const ExecutionContext = require('./execution-context');
const {
  scrubDeletedNoteReferences,
  scrubDeletedGoalReferences,
  scrubDeletedDecisionReferences,
  scrubDeletedActionReferences,
  replaceActionReference,
  scrubDeletedTopicReferences,
} = require('./reference-integrity');
const DateUtils = require('./date-utils');

let dataDir = null;
let brainIndex = null;
// Actions are synchronous. This invocation-local actor lets the shared command
// layer distinguish a panel fact from an AI write even when the entity itself
// was originally created by AI.
let activeActor = 'user';
// Action handlers mutate a state snapshot under one transaction.  Activity
// events must be appended only after that snapshot is durably committed;
// otherwise writeState can overwrite a just-appended journal entry.
let postCommitOperations = null;
// A command may inspect state or settle an activity-journal record without
// changing canonical entities.  Persisting an unchanged snapshot still bumps
// stateVersion, which makes optimistic retries conflict with themselves.
const SKIP_STATE_WRITE = Symbol('skipStateWrite');

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

function noStateWrite(result) {
  return { ...(result || {}), [SKIP_STATE_WRITE]: true };
}

function goalStatusSignal(value) {
  return ['actionable', 'needs_confirmation', 'blocked', 'at_risk', 'on_track'].includes(value)
    ? value
    : null;
}

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
    const previousPostCommit = postCommitOperations;
    const deferred = [];
    postCommitOperations = deferred;
    try {
      const state = Storage.readFullState();
      const result = fn(state);  // fn can modify state
      if (!result || !result[SKIP_STATE_WRITE]) Storage.writeState(state);
      for (const operation of deferred) operation();
      return result;
    } finally {
      postCommitOperations = previousPostCommit;
    }
  });
}

function normalizeFollowUpDue(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new ActionError('followUp dueAt is required', 400, 'INVALID_FOLLOW_UP');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { dueAt: normalizeDate(raw, { optional: false }), dueDate: raw };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new ActionError('followUp dueAt must be YYYY-MM-DD or an ISO datetime', 400, 'INVALID_FOLLOW_UP');
  return { dueAt: parsed.toISOString(), dueDate: DateUtils.formatDate(parsed) };
}

function createFollowUpInState(state, rawFollowUp, { sourceEventId = null, sourceActionId = null } = {}) {
  if (!rawFollowUp) return { item: null, created: false };
  if (!['check_in', 'decision_required'].includes(rawFollowUp.mode) || !rawFollowUp.question) {
    throw new ActionError('followUp needs mode, dueAt and question', 400, 'INVALID_FOLLOW_UP');
  }
  const { dueAt, dueDate } = normalizeFollowUpDue(rawFollowUp.dueAt);
  state.followUps = Array.isArray(state.followUps) ? state.followUps : [];
  const dedupeActionId = rawFollowUp.sourceActionId || sourceActionId || null;
  const dedupeEventId = rawFollowUp.sourceEventId || sourceEventId || null;
  const existing = state.followUps.find(item => item.status === 'pending'
    && ((dedupeEventId && item.sourceEventId === dedupeEventId)
      || (dedupeActionId && item.sourceActionId === dedupeActionId
        && item.mode === rawFollowUp.mode && item.question === String(rawFollowUp.question).trim())));
  if (existing) return { item: existing, created: false };
  const item = {
    id: id('followup'), mode: rawFollowUp.mode, dueAt, dueDate,
    reason: String(rawFollowUp.reason || '').trim(), question: String(rawFollowUp.question).trim(),
    contextRefs: Array.isArray(rawFollowUp.contextRefs) ? rawFollowUp.contextRefs.slice(0, 12) : [],
    status: 'pending', sourceEventId: dedupeEventId, sourceActionId: dedupeActionId, createdAt: now(),
  };
  state.followUps.push(item);
  return { item, created: true };
}

// Apply the durable semantic consequence of a completed action in the same
// transaction as the fact itself. This gives panel and conversation-origin
// completions the same ability to update goals, notes, decisions and follow-ups.
function applySemanticImpact(state, payload = {}, { sourceEventId = null, sourceActionId = null } = {}) {
  const goalPatches = Array.isArray(payload.goalPatches) ? payload.goalPatches.slice(0, 10) : [];
  const notePatches = Array.isArray(payload.notePatches) ? payload.notePatches.slice(0, 10) : [];
  const decisionPatches = Array.isArray(payload.decisionPatches) ? payload.decisionPatches.slice(0, 10) : [];
  const decisionCreates = Array.isArray(payload.decisionCreates) ? payload.decisionCreates.slice(0, 3) : [];
  const allowedGoalFields = new Set(['statusSignal', 'statusReason', 'nextStep', 'obstacle', 'risk']);
  const allowedNoteFields = new Set(['content', 'relatedDate']);
  const changed = { goals: [], notes: [], decisions: [], followUp: null };

  for (const patch of goalPatches) {
    const goal = [...(state.strategicGoals || []), ...(state.currentGoals || []), ...(state.constraints || [])]
      .find(item => item.id === patch.id);
    if (!goal) throw new ActionError(`Goal not found: ${patch.id}`, 404, 'NOT_FOUND');
    for (const [key, value] of Object.entries(patch)) {
      if (key !== 'id' && allowedGoalFields.has(key)) goal[key] = value == null ? null : String(value).trim();
    }
    goal.updatedAt = now();
    changed.goals.push(goal.id);
  }
  for (const patch of notePatches) {
    const note = (state.notes || []).find(item => item.id === patch.id);
    if (!note) throw new ActionError(`Note not found: ${patch.id}`, 404, 'NOT_FOUND');
    for (const [key, value] of Object.entries(patch)) {
      if (key !== 'id' && allowedNoteFields.has(key)) note[key] = value == null ? null : String(value).trim();
    }
    note.updatedAt = now();
    changed.notes.push(note.id);
  }
  for (const patch of decisionPatches) {
    const decision = (state.decisions || []).find(item => item.id === patch.id);
    if (!decision) throw new ActionError(`Decision not found: ${patch.id}`, 404, 'NOT_FOUND');
    patchDecisionInState(state, decision, patch);
    changed.decisions.push(decision.id);
  }
  for (const create of decisionCreates) {
    const decision = createDecisionInState(state, { ...create, sourceEventId });
    changed.decisions.push(decision.id);
  }
  const followUp = createFollowUpInState(state, payload.followUp, { sourceEventId, sourceActionId });
  if (followUp.item) changed.followUp = followUp.item.id;
  return changed;
}

function afterCommit(operation) {
  if (postCommitOperations) postCommitOperations.push(operation);
  else operation();
}

/**
 * 限制 completedActions 上限：超过 200 条时，one-time 保留最近 50 条，
 * recurring 保留最近 90 天。供 toggleTask 和 completeErrand 共用。
 */
function pruneCompletedActions(state) {
  if (!state.completedActions || state.completedActions.length <= 200) return [];
  const beforeIds = new Set(state.completedActions.map(action => action.id));
  const oneTimeIndices = [];
  state.completedActions.forEach((a, i) => {
    if (a.pattern === 'one-time') oneTimeIndices.push(i);
  });
  if (oneTimeIndices.length > 50) {
    const toRemove = new Set(oneTimeIndices.slice(0, oneTimeIndices.length - 50));
    state.completedActions = state.completedActions.filter((_, i) => !toRemove.has(i));
  }
  const RECURRING_RETENTION_DAYS = 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECURRING_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString();
  state.completedActions = state.completedActions.filter(a => {
    if (a.pattern === 'one-time') return true; // already capped above
    // continuing / recurring actions are kept for 90 days only
    return (a.completedAt || '') >= cutoffStr;
  });
  const retainedIds = new Set(state.completedActions.map(action => action.id));
  const removedIds = [...beforeIds].filter(actionId => !retainedIds.has(actionId));
  for (const actionId of removedIds) scrubDeletedActionReferences(state, actionId);
  return removedIds;
}

/**
 * 记录活动日志到 activity 文档，携带实体 ID、状态版本、来源与关联实体引用，供下一次对话读取。
 * @param {string} operation - 操作名称
 * @param {string} kind - 实体种类
 * @param {Object} entity - 关联的实体对象
 * @param {*=} [detail=null] - 附加详情
 */
function audit(operation, kind, entity, detail = null) {
  // Activity is deliberately a compact journal. Entity documents remain the
  // source of truth; this only tells the next conversation what changed.
  const source = detail?.source || activeActor || entity?.source || 'user';
  const relatedGoalIds = [...new Set([
    entity?.goalId, entity?.relatedGoalId, entity?.relatedStrategicGoalId,
    ...(entity?.relatedGoalIds || []), ...(entity?.linkedGoalId ? [entity.linkedGoalId] : []),
  ].filter(Boolean))];
  const relatedNoteIds = [...new Set([
    ...(entity?.noteIds || []), ...(entity?.linkedNoteIds || []), ...(entity?.relatedNoteIds || []),
    ...(entity?.contextRefs || []).filter(ref => ref?.type === 'note').map(ref => ref.id),
  ].filter(Boolean))];
  const event = {
    operation, kind,
    entityId: entity?.id || entity?.taskId || entity?.topicId || null,
    title: entity?.title || null,
    source,
    relatedGoalIds,
    relatedNoteIds,
    relatedDecisionIds: [...new Set([...(entity?.decisionIds || []), ...(entity?.linkedDecisionIds || [])].filter(Boolean))],
    relatedActionIds: [...new Set([...(entity?.relatedActionIds || []), ...(entity?.linkedActionIds || [])].filter(Boolean))],
    relatedTopicIds: [...new Set([entity?.topicId, ...(entity?.topicIds || []), ...(entity?.linkedTopicIds || [])].filter(Boolean))],
    // `source` is retained for old data. `channel` and `actor` distinguish
    // panel facts from an AI-mediated conversation without relying on chat
    // history in a later thread.
    channel: detail?.channel || (source === 'ai' ? 'conversation' : 'panel'),
    actor: detail?.actor || (source === 'ai' ? 'assistant' : 'user'),
    meaning: detail?.meaning || (source === 'ai' ? 'interpretation' : 'fact'),
    reconciliationStatus: detail?.reconciliationStatus || (source === 'ai' ? 'applied' : 'pending'),
    detail: detail || null,
  };
  afterCommit(() => {
    try {
      event.stateVersion = Storage.readLightweightState()?.meta?.stateVersion || null;
      Storage.appendActivity(event);
    } catch {}
  });
}

function reconcileActivity(payload) {
  const eventId = requiredText(payload.eventId, 'eventId', 200);
  return withStateLock(state => {
    const currentVersion = Number(state.meta?.stateVersion || 0);
    if (payload.expectedStateVersion !== undefined && Number(payload.expectedStateVersion) !== currentVersion) {
      return noStateWrite({ success: false, conflict: true, currentStateVersion: currentVersion, message: 'State changed; refresh bootstrap and retry.' });
    }

    const event = Storage.findPendingActivity(eventId);
    if (!event) {
      return noStateWrite({ success: false, alreadyHandled: true, message: 'Activity is no longer pending.' });
    }

    const disposition = ['applied', 'dismissed', 'needs_user'].includes(payload.disposition) ? payload.disposition : 'applied';
    const changed = applySemanticImpact(state, payload, {
      sourceEventId: eventId,
      sourceActionId: event.entityId || null,
    });
    const hasCanonicalChange = changed.goals.length || changed.notes.length || changed.decisions.length || changed.followUp;
    if (hasCanonicalChange) {
      state.meta = state.meta || {};
      state.meta.lastUpdated = now();
    }
    // Activity is a separate journal. Mark it only after the canonical state
    // write succeeds; otherwise a crash could hide a panel change that was
    // never actually reconciled.
    afterCommit(() => Storage.reconcileActivityEvent(eventId, {
      reconciliationStatus: disposition,
      reconciliation: {
        sourceStateVersion: currentVersion,
        changed,
        note: String(payload.note || '').trim().slice(0, 500),
      },
    }));
    const result = { success: true, eventId, disposition, changed, stateVersion: hasCanonicalChange ? currentVersion + 1 : currentVersion };
    return hasCanonicalChange ? result : noStateWrite(result);
  });
}

function resolveFollowUp(payload) {
  const followUpId = requiredText(payload.followUpId, 'followUpId', 200);
  const status = ['resolved', 'dismissed'].includes(payload.status) ? payload.status : 'resolved';
  return withStateLock(state => {
    const item = (state.followUps || []).find(followUp => followUp.id === followUpId);
    if (!item) throw new ActionError('Follow-up not found', 404, 'NOT_FOUND');
    if (item.status !== 'pending') return noStateWrite({ success: true, alreadyHandled: true, followUp: item });
    if (payload.deferUntil) {
      const normalized = normalizeFollowUpDue(payload.deferUntil);
      item.dueAt = normalized.dueAt;
      item.dueDate = normalized.dueDate;
      item.deferredAt = now();
      item.deferReason = String(payload.note || '').trim().slice(0, 500);
      audit('defer', 'followup', item);
    } else {
      item.status = status;
      item.resolvedAt = now();
      item.resolutionNote = String(payload.note || '').trim().slice(0, 500);
      audit(status, 'followup', item);
    }
    item.updatedAt = now();
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    return { success: true, followUp: item };
  });
}

function importNotes(payload) {
  const items = Array.isArray(payload.notes) ? payload.notes : (payload.content ? [payload] : []);
  if (!items.length) throw new ActionError('notes must contain at least one note', 400, 'INVALID_IMPORT');
  if (items.length > 100) throw new ActionError('A single import is limited to 100 notes', 400, 'IMPORT_TOO_LARGE');
  const notes = items.map(item => addNote({
    ...item,
    content: item?.content,
    source: item?.source || 'Imported',
  }).note);
  return { success: true, imported: notes.length, notes };
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
function setTaskCompletionInState(state, task, date, completed, payload = {}) {
  if (task.completed === completed) return { changed: false, completedAction: null };
  task.completed = completed;
  task.completedAt = completed ? now() : null;
  // Completion is always a user fact. `completedVia` records whether it was
  // clicked in the panel or asserted through an assistant conversation.
  task.completedBy = completed ? 'user' : null;
  task.completedVia = completed ? (payload.source === 'ai' ? 'conversation' : 'panel') : null;
  let completedAction = null;
  if (completed && task.relatedGoalId) {
    const goal = (state.currentGoals || []).find(g => g.id === task.relatedGoalId);
    if (goal?.isOneShot === true) {
      goal.completed = true;
      goal.completedAt = now();
      goal.completedDate = now().slice(0, 10);
      if (state.schedule && state.schedule.days) {
        for (const [dayDate, dayData] of Object.entries(state.schedule.days)) {
          if (dayDate > date && dayData.tasks) {
            dayData.tasks = dayData.tasks.filter(t => !(t.relatedGoalId === task.relatedGoalId && !t.completed));
          }
        }
      }
    }
  }
  state.completedActions = state.completedActions || [];
  if (completed && !state.completedActions.some(action => action.taskId === task.id)) {
    const linkedGoal = (state.currentGoals || []).find(goal => goal.id === task.relatedGoalId);
    completedAction = {
      id: id('ca'), taskId: task.id, scheduleDate: date, title: task.title,
      pattern: linkedGoal?.isOneShot || task.pattern === 'one-time' ? 'one-time' : (task.pattern || 'continuing'),
      category: task.category || 'misc', completedAt: task.completedAt, outcome: 'done', summary: '',
      linkedTopicId: task.topicId || null, linkedNoteIds: task.noteIds || [], linkedDecisionIds: task.decisionIds || [], linkedGoalId: task.relatedGoalId || null,
      contextRefs: task.contextRefs || [], contextReason: task.contextReason || '', placementReason: task.placementReason || '',
      noteCleanupHint: linkedGoal?.isOneShot || task.pattern === 'one-time' ? 'review' : 'keep',
      // Save full snapshot for undo (P2-2.9)
      errandSnapshot: { commitmentLevel: task.commitmentLevel, date, time: task.time, duration: task.duration, note: task.note, recurrence: task.recurrence },
    };
    state.completedActions.push(completedAction);
    pruneCompletedActions(state);
  } else if (!completed) {
    state.completedActions = state.completedActions.filter(action => action.taskId !== task.id);
  }
  return { changed: true, completedAction };
}

function toggleTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  return withStateLock(state => {
    const task = findTask(state, date, payload.taskId);
    const completed = typeof payload.completed === 'boolean' ? payload.completed : !task.completed;
    const transition = setTaskCompletionInState(state, task, date, completed, payload);
    const impact = completed ? applySemanticImpact(state, payload.completionImpact || {}, {
      sourceActionId: transition.completedAction?.id || task.id,
    }) : { goals: [], notes: [], decisions: [], followUp: null };
    if (!transition.changed && !impact.goals.length && !impact.notes.length && !impact.decisions.length && !impact.followUp) {
      return noStateWrite({ success: true, alreadyHandled: true, completed: task.completed, task, impact });
    }
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit(completed ? 'complete' : 'reopen', 'task', task, { date, source: payload.source || 'user', completionImpact: impact });
    return { success: true, completed: task.completed, task, completedAction: transition.completedAction, impact };
  });
}

function completeTask(payload) {
  return toggleTask({ ...payload, completed: true });
}

/**
 * 更新任务的时间和时长，并标记为手动锁定
 * @param {{ date: string, taskId: string, time?: string, duration?: number }} payload - 日期、任务 ID 及要更新的字段
 * @returns {{ success: boolean, task: Object }} 操作结果及更新后的任务对象
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function updateTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  return withStateLock(state => {
    const task = findTask(state, date, payload.taskId);
    if (payload.time !== undefined) task.time = normalizeTime(payload.time);
    if (payload.duration !== undefined) task.duration = durationValue(payload.duration, task.duration || 60);
    if (payload.title !== undefined) task.title = requiredText(payload.title, 'Title', 200);
    if (payload.description !== undefined) task.description = String(payload.description || '').trim();
    if (payload.category !== undefined) task.category = String(payload.category || 'event');
    ExecutionContext.applyExecutionContext(task, payload);
    const contextCheck = ExecutionContext.validateContext(state, task);
    if (!contextCheck.valid) throw new ActionError(`Missing execution context: ${contextCheck.missing.map(ref => ref.id).join(', ')}`, 400, 'INVALID_CONTEXT');
    task.manualLocked = true;
    task.manualLockedAt = now();
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', 'task', task, { date, fields: ['time', 'duration'] });
    return { success: true, task };
  });
}

/**
 * 删除指定日期的任务并清理索引
 * @param {{ date: string, taskId: string }} payload - 日期和任务 ID
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除标题
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function deleteTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  return withStateLock(state => {
    const day = state.schedule?.days?.[date];
    if (!day) throw new ActionError('Date not found', 404, 'NOT_FOUND');
    const index = (day.tasks || []).findIndex(task => task.id === payload.taskId);
    if (index < 0) throw new ActionError('Task not found', 404, 'NOT_FOUND');
    const [task] = day.tasks.splice(index, 1);
    // A task can have been associated with a topic after an AI review. Remove that
    // reference too, so the lightweight index never exposes a deleted action.
    try { brainIndex.unlinkEntityCascade('tasks', task.id); } catch {}
    const cleaned = scrubDeletedActionReferences(state, task.id);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('delete', 'task', task, { date });
    return { success: true, deleted: task.title, cleaned };
  });
}

/**
 * 解锁任务，允许系统重新调度时间和优先级
 * @param {{ date: string, taskId: string }} payload - 日期和任务 ID
 * @returns {{ success: boolean, task: Object }} 操作结果及更新后的任务对象
 * @throws {ActionError} 日期或任务不存在时抛出
 */
function unlockTask(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  return withStateLock(state => {
    const task = findTask(state, date, payload.taskId);
    task.manualLocked = false;
    delete task.manualLockedAt;
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('release-preference', 'task', task, { date });
    return { success: true, task };
  });
}

/**
 * 在全局状态中查找优先级目标实体（任务或目标）
 * @param {Object} state - 完整应用状态
 * @param {string} type - 实体类型（task/strategicGoal/currentGoal/constraint）
 * @param {string} targetId - 实体 ID
 * @returns {Object|null} 找到的实体对象，未找到返回 null
 */
/**
 * 更新实体优先级并锁定为用户手动设置
 * @throws {ActionError} 目标不存在时抛出
 */
/**
 * 解锁实体优先级，允许系统重新计算
 * @param {{ type: string, id: string }} payload - 实体类型及 ID
 * @returns {{ success: boolean, locked: boolean }} 操作结果
 * @throws {ActionError} 目标不存在时抛出
 */
/**
 * 新增日程事件任务
 * @param {{ date: string, time: string, title: string, description?: string, duration?: number, category?: string, retention?: string }} payload - 事件内容与元数据
 * @returns {{ success: boolean, task: Object }} 操作结果及创建的任务对象
 * @throws {ActionError} 日期、时间或标题无效时抛出
 */
function addEvent(payload) {
  const date = normalizeDate(payload.date, { optional: false });
  const time = normalizeTime(payload.time, { optional: false });
  const title = requiredText(payload.title, 'Title', 200);
  return withStateLock(state => {
    state.schedule = state.schedule || { days: {} };
    state.schedule.days = state.schedule.days || {};
    if (!state.schedule.days[date]) state.schedule.days[date] = { date, tasks: [], errands: [], dayNotes: [] };
    const task = {
      id: id('task'), date, time, duration: durationValue(payload.duration, 60), title,
      description: String(payload.description || '').trim(),
      completed: false, source: payload.source || 'manual', category: payload.category || 'event',
      retention: retentionLevel(payload.retention, 'review'),
      manualLocked: payload.manualLocked ?? payload.source !== 'ai', manualLockedAt: now(), createdAt: now(), pattern: payload.pattern || 'one-time',
      // Calendar events are date commitments by default. Work items can opt
      // into carry-forward; missed fixed commitments stay in their history.
      carryPolicy: ['auto', 'never'].includes(payload.carryPolicy)
        ? payload.carryPolicy
        : (['meeting', 'event', 'travel'].includes(payload.category || 'event') ? 'never' : 'auto'),
      fixedDate: payload.fixedDate === true,
      preparationLeadDays: Math.max(0, Math.min(Number(payload.preparationLeadDays) || 0, 365)),
    };
    ExecutionContext.applyExecutionContext(task, payload);
    const contextCheck = ExecutionContext.validateContext(state, task);
    if (!contextCheck.valid) throw new ActionError(`Missing execution context: ${contextCheck.missing.map(ref => ref.id).join(', ')}`, 400, 'INVALID_CONTEXT');
    state.schedule.days[date].tasks = state.schedule.days[date].tasks || [];
    state.schedule.days[date].tasks.push(task);
    state.schedule.days[date].tasks.sort((a, b) => (a.time || '').localeCompare((b.time || '')));
    // Link task to brain-index topic hub if topicId is present
    if (task.topicId) {
      try {
        brainIndex.linkEntity(task.topicId, 'actionItems', task.id);
        if (task.noteIds && task.noteIds.length > 0) {
          for (const nid of task.noteIds) {
            brainIndex.linkEntity(task.topicId, 'notes', nid);
          }
        }
      } catch {}
    }
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('create', 'task', task, { date });
    return { success: true, task };
  });
}

/**
 * 新增战略目标、当前目标或约束
 * @param {{ type: string, title: string, description?: string }} payload - 目标类型及内容
 * @returns {{ success: boolean, goal: Object }} 操作结果及创建的目标对象
 * @throws {ActionError} 类型未知时抛出
 */
function addGoal(payload) {
  const typeMap = { strategicGoal: ['strategicGoals', 'strategic'], currentGoal: ['currentGoals', 'current'], constraint: ['constraints', 'constraint'] };
  const mapping = typeMap[payload.type];
  if (!mapping) throw new ActionError('Unknown goal type');
  const title = requiredText(payload.title, 'Title', 240);
  return withStateLock(state => {
    const goal = {
      id: id(mapping[1] === 'constraint' ? 'constraint' : 'goal'), type: mapping[1], title,
      description: String(payload.description || '').trim(),
      completed: false, source: payload.source || 'manual', createdAt: now(), updatedAt: now(),
      // Phase 2: Enhanced goal fields
      why: payload.why || null,
      obstacle: payload.obstacle || null,
      risk: payload.risk || null,
      statusSignal: goalStatusSignal(payload.statusSignal),
      statusReason: String(payload.statusReason || '').trim() || null,
      successCriteria: payload.successCriteria || null,
      nextStep: payload.nextStep || null,
    };
    if (payload.domain) goal.domain = String(payload.domain).trim();
    if (payload.isOneShot !== undefined) goal.isOneShot = payload.isOneShot === true;
    if (payload.relatedStrategicGoalId) goal.relatedStrategicGoalId = payload.relatedStrategicGoalId;
    // Bind noteIds if provided — "this goal was built from these notes".
    // Only keep ids that resolve to a real note so a goal can never be born
    // with a dangling reference. Same contract as errand.noteIds.
    if (Array.isArray(payload.noteIds)) {
      const knownNoteIds = new Set((state.notes || []).map(n => n.id));
      goal.noteIds = payload.noteIds.filter(nid => typeof nid === 'string' && nid && knownNoteIds.has(nid));
    }
    if (Array.isArray(payload.rules)) goal.rules = payload.rules;
    if (Array.isArray(payload.subTasks) && payload.type === 'strategicGoal') goal.subTasks = payload.subTasks;
    if (payload.type === 'currentGoal') {
      goal.detail = String(payload.detail || '').trim();
      if (payload.deadline) {
        goal.deadline = normalizeDate(payload.deadline, { optional: false });
        goal.daysLeft = DateUtils.daysBetween(goal.deadline);
        goal.overdue = goal.daysLeft < 0;
        goal.lastRecalculated = now();
      }
    }
    state[mapping[0]] = state[mapping[0]] || [];
    state[mapping[0]].push(goal);
    // Topic association: topicId = reuse existing, topic = create new.
    try {
      let topicId = null;
      if (payload.topicId && brainIndex._readIndex().topics[payload.topicId]) {
        topicId = payload.topicId;
      } else if (payload.topic && typeof payload.topic === 'string') {
        topicId = brainIndex.ensureTopic(payload.topic, { domain: payload.domain || 'misc', category: payload.category });
      }
      if (topicId) {
        brainIndex.linkEntity(topicId, 'goals', goal.id);
        goal.topicId = topicId;
        afterCommit(() => { try { brainIndex.reindexTopic(topicId); } catch {} });
      }
    } catch {}
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('create', mapping[1], goal);
    return { success: true, goal };
  });
}

/**
 * 完成或重新打开目标（支持 currentGoal 与 strategicGoal）
 * @param {{ id: string, completed: boolean }} payload - 目标 ID 及目标完成状态
 * @returns {{ success: boolean, completed: boolean, goal: Object, type: string }} 操作结果及更新后的目标对象
 * @throws {ActionError} 目标不存在时抛出
 */
function completeGoal(payload) {
  return withStateLock(state => {
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
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit(goal.completed ? 'complete' : 'reopen', type === 'strategicGoal' ? 'strategicGoal' : 'goal', goal);
    return { success: true, completed: goal.completed, goal, type };
  });
}

/**
 * 删除目标并清理关联任务及索引
 * @param {{ type: string, id: string }} payload - 目标类型（strategicGoal/currentGoal/constraint）及 ID
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除标题
 * @throws {ActionError} 类型无效或目标不存在时抛出
 */
function deleteGoal(payload) {
  const map = { strategicGoal: 'strategicGoals', currentGoal: 'currentGoals', constraint: 'constraints' };
  return withStateLock(state => {
    const list = state[map[payload.type]];
    if (!Array.isArray(list)) throw new ActionError('Invalid goal type');
    const index = list.findIndex(g => g.id === payload.id);
    if (index < 0) throw new ActionError('Goal not found', 404, 'NOT_FOUND');
    const [goal] = list.splice(index, 1);
    const removedTaskIds = [];
    for (const day of Object.values(state.schedule?.days || {})) {
      const before = day.tasks || [];
      const after = before.filter(task => {
        if (task.relatedGoalId === payload.id || task.relatedStrategicGoalId === payload.id) {
          removedTaskIds.push(task.id);
          return false;
        }
        return true;
      });
      day.tasks = after;
    }
    const cleaned = scrubDeletedGoalReferences(state, payload.id);
    try { brainIndex.unlinkEntityCascade('goals', payload.id); } catch {}
    for (const taskId of removedTaskIds) {
      try { brainIndex.unlinkEntityCascade('tasks', taskId); } catch {}
    }
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('delete', payload.type, goal);
    return { success: true, deleted: goal.title, cleaned };
  });
}

function updateGoal(payload) {
  const typeMap = { strategicGoal: 'strategicGoals', currentGoal: 'currentGoals', constraint: 'constraints' };
  const listKey = typeMap[payload.type];
  if (!listKey) throw new ActionError('Unknown goal type', 400, 'INVALID_GOAL_TYPE');
  return withStateLock(state => {
    const goal = (state[listKey] || []).find(item => item.id === payload.id);
    if (!goal) throw new ActionError('Goal not found', 404, 'NOT_FOUND');
    const textFields = ['title', 'description', 'detail', 'why', 'obstacle', 'risk', 'statusReason', 'successCriteria', 'nextStep'];
    for (const key of textFields) {
      if (payload[key] !== undefined) goal[key] = String(payload[key]).trim() || null;
    }
    if (payload.deadline !== undefined) {
      if (payload.deadline) {
        goal.deadline = normalizeDate(payload.deadline, { optional: false });
        goal.daysLeft = DateUtils.daysBetween(goal.deadline);
        goal.overdue = goal.daysLeft < 0;
      } else {
        delete goal.deadline;
        goal.daysLeft = null;
        goal.overdue = false;
      }
      goal.lastRecalculated = now();
    }
    if (payload.completed !== undefined) {
      goal.completed = payload.completed === true;
      goal.completedAt = goal.completed ? now() : null;
    }
    if (payload.subTasks !== undefined) goal.subTasks = Array.isArray(payload.subTasks) ? payload.subTasks : [];
    if (payload.statusSignal !== undefined) goal.statusSignal = goalStatusSignal(payload.statusSignal);
    if (payload.noteIds !== undefined) {
      // Replace semantics, mirroring errand.update: pass the full set of note
      // links each time. Unknown ids are dropped to keep references honest.
      const knownNoteIds = new Set((state.notes || []).map(n => n.id));
      goal.noteIds = (Array.isArray(payload.noteIds) ? payload.noteIds : [])
        .filter(nid => typeof nid === 'string' && nid && knownNoteIds.has(nid));
    }
    goal.updatedAt = now();
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', payload.type, goal, { source: payload.source || 'user' });
    return { success: true, goal };
  });
}

function removeRecurringPreviews(state, templateId) {
  let count = 0;
  for (const day of Object.values(state.schedule?.days || {})) {
    if (!Array.isArray(day?.tasks)) continue;
    const before = day.tasks.length;
    day.tasks = day.tasks.filter(task => task.recurringTemplateId !== templateId);
    count += before - day.tasks.length;
  }
  return count;
}

// Calendar previews are derived views of a recurring errand, not independent
// commitments. Rebuild them from one durable template so editing/completing or
// deleting the template cannot leave ghost entries behind.
function syncRecurringPreviews(state, errand, previewDays = 30) {
  if (errand?.pattern !== 'recurring') return { removed: 0, created: 0 };
  const removed = removeRecurringPreviews(state, errand.id);
  const intervalDays = Math.max(1, Number(errand.recurrence?.intervalDays) || 7);
  const startDate = errand.date || todayStr();
  const endDate = DateUtils.nextDay(todayStr(), Math.max(1, Math.min(Number(previewDays) || 30, 90)) - 1);
  let currentDate = startDate;
  // Align a stale template date to its first valid future occurrence without
  // changing the weekday/rhythm of the series.
  while (currentDate < todayStr()) currentDate = DateUtils.nextDay(currentDate, intervalDays);
  let created = 0;
  state.schedule = state.schedule || {};
  state.schedule.days = state.schedule.days || {};
  while (currentDate <= endDate) {
    const day = state.schedule.days[currentDate] ||= { date: currentDate, tasks: [] };
    day.tasks = day.tasks || [];
    day.tasks.push({
      id: id('t'), date: currentDate, title: errand.title, source: 'recurring',
      recurringTemplateId: errand.id, completed: false, scheduled: true,
      time: errand.time || null, duration: errand.duration || 60,
      commitmentLevel: errand.commitmentLevel || 'should', category: errand.category || 'misc',
      note: errand.note || '', topicId: errand.topicId || null, noteIds: errand.noteIds || [],
      decisionIds: errand.decisionIds || [], relatedGoalId: errand.goalId || errand.relatedGoalId || null,
      contextRefs: errand.contextRefs || [], contextReason: errand.contextReason || '',
    });
    created++;
    currentDate = DateUtils.nextDay(currentDate, intervalDays);
  }
  return { removed, created };
}

/**
 * 新增一条待办事项
 * @param {{ title: string, date?: string, time?: string, duration?: number, commitmentLevel?: string, category?: string, note?: string, retention?: string }} payload - 待办内容与元数据
 * @returns {{ success: boolean, errand: Object }} 操作结果及创建的待办对象
 */
function addErrand(payload) {
  const title = requiredText(payload.title, 'Title', 240);
  const date = payload.date ? normalizeDate(payload.date, { optional: false }) : null;
  const commitmentLevel = ['must', 'should', 'nice'].includes(payload.commitmentLevel) ? payload.commitmentLevel : 'should';
  const pattern = ['one-time', 'recurring'].includes(payload.pattern) ? payload.pattern : 'one-time';
  return withStateLock(state => {
    const errand = {
      id: id('errand'), title, date, time: normalizeTime(payload.time),
      duration: durationValue(payload.duration, 60), commitmentLevel,
      category: payload.category || 'misc', note: String(payload.note || '').trim(),
      retention: retentionLevel(payload.retention),
      completed: false, source: 'manual', createdAt: now(),
      // 关联字段：AI 创建行程时前置绑定笔记/目标/topic
      pattern,
      topicId: payload.topicId || null,
      goalId: payload.goalId || null,
      preparationLeadDays: Math.max(0, Math.min(Number(payload.preparationLeadDays) || 0, 365)),
      recurrence: pattern === 'recurring' ? { intervalDays: Math.max(1, Math.min(Number(payload.recurrence?.intervalDays) || 7, 365)) } : null,
    };
    ExecutionContext.applyExecutionContext(errand, { ...payload, relatedGoalId: payload.goalId, goalId: payload.goalId });
    errand.goalId = errand.relatedGoalId || null;
    // Bind noteIds if provided — establishes errand→note edges in the
    // relationship graph at creation time, not just on completion.
    if (Array.isArray(payload.noteIds)) {
      errand.noteIds = payload.noteIds.filter(nid => typeof nid === 'string' && nid);
    }
    const contextCheck = ExecutionContext.validateContext(state, errand);
    if (!contextCheck.valid) throw new ActionError(`Missing execution context: ${contextCheck.missing.map(ref => ref.id).join(', ')}`, 400, 'INVALID_CONTEXT');
    state.errands = state.errands || [];
    state.errands.push(errand);
    // 若指定了 topicId，将 errand 挂到 brain-index 的 topic hub
    if (errand.topicId) {
      try { brainIndex.linkEntity(errand.topicId, 'actionItems', errand.id); } catch {}
    }
    // 若指定了 noteIds，将每条笔记关联到 errand 的 topic（如果 topicId 存在）
    if (errand.noteIds && errand.noteIds.length > 0 && errand.topicId) {
      try {
        for (const nid of errand.noteIds) {
          brainIndex.linkEntity(errand.topicId, 'notes', nid);
        }
      } catch {}
    }
    const preview = syncRecurringPreviews(state, errand, payload.previewDays);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('create', 'errand', errand, { date, previewCount: preview.created });
    return { success: true, errand, previewCount: preview.created };
  });
}

/**
 * 完成待办事项：移入 completedActions 行动日志，从活跃 errands 中移除
 * @param {{ id: string, outcome?: string, summary?: string }} payload - 包含待办 ID 的参数
 * @returns {{ success: boolean, completed: boolean, discarded: boolean, errand: Object, action: Object }} 操作结果
 * @throws {ActionError} 待办不存在或已完成时抛出
 */
function completeErrand(payload) {
  return withStateLock(state => {
    const index = (state.errands || []).findIndex(e => e.id === payload.id);
    const errand = state.errands?.[index];
    if (!errand) throw new ActionError('Errand not found', 404, 'NOT_FOUND');
    if (errand.completed) throw new ActionError('Errand already completed', 400, 'ALREADY_DONE');

    // 从活跃 errands 中移除
    state.errands.splice(index, 1);
    // 从 brain-index 中解除关联
    try { brainIndex.unlinkEntityCascade('errands', errand.id); } catch {}

    // 构建行动日志记录
    const pattern = errand.pattern || 'one-time';
    const action = {
      id: id('ca'),
      errandId: errand.id,
      scheduleDate: errand.date || null,  // P0-2: record which date this errand belonged to
      title: errand.title,
      pattern,
      category: errand.category || 'misc',
      completedAt: now(),
      outcome: payload.outcome || 'done',
      summary: String(payload.summary || '').trim() || '',
      linkedTopicId: errand.topicId || null,
      linkedNoteIds: errand.noteIds || [],
      linkedDecisionIds: errand.decisionIds || [],
      linkedGoalId: errand.goalId || null,
      contextRefs: errand.contextRefs || [],
      contextReason: errand.contextReason || '',
      placementReason: errand.placementReason || '',
      errandSnapshot: {
        commitmentLevel: errand.commitmentLevel, date: errand.date, time: errand.time,
        duration: errand.duration, note: errand.note, recurrence: errand.recurrence,
      },
      // 生命周期提示：one-time 行程建议删除关联笔记，recurring 保留
      noteCleanupHint: pattern === 'one-time' ? 'review' : 'keep',
    };

    // 写入 completedActions 数组
    state.completedActions = state.completedActions || [];
    state.completedActions.push(action);
    pruneCompletedActions(state);
    const relinked = replaceActionReference(state, errand.id, action.id);
    const impact = applySemanticImpact(state, payload.completionImpact || {}, { sourceActionId: action.id });

    let nextOccurrence = null;
    if (pattern === 'recurring') {
      const intervalDays = Math.max(1, Number(errand.recurrence?.intervalDays) || 7);
      // Use DateUtils.nextDay for timezone-safe date arithmetic (consistent
      // with addErrand and rollForwardRecurringTasks). Avoids new Date()+setDate
      // which can shift a day in DST timezones.
      const nextDate = DateUtils.nextDay(errand.date || todayStr(), intervalDays);
      // Keep the template identity stable: previews and references point to the
      // recurring series, rather than to one disposable occurrence.
      nextOccurrence = { ...errand, date: nextDate, completed: false, createdAt: errand.createdAt || now(), updatedAt: now(), previousOccurrenceId: errand.id };
      state.errands.push(nextOccurrence);
      try { if (nextOccurrence.topicId) brainIndex.linkEntity(nextOccurrence.topicId, 'actionItems', nextOccurrence.id); } catch {}
      syncRecurringPreviews(state, nextOccurrence);
    }
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('complete', 'errand', errand, { actionId: action.id, nextOccurrenceId: nextOccurrence?.id || null, source: payload.source || 'user', completionImpact: impact });
    return { success: true, completed: true, discarded: false, errand, action, nextOccurrence, relinked, impact };
  });
}

/**
 * 更新待办事项的日期、时间、时长或保留级别
 * @param {{ id: string, date?: string, time?: string, duration?: number, retention?: string }} payload - 待办 ID 及要更新的字段
 * @returns {{ success: boolean, errand: Object }} 操作结果及更新后的待办对象
 * @throws {ActionError} 待办不存在或字段无效时抛出
 */
function updateErrand(payload) {
  return withStateLock(state => {
    const errand = (state.errands || []).find(e => e.id === payload.id);
    if (!errand) throw new ActionError('Action not found', 404, 'NOT_FOUND');
    if (payload.title !== undefined) errand.title = requiredText(payload.title, 'Title', 240);
    if (payload.commitmentLevel !== undefined && ['must', 'should', 'nice'].includes(payload.commitmentLevel)) {
      errand.commitmentLevel = payload.commitmentLevel;
    }
    if (payload.date !== undefined) errand.date = payload.date ? normalizeDate(payload.date, { optional: false }) : null;
    if (payload.time !== undefined) errand.time = normalizeTime(payload.time);
    if (payload.duration !== undefined) errand.duration = durationValue(payload.duration, errand.duration || 60);
    if (payload.retention !== undefined) errand.retention = retentionLevel(payload.retention);
    ExecutionContext.applyExecutionContext(errand, { ...payload, goalId: payload.goalId ?? payload.relatedGoalId });
    errand.goalId = errand.relatedGoalId || null;
    const contextCheck = ExecutionContext.validateContext(state, errand);
    if (!contextCheck.valid) throw new ActionError(`Missing execution context: ${contextCheck.missing.map(ref => ref.id).join(', ')}`, 400, 'INVALID_CONTEXT');
    errand.manualLocked = true;
    errand.manualLockedAt = now();
    errand.updatedAt = now();
    if (errand.pattern === 'recurring') syncRecurringPreviews(state, errand, payload.previewDays);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', 'errand', errand, { fields: ['date', 'time', 'duration'] });
    return { success: true, errand };
  });
}

/**
 * 删除指定待办事项并清理索引
 * @param {{ id: string }} payload - 包含待办 ID 的参数
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除标题
 * @throws {ActionError} 待办不存在时抛出
 */
function deleteErrand(payload) {
  return withStateLock(state => {
    const index = (state.errands || []).findIndex(e => e.id === payload.id);
    if (index < 0) throw new ActionError('Errand not found', 404, 'NOT_FOUND');
    const [errand] = state.errands.splice(index, 1);
    const removedPreviews = removeRecurringPreviews(state, errand.id);
    try { brainIndex.unlinkEntityCascade('errands', payload.id); } catch {}
    const cleaned = scrubDeletedActionReferences(state, errand.id);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('delete', 'errand', errand);
    return { success: true, deleted: errand.title, removedPreviews, cleaned };
  });
}

/**
 * 撤销已完成行程：从 completedActions 移回 errands
 * @param {{ actionId: string }} payload - completedActions 中的 action ID
 * @returns {{ success: boolean, errand: Object }} 操作结果
 * @throws {ActionError} action 不存在时抛出
 */
function undoCompleteErrand(payload) {
  return withStateLock(state => {
    const caIndex = (state.completedActions || []).findIndex(a => a.id === payload.actionId);
    if (caIndex < 0) throw new ActionError('Completed action not found', 404, 'NOT_FOUND');

    const action = state.completedActions[caIndex];

    // 从 completedActions 中移除
    state.completedActions.splice(caIndex, 1);

    // 恢复为 errand，优先用 errandSnapshot 恢复原始属性（P2-2.9 修复）
    const snap = action.errandSnapshot || {};
    const errand = {
      id: action.errandId || id('errand'),
      title: action.title,
      pattern: action.pattern || 'one-time',
      category: action.category || 'misc',
      commitmentLevel: snap.commitmentLevel || 'should',
      date: snap.date || action.scheduleDate || todayStr(),
      time: snap.time || '',
      duration: snap.duration || 60,
      note: snap.note || '',
      recurrence: snap.recurrence || null,
      completed: false,
      noteIds: action.linkedNoteIds || [],
      decisionIds: action.linkedDecisionIds || [],
      contextRefs: action.contextRefs || [],
      contextReason: action.contextReason || '',
      placementReason: action.placementReason || '',
      topicId: action.linkedTopicId || null,
      goalId: action.linkedGoalId || null,
      relatedGoalId: action.linkedGoalId || null,
      createdAt: now(),
      updatedAt: now(),
    };

    state.errands = state.errands || [];
    state.errands.push(errand);

    // 恢复 recurring 预览任务
    if (errand.pattern === 'recurring') {
      syncRecurringPreviews(state, errand);
    }

    // 恢复 brain-index 关联
    try {
      if (errand.topicId) brainIndex.linkEntity(errand.topicId, 'errands', errand.id);
    } catch {}

    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('undo', 'errand', errand, { actionId: action.id });
    return { success: true, errand };
  });
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
  return withStateLock(state => {
    let topicId = null;
    let domain = payload.domain || 'misc';
    // topicId = reuse existing topic; topic = create new topic.
    if (payload.topicId) {
      try {
        const existing = brainIndex._readIndex().topics[payload.topicId];
        if (existing) {
          topicId = payload.topicId;
          domain = existing.domain || domain;
        }
      } catch {}
    } else if (topicName) {
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
      signal: payload.signal || null,
      importMetadata: payload.importMetadata && typeof payload.importMetadata === 'object'
        ? { ...payload.importMetadata }
        : null,
      needsEnrichment: !suppliedTitle || !topicId,
      organizationStatus: (!suppliedTitle || !topicId) ? 'pending' : 'confirmed',
      createdAt: now(),
      updatedAt: now(),
    };
    state.notes = Array.isArray(state.notes) ? state.notes : [];
    state.notes.push(note);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    if (topicId) {
      try { brainIndex.linkEntity(topicId, 'notes', note.id); } catch (e) { require('./logger').error('brain-index', 'link failed for topic', { tid: topicId, error: e.message }); }
      // 持久化铁律：state 落盘后再 reindex（reindexTopic 读磁盘 notes.json），与 addGoal/enrichNote 对齐
      afterCommit(() => { try { brainIndex.reindexTopic(topicId); } catch (e) { require('./logger').error('brain-index', 'reindex failed for topic', { tid: topicId, error: e.message }); } });
    }
    audit('create', 'note', note);
    return { success: true, note };
  });
}

/**
 * 拆分主题为多个更小的主题（对话内确认后直接执行）
 * AI 必须先在对话中向用户展示完整拆分方案并获得明确同意，再调用本函数。
 * @param {{ sourceTopicId: string, noteMoves: Array<{ noteId: string, targetTopicLabel: string }>, newTopics: Array<{ label: string, category: string, domain?: string }>, reason?: string }} payload - 拆分方案
 * @returns {{ success: boolean, sourceTopicId: string, movedNotes: number, newTopics: Array }} 执行结果
 */
function splitTopic(payload) {
  return withStateLock(state => {
    const idx = brainIndex._readIndex();
    const sourceTopic = idx.topics[payload.sourceTopicId];
    if (!sourceTopic) throw new ActionError('Source topic not found', 404, 'NOT_FOUND');

    const newTopics = Array.isArray(payload.newTopics) ? payload.newTopics : [];
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

    let moved = 0;
    for (const move of noteMoves) {
      if (!move.targetTopicId) continue;
      const note = (state.notes || []).find(n => n.id === move.noteId);
      if (!note) continue;
      try { brainIndex.unlinkEntityCascade('notes', note.id); } catch {}
      note.topicId = move.targetTopicId;
      try { brainIndex.linkEntity(move.targetTopicId, 'notes', note.id); } catch {}
      moved++;
    }

    // 持久化铁律：state 落盘后再 reindex（reindexTopic 读磁盘上的 notes.json）。
    const reindexIds = [payload.sourceTopicId, ...new Set(noteMoves.map(m => m.targetTopicId).filter(Boolean))];
    afterCommit(() => {
      for (const tid of reindexIds) {
        try { brainIndex.reindexTopic(tid); } catch (error) {
          require('./logger').error('brain-index', 'reindex failed after topic split', { tid, error: error.message });
        }
      }
    });

    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('topic-split', 'topic', { id: payload.sourceTopicId, title: sourceTopic.label }, {
      movedNotes: moved,
      newTopics: newTopics.map(t => t.label),
      reason: String(payload.reason || '').trim().slice(0, 600),
    });
    return {
      success: true,
      sourceTopicId: payload.sourceTopicId,
      movedNotes: moved,
      newTopics: newTopics.map(t => ({ label: t.label, topicId: labelToTopicId[t.label] })),
    };
  });
}

/**
 * 将多个相关主题合并为一个（对话内确认后直接执行）
 * AI 必须先在对话中向用户展示合并方案并获得明确同意，再调用本函数。
 * @param {{ sourceTopicId?: string, sourceTopicIds?: string[], targetTopicId: string, reason?: string }} payload - 合并方案
 * @returns {{ success: boolean, targetTopicId: string, mergedTopicIds: string[], mergedLabels: string[] }} 执行结果
 */
function mergeTopics(payload) {
  return withStateLock(state => {
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

    for (const sourceTopicId of sourceTopicIds) {
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
      // Update errands' topicId from source to target
      for (const errand of (state.errands || [])) {
        if (errand.topicId === sourceTopicId) {
          errand.topicId = targetTopicId;
        }
      }
      // Delete only the now-empty topic metadata. The moved entities remain
      // durable and are rebuilt against the target topic after commit.
      try { brainIndex.deleteTopicMetadata(sourceTopicId); } catch {}
    }
    afterCommit(() => {
      try { brainIndex.reindexAll(); } catch (error) {
        require('./logger').error('brain-index', 'reindex failed after topic merge', { targetTopicId, error: error.message });
      }
    });

    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('topic-merge', 'topic', { id: targetTopicId, title: idx.topics[targetTopicId].label }, {
      sourceTopicIds, sourceLabels,
      reason: String(payload.reason || '').trim().slice(0, 600),
    });
    return { success: true, targetTopicId, mergedTopicIds: sourceTopicIds, mergedLabels: sourceLabels };
  });
}

/**
 * 重命名主题（对话内确认后直接执行）
 * AI 必须先在对话中向用户说明新旧名称并获得明确同意，再调用本函数。
 * @param {{ topicId: string, newLabel: string, reason?: string }} payload - 重命名方案
 * @returns {{ success: boolean, topicId: string, oldLabel: string, newLabel: string }} 执行结果
 */
function renameTopic(payload) {
  return withStateLock(state => {
    const idx = brainIndex._readIndex();
    const topic = idx.topics[payload.topicId];
    if (!topic) throw new ActionError('Topic not found', 404, 'NOT_FOUND');

    const newLabel = requiredText(payload.newLabel, 'New label', 100);
    if (newLabel === topic.label) throw new ActionError('New label is the same as current', 400, 'NO_CHANGE');
    const oldLabel = topic.label;

    // Do NOT call ensureTopic(newLabel) — it would create a duplicate topic.
    // Directly update the existing topic's label instead.
    idx.topics[payload.topicId].label = newLabel;
    idx.topics[payload.topicId].updatedAt = now();
    brainIndex._writeIndex(idx);
    afterCommit(() => {
      try { brainIndex.reindexTopic(payload.topicId); } catch (error) {
        require('./logger').error('brain-index', 'reindex failed after topic rename', { tid: payload.topicId, error: error.message });
      }
    });

    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('topic-rename', 'topic', { id: payload.topicId, title: newLabel }, {
      oldLabel,
      reason: String(payload.reason || '').trim().slice(0, 600),
    });
    return { success: true, topicId: payload.topicId, oldLabel, newLabel };
  });
}

/**
 * 把主题的笔记沉淀为独立文件（对话内确认后直接执行）
 * AI 必须先在对话中向用户说明沉淀理由并获得明确同意，再调用本函数。
 * @param {{ topicId: string, reason?: string }} payload - 沉淀方案
 * @returns {{ success: boolean, topicId: string, label: string, alreadyPrecipitated?: boolean }} 执行结果
 */
function precipitateTopic(payload) {
  return withStateLock(state => {
    const idx = brainIndex._readIndex();
    const topic = idx.topics[payload.topicId];
    if (!topic) throw new ActionError('Topic not found', 404, 'NOT_FOUND');
    if (topic.precipitated) {
      return { success: true, topicId: payload.topicId, label: topic.label, alreadyPrecipitated: true };
    }
    try {
      brainIndex._precipitate(payload.topicId);
    } catch (e) {
      throw new ActionError(`Precipitation failed: ${e.message}`, 500, 'PRECIPITATION_FAILED');
    }
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('topic-precipitate', 'topic', { id: payload.topicId, title: topic.label }, {
      reason: String(payload.reason || '').trim().slice(0, 600),
    });
    return { success: true, topicId: payload.topicId, label: topic.label };
  });
}

/**
 * 直接为笔记设置标题、主题和分类（AI 侧调用）
 * @param {{ id: string, title: string, topic?: string, topicId?: string, category: string, domain?: string, signal?: string }} payload - 笔记丰富化参数
 * @returns {{ success: boolean, note: Object }} 操作结果及更新后的笔记对象
 * @throws {ActionError} 笔记不存在或分类失败时抛出
 */
function enrichNote(payload) {
  return withStateLock(state => {
    state.notes = Array.isArray(state.notes) ? state.notes : [];
    const note = state.notes.find(n => n.id === payload.id);
    if (!note) throw new ActionError('Note not found', 404, 'NOT_FOUND');
    const title = requiredText(payload.title, 'Title', 160);
    const category = requiredText(payload.category, 'Category', 100);
    const topicLabel = String(payload.topic || '').trim();
    const oldTopicId = note.topicId || null;
    let topicId = null;
    // topicId = reuse existing topic; topic = create new topic.
    if (payload.topicId) {
      const existing = brainIndex._readIndex().topics[payload.topicId];
      if (!existing) throw new ActionError('Topic not found: ' + payload.topicId, 404, 'NOT_FOUND');
      topicId = payload.topicId;
    } else if (topicLabel) {
      try {
        topicId = brainIndex.ensureTopic(topicLabel, { domain: payload.domain || note.domain || 'misc', category });
      } catch (error) {
        throw new ActionError(`Unable to classify note: ${error.message}`, 500, 'CLASSIFICATION_FAILED');
      }
    } else {
      throw new ActionError('Either topic or topicId is required', 400, 'VALIDATION_ERROR');
    }
    note.title = title;
    note.topicId = topicId;
    note.category = category;
    note.domain = payload.domain || note.domain || 'misc';
    if (payload.signal) note.signal = payload.signal;
    note.needsEnrichment = false;
    note.organizationStatus = 'confirmed';
    note.enrichedAt = now();
    note.enrichedBy = 'ai';
    if (oldTopicId && oldTopicId !== topicId) {
      try { brainIndex.unlinkEntityCascade('notes', note.id); } catch {}
    }
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    // Reindex after writeState so brain-index reads the updated notes.json.
    afterCommit(() => {
      try {
        brainIndex.linkEntity(topicId, 'notes', note.id);
        brainIndex.reindexTopic(topicId);
        if (oldTopicId && oldTopicId !== topicId) brainIndex.reindexTopic(oldTopicId);
      } catch (e) { require('./logger').error('brain-index', 'reindex failed for topic', { tid: topicId, oldTopicId, error: e.message }); }
    });
    audit('enrich', 'note', note, { oldTopicId });
    return { success: true, note };
  });
}

/**
 * 删除指定笔记并清理索引
 * @param {{ noteId: string }} payload - 包含笔记 ID 的参数
 * @returns {{ success: boolean, deleted: string }} 操作结果，含被删除笔记内容
 * @throws {ActionError} 笔记不存在时抛出
 */
function deleteNote(payload) {
  return withStateLock(state => {
    state.notes = Array.isArray(state.notes) ? state.notes : [];
    const index = state.notes.findIndex(n => n.id === payload.noteId);
    if (index < 0) throw new ActionError('Note not found', 404, 'NOT_FOUND');
    const [note] = state.notes.splice(index, 1);
    const referenceCleanup = scrubDeletedNoteReferences(state, payload.noteId);
    // BrainIndex maintains its own index files and may synchronise a legacy
    // state projection. Run it first, then commit this complete canonical state
    // so completed actions and other non-index entities cannot be overwritten.
    try { brainIndex.unlinkEntityCascade('notes', payload.noteId); } catch {}
    try { brainIndex.cleanupEmptyTopics(); } catch {}
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('delete', 'note', note, { referenceCleanup });
    return { success: true, deleted: note.content, referenceCleanup };
  });
}

function topicDeletionPlan(state, topicId) {
  const index = brainIndex._readIndex();
  const topic = index?.topics?.[topicId];
  if (!topic) throw new ActionError('Topic not found', 404, 'NOT_FOUND');

  // Ownership is defined only by note.topicId.  The brain index can also list a
  // note because an action in this topic uses it as context; deleting that note
  // would wrongly damage cross-topic planning.
  const notes = (state.notes || []).filter(note => note?.topicId === topicId);
  const related = topic.related || {};
  const linkedActionItems = [
    ...(related.actionItems || []), ...(related.tasks || []), ...(related.errands || []),
  ];
  const linkedGoals = related.goals || [];
  return {
    topic: { id: topicId, label: topic.label, precipitated: !!topic.precipitated },
    notes,
    counts: {
      notes: notes.length,
      preservedActionItems: new Set(linkedActionItems).size,
      preservedGoals: new Set(linkedGoals).size,
    },
    manifest: {
      notes: notes.map(note => ({ id: note.id, title: note.title || '待 AI 归纳' })),
      preservedActionItems: [...new Set(linkedActionItems)].map(id => ({ id })),
      preservedGoals: [...new Set(linkedGoals)].map(id => ({ id })),
    },
  };
}

function previewTopicDelete(payload) {
  const topicId = requiredText(payload.topicId, 'Topic ID', 200);
  const plan = topicDeletionPlan(read(), topicId);
  return {
    aborted: true,
    preview: true,
    topicId,
    label: plan.topic.label,
    ...plan,
  };
}

/**
 * Delete a topic as a knowledge container. Only notes owned by the topic are
 * removed; goals, errands and scheduled tasks are preserved and detached.
 */
function deleteTopic(payload) {
  const topicId = requiredText(payload.topicId, 'Topic ID', 200);
  if (payload.confirm !== true) return previewTopicDelete({ topicId });

  return withStateLock(state => {
    const plan = topicDeletionPlan(state, topicId);
    const deletedNoteIds = plan.notes.map(note => note.id);
    const noteCleanup = {
      scheduleTasks: 0, errands: 0, completedActions: 0, decisions: 0,
      followUps: 0,
    };

    state.notes = (state.notes || []).filter(note => note?.topicId !== topicId);
    for (const noteId of deletedNoteIds) {
      const cleaned = scrubDeletedNoteReferences(state, noteId);
      for (const [key, value] of Object.entries(cleaned)) noteCleanup[key] += value || 0;
      try { brainIndex.unlinkEntityCascade('notes', noteId); } catch {}
    }
    const topicCleanup = scrubDeletedTopicReferences(state, topicId);

    // The topic index is a secondary retrieval projection. Remove its metadata
    // only after all owned note links have been unbound, then commit the full
    // canonical state below so no action context can be overwritten.
    const removedTopic = brainIndex.deleteTopicMetadata(topicId);
    if (!removedTopic?.success) {
      throw new ActionError(removedTopic?.error || 'Unable to remove topic index', 500, 'TOPIC_INDEX_FAILED');
    }

    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('delete', 'topic', {
      id: topicId,
      title: plan.topic.label,
      noteIds: deletedNoteIds,
    }, {
      deletedNotes: deletedNoteIds,
      noteReferenceCleanup: noteCleanup,
      topicReferenceCleanup: topicCleanup,
      preserved: plan.counts,
    });
    return {
      success: true,
      topicId,
      label: plan.topic.label,
      deleted: { notes: deletedNoteIds.length, topicFile: !!plan.topic.precipitated },
      preserved: plan.counts,
      noteReferenceCleanup: noteCleanup,
      topicReferenceCleanup: topicCleanup,
    };
  });
}

/**
 * 更新笔记内容
 * @param {{ noteId: string, content: string }} payload - 笔记 ID 和新内容
 * @returns {{ success: boolean, note: Object }} 操作结果及更新后的笔记对象
 * @throws {ActionError} 笔记不存在时抛出
 */
function updateNote(payload) {
  return withStateLock(state => {
    state.notes = Array.isArray(state.notes) ? state.notes : [];
    const note = state.notes.find(n => n.id === payload.noteId);
    if (!note) throw new ActionError('Note not found', 404, 'NOT_FOUND');
    const newContent = requiredText(payload.content, 'Content', 10000);
    note.content = newContent;
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', 'note', note);
    return { success: true, note };
  });
}

/**
 * 更新用户价值体系的权重与决策风格
 * @param {{ priorities?: string[], decisionStyle?: string, learnedFrom?: string[] }} payload - 权重更新参数
 * @returns {{ success: boolean }} 操作结果
 */
function updateWeights(payload) {
  return withStateLock(state => {
    state.userProfile = state.userProfile || {};
    const system = state.userProfile.valueSystem = state.userProfile.valueSystem || {};
    if (Array.isArray(payload.priorities)) system.priorities = payload.priorities;
    if (payload.decisionStyle) system.decisionStyle = payload.decisionStyle;
    if (Array.isArray(payload.learnedFrom)) system.learnedFrom = [...(system.learnedFrom || []), ...payload.learnedFrom];
    state.userProfile.updatedAt = now();
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', 'value-system', { id: 'value-system', title: 'Value system' });
    return { success: true };
  });
}

/**
 * 更新指定提醒（原地修改，保持 ID 与关联不变）
 * @param {{ id: string, title?: string, triggerAt?: string, category?: string, commitmentLevel?: string, note?: string, repeat?: string|null, relatedGoalId?: string|null, relatedErrandId?: string|null }} payload - 提醒 ID 及要更新的字段
 * @returns {{ success: boolean, reminder: Object }} 操作结果及更新后的提醒对象
 * @throws {ActionError} 提醒不存在或字段无效时抛出
 */
function updateReminder(payload) {
  return withStateLock(state => {
    const reminder = (state.reminders || []).find(r => r.id === payload.id);
    if (!reminder) throw new ActionError('Reminder not found', 404, 'NOT_FOUND');
    if (payload.title !== undefined) reminder.title = requiredText(payload.title, 'Title', 240);
    if (payload.triggerAt !== undefined) {
      const triggerAt = String(payload.triggerAt || '').trim();
      if (Number.isNaN(Date.parse(triggerAt))) {
        throw new ActionError('triggerAt must be an ISO datetime', 400, 'INVALID_DATE');
      }
      reminder.triggerAt = triggerAt;
      // Rescheduling to the future re-arms a fired one-time reminder so it can
      // trigger again at the new time instead of staying consumed forever.
      if (reminder.fired && Date.parse(triggerAt) > Date.now()) {
        reminder.fired = false;
        reminder.firedAt = null;
      }
    }
    if (payload.category !== undefined) reminder.category = String(payload.category || 'misc');
    if (payload.commitmentLevel !== undefined && ['must', 'should', 'nice'].includes(payload.commitmentLevel)) {
      reminder.commitmentLevel = payload.commitmentLevel;
    }
    if (payload.note !== undefined) reminder.note = String(payload.note || '').trim();
    if (payload.repeat !== undefined) reminder.repeat = payload.repeat || null;
    if (payload.relatedGoalId !== undefined) reminder.relatedGoalId = payload.relatedGoalId || null;
    if (payload.relatedErrandId !== undefined) reminder.relatedErrandId = payload.relatedErrandId || null;
    reminder.updatedAt = now();
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', 'reminder', reminder, { source: payload.source || 'user' });
    return { success: true, reminder };
  });
}

/**
 * 删除指定提醒
 * @param {{ id: string }} payload - 包含提醒 ID 的参数
 * @returns {{ success: boolean }} 操作结果
 * @throws {ActionError} 提醒不存在时抛出
 */
function deleteReminder(payload) {
  return withStateLock(state => {
    const index = (state.reminders || []).findIndex(r => r.id === payload.id);
    if (index < 0) throw new ActionError('Reminder not found', 404, 'NOT_FOUND');
    const [reminder] = state.reminders.splice(index, 1);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('delete', 'reminder', reminder);
    return { success: true };
  });
}

/**
 * 设置用户偏好项并持久化
 * @param {string} key - 偏好键名
 * @param {*} value - 偏好值
 * @returns {{ success: boolean }} 操作结果
 */
function setPreference(key, value) {
  return withStateLock(state => {
    state.meta = state.meta || {};
    state.meta[key] = value;
    state.meta.lastUpdated = now();
    return { success: true, [key]: value };
  });
}

function addReminder(payload) {
  const title = requiredText(payload.title, 'Title', 240);
  const triggerAt = String(payload.triggerAt || '').trim();
  if (Number.isNaN(Date.parse(triggerAt))) {
    throw new ActionError('triggerAt must be an ISO datetime', 400, 'INVALID_DATE');
  }
  return withStateLock(state => {
    const reminder = {
      id: id('rm'), title, triggerAt,
      category: String(payload.category || 'misc'),
      commitmentLevel: ['must', 'should', 'nice'].includes(payload.commitmentLevel) ? payload.commitmentLevel : 'should',
      note: String(payload.note || '').trim(),
      relatedGoalId: payload.relatedGoalId || null,
      relatedErrandId: payload.relatedErrandId || null,
      repeat: payload.repeat || null,
      fired: false, firedAt: null, createdAt: now(),
    };
    state.reminders = Array.isArray(state.reminders) ? state.reminders : [];
    state.reminders.push(reminder);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('create', 'reminder', reminder, { source: payload.source || 'user' });
    return { success: true, reminder };
  });
}

function setBriefing(payload) {
  const date = normalizeDate(payload.date || todayStr(), { optional: false });
  if (date !== todayStr()) {
    return { success: false, error: `Briefings are today-only. Cannot set briefing for ${date}.` };
  }
  return withStateLock(state => {
    const existing = state.briefings?.[date] || {};
    state.briefings = state.briefings || {};
    const briefing = {
      ...existing, date, _raw: false,
      mustDo: payload.mustDo, recommended: payload.recommended,
      notRecommended: payload.notRecommended || '', strategicReminder: payload.strategicReminder || '',
      dailyQuote: payload.dailyQuote || '', composedAt: now(), updatedAt: now(),
    };
    if (Array.isArray(payload.sections) && payload.sections.length > 0) {
      briefing.sections = payload.sections.filter(section => section && section.label && section.content);
    } else {
      delete briefing.sections;
    }
    state.briefings[date] = briefing;
    state.morningBriefing = briefing;
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('set', 'briefing', briefing, { source: payload.source || 'user' });
    return { success: true, briefing };
  });
}

function updateUserProfile(payload) {
  return withStateLock(state => {
    const profile = state.userProfile = state.userProfile || { createdAt: now(), conversationCount: 0 };
    const fields = ['personality', 'communicationStyle', 'preferredTools', 'workHabit', 'chronotype', 'interests', 'tonePreference', 'responseDetail', 'languageStyle', 'notes', 'longTermDirection', 'corePrinciples', 'lifeStage'];
    for (const key of fields) {
      if (payload[key] === undefined) continue;
      profile[key] = Array.isArray(payload[key])
        ? payload[key].map(value => String(value).trim()).filter(Boolean)
        : String(payload[key]).trim();
    }
    profile.conversationCount = payload.conversationCount !== undefined
      ? Number(payload.conversationCount) || 0
      : (Number(profile.conversationCount) || 0) + 1;
    profile.updatedAt = now();
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', 'userProfile', { id: 'userProfile', title: 'User profile' }, { source: payload.source || 'user' });
    return { success: true, profile };
  });
}

function normalizeWindowBounds(bounds) {
  const value = bounds && typeof bounds === 'object' ? bounds : {};
  const keys = ['x', 'y', 'width', 'height'];
  const normalized = {};
  for (const key of keys) {
    const number = Number(value[key]);
    if (!Number.isFinite(number)) throw new ActionError(`Window ${key} must be a number`, 400, 'INVALID_WINDOW_BOUNDS');
    normalized[key] = Math.round(number);
  }
  if (normalized.width < 40 || normalized.height < 40) {
    throw new ActionError('Window bounds are too small', 400, 'INVALID_WINDOW_BOUNDS');
  }
  return normalized;
}

function setWindowPresentation(payload) {
  return withStateLock(state => {
    state.meta = state.meta || {};
    if (payload.bounds) state.meta.windowBounds = normalizeWindowBounds(payload.bounds);
    if (typeof payload.collapsed === 'boolean') state.meta.collapsed = payload.collapsed;
    if (typeof payload.alwaysOnTop === 'boolean') state.meta.alwaysOnTop = payload.alwaysOnTop;
    state.meta.lastUpdated = now();
    return { success: true, windowBounds: state.meta.windowBounds || null };
  });
}

// A destructive operation must be explainable before it is committed.  This
// stays in the command layer so the dashboard, Electron shell and MCP do not
// invent separate ideas of which relationships will be affected.
function previewDeletion(payload = {}) {
  const entityType = requiredText(payload.entityType, 'entityType', 40);
  const state = read();
  const clone = JSON.parse(JSON.stringify(state));
  const entity = (type, id, title) => ({ type, id, title: title || id });

  if (entityType === 'task') {
    const date = normalizeDate(payload.date, { optional: false });
    const task = findTask(state, date, requiredText(payload.taskId, 'taskId', 200));
    const impact = scrubDeletedActionReferences(clone, task.id);
    return { success: true, preview: true, entity: entity('task', task.id, task.title), impact: { ...impact, scheduleTasks: 1 } };
  }
  if (entityType === 'errand') {
    const errand = (state.errands || []).find(item => item.id === payload.id);
    if (!errand) throw new ActionError('Errand not found', 404, 'NOT_FOUND');
    const recurringPreviews = Object.values(clone.schedule?.days || {}).reduce((total, day) => total + (day?.tasks || [])
      .filter(task => task.recurrenceParentId === errand.id).length, 0);
    const impact = scrubDeletedActionReferences(clone, errand.id);
    return { success: true, preview: true, entity: entity('errand', errand.id, errand.title), impact: { ...impact, recurringPreviews } };
  }
  if (entityType === 'note') {
    const noteId = requiredText(payload.noteId || payload.id, 'noteId', 200);
    const note = (state.notes || []).find(item => item.id === noteId);
    if (!note) throw new ActionError('Note not found', 404, 'NOT_FOUND');
    return { success: true, preview: true, entity: entity('note', note.id, note.title), impact: scrubDeletedNoteReferences(clone, note.id) };
  }
  if (entityType === 'decision') {
    const decision = (state.decisions || []).find(item => item.id === payload.id);
    if (!decision) throw new ActionError('Decision not found', 404, 'NOT_FOUND');
    return { success: true, preview: true, entity: entity('decision', decision.id, decision.title), impact: scrubDeletedDecisionReferences(clone, decision.id) };
  }
  if (entityType === 'reminder') {
    const reminder = (state.reminders || []).find(item => item.id === payload.id);
    if (!reminder) throw new ActionError('Reminder not found', 404, 'NOT_FOUND');
    return { success: true, preview: true, entity: entity('reminder', reminder.id, reminder.title), impact: {} };
  }
  if (entityType === 'goal') {
    const type = payload.goalType || payload.type;
    const map = { strategicGoal: 'strategicGoals', currentGoal: 'currentGoals', constraint: 'constraints' };
    const goal = (state[map[type]] || []).find(item => item.id === payload.id);
    if (!goal) throw new ActionError('Goal not found', 404, 'NOT_FOUND');
    const scheduledTasks = Object.values(state.schedule?.days || {}).flatMap(day => day?.tasks || [])
      .filter(task => task.relatedGoalId === goal.id || task.relatedStrategicGoalId === goal.id);
    const impact = scrubDeletedGoalReferences(clone, goal.id);
    return {
      success: true, preview: true, entity: entity('goal', goal.id, goal.title),
      impact: { ...impact, scheduleTasks: scheduledTasks.length },
      samples: { scheduleTasks: scheduledTasks.slice(0, 8).map(task => ({ id: task.id, title: task.title })) },
    };
  }
  if (entityType === 'topic') {
    const topicId = requiredText(payload.topicId || payload.id, 'topicId', 200);
    const plan = topicDeletionPlan(state, topicId);
    return {
      success: true, preview: true, entity: entity('topic', topicId, plan.topic.label),
      impact: { notes: plan.counts.notes, preservedActionItems: plan.counts.preservedActionItems, preservedGoals: plan.counts.preservedGoals },
      samples: plan.manifest,
    };
  }
  throw new ActionError('Unsupported deletion preview entityType', 400, 'INVALID_ENTITY_TYPE');
}

const ACTIONS = {
  'task.add': addEvent, 'task.toggle': toggleTask, 'task.complete': completeTask, 'task.update': updateTask, 'task.delete': deleteTask, 'task.unlock': unlockTask,
  'event.add': addEvent, 'goal.add': addGoal, 'goal.update': updateGoal, 'goal.complete': completeGoal, 'goal.delete': deleteGoal,
  'errand.add': addErrand, 'errand.complete': completeErrand, 'errand.undo': undoCompleteErrand, 'errand.update': updateErrand, 'errand.delete': deleteErrand,
  'note.add': addNote, 'note.enrich': enrichNote, 'note.delete': deleteNote, 'note.update': updateNote,
  'note.import': importNotes,
  'topic.preview_delete': previewTopicDelete, 'topic.delete': deleteTopic,
  'topic.split': splitTopic, 'topic.merge': mergeTopics, 'topic.rename': renameTopic, 'topic.precipitate': precipitateTopic,
  'weights.update': updateWeights,
      'decision.add': addDecision, 'decision.get': getDecisions, 'decision.update': updateDecision, 'decision.delete': deleteDecision,
  'reminder.add': addReminder, 'reminder.update': updateReminder, 'reminder.delete': deleteReminder,
  'briefing.set': setBriefing, 'profile.update': updateUserProfile,
  'followup.resolve': resolveFollowUp,
  'activity.reconcile': reconcileActivity,
  'deletion.preview': previewDeletion,
  'window.presentation.set': setWindowPresentation,
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
  const previousActor = activeActor;
  activeActor = payload?.source || 'user';
  try {
    return handler(payload || {});
  } finally {
    activeActor = previousActor;
  }
}

// ─── Decision CRUD ─────────────────────────────────────────────────────

const DECISION_STATUSES = new Set(['accepted', 'rejected', 'pending', 'revised', 'reversed', 'expired', 'resolved']);

function uniqueIds(value, max = 30) {
  return [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))].slice(0, max);
}

function actionEntitiesById(state) {
  const entities = new Map();
  for (const day of Object.values(state.schedule?.days || {})) {
    for (const task of (day?.tasks || [])) if (task?.id) entities.set(task.id, task);
  }
  for (const errand of (state.errands || [])) if (errand?.id) entities.set(errand.id, errand);
  for (const action of (state.completedActions || [])) if (action?.id) entities.set(action.id, action);
  return entities;
}

function assertDecisionReferences(state, input) {
  const goals = new Set([...(state.strategicGoals || []), ...(state.currentGoals || []), ...(state.constraints || [])].map(goal => goal.id));
  const notes = new Set((state.notes || []).map(note => note.id));
  const actions = actionEntitiesById(state);
  for (const goalId of uniqueIds(input.relatedGoalIds)) if (!goals.has(goalId)) throw new ActionError(`Goal not found: ${goalId}`, 404, 'NOT_FOUND');
  for (const noteId of uniqueIds(input.relatedNoteIds)) if (!notes.has(noteId)) throw new ActionError(`Note not found: ${noteId}`, 404, 'NOT_FOUND');
  for (const actionId of uniqueIds(input.relatedActionIds)) if (!actions.has(actionId)) throw new ActionError(`Action not found: ${actionId}`, 404, 'NOT_FOUND');
}

function applyDecisionStatus(decision, status) {
  if (!DECISION_STATUSES.has(status)) throw new ActionError('Invalid decision status', 400, 'INVALID_STATUS');
  decision.status = status;
  if (['rejected', 'revised', 'reversed', 'expired', 'resolved'].includes(status)) {
    decision.lifecycleState = 'archived';
    decision.archivedAt = decision.archivedAt || now();
  } else {
    decision.lifecycleState = 'active';
    delete decision.archivedAt;
  }
}

function syncDecisionActionLinks(state, decision, previousActionIds = []) {
  const nextIds = uniqueIds(decision.relatedActionIds);
  const next = new Set(nextIds);
  const previous = new Set(uniqueIds(previousActionIds));
  const actions = actionEntitiesById(state);
  for (const actionId of previous) {
    if (next.has(actionId)) continue;
    const action = actions.get(actionId);
    if (!action) continue;
    for (const key of ['decisionIds', 'linkedDecisionIds']) {
      if (Array.isArray(action[key])) action[key] = action[key].filter(id => id !== decision.id);
    }
    if (Array.isArray(action.contextRefs)) {
      action.contextRefs = action.contextRefs.filter(ref => !(ref?.type === 'decision' && ref.id === decision.id));
    }
  }
  for (const actionId of next) {
    const action = actions.get(actionId);
    if (!action) throw new ActionError(`Action not found: ${actionId}`, 404, 'NOT_FOUND');
    action.decisionIds = [...new Set([...(action.decisionIds || []), decision.id])];
    action.contextRefs = Array.isArray(action.contextRefs) ? action.contextRefs : [];
    if (!action.contextRefs.some(ref => ref?.type === 'decision' && ref.id === decision.id)) {
      action.contextRefs.push({ type: 'decision', id: decision.id, role: 'decision_basis' });
    }
  }
}

function createDecisionInState(state, payload = {}) {
  const title = requiredText(payload.title, 'Title', 240);
  assertDecisionReferences(state, payload);
  const decision = {
    id: id('dec'), title,
    description: String(payload.description || '').trim(),
    evidence: String(payload.evidence || '').trim(),
    impact: String(payload.impact || '').trim(),
    relatedGoalIds: uniqueIds(payload.relatedGoalIds),
    relatedNoteIds: uniqueIds(payload.relatedNoteIds),
    relatedActionIds: uniqueIds(payload.relatedActionIds),
    topicIds: uniqueIds(payload.topicIds),
    status: 'accepted', lifecycleState: 'active',
    expiresAt: payload.expiresAt || null,
    reviewDueAt: payload.reviewDueAt || payload.expiresAt || null,
    supersedesId: payload.supersedesId || null,
    replacedById: null,
    sourceEventId: payload.sourceEventId || null,
    updateReason: String(payload.updateReason || '').trim() || null,
    createdAt: now(), updatedAt: now(), reversedBy: null, outcome: null,
  };
  applyDecisionStatus(decision, payload.status || 'accepted');
  if (decision.supersedesId) {
    const previous = (state.decisions || []).find(item => item.id === decision.supersedesId);
    if (!previous) throw new ActionError(`Decision not found: ${decision.supersedesId}`, 404, 'NOT_FOUND');
    previous.replacedById = decision.id;
    previous.updateReason = previous.updateReason || `Replaced by ${decision.id}`;
    applyDecisionStatus(previous, 'revised');
    previous.updatedAt = now();
  }
  syncDecisionActionLinks(state, decision);
  state.decisions = state.decisions || [];
  state.decisions.push(decision);
  return decision;
}

function patchDecisionInState(state, decision, payload = {}) {
  const previousActionIds = [...(decision.relatedActionIds || [])];
  const referenceFields = ['relatedGoalIds', 'relatedNoteIds', 'relatedActionIds'];
  if (referenceFields.some(field => payload[field] !== undefined)) assertDecisionReferences(state, payload);
  for (const field of ['title', 'description', 'evidence', 'impact', 'expiresAt', 'reviewDueAt', 'outcome', 'updateReason']) {
    if (payload[field] !== undefined) decision[field] = payload[field] == null ? null : String(payload[field]).trim();
  }
  for (const field of referenceFields) if (payload[field] !== undefined) decision[field] = uniqueIds(payload[field]);
  if (payload.topicIds !== undefined) decision.topicIds = uniqueIds(payload.topicIds);
  if (payload.status !== undefined) applyDecisionStatus(decision, payload.status);
  if (payload.reversedBy !== undefined) decision.reversedBy = payload.reversedBy || null;
  if (payload.replacedById !== undefined) decision.replacedById = payload.replacedById || null;
  if (payload.supersedesId !== undefined) {
    const previous = payload.supersedesId ? (state.decisions || []).find(item => item.id === payload.supersedesId) : null;
    if (payload.supersedesId && !previous) throw new ActionError(`Decision not found: ${payload.supersedesId}`, 404, 'NOT_FOUND');
    decision.supersedesId = payload.supersedesId || null;
    if (previous && previous.id !== decision.id) {
      previous.replacedById = decision.id;
      applyDecisionStatus(previous, 'revised');
      previous.updatedAt = now();
    }
  }
  syncDecisionActionLinks(state, decision, previousActionIds);
  decision.updatedAt = now();
  return decision;
}

/** Add a structured, evolving decision record. */
function addDecision(payload) {
  return withStateLock(state => {
    const decision = createDecisionInState(state, payload);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('create', 'decision', decision, { channel: payload.source === 'ai' ? 'conversation' : 'panel', meaning: 'decision' });
    return { success: true, decision };
  });
}

/**
 * Get decision records with optional filtering.
 * @param {Object} payload
 * @returns {{ decisions: Array, total: number }}
 */
function getDecisions(payload) {
  const state = read();
  if (payload.id) {
    const decision = (state.decisions || []).find(item => item.id === payload.id);
    if (!decision) throw new ActionError('Decision not found', 404, 'NOT_FOUND');
    return { decision };
  }
  let result = [...(state.decisions || [])].reverse();
  if (payload.status) result = result.filter(d => d.status === payload.status);
  if (payload.goalId) result = result.filter(d => (d.relatedGoalIds || []).includes(payload.goalId));
  const limit = Math.min(Math.max(Number(payload.limit) || 20, 1), 100);
  result = result.slice(0, limit);
  return {
    decisions: result.map(decision => ({
      id: decision.id, title: decision.title, status: decision.status,
      lifecycleState: decision.lifecycleState || 'active', updatedAt: decision.updatedAt,
      reviewDueAt: decision.reviewDueAt || decision.expiresAt || null,
      relatedGoalIds: decision.relatedGoalIds || [], relatedNoteIds: decision.relatedNoteIds || [],
      relatedActionIds: decision.relatedActionIds || [], topicIds: decision.topicIds || [],
    })),
    total: result.length,
  };
}

/**
 * Update a decision (status, outcome, etc.).
 * @param {Object} payload
 * @returns {{ success: boolean, decision: Object }}
 */
function updateDecision(payload) {
  return withStateLock(state => {
    const decision = (state.decisions || []).find(d => d.id === payload.id);
    if (!decision) throw new ActionError('Decision not found', 404, 'NOT_FOUND');

    patchDecisionInState(state, decision, payload);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('update', 'decision', decision, { channel: payload.source === 'ai' ? 'conversation' : 'panel', meaning: 'decision' });
    return { success: true, decision };
  });
}

/**
 * Delete a decision record.
 * @param {Object} payload
 * @returns {{ success: boolean, deleted: string }}
 */
function deleteDecision(payload) {
  return withStateLock(state => {
    state.decisions = state.decisions || [];
    const idx = state.decisions.findIndex(d => d.id === payload.id);
    if (idx < 0) throw new ActionError('Decision not found', 404, 'NOT_FOUND');
    const [removed] = state.decisions.splice(idx, 1);
    const cleaned = scrubDeletedDecisionReferences(state, payload.id);
    state.meta = state.meta || {};
    state.meta.lastUpdated = now();
    audit('delete', 'decision', removed);
    return { success: true, deleted: removed.title, cleaned };
  });
}

module.exports = { configure, execute, ActionError, normalizeDate, normalizeTime, withStateLock };
