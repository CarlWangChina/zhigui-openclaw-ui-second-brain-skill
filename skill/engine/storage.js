/**
 * ZhiGui - Shared persistence and projection layer
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
const DateUtils = require('./date-utils');

// Deep clone helper: uses structuredClone (Node.js 17+) when available,
// falls back to JSON round-trip for older runtimes.
const _deepClone = typeof structuredClone === 'function'
  ? (obj) => structuredClone(obj)
  : (obj) => JSON.parse(JSON.stringify(obj));

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
  if (state.decisions !== undefined) docs.push('decisions');
  if (state.events !== undefined) docs.push('activity');
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
  recoverAtomicBackups(dir);
  // Task 3.1: Invalidate cache and hierarchy instance when data directory changes
  _fullStateCache = null;
  _hierarchyInstance = null;
  recoverPendingStateTransaction(dir);
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
    DOCUMENT_FILES.reminders,
    DOCUMENT_FILES.userProfile,
    DOCUMENT_FILES.schedule,  // schedule-level meta (conflicts, briefings)
    DOCUMENT_FILES.decisions,
    DOCUMENT_FILES.activity,
    DOCUMENT_FILES.goals,     // flat projection — brain-index reads from this
    DOCUMENT_FILES.notes,     // flat projection — brain-index reads from this
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
  // PERF #28: Short-circuit — within the check window, assume cache is valid
  // to avoid repeated statSync calls in hot read paths.
  for (const filePath of _getSentinelFiles()) {
    if (_getFileMtime(filePath) !== _fullStateCache.mtimes.get(filePath)) {
      return true;
    }
  }
  // Cache is still valid — extend the short window
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
  // PERF #28: Reset the short-window cache so the next read re-checks mtimes.
}

// Register cache invalidation on every successful write (P0-2.2 emitter).
// This ensures the cache is busted immediately after writeState, without
// waiting for the next mtime check.
onWrite(() => { invalidateCache(); });

// Recover documents left in the safe backup position by a Windows replacement
// fallback. A backup is only used when the target is missing; otherwise it is a
// completed-write residue and can be removed.
function recoverAtomicBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const visit = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.backup')) {
        const target = fullPath.slice(0, -'.backup'.length);
        try {
          if (!fs.existsSync(target)) fs.renameSync(fullPath, target);
          else fs.unlinkSync(fullPath);
        } catch {}
      }
    }
  };
  visit(dir);
}

// Write JSON through a sibling temporary file and atomically replace the target.
// When Windows refuses a direct replacement, move the old complete file to a
// recoverable backup before installing the new one. This avoids a delete/rename
// gap that could otherwise lose the only copy during a crash.
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  recoverAtomicBackups(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    const backupPath = `${filePath}.backup`;
    try {
      try { fs.unlinkSync(backupPath); } catch {}
      if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath);
      fs.renameSync(tempPath, filePath);
      try { fs.unlinkSync(backupPath); } catch {}
    } catch (fallbackError) {
      // Best-effort immediate restoration. If the process dies before this
      // runs, setDataDir() restores the .backup on the next launch.
      try {
        if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, filePath);
      } catch {}
      try { fs.unlinkSync(tempPath); } catch {}
      throw fallbackError;
    }
  }
}

// ===== Cross-process file lock (solves A, C: concurrent write race conditions) =====
// Uses a lock file on disk. Lock auto-expires after LOCK_TIMEOUT_MS to handle crashes.
const LOCK_TIMEOUT_MS = 30000;  // lock expires after 30 seconds (allows for large writes)
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
  if (!lockFile) return false;
  const now = Date.now();
  const lockData = {
    pid: process.pid,
    process: processName,
    acquiredAt: new Date().toISOString(),
    expiresAt: now + LOCK_TIMEOUT_MS,
  };
  try {
    // Atomically create the lock file (O_EXCL). If it exists, this fails.
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify(lockData, null, 2), 'utf8');
    fs.closeSync(fd);
    return true;
  } catch (err) {
    // Lock file exists — check if it's expired
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const expiresAt = existing.expiresAt || 0;
      const isOwnLock = existing.pid === process.pid;
      // Before taking over an "expired" lock, verify the holding process is
      // actually dead. A live process that is doing a large write should not
      // have its lock stolen just because it exceeded the timeout.
      const isHolderDead = () => {
        if (!existing.pid || isOwnLock) return true;
        try { process.kill(existing.pid, 0); return false; }
        catch { return true; } // ESRCH — process does not exist
      };
      if (isOwnLock || (now >= expiresAt && isHolderDead())) {
        // Lock expired or we already own it — take over atomically
        // Use unlink + openSync(wx) to avoid race with another process
        try { fs.unlinkSync(lockFile); } catch {}
        try {
          const fd = fs.openSync(lockFile, 'wx');
          fs.writeFileSync(fd, JSON.stringify(lockData, null, 2), 'utf8');
          fs.closeSync(fd);
          return true;
        } catch { return false; }
      }
    } catch {}
    return false;
  }
}

// Acquire lock with retry (blocks until acquired or timeout)
function acquireLockBlocking(processName) {
  for (let i = 0; i < LOCK_RETRY_MAX; i++) {
    if (acquireLock(processName)) return true;
    // Sleep synchronously without 100% CPU spin.
    // Atomics.wait is the lightest synchronous sleep in Node.js.
    const start = Date.now();
    const sharedBuf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sharedBuf, 0, 0, LOCK_RETRY_MS);
    // Fallback if Atomics.wait unavailable (older Node)
    if (Date.now() - start < LOCK_RETRY_MS) {
      while (Date.now() - start < LOCK_RETRY_MS) { /* fallback busy wait */ }
    }
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
      decisions: path.join(d, 'decisions.json'),
      activity: path.join(d, 'activity.json'),
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
      idx = { meta: { lastUpdated: new Date().toISOString(), description: 'ZhiGui document index - first-layer retrieval' }, documents: [] };
    }
    if (idx && idx.documents) {
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

// Activity is an episodic change journal, not a second source of entity truth.
// It lets the next AI conversation learn what the user changed from the panel
// without loading every schedule or note detail.
// Fingerprint for deduplication: same operation/kind on the same entity (or same
// set of related ids) within a short window is treated as one fact.
function activityFingerprint(e) {
  const rel = [
    ...(e.relatedNoteIds || []),
    ...(e.relatedGoalIds || []),
    ...(e.relatedErrandIds || []),
    ...(e.relatedTopicIds || []),
  ].sort().join(',');
  const entity = e.entityId || e.id || '';
  return `${e.operation || ''}|${e.kind || ''}|${entity}|${rel}`;
}

function appendActivity(event) {
  return withLock('activity', () => {
    const { DOCUMENT_FILES } = _paths();
    let data = { meta: {}, events: [] };
    try { data = JSON.parse(fs.readFileSync(DOCUMENT_FILES.activity, 'utf8')); } catch {}
    let events = Array.isArray(data.events) ? data.events : [];
    const newEvent = {
      id: event.id || `change_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: event.at || new Date().toISOString(),
      // Panel changes are facts first and need an assistant to interpret their
      // longer-term impact later.  AI-originated writes are already interpreted.
      reconciliationStatus: event.reconciliationStatus || 'pending',
      ...event,
    };
    events.push(newEvent);
    // Deduplicate: same fingerprint within 60s (double-click / retry) keeps one
    // record. Prefer a settled reconciliation status if either copy is settled so
    // we never lose an already-reconciled fact.
    const DEDUP_WINDOW_MS = 60 * 1000;
    const seen = new Map();
    const deduped = [];
    for (const ev of events) {
      const fp = activityFingerprint(ev);
      const idx = seen.get(fp);
      if (idx !== undefined) {
        const prev = deduped[idx];
        const dt = Math.abs(new Date(ev.at).getTime() - new Date(prev.at).getTime());
        if (dt <= DEDUP_WINDOW_MS) {
          if (prev.reconciliationStatus === 'pending' && ev.reconciliationStatus && ev.reconciliationStatus !== 'pending') {
            prev.reconciliationStatus = ev.reconciliationStatus;
            prev.reconciledAt = ev.reconciledAt;
          }
          continue;
        }
      }
      seen.set(fp, deduped.length);
      deduped.push(ev);
    }
    events = deduped;
    // Never compact away a pending fact. Settled history is bounded because it
    // is only audit evidence; current state remains in canonical entities.
    const pending = events.filter(item => ['pending', 'needs_user'].includes(item.reconciliationStatus));
    const settled = events.filter(item => !['pending', 'needs_user'].includes(item.reconciliationStatus)).slice(-300);
    // Pending facts are deliberately not capped: losing one would make a later
    // conversation invent continuity. Bootstrap pages them explicitly, while
    // settled audit history remains bounded. Keep the count as an operational
    // signal for the panel/assistant rather than pretending the journal is full.
    data = {
      meta: {
        ...(data.meta || {}),
        lastUpdated: new Date().toISOString(),
        documentType: 'activity',
        pendingCount: pending.length,
        backlogWarning: pending.length > 200,
      },
      events: [...pending, ...settled],
    };
    writeJsonAtomic(DOCUMENT_FILES.activity, data);
    updateIndexTimestamp('activity');
    return data.events[data.events.length - 1];
  });
}

function readPendingActivityPage({ limit = 20, offset = 0 } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(_paths().DOCUMENT_FILES.activity, 'utf8'));
    const pending = (Array.isArray(data.events) ? data.events : [])
      .filter(event => ['pending', 'needs_user'].includes(event.reconciliationStatus))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const items = pending.slice(safeOffset, safeOffset + safeLimit);
    const byOperation = {};
    for (const event of pending) byOperation[event.operation || 'unknown'] = (byOperation[event.operation || 'unknown'] || 0) + 1;
    return {
      items,
      total: pending.length,
      offset: safeOffset,
      limit: safeLimit,
      hasMore: safeOffset + items.length < pending.length,
      nextOffset: safeOffset + items.length < pending.length ? safeOffset + items.length : null,
      summary: {
        oldestAt: pending[pending.length - 1]?.at || null,
        newestAt: pending[0]?.at || null,
        byOperation,
      },
    };
  } catch {
    return { items: [], total: 0, offset: 0, limit: Math.max(1, Math.min(Number(limit) || 20, 100)), hasMore: false, nextOffset: null, summary: { oldestAt: null, newestAt: null, byOperation: {} } };
  }
}

// Compatibility helper for existing panel and test callers. New assistant
// reads should use readPendingActivityPage so no pending user fact is hidden.
function readPendingActivity({ limit = 20, offset = 0 } = {}) {
  return readPendingActivityPage({ limit, offset }).items;
}

function findPendingActivity(eventId) {
  if (!eventId) return null;
  try {
    const data = JSON.parse(fs.readFileSync(_paths().DOCUMENT_FILES.activity, 'utf8'));
    return (Array.isArray(data.events) ? data.events : [])
      .find(event => event.id === eventId && ['pending', 'needs_user'].includes(event.reconciliationStatus)) || null;
  } catch {
    return null;
  }
}

// Mark one event only after the canonical patches have been persisted.  The
// event id makes this operation idempotent across conversations.
function reconcileActivityEvent(eventId, patch = {}) {
  return withLock('activity', () => {
    const { DOCUMENT_FILES } = _paths();
    let data = { meta: {}, events: [] };
    try { data = JSON.parse(fs.readFileSync(DOCUMENT_FILES.activity, 'utf8')); } catch {}
    const event = (data.events || []).find(item => item.id === eventId);
    if (!event) return { found: false };
    if (!['pending', 'needs_user'].includes(event.reconciliationStatus)) {
      return { found: true, alreadyHandled: true, event };
    }
    Object.assign(event, patch, {
      reconciledAt: new Date().toISOString(),
    });
    const pendingCount = (data.events || []).filter(item => ['pending', 'needs_user'].includes(item.reconciliationStatus)).length;
    data.meta = {
      ...(data.meta || {}),
      lastUpdated: new Date().toISOString(),
      documentType: 'activity',
      pendingCount,
      backlogWarning: pendingCount > 200,
    };
    writeJsonAtomic(DOCUMENT_FILES.activity, data);
    updateIndexTimestamp('activity');
    return { found: true, event };
  });
}

function readRecentActivity({ sinceVersion = null, limit = 20 } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(_paths().DOCUMENT_FILES.activity, 'utf8'));
    let events = Array.isArray(data.events) ? data.events : [];
    if (Number.isFinite(Number(sinceVersion))) events = events.filter(event => Number(event.stateVersion || 0) > Number(sinceVersion));
    // Pending facts are stored ahead of settled audit history so compaction can
    // preserve them. Recent reads therefore must sort by the durable version /
    // timestamp rather than rely on file order.
    return [...events]
      .sort((a, b) => Number(b.stateVersion || 0) - Number(a.stateVersion || 0)
        || String(b.at || b.reconciledAt || '').localeCompare(String(a.at || a.reconciledAt || '')))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  } catch {
    return [];
  }
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
function writeState(state, { recovering = false } = {}) {
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
    const recoveryPath = _stateRecoveryPath();

    // This snapshot remains until every projection below is durable. If a
    // process stops mid-write, setDataDir() replays it before serving reads.
    if (!recovering || !fs.existsSync(recoveryPath)) {
      writeJsonAtomic(recoveryPath, {
        version: 1,
        createdAt: now,
        state,
      });
    }

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

    // 4. Write small canonical documents.  The activity journal is intentionally
    // excluded: it is append/reconcile-only and must never be overwritten by a
    // stale state snapshot during an unrelated entity write.
    const smallDocs = ['errands', 'decisions', 'reminders', 'userProfile'];
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
      } catch (e) { process.stderr.write(`[storage] writeState read existing doc error (${docType}): ${e.message}\n`); }
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

    // 6. Write compatibility projections. Do not swallow a failure here: the
    // recovery snapshot must remain so the next launch repairs every file.
    const flatGoals = {
      meta: { lastUpdated: now, documentType: 'goals' },
      strategicGoals: state.strategicGoals || [],
      currentGoals: state.currentGoals || [],
      constraints: state.constraints || [],
    };
    writeJsonAtomic(DOCUMENT_FILES.goals, flatGoals);
    // Briefings are today-only. If state.briefings is somehow an array legacy, coerce to object.
    const today = DateUtils.todayStr();
    const rawBriefings = state.briefings && typeof state.briefings === 'object' && !Array.isArray(state.briefings)
      ? state.briefings
      : {};
    const cleanedBriefings = {};
    for (const d of Object.keys(rawBriefings)) {
      if (d === today) cleanedBriefings[d] = rawBriefings[d];
    }
    const flatSchedule = {
      meta: { lastUpdated: now, documentType: 'schedule' },
      schedule: state.schedule || { days: {} },
      morningBriefing: cleanedBriefings[today] || state.morningBriefing || null,
      conflicts: state.conflicts || [],
      briefings: cleanedBriefings,
    };
    writeJsonAtomic(DOCUMENT_FILES.schedule, flatSchedule);
    const flatNotes = {
      meta: { lastUpdated: now, documentType: 'notes' },
      notes: canonicalNotes || (Array.isArray(state.notes) ? state.notes : []),
    };
    writeJsonAtomic(DOCUMENT_FILES.notes, flatNotes);

    // Only remove the durable replay record after every projection succeeds.
    fs.unlinkSync(recoveryPath);

    return state;
  });
  // P0-2.2: Emit write notification after the lock is released and persistence
  // is complete. Listener errors are swallowed so they never break the write path.
  try {
    _writeEmitter.emit('write', _detectChangedDocs(state));
  } catch (e) {
    // Listener errors must not affect the write path
    process.stderr.write(`[storage] onWrite listener error: ${e.message}\n`);
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
    return _deepClone(_fullStateCache.state);
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

  // Read small documents (errands, reminders, userProfile)
  const smallDocs = ['errands', 'decisions', 'activity', 'reminders', 'userProfile'];
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

  // Read state-only durable fields. These are not part of a split document,
  // so omitting one here makes it disappear on the next unrelated action.
  try {
    const st = JSON.parse(fs.readFileSync(_paths().STATE_FILE, 'utf-8'));
    if (st && st.meta) base.meta = { ...st.meta };
    for (const key of ['completedActions', 'lastReflection']) {
      if (st && st[key] !== undefined) base[key] = st[key];
    }
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
  // Populate the cache with the fresh state and current mtimes
  _fullStateCache = {
    state: base,
    mtimes: _snapshotMtimes(),
  };

  // Return a deep copy so callers can mutate without corrupting the cache
  return _deepClone(base);
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

// Sync hierarchy files from legacy flat-file imports. Canonical entity actions
// do not call this path; they write the hierarchy directly.
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

    // Invalidate cache after hierarchy sync so readFullState sees fresh data
    invalidateCache();
    return true;
  });
}

// Lightweight state: returns goal/note/schedule INDEXES instead of full content.
// This is the DEFAULT state — saves tokens by not loading full goal descriptions,
// goal detail, note content, or all schedule days.
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
  const smallDocs = ['errands', 'decisions', 'activity', 'reminders', 'userProfile'];
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

  // Goal index (lightweight: id, title, deadline, completed, topicId, domain)
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
      // These records have no split-document projection. A brain-index write
      // calls syncStateJson(), so they must be copied forward instead of being
      // silently erased by an unrelated topic/index update.
      for (const key of ['completedActions', 'lastReflection']) {
        if (st[key] !== undefined) merged[key] = st[key];
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
    const today = DateUtils.todayStr();
    const rawBriefings = data.briefings !== undefined ? data.briefings : {};
    const briefings = {};
    if (rawBriefings && typeof rawBriefings === 'object' && !Array.isArray(rawBriefings)) {
      for (const d of Object.keys(rawBriefings)) {
        if (d === today) briefings[d] = rawBriefings[d];
      }
    }
    return {
      conflicts: data.conflicts !== undefined ? data.conflicts : [],
      morningBriefing: briefings[today] !== undefined ? briefings[today] : (data.morningBriefing !== undefined ? data.morningBriefing : null),
      briefings,
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

// Patch a single goal's lifecycle fields in the flat goals.json projection.
// This keeps brain-index (which reads flat files) consistent with hierarchy
// detail writes without requiring a full writeState().
function _patchGoalInFlat(goalId, detail) {
  try {
    const { DOCUMENT_FILES } = _paths();
    const flat = JSON.parse(fs.readFileSync(DOCUMENT_FILES.goals, 'utf8'));
    for (const arr of [flat.strategicGoals, flat.currentGoals, flat.constraints]) {
      if (!Array.isArray(arr)) continue;
      const item = arr.find(g => g.id === goalId);
      if (item) {
        item.lastAccessedAt = detail.lastAccessedAt;
        item.lifecycleState = detail.lifecycleState || 'active';
        if (detail.lifecycleState === 'active') { delete item.staleSince; delete item.archivedAt; }
        break;
      }
    }
    writeJsonAtomic(DOCUMENT_FILES.goals, flat);
  } catch { /* flat file may not exist yet — next writeState will create it */ }
}

// Patch a single note's lifecycle fields in the flat notes.json projection.
function _patchNoteInFlat(noteId, detail) {
  try {
    const { DOCUMENT_FILES } = _paths();
    const flat = JSON.parse(fs.readFileSync(DOCUMENT_FILES.notes, 'utf8'));
    if (!Array.isArray(flat.notes)) return;
    const item = flat.notes.find(n => n.id === noteId);
    if (item) {
      item.lastAccessedAt = detail.lastAccessedAt;
      item.lifecycleState = detail.lifecycleState || 'active';
      if (detail.lifecycleState === 'active') { delete item.staleSince; delete item.archivedAt; }
      writeJsonAtomic(DOCUMENT_FILES.notes, flat);
    }
  } catch { /* flat file may not exist yet — next writeState will create it */ }
}

// P6-6.9: Update goal's lastAccessedAt timestamp (memory freshness tracking).
// Only rewrites the detail file — does NOT touch the index.
// Also patches the flat projection so brain-index reads stay consistent.
function touchGoalLastAccessed(goalId) {
  const h = _getHierarchyInstance();
  if (!h) return false;
  const detail = h.getGoalDetail(goalId);
  if (!detail) return false;
  detail.lastAccessedAt = new Date().toISOString();
  // Referencing a stale entity is evidence that it is useful again.  Do not
  // let an old staleSince timestamp silently archive it later.
  if (detail.lifecycleState === 'stale') {
    detail.lifecycleState = 'active';
    delete detail.staleSince;
    delete detail.archivedAt;
  }
  h.writeGoal(detail);
  _patchGoalInFlat(goalId, detail);
  invalidateCache();
  return true;
}

// A state write touches several projections.  Individual JSON replacements are
// atomic, but a process interruption between projections previously left the
// next reader to combine old and new files.  Keep one durable source snapshot
// until every projection has been written; startup can replay it safely.
const STATE_RECOVERY_FILE = '.state-write-recovery.json';
function _stateRecoveryPath(dir = DATA_DIR) {
  return dir ? path.join(dir, STATE_RECOVERY_FILE) : null;
}

function recoverPendingStateTransaction(dir) {
  const recoveryPath = _stateRecoveryPath(dir);
  if (!recoveryPath || !fs.existsSync(recoveryPath)) return false;
  try {
    const record = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
    if (!record || typeof record.state !== 'object' || Array.isArray(record.state)) {
      throw new Error('recovery record does not contain a state object');
    }
    process.stderr.write('[storage] Replaying interrupted state write.\n');
    writeState(record.state, { recovering: true });
    return true;
  } catch (error) {
    // Do not delete a recovery record that could still preserve user data.
    process.stderr.write(`[storage] State recovery deferred: ${error.message}\n`);
    return false;
  }
}

// Same lifecycle-aware access update for notes.  This is deliberately a
// detail-store write rather than a full-state write so reading one note cannot
// clobber unrelated changes from another client.
// Also patches the flat projection so brain-index reads stay consistent.
function touchNoteLastAccessed(noteId) {
  const h = _getHierarchyInstance();
  if (!h) return false;
  const detail = h.getNoteDetail(noteId);
  if (!detail) return false;
  detail.lastAccessedAt = new Date().toISOString();
  if (detail.lifecycleState === 'stale') {
    detail.lifecycleState = 'active';
    delete detail.staleSince;
    delete detail.archivedAt;
  }
  h.writeNote(detail);
  _patchNoteInFlat(noteId, detail);
  invalidateCache();
  return true;
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
  appendActivity,
  readRecentActivity,
  readPendingActivity,
  readPendingActivityPage,
  findPendingActivity,
  reconcileActivityEvent,
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
  // P6-6.9: Goal memory freshness tracking
  touchGoalLastAccessed,
  touchNoteLastAccessed,
  // Lock management (for cross-process coordination)
  isLockedByOther,
  withLock,
};
