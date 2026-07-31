const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'public', 'dashboard.js'),
  'utf8',
);
const dashboardServer = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'server.js'), 'utf8');
const electronMain = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

assert.ok(dashboard.includes('let selectedDate = null'),
  'the dashboard must retain an absolute viewed date instead of a drifting relative offset');
assert.equal(dashboard.includes('currentDayOffset'), false,
  'all render paths must use the shared absolute viewed date');
assert.ok(dashboard.includes('function parseLocalDate(dateStr)'),
  'date-only values must be parsed as local calendar dates');
assert.ok(dashboard.includes('function renderViewedDate()'),
  'date navigation must use one complete render path');
const viewedRender = dashboard.match(/function renderViewedDate\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
for (const renderer of ['renderFocusHero()', 'renderBriefing()', 'renderSchedule()', 'renderCompletedActions()', 'renderReflection()']) {
  assert.ok(viewedRender.includes(renderer),
    `viewed-date render path must include ${renderer}`);
}
assert.ok(dashboard.includes("schedule: ['renderCollapsed', 'renderFocusHero', 'renderSchedule', 'renderCompletedActions']"),
  'a schedule-only external update must also refresh completed actions');
assert.ok(dashboard.includes('setInterval(() => scheduleExternalStateRender(), 30000)'),
  'the browser polling fallback must render, not only fetch fresh state');
assert.ok(dashboard.includes('state.lastReflection?.date === displayDate ? state.lastReflection : null'),
  'daily reflection must read the persisted record only for its own date');
assert.ok(dashboardServer.includes("require('../engine/dashboard-state')") && electronMain.includes("require('../engine/dashboard-state')"),
  'browser and Electron state reads must share the same dashboard projection');

console.log('PASS dashboard-date-contract');
