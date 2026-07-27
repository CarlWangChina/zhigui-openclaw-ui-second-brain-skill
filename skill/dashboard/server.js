/**
 * ZhiGui · Decision & Planning Companion - Local Server
 * Zero dependencies, uses only Node.js built-in modules
 * Features: Static file serving + JSON API + SSE real-time push
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// P0-7.1 / P1-2.4: shared safety primitives — typed validation errors, tunable
// constants (SSE limits, body size, heartbeat interval), and structured logging.
const { ValidationError } = require('../engine/errors');
const constants = require('../engine/constants');
const logger = require('../engine/logger');
const Utils = require('../engine/utils');
const { genId, todayStr, normalizeTime, normalizeDate } = Utils;

const PORT = Number(process.env.ZHIGUI_PORT || 7788);
// Data directory is resolved by the shared config loader (shared with MCP engine / Electron),
// ensuring all three ends read/write the same .zhigui data; static assets are in ./public/.
const { loadConfig } = require('../lib/config');
const CONFIG = loadConfig();
const { ensureDataInitialized } = require('../lib/init-data');
ensureDataInitialized(CONFIG.dataDir);
const ZHIGUI_DIR = CONFIG.dataDir;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(ZHIGUI_DIR, 'state.json');
const HISTORY_FILE = path.join(ZHIGUI_DIR, 'history.json');
const INDEX_FILE = path.join(ZHIGUI_DIR, 'documents.json');

const { BrainIndex } = require('../engine/brain-index');
const Storage = require('../engine/storage');
Storage.setDataDir(ZHIGUI_DIR);
const Actions = require('../engine/actions');
Actions.configure(ZHIGUI_DIR);
// Second Brain association index layer (for dashboard topic/cascade delete/association search)
let brainIndex = null;
function getBrainIndex() {
  if (!brainIndex) brainIndex = new BrainIndex(ZHIGUI_DIR);
  return brainIndex;
}

// Record manual UI operations to the audit stream — failure does not affect the state write path.
function recordManualToEvents(kind, summary, detail, meta) {}

// ─── Document Split — Two-layer Retrieval Architecture (HTTP server also supported) ────────────────────────────
const DOCUMENT_FILES = {
  goals: path.join(ZHIGUI_DIR, 'goals.json'),
  schedule: path.join(ZHIGUI_DIR, 'schedule.json'),
  errands: path.join(ZHIGUI_DIR, 'errands.json'),
  notes: path.join(ZHIGUI_DIR, 'notes.json'),
  reminders: path.join(ZHIGUI_DIR, 'reminders.json'),
  userProfile: path.join(ZHIGUI_DIR, 'userProfile.json'),
};

const DOCUMENT_KEYS = {
  goals: ['strategicGoals', 'currentGoals', 'constraints'],
  schedule: ['schedule', 'morningBriefing', 'conflicts', 'briefings'],
  errands: ['errands'],
  notes: ['notes'],
  userProfile: ['userProfile'],
};

// P0 FIX: Use unified Storage.readFullState() (hierarchy primary) instead of
// reading flat files directly. This ensures Dashboard sees the same data as AI and Electron.
function readMergedState() {
  return Storage.readFullState();
}

function buildDashboardState() {
  const state = readMergedState() || {};
  let topicIndex = [];
  try {
    topicIndex = getBrainIndex().getTopics().map(topic => ({ id: topic.id, label: topic.label }));
  } catch {}
  return { ...state, topicIndex };
}

// P0 FIX: Use unified Storage.writeState() which writes to hierarchy + flat files + state.json.
// This ensures Dashboard edits are visible to AI and Electron.
function writeMergedState(state) {
  return Storage.writeState(state);
}

// Update document index timestamp (first layer of two-layer retrieval)
function updateIndexTimestamp(docType) {
  try {
    const idx = readJson(INDEX_FILE);
    if (idx && idx.documents) {
      const doc = idx.documents.find(d => d.type === docType);
      if (doc) {
        doc.lastUpdated = new Date().toISOString();
        try { doc.size = fs.statSync(DOCUMENT_FILES[docType]).size; } catch {}
      }
      idx.meta.lastUpdated = new Date().toISOString();
      writeJson(INDEX_FILE, idx);
    }
  } catch {}
}

// Ensure document index exists, initialize if not
function ensureIndex() {
  const existing = readJson(INDEX_FILE);
  if (existing && existing.documents) {
    const filtered = existing.documents.filter(doc => doc.type !== 'decisions');
    if (filtered.length !== existing.documents.length) {
      existing.documents = filtered;
      existing.meta = existing.meta || {};
      existing.meta.lastUpdated = new Date().toISOString();
      writeJson(INDEX_FILE, existing);
    }
    return existing;
  }
  const idx = {
    meta: {
      version: '2.1.0',
      lastUpdated: new Date().toISOString(),
      description: 'ZhiGui Document Index — First Layer of Retrieval'
    },
    documents: [
      { type: 'goals', title: 'Goals and Constraints', description: 'Strategic goals, current goals, constraints', lastUpdated: new Date().toISOString(), size: 0 },
      { type: 'schedule', title: 'Schedule and Briefing', description: 'Schedule, daily briefing, conflict detection', lastUpdated: new Date().toISOString(), size: 0 },
      { type: 'errands', title: 'Errands', description: 'must/should/nice three-level errands', lastUpdated: new Date().toISOString(), size: 0 },
      { type: 'notes', title: 'Life Notes', description: 'AI-authored title index with on-demand details', lastUpdated: new Date().toISOString(), size: 0 },
      { type: 'reminders', title: 'Reminders', description: 'Scheduled time-point reminders and event-driven reminders', lastUpdated: new Date().toISOString(), size: 0 },
      { type: 'userProfile', title: 'User Profile', description: 'User profile, values, communication preferences', lastUpdated: new Date().toISOString(), size: 0 },
    ]
  };
  writeJson(INDEX_FILE, idx);
  return idx;
}

// SSE client list
const sseClients = [];

// P1-2.4: remove a disconnected/dead SSE client from the registry and close its
// response stream. Idempotent — safe to call multiple times for the same res.
function cleanupSSEClient(res) {
  const idx = sseClients.indexOf(res);
  if (idx > -1) sseClients.splice(idx, 1);
  try { res.end(); } catch { /* response already closed */ }
}

