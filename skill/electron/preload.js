/**
 * ZhiGui - Decision & Planning Companion - Electron Preload
 *
 * Secure IPC bridge layer, exposes a restricted API to the renderer process via contextBridge
 * Replaces fetch / EventSource (SSE) in the browser version
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zhigui', {
  // ===== Data reading =====
  getState: () => ipcRenderer.invoke('get-state'),
  getHistory: () => ipcRenderer.invoke('get-history'),
  getTopics: () => ipcRenderer.invoke('get-topics'),
  getTopic: (topicId) => ipcRenderer.invoke('get-topic', { topicId }),
  findAssociated: (q) => ipcRenderer.invoke('find-associated', { q }),
  search: (q) => ipcRenderer.invoke('search', { q }),

  // ===== Data operations =====
  toggleTask: (date, taskId) => ipcRenderer.invoke('toggle-task', { date, taskId }),
  updateTask: (data) => ipcRenderer.invoke('update-task', data),
  deleteTask: (data) => ipcRenderer.invoke('delete-task', data),
  unlockTask: (data) => ipcRenderer.invoke('unlock-task', data),
  updatePriority: (type, id, priority) => ipcRenderer.invoke('update-priority', { type, id, priority }),
  unlockPriority: (type, id) => ipcRenderer.invoke('unlock-priority', { type, id }),
  addEvent: (data) => ipcRenderer.invoke('add-event', data),
  addGoal: (data) => ipcRenderer.invoke('add-goal', data),
  completeGoal: (data) => ipcRenderer.invoke('complete-goal', data),
  deleteGoal: (data) => ipcRenderer.invoke('delete-goal', data),
  addErrand: (data) => ipcRenderer.invoke('add-errand', data),
  updateErrand: (data) => ipcRenderer.invoke('update-errand', data),
  deleteErrand: (data) => ipcRenderer.invoke('delete-errand', data),
  completeErrand: (data) => ipcRenderer.invoke('complete-errand', data),
  addNote: (data) => ipcRenderer.invoke('add-note', data),
  importNotes: (data) => ipcRenderer.invoke('import-notes', data),
  updateNote: (data) => ipcRenderer.invoke('update-note', data),
  deleteNote: (data) => ipcRenderer.invoke('delete-note', data),
  resolveReview: (data) => ipcRenderer.invoke('resolve-review', data),
  updateWeights: (data) => ipcRenderer.invoke('update-weights', data),
  deleteTopic: (data) => ipcRenderer.invoke('topic-delete', data),
  deleteReminder: (data) => ipcRenderer.invoke('reminder-delete', data),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', { theme }),
  setLang: (lang) => ipcRenderer.invoke('set-lang', { lang }),

  // ===== Window control =====
  // Note: APIs related to floating-ball dragging have been removed (only the expanded
  // panel is kept per user request, no floating ball).
  toggleCollapse: (collapsed) => ipcRenderer.invoke('toggle-collapse', collapsed),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  closeApp: () => ipcRenderer.invoke('close-app'),

  // ===== Real-time update listening (replaces SSE) =====
  onStateUpdate: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('state-updated', handler);
    // Return an unsubscribe function
    return () => ipcRenderer.removeListener('state-updated', handler);
  },
  onHistoryUpdate: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('history-updated', handler);
    return () => ipcRenderer.removeListener('history-updated', handler);
  },

  // ===== Tray / right-click menu triggers =====
  onToggleRequest: (callback) => {
    ipcRenderer.on('toggle-from-tray', callback);
  },

  // ===== Environment identifier =====
  isElectron: true,
});
