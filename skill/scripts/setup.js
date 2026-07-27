#!/usr/bin/env node
/**
 * Lingxi - Self-contained deployment script (called by start.bat / start.sh)
 *
 * Responsibilities:
 *   1. Install the skill engine (engine/), scripts (scripts/), docs (SKILL.md) into
 *      the target skill directory — the skill package "brings its own engine", import-and-go.
 *   2. Write config.json:
 *        - Dev mode (deploy from project, APP_DIR ≠ SKILL_DIR): dataDir points to
 *          <APP_DIR>/.lingxi (shared with the Electron dashboard, single source of truth).
 *        - Standalone mode (run directly against the skill directory): dataDir uses relative path ".lingxi",
 *          data lives inside the skill folder, fully self-contained and portable across machines.
 *   3. Initialize the data directory (events.json / split documents / state.json / documents.json / history.json).
 *   4. Call register-mcp to register lingxi into the global MCP config, so the agent can call it after wiring.
 *
 * Args:
 *   argv[2] = APP_DIR   (project root dir, can equal SKILL_DIR for standalone mode)
 *   argv[3] = SKILL_DIR (target skill directory)
 *   argv[4] = NODE_EXE  (optional, absolute path to node executable; defaults to process.execPath)
 */

const fs = require('fs');
const path = require('path');
const { register: registerMcp } = require('./register-mcp');

const APP_DIR = process.argv[2];
const SKILL_DIR = process.argv[3];
const NODE_EXE = process.argv[4] || process.execPath;

if (!SKILL_DIR) {
  console.error('[Lingxi] Missing SKILL_DIR argument');
  process.exit(1);
}

// Standalone mode: APP_DIR not provided or equals SKILL_DIR -> data is self-contained inside the skill
const standalone = !APP_DIR || APP_DIR === SKILL_DIR;
const DATA_DIR = standalone
  ? path.join(SKILL_DIR, '.lingxi')
  : path.join(APP_DIR, '.lingxi');

console.log('[Lingxi] Setup starting...');
console.log('  mode    : ' + (standalone ? 'standalone (self-contained)' : 'dev (project)'));
console.log('  SKILL_DIR: ' + SKILL_DIR);
console.log('  DATA_DIR : ' + DATA_DIR);

// ===== 1. Install engine / scripts / docs into the skill directory =====
console.log('\n[Lingxi] Installing engine + scripts into skill dir...');
try {
  if (!fs.existsSync(SKILL_DIR)) fs.mkdirSync(SKILL_DIR, { recursive: true });

  function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  }

  copyDir(path.join(__dirname, '..', 'engine'), path.join(SKILL_DIR, 'engine'));
  copyDir(path.join(__dirname, '..', 'dashboard'), path.join(SKILL_DIR, 'dashboard'));
  copyDir(path.join(__dirname, '..', 'electron'), path.join(SKILL_DIR, 'electron'));
  copyDir(path.join(__dirname, '..', 'lib'), path.join(SKILL_DIR, 'lib'));
  copyDir(path.join(__dirname, '..', 'scripts'), path.join(SKILL_DIR, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '..', 'SKILL.md'), path.join(SKILL_DIR, 'SKILL.md'));
  const tpl = path.join(__dirname, '..', 'mcp-config-template.json');
  if (fs.existsSync(tpl)) fs.copyFileSync(tpl, path.join(SKILL_DIR, 'mcp-config-template.json'));
  // The skill brings its own package.json (with electron dependency) for npm install to
  // install Electron in standalone mode
  const pkg = path.join(__dirname, '..', 'package.json');
  if (fs.existsSync(pkg)) fs.copyFileSync(pkg, path.join(SKILL_DIR, 'package.json'));
  console.log('  engine/ + dashboard/ + electron/ + lib/ + scripts/ + SKILL.md installed.');
} catch (err) {
  console.error('  [ERROR] install failed: ' + err.message);
  process.exit(1);
}