// P1-2.4: periodic heartbeat. A single shared timer pushes an SSE comment to every
// client every SSE_HEARTBEAT_INTERVAL_MS. This keeps proxies from dropping idle
// connections and lets us evict dead clients whose write throws.
const sseHeartbeatTimer = setInterval(() => {
  if (sseClients.length === 0) return;
  const beat = ':heartbeat\n\n';
  // Iterate over a snapshot so cleanupSSEClient (which mutates sseClients) cannot
  // disrupt the traversal or skip entries.
  for (const res of [...sseClients]) {
    try {
      res.write(beat);
    } catch {
      cleanupSSEClient(res);
    }
  }
}, constants.SSE_HEARTBEAT_INTERVAL_MS);
// Don't keep the process alive solely for the heartbeat timer.
if (sseHeartbeatTimer.unref) sseHeartbeatTimer.unref();

const SHARED_ACTION_ROUTES = {
  '/api/task/toggle': 'task.toggle',
  '/api/task/update': 'task.update',
  '/api/task/delete': 'task.delete',
  '/api/task/unlock': 'task.unlock',
  '/api/priority/update': 'priority.update',
  '/api/priority/unlock': 'priority.unlock',
  '/api/event/add': 'event.add',
  '/api/goal/add': 'goal.add',
  '/api/goal/complete': 'goal.complete',
  '/api/delete-goal': 'goal.delete',
  '/api/errand/add': 'errand.add',
  '/api/errand/complete': 'errand.complete',
  '/api/errand/update': 'errand.update',
  '/api/errand/delete': 'errand.delete',
  '/api/note/add': 'note.add',
  '/api/note/delete': 'note.delete',
  '/api/note/update': 'note.update',
  '/api/review/resolve': 'review.resolve',
  '/api/weights/update': 'weights.update',
  '/api/reminder/delete': 'reminder.delete',
  '/api/theme': 'theme.set',
  '/api/lang': 'lang.set',
};

