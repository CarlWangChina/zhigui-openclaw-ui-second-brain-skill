'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');
const { seedDemoData } = require('../scripts/seed-demo-data');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-demo-seed-'));
try {
  const result = seedDemoData(root);
  assert.equal(result.seeded, true);
  const state = Storage.readFullState();
  assert.equal(state.notes.length, 3);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.reminders.length, 1);
  assert.ok(state.lastReflection?.date, 'the seed must include a date-scoped reflection example');

  const crossTopicTask = Object.values(state.schedule.days)
    .flatMap(day => day.tasks || [])
    .find(task => task.title === '示例｜核对跨主题关联是否可追溯');
  assert.equal(crossTopicTask.noteIds.length, 3,
    'the demo must include one action linked to notes from multiple topics');
  assert.equal(crossTopicTask.decisionIds.length, 1);

  // A normal action after the seed must not erase the state-only reflection.
  Actions.execute('errand.add', { title: 'Seed preservation probe', duration: 15 });
  assert.ok(Storage.readFullState().lastReflection?.date,
    'lastReflection must survive an unrelated write');
  assert.equal(seedDemoData(root).reason, 'already-seeded',
    'the seed must be idempotent and never duplicate a demo workspace');
  console.log('PASS demo-seed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
