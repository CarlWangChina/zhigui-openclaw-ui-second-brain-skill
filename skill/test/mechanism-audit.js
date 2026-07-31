const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const DateUtils = require('../engine/date-utils');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-mechanism-'));
// Use timezone-safe date utilities to match the engine's DateUtils.todayStr()
const today = DateUtils.todayStr();
const tomorrow = DateUtils.nextDay(today, 1);

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
      else entry.resolve(entry.raw ? message.result : JSON.parse(message.result.content[0].text));
    }
  });
  const call = (name, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
  call.listTools = () => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, raw: true });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })}\n`);
  });
  return call;
}

(async () => {
  let child;
  try {
    ensureDataInitialized(testDir);
    Storage.setDataDir(testDir);
    const state = Storage.readFullState();
    state.currentGoals = [
      { id: 'g_due', title: 'Deadline-sensitive goal', description: 'Prepare the final deliverable.', deadline: tomorrow, completed: false, domain: 'career' },
      { id: 'g_commitment', title: 'Explicit commitment', description: 'Keep its declared commitment intact.', deadline: tomorrow, completed: false, domain: 'learning' },
    ];
    state.constraints = [{ id: 'c_sleep', title: 'No late nights', rules: [{ type: 'no_late_night', sleepTime: '23:00' }] }];
    state.schedule = { days: { [today]: { date: today, tasks: [
      { id: 't_a', title: 'First timed task', time: '20:30', duration: 60, completed: false, source: 'manual', category: 'event' },
      { id: 't_b', title: 'Overlapping timed task', time: '21:00', duration: 60, completed: false, source: 'manual', category: 'event' },
    ] } } };
    state.errands = [{ id: 'e_hike', title: 'Tomorrow hiking', date: tomorrow, time: '', duration: 240, commitmentLevel: 'must', completed: false, category: 'health' }];
    state.reminders = [{ id: 'rm_due', title: 'Due conversation reminder', triggerAt: new Date(Date.now() - 60000).toISOString(), commitmentLevel: 'must', fired: false }];
    state.notes = [{ id: 'n_secret', title: 'AI-authored title only', content: 'This body must not appear in the overview.', category: 'Test', createdAt: new Date().toISOString() }];
    state.userProfile = { valueSystem: { priorities: [{ domain: 'career', weight: 90 }, { domain: 'learning', weight: 10 }] } };
    Storage.writeState(state);

    child = spawn(process.execPath, ['engine/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ZHIGUI_DATA_DIR: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const call = callFactory(child);
    const initialBootstrap = await call('zhigui_get_assistant_bootstrap');
    assert.ok(initialBootstrap.dailyCheck?.ranAt, 'bootstrap must run the daily check');
    assert.equal(initialBootstrap.dueReminders?.[0]?.id, 'rm_due', 'bootstrap must surface an overdue reminder without a separate tool call');
    assert.equal(Object.hasOwn(initialBootstrap.noteIndex[0], 'content'), false, 'Layer-0 must not expose note bodies');
    assert.equal(Object.hasOwn(initialBootstrap.hardConstraints[0], 'short'), false, 'Layer-0 must not expose constraint details');
    assert.equal(initialBootstrap.today.taskTotal, 2, 'Layer-0 must expose a compact count for today\'s schedule');
    assert.ok(initialBootstrap.dailyCheck.conflicts.total >= 2, 'daily check must detect overlap and structured constraint violation');
    assert.ok(initialBootstrap.upcomingCommitments.some(item => item.id === 'e_hike' && item.timing === 'time_pending'),
      'bootstrap must index a fixed-date, time-pending commitment without loading every future day');
    const tomorrowSchedule = await call('zhigui_get_day_schedule', { date: tomorrow });
    assert.ok(tomorrowSchedule.dateFixedActions.some(item => item.id === 'e_hike'),
      'on-demand day reads must include date-fixed actions with no time');

    const stateAfterCheck = Storage.readFullState();
    assert.equal(stateAfterCheck.reminders.find(reminder => reminder.id === 'rm_due')?.fired, true, 'conversation-triggered reminder checks must persist the fired marker');
    const unlocked = stateAfterCheck.currentGoals.find(goal => goal.id === 'g_due');
    const commitment = stateAfterCheck.currentGoals.find(goal => goal.id === 'g_commitment');
    assert.ok(Number.isInteger(unlocked.daysLeft) && unlocked.daysLeft >= 0 && unlocked.daysLeft <= 1,
      'daily check must refresh daysLeft from the deadline');
    assert.equal(Object.hasOwn(commitment, 'priority'), false, 'numeric goal priority must not survive canonical writes');

    const skillText = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
    assert.ok(skillText.includes('Layer 0'), 'the Skill must distinguish compact orientation data from on-demand detail reads');
    assert.ok(skillText.includes('zhigui_search'), 'the Skill must require read-only retrieval before personal recommendations');
    assert.ok(skillText.includes('signal for investigation'), 'the Skill must define signals as investigation cues rather than scores');
    assert.ok(skillText.includes('completionImpact'), 'the Skill must require an atomic conversational completion-impact path');
    const listedTools = await call.listTools();
    const toolNames = listedTools.tools.map(tool => tool.name);
    assert.equal(toolNames.length, 42, 'the conversational MCP set is a reviewed, deliberately small reasoning surface');
    assert.equal(toolNames.includes('zhigui_update_errand'), true, 'errand edits must be in-place so IDs and context links survive user changes');
    assert.equal(toolNames.includes('zhigui_update_reminder'), true, 'reminder rescheduling must be in-place rather than delete-and-recreate');
    assert.equal(toolNames.includes('zhigui_update_note'), true, 'confirmed note edits must have a direct path guarded by explicit user consent');
    assert.equal(toolNames.includes('zhigui_score_goals'), false, 'retired AI scoring tool must not be published');
    assert.equal(toolNames.includes('zhigui_recalc_priorities'), false, 'retired priority-recalculation tool must not be published');
    assert.equal(toolNames.includes('zhigui_search'), true, 'the SKILL retrieval protocol must expose its global search fallback');
    assert.equal(toolNames.includes('zhigui_get_context'), true, 'the SKILL contextual-action protocol must expose compact topic context');
    assert.equal(toolNames.includes('zhigui_search_associated'), false, 'the duplicate associated-search entry must not compete with the standard context path');
    assert.equal(toolNames.includes('zhigui_recall'), false, 'the duplicate recall entry must not compete with the standard context path');
    assert.equal(toolNames.includes('zhigui_get_notes'), false, 'broad note-list reads must not be published when the compact index is in bootstrap');
    assert.equal(toolNames.includes('zhigui_check_reminders'), false, 'reminder checks run inside bootstrap rather than as a separate start-up step');
    assert.equal(toolNames.includes('zhigui_check_impact'), false, 'duplicate impact preview must not compete with Bootstrap plus targeted detail reads');
    assert.equal(toolNames.includes('zhigui_get_instructions'), false, 'stable operating rules belong in SKILL.md, not a repeated MCP context payload');
    for (const retired of ['zhigui_get_overview', 'zhigui_get_attention', 'zhigui_get_related', 'zhigui_find_path', 'zhigui_explain_entity']) {
      assert.equal(toolNames.includes(retired), false, `${retired} must remain retired rather than silently returning to the model context`);
    }
    assert.equal(toolNames.includes('zhigui_get_state'), false, 'raw state reader must not enter the assistant context');
    assert.equal(toolNames.includes('zhigui_reconcile_activity'), true, 'the assistant must be able to reconcile a pending panel activity atomically');
    assert.equal(toolNames.includes('zhigui_resolve_follow_up'), true, 'due follow-ups must have an explicit closure path');
    assert.equal(toolNames.includes('zhigui_delete_topic'), true, 'AI must have the same safe topic-delete path as the panel');

    const taskDeletePreview = await call('zhigui_delete_task', { date: today, taskId: 't_a' });
    assert.equal(taskDeletePreview.preview, true, 'AI deletion must return an impact preview before it can mutate canonical state');
    assert.ok(Storage.readFullState().schedule.days[today].tasks.some(task => task.id === 't_a'),
      'the preview must not delete the target task');
    await call('zhigui_delete_task', { date: today, taskId: 't_a', confirm: true });
    assert.equal(Storage.readFullState().schedule.days[today].tasks.some(task => task.id === 't_a'), false,
      'AI deletion with an explicit confirm flag must use the canonical action path');

    const unconfirmedNoteEdit = await call('zhigui_update_note', { id: 'note_any', content: 'rewritten' });
    assert.equal(unconfirmedNoteEdit.success, false,
      'the engine must hard-reject note body edits that lack explicit per-edit user confirmation');
    assert.ok(String(unconfirmedNoteEdit.error || '').includes('CONFIRMATION_REQUIRED'),
      'the rejection must instruct the assistant to obtain explicit consent first');

    const futureTrigger = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const rearm = await call('zhigui_update_reminder', { id: 'rm_due', triggerAt: futureTrigger });
    assert.equal(rearm.success, true, 'in-place reminder rescheduling must succeed without recreating the entity');
    const rearmed = Storage.readFullState().reminders.find(reminder => reminder.id === 'rm_due');
    assert.equal(rearmed.fired, false, 'rescheduling a fired one-time reminder to the future must re-arm it');
    assert.equal(rearmed.triggerAt, futureTrigger, 'the reminder must keep its ID while carrying the new trigger time');

    await call('zhigui_update_goal', {
      id: 'g_due', type: 'currentGoal', statusSignal: 'needs_confirmation',
      statusReason: 'Wait for the family recovery update before choosing the next action.',
    });
    const statusDetail = await call('zhigui_get_goal_detail', { goalId: 'g_due' });
    assert.equal(statusDetail.goal.statusSignal, 'needs_confirmation', 'goals must persist a qualitative status signal');
    assert.equal(statusDetail.goal.statusReason, 'Wait for the family recovery update before choosing the next action.');
    assert.equal(Object.hasOwn(statusDetail.goal, 'confidence'), false, 'goal detail must not retain a numeric confidence score');

    const familyNote = await call('zhigui_add_note', { title: 'Family recovery plan', content: 'Call the clinic before the next family visit.', topic: 'Family recovery' });
    const queriedContext = await call('zhigui_get_context', { query: 'What should I remember before visiting the family?' });
    assert.equal(queriedContext.retrieval?.hits?.some(hit => hit.topicLabel === 'Family recovery'), true,
      'query-based context lookup must surface a stored topic without requiring a preselected ID');

    // MCP conversation writes must go through the same action command layer
    // as dashboard writes: preserve links, completion history and a compact,
    // already-interpreted activity event.
    const conversationalTask = await call('zhigui_add_task', {
      date: today, time: '09:00', duration: 30, title: 'Call the family member',
      relatedGoalId: 'g_due', noteIds: [familyNote.note.id], topicId: familyNote.note.topicId,
      contextRefs: [{ type: 'goal', id: 'g_due', role: 'instruction' }, { type: 'note', id: familyNote.note.id, role: 'reference' }],
      contextReason: 'Use the recovery note to guide the call.',
    });
    assert.equal(conversationalTask.task.relatedGoalId, 'g_due', 'MCP task creation must preserve its goal relationship');
    assert.deepEqual(conversationalTask.task.noteIds, [familyNote.note.id], 'MCP task creation must preserve its note relationship');
    await call('zhigui_update_task', { date: today, taskId: conversationalTask.task.id, completed: true });
    const conversationWriteState = Storage.readFullState();
    assert.ok(conversationWriteState.completedActions.some(action => action.taskId === conversationalTask.task.id),
      'MCP task completion must create the same canonical completed-action record as the panel');
    assert.ok(Storage.readRecentActivity({ limit: 30 }).some(event => event.entityId === conversationalTask.task.id && event.operation === 'complete' && event.channel === 'conversation' && event.reconciliationStatus === 'applied'),
      'MCP task completion must be a single applied conversation event, not a pending panel fact');

    for (let index = 0; index < 13; index++) {
      await call('zhigui_add_note', { title: `Paging note ${index + 1}`, content: `Detail ${index + 1}`, topic: 'Paging topic' });
    }
    const { BrainIndex } = require('../engine/brain-index');
    const pagingTopic = new BrainIndex(testDir).getTopics().find(topic => topic.label === 'Paging topic');
    const firstTopicPage = await call('zhigui_get_topic_document', { topicId: pagingTopic.id });
    assert.equal(firstTopicPage.noteCount, 13, 'topic retrieval must report the complete note count');
    assert.equal(firstTopicPage.notes.length, 12, 'topic retrieval must return a bounded first page');
    assert.equal(firstTopicPage.hasMore, true, 'the first page must explicitly report unread notes');
    const secondTopicPage = await call('zhigui_get_topic_document', { topicId: pagingTopic.id, offset: firstTopicPage.nextOffset });
    assert.equal(secondTopicPage.notes.length, 1, 'the next offset must recover the final note');
    assert.equal(secondTopicPage.hasMore, false, 'the final page must report completion');

    const selectionRequired = await call('zhigui_auto_schedule', { startDate: today, days: 1 });
    assert.equal(selectionRequired.reason, 'focus_selection_required', 'the assistant must make an explicit focus choice when goals compete');
    const schedule = await call('zhigui_auto_schedule', {
      startDate: today, days: 1, focusGoalIds: ['g_due'], selectionReason: 'Deadline is tomorrow.',
    });
    assert.equal(schedule.secondBrain.valueSystem.applied, true, 'value weights must participate in scheduling');

    const briefingAwaitingAi = await call('zhigui_get_assistant_bootstrap');
    assert.equal(briefingAwaitingAi.morningBriefing.status, 'awaiting_ai',
      'raw scheduler input must not be represented as an AI-authored morning briefing');
    await call('zhigui_set_briefing', {
      date: today,
      recommended: 'Use the first focused block for the deadline-sensitive deliverable.',
      notRecommended: 'Do not add overlapping late-evening work.',
    });
    const briefingComposed = await call('zhigui_get_assistant_bootstrap');
    assert.equal(briefingComposed.morningBriefing.status, 'composed',
      'only zhigui_set_briefing may mark the dated morning briefing as composed');
    assert.ok(skillText.includes('AI-authored decision record'),
      'the Skill must prevent live task-state derivation of the morning briefing');

    console.log('PASS mechanism-audit');
  } finally {
    if (child) child.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