async function handleSharedAction(req, res, action) {
  try {
    const payload = await parseBody(req);
    // P0-7.1: reject malformed/injectable input before it reaches the Actions engine.
    sanitizeSharedPayload(payload);
    const result = Actions.execute(action, payload);
    const timestamp = new Date().toISOString();
    pushSSE({ type: action === 'theme.set' ? 'theme_update' : 'state_update', theme: result.theme, timestamp });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    // ValidationError → 400 (bad input); everything else preserves the original status.
    const status = err instanceof ValidationError ? 400 : (err.status || 500);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message, code: err.code || 'ACTION_FAILED' }));
  }
}

// MIME type mapping
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

// Utility: read JSON file
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Utility: write JSON file
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Push message to all SSE clients
function pushSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  // Iterate over a snapshot so cleanupSSEClient (which mutates sseClients) cannot
  // disrupt the traversal or skip entries.
  for (const res of [...sseClients]) {
    try {
      res.write(msg);
    } catch (e) {
      // P1-2.4: client is dead — evict it instead of silently leaking the slot.
      cleanupSSEClient(res);
    }
  }
}

// Parse POST body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    // Security: cap request body at MAX_BODY_SIZE to prevent memory-exhaustion DoS
    const MAX_BODY = constants.MAX_BODY_SIZE;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Task 1.4: genId, todayStr, normalizeTime, normalizeDate moved to engine/utils.js

// P0-7.1: Generic input-validation helpers. IDs are interpolated into file lookups
// and inline onclick handlers, so they must be strictly alphanumeric+underscore.
// Free-text fields are capped to bound memory use and reject oversized payloads early.
// ID pattern: allows alphanumeric, underscore, dash (UUIDs), and dot (timestamp-based IDs).
// Rejects characters that could enable path traversal (< > / \) or injection (", ').
const ID_PATTERN = /^[a-zA-Z0-9_.\-]+$/;

// Validate an ID field. Must be a non-empty string matching ID_PATTERN.
// Throws ValidationError on invalid input; returns the validated string otherwise.
function validateId(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  if (!ID_PATTERN.test(value)) {
    throw new ValidationError(`${fieldName} contains invalid characters (allowed: a-z A-Z 0-9 _ - .)`);
  }
  return value;
}

// Validate a free-text field. null/undefined are normalized to '' (optional fields).
// Throws ValidationError if the value is not a string or its length is >= maxLength.
function validateText(value, fieldName, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  if (value.length >= maxLength) {
    throw new ValidationError(`${fieldName} is too long (max ${maxLength - 1} chars)`);
  }
  return value;
}

// P0-7.1: validate a required date field via the existing normalizeDate helper.
// Throws ValidationError when the date is missing or malformed.
function validateDate(value, fieldName) {
  const norm = normalizeDate(value);
  if (norm === null || norm === '') {
    throw new ValidationError(`${fieldName} must be a valid date (YYYY-MM-DD)`);
  }
  return norm;
}

// P0-7.1: validate an optional date field. Empty values are allowed; a non-empty
// but malformed value throws ValidationError.
function validateOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return '';
  const norm = normalizeDate(value);
  if (norm === null) {
    throw new ValidationError(`${fieldName} must be a valid date (YYYY-MM-DD)`);
  }
  return norm;
}

// P0-7.1: validate an optional time field via the existing normalizeTime helper.
function validateOptionalTime(value, fieldName) {
  if (value === undefined || value === null || value === '') return '';
  const norm = normalizeTime(value);
  if (norm === null) {
    throw new ValidationError(`${fieldName} must be a valid time (HH:MM)`);
  }
  return norm;
}

