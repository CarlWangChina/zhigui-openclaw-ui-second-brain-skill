/*
 * Regression: panel facts and conversational interpretation must share the
 * same canonical entities, activity journal, and relationship graph.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetData } = require('../lib/reset-data');
const Actions = require('../engine/actions');
const Storage = require('../engine/storage');
const RelationshipGraph = require('../engine/relationship-graph');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-decision-continuity-'));
const today = new Date().toISOString().slice(0, 10);

try {
  resetData(root, { preserveUi: false });
  Actions.configure(root);

  const goal = Actions.execute('goal.add', {
    type: 'currentGoal',
    title: 'Prepare the family care follow-up',
    nextStep: 'Confirm the recovery status this week',
    source: 'ai',
  }).goal;
  const note = Actions.execute('note.add', {
    title: 'Recovery observation notes',
    content: 'The family member is recovering. Check in again after a few days.',
    topic: 'Family health',
    source: 'ai',
  }).note;
  const task = Actions.execute('task.add', {
    date: today,
    time: '10:00',
    duration: 45,
    title: 'Visit the family member',
    relatedGoalId: goal.id,
    noteIds: [note.id],
    topicId: note.topicId,
    contextRefs: [
      { type: 'goal', id: goal.id, role: 'instruction' },
      { type: 'note', id: note.id, role: 'reference' },
    ],
    contextReason: 'Use the recovery observation notes during the visit.',
    placementReason: 'A daytime visit makes it easier to discuss next steps.',
    source: 'ai',
  }).task;

  // A conversational decision is already interpreted, so it is immediately
  // applied and uses the same action/note/goal references as the panel.
  const initialDecision = Actions.execute('decision.add', {
    title: 'Check in after the visit',
    description: 'Wait a few days, then call to confirm the recovery status.',
    relatedGoalIds: [goal.id],
    relatedNoteIds: [note.id],
    relatedActionIds: [task.id],
    topicIds: [note.topicId],
    reviewDueAt: `${today}T12:00:00.000Z`,
    updateReason: 'Conversation confirmed that a later follow-up is useful.',
    source: 'ai',
  }).decision;

  const conversationEvent = Storage.readRecentActivity({ limit: 20 })
    .find(event => event.kind === 'decision' && event.entityId === initialDecision.id);
  assert.ok(conversationEvent, 'a conversational decision must enter the activity journal');
  assert.equal(conversationEvent.channel, 'conversation');
  assert.equal(conversationEvent.reconciliationStatus, 'applied');

  let state = Storage.readFullState();
  let persistedTask = state.schedule.days[today].tasks.find(item => item.id === task.id);
  assert.ok(persistedTask.decisionIds.includes(initialDecision.id), 'the action keeps a compact decision reference');
  assert.ok(persistedTask.contextRefs.some(ref => ref.type === 'decision' && ref.id === initialDecision.id), 'the action has an explainable decision context');
  const graph = RelationshipGraph.getRelated(state, initialDecision.id, { depth: 1 });
  assert.ok(graph.related.some(item => item.id === task.id), 'the relationship graph exposes the decision-to-action link');
  assert.ok(graph.related.some(item => item.id === note.id), 'the relationship graph exposes the decision-to-note link');

  // New evidence can replace a decision, preserving lineage instead of making
  // the old decision look permanently current.
  const revisedDecision = Actions.execute('decision.add', {
    title: 'Call tomorrow instead of waiting',
    description: 'The visit revealed a concern that needs a faster check-in.',
    relatedGoalIds: [goal.id],
    relatedNoteIds: [note.id],
    relatedActionIds: [task.id],
    topicIds: [note.topicId],
    supersedesId: initialDecision.id,
    updateReason: 'The visit changed the follow-up timing.',
    source: 'ai',
  }).decision;
  state = Storage.readFullState();
  const archivedInitial = state.decisions.find(item => item.id === initialDecision.id);
  assert.equal(archivedInitial.status, 'revised');
  assert.equal(archivedInitial.replacedById, revisedDecision.id);

  // A panel completion remains a pending fact. A later conversation can turn
  // that fact into a decision update without copying data into a second store.
  Actions.execute('task.toggle', { date: today, taskId: task.id, source: 'user' });
  state = Storage.readFullState();
  const pending = Storage.readPendingActivity({ limit: 20 })
    .find(event => event.kind === 'task' && event.entityId === task.id && event.operation === 'complete');
  assert.ok(pending, 'a panel completion must remain pending for later interpretation');
  assert.equal(pending.channel, 'panel');
  assert.equal(pending.reconciliationStatus, 'pending');

  const reconciliation = Actions.execute('activity.reconcile', {
    eventId: pending.id,
    expectedStateVersion: state.meta.stateVersion,
    disposition: 'applied',
    decisionPatches: [{
      id: revisedDecision.id,
      status: 'resolved',
      outcome: 'The visit was completed and the needed support was confirmed.',
      updateReason: 'Panel completion was reviewed in conversation.',
    }],
    decisionCreates: [{
      title: 'Keep a short check-in next week',
      description: 'The completed visit suggests a light follow-up is sufficient.',
      relatedGoalIds: [goal.id],
      relatedNoteIds: [note.id],
      relatedActionIds: [task.id],
      topicIds: [note.topicId],
      updateReason: 'Created after interpreting the completed visit.',
    }],
    source: 'ai',
  });
  assert.equal(reconciliation.disposition, 'applied');
  assert.equal(reconciliation.changed.decisions.length, 2, 'one decision is resolved and one is created');

  state = Storage.readFullState();
  const resolvedDecision = state.decisions.find(item => item.id === revisedDecision.id);
  const followUpDecision = state.decisions.find(item => item.id === reconciliation.changed.decisions[1]);
  assert.equal(resolvedDecision.status, 'resolved');
  assert.equal(resolvedDecision.lifecycleState, 'archived');
  assert.equal(followUpDecision.sourceEventId, pending.id, 'the new decision retains its source fact');
  assert.ok(Storage.readRecentActivity({ limit: 20 }).some(event => event.id === pending.id && event.reconciliationStatus === 'applied'), 'the panel fact is closed only after canonical updates succeed');

  // Deletion is safe: no decision index or action context may retain the
  // deleted scheduled task ID.
  const preview = Actions.execute('deletion.preview', { entityType: 'task', date: today, taskId: task.id });
  assert.equal(preview.preview, true, 'a destructive operation must return an impact preview before mutation');
  assert.ok(preview.impact.decisions >= 1, 'the preview must disclose detached decision links');
  assert.ok(Storage.readFullState().schedule.days[today].tasks.some(item => item.id === task.id), 'the preview must not mutate canonical state');
  const deletion = Actions.execute('task.delete', { date: today, taskId: task.id, source: 'user' });
  assert.ok(deletion.cleaned.decisions >= 1, 'deleting an action cleans linked decisions');
  state = Storage.readFullState();
  for (const decision of state.decisions) {
    assert.ok(!(decision.relatedActionIds || []).includes(task.id), 'a decision cannot retain a deleted action ID');
  }

  console.log('PASS decision continuity: conversation, panel reconciliation, decision lineage, and deletion integrity');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
