'use strict';

const assert = require('assert');
const { createDashboardState } = require('../engine/dashboard-state');
const { todayStr } = require('../engine/date-utils');

const today = todayStr();
const source = {
  completedActions: [{
    id: 'completed_today', title: 'Completed sample', completedAt: `${today}T09:00:00+08:00`,
    pattern: 'one-time', category: 'misc', outcome: 'done',
  }],
  strategicGoals: [], currentGoals: [], constraints: [], notes: [{
    id: 'note_detail', title: 'Long note', content: 'This body must be loaded only after expansion.',
    topicId: 'topic_demo', createdAt: `${today}T08:00:00+08:00`,
  }], decisions: [], errands: [], followUps: [], reminders: [],
};
const projected = createDashboardState(source, [{ id: 'topic_demo', label: 'Demo topic' }]);

assert.deepEqual(projected.topicIndex, [{ id: 'topic_demo', label: 'Demo topic' }]);
assert.ok(projected.attentionSummary && projected.attentionSummary.byType,
  'both panels must receive the same attention summary projection');
assert.equal(projected.reflection?.date, today,
  'both panels must receive the same current-day reflection projection');
assert.equal(Object.hasOwn(projected.notes[0], 'content'), false,
  'the dashboard summary must not ship note bodies with every refresh');
assert.equal(Object.hasOwn(projected.notes[0], 'contentPreview'), false,
  'the dashboard index must not ship even truncated note text');
assert.equal(projected.notes[0].contentLength > 0, true,
  'the dashboard summary must still tell the renderer that a body exists');
assert.equal(source.notes[0].content, 'This body must be loaded only after expansion.',
  'creating a dashboard read model must not mutate its source state');

console.log('PASS dashboard-read-model');
