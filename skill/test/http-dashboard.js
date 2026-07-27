const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-http-'));
const port = 17888 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dashboard/server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, ZHIGUI_DATA_DIR: testDir, ZHIGUI_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard server start timed out')), 8000);
    const inspect = chunk => {
      if (String(chunk).includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => reject(new Error(`Dashboard server exited early (${code})`)));
  });
}

async function post(url, body) {
  const response = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || url);
  return data;
}

(async () => {
  try {
    await waitForServer();
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.status, 'ok');

    const page = await (await fetch(base + '/')).text();
    assert.ok(page.includes('focus-hero'));
    assert.ok(page.includes('toast-region'));
    assert.equal(page.includes('section-decisions'), false);

    const goal = await post('/api/goal/add', { type: 'currentGoal', title: 'HTTP contract goal', priority: 70 });
    assert.equal(goal.goal.type, 'current');
    const errand = await post('/api/errand/add', { title: 'HTTP contract errand', date: '2026-07-22' });
    assert.equal(errand.errand.title, 'HTTP contract errand');
    const timedErrand = await post('/api/errand/update', { id: errand.errand.id, time: '14:30', duration: 45 });
    assert.equal(timedErrand.errand.time, '14:30');
    assert.equal(timedErrand.errand.duration, 45);
    const queuedErrand = await post('/api/errand/update', { id: errand.errand.id, time: '' });
    assert.equal(queuedErrand.errand.time, '');
    const event = await post('/api/event/add', { title: 'HTTP contract event', date: '2026-07-22', time: '13:00' });
    const note = await post('/api/note/add', { content: 'Raw dashboard capture awaiting AI organization.' });
    assert.equal(note.note.needsEnrichment, true);
    const imported = await post('/api/note/add', { content: 'A previous note kept in its original wording.' });
    assert.equal(imported.note.needsEnrichment, true);
    await post('/api/task/toggle', { date: '2026-07-22', taskId: event.task.id });
    await post('/api/goal/complete', { id: goal.goal.id, completed: true });
    const deletedTask = await post('/api/task/delete', { date: '2026-07-22', taskId: event.task.id });
    assert.equal(deletedTask.deleted, 'HTTP contract event');

    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.currentGoals[0].completed, true);
    assert.equal(state.errands.length, 1);
    assert.equal(state.notes[0].title, '待 AI 归纳');
    assert.equal(state.notes.some(item => item.id === imported.note.id && item.content.includes('original wording')), true);
    assert.equal(state.schedule.days['2026-07-22'].tasks.some(task => task.id === event.task.id), false);
    console.log('PASS http-dashboard');
  } finally {
    child.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
