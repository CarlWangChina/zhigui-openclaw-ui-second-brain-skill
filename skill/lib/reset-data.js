'use strict';

const fs = require('fs');
const path = require('path');

const EMPTY_PROFILE = {
  personality: '', communicationStyle: '', preferredTools: [], workHabit: '', interests: [],
  tonePreference: '', responseDetail: '', languageStyle: '', notes: '', conversationCount: 0,
  valueSystem: { priorities: [], decisionStyle: 'balanced', learnedFrom: [] },
};

function writeJson(filePath, data) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
}

function clearFiles(root, relativeDir) {
  const target = path.resolve(root, relativeDir);
  if (path.dirname(target) !== path.resolve(root)) throw new Error(`Unsafe reset target: ${target}`);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isFile()) fs.unlinkSync(path.join(target, entry.name));
  }
}

function resetData(dataDir, { preserveUi = true } = {}) {
  const root = path.resolve(dataDir);
  fs.mkdirSync(root, { recursive: true });
  let ui = {};
  if (preserveUi) {
    try {
      const old = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      ui = { theme: old.meta?.theme, lang: old.meta?.lang, collapsed: old.meta?.collapsed };
    } catch {}
  }
  const now = new Date().toISOString();
  for (const dir of ['goals', 'notes', 'schedule', 'topics', 'decisions']) clearFiles(root, dir);
  const meta = { version: '4.0.0', lastUpdated: now };
  const docs = {
    'goals.json': { meta: { ...meta, documentType: 'goals' }, strategicGoals: [], currentGoals: [], constraints: [] },
    'schedule.json': { meta: { ...meta, documentType: 'schedule' }, schedule: { weekOf: '', days: {} }, morningBriefing: null, conflicts: [], briefings: {} },
    'errands.json': { meta: { ...meta, documentType: 'errands' }, errands: [] },
    'notes.json': { meta: { ...meta, documentType: 'notes' }, notes: [] },
    'decisions.json': { meta: { ...meta, documentType: 'decisions' }, decisions: [] },
    'activity.json': { meta: { ...meta, documentType: 'activity' }, events: [] },
    'reminders.json': { meta: { ...meta, documentType: 'reminders' }, reminders: [], followUps: [] },
    'userProfile.json': { meta: { ...meta, documentType: 'userProfile' }, userProfile: EMPTY_PROFILE },
    'history.json': { meta: { totalConversations: 0, lastConversation: null }, conversations: [] },
    'index.json': { version: '4.0.0', meta: { lastUpdated: now }, topics: {}, categories: {} },
    'library.json': { version: '4.0.0', meta: { lastUpdated: now }, categories: {}, topics: {} },
    'goals-index.json': { goals: [] }, 'notes-index.json': { notes: [] }, 'schedule-index.json': { days: {} },
  };
  for (const [name, value] of Object.entries(docs)) writeJson(path.join(root, name), value);
  const documentTypes = ['goals', 'schedule', 'errands', 'notes', 'decisions', 'activity', 'reminders', 'userProfile'];
  writeJson(path.join(root, 'documents.json'), {
    meta: { ...meta, description: 'ZhiGui Layer-0 document index' },
    documents: documentTypes.map(type => ({ type, lastUpdated: now, size: fs.statSync(path.join(root, `${type}.json`)).size })),
  });
  writeJson(path.join(root, 'state.json'), {
    meta: { ...meta, ...ui, stateVersion: 0 }, strategicGoals: [], currentGoals: [], constraints: [],
    schedule: { weekOf: '', days: {} }, morningBriefing: null, conflicts: [], briefings: {}, errands: [], notes: [], decisions: [], completedActions: [], reminders: [], followUps: [], userProfile: EMPTY_PROFILE, _hierarchyEnabled: true,
  });
  return { success: true, dataDir: root, preservedUi: preserveUi };
}

module.exports = { resetData, EMPTY_PROFILE };
