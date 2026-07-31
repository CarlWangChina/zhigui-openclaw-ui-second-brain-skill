#!/usr/bin/env node
'use strict';

// Creates a small, clearly labelled demo workspace without overwriting an
// existing workspace. It is useful for first-run walkthroughs and dashboard QA.

const { loadConfig } = require('../lib/config');
const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');
const DateUtils = require('../engine/date-utils');
const ReflectionEngine = require('../engine/reflection-engine');

const DEMO_SEED_VERSION = '2026-07-29-demo-v1';

function hasWorkspaceContent(state) {
  return [
    state.strategicGoals, state.currentGoals, state.constraints, state.notes,
    state.errands, state.decisions, state.reminders, state.completedActions,
    Object.values(state.schedule?.days || {}).flatMap(day => day?.tasks || []),
  ].some(list => Array.isArray(list) && list.length > 0);
}

function savedReflection(reflection) {
  return {
    date: reflection.date,
    generatedAt: reflection.generatedAt,
    suggestions: reflection.suggestions,
    lifecycle: reflection.lifecycle,
    completedToday: {
      totalCount: reflection.completedToday.totalCount,
      summary: reflection.completedToday.summary,
    },
    goalHealthNeedsAttention: (reflection.goalHealth.needsAttention || []).map(goal => ({
      id: goal.id, title: goal.title, type: goal.type, healthSignals: goal.healthSignals,
    })),
    attentionShift: {
      pendingDecisionsCount: reflection.attentionShift.pendingDecisionsCount,
      unresolvedConflictsCount: reflection.attentionShift.unresolvedConflictsCount,
      staleNotesCount: reflection.attentionShift.staleNotesCount,
      summary: reflection.attentionShift.summary,
    },
  };
}

