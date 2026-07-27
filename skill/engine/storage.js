/**
 * Lingxi - Shared persistence and projection layer
 *
 * Solves the "dual-storage divergence": the Electron panel's manual edits only write to
 * state.json, while the AI/MCP layer primarily reads the split documents (goals.json /
 * schedule.json / ...), causing each side to be unaware of the other's changes.
 *
 * This module is called by both mcp/server.js (the AI process) and electron/main.js
 * (the panel process), ensuring both write paths are completely consistent; readState
 * reconciles via timestamps, preferring the more recently updated copy, eliminating the
 * data loss scenario where "AI write-back overwrites panel edits".
 *
 * Zero dependencies, only uses Node.js built-in modules.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DOCUMENT_KEYS, validateStateSchema } = require('./constants');

// Lazy-load Hierarchy (avoids circular require if hierarchy.js ever requires storage)
let _Hierarchy = null;
function getHierarchy() {
  if (!_Hierarchy) _Hierarchy = require('./hierarchy').Hierarchy;
  return _Hierarchy;
}

// --- Document key mapping for the authoritative state write path ---------
// (Task 1.3: DOCUMENT_KEYS is now defined in constants.js — single source of truth)

// P0-2.2: Module-level EventEmitter for write-after-sync notifications.
// writeState() emits a 'write' event (carrying the list of changed document types)
// once the persistence is complete, so listeners (e.g. brain-index reindex) can
// react without polling.
const _writeEmitter = new EventEmitter();
// Raise the default listener cap so multiple subsystems can subscribe safely.
_writeEmitter.setMaxListeners(20);

// Detect which document types are present (and therefore potentially changed) in
// the state object being written. Used as the payload for the 'write' event.
function _detectChangedDocs(state) {
  const docs = [];
  if (state.strategicGoals !== undefined || state.currentGoals !== undefined || state.constraints !== undefined) docs.push('goals');
  if (state.schedule !== undefined) docs.push('schedule');
  if (state.errands !== undefined) docs.push('errands');
  if (state.notes !== undefined) docs.push('notes');
  if (state.pendingReviews !== undefined || state.importBatches !== undefined) docs.push('settingsConflicts');
  if (state.reminders !== undefined) docs.push('reminders');
  if (state.userProfile !== undefined) docs.push('userProfile');
  return docs;
}

// P0-2.2: Register a listener that fires after every successful writeState call.
// The callback receives an array of changed document-type strings (e.g. ['goals','notes']).
function onWrite(callback) {
  _writeEmitter.on('write', callback);
}

// Module-level data directory (injected via setDataDir to avoid path coupling with callers)
let DATA_DIR = null;
let LOCK_DEPTH = 0;
function setDataDir(dir) {
  DATA_DIR = dir;
  // Task 3.1: Invalidate cache and hierarchy instance when data directory changes
  _fullStateCache = null;
  _hierarchyInstance = null;
}

// Task 3.1: readFullState performance optimization — mtime-based read cache.
// Instead of reading and parsing every file on each call (48+ call sites), we cache
// the result and only re-read when a source file's modification time has changed.
// The cache is also invalidated immediately by the write emitter (onWrite).
let _fullStateCache = null;        // { state, mtimes: Map<filePath, mtimeMs> }
let _hierarchyInstance = null;     // reused Hierarchy instance

// Reuse a single Hierarchy instance instead of creating one per read.
function _getHierarchyInstance() {
  if (!_hierarchyInstance && DATA_DIR) {
    const Hierarchy = getHierarchy();
    _hierarchyInstance = new Hierarchy(DATA_DIR);
  }
  return _hierarchyInstance;
}

// Get the mtime (in ms) of a file, or 0 if the file doesn't exist / can't be stat'd.
function _getFileMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

// Build the list of "sentinel" files whose mtimes determine whether the cache is stale.
// Checking ~10 index/small-file mtimes is far cheaper than reading + parsing all detail files.
function _getSentinelFiles() {
  const { DOCUMENT_FILES, STATE_FILE } = _paths();
  const Hierarchy = getHierarchy();
  const h = _getHierarchyInstance();
  const files = [
    STATE_FILE,
    DOCUMENT_FILES.errands,
    DOCUMENT_FILES.settingsConflicts,
    DOCUMENT_FILES.reminders,
    DOCUMENT_FILES.userProfile,
    DOCUMENT_FILES.schedule,  // schedule-level meta (conflicts, briefings)
  ];
  // Hierarchy index files (lightweight — their mtime changes whenever any detail is written)
  if (h) {
    files.push(h.files.goalsIndex, h.files.notesIndex, h.files.scheduleIndex);
  }
  return files;
}

// Check whether any sentinel file has changed since the cache was populated.
// Returns true if the cache is stale (or absent), false if it's still valid.
function _isCacheStale() {
  if (!_fullStateCache) return true;
  for (const filePath of _getSentinelFiles()) {
    if (_getFileMtime(filePath) !== _fullStateCache.mtimes.get(filePath)) {
      return true;
    }
  }
  return false;
}

// Snapshot the current mtimes of all sentinel files for later comparison.
function _snapshotMtimes() {
  const mtimes = new Map();
  for (const filePath of _getSentinelFiles()) {
    mtimes.set(filePath, _getFileMtime(filePath));
  }
  return mtimes;
}

// Invalidate the read cache. Called by the write emitter and on setDataDir.
function invalidateCache() {
  _fullStateCache = null;
}

// Register cache invalidation on every successful write (P0-2.2 emitter).
// This ensures the cache is busted immediately after writeState, without
// waiting for the next mtime check.
onWrite(() => { invalidateCache(); });

// Write JSON through a sibling temporary file and atomically replace the target.
// A crash can therefore leave either the old or the new complete document, never
// a half-written JSON file.
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Windows cannot always replace an existing file with renameSync. Remove the
    // destination only after the complete temporary document is safely written.
    try { fs.unlinkSync(filePath); } catch {}
    fs.renameSync(tempPath, filePath);
  }
}

// ===== Cross-process file lock (solves A, C: concurrent write race conditions) =====
// Uses a lock file on disk. Lock auto-expires after LOCK_TIMEOUT_MS to handle crashes.
const LOCK_TIMEOUT_MS = 15000;  // lock expires after 15 seconds
const LOCK_RETRY_MS = 50;       // retry interval
const LOCK_RETRY_MAX = 60;      // max retries (~3 seconds total)
const LOCK_FILE_NAME = '.write-lock';

function _lockPath() {
  if (!DATA_DIR) return null;
  return path.join(DATA_DIR, LOCK_FILE_NAME);
}

// Try to acquire the write lock. Returns true if acquired, false if held by another process.
// processName: 'ai' | 'dashboard' | 'electron' — used for SSE notification
function acquireLock(processName) {
  const lockFile = _lockPath();
  if (!lockFile) return false; // no DATA_DIR, cannot acquire lock
  const now = Date.now();
  try {
    // Check if lock file exists and is still valid
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const expiresAt = existing.expiresAt || 0;
      if (now < expiresAt && existing.pid !== process.pid) {
        // Lock is held by another process and hasn't expired
        return false;
      }
    } catch {
      // Lock file doesn't exist or is corrupt — we can acquire
    }
    // Write our lock
    const lockData = {
      pid: process.pid,
      process: processName,
      acquiredAt: new Date().toISOString(),
      expiresAt: now + LOCK_TIMEOUT_MS,
    };
    fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Acquire lock with retry (blocks until acquired or timeout)
function acquireLockBlocking(processName) {
  for (let i = 0; i < LOCK_RETRY_MAX; i++) {
    if (acquireLock(processName)) return true;
    // Wait and retry — use synchronous sleep
    const start = Date.now();
    while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
  }
  return false;
}

// Release the write lock
function releaseLock() {
  try {
    const lockFile = _lockPath();
    if (!lockFile) return; // no DATA_DIR, nothing to release
    // Only release if we own the lock
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (existing.pid !== process.pid) return; // not our lock
    } catch {}
    fs.unlinkSync(lockFile);
  } catch {}
}

// Check if the lock is currently held by another process
function isLockedByOther() {
  const lockFile = _lockPath();
  if (!lockFile) return { locked: false }; // no DATA_DIR, no lock
  try {
    const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const now = Date.now();
    if (now < (existing.expiresAt || 0) && existing.pid !== process.pid) {
      return { locked: true, by: existing.process, pid: existing.pid };
    }
  } catch {}
  return { locked: false };
}

// Execute a function with the write lock held. Releases automatically (even on error).
// When DATA_DIR is null (e.g. test environment), runs fn() without locking.
function withLock(processName, fn) {
  if (!DATA_DIR) {
    return fn();
  }
  // Hierarchy writes are called from inside aggregate writes. Treat nested calls
  // in the same process as re-entrant so an inner write cannot release the outer
  // process lock prematurely.
  if (LOCK_DEPTH > 0) {
    LOCK_DEPTH++;
    try { return fn(); }
    finally { LOCK_DEPTH--; }
  }
  const acquired = acquireLockBlocking(processName);
  if (!acquired) {
    const state = isLockedByOther();
    throw new Error(`Write lock held by ${state.by || 'unknown'} process (pid: ${state.pid}). Retry later.`);
  }
  try {
    LOCK_DEPTH = 1;
    return fn();
  } finally {
    LOCK_DEPTH = 0;
    releaseLock();
  }
}

function _paths() {
  const d = DATA_DIR;
  return {
    DOCUMENT_FILES: {
      goals: path.join(d, 'goals.json'),
      schedule: path.join(d, 'schedule.json'),
      errands: path.join(d, 'errands.json'),
      notes: path.join(d, 'notes.json'),
      settingsConflicts: path.join(d, 'settings-conflicts.json'),
      reminders: path.join(d, 'reminders.json'),
      userProfile: path.join(d, 'userProfile.json'),
    },
    STATE_FILE: path.join(d, 'state.json'),
    INDEX_FILE: path.join(d, 'documents.json'),
  };
}

// Older releases could move note bodies into topics/*.json while leaving the hierarchy
// index empty. Recover those bodies once into the canonical per-note detail store.
function repairArchivedNoteDetails(h) {
  const topicsDir = path.join(DATA_DIR, 'topics');
  let files = [];
  try { files = fs.readdirSync(topicsDir).filter(name => name.endsWith('.json')); } catch { return 0; }
  let repaired = 0;
  for (const name of files) {
    try {
      const archive = JSON.parse(fs.readFileSync(path.join(topicsDir, name), 'utf-8'));
      for (const note of (archive.notes || [])) {
        if (note?.id && !h.getNoteDetail(note.id)) {
          h.writeNote(note);
          repaired++;
        }
      }
    } catch {}
  }
  return repaired;
}

// --- Low-level document read/write --------------------------------------
function readDocument(docType) {
  const { DOCUMENT_FILES } = _paths();
  try {
    return JSON.parse(fs.readFileSync(DOCUMENT_FILES[docType], 'utf-8'));
  } catch {
    return null;
  }
}

function writeDocument(docType, data) {
  return withLock('storage', () => {
    const { DOCUMENT_FILES, INDEX_FILE } = _paths();
    data.meta = data.meta || {};
    data.meta.lastUpdated = data.meta.lastUpdated || new Date().toISOString();
    data.meta.documentType = docType;
    writeJsonAtomic(DOCUMENT_FILES[docType], data);
    updateIndexTimestamp(docType);
  });
}

// Update the timestamp of the document index (the first layer of the two-layer retrieval)
function updateIndexTimestamp(docType) {
  const { DOCUMENT_FILES, INDEX_FILE } = _paths();
  try {
    let idx = null;
    try {
      idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    } catch {
      // If the index does not exist, lazily create it to keep the two-layer retrieval usable
      idx = { meta: { lastUpdated: new Date().toISOString(), description: 'Lingxi document index - first-layer retrieval' }, documents: [] };
    }
    if (idx && idx.documents) {
      idx.documents = idx.documents.filter(document => document.type !== 'decisions');
      const doc = idx.documents.find(d => d.type === docType);
      if (doc) {
        doc.lastUpdated = new Date().toISOString();
        try { doc.size = fs.statSync(DOCUMENT_FILES[docType]).size; } catch {}
      }
      idx.meta.lastUpdated = new Date().toISOString();
      writeJsonAtomic(INDEX_FILE, idx);
    }
  } catch {}
}

// --- Aggregate read/write (hierarchical: primary storage is now the file tree) ---
// The old flat files (goals.json/notes.json/schedule.json) are NO LONGER the primary store.
// Instead, hierarchy.js manages:
//   goals-index.json + goals/g_xxx.json
//   notes-index.json + notes/n_xxx.json
//   schedule-index.json + schedule/YYYY-MM-DD.json
// readState() returns the LIGHTWEIGHT state (indexes only) by default.
// readFullState() loads everything (use sparingly).
function readState() {
  return readLightweightState();
}

// On write: write to hierarchy (index + detail files) + small documents.
// Also writes the full state to state.json as a fallback copy, ensuring all three
// ends (MCP, Dashboard, Electron) can read each other's edits.
function writeState(state) {
  // Task 1.3: Dev-mode schema validation
  if (process.env.NODE_ENV === 'development') {
    const errors = validateStateSchema(state);
    if (errors.length > 0) {
      console.warn('[storage] Schema validation warnings:', errors.join('; '));
    }
  }
  const result = withLock('storage', () => {
    const { DOCUMENT_FILES, STATE_FILE } = _paths();
    const now = new Date().toISOString();
    const h = _getHierarchyInstance();

    // 1. Write goals to hierarchy (index + per-goal detail files)
    if (state.currentGoals || state.strategicGoals || state.constraints) {
      const incomingGoals = [
        ...(state.strategicGoals || []).map(g => ({ ...g, type: 'strategic' })),
        ...(state.currentGoals || []).map(g => ({ ...g, type: 'current' })),
        ...(state.constraints || []).map(g => ({ ...g, type: 'constraint' })),
      ].filter(g => g && g.id);
      const hasProjection = incomingGoals.some(goal => goal._lightweight);
      const existingById = new Map(h.getGoalsIndex().map(entry => [entry.id, h.getGoalDetail(entry.id) || entry]));
      const byId = new Map();
      if (hasProjection) for (const [goalId, existing] of existingById) byId.set(goalId, existing);
      for (const rawGoal of incomingGoals) {
        const { _lightweight, ...goal } = rawGoal;
        const existing = existingById.get(goal.id);
        byId.set(goal.id, _lightweight && existing ? { ...existing, ...goal } : goal);
      }
      const allGoals = [...byId.values()];
      if (allGoals.length > 0) h.writeGoals(allGoals);
      // Clean up hierarchy: remove goals that are no longer in the state
      // (writeGoals only upserts, never deletes — deleted goals would linger in the index)
      const existingIdx = h.getGoalsIndex();
      if (!hasProjection) {
        for (const existing of existingIdx) {
          if (!allGoals.some(g => g.id === existing.id)) {
            h.deleteGoal(existing.id);
          }
        }
      }
      state.strategicGoals = allGoals.filter(goal => goal.type === 'strategic' || goal.kind === 'strategic');
      state.constraints = allGoals.filter(goal => goal.type === 'constraint' || goal.kind === 'constraint');
      state.currentGoals = allGoals.filter(goal => goal.type !== 'strategic' && goal.kind !== 'strategic' && goal.type !== 'constraint' && goal.kind !== 'constraint');
    }

    // 2. Write notes to hierarchy. A lightweight projection is never authoritative:
    // materialise it from the existing detail file before persisting, otherwise a
    // dashboard/overview write could erase every note body.
    let canonicalNotes = null;
    if (state.notes) {
      const incomingNotes = Array.isArray(state.notes)
        ? state.notes
        : Object.values(state.notes || {}).flat();
      const hasProjection = incomingNotes.some(note => note && note._lightweight);
      const existingById = new Map(h.getNotesIndex().map(entry => [entry.id, h.getNoteDetail(entry.id) || entry]));
      const byId = new Map();
      if (hasProjection) {
        for (const [noteId, existing] of existingById) byId.set(noteId, existing);
      }
      for (const rawNote of incomingNotes) {
        if (!rawNote || !rawNote.id) continue;
        const { _lightweight, ...note } = rawNote;
        const existing = existingById.get(note.id);
        // The incoming index may carry a newer title/topic, but never carries a body.
        byId.set(note.id, _lightweight && existing ? { ...existing, ...note } : note);
      }
      canonicalNotes = [...byId.values()];
      if (canonicalNotes.length > 0) h.writeNotes(canonicalNotes);
      if (!hasProjection) {
        const noteIds = new Set(canonicalNotes.map(note => note.id));
        for (const existing of h.getNotesIndex()) {
          if (!noteIds.has(existing.id)) h.deleteNote(existing.id);
        }
      }
      state.notes = canonicalNotes;
    }

    // 3. Write schedule days to hierarchy (per-day files)
    if (state.schedule && state.schedule.days) {
      if (state.schedule._lightweight) {
        const materializedDays = {};
        for (const date of Object.keys(h.getScheduleIndex())) materializedDays[date] = h.getDaySchedule(date);
        state.schedule = { ...state.schedule, days: materializedDays };
        delete state.schedule._lightweight;
      }
      for (const [date, dayData] of Object.entries(state.schedule.days)) {
        // Skip index-only entries (lightweight)
        if (dayData && !dayData.tasks && !dayData.errands && !dayData.dayNotes) continue;
        h.writeDaySchedule(date, dayData);
      }
      const desiredDays = new Set(Object.keys(state.schedule.days));
      for (const existingDate of Object.keys(h.getScheduleIndex())) {
        if (!desiredDays.has(existingDate)) h.deleteDaySchedule(existingDate);
      }
    }

    // 4. Write small documents (errands, review queue, reminders, userProfile)
    const smallDocs = ['errands', 'settingsConflicts', 'reminders', 'userProfile'];
    for (const docType of smallDocs) {
      const docData = { meta: { lastUpdated: now, documentType: docType } };
      for (const key of (DOCUMENT_KEYS[docType] || [])) {
        if (state[key] !== undefined) docData[key] = state[key];
      }
      const hasData = DOCUMENT_KEYS[docType]?.some(key => state[key] !== undefined);
      if (!hasData) continue;
      try {
        const existing = JSON.parse(fs.readFileSync(DOCUMENT_FILES[docType], 'utf-8'));
        if (existing.meta) docData.meta = { ...existing.meta, ...docData.meta };
      } catch {}
      writeJsonAtomic(DOCUMENT_FILES[docType], docData);
      updateIndexTimestamp(docType);
    }

    // 5. Write state.json with full data as fallback (for Electron/Dashboard compatibility)
    // Also write the legacy flat files (goals.json, notes.json, schedule.json) for
    // Dashboard backward compatibility during the migration period.
    state.meta = state.meta || {};
    state.meta.lastUpdated = now;
    // State version: monotonically incrementing counter for stale-data detection (P0-9.2)
    state.meta.stateVersion = (state.meta.stateVersion || 0) + 1;
    state._hierarchyEnabled = true;
    writeJsonAtomic(STATE_FILE, state);

    // 6. Write legacy flat files for Dashboard backward compatibility
    try {
      const flatGoals = {
        meta: { lastUpdated: now, documentType: 'goals' },
        strategicGoals: state.strategicGoals || [],
        currentGoals: state.currentGoals || [],
        constraints: state.constraints || [],
      };
      writeJsonAtomic(DOCUMENT_FILES.goals, flatGoals);
    } catch {}
    try {
      const flatSchedule = {
        meta: { lastUpdated: now, documentType: 'schedule' },
        schedule: state.schedule || { days: {} },
        morningBriefing: state.morningBriefing || null,
        conflicts: state.conflicts || [],
        briefings: state.briefings || [],
      };
      writeJsonAtomic(DOCUMENT_FILES.schedule, flatSchedule);
    } catch {}
    try {
      const flatNotes = {
        meta: { lastUpdated: now, documentType: 'notes' },
        notes: canonicalNotes || (Array.isArray(state.notes) ? state.notes : []),
      };
      writeJsonAtomic(DOCUMENT_FILES.notes, flatNotes);
    } catch {}

    return state;
  });
  // P0-2.2: Emit write notification after the lock is released and persistence
  // is complete. Listener errors are swallowed so they never break the write path.
  try {
    _writeEmitter.emit('write', _detectChangedDocs(state));
  } catch (e) {
    // Listener errors must not affect the write path
  }
  return result;
}

// Read full state from hierarchy (reconstructs the complete state shape).
// Used by Electron and Dashboard — they need full task lists, note content, etc.,
// not just lightweight indexes.
// This is the unified read path for all three ends (MCP, Dashboard, Electron).
//
// Task 3.1: Uses an mtime-based read cache. On each call, we check the mtimes of
// ~10 sentinel files (index files + small docs). If none have changed since the
// last read, we return a deep copy of the cached state — avoiding potentially
// dozens of file reads and JSON parses per request. The cache is also invalidated
// immediately by the write emitter, so data consistency is preserved.
function readFullState() {
  // Fast path: return cached state if no sentinel files have changed
  if (!_isCacheStale()) {
    // Return a deep copy so callers can mutate the state without corrupting the cache
    return JSON.parse(JSON.stringify(_fullStateCache.state));
  }

  // Slow path: full read from hierarchy + flat files
  const h = _getHierarchyInstance();

  // Auto-migrate from legacy flat files if needed (one-time)
  if (h.needsMigration()) {
    const legacyState = _readLegacyFlatState();
    if (legacyState) {
      h.migrateFromLegacy(legacyState);
    }
  }
  repairArchivedNoteDetails(h);

  const base = {};

  // Read small documents (errands, review queue, reminders, userProfile)
  const smallDocs = ['errands', 'settingsConflicts', 'reminders', 'userProfile'];
  for (const docType of smallDocs) {
    try {
      const filePath = _paths().DOCUMENT_FILES[docType];
      if (!filePath) continue;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const key of (DOCUMENT_KEYS[docType] || [])) {
        if (data[key] !== undefined) base[key] = data[key];
      }
    } catch {}
  }

  // Read meta from state.json (theme/lang/windowBounds)
  try {
    const st = JSON.parse(fs.readFileSync(_paths().STATE_FILE, 'utf-8'));
    if (st && st.meta) base.meta = { ...st.meta };
  } catch {}

  // Reconstruct full goals from hierarchy (index + detail files)
  const goalsIdx = h.getGoalsIndex();
  const strategicGoals = [];
  const currentGoals = [];
  const constraints = [];
  for (const gEntry of goalsIdx) {
    const full = h.getGoalDetail(gEntry.id) || gEntry;
    if (full.type === 'strategic' || full.kind === 'strategic') {
      strategicGoals.push(full);
    } else if (full.type === 'constraint' || full.kind === 'constraint') {
      constraints.push(full);
    } else {
      currentGoals.push(full);
    }
  }
  base.strategicGoals = strategicGoals;
  base.currentGoals = currentGoals;
  base.constraints = constraints;

  // The hierarchy is the canonical note store: its index contains summaries only, while
  // each detail file contains the body. This preserves access to notes after a topic is
  // promoted out of the legacy flat file and keeps deletion consistent via writeState().
  base.notes = h.getNotesIndex()
    .map(entry => h.getNoteDetail(entry.id) || null)
    .filter(Boolean);

  // Reconstruct full schedule from hierarchy (per-day files)
  const scheduleIdx = h.getScheduleIndex();
  const days = {};
  for (const date of Object.keys(scheduleIdx)) {
    days[date] = h.getDaySchedule(date);
  }
  base.schedule = base.schedule || {};
  base.schedule.days = days;

  // Reload schedule-level meta (conflicts / morningBriefing / briefings) from the flat
  // schedule doc — these are NOT stored in the per-day hierarchy files.
  const schedMeta = _readScheduleMeta();
  base.conflicts = schedMeta.conflicts;
  base.morningBriefing = schedMeta.morningBriefing;
  base.briefings = schedMeta.briefings;

  base._hierarchyEnabled = true;
  base.meta = base.meta || {};
  base.meta.lastUpdated = new Date().toISOString();

  // Populate the cache with the fresh state and current mtimes
  _fullStateCache = {
    state: base,
    mtimes: _snapshotMtimes(),
  };

  // Return a deep copy so callers can mutate without corrupting the cache
  return JSON.parse(JSON.stringify(base));
}

// Sync state.json from flat files (primary source of truth for brain-index.js).
// brain-index.js writes directly to flat files (notes.json/goals.json/etc.),
// so syncStateJson must read from flat files — NOT from hierarchy — to avoid
// overwriting fresh flat-file edits with stale hierarchy data.
function syncStateJson() {
  const { STATE_FILE } = _paths();
  try {
    const state = _readLegacyFlatState();
    if (!state) return false;
    state.meta = state.meta || {};
    state.meta.lastUpdated = new Date().toISOString();
    writeJsonAtomic(STATE_FILE, state);
    // Task 3.1: Invalidate cache since we wrote to state.json directly
    invalidateCache();
    return true;
  } catch {
    return false;
  }
}

// Sync hierarchy files from flat files.
// Called after brain-index.js modifies flat files directly (e.g. cascadeDelete),
// ensuring Storage.readFullState() sees the latest data.
function syncHierarchyFromFlatFiles() {
  return withLock('storage', () => {
    const state = _readLegacyFlatState();
    if (!state) return false;
    const h = _getHierarchyInstance();

    // Write goals to hierarchy
    if (state.currentGoals || state.strategicGoals || state.constraints) {
      const allGoals = [
        ...(state.strategicGoals || []).map(g => ({ ...g, type: 'strategic' })),
        ...(state.currentGoals || []).map(g => ({ ...g, type: 'current' })),
        ...(state.constraints || []).map(g => ({ ...g, type: 'constraint' })),
      ].filter(g => g && g.id);
      if (allGoals.length > 0) h.writeGoals(allGoals);
      // Clean up hierarchy: remove goals that are no longer in the state
      const existingIdx = h.getGoalsIndex();
      for (const existing of existingIdx) {
        if (!allGoals.some(g => g.id === existing.id)) {
          h.deleteGoal(existing.id);
        }
      }
    }

    // Write notes to hierarchy. Index-only legacy data must never delete a body
    // that was already recovered in the canonical detail store.
    if (state.notes) {
      const allNotes = Array.isArray(state.notes)
        ? state.notes
        : Object.values(state.notes || {}).flat();
      const hasProjection = allNotes.some(note => note && note._lightweight);
      const filtered = allNotes.filter(n => n && n.id && !n._lightweight);
      if (filtered.length > 0) h.writeNotes(filtered);
      if (!hasProjection) {
        const noteIds = new Set(filtered.map(n => n.id));
        for (const existing of h.getNotesIndex()) {
          if (!noteIds.has(existing.id)) h.deleteNote(existing.id);
        }
      }
    }

    // Write schedule days to hierarchy
    if (state.schedule && state.schedule.days) {
      for (const [date, dayData] of Object.entries(state.schedule.days)) {
        if (dayData && !dayData.tasks && !dayData.errands && !dayData.dayNotes) continue;
        h.writeDaySchedule(date, dayData);
      }
      const desiredDays = new Set(Object.keys(state.schedule.days));
      for (const existingDate of Object.keys(h.getScheduleIndex())) {
        if (!desiredDays.has(existingDate)) h.deleteDaySchedule(existingDate);
      }
    }

    return true;
  });
  // Task 3.1: Invalidate cache since hierarchy files were modified directly
  invalidateCache();
}

// Lightweight state: returns goal/note/schedule INDEXES instead of full content.
// This is the DEFAULT state — saves tokens by not loading full goal descriptions,
// aiReasoning, note content, or all schedule days.
// Use getGoalDetail(id) / getNoteDetail(id) / getDaySchedule(date) for full content on demand.
function readLightweightState() {
  const h = _getHierarchyInstance();

  // Auto-migrate from legacy flat files if needed (one-time)
  if (h.needsMigration()) {
    const legacyState = _readLegacyFlatState();
    if (legacyState) {
      h.migrateFromLegacy(legacyState);
    }
  }
  repairArchivedNoteDetails(h);

  // Read non-goal/note/schedule fields from small documents
  const base = {};
  const smallDocs = ['errands', 'settingsConflicts', 'reminders', 'userProfile'];
  for (const docType of smallDocs) {
    try {
      const filePath = _paths().DOCUMENT_FILES[docType];
      if (!filePath) continue;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const key of (DOCUMENT_KEYS[docType] || [])) {
        if (data[key] !== undefined) base[key] = data[key];
      }
    } catch {}
  }

  // Read meta from state.json (theme/lang/windowBounds)
  try {
    const st = JSON.parse(fs.readFileSync(_paths().STATE_FILE, 'utf-8'));
    if (st && st.meta) base.meta = { ...st.meta };
  } catch {}

  // Goal index (lightweight: id, title, deadline, priority, completed, topicId, domain)
  const goalsIndex = h.getGoalsIndex();
  base.strategicGoals = goalsIndex.filter(g => g.type === 'strategic' || g.kind === 'strategic').map(goal => ({ ...goal, _lightweight: true }));
  base.currentGoals = goalsIndex.filter(g => !g.type || (g.type !== 'strategic' && g.type !== 'constraint')).map(goal => ({ ...goal, _lightweight: true }));
  base.constraints = goalsIndex.filter(g => g.type === 'constraint' || g.kind === 'constraint').map(goal => ({ ...goal, _lightweight: true }));

  // Note index (lightweight: AI-authored title + classification — NO full content)
  base.notes = [];
  const notesIndex = h.getNotesIndex();
  for (const n of notesIndex) {
    base.notes.push({
      id: n.id,
      title: n.title || '待 AI 归纳',
      category: n.category || null,
      topicId: n.topicId || null,
      domain: n.domain || 'misc',
      createdAt: n.createdAt,
      relatedDate: n.relatedDate || null,
      needsEnrichment: n.needsEnrichment === true,
      _lightweight: true,
    });
  }

  // Schedule index (lightweight: which days exist, NOT full task lists)
  const scheduleIndex = h.getScheduleIndex();
  base.schedule = base.schedule || {};
  base.schedule.days = scheduleIndex;
  base.schedule._lightweight = true;

  // Reload schedule-level meta (conflicts / morningBriefing / briefings) from the flat
  // schedule doc — these are NOT stored in the per-day hierarchy files.
  const schedMeta = _readScheduleMeta();
  base.conflicts = schedMeta.conflicts;
  base.morningBriefing = schedMeta.morningBriefing;
  base.briefings = schedMeta.briefings;

  // userProfile.valueSystem is already loaded above.

  base._hierarchyEnabled = true;
  base.meta = base.meta || {};
  base.meta.lastUpdated = new Date().toISOString();
  return base;
}

// Read legacy flat files (one-time migration use only)
function _readLegacyFlatState() {
  const { DOCUMENT_FILES, STATE_FILE } = _paths();
  try {
    const merged = {};
    for (const [docType, filePath] of Object.entries(DOCUMENT_FILES)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        for (const key of (DOCUMENT_KEYS[docType] || [])) {
          if (data[key] !== undefined) merged[key] = data[key];
        }
      } catch {}
    }
    let st = null;
    try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch {}
    if (st) {
      for (const [docType, keys] of Object.entries(DOCUMENT_KEYS)) {
        for (const key of keys) {
          if (st[key] !== undefined && merged[key] === undefined) merged[key] = st[key];
        }
      }
      if (st.meta) merged.meta = { ...st.meta };
    }
    return Object.keys(merged).length > 0 ? merged : null;
  } catch {
    return null;
  }
}

// Read schedule-level meta fields (conflicts / morningBriefing / briefings) from the
// flat schedule.json. These live at the TOP LEVEL of the flat schedule doc (not inside
// schedule.days), so the per-day hierarchy files do NOT carry them. Without this, the
// read path would never reload them and the conflict panel / morning briefing would be
// permanently empty after a write (was defect #3).
function _readScheduleMeta() {
  try {
    const data = JSON.parse(fs.readFileSync(_paths().DOCUMENT_FILES.schedule, 'utf-8'));
    return {
      conflicts: data.conflicts !== undefined ? data.conflicts : [],
      morningBriefing: data.morningBriefing !== undefined ? data.morningBriefing : null,
      briefings: data.briefings !== undefined ? data.briefings : {},
    };
  } catch {
    return { conflicts: [], morningBriefing: null, briefings: {} };
  }
}

// Get full goal detail from the hierarchy (on-demand loading)
function getGoalDetail(goalId) {
  const h = _getHierarchyInstance();
  return h.getGoalDetail(goalId);
}

// Get full note detail from the hierarchy (on-demand loading)
function getNoteDetail(noteId) {
  const h = _getHierarchyInstance();
  return h.getNoteDetail(noteId);
}

// Get a specific day's schedule (on-demand loading, auto-creates empty day)
function getDaySchedule(date) {
  const h = _getHierarchyInstance();
  return h.getDaySchedule(date);
}

// Get days in a range (for weekly view)
function getDaysInRange(startDate, endDate) {
  const h = _getHierarchyInstance();
  return h.getDaysInRange(startDate, endDate);
}

// Write a goal to hierarchy (index + detail file)
function writeGoalToHierarchy(goal) {
  const h = _getHierarchyInstance();
  return h.writeGoal(goal);
}

// Write a note to hierarchy (index + detail file)
function writeNoteToHierarchy(note) {
  const h = _getHierarchyInstance();
  return h.writeNote(note);
}

// Write a day's schedule to hierarchy (per-day file + index)
function writeDaySchedule(date, dayData) {
  const h = _getHierarchyInstance();
  return h.writeDaySchedule(date, dayData);
}

// Add an item to a specific day (without loading full schedule)
function addItemToDay(date, type, item) {
  const h = _getHierarchyInstance();
  return h.addItemToDay(date, type, item);
}

module.exports = {
  DOCUMENT_KEYS,
  writeJsonAtomic,
  setDataDir,
  readDocument,
  writeDocument,
  updateIndexTimestamp,
  readState,
  readLightweightState,
  readFullState,
  writeState,
  syncStateJson,
  syncHierarchyFromFlatFiles,
  // P0-2.2: Write-after-sync notification (EventEmitter-based)
  onWrite,
  // Task 3.1: Read cache invalidation (for external callers that modify files directly)
  invalidateCache,
  // Hierarchy functions (lazy-loading)
  getGoalDetail,
  getNoteDetail,
  getDaySchedule,
  getDaysInRange,
  writeGoalToHierarchy,
  writeNoteToHierarchy,
  writeDaySchedule,
  addItemToDay,
  // Lock management (for cross-process coordination)
  acquireLock,
  acquireLockBlocking,
  releaseLock,
  isLockedByOther,
  withLock,
};
