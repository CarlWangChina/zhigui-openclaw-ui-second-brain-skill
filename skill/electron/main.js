/**
 * ZhiGui - AI schedule assistant - Electron main process
 *
 * Features:
 * - Frameless window, permanently stationed on the right side of the desktop
 * - Collapsible (70px) / expandable (420px+)
 * - IPC handlers replace the HTTP API
 * - fs.watch file watching + IPC push (replaces SSE)
 * - Always-on-top (toggle via right-click)
 */

const { app, BrowserWindow, ipcMain, screen, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { BrainIndex } = require('../engine/brain-index');
// Shared persistence layer: same read/write logic as the AI/MCP process, eliminating dual-storage divergence
const Storage = require('../engine/storage');
// Shared config loader: data directory shared with MCP engine / HTTP dashboard, keeping all three ends consistent
const { loadConfig } = require('../lib/config');
const CONFIG = loadConfig();
const { ensureDataInitialized } = require('../lib/init-data');

// ===== Path constants =====
const ZHIGUI_DIR = CONFIG.dataDir;
ensureDataInitialized(ZHIGUI_DIR);
// Must be called after ZHIGUI_DIR is declared, to avoid the const temporal dead zone (TDZ) error
Storage.setDataDir(ZHIGUI_DIR);
const Actions = require('../engine/actions');
Actions.configure(ZHIGUI_DIR);
const STATE_FILE = path.join(ZHIGUI_DIR, 'state.json');
const HISTORY_FILE = path.join(ZHIGUI_DIR, 'history.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

// ===== Window size =====
const COLLAPSED_W = 56;   // Collapsed-state mini window width
const COLLAPSED_H = 56;   // Collapsed-state mini window height
let mainWindow = null;
let expandedWidth = 420;    // Module-level variable, set when createWindow runs

// ===== Utility functions =====
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

// Second Brain association index (for topic reindex)
let brainIndex = null;
function getBrainIndex() {
  if (!brainIndex) brainIndex = new BrainIndex(ZHIGUI_DIR);
  return brainIndex;
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Save the current window position
function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  saveBoundsExplicit(b.x, b.y, b.width, b.height);
}

// Explicitly save window position
function saveBoundsExplicit(x, y, w, h) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const st = readJson(STATE_FILE) || {};
  st.meta = st.meta || {};
  st.meta.windowBounds = {
    x: Math.round(x), y: Math.round(y),
    width: Math.round(w), height: Math.round(h)
  };
  writeJson(STATE_FILE, st);
}

// ===== Ensure data files exist =====
function ensureDataFiles() {
  if (!fs.existsSync(ZHIGUI_DIR)) {
    fs.mkdirSync(ZHIGUI_DIR, { recursive: true });
  }
  if (!fs.existsSync(STATE_FILE)) {
    writeJson(STATE_FILE, {
      meta: { theme: 'dark', lastUpdated: new Date().toISOString() },
      strategicGoals: [],
      constraints: [],
      currentGoals: [],
      schedule: { days: {} },
      conflicts: [],
      morningBriefing: null
    });
  }
  if (!fs.existsSync(HISTORY_FILE)) {
    writeJson(HISTORY_FILE, { conversations: [], meta: {} });
  }
}

// ===== Compute expanded width based on screen size =====
function getExpandedWidth(workArea) {
  const width = workArea.width;
  if (width >= 1920) return 460;
  if (width >= 1200) return 420;
  if (width >= 769) return 380;
  return Math.min(width - 20, 360); // Leave some margin on small screens
}

// ===== Create window =====
function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  expandedWidth = getExpandedWidth(workArea);

  // Always start expanded: full dashboard panel at right edge
  const initW = expandedWidth;
  const initH = workArea.height;
  const initX = Math.round(workArea.x + workArea.width - expandedWidth);
  const initY = workArea.y;

  mainWindow = new BrowserWindow({
    width: Math.round(initW),
    height: Math.round(initH),
    x: Math.round(initX),
    y: Math.round(initY),
    frame: false,           // Frameless
    resizable: false,       // Disable manual resizing
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,     // Not on top by default (user can toggle)
    skipTaskbar: false,     // Show in taskbar
    transparent: true,      // Transparent background (needed for the mini icon rounded corners)
    title: '知归 - ZhiGui',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Security: explicitly enable web security (default true, but make it explicit)
      webSecurity: true,
      // Security: prevent loading remote content in this window
      allowRunningInsecureContent: false,
    }
  });

  // Load the dashboard page
  mainWindow.loadFile(path.join(PUBLIC_DIR, 'index.html'));

  // Always-on-top state: restore from state.json, default not on top
  const savedState = readJson(STATE_FILE) || {};
  const savedPin = savedState.meta?.alwaysOnTop === true;
  mainWindow.setAlwaysOnTop(savedPin, 'floating', 1);

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click menu: toggle always-on-top, close
  mainWindow.webContents.on('context-menu', () => {
    const isOnTop = mainWindow.isAlwaysOnTop();
    const menu = Menu.buildFromTemplate([
      {
        label: 'Always on Top',
        type: 'checkbox',
        checked: isOnTop,
        click: (item) => mainWindow.setAlwaysOnTop(item.checked, 'floating', 1)
      },
      { type: 'separator' },
      {
        label: 'Close ZhiGui',
        click: () => mainWindow.close()
      }
    ]);
    menu.popup();
  });

  mainWindow.on('closed', () => {
    try { saveBounds(); } catch (e) {}
    mainWindow = null;
  });
}

