const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');
const { BrainIndex } = require('../engine/brain-index');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-actions-'));

function json(file) {
  return JSON.parse(fs.readFileSync(path.join(testDir, file), 'utf8'));
}

try {
  ensureDataInitialized(testDir);
  Storage.setDataDir(testDir);
  Actions.configure(testDir);

  const strategic = Actions.execute('goal.add', {
    type: 'strategicGoal', title: 'Build a calm decision system', description: 'Keep context without rigid rules',
  });
  assert.equal(strategic.success, true);

  const current = Actions.execute('goal.add', {
    type: 'currentGoal', title: 'Ship the first reliable version', description: 'End-to-end usable',
  });
  assert.equal(current.goal.type, 'current');
  const updatedGoal = Actions.execute('goal.update', {
    type: 'currentGoal', id: current.goal.id, deadline: '2026-08-15',
    nextStep: 'Run the end-to-end acceptance check', source: 'ai',
  });
  assert.equal(updatedGoal.goal.deadline, '2026-08-15');
  assert.equal(updatedGoal.goal.nextStep, 'Run the end-to-end acceptance check');

  const scheduled = Actions.execute('event.add', {
    date: '2026-07-23', time: '09:30', title: 'Architecture review', duration: 45,
  });
  assert.equal(scheduled.task.manualLocked, true);
  Actions.execute('task.update', {
    date: '2026-07-23', taskId: scheduled.task.id, time: '10:00', duration: 60,
  });
  Actions.execute('task.toggle', { date: '2026-07-23', taskId: scheduled.task.id });

  const errand = Actions.execute('errand.add', {
    title: 'Prepare usability checklist', date: '2026-07-23', commitmentLevel: 'should', duration: 30,
  });
  const timedErrand = Actions.execute('errand.update', {
    id: errand.errand.id, time: '14:15', duration: 45,
  });
  assert.equal(timedErrand.errand.time, '14:15');
  assert.equal(timedErrand.errand.duration, 45);
  const unscheduledErrand = Actions.execute('errand.update', {
    id: errand.errand.id, time: '', duration: 30,
  });
  assert.equal(unscheduledErrand.errand.time, '');
  const completedTransient = Actions.execute('errand.complete', { id: errand.errand.id });
  assert.equal(completedTransient.discarded, false);
  assert.equal(completedTransient.completed, true);
  assert.ok(completedTransient.action, 'should return completed action record');
  assert.equal(Storage.readFullState().errands.some(item => item.id === errand.errand.id), false);
  assert.ok(Storage.readFullState().completedActions.some(a => a.errandId === errand.errand.id), 'should be in completedActions');

  const reviewAction = Actions.execute('errand.add', {
    title: 'Review the workshop outcome', date: '2026-07-24', commitmentLevel: 'should', retention: 'review',
  });
  const completedReview = Actions.execute('errand.complete', { id: reviewAction.errand.id });
  assert.equal(completedReview.completed, true);
  assert.ok(completedReview.action, 'should return completed action record');
  assert.equal(Storage.readFullState().errands.some(item => item.id === reviewAction.errand.id), false);
  assert.ok(Storage.readFullState().completedActions.some(a => a.errandId === reviewAction.errand.id), 'should be in completedActions');

  const note = Actions.execute('note.add', {
    title: 'Prefer reversible assumptions for low-risk gaps',
    topic: 'Decision quality', category: 'Product method',
    content: 'Prefer reversible assumptions over mandatory follow-up questions.',
    relatedDate: '2026-07-24', relatedTime: '16:00',
  });
  assert.ok(note.note.topicId);
  assert.equal(note.note.needsEnrichment, false);

  // Goals can pin the notes they were built from; unknown ids must be dropped
  // so a goal can never hold a dangling note reference.
  const goalWithNote = Actions.execute('goal.update', {
    type: 'currentGoal', id: current.goal.id,
    noteIds: [note.note.id, 'note_ghost_does_not_exist'], source: 'ai',
  });
  assert.deepEqual(goalWithNote.goal.noteIds, [note.note.id]);
  const retrieved = new BrainIndex(testDir).search('Which reversible method should I use when uncertain?');
  assert.equal(retrieved.retrieval, 'term-ranked');
  assert.equal(retrieved.hits.some(hit => hit.id === note.note.id), true,
    'conversation-style wording should retrieve a relevant note without a full literal match');

  const inboxNote = Actions.execute('note.add', {
    content: 'A manually captured note needs AI organization before it enters the knowledge index.',
  });
  assert.equal(inboxNote.note.needsEnrichment, true);
  const enriched = Actions.execute('note.enrich', {
    id: inboxNote.note.id,
    title: 'Manual captures wait for AI organization',
    topic: 'Layered memory',
    category: 'Architecture',
  });
  assert.equal(enriched.note.needsEnrichment, false);

  const imported = Actions.execute('note.add', {
    content: 'I prefer to reserve Friday evenings for family time.',
  });
  assert.equal(imported.note.needsEnrichment, true);
  const importedNoteId = imported.note.id;
  let pendingImported = Storage.readFullState().notes.find(item => item.id === importedNoteId);
  assert.equal(pendingImported.needsEnrichment, true);
  assert.equal(pendingImported.topicId, null);
  assert.ok(pendingImported.content.includes('Friday evenings'));

  const enrichment = Actions.execute('note.enrich', {
    id: importedNoteId, title: '周五晚间优先留给家人', topic: '家庭时间', category: '关系与生活',
  });
  assert.equal(enrichment.success, true);
  const confirmedImported = Storage.readFullState().notes.find(item => item.id === importedNoteId);
  assert.equal(confirmedImported.needsEnrichment, false);
  assert.equal(confirmedImported.organizationStatus, 'confirmed');
  assert.ok(confirmedImported.topicId);
  assert.equal(confirmedImported.title, '周五晚间优先留给家人');

  let full = Storage.readFullState();
  assert.equal(full.strategicGoals.length, 1);
  assert.equal(full.currentGoals.length, 1);
  assert.equal(full.currentGoals[0].description, 'End-to-end usable');
  assert.equal(full.schedule.days['2026-07-23'].tasks[0].time, '10:00');
  assert.equal(full.schedule.days['2026-07-23'].tasks[0].completed, true);
  assert.equal(full.notes.find(item => item.id === note.note.id).content, 'Prefer reversible assumptions over mandatory follow-up questions.');

  // A title-only projection must never overwrite a stored note body on the next write.
  const noteProjection = Storage.readFullState();
  noteProjection.notes = Storage.readLightweightState().notes;
  Storage.writeState(noteProjection);
  assert.equal(Storage.getNoteDetail(note.note.id).content,
    'Prefer reversible assumptions over mandatory follow-up questions.');

  const removableTask = Actions.execute('event.add', {
    date: '2026-07-24', time: '11:30', title: 'Remove a single scheduled action', duration: 30,
  });
  const deletedTask = Actions.execute('task.delete', {
    date: '2026-07-24', taskId: removableTask.task.id,
  });
  assert.equal(deletedTask.success, true);
  assert.equal(Storage.readFullState().schedule.days['2026-07-24'].tasks
    .some(task => task.id === removableTask.task.id), false);

  // A lightweight read must never damage full entities on the next mutation.
  const lightweight = Storage.readLightweightState();
  const indexedNote = lightweight.notes.find(item => item.id === note.note.id);
  assert.equal(indexedNote._lightweight, true);
  assert.equal(indexedNote.title, 'Prefer reversible assumptions for low-risk gaps');
  assert.equal(Object.hasOwn(indexedNote, 'content'), false);
  assert.equal(Object.hasOwn(indexedNote, 'preview'), false);

  // Topic promotion may remove a note from the legacy flat file. The hierarchy detail
  // remains canonical, so full reads must still return the body.
  const flatNotes = json('notes.json');
  flatNotes.notes = flatNotes.notes.filter(item => item.id !== note.note.id);
  fs.writeFileSync(path.join(testDir, 'notes.json'), JSON.stringify(flatNotes, null, 2));
  assert.equal(Storage.readFullState().notes.find(item => item.id === note.note.id).content,
    'Prefer reversible assumptions over mandatory follow-up questions.');

  full = Storage.readFullState();
  assert.equal(Object.hasOwn(full.currentGoals[0], 'priority'), false);
  assert.equal(full.currentGoals[0].description, 'End-to-end usable');
  assert.equal(full.notes.find(item => item.id === note.note.id).content, 'Prefer reversible assumptions over mandatory follow-up questions.');

  // Deletion must remove both the note itself and every durable action/decision
  // reference, so a later dashboard render cannot show a dangling context card.
  full.schedule.days['2026-07-23'].tasks.push({
    id: 'task_note_ref', title: 'Read the linked note', time: '15:00', noteIds: [note.note.id],
    contextRefs: [{ type: 'note', id: note.note.id, role: 'reference' }],
  });
  full.errands.push({
    id: 'errand_note_ref', title: 'Use note context', noteIds: [note.note.id],
    contextRefs: [{ type: 'note', id: note.note.id, role: 'instruction' }],
  });
  full.completedActions = full.completedActions || [];
  full.completedActions.push({
    id: 'completed_note_ref', title: 'Completed with note context', linkedNoteIds: [note.note.id],
    contextRefs: [{ type: 'note', id: note.note.id, role: 'result' }], completedAt: new Date().toISOString(),
  });
  full.decisions = full.decisions || [];
  full.decisions.push({
    id: 'decision_note_ref', title: 'Decision with evidence', relatedNoteIds: [note.note.id],
    contextRefs: [{ type: 'note', id: note.note.id, role: 'evidence' }],
  });
  full.followUps = full.followUps || [];
  full.followUps.push({ id: 'followup_note_ref', title: 'Check note context', contextRefs: [{ type: 'note', id: note.note.id }] });
  // Goals may pin the notes they were built from; deletion must detach them too.
  full.currentGoals[0].noteIds = [note.note.id];
  Storage.writeState(full);

  const deletedNote = Actions.execute('note.delete', { noteId: note.note.id });
  assert.deepEqual(deletedNote.referenceCleanup, {
    scheduleTasks: 1, errands: 1, completedActions: 1, goals: 1, decisions: 1, followUps: 1,
  });
  full = Storage.readFullState();
  assert.equal(full.notes.some(item => item.id === note.note.id), false);
  assert.equal(Storage.getNoteDetail(note.note.id), null);
  assert.equal(Storage.readLightweightState().notes.some(item => item.id === note.note.id), false);
  assert.deepEqual(full.schedule.days['2026-07-23'].tasks.find(task => task.id === 'task_note_ref').noteIds, []);
  assert.deepEqual(full.errands.find(item => item.id === 'errand_note_ref').contextRefs, []);
  assert.deepEqual(full.currentGoals[0].noteIds, []);
  assert.deepEqual(full.completedActions.find(item => item.id === 'completed_note_ref').linkedNoteIds, []);
  assert.deepEqual(full.decisions[0].relatedNoteIds, []);
  assert.deepEqual(full.decisions[0].contextRefs, []);
  assert.deepEqual(full.followUps.find(item => item.id === 'followup_note_ref').contextRefs, []);

  Actions.execute('goal.complete', { id: current.goal.id, completed: true });
  Actions.execute('goal.delete', { type: 'currentGoal', id: current.goal.id });
  full = Storage.readFullState();
  assert.equal(full.currentGoals.length, 0);
  assert.equal(Storage.getGoalDetail(current.goal.id), null);

  // A crash between projections leaves a replay snapshot. Reconfiguring the
  // storage directory must recover it before any reader observes mixed data.
  const recoveryState = Storage.readFullState();
  recoveryState.userProfile = { ...(recoveryState.userProfile || {}), recoveryProbe: 'replayed' };
  recoveryState.lastReflection = { date: '2026-07-24', completedToday: { totalCount: 2, summary: 'Two items completed.' } };
  fs.writeFileSync(path.join(testDir, '.state-write-recovery.json'), JSON.stringify({ version: 1, state: recoveryState }));
  Storage.setDataDir(testDir);
  assert.equal(Storage.readFullState().userProfile.recoveryProbe, 'replayed');
  assert.equal(Storage.readFullState().lastReflection.date, '2026-07-24',
    'state-only daily reflections must survive later reads and writes');
  assert.equal(Storage.syncStateJson(), true);
  assert.equal(Storage.readFullState().lastReflection.date, '2026-07-24',
    'a legacy brain-index sync must preserve state-only daily reflections');

  // Every persisted JSON document remains parseable. Actions no longer create
  // duplicate event-stream audit records.
  for (const file of fs.readdirSync(testDir).filter(name => name.endsWith('.json'))) json(file);
  assert.equal(fs.existsSync(path.join(testDir, '.state-write-recovery.json')), false,
    'a successful multi-projection write must clear its recovery record');
  assert.equal(fs.existsSync(path.join(testDir, 'events.json')), false);
  console.log('PASS integration-actions');
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