// P0-7.1: Generic payload sanitizer for the shared-action routes. Validates every
// known-sensitive field name (IDs, date, time, free text) so the Actions engine
// never receives malformed/injectable input, regardless of which action runs.
const SHARED_ID_FIELDS = ['id', 'taskId', 'goalId', 'noteId', 'topicId', 'errandId', 'reminderId'];
const SHARED_TEXT_FIELDS = {
  title: 10000, description: 10000, content: 10000, note: 10000,
  userMessage: 100000, aiResponse: 100000, theme: 100, lang: 20,
};

function sanitizeSharedPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  for (const f of SHARED_ID_FIELDS) {
    if (payload[f] !== undefined && payload[f] !== null && payload[f] !== '') {
      validateId(payload[f], f);
    }
  }
  validateOptionalDate(payload.date, 'date');
  validateOptionalTime(payload.time, 'time');
  for (const [f, maxLen] of Object.entries(SHARED_TEXT_FIELDS)) {
    if (payload[f] !== undefined && payload[f] !== null) {
      validateText(payload[f], f, maxLen);
    }
  }
  return payload;
}

// ===================== API Handlers =====================

// GET /api/state - Read state
function handleGetState(res) {
  const state = buildDashboardState();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(state));
}

// GET /api/history - Read history
function handleGetHistory(res) {
  const history = readJson(HISTORY_FILE) || { conversations: [] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(history));
}

// POST /api/state - Write complete state (used by Agent)
async function handlePostState(req, res) {
  const body = await parseBody(req);
  if (!body || typeof body !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid state data' }));
    return;
  }
  body.meta = body.meta || {};
  body.meta.lastUpdated = new Date().toISOString();
  writeMergedState(body);
  pushSSE({ type: 'state_update', timestamp: body.meta.lastUpdated });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

// POST /api/history - Append history record (used by Agent)
async function handlePostHistory(req, res) {
  const body = await parseBody(req);
  // P0-7.1: validate text fields
  validateText(body.userMessage, 'userMessage', 100000);
  validateText(body.aiResponse, 'aiResponse', 100000);
  const history = readJson(HISTORY_FILE) || { conversations: [], meta: {} };
  
  const entry = {
    id: genId('conv'),
    timestamp: new Date().toISOString(),
    userMessage: body.userMessage || '',
    aiResponse: body.aiResponse || '',
    extracted: body.extracted || {}
  };
  
  history.conversations = history.conversations || [];
  history.conversations.push(entry);
  history.meta = history.meta || {};
  history.meta.totalConversations = history.conversations.length;
  history.meta.lastConversation = entry.timestamp;
  
  writeJson(HISTORY_FILE, history);
  pushSSE({ type: 'history_update', timestamp: entry.timestamp });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, id: entry.id }));
}

// GET /api/documents - Get document index (first layer of two-layer retrieval)
function handleGetDocuments(res) {
  const idx = ensureIndex();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(idx));
}

// ── Second Brain · Association Index API ──