// ===== IPC handlers (replacing the HTTP API) =====

// Toggle always-on-top (persisted to state.json)
ipcMain.handle('toggle-pin', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { error: 'No window' };
  const isOnTop = mainWindow.isAlwaysOnTop();
  const newTop = !isOnTop;
  mainWindow.setAlwaysOnTop(newTop, 'floating', 1);
  // Persist
  try {
    const st = readJson(STATE_FILE) || {};
    st.meta = st.meta || {};
    st.meta.alwaysOnTop = newTop;
    writeJson(STATE_FILE, st);
  } catch (e) { /* ignore */ }
  return { alwaysOnTop: newTop };
});

// Close window (quit the app)
ipcMain.handle('close-app', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.close();
});

// Read state — unified read path via Storage.readFullState()
// This reads from hierarchy (primary) and reconstructs the full state,
// ensuring the Electron panel sees the same data as the AI and Dashboard.
ipcMain.handle('get-state', () => {
  const state = Storage.readFullState();
  let topicIndex = [];
  try {
    topicIndex = getBrainIndex().getTopics().map(topic => ({ id: topic.id, label: topic.label }));
  } catch {}
  return { ...state, topicIndex };
});

// Read history
ipcMain.handle('get-history', () => {
  return readJson(HISTORY_FILE) || { conversations: [] };
});

// Toggle task completion
ipcMain.handle('toggle-task', (event, { date, taskId }) => {
  return Actions.execute('task.toggle', { date, taskId });
  const state = Storage.readFullState();
  const day = state.schedule?.days?.[date];
  if (!day) return { error: 'Date not found' };

  const task = day.tasks.find(t => t.id === taskId);
  if (!task) return { error: 'Task not found' };

  task.completed = !task.completed;
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  Storage.writeState(state);

  return { success: true, completed: task.completed };
});

// Update task time/duration (manual lock)
ipcMain.handle('update-task', (event, { date, taskId, time, duration }) => {
  return Actions.execute('task.update', { date, taskId, time, duration });
  const state = Storage.readFullState();
  const day = state.schedule?.days?.[date];
  if (!day) return { error: 'Date not found' };
  const task = day.tasks.find(t => t.id === taskId);
  if (!task) return { error: 'Task not found' };
  if (time !== undefined) task.time = time;
  if (duration !== undefined) task.duration = duration;
  task.manualLocked = true;
  task.manualLockedAt = new Date().toISOString();
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  Storage.writeState(state);
  return { success: true, task };
});

// Delete one scheduled task without affecting the rest of that day.
ipcMain.handle('delete-task', (event, payload) => {
  return Actions.execute('task.delete', payload);
});

// Unlock task (remove manual lock)
ipcMain.handle('unlock-task', (event, { date, taskId }) => {
  return Actions.execute('task.unlock', { date, taskId });
  const state = Storage.readFullState();
  const day = state.schedule?.days?.[date];
  if (!day) return { error: 'Date not found' };
  const task = day.tasks.find(t => t.id === taskId);
  if (!task) return { error: 'Task not found' };
  task.manualLocked = false;
  delete task.manualLockedAt;
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  Storage.writeState(state);
  return { success: true, task };
});

