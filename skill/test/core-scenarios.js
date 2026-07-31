/**
 * Core scenario tests for the ZhiGui project.
 * Covers key scenarios from engine/test-cases.md.
 * Uses Node.js built-in assert module with a temporary data directory.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');
const { BrainIndex } = require('../engine/brain-index');
const Scheduler = require('../engine/scheduler');
const DateUtils = require('../engine/date-utils');
const Utils = require('../engine/utils');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-core-'));
ensureDataInitialized(testDir);
Storage.setDataDir(testDir);
Actions.configure(testDir);

let count = 0;

// --- Section 1: Goal Management ---
console.log('--- Section 1: Goal Management ---');

// TC-GOAL-1: Add strategic goal, current goal, and constraint — verify types, IDs, and fields
{
  const sg = Actions.execute('goal.add', { type: 'strategicGoal', title: 'SG1', description: 'desc1' });
  assert.equal(sg.success, true);
  assert.ok(sg.goal.id.startsWith('goal_'));
  assert.equal(sg.goal.type, 'strategic');
  assert.equal(sg.goal.title, 'SG1');
  assert.equal(sg.goal.description, 'desc1');
  assert.equal(Object.hasOwn(sg.goal, 'priority'), false);
  assert.equal(sg.goal.completed, false);

  const cg = Actions.execute('goal.add', { type: 'currentGoal', title: 'CG1' });
  assert.equal(cg.success, true);
  assert.ok(cg.goal.id.startsWith('goal_'));
  assert.equal(cg.goal.type, 'current');
  assert.equal(cg.goal.title, 'CG1');

  const ct = Actions.execute('goal.add', { type: 'constraint', title: 'CT1' });
  assert.equal(ct.success, true);
  assert.ok(ct.goal.id.startsWith('constraint_'));
  assert.equal(ct.goal.type, 'constraint');
  assert.equal(ct.goal.title, 'CT1');
  count += 3;
}

// TC-GOAL-2: Complete a current goal — verify completed flag, completedAt set
{
  const g = Actions.execute('goal.add', { type: 'currentGoal', title: 'CompleteMe' });
  const result = Actions.execute('goal.complete', { id: g.goal.id, completed: true });
  assert.equal(result.completed, true);
  assert.ok(result.goal.completedAt);
  count++;
}

// TC-GOAL-3: Delete a goal — verify removal from state, cascade removal of related schedule tasks
{
  const g = Actions.execute('goal.add', { type: 'currentGoal', title: 'DeleteMe' });
  const date = '2026-07-23';
  const ev = Actions.execute('event.add', { date, time: '09:00', title: 'Linked task', duration: 30 });
  // Manually link the task to the goal so cascade can be tested
  const state = Storage.readFullState();
  const task = state.schedule.days[date].tasks.find(t => t.id === ev.task.id);
  task.relatedGoalId = g.goal.id;
  Storage.writeState(state);

  Actions.execute('goal.delete', { type: 'currentGoal', id: g.goal.id });
  const after = Storage.readFullState();
  assert.ok(!after.currentGoals.some(x => x.id === g.goal.id));
  assert.ok(!after.schedule.days[date].tasks.some(t => t.relatedGoalId === g.goal.id));
  count++;
}

// TC-GOAL-4: Numeric priority input is ignored and never persisted.
{
  const g = Actions.execute('goal.add', { type: 'currentGoal', title: 'NoNumericPriority', priority: 95 });
  const state = Storage.readFullState();
  const goal = state.currentGoals.find(x => x.id === g.goal.id);
  assert.equal(Object.hasOwn(goal, 'priority'), false);
  assert.equal(Object.hasOwn(goal, 'locked'), false);
  count++;
}

// --- Section 2: Task Management ---
console.log('--- Section 2: Task Management ---');

const TASK_DATE = '2026-07-23';

// TC-TASK-1: Add event/task via event.add — verify manualLocked=true, correct time/duration
{
  const ev = Actions.execute('event.add', { date: TASK_DATE, time: '10:00', title: 'Task1', duration: 45 });
  assert.equal(ev.success, true);
  assert.equal(ev.task.manualLocked, true);
  assert.ok(ev.task.manualLockedAt);
  assert.equal(ev.task.time, '10:00');
  assert.equal(ev.task.duration, 45);
  count++;
}

// TC-TASK-2: Toggle task completion — verify completed flag and completedAt
{
  const ev = Actions.execute('event.add', { date: TASK_DATE, time: '11:00', title: 'Task2', duration: 30 });
  const tog = Actions.execute('task.toggle', { date: TASK_DATE, taskId: ev.task.id });
  assert.equal(tog.completed, true);
  assert.ok(tog.task.completedAt);
  // Toggle back
  const tog2 = Actions.execute('task.toggle', { date: TASK_DATE, taskId: ev.task.id });
  assert.equal(tog2.completed, false);
  assert.equal(tog2.task.completedAt, null);
  count++;
}

// TC-TASK-3: Update task time — verify manualLocked=true, new time applied
{
  const ev = Actions.execute('event.add', { date: TASK_DATE, time: '13:00', title: 'Task3', duration: 60 });
  const upd = Actions.execute('task.update', { date: TASK_DATE, taskId: ev.task.id, time: '14:30', duration: 90 });
  assert.equal(upd.task.manualLocked, true);
  assert.equal(upd.task.time, '14:30');
  assert.equal(upd.task.duration, 90);
  count++;
}

// TC-TASK-4: Delete task — verify removal from day
{
  const ev = Actions.execute('event.add', { date: TASK_DATE, time: '15:00', title: 'Task4', duration: 30 });
  Actions.execute('task.delete', { date: TASK_DATE, taskId: ev.task.id });
  const state = Storage.readFullState();
  assert.ok(!state.schedule.days[TASK_DATE].tasks.some(t => t.id === ev.task.id));
  count++;
}

// TC-TASK-5: Unlock task — verify manualLocked=false, manualLockedAt removed
{
  const ev = Actions.execute('event.add', { date: TASK_DATE, time: '16:00', title: 'Task5', duration: 30 });
  assert.equal(ev.task.manualLocked, true);
  const unlocked = Actions.execute('task.unlock', { date: TASK_DATE, taskId: ev.task.id });
  assert.equal(unlocked.task.manualLocked, false);
  assert.equal(unlocked.task.manualLockedAt, undefined);
  count++;
}

// --- Section 3: Errand System ---
console.log('--- Section 3: Errand System ---');

// TC-ERRAND-1: Add must-level errand — verify commitmentLevel='must'
{
  const e = Actions.execute('errand.add', { title: 'MustErrand', date: '2026-07-23', commitmentLevel: 'must' });
  assert.equal(e.errand.commitmentLevel, 'must');
  count++;
}

// TC-ERRAND-2: Add should-level errand — verify commitmentLevel='should'
{
  const e = Actions.execute('errand.add', { title: 'ShouldErrand', date: '2026-07-23', commitmentLevel: 'should' });
  assert.equal(e.errand.commitmentLevel, 'should');
  count++;
}

// TC-ERRAND-2b: A fixed date without time is a date-fixed commitment, while no
// date remains genuinely unscheduled.
{
  const fixed = Actions.execute('errand.add', { title: 'Concert', date: '2026-08-01', commitmentLevel: 'must' });
  const unscheduled = Actions.execute('errand.add', { title: 'Decide weekend plan' });
  assert.equal(fixed.errand.date, '2026-08-01');
  assert.equal(fixed.errand.time, '');
  assert.equal(unscheduled.errand.date, null);
  count++;
}

// TC-ERRAND-3: Complete errand — verify moved to completedActions, removed from active errands
{
  const e = Actions.execute('errand.add', { title: 'TransientErrand', date: '2026-07-23', commitmentLevel: 'nice', retention: 'transient' });
  const result = Actions.execute('errand.complete', { id: e.errand.id });
  assert.equal(result.discarded, false);
  assert.equal(result.completed, true);
  assert.ok(result.action, 'should return completed action record');
  assert.equal(result.action.errandId, e.errand.id);
  const state = Storage.readFullState();
  assert.ok(!state.errands.some(x => x.id === e.errand.id), 'should be removed from active errands');
  assert.ok(state.completedActions.some(x => x.errandId === e.errand.id), 'should be in completedActions');
  count++;
}

// TC-ERRAND-4: Complete errand — verify all completions go to completedActions with correct pattern
{
  const e = Actions.execute('errand.add', { title: 'ReviewErrand', date: '2026-07-23', commitmentLevel: 'should', retention: 'review' });
  const result = Actions.execute('errand.complete', { id: e.errand.id });
  assert.equal(result.completed, true);
  assert.ok(result.action, 'should return completed action record');
  assert.equal(result.action.pattern, 'one-time');
  const state = Storage.readFullState();
  assert.ok(!state.errands.some(x => x.id === e.errand.id), 'should be removed from active errands');
  assert.ok(state.completedActions.some(x => x.errandId === e.errand.id), 'should be in completedActions');
  count++;
}

// --- Section 5: Note Management ---
console.log('--- Section 5: Note Management ---');

// TC-NOTE-1: Add note with domain/category — verify fields populated
{
  const n = Actions.execute('note.add', {
    content: 'Test note content', title: 'TestNote', domain: 'health', category: 'medical',
  });
  assert.equal(n.success, true);
  assert.equal(n.note.domain, 'health');
  assert.equal(n.note.category, 'medical');
  assert.equal(n.note.title, 'TestNote');
  assert.equal(n.note.content, 'Test note content');
  count++;
}

// TC-NOTE-2: Add note with AI classification — verify confirmed note appears in state
{
  const result = Actions.execute('note.add', {
    content: 'AI-classified note', title: 'AI Title', topic: 'Test Topic', category: 'Other',
  });
  assert.equal(result.success, true);
  assert.equal(result.note.organizationStatus, 'confirmed');
  assert.equal(result.note.title, 'AI Title');
  count++;
}

// TC-NOTE-3: Delete note — verify removed from state
{
  const n = Actions.execute('note.add', { content: 'Delete me' });
  Actions.execute('note.delete', { noteId: n.note.id });
  const state = Storage.readFullState();
  assert.ok(!state.notes.some(x => x.id === n.note.id));
  count++;
}

// --- Section 6: One-shot Goal Behavior ---
console.log('--- Section 6: One-shot Goal Behavior ---');

// TC-ONESHOT-1: Complete task for one-shot goal — verify goal marked completed
{
  // Create a one-shot goal directly in state
  const state = Storage.readFullState();
  const oneShotGoal = {
    id: 'goal_oneshot_test_' + Date.now(),
    type: 'current',
    title: 'OneShotGoal',
    isOneShot: true,
    completed: false,
    source: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.currentGoals.push(oneShotGoal);
  Storage.writeState(state);

  // Add a task linked to this one-shot goal
  const ev = Actions.execute('event.add', { date: '2026-07-23', time: '10:00', title: 'OneShotTask', duration: 30 });
  // Link the task to the one-shot goal
  const state2 = Storage.readFullState();
  const task = state2.schedule.days['2026-07-23'].tasks.find(t => t.id === ev.task.id);
  task.relatedGoalId = oneShotGoal.id;
  Storage.writeState(state2);

  // Toggle complete
  const result = Actions.execute('task.toggle', { date: '2026-07-23', taskId: ev.task.id });
  assert.equal(result.completed, true);

  // Verify goal is now completed
  const state3 = Storage.readFullState();
  const goal = state3.currentGoals.find(g => g.id === oneShotGoal.id);
  assert.equal(goal.completed, true);
  assert.ok(goal.completedAt);
  count++;
}

// TC-ONESHOT-2: Verify future tasks removed after one-shot goal completion
{
  const futureDate = '2026-07-25';
  // Create a one-shot goal
  const state = Storage.readFullState();
  const osGoal = {
    id: 'goal_oneshot_future_' + Date.now(),
    type: 'current',
    title: 'OneShotFuture',
    isOneShot: true,
    completed: false,
    source: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.currentGoals.push(osGoal);
  Storage.writeState(state);

  // Add a task today linked to this goal
  const ev1 = Actions.execute('event.add', { date: '2026-07-23', time: '08:00', title: 'OSTaskToday', duration: 30 });
  const s2 = Storage.readFullState();
  const t1 = s2.schedule.days['2026-07-23'].tasks.find(t => t.id === ev1.task.id);
  t1.relatedGoalId = osGoal.id;
  Storage.writeState(s2);

  // Add a task in the future linked to this goal
  const ev2 = Actions.execute('event.add', { date: futureDate, time: '09:00', title: 'OSTaskFuture', duration: 30 });
  const s3 = Storage.readFullState();
  const t2 = s3.schedule.days[futureDate].tasks.find(t => t.id === ev2.task.id);
  t2.relatedGoalId = osGoal.id;
  Storage.writeState(s3);

  // Complete today's task
  Actions.execute('task.toggle', { date: '2026-07-23', taskId: ev1.task.id });

  // Verify future task was removed
  const stateAfter = Storage.readFullState();
  const futureTasks = stateAfter.schedule.days[futureDate] ? stateAfter.schedule.days[futureDate].tasks : [];
  assert.ok(!futureTasks.some(t => t.relatedGoalId === osGoal.id));
  count++;
}

// --- Section 7: Storage Layer ---
console.log('--- Section 7: Storage Layer ---');

// TC-STORAGE-1: readFullState after writeState — verify all fields present
{
  const state = Storage.readFullState();
  assert.ok(Array.isArray(state.strategicGoals));
  assert.ok(Array.isArray(state.currentGoals));
  assert.ok(Array.isArray(state.constraints));
  assert.ok(state.schedule);
  assert.ok(state.schedule.days);
  assert.ok(Array.isArray(state.errands));
  assert.ok(Array.isArray(state.notes));
  assert.ok(state.meta);
  assert.ok(state.meta.lastUpdated);
  assert.equal(state._hierarchyEnabled, true);
  count++;
}

// TC-STORAGE-2: Cache invalidation on write — verify readFullState returns fresh data
{
  const s1 = Storage.readFullState();
  const beforeCount = s1.currentGoals.length;
  // Write new data
  Actions.execute('goal.add', { type: 'currentGoal', title: 'CacheTestGoal' });
  // Read again — should see the new goal
  const s2 = Storage.readFullState();
  assert.ok(s2.currentGoals.length > beforeCount);
  count++;
}

// TC-STORAGE-3: Lightweight vs full state — verify lightweight has _lightweight markers, full has bodies
{
  const lightweight = Storage.readState(); // readState returns lightweight
  const full = Storage.readFullState();

  // Lightweight notes have _lightweight markers and no body
  if (lightweight.notes && lightweight.notes.length > 0) {
    assert.equal(lightweight.notes[0]._lightweight, true);
    assert.equal(lightweight.notes[0].content, undefined);
  }
  // Full notes have body content
  if (full.notes && full.notes.length > 0) {
    assert.ok(full.notes[0].content !== undefined || full.notes[0]._lightweight !== true);
  }
  // Lightweight schedule has _lightweight marker
  assert.equal(lightweight.schedule._lightweight, true);
  count++;
}

// --- Section 8: Scheduler Sub-functions (pure logic, no data persistence needed) ---
console.log('--- Section 8: Scheduler Sub-functions ---');

// TC-SCHED-1: computePhaseRanges — verify phase goals get date ranges
{
  const goals = [
    { id: 'g1', baseTitle: 'Phase A', deadline: '2026-08-01' },
    { id: 'g2', baseTitle: 'Phase A', deadline: '2026-08-15' },
    { id: 'g3', title: 'Standalone' },
  ];
  const { phaseRanges, activeGoals } = Scheduler.computePhaseRanges(goals, '2026-07-23');
  assert.equal(phaseRanges.size, 2); // g1 and g2 have phases; g3 is standalone
  assert.ok(phaseRanges.has('g1'));
  assert.ok(phaseRanges.has('g2'));
  const r1 = phaseRanges.get('g1');
  assert.equal(r1.start, '2026-07-23'); // no prev deadline, starts at startDate
  assert.equal(r1.end, '2026-08-01');
  const r2 = phaseRanges.get('g2');
  assert.equal(r2.start, '2026-08-02'); // next day after g1 deadline
  assert.equal(r2.end, '2026-08-15');
  assert.equal(activeGoals.length, 3); // all goals in activeGoals
  count++;
}

// TC-SCHED-2: parseConstraintRules — verify no_late_night, rest_day, daily_exercise parsing
{
  const constraints = [
    {
      id: 'c1',
      rules: [
        { type: 'no_late_night', sleepTime: '23:00' },
        { type: 'rest_day', dayOfWeek: 0 }, // Sunday
        { type: 'daily_exercise', durationMinutes: 45 },
      ],
    },
  ];
  const result = Scheduler.parseConstraintRules(constraints);
  // no_late_night: sleepTime 23:00 => latestTaskTime = 21:00
  assert.equal(result.latestTaskTime, '21:00');
  // rest_day: Sunday = weekday 0
  assert.ok(result.restDays.includes(0));
  // daily_exercise: 45 minutes
  assert.equal(result.dailyExercise, 45);
  // constraintRules should have 3 entries
  assert.equal(result.constraintRules.length, 3);
  count++;
}

// TC-SCHED-3: isOneShotGoal — verify true/false detection
{
  assert.equal(Scheduler.isOneShotGoal({ isOneShot: true }), true);
  assert.equal(Scheduler.isOneShotGoal({ isOneShot: false }), false);
  assert.equal(Scheduler.isOneShotGoal({ }), false);
  assert.equal(Scheduler.isOneShotGoal({ isOneShot: 'yes' }), false); // strict true check
  count++;
}

// TC-SCHED-4: getProfileAwareSlots — verify night_owl/early_bird/standard slot configurations
{
  const nightOwl = Scheduler.getProfileAwareSlots('', '23:00', 23, 'night_owl');
  assert.equal(nightOwl.profile, 'night_owl');
  assert.ok(nightOwl.slots.length >= 3);

  const earlyBird = Scheduler.getProfileAwareSlots('', '22:00', 22, 'early_bird');
  assert.equal(earlyBird.profile, 'early_bird');
  assert.ok(earlyBird.slots.length >= 3);
  assert.equal(earlyBird.slots[0].start, '07:00'); // early bird starts at 7am

  const standard = Scheduler.getProfileAwareSlots('', '22:00', 22, 'standard');
  assert.equal(standard.profile, 'standard');
  assert.ok(standard.slots.length >= 3);
  assert.equal(standard.slots[0].start, '09:00'); // standard starts at 9am
  count++;
}

// --- Section 9: Utility Functions ---
console.log('--- Section 9: Utility Functions ---');

// TC-UTIL-1: genId — verify prefix + format
{
  const id1 = Utils.genId('t');
  assert.ok(id1.startsWith('t_'));
  // Format: prefix + '_' + base36timestamp + base36random
  const parts = id1.split('_');
  assert.equal(parts[0], 't');
  assert.ok(parts[1].length > 0);
  // Two different calls should yield different IDs
  const id2 = Utils.genId('t');
  assert.notEqual(id1, id2);
  count++;
}

// TC-UTIL-2: normalizeTime — verify valid/invalid/empty inputs
{
  assert.equal(Utils.normalizeTime('9:05'), '09:05');
  assert.equal(Utils.normalizeTime('  14:30  '), '14:30');
  assert.equal(Utils.normalizeTime(''), '');
  assert.equal(Utils.normalizeTime(null), '');
  assert.equal(Utils.normalizeTime(undefined), '');
  assert.equal(Utils.normalizeTime('invalid'), null);
  assert.equal(Utils.normalizeTime('25:00'), null);
  assert.equal(Utils.normalizeTime('12:60'), null);
  count++;
}

// TC-UTIL-3: normalizeDate — verify valid/invalid/empty inputs
{
  assert.equal(Utils.normalizeDate('2026-07-23'), '2026-07-23');
  assert.equal(Utils.normalizeDate(''), '');
  assert.equal(Utils.normalizeDate(null), '');
  assert.equal(Utils.normalizeDate(undefined), '');
  assert.equal(Utils.normalizeDate('not-a-date'), null);
  assert.equal(Utils.normalizeDate('2026-13-01'), null); // invalid month
  assert.equal(Utils.normalizeDate('2026-02-30'), null); // invalid day
  count++;
}

// TC-UTIL-4: clamp — verify boundaries
{
  assert.equal(Utils.clamp(50), 50);
  assert.equal(Utils.clamp(-10), 0);
  assert.equal(Utils.clamp(150), 100);
  assert.equal(Utils.clamp(50, 10, 90), 50);
  assert.equal(Utils.clamp(5, 10, 90), 10);
  assert.equal(Utils.clamp(95, 10, 90), 90);
  assert.equal(Utils.clamp(50.7, 0, 100), 51); // rounds to integer
  count++;
}

// --- Section 10: Value System ---
console.log('--- Section 10: Value System ---');

// TC-VALUE-1: updateWeights — verify value system stored correctly
{
  Actions.execute('weights.update', {
    priorities: [
      { domain: 'health', weight: 90 },
      { domain: 'learning', weight: 80 },
    ],
    decisionStyle: 'aggressive',
  });
  const state = Storage.readFullState();
  assert.ok(state.userProfile);
  assert.ok(state.userProfile.valueSystem);
  assert.equal(state.userProfile.valueSystem.decisionStyle, 'aggressive');
  assert.ok(Array.isArray(state.userProfile.valueSystem.priorities));
  assert.equal(state.userProfile.valueSystem.priorities.length, 2);
  count++;
}

// TC-VALUE-2: Domain weight lookup — verify correct weights for known/unknown domains
{
  const valueSystem = {
    priorities: [
      { domain: 'health', weight: 90 },
      { domain: 'learning', weight: 80 },
    ],
  };
  assert.equal(Scheduler.getDomainWeight('health', valueSystem), 90);
  assert.equal(Scheduler.getDomainWeight('learning', valueSystem), 80);
  assert.equal(Scheduler.getDomainWeight('misc', valueSystem), 50); // unknown domain -> default
  assert.equal(Scheduler.getDomainWeight('family_health', valueSystem), 90); // alias -> health
  assert.equal(Scheduler.getDomainWeight('academic', valueSystem), 80); // alias -> learning
  // Null valueSystem -> default 50
  assert.equal(Scheduler.getDomainWeight('health', null), 50);
  count++;
}

// --- Cleanup ---
fs.rmSync(testDir, { recursive: true, force: true });

console.log('PASS core-scenarios (' + count + ' assertions)');
