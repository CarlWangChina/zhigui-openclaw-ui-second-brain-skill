/* Focused regression checks for the assistant architecture. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetData } = require('../lib/reset-data');
const Actions = require('../engine/actions');
const Storage = require('../engine/storage');
const Attention = require('../engine/attention-engine');
const { BrainIndex } = require('../engine/brain-index');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-evolution-'));
try {
  resetData(root, { preserveUi: false });
  Actions.configure(root);
  const note = Actions.execute('note.add', { title: '家人病后恢复情况', content: '本周看望，后续电话确认恢复情况。', topic: '家庭健康' }).note;
  const task = Actions.execute('task.add', {
    date: '2026-07-28', time: '10:00', title: '看望家人',
    noteIds: [note.id], contextRefs: [{ type: 'note', id: note.id, role: 'instruction' }],
    contextReason: '执行前需要知道恢复情况', placementReason: '今天先完成探望，再根据情况安排回访', source: 'ai',
  }).task;
  assert.deepStrictEqual(task.noteIds, [note.id]);
  Actions.execute('task.toggle', { date: '2026-07-28', taskId: task.id });
  const firstCompletion = Storage.readFullState().completedActions.find(item => item.taskId === task.id);
  assert.strictEqual(firstCompletion.scheduleDate, '2026-07-28', 'completed task must retain its original date for a type-safe restore');
  Actions.execute('task.toggle', { date: '2026-07-28', taskId: task.id });
  assert.equal(Storage.readFullState().completedActions.some(item => item.taskId === task.id), false, 'reopening a task must remove only its completion record');
  Actions.execute('task.toggle', { date: '2026-07-28', taskId: task.id });

  const recurring = Actions.execute('errand.add', {
    title: '每周健身', date: '2026-07-28', pattern: 'recurring', recurrence: { intervalDays: 7 },
    noteIds: [note.id], contextRefs: [{ type: 'note', id: note.id, role: 'reference' }],
    contextReason: '沿用本周训练记录', placementReason: '保持每周节奏',
  }).errand;
  const completion = Actions.execute('errand.complete', { id: recurring.id, summary: '完成训练' });
  assert.ok(completion.nextOccurrence, 'recurring errand must create the next occurrence');
  assert.strictEqual(completion.action.noteCleanupHint, 'keep');
  assert.ok(completion.action.contextRefs.some(ref => ref.id === note.id && ref.role === 'reference'), 'completion must preserve context roles');
  assert.strictEqual(completion.action.contextReason, '沿用本周训练记录');
  const restored = Actions.execute('errand.undo', { actionId: completion.action.id }).errand;
  assert.ok(restored.contextRefs.some(ref => ref.id === note.id && ref.role === 'reference'), 'restoring an action must restore context roles');
  assert.strictEqual(restored.placementReason, '保持每周节奏');

  const state = Storage.readFullState();
  const completedTask = state.completedActions.find(item => item.taskId === task.id);
  assert.ok(completedTask, 'task completion must enter completedActions');
  assert.ok(completedTask.contextRefs.some(ref => ref.id === note.id && ref.role === 'instruction'), 'task completion must retain its execution context');
  assert.strictEqual(completedTask.placementReason, '今天先完成探望，再根据情况安排回访');
  assert.ok(Storage.readRecentActivity({ limit: 20 }).length >= 4, 'panel/MCP mutations must emit compact activity events');
  assert.ok(new BrainIndex(root).getTopics().every(topic => typeof topic.id === 'string' && topic.id.length > 0), 'topic list must never expose template topics without IDs');

  const scorelessGoal = Actions.execute('goal.add', {
    type: 'currentGoal', title: 'Scoreless goal', priority: 72, confidence: 80,
  }).goal;
  assert.equal(Object.hasOwn(scorelessGoal, 'priority'), false, 'goal writes must not create a numeric priority');
  assert.equal(Object.hasOwn(scorelessGoal, 'confidence'), false, 'goal writes must not create numeric confidence');
  const scorelessNote = Actions.execute('note.add', {
    title: 'Signal-only note', content: 'Keep this as a factual note.', topic: 'Test', importance: 90,
  }).note;
  assert.equal(Object.hasOwn(scorelessNote, 'importance'), false, 'note writes must not create a numeric importance field');

  const attention = Attention.computeAttention(state, { maxResults: 20 });
  assert.ok(attention.signals.every(signal => !Object.hasOwn(signal, 'attentionScore') && !Object.hasOwn(signal, 'signalOrder') && Number.isInteger(signal.attentionRank)));
  assert.equal(attention.signals.some(signal => signal.signalType === 'importance'), false,
    'attention must expose qualitative situations, not a synthetic high-importance score');
  console.log('architecture-evolution: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