// Update priority (and lock it)
ipcMain.handle('update-priority', (event, { type, id, priority }) => {
  return Actions.execute('priority.update', { type, id, priority });
  const state = Storage.readFullState();
  let target = null;
  let list = null;

  if (type === 'strategicGoal') list = state.strategicGoals;
  else if (type === 'constraint') list = state.constraints;
  else if (type === 'currentGoal') list = state.currentGoals;
  else if (type === 'task') {
    const days = state.schedule?.days || {};
    for (const d of Object.values(days)) {
      const t = d.tasks?.find(t => t.id === id);
      if (t) { target = t; break; }
    }
  }

  if (!target && list) {
    target = list.find(item => item.id === id);
  }

  if (!target) return { error: 'Target not found' };

  target.priority = Math.max(0, Math.min(100, parseInt(priority)));
  target.locked = true;
  target.updatedAt = new Date().toISOString();

  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  // Go through the shared persistence layer: synchronously write back to split documents + state.json
  // so the AI can see the panel edits
  Storage.writeState(state);

  return { success: true, priority: target.priority, locked: true };
});

// Unlock priority
ipcMain.handle('unlock-priority', (event, { type, id }) => {
  return Actions.execute('priority.unlock', { type, id });
  const state = Storage.readFullState();
  let list = null;
  if (type === 'strategicGoal') list = state.strategicGoals;
  else if (type === 'constraint') list = state.constraints;
  else if (type === 'currentGoal') list = state.currentGoals;

  if (list) {
    const item = list.find(i => i.id === id);
    if (item) {
      item.locked = false;
      item.updatedAt = new Date().toISOString();
      state.meta = state.meta || {};
      state.meta.lastUpdated = new Date().toISOString();
      // Go through the shared persistence layer: synchronously write back to split documents + state.json
      // so the AI can see the panel edits
      Storage.writeState(state);
      return { success: true, locked: false };
    }
  }

  return { error: 'Target not found' };
});

// Manually add an event
ipcMain.handle('add-event', (event, { date, time, title, description, category }) => {
  return Actions.execute('event.add', { date, time, title, description, category });
  const state = Storage.readFullState();
  state.schedule = state.schedule || { days: {} };
  state.schedule.days = state.schedule.days || {};

  if (!state.schedule.days[date]) {
    const d = new Date(date);
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    state.schedule.days[date] = { date, weekday: weekdays[d.getDay()], tasks: [] };
  }

  const newTask = {
    id: genId('t'),
    time: time || '00:00',
    duration: 60,
    title: title || 'New event',
    description: description || '',
    priority: 50,
    completed: false,
    source: 'manual',
    category: category || 'event'
  };

  state.schedule.days[date].tasks.push(newTask);
  state.schedule.days[date].tasks.sort((a, b) => a.time.localeCompare(b.time));

  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  // Go through the shared persistence layer: synchronously write back to split documents + state.json
  // so the AI can see the panel edits
  Storage.writeState(state);

  // Record into the audit stream.
  try {
    eventEngine.recordManualEvent({ kind: 'event', summary: title, detail: description, meta: { type: 'event', date, time, category } });
  } catch (e) { console.warn('[ZhiGui] Event write failed:', e.message); }

  return { success: true, task: newTask };
});

// Set theme
ipcMain.handle('set-theme', (event, { theme }) => {
  return Actions.execute('theme.set', { theme });
  const state = Storage.readFullState();
  state.meta = state.meta || {};
  state.meta.theme = theme;
  state.meta.lastUpdated = new Date().toISOString();
  Storage.writeState(state);

  // setBackgroundColor cannot be used in transparent mode; theme color is handled by CSS
  return { success: true };
});

// Set language preference (persisted to state.json)
ipcMain.handle('set-lang', (event, { lang }) => {
  return Actions.execute('lang.set', { lang });
  const state = Storage.readFullState();
  state.meta = state.meta || {};
  state.meta.lang = lang;
  state.meta.lastUpdated = new Date().toISOString();
  Storage.writeState(state);
  return { success: true };
});

