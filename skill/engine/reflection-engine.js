/**
 * engine/reflection-engine.js
 *
 * Reflection Engine — 每日复盘机制。
 *
 * 分析当天完成的行动、attention 信号变化、目标进度，
 * 输出结构化复盘数据，供 AI 更新 goals 的状态信号、障碍和下一步。
 *
 * 反馈权重：
 *   - 当天完成的行动 → 目标进度指标
 *   - Attention signal 变化 → 是否需要调整
 *   - 连续未完成 → 动量/信心变化
 *
 * 纯计算层，输出建议由 AI 决定是否采纳；唯一例外是 runMemoryLifecycle，它会就地迁移实体的 lifecycle 状态字段（active→stale→archived），调用方需在锁内调用并持久化结果。
 */

'use strict';

const DateUtils = require('./date-utils');

// ─── Helpers ──────────────────────────────────────────────────────────────

function todayStr() {
  return DateUtils.todayStr();
}

function daysAgo(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return Math.round((new Date() - d) / 86400000);
}

// ─── Core: generateReflection ─────────────────────────────────────────────

/**
 * Generate a structured daily reflection.
 *
 * @param {Object} state - Full application state
 * @param {Object} [opts]
 * @param {string} [opts.date] - The date to reflect on (default: today)
 * @param {string} [opts.lang='zh'] - Language for summaries
 * @returns {Object} Structured reflection data
 */
function generateReflection(state, opts = {}) {
  const lang = opts.lang || 'zh';
  const date = opts.date || todayStr();

  const result = {
    date,
    generatedAt: new Date().toISOString(),

    // 1. 今日完成分析
    completedToday: analyzeCompletedToday(state, date, lang),

    // 2. 目标健康度
    goalHealth: analyzeGoalHealth(state, lang),

    // 3. 注意力变化
    attentionShift: analyzeAttentionShift(state, lang),

    // 4. 待办建议（AI 决定是否采纳）
    suggestions: [],
  };

  // 5. 基于分析生成建议
  result.suggestions = generateSuggestions(result, lang);

  // P1-1.4: Run memory lifecycle management as part of daily reflection
  result.lifecycle = runMemoryLifecycle(state);

  return result;
}

// ─── Analysis: Completed Today ─────────────────────────────────────────────

function analyzeCompletedToday(state, date, lang) {
  const actions = state.completedActions || [];
  const today = date;

  const completedOnDate = actions.filter(a => {
    if (!a.completedAt) return false;
    return a.completedAt.startsWith(today);
  });

  const byCategory = {};
  const oneTime = [];
  const recurring = [];

  for (const action of completedOnDate) {
    const cat = action.category || 'misc';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    if (action.pattern === 'recurring') recurring.push(action);
    else oneTime.push(action);
  }

  return {
    totalCount: completedOnDate.length,
    oneTimeCount: oneTime.length,
    recurringCount: recurring.length,
    byCategory,
    items: completedOnDate.map(a => ({
      id: a.id,
      title: a.title,
      pattern: a.pattern,
      outcome: a.outcome,
      summary: a.summary,
    })),
    summary: lang === 'zh'
      ? `今天完成了 ${completedOnDate.length} 件事（${oneTime.length} 一次性，${recurring.length} 周期性）`
      : `Completed ${completedOnDate.length} items today (${oneTime.length} one-time, ${recurring.length} recurring)`,
  };
}

// ─── Analysis: Goal Health ──────────────────────────────────────────────────

