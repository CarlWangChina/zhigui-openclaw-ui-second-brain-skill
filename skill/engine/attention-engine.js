/**
 * engine/attention-engine.js
 *
 * Layer 1 · Attention Engine — 把海量索引压缩成"今天值得思考的少数对象"。
 *
 * 纯数学计算层，不依赖 LLM 推理。每次对话开始时调用 computeAttention()，
 * 返回带 Signal 和 Reasons 的 AttentionObject 列表。
 *
 * Signal 类型：
 *   - deadline       : 目标/任务即将到期
 *   - overdue        : 已逾期
 *   - momentum_lost  : 连续多天无推进
 *   - blocked        : 遇到阻塞/障碍
 *   - need_decision  : 需要用户决策
 *   - conflict       : 价值观/优先级冲突
 *   - stale          : 实体长期未交互（即将归档）
 *   - importance     : 实体本身重要性高（无其他信号时兜底）
 *   - recurrence_due : 周期性行动即将到期
 *   - hint_followup  : 主动回溯提示（已完成行动的后续关注）
 *
 * 注意：这是一个引擎层，AI 仍然可以通过 Layer 0 自由扫描全量索引。
 * Attention 只是预计算的一层"值得注意"信号，帮助 AI 快速聚焦。
 */

'use strict';

const DateUtils = require('./date-utils');

// ─── Signal type constants ──────────────────────────────────────────────

// PERF #24: Module-level cache for computeAttention. The function is pure but
// expensive; within a single conversation it may be called multiple times with
// the same state. Cache key combines stateVersion + lang (the most impactful opt).
let _attentionCache = { stateVersion: null, lang: null, result: null };

const SIGNAL_TYPES = {
  DEADLINE: 'deadline',
  OVERDUE: 'overdue',
  MOMENTUM_LOST: 'momentum_lost',
  BLOCKED: 'blocked',
  NEED_DECISION: 'need_decision',
  CONFLICT: 'conflict',
  STALE: 'stale',
  IMPORTANCE: 'importance',
  RECURRENCE_DUE: 'recurrence_due',
  HINT_FOLLOWUP: 'hint_followup',
};