// Collapse/expand window — simple two-state toggle:
//   - Collapse (collapsed=true): shrink window to small mini icon at bottom-right corner
//   - Expand (collapsed=false): restore full dashboard panel at right edge, full height
const MINI_MARGIN = 16; // Distance from screen edges when collapsed
ipcMain.handle('toggle-collapse', (event, collapsed) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { error: 'No window' };

  const workArea = screen.getPrimaryDisplay().workArea;
  const state = Storage.readFullState();
  state.meta = state.meta || {};

  if (collapsed) {
    // Collapse: small mini icon at bottom-right corner (above taskbar)
    const cx = Math.round(workArea.x + workArea.width - COLLAPSED_W - MINI_MARGIN);
    const cy = Math.round(workArea.y + workArea.height - COLLAPSED_H - MINI_MARGIN);
    mainWindow.setBounds({ x: cx, y: cy, width: COLLAPSED_W, height: COLLAPSED_H });
    saveBoundsExplicit(cx, cy, COLLAPSED_W, COLLAPSED_H);
  } else {
    // Expand: full dashboard panel at right edge
    const width = getExpandedWidth(workArea);
    const px = Math.round(workArea.x + workArea.width - width);
    const py = Math.round(workArea.y);
    const ph = Math.round(workArea.height);
    mainWindow.setBounds({ x: px, y: py, width, height: ph });
    saveBoundsExplicit(px, py, width, ph);
  }

  state.meta.collapsed = collapsed;
  Storage.writeState(state);

  return { success: true };
});

// Correct window position: pin the window to its target position based on current size.
function correctWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [cw, ch] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  const isCollapsedNow = cw <= COLLAPSED_W + 10 && ch <= COLLAPSED_H + 10;
  let nx, ny;
  if (isCollapsedNow) {
    nx = Math.round(wa.x + wa.width - COLLAPSED_W - MINI_MARGIN);
    ny = Math.round(wa.y + wa.height - COLLAPSED_H - MINI_MARGIN);
  } else {
    nx = Math.round(wa.x + wa.width - cw);
    ny = Math.round(wa.y);
  }
  if (nx !== x || ny !== y) mainWindow.setPosition(nx, ny);
}

// ===== Collapsed-state detection =====
function isCollapsedSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const [cw, ch] = mainWindow.getSize();
  return cw <= COLLAPSED_W + 10 && ch <= COLLAPSED_H + 10;
}

// ===== Manually add strategic goal / constraint =====
ipcMain.handle('add-goal', (event, { type, title, description, priority }) => {
  return Actions.execute('goal.add', { type, title, description, priority });
  const state = Storage.readFullState();
  const newGoal = {
    id: genId(type === 'strategicGoal' ? 'sg' : 'c'),
    title: title || 'New goal',
    description: description || '',
    priority: Math.max(0, Math.min(100, parseInt(priority) || 50)),
    locked: true,   // Manually added ones are locked by default
    source: 'manual',
    createdAt: new Date().toISOString()
  };

  if (type === 'strategicGoal') {
    state.strategicGoals = state.strategicGoals || [];
    state.strategicGoals.push(newGoal);
  } else if (type === 'constraint') {
    state.constraints = state.constraints || [];
    state.constraints.push(newGoal);
  } else {
    return { error: 'Unknown type' };
  }

  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  // Go through the shared persistence layer: synchronously write back to split documents + state.json
  // so the AI can see the panel edits
  Storage.writeState(state);

  // Record into the audit stream.
  try {
    eventEngine.recordManualEvent({
      kind: type === 'strategicGoal' ? 'goal' : 'constraint',
      summary: title, detail: description,
      meta: { priority: newGoal.priority, locked: true }
    });
  } catch (e) { console.warn('[ZhiGui] Event write failed:', e.message); }

  return { success: true, goal: newGoal };
});

ipcMain.handle('complete-goal', (event, payload) => {
  return Actions.execute('goal.complete', payload);
});

ipcMain.handle('add-errand', (event, payload) => {
  return Actions.execute('errand.add', payload);
});

ipcMain.handle('update-errand', (event, payload) => {
  return Actions.execute('errand.update', payload);
});

// ===== Delete strategic goal / constraint / current goal =====
// Replicates dashboard/server.js handleDeleteGoal: removes the item from the corresponding
// list, cascades deletion of related tasks in the schedule, then writes back through the
// shared persistence layer.
ipcMain.handle('delete-goal', (event, { type, id }) => {
  return Actions.execute('goal.delete', { type, id });
  const state = Storage.readFullState();
  let list = null;
  if (type === 'strategicGoal') list = state.strategicGoals;
  else if (type === 'constraint') list = state.constraints;
  else if (type === 'currentGoal') list = state.currentGoals;
  if (!list) {
    return { error: 'Invalid type' };
  }
  const idx = list.findIndex(g => g.id === id);
  if (idx === -1) {
    return { error: 'Not found' };
  }
  const deleted = list.splice(idx, 1)[0];
  // Cascade delete related tasks in schedule
  if (state.schedule?.days) {
    for (const day of Object.values(state.schedule.days)) {
      if (day.tasks) {
        day.tasks = day.tasks.filter(t => t.relatedGoalId !== id);
      }
    }
  }
  // Sync topic index: unbind this goal from all topics
  try {
    const brain = getBrainIndex();
    brain.unlinkEntityCascade('goals', id);
    if (deleted.topicId) { try { brain.reindexTopic(deleted.topicId); } catch {} }
  } catch (e) { console.error('Topic index sync error (delete-goal):', e.message); }
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  // Go through the shared persistence layer: synchronously write back to split documents + state.json
  // so the AI can see the panel edits. The file watcher will push 'state-updated' to the renderer.
  Storage.writeState(state);

  return { success: true, deleted: deleted.title };
});

