/**
 * ZhiGui - Data auto-initialization
 *
 * Shared by engine/server.js, dashboard/server.js, and electron/main.js, ensuring
 * "import-and-go" - whichever end starts first automatically creates the data directory
 * and empty data files.
 *
 * Only creates files when they do not exist; does not overwrite existing data.
 */

const fs = require('fs');
const path = require('path');

function ensureDataInitialized(dataDir) {
  if (!dataDir) return 0;

  // Create data directory
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Core data files and their default structures
  const INIT_FILES = {
    'goals.json': { meta: { version: '3.1.0', lastUpdated: new Date().toISOString() }, strategicGoals: [], currentGoals: [], constraints: [] },
    'schedule.json': { meta: { version: '3.2.0', lastUpdated: new Date().toISOString() }, schedule: { weekOf: '', days: {} }, morningBriefing: null, conflicts: [], briefings: {} },
    'errands.json': { meta: { version: '3.1.0', lastUpdated: new Date().toISOString() }, errands: [] },
    'notes.json': { meta: { version: '3.2.0', lastUpdated: new Date().toISOString() }, notes: [] },
    'settings-conflicts.json': { meta: { version: '1.0.0', lastUpdated: new Date().toISOString() }, pendingReviews: [], importBatches: [] },
    'reminders.json': { meta: { version: '3.2.0', lastUpdated: new Date().toISOString() }, reminders: [] },
    'userProfile.json': { meta: { version: '3.1.0', lastUpdated: new Date().toISOString() }, userProfile: { personality: '', communicationStyle: '', preferredTools: [], workHabit: '', interests: [], tonePreference: '', responseDetail: '', languageStyle: '', notes: '', conversationCount: 0, valueSystem: { priorities: [], decisionStyle: 'balanced', learnedFrom: [] } } },
    'history.json': { meta: { totalConversations: 0, lastConversation: null }, conversations: [] },
    'index.json': { meta: { version: '3.1.0', lastUpdated: new Date().toISOString() }, topics: {} },
  };

  let created = 0;
  for (const [file, defaultData] of Object.entries(INIT_FILES)) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), 'utf8');
      created++;
    }
  }

  // documents.json index
  const docIndexPath = path.join(dataDir, 'documents.json');
  if (!fs.existsSync(docIndexPath)) {
    const DOC_META = {
      goals: { title: 'Goals & Constraints', desc: 'Strategic goals, current goals, constraint principles' },
      schedule: { title: 'Schedule & Morning Briefing', desc: 'Schedule, daily morning briefing, conflict detection' },
      errands: { title: 'Errands', desc: 'must/should/nice three-tier errands' },
      notes: { title: 'Life Notes', desc: 'AI-authored title index with on-demand note details' },
      userProfile: { title: 'User Profile', desc: 'User profile, value system, communication preferences' },
    };
    const docs = Object.entries(DOC_META).map(([type, info]) => ({
      type, title: info.title, description: info.desc,
      lastUpdated: new Date().toISOString(),
      size: fs.statSync(path.join(dataDir, `${type}.json`)).size,
    }));
    fs.writeFileSync(docIndexPath, JSON.stringify({
      meta: { version: '3.1.0', lastUpdated: new Date().toISOString(), description: 'ZhiGui document index - first-layer retrieval' },
      documents: docs,
    }, null, 2), 'utf8');
    created++;
  }

  // state.json fallback copy
  const statePath = path.join(dataDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    const initialState = {
      meta: { version: '3.1.0', lastUpdated: new Date().toISOString(), theme: 'dark', collapsed: true },
      strategicGoals: [], constraints: [], currentGoals: [],
      schedule: { weekOf: '', days: {} },
      morningBriefing: null, conflicts: [], briefings: {},
      errands: [],
      notes: [],
      pendingReviews: [],
      importBatches: [],
      userProfile: { personality: '', communicationStyle: '', preferredTools: [], workHabit: '', interests: [], tonePreference: '', responseDetail: '', languageStyle: '', notes: '', conversationCount: 0, valueSystem: { priorities: [], decisionStyle: 'balanced', learnedFrom: [] } },
    };
    fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2), 'utf8');
    created++;
  }

  return created;
}

module.exports = { ensureDataInitialized };
