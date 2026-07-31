/* Executable write case: linked care action → panel completion → later follow-up signal. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetData } = require('../lib/reset-data');
const Actions = require('../engine/actions');
const Storage = require('../engine/storage');
const Attention = require('../engine/attention-engine');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-write-case-'));
try {
  resetData(root, { preserveUi: false });
  Actions.configure(root);
  const note = Actions.execute('note.add', {
    title: '家人病后恢复情况',
    content: '周二探望后，医生建议一周内观察恢复情况；周末可电话确认。',
    topic: '家庭健康',
  }).note;
  const goal = Actions.execute('goal.add', {
    type: 'currentGoal', title: '照顾家人恢复',
    description: '确认恢复情况并在需要时协调后续安排。', nextStep: '本周末电话确认恢复情况',
  }).goal;
  const today = new Date().toISOString().slice(0, 10);
  const task = Actions.execute('task.add', {
    date: today, time: '10:00', title: '看望生病的家人', relatedGoalId: goal.id,
    noteIds: [note.id], topicId: note.topicId,
    contextRefs: [{ type: 'goal', id: goal.id, role: 'instruction' }, { type: 'note', id: note.id, role: 'reference' }],
    contextReason: '查看恢复情况，并据此决定是否安排电话回访。',
    placementReason: '白天探望便于沟通和处理后续事务。', source: 'ai',
  }).task;

  // This is the same canonical command path the panel checkbox uses.
  Actions.execute('task.toggle', { date: today, taskId: task.id });
  const state = Storage.readFullState();
  const completed = state.completedActions.find(action => action.taskId === task.id);
  completed.completedAt = new Date(Date.now() - 4 * 86400000).toISOString();
  Storage.writeState(state);

  const afterWrite = Storage.readFullState();
  const pending = Storage.readPendingActivity({ limit: 20 })
    .find(event => event.entityId === task.id && event.operation === 'complete');
  assert.ok(pending, 'panel completion must remain pending until an assistant reconciles its meaning');
  Actions.execute('activity.reconcile', {
    eventId: pending.id,
    expectedStateVersion: afterWrite.meta.stateVersion,
    disposition: 'applied',
    followUp: {
      mode: 'check_in', dueAt: today,
      reason: '探望后需要确认家人恢复情况',
      question: '前几天家里人生病了，现在要不要打个电话看一下后续？',
      contextRefs: [{ type: 'goal', id: goal.id }, { type: 'note', id: note.id }],
    },
  });
  const reconciledState = Storage.readFullState();
  const followUp = Attention.computeAttention(reconciledState, { maxResults: 20 }).signals
    .find(signal => signal.type === 'followUp' && signal.signalType === 'hint_followup');
  assert.ok(followUp, 'an explicit reconciled care follow-up must surface later');
  const resolvedFollowUp = Actions.execute('followup.resolve', { followUpId: followUp.id, status: 'resolved', note: 'User confirmed the result.' });
  assert.equal(resolvedFollowUp.followUp.status, 'resolved', 'a surfaced follow-up must have an explicit closure path');
  assert.deepStrictEqual(completed.linkedNoteIds, [note.id], 'completion must retain the note shown from the panel');
  assert.equal(completed.linkedGoalId, goal.id, 'completion must retain its goal relationship');

  console.log(JSON.stringify({
    case: '家庭照护：写入关联行动、面板完成、后续对话提示',
    panelCanExpand: {
      action: task.title,
      relatedGoal: goal.title,
      linkedNote: note.title,
      contextReason: task.contextReason,
    },
    canonicalCompletion: {
      completedActionId: completed.id,
      retainedGoalId: completed.linkedGoalId,
      retainedNoteIds: completed.linkedNoteIds,
      activityEvents: Storage.readRecentActivity({ limit: 10 }).length,
    },
    laterConversation: {
      signalType: followUp.signalType,
      reason: followUp.attentionReasons[0],
      expectedAssistantMove: '先读取关联笔记，再自然询问恢复情况是否需要电话跟进。',
    },
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
