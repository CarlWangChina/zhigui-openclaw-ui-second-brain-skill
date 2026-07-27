const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-mechanism-'));
const today = new Date().toISOString().slice(0, 10);
const tomorrowDate = new Date(`${today}T00:00:00`);
tomorrowDate.setDate(tomorrowDate.getDate() + 1);
const tomorrow = tomorrowDate.toISOString().slice(0, 10);

function callFactory(child) {
  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
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
  let child;
  try {
    ensureDataInitialized(testDir);
    Storage.setDataDir(testDir);
    const state = Storage.readFullState();
    state.currentGoals = [
      { id: 'g_due', title: 'Deadline-sensitive goal', description: 'Prepare the final deliverable.', deadline: tomorrow, priority: 50, completed: false, domain: 'career' },
      { id: 'g_locked', title: 'User-locked priority', description: 'Keep its priority intact.', deadline: tomorrow, priority: 77, completed: false, locked: true, prioritySource: 'user', domain: 'learning' },
    ];
    state.constraints = [{ id: 'c_sleep', title: 'No late nights', rules: [{ type: 'no_late_night', sleepTime: '23:00' }] }];
    state.schedule = { days: { [today]: { date: today, tasks: [
      { id: 't_a', title: 'First timed task', time: '20:30', duration: 60, completed: false, source: 'manual', category: 'event' },
      { id: 't_b', title: 'Overlapping timed task', time: '21:00', duration: 60, completed: false, source: 'manual', category: 'event' },
    ] } } };
    state.notes = [{ id: 'n_secret', title: 'AI-authored title only', content: 'This body must not appear in the overview.', category: 'Test', createdAt: new Date().toISOString() }];
    state.userProfile = { valueSystem: { priorities: [{ domain: 'career', weight: 90 }, { domain: 'learning', weight: 10 }] } };
    Storage.writeState(state);

    child = spawn(process.execPath, ['engine/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, LINGXI_DATA_DIR: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const call = callFactory(child);
    const overview = await call('lingxi_get_overview');

    assert.ok(overview.dailyCheck?.ranAt, 'overview must run the daily check');
    assert.equal(Object.hasOwn(overview.notes[0], 'content'), false, 'Layer-0 must not expose note bodies');
    assert.equal(Object.hasOwn(overview.constraints[0], 'short'), false, 'Layer-0 must not expose constraint details');
    assert.deepEqual(Object.keys(overview.scheduleDays[0]).sort(), ['completedCount', 'date', 'taskCount']);
    assert.ok(overview.dailyCheck.conflicts.total >= 2, 'daily check must detect overlap and structured constraint violation');

    const stateAfterCheck = await call('lingxi_get_state', { sections: ['currentGoals'] });
    const unlocked = stateAfterCheck.currentGoals.find(goal => goal.id === 'g_due');
    const locked = stateAfterCheck.currentGoals.find(goal => goal.id === 'g_locked');
    assert.ok(Number.isInteger(unlocked.daysLeft) && unlocked.daysLeft >= 0 && unlocked.daysLeft <= 1,
      'daily check must refresh daysLeft from the deadline');
    assert.equal(locked.priority, 77, 'daily check must not overwrite a user lock');

    const noSelectionRecall = await call('lingxi_recall', { topicIds: [] });
    assert.equal(noSelectionRecall.hasContext, false, 'recall requires AI-selected topic IDs rather than text matching');

    const instructions = await call('lingxi_get_instructions');
    assert.equal(Object.hasOwn(instructions, 'legacyDeprecatedRules'), false, 'deprecated rigid rules must not be exposed to the AI');
    assert.ok(instructions.absoluteRules.some(rule => rule.includes('AI-owned sedimentation')),
      'AI instructions must explicitly forbid rule-based sedimentation');

    const textOnlyImpact = await call('lingxi_check_impact', {
      type: 'currentGoal', title: 'Work late tonight', description: 'A title alone is not structured evidence.', deadline: tomorrow,
    });
    assert.equal(textOnlyImpact.conflicts.some(conflict => conflict.type === 'constraint_violation'), false,
      'constraint conflicts must not be guessed from wording');
    const aiAssessedImpact = await call('lingxi_check_impact', {
      type: 'currentGoal', title: 'Work late tonight', deadline: tomorrow,
      constraintAssessments: [{ constraintId: 'c_sleep', conflicts: true, reasoning: 'AI reviewed the sleep rule and this commitment exceeds its latest end time.' }],
    });
    assert.equal(aiAssessedImpact.conflicts.some(conflict => conflict.type === 'constraint_violation'), true,
      'structured AI constraint assessments must participate in impact checks');

    const schedule = await call('lingxi_auto_schedule', { startDate: today, days: 1 });
    assert.equal(schedule.valueSystem.appliedInScheduling, true, 'value weights must participate in scheduling');

    console.log('PASS mechanism-audit');
  } finally {
    if (child) child.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
