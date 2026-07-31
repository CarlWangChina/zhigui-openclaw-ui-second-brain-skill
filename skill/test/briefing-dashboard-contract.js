const assert = require('assert');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'dashboard', 'public');
const dashboard = fs.readFileSync(path.join(publicDir, 'dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

assert.equal(dashboard.includes('function _extractLocalContent'), false,
  'the dashboard must not derive a morning briefing from live tasks/goals');
assert.equal(dashboard.includes('invalidateTodayBriefing'), false,
  'task/goal mutation must not clear the dated morning briefing in the UI');
assert.ok(dashboard.includes('.filter(task => task.time && !task.completed)'),
  'completed timed tasks must be excluded from Today\'s Actions');
assert.ok(dashboard.includes('.filter(action => action.date === displayDate && action.time && !action.completed)'),
  'completed timed errands must be excluded from Today\'s Actions');
assert.ok(html.includes('id="briefing-empty-state"'),
  'a missing AI briefing must render an explicit empty state instead of a task-derived recommendation');
assert.ok(dashboard.includes('const PAGE_SIZE = { goals: 12, decisions: 10, errands: 12, notes: 12, topics: 12 }'),
  'the main panel and topic library must cap long entity lists instead of rendering an unbounded page');
assert.ok(dashboard.includes('topics: PAGE_SIZE.topics'),
  'topic paging must have an initialized visible count so every category can render its cards');
assert.ok(dashboard.includes('if (!visibleTopics.length) continue;'),
  'deferred topic cards must not leave an empty category header that users cannot open');
assert.ok(dashboard.includes('ensureNoteDetail'),
  'the main panel must load a note body only after its card is opened');
assert.equal(dashboard.includes('tree-note-full'), false,
  'a topic relation must show a note title and deliberate open action, not its body inline');

console.log('PASS briefing-dashboard-contract');
