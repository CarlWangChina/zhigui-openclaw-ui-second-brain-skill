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
const { createDashboardState } = require('../engine/dashboard-state');
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

// Save the current window position
function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  saveBoundsExplicit(b.x, b.y, b.width, b.height);
}

// Explicitly save window position
function saveBoundsExplicit(x, y, w, h) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  Actions.execute('window.presentation.set', {
    bounds: { x, y, width: w, height: h },
  });
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
  const savedState = Storage.readFullState() || {};
  const savedBounds = savedState.meta?.windowBounds;
  const restoreCollapsed = savedState.meta?.collapsed === true;
  const canRestoreBounds = savedBounds && ['x', 'y', 'width', 'height']
    .every(key => Number.isFinite(Number(savedBounds[key]))) &&
    Number(savedBounds.width) >= COLLAPSED_W && Number(savedBounds.height) >= COLLAPSED_H;

  // The persisted presentation mode is authoritative.  A collapsed window
  // must reopen as the mini control, never as a full dashboard squeezed into
  // its saved 56×56 bounds.  Conversely, an expanded panel always gets its
  // current full-height layout instead of inheriting stale mini bounds.
  const initW = restoreCollapsed
    ? COLLAPSED_W
    : (canRestoreBounds && Number(savedBounds.width) > COLLAPSED_W ? Math.min(Math.round(savedBounds.width), workArea.width) : expandedWidth);
  const initH = restoreCollapsed
    ? COLLAPSED_H
    : (canRestoreBounds && Number(savedBounds.height) > COLLAPSED_H ? Math.min(Math.round(savedBounds.height), workArea.height) : workArea.height);
  const defaultX = Math.round(workArea.x + workArea.width - expandedWidth);
  const defaultY = workArea.y;
  const initX = restoreCollapsed
    ? Math.round(workArea.x + workArea.width - COLLAPSED_W - MINI_MARGIN)
    : canRestoreBounds
    ? Math.max(workArea.x, Math.min(Math.round(savedBounds.x), workArea.x + workArea.width - initW))
    : defaultX;
  const initY = restoreCollapsed
    ? Math.round(workArea.y + workArea.height - COLLAPSED_H - MINI_MARGIN)
    : canRestoreBounds
    ? Math.max(workArea.y, Math.min(Math.round(savedBounds.y), workArea.y + workArea.height - initH))
    : defaultY;

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

  // Window preferences use the same transactional state path as every other
  // panel mutation; state.json is only a fallback projection now.
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
        click: (item) => {
          mainWindow.setAlwaysOnTop(item.checked, 'floating', 1);
          try {
            Actions.execute('window.presentation.set', { alwaysOnTop: item.checked });
          } catch (e) { /* ignore */ }
          mainWindow.webContents.send('pin-state-changed', item.checked);
        }
      },
      { type: 'separator' },
      {
        label: 'Close ZhiGui',
        click: () => mainWindow.close()
      }
    ]);
    menu.popup();
  });

  mainWindow.on('close', () => {
    try { saveBounds(); } catch (e) {}
  });
  mainWindow.on('closed', () => {
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
  // Persist through the shared command layer so a window preference cannot
  // overwrite a concurrent task/note mutation.
  try {
    Actions.execute('window.presentation.set', { alwaysOnTop: newTop });
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
  return createDashboardState(state, topicIndex);
});

// Read history
ipcMain.handle('get-history', () => {
  return readJson(HISTORY_FILE) || { conversations: [] };
});

// Toggle task completion
ipcMain.handle('toggle-task', (event, { date, taskId }) => {
  return Actions.execute('task.toggle', { date, taskId });
});

// Update task time/duration (manual lock)
ipcMain.handle('update-task', (event, { date, taskId, time, duration }) => {
  return Actions.execute('task.update', { date, taskId, time, duration });
});

// Delete one scheduled task without affecting the rest of that day.
ipcMain.handle('delete-task', (event, payload) => {
  return Actions.execute('task.delete', payload);
});

// Unlock task (remove manual lock)
ipcMain.handle('unlock-task', (event, { date, taskId }) => {
  return Actions.execute('task.unlock', { date, taskId });
});

// Manually add an event
ipcMain.handle('add-event', (event, { date, time, title, description, category }) => {
  return Actions.execute('event.add', { date, time, title, description, category });
});

// Set theme
ipcMain.handle('set-theme', (event, { theme }) => {
  return Actions.execute('theme.set', { theme });
});

// Set language preference (persisted to state.json)
ipcMain.handle('set-lang', (event, { lang }) => {
  return Actions.execute('lang.set', { lang });
});

// Collapse/expand window — simple two-state toggle:
//   - Collapse (collapsed=true): shrink window to small mini icon at bottom-right corner
//   - Expand (collapsed=false): restore full dashboard panel at right edge, full height
const MINI_MARGIN = 16; // Distance from screen edges when collapsed
ipcMain.handle('toggle-collapse', (event, collapsed) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { error: 'No window' };

  const workArea = screen.getPrimaryDisplay().workArea;
  let bounds;

  if (collapsed) {
    // Collapse: small mini icon at bottom-right corner (above taskbar)
    const cx = Math.round(workArea.x + workArea.width - COLLAPSED_W - MINI_MARGIN);
    const cy = Math.round(workArea.y + workArea.height - COLLAPSED_H - MINI_MARGIN);
    mainWindow.setBounds({ x: cx, y: cy, width: COLLAPSED_W, height: COLLAPSED_H });
    bounds = { x: cx, y: cy, width: COLLAPSED_W, height: COLLAPSED_H };
  } else {
    // Expand: full dashboard panel at right edge
    const width = getExpandedWidth(workArea);
    const px = Math.round(workArea.x + workArea.width - width);
    const py = Math.round(workArea.y);
    const ph = Math.round(workArea.height);
    mainWindow.setBounds({ x: px, y: py, width, height: ph });
    bounds = { x: px, y: py, width, height: ph };
  }

  Actions.execute('window.presentation.set', { collapsed, bounds });

  return { success: true };
});