function analyzeGoalHealth(state, lang) {
  const allGoals = [
    ...(state.currentGoals || []).filter(g => !g.completed),
    ...(state.strategicGoals || []).filter(g => !g.completed),
  ];

  const health = [];

  for (const goal of allGoals) {
    const entry = {
      id: goal.id,
      type: goal.type === 'strategicGoal' ? 'strategicGoal' : 'currentGoal',
      title: goal.title,
      statusSignal: goal.statusSignal || null,
      statusReason: goal.statusReason || null,
      obstacle: goal.obstacle || null,
      daysSinceUpdate: goal.updatedAt ? daysAgo(goal.updatedAt) : null,
    };

    // Goal health is expressed as explainable signals, never a synthetic number.
    entry.healthSignals = [];
    if (goal.obstacle) {
      entry.healthSignals.push({ type: 'blocked', reason: lang === 'zh' ? '存在待解决障碍' : 'Has an unresolved obstacle' });
    }
    if (!goal.nextStep) {
      entry.healthSignals.push({ type: 'next_step_missing', reason: lang === 'zh' ? '缺少明确下一步' : 'No explicit next step' });
    }
    if (entry.daysSinceUpdate !== null && entry.daysSinceUpdate > 14) {
      entry.healthSignals.push({ type: 'stale', reason: lang === 'zh' ? `已 ${entry.daysSinceUpdate} 天未更新` : `No update for ${entry.daysSinceUpdate} days` });
    } else if (entry.daysSinceUpdate !== null && entry.daysSinceUpdate > 7) {
      entry.healthSignals.push({ type: 'drifting', reason: lang === 'zh' ? `${entry.daysSinceUpdate} 天没有推进记录` : `No progress record for ${entry.daysSinceUpdate} days` });
    }
    if (goal.statusSignal === 'needs_confirmation') {
      entry.healthSignals.push({ type: 'needs_confirmation', reason: goal.statusReason || (lang === 'zh' ? '仍有关键情况待确认' : 'Key context still needs confirmation') });
    }
    if (goal.statusSignal === 'at_risk') {
      entry.healthSignals.push({ type: 'at_risk', reason: goal.statusReason || (lang === 'zh' ? '存在需要处理的风险' : 'There is a risk to address') });
    }
    if (goal.nextStep && entry.healthSignals.length === 0) {
      entry.healthSignals.push({ type: 'on_track', reason: lang === 'zh' ? '有明确下一步，持续观察' : 'Has a next step; continue monitoring' });
    }
    entry.needsAttention = entry.healthSignals.some(signal => signal.type !== 'on_track');
    health.push(entry);
  }

  // Put explicit risks first, without converting the signals into a hidden number.
  const signalOrder = ['blocked', 'at_risk', 'needs_confirmation', 'stale', 'drifting', 'next_step_missing', 'on_track'];
  const minSignalOrder = (signals) => {
    if (!signals || signals.length === 0) return signalOrder.length;
    return Math.min(...signals.map(s => signalOrder.indexOf(s.type)));
  };
  health.sort((a, b) => minSignalOrder(a.healthSignals) - minSignalOrder(b.healthSignals));

  return {
    totalGoals: allGoals.length,
    needsAttention: health.filter(g => g.needsAttention),
    items: health,
  };
}

// ─── Analysis: Attention Shift ────────────────────────────────────────────

function analyzeAttentionShift(state, lang) {
  // 分析 attention signals 的总体特征
  const decisions = state.decisions || [];
  const pendingDecisions = decisions.filter(d => d.status === 'pending');
  const recentDecisions = decisions.filter(d => {
    if (!d.createdAt) return false;
    return daysAgo(d.createdAt) <= 7;
  });

  const conflicts = state.conflicts || [];
  const unresolvedConflicts = conflicts.filter(c => !c.resolved);

  const notes = state.notes || [];
  const staleNotes = notes.filter(n => {
    if (!n.createdAt) return false;
    const days = daysAgo(n.createdAt);
    return days >= 25 && days < 180;
  });

  return {
    pendingDecisionsCount: pendingDecisions.length,
    recentDecisionsCount: recentDecisions.length,
    unresolvedConflictsCount: unresolvedConflicts.length,
    staleNotesCount: staleNotes.length,
    decisionTrend: lang === 'zh'
      ? (recentDecisions.length > 3 ? '本周决策频繁，可能需要回顾' : recentDecisions.length === 0 ? '本周无新决策' : '正常决策节奏')
      : (recentDecisions.length > 3 ? 'High decision volume this week, may need review' : recentDecisions.length === 0 ? 'No new decisions this week' : 'Normal decision pace'),
    cleanupNeeded: staleNotes.length > 5 || unresolvedConflicts.length > 0,
    summary: lang === 'zh'
      ? `${pendingDecisions.length} 个待决事项，${unresolvedConflicts.length} 个未解决冲突，${staleNotes.length} 条沉寂笔记`
      : `${pendingDecisions.length} pending decisions, ${unresolvedConflicts.length} unresolved conflicts, ${staleNotes.length} stale notes`,
  };
}

// ─── Suggestion Generation ───────────────────────────────────────────────