// ===== 2. Write config.json =====
console.log('\n[Lingxi] Writing config.json...');
try {
  const config = standalone
    ? { dataDir: '.lingxi', appDir: '.', installedAt: new Date().toISOString() }
    : {
        dataDir: DATA_DIR.replace(/\\/g, '/'),
        appDir: APP_DIR.replace(/\\/g, '/'),
        installedAt: new Date().toISOString(),
      };
  fs.writeFileSync(path.join(SKILL_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  console.log('  config.json written (' + (standalone ? 'relative/self-contained' : 'project data dir') + ').');
} catch (err) {
  console.error('  [ERROR] config write failed: ' + err.message);
}

// ===== 3. Initialize the data directory =====
console.log('\n[Lingxi] Checking data files...');
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('  Created data directory: ' + DATA_DIR);
  }

  const DOC_FILES = {
    goals: { keys: ['strategicGoals', 'currentGoals', 'constraints'], title: 'Goals & Constraints', desc: 'Strategic goals, current goals, constraint principles' },
    schedule: { keys: ['schedule', 'morningBriefing', 'conflicts'], title: 'Schedule & Morning Briefing', desc: 'Schedule, daily morning briefing, conflict detection' },
    errands: { keys: ['errands'], title: 'Errands', desc: 'must/should/nice three-tier errands' },
    notes: { keys: ['notes'], title: 'Life Notes', desc: 'AI-titled notes with layered on-demand detail' },
    userProfile: { keys: ['userProfile'], title: 'User Profile', desc: 'User profile, value system, communication preferences' },
  };

  const stateFile = path.join(DATA_DIR, 'state.json');
  let existingState = null;
  if (!fs.existsSync(stateFile)) {
    console.log('  Initializing state.json (first run)...');
    const initialState = {
      meta: { version: '2.1.0', lastUpdated: new Date().toISOString(), theme: 'dark', collapsed: true },
      strategicGoals: [], constraints: [], currentGoals: [],
      schedule: { weekOf: '', days: {} },
      morningBriefing: {}, conflicts: [],
      errands: [],
      notes: [],
      userProfile: {
        personality: '', communicationStyle: '', preferredTools: [], workHabit: '',
        interests: [], tonePreference: '', responseDetail: '', languageStyle: '',
        notes: '', conversationCount: 0,
        valueSystem: { priorities: [], decisionStyle: 'balanced', learnedFrom: [] },
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2), 'utf8');
    existingState = initialState;
    console.log('  state.json created.');
  } else {
    console.log('  state.json exists.');
    existingState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }

  for (const [docType, info] of Object.entries(DOC_FILES)) {
    const docPath = path.join(DATA_DIR, `${docType}.json`);
    if (!fs.existsSync(docPath)) {
      console.log(`  Initializing ${docType}.json...`);
      const docData = { meta: { version: '2.1.0', lastUpdated: new Date().toISOString(), documentType: docType } };
      for (const key of info.keys) {
        docData[key] = existingState[key] !== undefined ? existingState[key]
          : [];
      }
      fs.writeFileSync(docPath, JSON.stringify(docData, null, 2), 'utf8');
    } else console.log(`  ${docType}.json exists.`);
  }

  const indexFile = path.join(DATA_DIR, 'documents.json');
  if (!fs.existsSync(indexFile)) {
    console.log('  Initializing documents.json index...');
    const docs = Object.entries(DOC_FILES).map(([type, info]) => ({
      type, title: info.title, description: info.desc,
      lastUpdated: new Date().toISOString(),
      size: fs.statSync(path.join(DATA_DIR, `${type}.json`)).size,
    }));
    fs.writeFileSync(indexFile, JSON.stringify({
      meta: { version: '2.1.0', lastUpdated: new Date().toISOString(), description: 'Lingxi document index - first-layer retrieval' },
      documents: docs,
    }, null, 2), 'utf8');
  } else console.log('  documents.json index exists.');

  const historyFile = path.join(DATA_DIR, 'history.json');
  if (!fs.existsSync(historyFile)) {
    console.log('  Initializing history.json...');
    fs.writeFileSync(historyFile, JSON.stringify({
      meta: { totalConversations: 0, lastConversation: null }, conversations: [],
    }, null, 2), 'utf8');
  } else console.log('  history.json exists.');
} catch (err) {
  console.error('  [ERROR] Data init failed: ' + err.message);
  process.exit(1);
}

// ===== 4. Register the global MCP (agent can call it after wiring) =====
console.log('\n[Lingxi] Registering global MCP server...');
try {
  registerMcp(SKILL_DIR, NODE_EXE);
} catch (err) {
  console.error('  [WARN] MCP registration failed: ' + err.message);
}

// ===== 5. Dev mode: point the project-level .mcp.json to the new engine location as well =====
if (!standalone && APP_DIR) {
  console.log('\n[Lingxi] Patching project MCP configs...');
  const MCP_SERVER = path.join(APP_DIR, 'skill', 'engine', 'server.js').replace(/\\/g, '/');
  const PROJECT_CONFIGS = [
    path.join(APP_DIR, '.mcp.json'),
    path.join(APP_DIR, '.trae', 'mcp.json'),
    path.join(APP_DIR, '.cursor', 'mcp.json'),
  ];
  for (const cfgPath of PROJECT_CONFIGS) {
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const srv = cfg.mcpServers && cfg.mcpServers.lingxi;
      if (!srv) continue;
      if (!Array.isArray(srv.args)) srv.args = [];
      srv.args[0] = MCP_SERVER;
      if (NODE_EXE) srv.command = NODE_EXE;
      else if (typeof srv.command === 'string' && srv.command !== 'node' && /[\\/]/.test(srv.command)) srv.command = 'node';
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      console.log('  patched: ' + cfgPath);
    } catch (err) {
      console.error('  [WARN] failed to patch ' + cfgPath + ': ' + err.message);
    }
  }
}

console.log('\n[Lingxi] Setup complete!');
console.log('  - Skill engine installed at: ' + SKILL_DIR);
console.log('  - Data at: ' + DATA_DIR);
console.log('  - Next: register the lingxi MCP server in your AI tool (see SKILL.md "Installation & Setup").');
