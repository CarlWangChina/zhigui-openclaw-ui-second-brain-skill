/**
 * ZhiGui - Data auto-initialization
 *
 * Shared by engine/server.js, dashboard/server.js, and electron/main.js, ensuring
 * "import-and-go" - whichever end starts first automatically creates the data directory
 * and empty data files.
 *
 * Only creates files when they do not exist; does not overwrite existing data.
 *
 * Version numbers and file structures are kept in sync with lib/reset-data.js.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '4.0.0';

function ensureDataInitialized(dataDir) {
  if (!dataDir) return 0;

  // Create data directory
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const now = new Date().toISOString();
  const meta = { version: SCHEMA_VERSION, lastUpdated: now };

  // Core data files and their default structures (kept in sync with reset-data.js)
  const INIT_FILES = {
    'goals.json': { meta: { ...meta, documentType: 'goals' }, strategicGoals: [], currentGoals: [], constraints: [] },
    'schedule.json': { meta: { ...meta, documentType: 'schedule' }, schedule: { weekOf: '', days: {} }, morningBriefing: null, conflicts: [], briefings: {} },
    'errands.json': { meta: { ...meta, documentType: 'errands' }, errands: [] },
    'notes.json': { meta: { ...meta, documentType: 'notes' }, notes: [] },
    'decisions.json': { meta: { ...meta, documentType: 'decisions' }, decisions: [] },
    'activity.json': { meta: { ...meta, documentType: 'activity' }, events: [] },
    'reminders.json': { meta: { ...meta, documentType: 'reminders' }, reminders: [], followUps: [] },
    'userProfile.json': { meta: { ...meta, documentType: 'userProfile' }, userProfile: { personality: '', communicationStyle: '', preferredTools: [], workHabit: '', interests: [], tonePreference: '', responseDetail: '', languageStyle: '', notes: '', conversationCount: 0, valueSystem: { priorities: [], decisionStyle: 'balanced', learnedFrom: [] } } },
    'history.json': { meta: { totalConversations: 0, lastConversation: null }, conversations: [] },
    'index.json': { version: SCHEMA_VERSION, meta: { lastUpdated: now }, topics: {}, categories: {} },
    'library.json': { version: SCHEMA_VERSION, meta: { lastUpdated: now }, categories: {}, topics: {} },
    'goals-index.json': { goals: [] },
    'notes-index.json': { notes: [] },
    'schedule-index.json': { days: {} },
  };

  let created = 0;
  for (const [file, defaultData] of Object.entries(INIT_FILES)) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), 'utf8');
      created++;
    }
  }

  // documents.json index — must include all 8 document types (synced with reset-data.js)
  const docIndexPath = path.join(dataDir, 'documents.json');
  if (!fs.existsSync(docIndexPath)) {
    const DOC_META = {
      goals: { title: 'Goals & Constraints', desc: 'Strategic goals, current goals, constraint principles' },
      schedule: { title: 'Schedule & Morning Briefing', desc: 'Schedule, daily morning briefing, conflict detection' },
      errands: { title: 'Errands', desc: 'must/should/nice three-tier errands' },
      notes: { title: 'Notes', desc: 'AI-authored title index with on-demand note details' },
      decisions: { title: 'Decisions', desc: 'Structured decisions and outcomes' },
      activity: { title: 'Activity', desc: 'Compact cross-conversation change journal' },
      reminders: { title: 'Reminders & Follow-ups', desc: 'Conversation-triggered clock reminders and explicit follow-ups' },
      userProfile: { title: 'User Profile', desc: 'User profile, value system, communication preferences' },
    };
    const docs = Object.entries(DOC_META).map(([type, info]) => ({
      type, title: info.title, description: info.desc,
      lastUpdated: now,
      size: fs.statSync(path.join(dataDir, `${type}.json`)).size,
    }));
    fs.writeFileSync(docIndexPath, JSON.stringify({
      meta: { ...meta, description: 'ZhiGui Layer-0 document index' },
      documents: docs,
    }, null, 2), 'utf8');
    created++;
  }

  // state.json fallback copy (kept in sync with reset-data.js structure)
  const statePath = path.join(dataDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    const initialState = {
      meta: { ...meta, theme: 'dark', collapsed: true, stateVersion: 0 },
      strategicGoals: [], constraints: [], currentGoals: [],
      schedule: { weekOf: '', days: {} },
      morningBriefing: null, conflicts: [], briefings: {},
      errands: [],
      notes: [],
      decisions: [], completedActions: [],
      reminders: [], followUps: [],
      userProfile: { personality: '', communicationStyle: '', preferredTools: [], workHabit: '', interests: [], tonePreference: '', responseDetail: '', languageStyle: '', notes: '', conversationCount: 0, valueSystem: { priorities: [], decisionStyle: 'balanced', learnedFrom: [] } },
      _hierarchyEnabled: true,
    };
    fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2), 'utf8');
    created++;
  }

  return created;
}

module.exports = { ensureDataInitialized, SCHEMA_VERSION };