function generateSuggestions(reflection, lang) {
  const suggestions = [];

  // 1. 带关注信号的目标建议
  for (const goal of reflection.goalHealth.needsAttention) {
    if (goal.obstacle && !goal.nextStep) {
      suggestions.push({
        type: 'goal_unblock',
        targetId: goal.id,
        targetType: goal.type,
        title: goal.title,
        message: lang === 'zh'
          ? `「${goal.title}」有障碍但无下一步，建议讨论解决方案`
          : `"${goal.title}" has an obstacle but no next step. Suggest discussing a solution.`,
        action: 'ask_user_about_obstacle',
        urgency: 'high',
      });
    } else if (goal.daysSinceUpdate > 7 && !goal.obstacle) {
      suggestions.push({
        type: 'goal_momentum',
        targetId: goal.id,
        targetType: goal.type,
        title: goal.title,
        message: lang === 'zh'
          ? `「${goal.title}」${goal.daysSinceUpdate} 天无推进，是否仍然相关？`
          : `"${goal.title}" has no progress for ${goal.daysSinceUpdate} days. Still relevant?`,
        action: 'check_relevance',
        urgency: 'medium',
      });
    }
  }

  // 2. 待决事项建议
  if (reflection.attentionShift.pendingDecisionsCount > 0) {
    suggestions.push({
      type: 'decision_pending',
      message: lang === 'zh'
        ? `有 ${reflection.attentionShift.pendingDecisionsCount} 个待决事项需要处理`
        : `${reflection.attentionShift.pendingDecisionsCount} pending decisions need resolution`,
      action: 'surface_pending_decisions',
      urgency: 'medium',
    });
  }

  // 3. 清理建议
  if (reflection.attentionShift.cleanupNeeded) {
    suggestions.push({
      type: 'cleanup',
      message: lang === 'zh'
        ? '有沉寂笔记和/或未解决冲突需要清理'
        : 'Stale notes and/or unresolved conflicts need cleanup',
      action: 'suggest_cleanup',
      urgency: 'low',
    });
  }

  // 4. 待确认目标建议
  for (const goal of reflection.goalHealth.items) {
    if (goal.statusSignal === 'needs_confirmation' && goal.needsAttention) {
      suggestions.push({
        type: 'goal_needs_confirmation',
        targetId: goal.id,
        targetType: goal.type,
        title: goal.title,
        message: lang === 'zh'
          ? `「${goal.title}」仍有关键情况待确认，建议先补齐信息再决定后续策略。`
          : `"${goal.title}" still has key context to confirm. Gather that information before deciding the next strategy.`,
        action: 'discuss_strategy',
        urgency: 'medium',
      });
    }
  }

  const urgencyOrder = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  return suggestions;
}

// ─── Memory Lifecycle Management (P1-1.4) ───────────────────────────────────

/**
 * Run memory lifecycle management: migrate entities through lifecycle states.
 * Called daily by the Reflection Engine.
 *
 * Lifecycle: active → stale → archived
 * - active → stale: no access for 30+ days
 * - stale → archive-candidate: stale for > 150 days; archive requires an
 *   explicit user-approved action and is never performed by reflection alone.
 * - Archived entities exit Attention rotation but remain searchable.
 *
 * @param {Object} state - Full application state (will be mutated)
 * @returns {Object} Summary of lifecycle transitions
 */
function runMemoryLifecycle(state) {
  const STALE_THRESHOLD_DAYS = 30;
  const ARCHIVE_THRESHOLD_DAYS = 150;
  const transitions = { notes: { toStale: 0, archiveCandidates: 0 }, goals: { toStale: 0, archiveCandidates: 0 }, decisions: { toStale: 0, archiveCandidates: 0 } };

  const processEntity = (entity) => {
    if (!entity) return;
    const current = entity.lifecycleState || 'active';
    if (current === 'archived') return;

    const refDate = entity.lastAccessedAt || entity.updatedAt || entity.createdAt;
    if (!refDate) return;

    const daysSinceAccess = daysAgo(refDate);
    if (daysSinceAccess === null) return;

    if (current === 'active') {
      if (daysSinceAccess >= STALE_THRESHOLD_DAYS) {
        entity.lifecycleState = 'stale';
        entity.staleSince = new Date().toISOString();
        return 'toStale';
      }
    } else if (current === 'stale') {
      const staleDays = daysAgo(entity.staleSince);
      if (staleDays !== null && staleDays >= ARCHIVE_THRESHOLD_DAYS) {
        // Lifecycle is allowed to reduce attention, not to hide knowledge by
        // itself. Keep the item searchable and make the possible cleanup
        // explicit for a later assistant/user decision.
        if (!entity.archiveSuggestedAt) entity.archiveSuggestedAt = new Date().toISOString();
        return 'archiveCandidate';
      }
    }
    return null;
  };

  // Process notes
  for (const note of (state.notes || [])) {
    const result = processEntity(note);
    if (result === 'toStale') transitions.notes.toStale++;
    else if (result === 'archiveCandidate') transitions.notes.archiveCandidates++;
  }

  // Active goals must remain planning inputs even if no conversation opened
  // their detail recently. Only completed goals may become low-attention stale.
  for (const goal of [...(state.currentGoals || []), ...(state.strategicGoals || [])]) {
    if (!goal.completed) continue;
    const result = processEntity(goal);
    if (result === 'toStale') transitions.goals.toStale++;
    else if (result === 'archiveCandidate') transitions.goals.archiveCandidates++;
  }

  // Process decisions (only non-pending)
  for (const decision of (state.decisions || [])) {
    if (decision.status === 'pending') continue;
    const result = processEntity(decision);
    if (result === 'toStale') transitions.decisions.toStale++;
    else if (result === 'archiveCandidate') transitions.decisions.archiveCandidates++;
  }

  return {
    executedAt: new Date().toISOString(),
    transitions,
    totalArchived: 0,
    totalArchiveCandidates: transitions.notes.archiveCandidates + transitions.goals.archiveCandidates + transitions.decisions.archiveCandidates,
  };
}

module.exports = {
  generateReflection,
  runMemoryLifecycle,
};
