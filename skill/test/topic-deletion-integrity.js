const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');
const RelationshipGraph = require('../engine/relationship-graph');
const { BrainIndex } = require('../engine/brain-index');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-topic-delete-'));

try {
  ensureDataInitialized(testDir);
  Storage.setDataDir(testDir);
  Actions.configure(testDir);

  const homeNote = Actions.execute('note.add', {
    title: 'Family recovery context', topic: 'Family recovery', category: 'Life',
    content: 'Track the recovery plan and questions for the next visit.',
  }).note;
  const workNote = Actions.execute('note.add', {
    title: 'Work handoff context', topic: 'Work delivery', category: 'Career',
    content: 'Keep the deployment handoff checklist available.',
  }).note;

  const homeTopicId = homeNote.topicId;
  const workTopicId = workNote.topicId;
  let state = Storage.readFullState();
  state.schedule.days['2026-08-10'] = {
    date: '2026-08-10',
    tasks: [{
      id: 'task_cross_topic', title: 'Visit family with handoff prepared', time: '10:00',
      topicId: homeTopicId, noteIds: [homeNote.id, workNote.id],
      contextRefs: [
        { type: 'topic', id: homeTopicId, role: 'classification' },
        { type: 'note', id: homeNote.id, role: 'instruction' },
        { type: 'note', id: workNote.id, role: 'reference' },
      ],
    }],
  };
  state.errands.push({
    id: 'errand_cross_topic', title: 'Call the family', topicId: homeTopicId,
    noteIds: [homeNote.id, workNote.id],
    contextRefs: [{ type: 'note', id: homeNote.id }, { type: 'note', id: workNote.id }],
  });
  state.completedActions = [{
    id: 'completed_cross_topic', title: 'Earlier family call', linkedTopicId: homeTopicId,
    linkedNoteIds: [homeNote.id, workNote.id],
    contextRefs: [{ type: 'note', id: homeNote.id }, { type: 'note', id: workNote.id }],
  }];
  state.currentGoals.push({ id: 'goal_cross_topic', title: 'Support family recovery', topicId: homeTopicId });
  state.decisions.push({
    id: 'decision_cross_topic', title: 'Keep weekly follow-up', relatedNoteIds: [homeNote.id, workNote.id],
  });
  state.constraints.push({ id: 'constraint_recovery', type: 'constraint', title: 'Avoid overloading the recovery period' });
  state.decisions.push({
    id: 'decision_constraint_ref', title: 'Respect recovery capacity', relatedGoalIds: ['constraint_recovery'],
  });
  state.followUps = [{
    id: 'followup_cross_topic', title: 'Ask for recovery update',
    contextRefs: [{ type: 'topic', id: homeTopicId }, { type: 'note', id: homeNote.id }, { type: 'note', id: workNote.id }],
  }];
  Storage.writeState(state);

  const preview = Actions.execute('topic.preview_delete', { topicId: homeTopicId });
  assert.equal(preview.counts.notes, 1, 'only the topic-owned note is deletable');
  assert.equal(preview.counts.preservedActionItems >= 0, true);
  assert.deepEqual(preview.manifest.notes.map(note => note.id), [homeNote.id]);

  const result = Actions.execute('topic.delete', { topicId: homeTopicId, confirm: true });
  assert.equal(result.success, true);
  assert.equal(result.deleted.notes, 1);

  state = Storage.readFullState();
  assert.equal(state.notes.some(note => note.id === homeNote.id), false, 'owned note is deleted');
  assert.equal(state.notes.some(note => note.id === workNote.id), true, 'cross-topic note survives');

  const task = state.schedule.days['2026-08-10'].tasks.find(item => item.id === 'task_cross_topic');
  assert.ok(task, 'schedule item must survive topic deletion');
  assert.equal(task.topicId, null);
  assert.deepEqual(task.noteIds, [workNote.id]);
  assert.deepEqual(task.contextRefs, [{ type: 'note', id: workNote.id, role: 'reference' }]);

  const errand = state.errands.find(item => item.id === 'errand_cross_topic');
  assert.ok(errand, 'errand must survive topic deletion');
  assert.equal(errand.topicId, null);
  assert.deepEqual(errand.noteIds, [workNote.id]);

  const completed = state.completedActions.find(item => item.id === 'completed_cross_topic');
  assert.ok(completed, 'completed action history must survive topic deletion');
  assert.equal(completed.linkedTopicId, null);
  assert.deepEqual(completed.linkedNoteIds, [workNote.id]);

  assert.equal(state.currentGoals.find(goal => goal.id === 'goal_cross_topic').topicId, null);
  assert.deepEqual(state.decisions.find(item => item.id === 'decision_cross_topic').relatedNoteIds, [workNote.id]);
  assert.deepEqual(state.followUps.find(item => item.id === 'followup_cross_topic').contextRefs, [{ type: 'note', id: workNote.id }]);

  assert.equal(new BrainIndex(testDir).getTopics().some(topic => topic.id === homeTopicId), false, 'topic index is removed');
  const deletedTopicContext = RelationshipGraph.getRelated(state, homeTopicId);
  const deletedNoteContext = RelationshipGraph.getRelated(state, homeNote.id);
  assert.deepEqual(deletedTopicContext.related, [], 'relationship graph cannot retain the deleted topic');
  assert.deepEqual(deletedNoteContext.related, [], 'relationship graph cannot retain the deleted note');
  assert.equal(RelationshipGraph.getRelated(state, task.id).related.some(item => item.id === workNote.id), true,
    'the graph retains valid links to notes in other topics');
  assert.equal(RelationshipGraph.getRelated(state, 'followup_cross_topic').related.some(item => item.id === workNote.id), true,
    'follow-up context remains queryable after a topic delete');
  assert.equal(RelationshipGraph.getRelated(state, 'decision_constraint_ref').related.some(item => item.id === 'constraint_recovery'), true,
    'constraints participate in decision explanation paths');

  console.log('PASS topic-deletion-integrity');
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