// ===== Mark errand complete / uncomplete =====
// Replicates dashboard/server.js handleCompleteErrand: toggles the errand's completed flag.
ipcMain.handle('complete-errand', (event, { id }) => {
  return Actions.execute('errand.complete', { id });
  const state = Storage.readFullState();
  const errand = (state.errands || []).find(e => e.id === id);
  if (!errand) {
    return { error: 'Errand not found' };
  }
  errand.completed = !errand.completed;
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  // Go through the shared persistence layer: synchronously write back to split documents + state.json
  // so the AI can see the panel edits. The file watcher will push 'state-updated' to the renderer.
  Storage.writeState(state);

  return { success: true, completed: errand.completed };
});

// ===== Delete errand =====
// Replicates dashboard/server.js handleDeleteErrand: removes the errand from state.errands.
ipcMain.handle('delete-errand', (event, { id }) => {
  return Actions.execute('errand.delete', { id });
  const state = Storage.readFullState();
  const idx = (state.errands || []).findIndex(e => e.id === id);
  if (idx === -1) {
    return { error: 'Errand not found' };
  }
  state.errands.splice(idx, 1);
  // Sync topic index: unbind this errand from all topics
  try {
    const brain = getBrainIndex();
    brain.unlinkEntityCascade('errands', id);
  } catch (e) { console.error('Topic index sync error (delete-errand):', e.message); }
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  // Go through the shared persistence layer: synchronously write back to split documents + state.json
  // so the AI can see the panel edits. The file watcher will push 'state-updated' to the renderer.
  Storage.writeState(state);

  return { success: true };
});

// ===== Capture a raw note =====
// The panel only captures the original text. AI enrichment is a separate action that
// writes the summary title, topic and category after reading this one note on demand.
ipcMain.handle('add-note', (event, payload) => {
  return Actions.execute('note.add', payload);
});

// Import keeps source text untouched and queues it for AI organization + user review.
ipcMain.handle('import-notes', (event, payload) => {
  return Actions.execute('note.import', payload);
});

// ===== Delete one note (panel delete is non-cascade) =====
ipcMain.handle('delete-note', (event, { noteId }) => {
  return Actions.execute('note.delete', { noteId });
});

// ===== Update note content =====
ipcMain.handle('update-note', (event, { noteId, content }) => {
  return Actions.execute('note.update', { noteId, content });
});

ipcMain.handle('resolve-review', (event, payload) => {
  return Actions.execute('review.resolve', payload);
});

// ===== Update domain weights / value system =====
// Replicates dashboard/server.js handleUpdateWeights: merges priorities / decisionStyle /
// learnedFrom into userProfile.valueSystem.
ipcMain.handle('update-weights', (event, { priorities, decisionStyle, learnedFrom }) => {
  return Actions.execute('weights.update', { priorities, decisionStyle, learnedFrom });
  const state = Storage.readFullState();
  state.userProfile = state.userProfile || {};
  state.userProfile.valueSystem = state.userProfile.valueSystem || {};
  if (priorities) state.userProfile.valueSystem.priorities = priorities;
  if (decisionStyle) state.userProfile.valueSystem.decisionStyle = decisionStyle;
  if (learnedFrom) {
    state.userProfile.valueSystem.learnedFrom = state.userProfile.valueSystem.learnedFrom || [];
    state.userProfile.valueSystem.learnedFrom.push(...learnedFrom);
  }
  state.userProfile.updatedAt = new Date().toISOString();
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  // Go through the shared persistence layer: synchronously write back to split documents + state.json
  // so the AI can see the panel edits. The file watcher will push 'state-updated' to the renderer.
  Storage.writeState(state);

  return { success: true };
});

