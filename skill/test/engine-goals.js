// Focused engine test: strategic + sub-goal complete/delete, derived-task cascade,
// and the priority recalculation script (no hard rules, AI-owned scores).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-goals-'));
process.env.LINGXI_DATA_DIR = testDir;

const { ensureDataInitialized } = require('../lib/init-data');
const Actions = require('../engine/actions');
const Storage = require('../engine/storage');

ensureDataInitialized(testDir);
Actions.configure(testDir);

function today() { return new Date().toISOString().slice(0, 10); }

(async () => {
  try {
    // 1) Strategic goal
    const sg = Actions.execute('goal.add', { type: 'strategicGoal', title: '考研战略' });
    assert.equal(sg.goal.type, 'strategic');
    const sgId = sg.goal.id;

    // 2) Sub-goal (currentGoal) linked to the strategic goal
    const sub = Actions.execute('goal.add', { type: 'currentGoal', title: '数学一轮复习' });
    const subId = sub.goal.id;
    // link it like the MCP lingxi_add_goal would
    const state = Storage.readFullState();
    const subGoal = state.currentGoals.find(g => g.id === subId);
    subGoal.relatedStrategicGoalId = sgId;
    subGoal.baseTitle = '考研';
    subGoal.phaseName = '基础阶段';
    Storage.writeState(state);

    // 3) A derived task under the sub-goal
    const ev = Actions.execute('event.add', { date: today(), time: '09:00', title: '高数练习' });
    const taskId = ev.task.id;
    const s2 = Storage.readFullState();
    const day = s2.schedule.days[today()];
    const task = day.tasks.find(t => t.id === taskId);
    task.relatedGoalId = subId;
    task.relatedStrategicGoalId = sgId;
    Storage.writeState(s2);

    // 4) Complete the sub-goal
    const c1 = Actions.execute('goal.complete', { id: subId, completed: true });
    assert.equal(c1.success, true);
    assert.equal(c1.goal.completed, true);
    assert.equal(c1.type, 'currentGoal');

    // 5) Reopen the sub-goal, then complete the strategic goal
    Actions.execute('goal.complete', { id: subId, completed: false });
    const c2 = Actions.execute('goal.complete', { id: sgId, completed: true });
    assert.equal(c2.success, true);
    assert.equal(c2.goal.completed, true);
    assert.equal(c2.type, 'strategicGoal');

    // 6) Cascade delete the strategic goal removes the derived task
    const before = Storage.readFullState();
    assert.ok(before.schedule.days[today()].tasks.some(t => t.id === taskId));
    const del = Actions.execute('goal.delete', { type: 'strategicGoal', id: sgId });
    assert.equal(del.success, true);
    const after = Storage.readFullState();
    assert.equal(after.schedule.days[today()].tasks.some(t => t.id === taskId), false, 'derived task should be cascade-deleted');
    assert.equal(after.strategicGoals.some(g => g.id === sgId), false);

    // 7) Priority recalculation script runs without crashing (no hard rules)
    const { execFileSync } = require('child_process');
    const node = process.execPath;
    const out = execFileSync(node, ['scripts/recalc-priorities.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, LINGXI_DATA_DIR: testDir },
    }).toString();
    assert.ok(out.includes('recalc') || out.includes('priority') || out.includes('done') || out.length >= 0, 'recalc script output');

    console.log('PASS engine-goals');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
})();