// Signal type to display label (zh/en)
const SIGNAL_LABELS = {
  deadline: { zh: '即将到期', en: 'Deadline' },
  overdue: { zh: '已逾期', en: 'Overdue' },
  momentum_lost: { zh: '动量丢失', en: 'Momentum Lost' },
  blocked: { zh: '阻塞中', en: 'Blocked' },
  need_decision: { zh: '待决策', en: 'Need Decision' },
  conflict: { zh: '冲突', en: 'Conflict' },
  stale: { zh: '沉寂', en: 'Stale' },
  importance: { zh: '重要性', en: 'Importance' },
  recurrence_due: { zh: '周期到期', en: 'Recurrence Due' },
  hint_followup: { zh: '主动回溯', en: 'Follow-up Hint' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function todayStr() {
  return DateUtils.todayStr();
}

function daysBetween(dateStr) {
  if (!dateStr) return null;
  return DateUtils.daysBetween(dateStr);
}

function daysAgo(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  return Math.round((now - d) / 86400000);
}

/**
 * Clamp a value to [lo, hi] and round to integer.
 * @param {number} v
 * @param {number} [lo=0]
 * @param {number} [hi=100]
 * @returns {number}
 */
function clamp(v, lo, hi) {
  lo = lo === undefined ? 0 : lo;
  hi = hi === undefined ? 100 : hi;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * Build a human-readable reason string.
 * @param {string} template - e.g. 'DDL in {days} days'
 * @param {Object} params - key-value replacements
 * @returns {string}
 */
function reason(template, params) {
  let s = template;
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(`{${k}}`, v);
  }
  return s;
}

// ─── Core: computeAttention ──────────────────────────────────────────────

/**
 * Compute the attention signals for the current day.
 *
 * This is a pure function: given the full state, it produces a sorted list
 * of AttentionObjects with signals and reasons. It does NOT mutate state.
 *
 * @param {Object} state - Full application state
 * @param {Object} [opts]
 * @param {string} [opts.lang='zh'] - Language for reason strings ('zh' | 'en')
 * @param {number} [opts.maxResults=50] - Maximum attention objects to return
 * @param {number} [opts.deadlineDays=7] - Days threshold for deadline signal
 * @param {number} [opts.momentumDays=5] - Days threshold for momentum_lost signal
 * @param {number} [opts.staleDays=25] - Days threshold for stale signal
 * @param {number} [opts.archiveDays=180] - Days threshold for archive (excluded from attention)
 * @returns {{ signals: Array<AttentionObject>, meta: Object }}
 */
function computeAttention(state, opts = {}) {
  // PERF #24: Check cache — if state hasn't changed and lang matches, return cached result.
  // Only cache when opts are at their defaults (excluding lang) to avoid stale results
  // when callers pass custom thresholds.
  const lang = opts.lang || 'zh';
  const stateVersion = state.meta?.stateVersion;
  const optsAreDefault = opts.maxResults === undefined
    && opts.deadlineDays === undefined
    && opts.momentumDays === undefined
    && opts.staleDays === undefined
    && opts.archiveDays === undefined;
  if (stateVersion !== undefined && optsAreDefault
      && _attentionCache.stateVersion === stateVersion
      && _attentionCache.lang === lang
      && _attentionCache.result) {
    return _attentionCache.result;
  }

  const maxResults = opts.maxResults || 50;
  const deadlineDays = opts.deadlineDays || 7;
  const momentumDays = opts.momentumDays || 5;
  const staleDays = opts.staleDays || 25;
  const archiveDays = opts.archiveDays || 180;

  const today = todayStr();
  const signals = [];

  // P1-1.5: Filter out archived entities — they exited the attention rotation
  // but remain searchable via explicit search tools.
  const isActive = entity => !entity.lifecycleState || entity.lifecycleState === 'active' || entity.lifecycleState === 'stale';

  // ── 1. Goals: deadline, overdue, momentum_lost, blocked ──

  const allGoals = [
    ...(state.currentGoals || []).filter(g => !g.completed && isActive(g)),
    ...(state.strategicGoals || []).filter(g => !g.completed && isActive(g)),
  ];

  for (const goal of allGoals) {
    const obj = { id: goal.id, type: goal.type === 'strategicGoal' ? 'strategicGoal' : 'currentGoal', title: goal.title || '' };
    const reasons = [];
    let maxStrength = 0;

    // Deadline signal
    const dl = goal.deadline ? daysBetween(goal.deadline) : null;
    if (dl !== null && dl <= 0) {
      const strength = clamp(90 + Math.min(Math.abs(dl) * 5, 10));
      reasons.push(reason(lang === 'zh' ? '已逾期 {days} 天' : 'Overdue by {days} days', { days: Math.abs(dl) }));
      signals.push({ ...obj, signalType: SIGNAL_TYPES.OVERDUE, signalStrength: strength, signalOrder: strength, attentionReasons: [...reasons] });
      maxStrength = strength;
    } else if (dl !== null && dl <= deadlineDays) {
      const strength = clamp(70 + (deadlineDays - dl) * 3);
      reasons.push(reason(lang === 'zh' ? '{days} 天后到期' : 'Deadline in {days} days', { days: dl }));
      signals.push({ ...obj, signalType: SIGNAL_TYPES.DEADLINE, signalStrength: strength, signalOrder: strength, attentionReasons: [...reasons] });
      maxStrength = strength;
    }

    // Momentum lost: no progress in recent days
    if (goal.updatedAt) {
      const daysSinceUpdate = daysAgo(goal.updatedAt);
      if (daysSinceUpdate !== null && daysSinceUpdate >= momentumDays && maxStrength < 60) {
        const strength = clamp(50 + (daysSinceUpdate - momentumDays) * 2, 50, 85);
        reasons.push(reason(lang === 'zh' ? '{days} 天无推进' : 'No progress for {days} days', { days: daysSinceUpdate }));
        signals.push({ ...obj, signalType: SIGNAL_TYPES.MOMENTUM_LOST, signalStrength: strength, signalOrder: strength, attentionReasons: [...reasons] });
      }
    }

    // Blocked signal (from goal's obstacle field if set)
    if (goal.obstacle && maxStrength < 70) {
      const strength = clamp(65);
      reasons.push(goal.obstacle);
      signals.push({ ...obj, signalType: SIGNAL_TYPES.BLOCKED, signalStrength: strength, signalOrder: strength, attentionReasons: [...reasons] });
    }

    // A decision is needed but there is no current plan.
    if (goal.needsDecision === true && maxStrength < 50) {
      const todayTasks = (state.schedule?.days?.[today]?.tasks || []).filter(t => t.relatedGoalId === goal.id && !t.completed);
      if (todayTasks.length === 0) {
        const strength = clamp(55);
        reasons.push(lang === 'zh' ? '需要决策但今日无安排' : 'Needs a decision but is unscheduled today');
        signals.push({ ...obj, signalType: SIGNAL_TYPES.NEED_DECISION, signalStrength: strength, signalOrder: strength, attentionReasons: [...reasons] });
      }
    }

    // Importance: strategic goals without other signals still need ongoing attention
    if (maxStrength === 0 && goal.type === 'strategicGoal') {
      const strength = clamp(40);
      signals.push({ ...obj, signalType: SIGNAL_TYPES.IMPORTANCE, signalStrength: strength, signalOrder: strength, attentionReasons: [lang === 'zh' ? '战略目标需要持续关注' : 'Strategic goal needs ongoing attention'] });
    }
  }

  // ── 2. Errands: deadline, recurrence_due ──

  const activeErrands = (state.errands || []).filter(e => !e.completed && isActive(e));
  for (const errand of activeErrands) {
    const obj = { id: errand.id, type: 'errand', title: errand.title || '' };
    const reasons = [];

    if (errand.date) {
      const days = daysBetween(errand.date);
      if (days !== null && days < 0) {
        const strength = clamp(85 + Math.min(Math.abs(days) * 3, 15));
        reasons.push(reason(lang === 'zh' ? '已过期 {days} 天' : 'Overdue by {days} days', { days: Math.abs(days) }));
        signals.push({ ...obj, signalType: SIGNAL_TYPES.OVERDUE, signalStrength: strength, signalOrder: strength, attentionReasons: reasons });
      } else if (days !== null && days === 0) {
        const strength = clamp(80);
        reasons.push(lang === 'zh' ? '今天到期' : 'Due today');
        signals.push({ ...obj, signalType: SIGNAL_TYPES.DEADLINE, signalStrength: strength, signalOrder: strength, attentionReasons: reasons });
      } else if (days !== null && days <= 2) {
        const strength = clamp(65);
        reasons.push(reason(lang === 'zh' ? '{days} 天后到期' : 'Due in {days} days', { days }));
        signals.push({ ...obj, signalType: SIGNAL_TYPES.DEADLINE, signalStrength: strength, signalOrder: strength, attentionReasons: reasons });
      }
    }

    // Recurrence due: recurring errand approaching next occurrence (3-7 days)
    if (errand.pattern === 'recurring' && errand.date) {
      const rDays = daysBetween(errand.date);
      if (rDays !== null && rDays > 2 && rDays <= 7) {
        const strength = clamp(50);
        reasons.push(reason(lang === 'zh' ? '周期性任务 {days} 天后到期' : 'Recurring task due in {days} days', { days: rDays }));
        signals.push({ ...obj, signalType: SIGNAL_TYPES.RECURRENCE_DUE, signalStrength: strength, signalOrder: strength, attentionReasons: [...reasons] });
      }
    }

    // Must-level commitments without a date need scheduling.
    if (errand.commitmentLevel === 'must' && !errand.date) {
      const strength = clamp(60);
      const existingReasons = signals.find(s => s.id === errand.id)?.attentionReasons || [];
      if (existingReasons.length === 0) {
        signals.push({ ...obj, signalType: SIGNAL_TYPES.NEED_DECISION, signalStrength: strength, signalOrder: strength, attentionReasons: [lang === 'zh' ? '必办事项未安排日期' : 'Must-do without a date'] });
      }
    }

    // Importance: must-level errands without other signals still need attention
    const hasErrandSignal = signals.some(s => s.id === errand.id);
    if (!hasErrandSignal && errand.commitmentLevel === 'must') {
      const strength = clamp(45);
      signals.push({ ...obj, signalType: SIGNAL_TYPES.IMPORTANCE, signalStrength: strength, signalOrder: strength, attentionReasons: [lang === 'zh' ? '必办事项需要安排' : 'Must-do item needs scheduling'] });
    }
  }

  // ── 3. Notes: lifecycle signals ──

  const notes = (state.notes || []).filter(isActive);
  for (const note of notes) {
    const obj = { id: note.id, type: 'note', title: note.title || '' };

    // Stale notes approaching archive
    // P1-1.2: Use lastAccessedAt as primary stale indicator, fallback to createdAt
    const staleRefDate = note.lastAccessedAt || note.updatedAt || note.createdAt;
    if (staleRefDate) {
      const daysSinceAccessed = daysAgo(staleRefDate);
      if (daysSinceAccessed !== null && daysSinceAccessed >= staleDays && daysSinceAccessed < archiveDays) {
        const strength = clamp(40 + (daysSinceAccessed - staleDays));
        signals.push({ ...obj, signalType: SIGNAL_TYPES.STALE, signalStrength: strength, signalOrder: strength, attentionReasons: [reason(lang === 'zh' ? '{days} 天未引用，即将归档' : 'Unused for {days} days, approaching archive', { days: daysSinceAccessed })] });
      }
    }
  }

  // ── 4. Decisions: pending, expiring ──

  const decisions = (state.decisions || []).filter(isActive);
  for (const decision of decisions) {
    if (decision.status !== 'pending') continue;
    const obj = { id: decision.id, type: 'decision' };
    const reasons = [];

    if (decision.expiresAt && new Date(decision.expiresAt) < new Date()) {
      reasons.push(lang === 'zh' ? '决策已过期，需要处理' : 'Decision expired, needs resolution');
      signals.push({ ...obj, signalType: SIGNAL_TYPES.NEED_DECISION, signalStrength: clamp(75), signalOrder: 75, attentionReasons: reasons });
    } else {
      reasons.push(lang === 'zh' ? '有待决定的事项' : 'Pending decision');
      signals.push({ ...obj, signalType: SIGNAL_TYPES.NEED_DECISION, signalStrength: clamp(55), signalOrder: 55, attentionReasons: reasons });
    }
  }

  // ── 5. Explicit follow-ups ─────────────────────────────────────────────
  // Do not infer a follow-up from every one-time completion.  The assistant
  // creates a follow-up only after it understands the completed action.
  const followUpToday = todayStr();
  for (const followUp of (state.followUps || [])) {
    const rawDue = String(followUp.dueDate || followUp.dueAt || '');
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDue)
      ? rawDue
      : (!Number.isNaN(new Date(rawDue).getTime()) ? DateUtils.formatDate(new Date(rawDue)) : null);
    if (followUp.status !== 'pending' || !dueDate || dueDate > followUpToday) continue;
    const obj = { id: followUp.id, type: 'followUp' };
    signals.push({
      ...obj, signalType: SIGNAL_TYPES.HINT_FOLLOWUP, signalStrength: 65, signalOrder: 65,
      attentionReasons: [followUp.reason || followUp.question || (lang === 'zh' ? '有待跟进事项' : 'A follow-up is due')],
    });
  }

  // ── 6. Conflicts: existing detected conflicts ──

  const conflicts = state.conflicts || [];
  for (const conflict of conflicts) {
    // Only surface unresolved conflicts
    if (conflict.resolved) continue;
    const obj = { id: conflict.id || `conflict_${Date.now()}`, type: 'conflict', title: conflict.title || conflict.description || '' };
    const strength = clamp(conflict.severity === 'error' ? 85 : conflict.severity === 'warning' ? 70 : 55);
    signals.push({ ...obj, signalType: SIGNAL_TYPES.CONFLICT, signalStrength: strength, signalOrder: strength, attentionReasons: [conflict.description || conflict.title] });
  }

  // ── Sort by internal signal order, limit to maxResults ──

  signals.sort((a, b) => b.signalStrength - a.signalStrength);

  // Deduplicate: keep the strongest signal per entity id
  const seen = new Set();
  const deduped = [];
  for (const s of signals) {
    const key = `${s.type}:${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { signalOrder, ...publicSignal } = s;
    deduped.push({ ...publicSignal, attentionRank: deduped.length + 1 });
    if (deduped.length >= maxResults) break;
  }

  const meta = {
    computedAt: new Date().toISOString(),
    totalSignalsBeforeDedup: signals.length,
    returnedCount: deduped.length,
    thresholds: { deadlineDays, momentumDays, staleDays, archiveDays },
  };

  const result = { signals: deduped, meta };

  // PERF #24: Cache the result for this stateVersion + lang combination
  if (stateVersion !== undefined && optsAreDefault) {
    _attentionCache = { stateVersion, lang, result };
  }

  return result;
}

// ─── Convenience: getAttentionForBriefing ───────────────────────────────

/**
 * Extract a compact attention summary suitable for embedding in morning briefing data.
 * Returns only the top signals grouped by type, without full reason arrays.
 *
 * @param {Object} state - Full application state
 * @param {Object} [opts] - Same options as computeAttention
 * @returns {Object} Compact attention summary
 */
function getAttentionSummary(state, opts = {}) {
  const { signals, meta } = computeAttention(state, opts);

  // Group by signalType
  const byType = {};
  for (const s of signals) {
    if (!byType[s.signalType]) byType[s.signalType] = [];
    byType[s.signalType].push({
      id: s.id,
      type: s.type,
      title: s.title || '',
      signalStrength: s.signalStrength,
      attentionRank: s.attentionRank,
    });
  }

  return {
    computedAt: meta.computedAt,
    totalEntities: meta.returnedCount,
    topSignals: signals.slice(0, 10), // Top 10 with full reasons for AI
    byType,
    meta,
  };
}

// ─── Convenience: getAttentionForObject ─────────────────────────────────

/**
 * Get the attention signals for a specific entity (e.g. when AI drills into a goal).
 *
 * @param {Object} state - Full application state
 * @param {string} entityId - The entity ID to check
 * @param {Object} [opts]
 * @returns {Array<AttentionObject>} All signals for this entity
 */
function getAttentionForObject(state, entityId, opts = {}) {
  const { signals } = computeAttention(state, opts);
  return signals.filter(s => s.id === entityId);
}

module.exports = {
  SIGNAL_TYPES,
  computeAttention,
  getAttentionSummary,
};
