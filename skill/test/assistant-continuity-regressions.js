const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');
const Attention = require('../engine/attention-engine');
const { BrainIndex } = require('../engine/brain-index');
const DateUtils = require('../engine/date-utils');

function callFactory(child) {
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(JSON.parse(message.result.content[0].text));
    }
  });
  return (name, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-continuity-'));
  let child;
  try {
    ensureDataInitialized(dir);
    Storage.setDataDir(dir);
    Actions.configure(dir);
    const today = DateUtils.todayStr();
    const yesterday = DateUtils.nextDay(today, -1);

    const persistedTimestamp = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).meta.lastUpdated;
    Storage.readFullState();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).meta.lastUpdated, persistedTimestamp,
      'a read must not masquerade as a write by changing the persisted update timestamp');

    // A rejected optimistic reconciliation must not create a new version.
    const panelTask = Actions.execute('task.add', { date: today, time: '09:00', title: 'Panel fact', category: 'study', source: 'user' }).task;
    const event = Storage.readPendingActivityPage({ limit: 20 }).items[0];
    const beforeConflict = Storage.readFullState().meta.stateVersion;
    const conflict = Actions.execute('activity.reconcile', { eventId: event.id, expectedStateVersion: beforeConflict - 1, disposition: 'applied', source: 'ai' });
    assert.equal(conflict.conflict, true);
    assert.equal(Storage.readFullState().meta.stateVersion, beforeConflict, 'a conflict response must not make its own checkpoint stale');

    // Pending facts must remain page-addressable and reconciliable beyond the old 100-item ceiling.
    for (let i = 0; i < 105; i++) {
      Actions.execute('task.add', { date: today, time: '10:00', title: `Backlog ${i}`, category: 'study', source: 'user' });
    }
    const lastPendingPage = Storage.readPendingActivityPage({ limit: 20, offset: 100 });
    assert.ok(lastPendingPage.total > 100 && lastPendingPage.items.length > 0 && lastPendingPage.hasMore === false);
    const oldPending = lastPendingPage.items[lastPendingPage.items.length - 1];
    const currentVersion = Storage.readFullState().meta.stateVersion;
    const settled = Actions.execute('activity.reconcile', { eventId: oldPending.id, expectedStateVersion: currentVersion, disposition: 'applied', source: 'ai' });
    assert.equal(settled.success, true, 'an older pending fact must be found by ID, not by a recent-100 slice');

    // Search is a compact index: it may show a bounded snippet, never a full body.
    const longBody = `family-recovery ${'x'.repeat(1000)}`;
    const note = Actions.execute('note.add', { title: 'Long recovery note', content: longBody, topic: 'Family', category: 'Care', source: 'ai' }).note;
    const search = new BrainIndex(dir).search('family-recovery');
    const searchHit = search.hits.find(hit => hit.id === note.id);
    assert.ok(searchHit);
    assert.ok((searchHit.snippet || '').length <= 180);
    assert.equal(JSON.stringify(searchHit).includes(longBody), false, 'search must not return a full long note body');
    const actionSearch = new BrainIndex(dir).search('Panel fact');
    assert.ok(actionSearch.hits.some(hit => hit.type === 'task' && hit.id === panelTask.id && hit.date === today),
      'global search must retain a compact pointer to schedule actions, not only notes and goals');
    const linkedTask = Actions.execute('task.add', { date: today, time: '09:30', title: 'Use recovery note', noteIds: [note.id], source: 'ai' }).task;
    const taskState = Storage.readFullState();
    assert.ok(taskState.schedule.days[today].tasks.find(item => item.id === linkedTask.id)?.noteIds.includes(note.id),
      'a linked task must retain its note reference');

    // ISO and date-only follow-up due times use the same local-day semantics.
    const dueState = { followUps: [{ id: 'fu_iso', status: 'pending', dueAt: `${today}T09:00:00+08:00`, question: 'Check in' }] };
    assert.ok(Attention.computeAttention(dueState, { maxResults: 20 }).signals.some(signal => signal.id === 'fu_iso'));

    // Carry-forward keeps the original task ID, so decision references do not dangle.
    const carried = Actions.execute('task.add', { date: yesterday, time: '11:00', title: 'Continue linked work', category: 'study', source: 'ai' }).task;
    Actions.execute('decision.add', { title: 'Keep work linked', status: 'accepted', relatedActionIds: [carried.id], source: 'ai' });
    const state = Storage.readFullState();
    state.meta.lastDailyCheck = `${yesterday}T00:00:00.000Z`;
    Storage.writeState(state);

    child = spawn(process.execPath, ['engine/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ZHIGUI_DATA_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const call = callFactory(child);
    await call('zhigui_get_assistant_bootstrap');
    const directContext = await call('zhigui_get_context', { query: 'Panel fact' });
    assert.ok(directContext.hasContext && directContext.items.some(item => item.type === 'task' && item.id === panelTask.id),
      'query context must retain direct schedule matches even when they have no topic');
    const afterCarry = Storage.readFullState();
    assert.ok(afterCarry.schedule.days[today].tasks.some(task => task.id === carried.id && task.carriedFrom === yesterday));
    assert.ok(afterCarry.decisions[0].relatedActionIds.includes(carried.id));

    // A conversational completion can atomically create the later check-in.
    const direct = await call('zhigui_update_task', {
      date: today,
      taskId: panelTask.id,
      completed: true,
      completionImpact: {
        followUp: {
          mode: 'check_in',
          dueAt: DateUtils.nextDay(today, 3),
          question: 'Ask whether the family recovery needs another call.',
          reason: 'The visit needs a later check-in.',
          contextRefs: [{ type: 'note', id: note.id }],
        },
      },
    });
    assert.equal(direct.completed, true);
    const afterDirect = Storage.readFullState();
    assert.ok(afterDirect.followUps.some(item => item.sourceActionId && item.dueDate === DateUtils.nextDay(today, 3)));

    console.log('PASS assistant continuity regressions');
  } finally {
    if (child) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