// ===== Topic Library IPC handlers =====
ipcMain.handle('get-topics', () => {
  try {
    const brain = getBrainIndex();
    const topics = brain.getTopics();
    const unclassifiedNotes = (Storage.readFullState().notes || [])
      .filter(note => note.needsEnrichment === true || !note.topicId)
      .map(note => ({ id: note.id, title: note.title || '待 AI 整理', createdAt: note.createdAt || null, source: note.source || null }));
    return { topics, total: topics.length, unclassifiedNotes };
  } catch (e) {
    return { topics: [], total: 0, error: e.message };
  }
});

// Delete a scheduled reminder by ID
ipcMain.handle('reminder-delete', (event, { id }) => {
  return Actions.execute('reminder.delete', { id });
  if (!id) return { error: 'Missing reminder id' };
  const state = Storage.readFullState();
  state.reminders = state.reminders || [];
  const before = state.reminders.length;
  state.reminders = state.reminders.filter(rm => rm.id !== id);
  if (state.reminders.length === before) return { error: 'Reminder not found' };
  state.meta = state.meta || {};
  state.meta.lastUpdated = new Date().toISOString();
  const Storage = require('../engine/storage');
  Storage.writeState(state);
  return { success: true };
});

// Cascade delete a topic and all its associations (mirrors dashboard server handleDeleteTopic)
ipcMain.handle('topic-delete', (event, { topicId, confirm }) => {
  if (!topicId) return { error: 'Missing topicId' };
  const brain = getBrainIndex();
  if (confirm !== true) {
    // Preview mode: return counts without deleting
    try {
      const t = brain.getTopics().find(x => x.id === topicId);
      if (!t) return { error: 'Topic not found', preview: null };
      return {
        aborted: true,
        reason: 'Not confirmed, returning preview only. Set confirm to true to execute cascade delete.',
        preview: { label: t.label, ...t.relatedCounts, notes: t.noteCount, precipitated: t.precipitated },
      };
    } catch (e) {
      return { error: e.message };
    }
  }
  // Execute cascade delete
  try {
    const result = brain.cascadeDelete(topicId);
    // Re-read full state from hierarchy after cascade delete
    const freshState = Storage.readFullState();
    // Write the fresh merged state back to persistence layer so the panel sees the update
    Storage.writeState(freshState);
    return result;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-topic', (event, { topicId }) => {
  try {
    const brain = getBrainIndex();
    const doc = brain.getTopicDocument(topicId);
    if (!doc) return null;
    return { ...doc, noteCount: (doc.notes || []).length };
  } catch (e) {
    return null;
  }
});

ipcMain.handle('find-associated', (event, { q }) => {
  try {
    const brain = getBrainIndex();
    return brain.findAssociated(q || '');
  } catch (e) {
    return { found: false };
  }
});

ipcMain.handle('search', (event, { q }) => {
  try {
    const brain = getBrainIndex();
    return brain.search(q || '');
  } catch (e) {
    return { query: q, total: 0, hits: [] };
  }
});

// ===== File watching (replaces SSE) =====
let watchDebounce = null;

function setupFileWatcher() {
  try {
    fs.watch(ZHIGUI_DIR, { persistent: false }, (eventType, filename) => {
      if (!filename) return;

      // Debounce: multiple changes within 100ms only push once
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (filename === 'state.json') {
            mainWindow.webContents.send('state-updated');
          } else if (filename === 'history.json') {
            mainWindow.webContents.send('history-updated');
          } else {
            // Unknown file change, push a unified state update
            mainWindow.webContents.send('state-updated');
          }
        }
      }, 100);
    });
    console.log('[ZhiGui] File watcher started');
  } catch (e) {
    console.warn('[ZhiGui] File watcher failed to start:', e.message);
  }
}

// ===== App lifecycle =====
app.whenReady().then(() => {
  ensureDataFiles();
  createWindow();
  setupFileWatcher();

  // Display/resolution/taskbar changes: ensure the window stays in the visible area
  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const [cw, ch] = mainWindow.getSize();
    const [oldX, oldY] = mainWindow.getPosition();
    const isCollapsedNow = cw <= COLLAPSED_W + 10 && ch <= COLLAPSED_H + 10;
    const newX = isCollapsedNow
      ? Math.round(wa.x + wa.width - COLLAPSED_W - MINI_MARGIN)
      : Math.round(wa.x + wa.width - cw);
    const newY = isCollapsedNow
      ? Math.round(wa.y + wa.height - COLLAPSED_H - MINI_MARGIN)
      : Math.round(wa.y);
    if (newX !== oldX || newY !== oldY) {
      mainWindow.setPosition(newX, newY);
    }
    saveBoundsExplicit(newX, newY, cw, ch);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Block certificate errors
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});