// ===== Manually add strategic goal / constraint =====
ipcMain.handle('add-goal', (event, { type, title, description }) => {
  return Actions.execute('goal.add', { type, title, description });
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
ipcMain.handle('delete-goal', (event, { type, id }) => {
  return Actions.execute('goal.delete', { type, id });
});

// ===== Mark errand complete =====
// Completes an errand: moves it to completedActions log, removes from active errands.
ipcMain.handle('complete-errand', (event, { id }) => {
  try {
    return Actions.execute('errand.complete', { id });
  } catch (err) {
    // errand may have already been completed (e.g. double-click or stale UI)
    return { success: false, error: err.message, code: err.code || 'ALREADY_DONE' };
  }
});

// ===== Undo errand complete =====
// Restores a completed action back to active errands.
ipcMain.handle('undo-errand', (event, { actionId }) => {
  try {
    return Actions.execute('errand.undo', { actionId });
  } catch (err) {
    return { success: false, error: err.message, code: err.code || 'UNDO_FAILED' };
  }
});

// ===== Delete errand =====
ipcMain.handle('delete-errand', (event, { id }) => {
  return Actions.execute('errand.delete', { id });
});

// ===== Record a manually structured note =====
ipcMain.handle('add-note', (event, payload) => {
  return Actions.execute('note.add', payload);
});

// ===== Delete one note (also removes stale action/decision references) =====
ipcMain.handle('delete-note', (event, { noteId }) => {
  return Actions.execute('note.delete', { noteId });
});

ipcMain.handle('get-note', (event, { noteId }) => {
  const note = Storage.getNoteDetail(noteId);
  return note ? { note } : null;
});

ipcMain.handle('preview-delete', (event, payload) => {
  return Actions.execute('deletion.preview', payload);
});

ipcMain.handle('decision-update', (event, payload) => {
  return Actions.execute('decision.update', payload);
});

ipcMain.handle('decision-delete', (event, payload) => {
  return Actions.execute('decision.delete', payload);
});

// ===== Update note content =====
ipcMain.handle('update-note', (event, { noteId, content }) => {
  return Actions.execute('note.update', { noteId, content });
});

// ===== Update domain weights / value system =====
ipcMain.handle('update-weights', (event, { priorities, decisionStyle, learnedFrom }) => {
  return Actions.execute('weights.update', { priorities, decisionStyle, learnedFrom });
});

// ===== Topic Library IPC handlers =====
ipcMain.handle('get-topics', () => {
  try {
    const brain = getBrainIndex();
    const topics = brain.getTopics().filter(topic =>
      (topic.noteCount || 0) > 0 || (topic.relatedCounts?.goals || 0) > 0 || (topic.relatedCounts?.actionItems || 0) > 0
    );
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
});

// Delete only the topic-owned notes. Linked tasks, errands and goals are kept
// and have deleted note/topic references removed by the shared action layer.
ipcMain.handle('topic-delete', (event, { topicId, confirm }) => {
  try {
    return Actions.execute(confirm === true ? 'topic.delete' : 'topic.preview_delete', { topicId, confirm });
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-topic', (event, { topicId }) => {
  try {
    const brain = getBrainIndex();
    const doc = brain.getTopicDocument(topicId, { includeNotes: true });
    if (!doc) return null;
    const notes = (doc.notes || []).map(note => ({
      id: note.id,
      title: note.title || null,
      createdAt: note.createdAt || null,
      relatedDate: note.relatedDate || null,
      relatedTime: note.relatedTime || null,
      domain: note.domain || null,
      source: note.source || null,
      needsEnrichment: !!note.needsEnrichment,
    }));
    return { ...doc, notes, noteCount: notes.length };
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
let pendingFiles = new Set();

function setupFileWatcher() {
  try {
    fs.watch(ZHIGUI_DIR, { persistent: false, recursive: true }, (eventType, filename) => {
      if (!filename) return;
      pendingFiles.add(filename);

      // Debounce: multiple changes within 100ms only push once
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (pendingFiles.has('history.json')) {
            mainWindow.webContents.send('history-updated');
          }
          // Any file change may affect panel state — always notify
          mainWindow.webContents.send('state-updated');
        }
        pendingFiles.clear();
      }, 100);
    });
    console.log('[ZhiGui] File watcher started');
  } catch (e) {
    console.warn('[ZhiGui] File watcher failed to start:', e.message);
  }
}

// ===== App lifecycle =====
app.whenReady().then(() => {
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
