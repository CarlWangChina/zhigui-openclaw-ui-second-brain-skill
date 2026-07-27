const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-actions-'));

function json(file) {
  return JSON.parse(fs.readFileSync(path.join(testDir, file), 'utf8'));
}

try {
  ensureDataInitialized(testDir);
  Storage.setDataDir(testDir);
  Actions.configure(testDir);

  const strategic = Actions.execute('goal.add', {
    type: 'strategicGoal', title: 'Build a calm decision system', description: 'Keep context without rigid rules', priority: 78,
  });
  assert.equal(strategic.success, true);

  const current = Actions.execute('goal.add', {
    type: 'currentGoal', title: 'Ship the first reliable version', description: 'End-to-end usable', priority: 84,
  });
  assert.equal(current.goal.type, 'current');

  const scheduled = Actions.execute('event.add', {
    date: '2026-07-23', time: '09:30', title: 'Architecture review', duration: 45, priority: 80,
  });
  assert.equal(scheduled.task.manualLocked, true);
  Actions.execute('task.update', {
    date: '2026-07-23', taskId: scheduled.task.id, time: '10:00', duration: 60,
  });
  Actions.execute('task.toggle', { date: '2026-07-23', taskId: scheduled.task.id });

  const errand = Actions.execute('errand.add', {
    title: 'Prepare usability checklist', date: '2026-07-23', priority: 'should', duration: 30,
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
  assert.equal(completedTransient.discarded, true);
  assert.equal(Storage.readFullState().errands.some(item => item.id === errand.errand.id), false);

  const reviewAction = Actions.execute('errand.add', {
    title: 'Review the workshop outcome', date: '2026-07-24', priority: 'should', retention: 'review',
  });
  const completedReview = Actions.execute('errand.complete', { id: reviewAction.errand.id });
  assert.equal(completedReview.discarded, undefined);
  assert.equal(completedReview.errand.completed, true);

  const note = Actions.execute('note.add', {
    title: 'Prefer reversible assumptions for low-risk gaps',
    topic: 'Decision quality', category: 'Product method',
    content: 'Prefer reversible assumptions over mandatory follow-up questions.',
    relatedDate: '2026-07-24', relatedTime: '16:00',
  });
  assert.ok(note.note.topicId);
  assert.equal(note.note.needsEnrichment, false);

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

  const proposal = Actions.execute('note.propose_enrichment', {
    id: importedNoteId, title: '周五晚间优先留给家人', topic: '家庭时间', category: '关系与生活',
    reason: '这是一条稳定的时间偏好。', conflicts: ['可能与临时截止日期冲突，需要你确认例外。'],
  });
  assert.equal(proposal.review.status, 'pending');
  pendingImported = Storage.readFullState().notes.find(item => item.id === importedNoteId);
  assert.equal(pendingImported.topicId, null);
  assert.equal(pendingImported.organizationStatus, 'proposed');

  Actions.execute('review.resolve', { reviewId: proposal.review.id, decision: 'accept' });
  const confirmedImported = Storage.readFullState().notes.find(item => item.id === importedNoteId);
  assert.equal(confirmedImported.needsEnrichment, false);
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

  Actions.execute('priority.update', { type: 'currentGoal', id: current.goal.id, priority: 92 });
  full = Storage.readFullState();
  assert.equal(full.currentGoals[0].prioritySource, 'user');
  assert.equal(full.currentGoals[0].description, 'End-to-end usable');
  assert.equal(full.notes.find(item => item.id === note.note.id).content, 'Prefer reversible assumptions over mandatory follow-up questions.');

  // Deletion must remove both the full view and the hierarchy detail/index.
  Actions.execute('note.delete', { noteId: note.note.id });
  full = Storage.readFullState();
  assert.equal(full.notes.some(item => item.id === note.note.id), false);
  assert.equal(Storage.getNoteDetail(note.note.id), null);
  assert.equal(Storage.readLightweightState().notes.some(item => item.id === note.note.id), false);

  Actions.execute('goal.complete', { id: current.goal.id, completed: true });
  Actions.execute('goal.delete', { type: 'currentGoal', id: current.goal.id });
  full = Storage.readFullState();
  assert.equal(full.currentGoals.length, 0);
  assert.equal(Storage.getGoalDetail(current.goal.id), null);

  // Every persisted JSON document remains parseable. Actions no longer create
  // duplicate event-stream audit records.
  for (const file of fs.readdirSync(testDir).filter(name => name.endsWith('.json'))) json(file);
  assert.equal(fs.existsSync(path.join(testDir, 'events.json')), false);
  console.log('PASS integration-actions');
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
