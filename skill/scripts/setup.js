#!/usr/bin/env node
/**
 * ZhiGui - Self-contained deployment script (called by start.bat / start.sh)
 *
 * Responsibilities:
 *   1. Install the skill engine (engine/), scripts (scripts/), docs (SKILL.md) into
 *      the target skill directory — the skill package "brings its own engine", import-and-go.
 *   2. Write config.json:
 *        - Dev mode (deploy from project, APP_DIR ≠ SKILL_DIR): dataDir points to
 *          <APP_DIR>/skill/.zhigui (shared with the Electron dashboard and development MCP).
 *        - Standalone mode (run directly against the skill directory): dataDir uses relative path ".zhigui",
 *          data lives inside the skill folder, fully self-contained and portable across machines.
 *   3. Initialize the data directory (activity.json / split documents / state.json / documents.json / history.json).
 *   4. Call register-mcp to print MCP setup guidance for connecting zhigui to AI tools.
 *
 * Args:
 *   argv[2] = APP_DIR   (project root dir, can equal SKILL_DIR for standalone mode)
 *   argv[3] = SKILL_DIR (target skill directory)
 *   argv[4] = NODE_EXE  (optional, absolute path to node executable; defaults to process.execPath)
 */

const fs = require('fs');
const path = require('path');
const { register: registerMcp } = require('./register-mcp');
const { ensureDataInitialized } = require('../lib/init-data');

const APP_DIR = process.argv[2];
const SKILL_DIR = process.argv[3];
const NODE_EXE = process.argv[4] || process.execPath;

if (!SKILL_DIR) {
  console.error('[ZhiGui] Missing SKILL_DIR argument');
  process.exit(1);
}

// Standalone mode: APP_DIR not provided or equals SKILL_DIR -> data is self-contained inside the skill
const standalone = !APP_DIR || APP_DIR === SKILL_DIR;
const DATA_DIR = standalone
  ? path.join(SKILL_DIR, '.zhigui')
  : path.join(APP_DIR, 'skill', '.zhigui');

console.log('[ZhiGui] Setup starting...');
console.log('  mode    : ' + (standalone ? 'standalone (self-contained)' : 'dev (project)'));
console.log('  SKILL_DIR: ' + SKILL_DIR);
console.log('  DATA_DIR : ' + DATA_DIR);

// ===== 1. Install engine / scripts / docs into the skill directory =====
console.log('\n[ZhiGui] Installing engine + scripts into skill dir...');
try {
  if (!fs.existsSync(SKILL_DIR)) fs.mkdirSync(SKILL_DIR, { recursive: true });

  // Sync a source tree into a destination tree: copy source -> dest, then
  // prune dest files/dirs that no longer exist in source. This keeps the
  // deployed skill copy == source of truth and prevents stale legacy modules
  // (e.g. retired files the source tree has since deleted) from lingering.
  // Only the synced subdirs (engine/dashboard/electron/lib/scripts) are pruned;
  // top-level files like config.json / SKILL.md / package.json are copied
  // individually below and never pruned.
  function syncDir(src, dst) {
    // 1. collect source file/dir relative paths (separator-normalized)
    const srcPaths = new Set();
    (function collect(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          srcPaths.add(childRel);
          collect(path.join(dir, e.name), childRel);
        } else {
          srcPaths.add(childRel);
        }
      }
    })(src, '');

    // 2. copy source -> dest
    (function copy(rel) {
      const d = path.join(dst, rel);
      fs.mkdirSync(d, { recursive: true });
      const sdir = path.join(src, rel);
      for (const e of fs.readdirSync(sdir, { withFileTypes: true })) {
        const s = path.join(sdir, e.name);
        const d2 = path.join(d, e.name);
        const childRel = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) copy(childRel);
        else fs.copyFileSync(s, d2);
      }
    })('');

    // 3. prune dest entries not present in source
    (function prune(rel) {
      const d = path.join(dst, rel);
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const d2 = path.join(d, e.name);
        const childRel = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          prune(childRel);
          if (!srcPaths.has(childRel)) {
            const remaining = fs.readdirSync(d2);
            if (remaining.length === 0) fs.rmdirSync(d2);
          }
        } else {
          if (!srcPaths.has(childRel)) {
            fs.unlinkSync(d2);
            console.log('  pruned orphan: ' + childRel);
          }
        }
      }
    })('');
  }

  syncDir(path.join(__dirname, '..', 'engine'), path.join(SKILL_DIR, 'engine'));
  syncDir(path.join(__dirname, '..', 'dashboard'), path.join(SKILL_DIR, 'dashboard'));
  syncDir(path.join(__dirname, '..', 'electron'), path.join(SKILL_DIR, 'electron'));
  syncDir(path.join(__dirname, '..', 'lib'), path.join(SKILL_DIR, 'lib'));
  syncDir(path.join(__dirname, '..', 'scripts'), path.join(SKILL_DIR, 'scripts'));
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
console.log('\n[ZhiGui] Writing config.json...');
try {
  const config = standalone
    ? { dataDir: '.zhigui', appDir: '.', installedAt: new Date().toISOString() }
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
console.log('\n[ZhiGui] Checking data files...');
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('  Created data directory: ' + DATA_DIR);
  }
  const created = ensureDataInitialized(DATA_DIR);
  if (created > 0) {
    console.log(`  Initialized ${created} data file(s).`);
  } else {
    console.log('  All data files already exist.');
  }
} catch (err) {
  console.error('  [ERROR] Data init failed: ' + err.message);
  process.exit(1);
}

// ===== 4. Register the global MCP (agent can call it after wiring) =====
console.log('\n[ZhiGui] Registering global MCP server...');
try {
  registerMcp(SKILL_DIR, NODE_EXE);
} catch (err) {
  console.error('  [WARN] MCP registration failed: ' + err.message);
}

// ===== 5. Dev mode: point the project-level .mcp.json to the new engine location as well =====
if (!standalone && APP_DIR) {
  console.log('\n[ZhiGui] Patching project MCP configs...');
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
      const srv = cfg.mcpServers && cfg.mcpServers.zhigui;
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

console.log('\n[ZhiGui] Setup complete!');
console.log('  - Skill engine installed at: ' + SKILL_DIR);
console.log('  - Data at: ' + DATA_DIR);
console.log('  - Next: register the zhigui MCP server in your AI tool (see mcp-config-template.json).');