function seedDemoData(dataDir = loadConfig().dataDir) {
  ensureDataInitialized(dataDir);
  Storage.setDataDir(dataDir);
  Actions.configure(dataDir);

  const initial = Storage.readFullState();
  if (initial.meta?.demoSeedVersion === DEMO_SEED_VERSION) {
    if (initial.lastReflection?.date) {
      return { seeded: false, reason: 'already-seeded', dataDir };
    }
    // Older builds could lose state-only fields when the topic index synced its
    // flat projection. Repair this known demo workspace without duplicating it.
    const reflectionDate = (initial.completedActions || []).find(action => action.scheduleDate)?.scheduleDate;
    if (!reflectionDate) throw new Error('演示数据不完整，且找不到可恢复的复盘日期。');
    const reflection = ReflectionEngine.generateReflection(initial, { date: reflectionDate, lang: 'zh' });
    initial.lastReflection = savedReflection(reflection);
    Storage.writeState(initial);
    return { seeded: false, reason: 'repaired-reflection', dataDir };
  }
  if (hasWorkspaceContent(initial)) {
    throw new Error('演示案例不会混入已有数据。请在空工作区运行，或先手动移除演示数据。');
  }

  const today = DateUtils.todayStr();
  const yesterday = DateUtils.nextDay(today, -1);
  const tomorrow = DateUtils.nextDay(today, 1);
  const twoDaysLater = DateUtils.nextDay(today, 2);

  const healthNote = Actions.execute('note.add', {
    title: '示例｜家人复查的沟通要点', topic: '家庭健康', category: '健康记录', domain: 'health',
    content: '示例：本周电话确认复查时间、交通安排和需要携带的资料。若对方疲惫，先询问是否需要改到周末。',
    relatedDate: today,
  }).note;
  const deliveryNote = Actions.execute('note.add', {
    title: '示例｜项目演示的核心信息', topic: '项目交付', category: '工作笔记', domain: 'career',
    content: '示例：演示先说明用户价值，再展示可验证的链路；评审最关心数据一致性、日期切换和删除后的引用清理。',
    relatedDate: today,
  }).note;
  const planningNote = Actions.execute('note.add', {
    title: '示例｜安排原则：为重要关系预留缓冲', topic: '个人规划', category: '决策原则', domain: 'relationship',
    content: '示例：工作事项可压缩时，优先保留家庭沟通窗口；冲突时先给出可逆的调整方案。',
  }).note;

  const northStar = Actions.execute('goal.add', {
    type: 'strategicGoal', title: '示例｜兼顾可靠交付与家庭支持',
    description: '用可执行的计划完成工作关键节点，同时保留照顾家人的时间与精力。',
    why: '长期表现来自稳定的节奏，而不是持续透支。', nextStep: '先完成演示主线，再确认家人复查安排。',
    topic: '个人规划', domain: 'relationship', source: 'demo',
  }).goal;
  const deliveryGoal = Actions.execute('goal.add', {
    type: 'currentGoal', title: '示例｜完成本周项目演示准备',
    description: '演示内容可让评审快速验证关键能力。', relatedStrategicGoalId: northStar.id,
    deadline: twoDaysLater, nextStep: '今天完成演示主线和验收清单。',
    topic: '项目交付', domain: 'career', source: 'demo',
  }).goal;

  const decision = Actions.execute('decision.add', {
    title: '示例｜先完成演示主线，再安排可移动的沟通事项',
    description: '将高专注工作放在白天，家庭沟通放在晚间并留出改期空间。',
    evidence: '项目演示需要连续专注；家人复查更适合在晚间确认具体安排。', impact: '减少两类重要事项相互打断的概率。',
    relatedGoalIds: [northStar.id, deliveryGoal.id], relatedNoteIds: [deliveryNote.id, healthNote.id, planningNote.id],
    status: 'accepted', source: 'demo',
  }).decision;

  const completedYesterday = Actions.execute('task.add', {
    date: yesterday, time: '16:30', duration: 30, title: '示例｜确认演示范围',
    description: '已完成，用于查看昨日日期和复盘。', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: '演示范围以项目笔记和已采纳的安排决策为依据。',
  }).task;
  Actions.execute('task.toggle', { date: yesterday, taskId: completedYesterday.id, source: 'demo' });

  Actions.execute('task.add', {
    date: today, time: '09:30', duration: 90, title: '示例｜梳理项目演示主线',
    description: '从用户价值、关键链路到验收方式组织演示。', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: '使用项目交付笔记，并执行已采纳的优先级决策。',
  });
  Actions.execute('task.add', {
    date: today, time: '14:30', duration: 45, title: '示例｜核对跨主题关联是否可追溯',
    description: '验证一个行程可以同时引用工作和家庭主题下的笔记。', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id, healthNote.id, planningNote.id], decisionIds: [decision.id], source: 'demo', retention: 'memory',
    contextReason: '这条示例刻意关联三个不同主题的笔记，便于查看关系图和上下文卡片。',
  });
  Actions.execute('task.add', {
    date: today, time: '20:00', duration: 25, title: '示例｜电话确认家人复查安排',
    description: '若不方便沟通，记录原因并改到周末。', relatedGoalId: northStar.id, topicId: healthNote.topicId,
    noteIds: [healthNote.id, planningNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: '家庭健康笔记提供事实，个人规划笔记提供安排原则。',
  });
  Actions.execute('task.add', {
    date: tomorrow, time: '10:00', duration: 45, title: '示例｜发送演示材料前的最终检查',
    description: '检查日期切换、删除引用和跨主题关联展示。', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: '从项目交付笔记提取验收重点。',
  });

  Actions.execute('errand.add', {
    title: '示例｜预约复查交通', date: today, duration: 20, commitmentLevel: 'must', category: 'health',
    note: '确认医院附近停车或公共交通方案。', topicId: healthNote.topicId, goalId: northStar.id,
    noteIds: [healthNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: '由家庭健康笔记和当前安排决策共同约束。',
  });
  Actions.execute('errand.add', {
    title: '示例｜整理可报销票据', duration: 20, commitmentLevel: 'nice', category: 'misc',
    note: '未安排时间，因此显示在待安排事项中。', source: 'demo', retention: 'transient',
  });

  Actions.execute('reminder.add', {
    title: '示例｜明早查看演示材料是否已发送', triggerAt: `${tomorrow}T09:00:00+08:00`,
    category: 'career', commitmentLevel: 'should', relatedGoalId: deliveryGoal.id, source: 'demo',
  });
  Actions.execute('briefing.set', {
    date: today,
    mustDo: ['完成项目演示主线。', '确认家人复查安排。'],
    recommended: ['下午验证跨主题笔记和行程关联。'],
    notRecommended: ['不要为了补充细节打断上午的连续专注时间。'],
    strategicReminder: ['工作交付与家庭支持都需要明确的时间边界和缓冲。'],
    dailyQuote: '示例：清晰的安排不是塞满时间，而是让重要的事有位置。', source: 'demo',
  });

  const finalState = Storage.readFullState();
  const yesterdayTask = finalState.schedule?.days?.[yesterday]?.tasks?.find(task => task.id === completedYesterday.id);
  const completedAction = finalState.completedActions?.find(action => action.taskId === completedYesterday.id);
  const completedAt = new Date(`${yesterday}T18:00:00+08:00`).toISOString();
  if (yesterdayTask) yesterdayTask.completedAt = completedAt;
  if (completedAction) completedAction.completedAt = completedAt;
  const reflection = ReflectionEngine.generateReflection(finalState, { date: yesterday, lang: 'zh' });
  finalState.lastReflection = savedReflection(reflection);
  finalState.meta = finalState.meta || {};
  finalState.meta.demoSeedVersion = DEMO_SEED_VERSION;
  finalState.meta.demoSeededAt = new Date().toISOString();
  Storage.writeState(finalState);

  return {
    seeded: true,
    dataDir,
    dates: { yesterday, today, tomorrow },
    examples: { notes: 3, goals: 2, decision: 1, scheduledDays: 3, reminders: 1 },
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(seedDemoData(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { DEMO_SEED_VERSION, seedDemoData };
