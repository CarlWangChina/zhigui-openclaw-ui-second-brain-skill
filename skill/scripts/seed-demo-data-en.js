#!/usr/bin/env node
'use strict';

// English version of demo data for English manual screenshots.

const { loadConfig } = require('../lib/config');
const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');
const DateUtils = require('../engine/date-utils');
const ReflectionEngine = require('../engine/reflection-engine');

const DEMO_SEED_VERSION = '2026-07-31-demo-en-v1';

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

function seedDemoDataEn(dataDir = loadConfig().dataDir) {
  ensureDataInitialized(dataDir);
  Storage.setDataDir(dataDir);
  Actions.configure(dataDir);

  const initial = Storage.readFullState();
  if (initial.meta?.demoSeedVersion === DEMO_SEED_VERSION) {
    return { seeded: false, reason: 'already-seeded-en', dataDir };
  }
  if (hasWorkspaceContent(initial)) {
    throw new Error('Workspace has existing data. Reset first with reset-data.js');
  }

  const today = DateUtils.todayStr();
  const yesterday = DateUtils.nextDay(today, -1);
  const tomorrow = DateUtils.nextDay(today, 1);
  const twoDaysLater = DateUtils.nextDay(today, 2);

  // Notes (English)
  const healthNote = Actions.execute('note.add', {
    title: 'Demo | Family follow-up appointment talking points', topic: 'Family Health', category: 'Health Records', domain: 'health',
    content: 'Demo: Call this week to confirm follow-up time, transportation, and documents to bring. If they seem tired, ask if weekend works better.',
    relatedDate: today,
  }).note;
  const deliveryNote = Actions.execute('note.add', {
    title: 'Demo | Key info for project presentation', topic: 'Project Delivery', category: 'Work Notes', domain: 'career',
    content: 'Demo: Lead with user value, then show verifiable workflow. Reviewers care most about data consistency, date switching, and reference cleanup.',
    relatedDate: today,
  }).note;
  const planningNote = Actions.execute('note.add', {
    title: 'Demo | Scheduling principle: buffer for important relationships', topic: 'Personal Planning', category: 'Decision Principles', domain: 'relationship',
    content: 'Demo: When work items can be compressed, protect family communication windows. On conflict, offer a reversible adjustment first.',
  }).note;

  // Goals (English)
  const northStar = Actions.execute('goal.add', {
    type: 'strategicGoal', title: 'Demo | Balance reliable delivery with family support',
    description: 'Use an executable plan to complete work milestones while protecting time and energy for family.',
    why: 'Sustainable performance comes from steady rhythm, not constant burnout.', nextStep: 'Finish the demo mainline first, then confirm family appointment.',
    topic: 'Personal Planning', domain: 'relationship', source: 'demo',
  }).goal;
  const deliveryGoal = Actions.execute('goal.add', {
    type: 'currentGoal', title: 'Demo | Complete project presentation prep this week',
    description: 'Demo content lets reviewers quickly verify key capabilities.', relatedStrategicGoalId: northStar.id,
    deadline: twoDaysLater, nextStep: 'Finish the demo mainline and acceptance checklist today.',
    topic: 'Project Delivery', domain: 'career', source: 'demo',
  }).goal;

  // Decision (English)
  const decision = Actions.execute('decision.add', {
    title: 'Demo | Finish presentation mainline first, then schedule flexible comms',
    description: 'Place deep-focus work during the day; handle family calls in the evening with room to reschedule.',
    evidence: 'The project demo needs continuous focus; family follow-up is better confirmed in the evening.', impact: 'Reduces mutual interruption between two important tracks.',
    relatedGoalIds: [northStar.id, deliveryGoal.id], relatedNoteIds: [deliveryNote.id, healthNote.id, planningNote.id],
    status: 'accepted', source: 'demo',
  }).decision;

  // Schedule (English)
  const completedYesterday = Actions.execute('task.add', {
    date: yesterday, time: '16:30', duration: 30, title: 'Demo | Confirm presentation scope',
    description: 'Completed, used for reviewing yesterday and reflection.', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: 'Scope based on project notes and the accepted prioritization decision.',
  }).task;
  Actions.execute('task.toggle', { date: yesterday, taskId: completedYesterday.id, source: 'demo' });

  Actions.execute('task.add', {
    date: today, time: '09:30', duration: 90, title: 'Demo | Outline project presentation mainline',
    description: 'Organize the demo around user value, key workflow, and acceptance criteria.', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: 'Using project delivery notes and executing the accepted priority decision.',
  });
  Actions.execute('task.add', {
    date: today, time: '14:30', duration: 45, title: 'Demo | Verify cross-topic traceability',
    description: 'Validate that one schedule item can reference notes from both work and family topics.', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id, healthNote.id, planningNote.id], decisionIds: [decision.id], source: 'demo', retention: 'memory',
    contextReason: 'This demo intentionally links three different-topic notes to showcase the relationship graph.',
  });
  Actions.execute('task.add', {
    date: today, time: '20:00', duration: 25, title: 'Demo | Call to confirm family appointment',
    description: 'If not a good time, note the reason and move to weekend.', relatedGoalId: northStar.id, topicId: healthNote.topicId,
    noteIds: [healthNote.id, planningNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: 'Family health note provides facts; personal planning note provides scheduling principles.',
  });
  Actions.execute('task.add', {
    date: tomorrow, time: '10:00', duration: 45, title: 'Demo | Final check before sending demo materials',
    description: 'Check date switching, delete references, and cross-topic linking.', relatedGoalId: deliveryGoal.id, topicId: deliveryNote.topicId,
    noteIds: [deliveryNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: 'Extract acceptance highlights from the project delivery note.',
  });

  // Errands (English)
  Actions.execute('errand.add', {
    title: 'Demo | Book transportation for appointment', date: today, duration: 20, commitmentLevel: 'must', category: 'health',
    note: 'Confirm parking or public transit near the hospital.', topicId: healthNote.topicId, goalId: northStar.id,
    noteIds: [healthNote.id], decisionIds: [decision.id], source: 'demo', retention: 'review',
    contextReason: 'Constrained by family health note and current scheduling decision.',
  });
  Actions.execute('errand.add', {
    title: 'Demo | Organize reimbursable receipts', duration: 20, commitmentLevel: 'nice', category: 'misc',
    note: 'No time scheduled, shows in unscheduled queue.', source: 'demo', retention: 'transient',
  });

  // Reminder (English)
  Actions.execute('reminder.add', {
    title: 'Demo | Check tomorrow morning if demo materials were sent', triggerAt: `${tomorrow}T09:00:00+08:00`,
    category: 'career', commitmentLevel: 'should', relatedGoalId: deliveryGoal.id, source: 'demo',
  });

  // Briefing (English)
  Actions.execute('briefing.set', {
    date: today,
    mustDo: ['Finish the project presentation mainline.', 'Confirm family follow-up appointment.'],
    recommended: ['This afternoon, verify cross-topic note and schedule links.'],
    notRecommended: ['Do not interrupt morning focus time just to add minor details.'],
    strategicReminder: ['Both work delivery and family support need clear time boundaries and buffers.'],
    dailyQuote: 'Demo: A clear plan is not about filling time, but giving important things a place.', source: 'demo',
  });

  const finalState = Storage.readFullState();
  const yesterdayTask = finalState.schedule?.days?.[yesterday]?.tasks?.find(task => task.id === completedYesterday.id);
  const completedAction = finalState.completedActions?.find(action => action.taskId === completedYesterday.id);
  const completedAt = new Date(`${yesterday}T18:00:00+08:00`).toISOString();
  if (yesterdayTask) yesterdayTask.completedAt = completedAt;
  if (completedAction) completedAction.completedAt = completedAt;
  const reflection = ReflectionEngine.generateReflection(finalState, { date: yesterday, lang: 'en' });
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
    console.log(JSON.stringify(seedDemoDataEn(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { seedDemoDataEn };