// GET /api/topics - Topic overview
function handleGetTopics(res) {
  try {
    const brain = getBrainIndex();
    const topics = brain.getTopics().filter(topic =>
      (topic.noteCount || 0) > 0 || (topic.relatedCounts?.goals || 0) > 0 || (topic.relatedCounts?.actionItems || 0) > 0
    );
    const unclassifiedNotes = (Storage.readFullState().notes || [])
      .filter(note => note.needsEnrichment === true || !note.topicId)
      .map(note => ({ id: note.id, title: note.title || '待 AI 整理', createdAt: note.createdAt || null, source: note.source || null }))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ topics, total: topics.length, unclassifiedNotes }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// GET /api/topic?topicId=xxx - Single topic precipitation document (read on demand, saves tokens)
function handleGetTopic(req, res, queryParams) {
  const topicId = queryParams.get('topicId');
  if (!topicId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing topicId' }));
    return;
  }
  // P0-7.1: validate id format
  validateId(topicId, 'topicId');
  try {
    const brain = getBrainIndex();
    const doc = brain.getTopicDocument(topicId);
    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Topic not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...doc, noteCount: (doc.notes || []).length }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// GET /api/associated?q=xxx - Association search (JOIN-like)
function handleSearchAssociated(req, res, queryParams) {
  const q = queryParams.get('q') || '';
  try {
    const brain = getBrainIndex();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(brain.findAssociated(q)));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// GET /api/search?q=xxx - Global fuzzy search
function handleGlobalSearch(req, res, queryParams) {
  const q = queryParams.get('q') || '';
  try {
    const brain = getBrainIndex();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(brain.search(q)));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// POST /api/topic/delete - Cascade delete topic and its associations
async function handleDeleteTopic(req, res) {
  const { topicId, confirm } = await parseBody(req);
  if (!topicId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing topicId' }));
    return;
  }
  // P0-7.1: validate id format
  validateId(topicId, 'topicId');
  if (confirm !== true) {
    try {
      const brain = getBrainIndex();
      // Return the FULL cascade manifest (what WILL be deleted) so the panel can render a
      // confirmation checklist. Shape matches dashboard's preview.counts / preview.manifest.
      const dry = brain.cascadeDelete(topicId, { dryRun: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dry));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  try {
    const brain = getBrainIndex();
    const result = brain.cascadeDelete(topicId);
    pushSSE({ type: 'topics_update', timestamp: new Date().toISOString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// GET /api/document?type=xxx - Get single document content (second layer of two-layer retrieval)
function handleGetDocument(req, res, queryParams) {
  const docType = queryParams.get('type');
  if (!docType || !DOCUMENT_FILES[docType]) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or missing type parameter' }));
    return;
  }
  const data = readJson(DOCUMENT_FILES[docType]);
  if (!data) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Document not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// GET /api/event-stream?limit=10 — Get recent event stream
// GET /api/pending-follows — Get pending follow-up events
// GET /api/summary?days=14 — Get comprehensive summary
// SSE: GET /api/events
function handleSSE(req, res) {
  // P1-2.4: enforce a hard cap on concurrent SSE connections to prevent resource
  // exhaustion. Reject new connections with 503 once the limit is reached.
  if (sseClients.length >= constants.MAX_SSE_CLIENTS) {
    logger.warn('sse', 'SSE connection rejected — client limit reached', { clients: sseClients.length, limit: constants.MAX_SSE_CLIENTS });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many SSE connections', code: 'SSE_LIMIT_REACHED' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  
  sseClients.push(res);
  
  // P1-2.4: evict this client the moment the underlying request closes so the slot
  // is reclaimed even if no write error is ever observed.
  req.on('close', () => {
    cleanupSSEClient(res);
  });
}

// Static file serving
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  
  // Security: prevent directory traversal — use path.resolve to fully normalize,
  // then verify the resolved path is strictly under PUBLIC_DIR (with separator boundary
  // to prevent prefix-suffix bypasses like /publicevil/ → /public + evil/)
  const resolvedPublic = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(resolvedPublic, '.' + urlPath);
  if (!filePath.startsWith(resolvedPublic + path.sep) && filePath !== resolvedPublic) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 - File Not Found</h1>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    };
    // Security: CSP for HTML responses — blocks inline scripts from untrusted sources
    if (ext === '.html') {
      headers['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com;";
      headers['X-Content-Type-Options'] = 'nosniff';
      headers['X-Frame-Options'] = 'DENY';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ===================== Main Server =====================

const server = http.createServer(async (req, res) => {
  // Security: restrict CORS to localhost origins only — prevents any external
  // website from making cross-origin requests to the local dashboard API
  const origin = req.headers.origin || '';
  if (origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}` ||
      origin.startsWith('file://') || origin.startsWith('app://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // CSRF protection: block cross-origin WRITE requests (same-origin only).
  // The browser sends an Origin header on cross-origin requests; the dashboard itself
  // (served from http://localhost:7788) and the Electron shell (file:// / app://) are allowed.
  // Requests with NO Origin (curl, local Electron fetch, server-to-server) are also allowed.
  // A foreign Origin is rejected — this stops a malicious website from silently wiping state.
  if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT') {
    const writeOrigin = req.headers.origin;
    const ALLOWED_WRITE_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    const allowed = !writeOrigin ||
      ALLOWED_WRITE_ORIGINS.includes(writeOrigin) ||
      writeOrigin.startsWith('file://') ||
      writeOrigin.startsWith('app://');
    if (!allowed) {
      console.warn(`[CSRF] Blocked cross-origin write from origin: ${writeOrigin} -> ${req.url}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cross-origin write blocked (CSRF protection)' }));
      return;
    }
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  
  try {
    const sharedAction = req.method === 'POST' ? SHARED_ACTION_ROUTES[pathname] : null;
    if (sharedAction) {
      await handleSharedAction(req, res, sharedAction);
      return;
    }
    // API routes
    if (pathname === '/api/state' && req.method === 'GET') {
      handleGetState(res);
    } else if (pathname === '/api/state' && req.method === 'POST') {
      await handlePostState(req, res);
    } else if (pathname === '/api/history' && req.method === 'GET') {
      handleGetHistory(res);
    } else if (pathname === '/api/history' && req.method === 'POST') {
      await handlePostHistory(req, res);
    } else if (pathname === '/api/documents' && req.method === 'GET') {
      handleGetDocuments(res);
    } else if (pathname === '/api/document' && req.method === 'GET') {
      handleGetDocument(req, res, url.searchParams);
    } else if (pathname === '/api/topics' && req.method === 'GET') {
      handleGetTopics(res);
    } else if (pathname === '/api/topic' && req.method === 'GET') {
      handleGetTopic(req, res, url.searchParams);
    } else if (pathname === '/api/associated' && req.method === 'GET') {
      handleSearchAssociated(req, res, url.searchParams);
    } else if (pathname === '/api/search' && req.method === 'GET') {
      handleGlobalSearch(req, res, url.searchParams);
    } else if (pathname === '/api/topic/delete' && req.method === 'POST') {
      await handleDeleteTopic(req, res);
    } else if (pathname === '/api/events') {
      handleSSE(req, res);
    } else if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), clients: sseClients.length }));
    } else {
      serveStatic(req, res);
    }
  } catch (e) {
    // P0-7.1: ValidationError is a client-input problem → 400, not a 500 server fault.
    if (e instanceof ValidationError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message, code: e.code }));
      return;
    }
    console.error('Request handling error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Watch file changes, push via SSE
let watchDebounce = null;
function setupFileWatcher() {
  try {
    fs.watch(ZHIGUI_DIR, { persistent: false }, (event, filename) => {
      if (!filename) return;
      // Detect lock file changes — push lock state to dashboard
      if (filename === '.write-lock') {
        const lockState = Storage.isLockedByOther();
        if (lockState.locked) {
          pushSSE({ type: 'lock_acquired', by: lockState.by, timestamp: new Date().toISOString() });
        } else {
          pushSSE({ type: 'lock_released', timestamp: new Date().toISOString() });
        }
        return;
      }
      // Debounce: multiple changes within 100ms only push once
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        pushSSE({ type: 'file_change', filename, timestamp: new Date().toISOString() });
      }, 100);
    });
    console.log('  File watcher started (SSE real-time push + lock monitoring ready)');
  } catch (e) {
    console.warn('  File watcher failed to start:', e.message);
  }
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║     ZhiGui · AI Schedule Dashboard    ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Health:     http://localhost:${PORT}/api/health`);
  console.log(`  Data Dir:   ${ZHIGUI_DIR}`);
  console.log('');
  console.log('  Press Ctrl+C to stop the server');
  console.log('');
  
  ensureIndex();
  setupFileWatcher();
});
