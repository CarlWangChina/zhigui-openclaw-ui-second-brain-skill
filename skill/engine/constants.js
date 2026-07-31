'use strict';

/**
 * 全局常量定义 (P2-4.4)
 *
 * 消除散布在代码各处的魔法数字，集中管理可调参数。
 * 所有常量使用 UPPER_SNAKE_CASE，带注释说明取值理由。
 *
 * @module constants
 */

// ─── 存储与锁 ───
/** 跨进程文件锁超时时间（毫秒）。15 秒后自动过期，防崩溃死锁。 */
const LOCK_TIMEOUT_MS = 15000;
/** 锁重试间隔（毫秒）。 */
const LOCK_RETRY_MS = 50;
/** 锁最大重试次数（约 3 秒总量）。 */
const LOCK_RETRY_MAX = 60;

// ─── HTTP 与网络 ───
/** Dashboard HTTP 请求 body 最大大小（字节）。10MB，足够大 JSON 载荷。 */
const MAX_BODY_SIZE = 10 * 1024 * 1024;
/** SSE 最大连接数。防止资源耗尽。 */
const MAX_SSE_CLIENTS = 10;
/** SSE 心跳间隔（毫秒）。30 秒发送一次注释保持连接活跃。 */
const SSE_HEARTBEAT_INTERVAL_MS = 30000;
/** SSE 默认重连提示（毫秒）。 */
const SSE_RETRY_MS = 3000;

// ─── 调度引擎 ───
/** 晨报只生成当天（today-only）。server.js 内局部 BRIEFING_DAYS=1 为实际生效值；此处保持一致避免误导。未来截止日期已在 goals/notes 中。 */
const BRIEFING_DAYS = 1;
/** 最大可调度天数。防止用户请求过大导致性能问题。 */
const MAX_SCHEDULE_DAYS = 180;
/** 运动任务默认时长（分钟）。 */
const EXERCISE_DURATION_MIN = 30;
/** 最晚任务时间下限（小时）。latestTaskTime 不低于 19:00。 */
const MIN_LATEST_TASK_HOUR = 19;
/** 每日默认可用学习时间（小时）。 */
const DEFAULT_DAILY_HOURS = 8;
// ─── 价值观与置信度 ───
/** 置信度基础值。 */
const CONFIDENCE_BASE = 0.3;
/** 置信度每信号增量。 */
const CONFIDENCE_PER_SIGNAL = 0.2;
/** 信号最大保留数。防止信号列表无限增长。 */
const MAX_SIGNALS = 50;

// ─── 渲染与防抖 ───
/** SSE 事件防抖时间（毫秒）。300ms 足以合并一个写入批次。 */
const RENDER_DEBOUNCE_MS = 300;
/** 本地变更回声抑制窗口（毫秒）。900ms 内忽略外部触发的重渲染。 */
const ECHO_SUPPRESSION_MS = 900;
/** 渲染锁：防止 renderAll 重入。 */
const RENDER_LOCK_TIMEOUT_MS = 5000;

// ─── 笔记信号 ───
/** 健康负面信号每条强度衰减。 */
const HEALTH_NEGATIVE_DECAY = 0.10;
/** 健康负面信号最大衰减。 */
const HEALTH_NEGATIVE_MAX = 0.40;
/** 情绪压力信号每条强度衰减。 */
const EMOTIONAL_STRESS_DECAY = 0.08;
/** 情绪压力信号最大衰减。 */
const EMOTIONAL_STRESS_MAX = 0.20;
/** 正面信号每条强度增益。 */
const POSITIVE_SIGNAL_GAIN = 0.05;
/** 正面信号最大增益。 */
const POSITIVE_SIGNAL_MAX = 0.15;
/** 强度修正下限。不低于 30% 的原始强度。 */
const INTENSITY_MODIFIER_MIN = 0.3;

// ─── 文件监听 ───
/** 文件变更防抖时间（毫秒）。100ms 内多次变更合并为一次事件。 */
const FILE_WATCH_DEBOUNCE_MS = 100;

// ─── 日志 ───
/** 日志文件最大大小（字节）。5MB 后轮转。 */
const LOG_MAX_SIZE = 5 * 1024 * 1024;
/** 日志最大保留天数。 */
const LOG_MAX_AGE_DAYS = 7;

// ─── 文档类型与字段定义 (Task 1.3: 统一定义) ──────────────────────────────
/**
 * DOCUMENT_KEYS — 文档类型到 state 字段的映射。
 * storage.js 和 hierarchy.js 共用此定义，避免新增字段时遗漏。
 */
const DOCUMENT_KEYS = {
  goals: ['strategicGoals', 'currentGoals', 'constraints'],
  schedule: ['schedule', 'morningBriefing', 'conflicts', 'briefings'],
  errands: ['errands'],
  notes: ['notes'],
  decisions: ['decisions'],
  // Activity is append-only and stored as compact `events`; it is not part of
  // the canonical state aggregate, which prevents normal entity writes from
  // erasing the change journal.
  activity: ['events'],
  // Follow-ups are assistant-owned future questions, distinct from clock alarms.
  reminders: ['reminders', 'followUps'],
  userProfile: ['userProfile'],
};

/**
 * GOAL_INDEX_FIELDS — 目标索引文件中保存的轻量字段列表。
 * writeGoal / writeGoals 共用此定义，保证索引一致性。
 * 不含 description/detail 等重字段（它们在 detail 文件中）。
 */
const GOAL_INDEX_FIELDS = [
  'id', 'type', 'title', 'deadline', 'completed',
  'topicId', 'domain', 'category', 'estimatedHours', 'daysLeft', 'overdue', 'statusSignal',
  'baseTitle', 'phaseName', 'relatedStrategicGoalId',
  // P1: Lifecycle fields — needed for archived filtering in lightweight index reads
  'lifecycleState', 'lastAccessedAt', 'staleSince', 'archivedAt',
];

/**
 * NOTE_INDEX_FIELDS — 笔记索引文件中保存的轻量字段列表。
 * writeNote / writeNotes 共用此定义。
 */
const NOTE_INDEX_FIELDS = [
  'id', 'title', 'category', 'domain', 'topicId', 'createdAt',
  'relatedDate', 'needsEnrichment',
  // Lifecycle fields support archived filtering and stale detection.
  'lifecycleState', 'lastAccessedAt', 'staleSince', 'archivedAt',
];

/**
 * 从源对象中按字段列表提取子集，用于创建索引条目。
 * @param {Object} src - 源对象
 * @param {string[]} fields - 字段名列表
 * @param {Object} defaults - 字段默认值 { fieldName: defaultValue }
 * @returns {Object} 包含指定字段的对象
 */
function pickIndexFields(src, fields, defaults = {}) {
  const result = {};
  for (const f of fields) {
    if (src[f] !== undefined) {
      result[f] = src[f];
    } else if (defaults[f] !== undefined) {
      result[f] = defaults[f];
    }
  }
  return result;
}

/**
 * 开发模式下校验 state 对象是否符合 DOCUMENT_KEYS schema。
 * 生产环境跳过以保性能。
 * @param {Object} state - 待写入的 state 对象
 * @returns {string[]} 校验错误列表（空数组表示通过）
 */
function validateStateSchema(state) {
  const errors = [];
  const allKnownKeys = new Set();
  for (const keys of Object.values(DOCUMENT_KEYS)) {
    for (const k of keys) allKnownKeys.add(k);
  }
  // Check for unknown keys (keys in state not covered by any document type)
  for (const key of Object.keys(state || {})) {
    if (!allKnownKeys.has(key) && key !== 'meta') {
      errors.push(`Unknown state key "${key}" — not mapped in DOCUMENT_KEYS`);
    }
  }
  return errors;
}

module.exports = {
  // 存储与锁
  LOCK_TIMEOUT_MS,
  LOCK_RETRY_MS,
  LOCK_RETRY_MAX,
  // HTTP 与网络
  MAX_BODY_SIZE,
  MAX_SSE_CLIENTS,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_RETRY_MS,
  // 调度引擎
  BRIEFING_DAYS,
  MAX_SCHEDULE_DAYS,
  EXERCISE_DURATION_MIN,
  MIN_LATEST_TASK_HOUR,
  DEFAULT_DAILY_HOURS,
  // 价值观与置信度
  CONFIDENCE_BASE,
  CONFIDENCE_PER_SIGNAL,
  MAX_SIGNALS,
  // 渲染与防抖
  RENDER_DEBOUNCE_MS,
  ECHO_SUPPRESSION_MS,
  RENDER_LOCK_TIMEOUT_MS,
  // 笔记信号
  HEALTH_NEGATIVE_DECAY,
  HEALTH_NEGATIVE_MAX,
  EMOTIONAL_STRESS_DECAY,
  EMOTIONAL_STRESS_MAX,
  POSITIVE_SIGNAL_GAIN,
  POSITIVE_SIGNAL_MAX,
  INTENSITY_MODIFIER_MIN,
  // 文件监听
  FILE_WATCH_DEBOUNCE_MS,
  // 日志
  LOG_MAX_SIZE,
  LOG_MAX_AGE_DAYS,
  // 文档类型与字段 (Task 1.3)
  DOCUMENT_KEYS,
  GOAL_INDEX_FIELDS,
  NOTE_INDEX_FIELDS,
  pickIndexFields,
  validateStateSchema,
};
