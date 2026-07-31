// mcp/brain-index.js
/**
 * ZhiGui - Second-brain association index layer (MySQL-style foreign keys + user-confirmed topic precipitation)
 *
 * This is the core data layer of the "true second brain". It builds a
 * "topic -> entity" association index on top of canonical entity documents, enabling:
 *
 *  1) AI-driven topic classification: the AI assigns notes/goals/events to topics
 *     explicitly; the engine never creates or splits topics via keyword or count thresholds.
 *  2) User-confirmed precipitation (document detachment): when the AI decides a topic
 *     has grown large enough, it proposes extracting that topic's notes from notes.json
 *     into a standalone topics/<id>.json file. The extraction only happens after the user
 *     accepts the proposal in conversation (the tool is called with userConfirmed: true).
 *  3) Safe topic deletion: deleting a topic removes only notes owned by that
 *     topic and detaches surviving plans from its retrieval metadata.
 *  4) Association search (JOIN-like): given a topic, return all associated entities; global
 *     search aggregates across stores.
 *
 * All entities reference each other through the related foreign-key table in index.json,
 * structurally equivalent to a relational database.
 */

const fs = require('fs');
const path = require('path');
const Storage = require('./storage');
const { StaleDataError } = require('./errors');
const logger = require('./logger');

const VERSION = '3.1.0';

function ts() { return new Date().toISOString(); }

// Generate a stable id from a topic label (avoids pinyin dependency, filename-safe)
function slug(label) {
  const hex = Buffer.from(label, 'utf8').toString('hex').slice(0, 12);
  return 't_' + hex;
}

// A dependency-free relevance fallback for conversation-triggered retrieval.
// It does not classify or mutate records; it only lets a mixed Chinese/English
// user query match individual concepts when the entire sentence is not a
// literal substring of a stored note.
function retrievalTerms(query) {
  const text = String(query || '').toLowerCase().trim();
  const terms = new Set((text.match(/[\p{L}\p{N}_-]{2,}/gu) || []));
  const han = [...text].filter(char => /\p{Script=Han}/u.test(char));
  for (let index = 0; index < han.length - 1; index++) terms.add(han.slice(index, index + 2).join(''));
  return [...terms];
}

function relevanceScore(terms, value) {
  const text = String(value || '').toLowerCase();
  if (!text) return 0;
  return terms.reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0);
}

function searchSnippet(value, query, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const at = lower.indexOf(String(query || '').toLowerCase());
  if (at < 0 || text.length <= max) return text.slice(0, max);
  const start = Math.max(0, at - Math.floor(max / 3));
  const prefix = start > 0 ? '…' : '';
  const remaining = Math.max(1, max - prefix.length);
  const provisionalEnd = Math.min(text.length, start + remaining);
  const suffix = provisionalEnd < text.length ? '…' : '';
  const end = Math.min(text.length, start + Math.max(1, remaining - suffix.length));
  return `${prefix}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

class BrainIndex {
  constructor(dataDir) {
    this.dir = dataDir;
    this.topicsDir = path.join(dataDir, 'topics');
    this.files = {
      notes: path.join(dataDir, 'notes.json'),
      goals: path.join(dataDir, 'goals.json'),
      schedule: path.join(dataDir, 'schedule.json'),
      errands: path.join(dataDir, 'errands.json'),
      decisions: path.join(dataDir, 'decisions.json'),
      userProfile: path.join(dataDir, 'userProfile.json'),
      index: path.join(dataDir, 'index.json'),
      library: path.join(dataDir, 'library.json'),
    };
    // Start with an empty library. Topics and categories are created only from
    // explicit AI judgments supplied with notes/goals.
    this._initLibrary();
  }

  // ===== AI-authored library management =====
  _initLibrary() {
    const existing = this._read(this.files.library, null);
    if (existing && existing.topics) return;  // already initialized

    const library = {
      version: '1.0',
      createdAt: ts(),
      categories: {},
      topics: {},
    };

    this._writeLibrary(library);
  }

  _readLibrary() {
    return this._read(this.files.library, { version: '1.0', categories: {}, topics: {} });
  }

  _writeLibrary(library) {
    return this._write(this.files.library, library);
  }

  // Get the full library structure (for AI and dashboard)
  getLibrary() {
    return this._readLibrary();
  }

  // Add a new topic to the library (called by ensureTopic when creating new topics)
  _addToLibrary(label, keywords, category) {
    const library = this._readLibrary();
    if (!library.topics[label]) {
      library.topics[label] = {
        keywords: keywords || [],
        category: category || null,
        builtIn: false,
        createdAt: ts(),
      };
      // Add to category's topic list
      if (category) {
        if (!library.categories[category]) library.categories[category] = { icon: '📁', topics: [] };
        if (!library.categories[category].topics.includes(label)) library.categories[category].topics.push(label);
      }
      this._writeLibrary(library);
    }
  }

  // -- Low-level IO --
  _read(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
  }

  // P0-2.2: Record the mtime of a file at a given point in time.
  // Returns null if the file does not exist (so the staleness check is skipped
  // for files that were never present).
  _statMtime(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  // P0-2.2: Compare the current mtime against the start mtime.
  // If they differ the file was modified (or deleted/created) by another process
  // during the read-recompute window — the in-memory data is now stale and must
  // NOT be persisted. Throw StaleDataError so callers can abort the write.
  _checkStale(filePath, startMtime) {
    let endMtime;
    try {
      endMtime = fs.statSync(filePath).mtimeMs;
    } catch {
      endMtime = null;
    }
    if (endMtime !== startMtime) {
      throw new StaleDataError(
        `${path.basename(filePath)} was modified during read-recompute`,
        { file: path.basename(filePath), startMtime, endMtime }
      );
    }
  }
  _write(p, data) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // Use file lock to prevent concurrent writes (solves B, C)
      const Storage = require('./storage');
      const result = Storage.withLock('brain-index', () => {
        Storage.writeJsonAtomic(p, data);
        return true;
      });
      // state.json is owned exclusively by Storage.writeState; the brain-index
      // writer only flushes index.json / topics/*.json, so no side-channel
      // syncStateJson() is needed here. Calling it would race with writeState
      // (unlocked write to the same state.json) — see audit P2.
      return result;
    } catch { return false; }
  }

  // -- Index read/write --
  _readIndex() {
    const idx = this._read(this.files.index, null);
    if (!idx || !idx.topics) {
      const fresh = { version: VERSION, meta: { lastUpdated: ts() }, topics: {} };
      this._write(this.files.index, fresh);
      return fresh;
    }
    idx.meta = idx.meta || {};
    if (!idx.meta.keywordFreq) idx.meta.keywordFreq = {};
    return idx;
  }
  _writeIndex(idx) {
    idx.meta = idx.meta || {};
    idx.meta.lastUpdated = ts();
    return this._write(this.files.index, idx);
  }

  // -- Topic detection and creation --
  // AI-DRIVEN: the AI must pass the `topic` parameter when calling add_goal/create_event.
  // The engine does NOT do keyword matching — that was unreliable for Chinese semantics.
  // This method is kept for backward compatibility (dashboard reindex) but returns null
  // when no explicit topic is provided, forcing the AI to classify.
  detectTopic(text) {
    // No keyword matching — AI must provide topic explicitly.
    // Return null to signal "AI needs to classify this".
    return null;
  }

  // Find an existing topic by label (exact or fuzzy match) — used by dashboard search only
  findTopicByLabel(query) {
    if (!query) return null;
    const idx = this._readIndex();
    const q = query.toLowerCase().trim();
    // Exact match first
    for (const t of Object.values(idx.topics)) {
      if (t.label.toLowerCase() === q) return t.id;
    }
    // Fuzzy substring match (dashboard search only — NOT used by AI workflow)
    let best = null;
    for (const t of Object.values(idx.topics)) {
      const label = t.label.toLowerCase();
      if (label.includes(q) || q.includes(label)) {
        if (!best || t.label.length < idx.topics[best].label.length) best = t.id;
      }
    }
    return best;
  }

  // Fuzzy match by label (used to locate a topic during search/delete)
  _matchByLabel(query) {
    const idx = this._readIndex();
    const q = (query || '').trim().toLowerCase();
    if (!q) return null;
    let best = null;
    for (const t of Object.values(idx.topics)) {
      const label = (t.label || '').toLowerCase();
      if (label === q) return t.id;
      if (label.includes(q) || q.includes(label)) best = best || t.id;
    }
    return best;
  }

  ensureTopic(label, { domain = 'misc', category = null, keywords = [] } = {}) {
    if (!label) return null;
    const idx = this._readIndex();
    const id = slug(label);
    // ID collision guard: same label → same slug → same ID. If a topic with
    // this ID already exists, return it instead of overwriting. This is NOT
    // fuzzy matching — the AI decides reuse via topicId; this only prevents
    // data loss when the same label is passed twice.
    if (idx.topics[id]) {
      const existing = idx.topics[id];
      const set = new Set([...(existing.keywords || []), ...keywords]);
      existing.keywords = [...set];
      if (category && category !== existing.category) {
        this._updateCategoryCount(idx, existing.category, -1);
        existing.category = category;
        this._updateCategoryCount(idx, category, 1);
      }
      existing.updatedAt = ts();
      this._writeIndex(idx);
      return existing.id;
    }
    // Normalize matching (secondary check): trim + case-insensitive.
    // Catches "English" vs "english" or " 考研 " vs "考研" that slug()
    // misses because UTF-8 hex encoding is case-sensitive.
    const normalizedLabel = label.trim().toLowerCase();
    for (const existing of Object.values(idx.topics)) {
      if ((existing.label || '').trim().toLowerCase() === normalizedLabel) {
        const set = new Set([...(existing.keywords || []), ...keywords]);
        existing.keywords = [...set];
        if (category && category !== existing.category) {
          this._updateCategoryCount(idx, existing.category, -1);
          existing.category = category;
          this._updateCategoryCount(idx, category, 1);
        }
        existing.updatedAt = ts();
        this._writeIndex(idx);
        return existing.id;
      }
    }
    const effectiveCategory = category || null;
    idx.topics[id] = {
      id,
      label,
      domain,
      category: effectiveCategory,
      keywords: [...new Set(keywords)],
      createdAt: ts(),
      updatedAt: ts(),
      noteCount: 0,
      precipitated: false,
      file: null,
      related: { notes: [], goals: [], actionItems: [] },
    };
    this._updateCategoryCount(idx, effectiveCategory, 1);
    this._writeIndex(idx);
    // Also add to library.json so the library stays in sync with all topics
    this._addToLibrary(label, [...new Set(keywords)], effectiveCategory);
    return id;
  }

  // Maintain category counts in index for filter dropdown and auto-promotion
  _updateCategoryCount(idx, category, delta) {
    if (!category) return;
    idx.categories = idx.categories || {};
    const c = idx.categories[category] || { topicCount: 0, totalNotes: 0 };
    c.topicCount = Math.max(0, (c.topicCount || 0) + delta);
    idx.categories[category] = c;
  }

  // Get category list for filter dropdown
  getCategories() {
    const idx = this._readIndex();
    const cats = idx.categories || {};
    return Object.entries(cats)
      .map(([name, c]) => ({ name, topicCount: c.topicCount || 0, totalNotes: c.totalNotes || 0 }))
      .filter(c => c.topicCount > 0)
      .sort((a, b) => b.totalNotes - a.totalNotes);
  }

  // -- Foreign-key association --
  // Map legacy entity types to the unified bucket. Tasks and errands are BOTH "action items"
  // (doable things) — they share one `actionItems` foreign-key bucket in topic.related even though
  // they live in separate storage files (schedule.json tasks vs errands.json). Events are the input
  // stream and are never linked to a topic.
  _relKey(type) {
    if (type === 'tasks' || type === 'errands') return 'actionItems';
    return type;
  }

  linkEntity(topicId, type, entityId) {
    if (!topicId || !entityId) return false;
    const key = this._relKey(type);
    const idx = this._readIndex();
    const t = idx.topics[topicId];
    if (!t) return false;
    const arr = t.related[key] || (t.related[key] = []);
    if (!arr.includes(entityId)) arr.push(entityId);
    t.updatedAt = ts();
    this._writeIndex(idx);
    return true;
  }

  // Unbind an entity from all topics (used to maintain foreign keys on single-record delete)
  unlinkEntityCascade(type, entityId) {
    const key = this._relKey(type);
    const idx = this._readIndex();
    for (const t of Object.values(idx.topics)) {
      if (t.related[key]) {
        const before = t.related[key].length;
        t.related[key] = t.related[key].filter(id => id !== entityId);
        if (t.related[key].length !== before) t.updatedAt = ts();
      }
    }
    this._writeIndex(idx);
  }

  // Remove topics that no longer have any related notes, goals or action items,
  // and prune empty categories from both index.json and library.json so that
  // deleting the last note of a topic does not leave phantom categories behind.
  cleanupEmptyTopics() {
    const idx = this._readIndex();
    const emptyTopicIds = [];
    for (const [topicId, topic] of Object.entries(idx.topics || {})) {
      const notes = topic.related?.notes || [];
      const goals = topic.related?.goals || [];
      const actionItems = topic.related?.actionItems || [];
      if (notes.length === 0 && goals.length === 0 && actionItems.length === 0) {
        emptyTopicIds.push(topicId);
      }
    }
    for (const topicId of emptyTopicIds) {
      this.deleteTopicMetadata(topicId);
    }

    // Consistency sweep: remove library topics whose label no longer exists in
    // the index, and drop empty library/index categories.
    const lib = this._readLibrary();
    const activeLabels = new Set(Object.values(idx.topics || {}).map(t => t.label).filter(Boolean));
    let libraryDirty = false;
    for (const label of Object.keys(lib.topics || {})) {
      if (!activeLabels.has(label)) {
        delete lib.topics[label];
        libraryDirty = true;
      }
    }
    for (const [catName, cat] of Object.entries(lib.categories || {})) {
      if (!Array.isArray(cat.topics) || cat.topics.length === 0) {
        delete lib.categories[catName];
        libraryDirty = true;
      }
    }
    if (libraryDirty) this._writeLibrary(lib);

    const finalIdx = this._readIndex();
    if (finalIdx.categories) {
      let indexDirty = false;
      for (const [name, c] of Object.entries(finalIdx.categories)) {
        if (!c.topicCount || c.topicCount === 0) {
          delete finalIdx.categories[name];
          indexDirty = true;
        }
      }
      if (indexDirty) this._writeIndex(finalIdx);
    }

    return emptyTopicIds.length;
  }

  // Recount a topic from its foreign-key associations. Note bodies remain canonical in
  // notes/<id>.json; a topic is an index, never a second competing note store.
  reindexTopic(topicId) {
    // P0-2.2: Stale data detection — record notes.json mtime before reading.
    const startMtime = this._statMtime(this.files.notes);
    const idx = this._readIndex();
    const t = idx.topics[topicId];
    if (!t) return;
    const notesDoc = this._read(this.files.notes, { notes: [] });
    const ids = new Set(t.related?.notes || []);
    for (const note of (notesDoc.notes || [])) {
      if (note?.topicId === topicId) ids.add(note.id);
    }
    let count = ids.size;
    if (t.precipitated && t.file) {
      const tf = this._read(path.join(this.dir, t.file), { notes: [] });
      for (const note of (tf.notes || [])) ids.add(note.id);
      count = ids.size;
    }
    t.noteCount = count;
    t.updatedAt = ts();
    t.related = t.related || { notes: [], goals: [], actionItems: [] };
    t.related.notes = [...ids];
    // P0-2.2: If notes.json changed during the read-recompute window, abort
    // the write — the recounted note list is based on stale data.
    this._checkStale(this.files.notes, startMtime);
    this._writeIndex(idx);
  }

  // Already-precipitated topic: merge the newly-added notes for this topic from notes.json
  // into topics/<id>.json
  _mergePrecipitate(topicId, inNotes, notesDoc) {
    const idx = this._readIndex();
    const t = idx.topics[topicId];
    if (!t) return;
    const topicFilePath = t.file || path.join('topics', topicId + '.json');
    const tf = this._read(path.join(this.dir, topicFilePath), { notes: [] });
    tf.topicId = topicId;
    tf.label = t.label;
    tf.precipitatedAt = tf.precipitatedAt || ts();
    tf.meta = tf.meta || {};
    tf.meta.version = VERSION;
    tf.notes = [...(tf.notes || []), ...inNotes];
    this._write(path.join(this.dir, topicFilePath), tf);
    notesDoc.notes = (notesDoc.notes || []).filter(n => !(n && n.topicId === topicId));
    this._write(this.files.notes, notesDoc);
    t.file = topicFilePath;
    t.precipitated = true;
    t.noteCount = (tf.notes || []).length;
    t.updatedAt = ts();
    this._writeIndex(idx);
  }

  // Move a topic's notes from notes.json to topics/<id>.json (standalone file)
  _precipitate(topicId) {
    const idx = this._readIndex();
    const t = idx.topics[topicId];
    if (!t) return;
    const notesDoc = this._read(this.files.notes, { notes: [] });
    const allNotes = notesDoc.notes || [];
    const moved = allNotes.filter(n => n && n.topicId === topicId);
    notesDoc.notes = allNotes.filter(n => !(n && n.topicId === topicId));
    const topicFilePath = path.join('topics', topicId + '.json');
    const topicDoc = {
      topicId,
      label: t.label,
      precipitatedAt: ts(),
      notes: moved,
      meta: { version: VERSION },
    };
    this._write(path.join(this.dir, topicFilePath), topicDoc);
    this._write(this.files.notes, notesDoc);
    t.precipitated = true;
    t.file = topicFilePath;
    t.noteCount = moved.length;
    t.updatedAt = ts();
    this._writeIndex(idx);
  }

  /**
   * Get the compressed Working Context for a topic.
   * This is Layer 2 Knowledge Engine output — NOT a raw note list.
   * AI reads this compressed context instead of individual notes.
   *
   * @param {string} topicId - Topic ID
   * @param {Object} [opts]
   * @param {boolean} [opts.includeNotes=false] - Whether to include individual note titles
   * @returns {Object} Compressed topic document
   */
  getTopicDocument(topicId, opts = {}) {
    const { includeNotes = false } = opts;
    const idx = this._readIndex();
    const t = idx.topics[topicId];
    if (!t) return null;

    // ---- Collect all notes linked to this topic ----
    const notesDoc = this._read(this.files.notes, { notes: [] });
    const candidates = new Map();
    for (const note of (notesDoc.notes || [])) {
      if (note && (note.topicId === topicId || (t.related?.notes || []).includes(note.id))) {
        candidates.set(note.id, note);
      }
    }
    // Read legacy precipitated files only as a recovery source
    if (t.precipitated && t.file) {
      const archive = this._read(path.join(this.dir, t.file), { notes: [] });
      for (const note of (archive.notes || [])) {
        if (note?.id) candidates.set(note.id, note);
      }
    }
    // Enrich notes via Storage.getNoteDetail when available
    const allNotes = [...candidates.values()].map(note => Storage.getNoteDetail(note.id) || note);

    // ---- Collect goals linked to this topic ----
    const goalIds = new Set(t.related?.goals || []);
    const goalsDoc = this._read(this.files.goals, {});
    const linkedGoals = [];
    for (const key of ['strategicGoals', 'currentGoals', 'constraints']) {
      for (const g of (goalsDoc[key] || [])) {
        if (goalIds.has(g.id)) {
          const deadline = g.deadline ? new Date(g.deadline) : null;
          const now = new Date();
          const daysLeft = deadline ? Math.ceil((deadline - now) / 86400000) : null;
          linkedGoals.push({
            id: g.id,
            title: g.title,
            deadline: g.deadline || null,
            daysLeft,
          });
        }
      }
    }

    // ---- Collect decisions & completedActions from state.json ----
    const stateFile = path.join(this.dir, 'state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) || {}; } catch {}

    const allDecisions = state.decisions || [];
    const topicNoteIds = new Set(allNotes.map(n => n.id));
    const linkedDecisions = allDecisions
      .filter(d => d.topicId === topicId || (d.noteId && topicNoteIds.has(d.noteId)))
      .map(d => ({
        id: d.id,
        title: d.title || d.summary || 'Untitled decision',
        status: d.status || 'pending',
        createdAt: d.createdAt || null,
      }));

    const allCompleted = state.completedActions || [];
    const topicActionIds = new Set([
      ...(t.related?.actionItems || []),
      ...(t.related?.tasks || []),
      ...(t.related?.errands || []),
    ]);
    const recentCompleted = allCompleted
      .filter(a => topicActionIds.has(a.id) || a.topicId === topicId)
      .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))
      .slice(0, 5)
      .map(a => ({ id: a.id, title: a.title, completedAt: a.completedAt }));

    // ---- Aggregate stats ----
    const actionItemCount = topicActionIds.size;

    // ---- Recent notes (last 5 by createdAt) ----
    const recentNotes = [...allNotes]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 5)
      .map(n => ({
        id: n.id,
        title: n.title || 'Untitled',
        createdAt: n.createdAt || null,
      }));

    // ---- Evidence: open questions & risks ----
    const openQuestions = [];
    const risks = [];
    for (const n of allNotes) {
      if (n.signal === 'question' || n.needsEnrichment) {
        openQuestions.push(n.title || n.content || 'Untitled question');
      }
      if (n.signal === 'risk' || n.health === 'health_negative') {
        risks.push(n.title || n.content || 'Untitled risk');
      }
    }

    // ---- Compressed working context summary (engine-generated, not AI) ----
    const goalSummary = linkedGoals.length > 0
      ? linkedGoals.map(g => `${g.title}${g.daysLeft !== null ? ` (${g.daysLeft}d left)` : ''}`).join(', ')
      : 'No linked goals';
    const decisionSummary = linkedDecisions.length > 0
      ? linkedDecisions.filter(d => d.status === 'pending').length + ' pending'
      : 'No linked decisions';
    const riskSummary = risks.length > 0 ? risks.join('; ') : 'No known risks';
    const questionSummary = openQuestions.length > 0 ? openQuestions.join('; ') : 'No open questions';

    const workingContext = [
      `Topic: ${t.label} [${t.domain || 'misc'}]`,
      `${allNotes.length} notes, ${linkedGoals.length} goals, ${actionItemCount} actions, ${linkedDecisions.length} decisions.`,
      `Goals: ${goalSummary}`,
      `Decisions: ${decisionSummary}`,
      `Risks: ${riskSummary}`,
      `Questions: ${questionSummary}`,
    ].join(' | ');

    // ---- Build result ----
    const result = {
      id: topicId,
      label: t.label,
      domain: t.domain || 'misc',
      category: t.category || 'Other',

      // Aggregation: counts by entity type
      stats: {
        noteCount: allNotes.length,
        goalCount: linkedGoals.length,
        actionItemCount,
        decisionCount: linkedDecisions.length,
      },

      // Summarization: what changed recently
      recentNotes,
      recentActions: recentCompleted,

      // Compression: key entities linked to this topic
      relatedGoals: linkedGoals,
      relatedDecisions: linkedDecisions,

      // Evidence
      openQuestions,
      risks,

      // Compressed working context summary
      workingContext,
    };

    // Backward compatibility: callers that expect .notes still get them
    if (includeNotes) {
      result.notes = allNotes;
    }

    return result;
  }

  getTopics() {
    const idx = this._readIndex();
    const dynamic = Object.values(idx.topics);

    // Errands (life to-dos) and goal-derived tasks share the unified `actionItems` bucket in
    // the index, so to show 琐事 as a distinct group we distinguish them by membership in
    // errands.json. One read, reused for every topic.
    let errandIds = new Set();
    try {
      const errandFile = this._read(this.files.errands, { errands: [] });
      errandIds = new Set((errandFile.errands || []).map(e => e.id));
    } catch {}

    const pendingNoteIds = new Set();
    try {
      const notesFile = this._read(this.files.notes, { notes: [] });
      for (const note of (notesFile.notes || [])) {
        if (note?.needsEnrichment === true || !note?.topicId) pendingNoteIds.add(note.id);
      }
    } catch {}

    // library.json is a vocabulary/template store, not a user Topic source. A live
    // topic must always have a real id so preview and deletion are reliable.
    return dynamic
      .map(t => {
        const actionItems = (t.related?.actionItems || []).concat(t.related?.tasks || [], t.related?.errands || []);
        const confirmedNotes = (t.related?.notes || []).filter(noteId => !pendingNoteIds.has(noteId));
        const errandCount = actionItems.filter(id => errandIds.has(id)).length;
        const taskCount = actionItems.length - errandCount;
        return {
          id: t.id,
          label: t.label,
          domain: t.domain,
          category: t.category || 'Other',
          keywords: t.keywords,
          noteCount: confirmedNotes.length,
          precipitated: t.precipitated,
          file: t.file,
          builtIn: t.builtIn || false,
          relatedCounts: {
            notes: confirmedNotes.length,
            goals: (t.related?.goals || []).length,
            actionItems: actionItems.length,
            // Distinct groups for the containment tree: 琐事 (errands) vs 目标-任务 (tasks)
            errands: errandCount,
            tasks: taskCount,
          },
        };
      })
      .sort((a, b) => b.noteCount - a.noteCount);
  }

  // One-click cascade delete of a topic and all its associations (foreign-key ON DELETE CASCADE).
  // opts.dryRun=true returns a detailed manifest (what WILL be deleted) WITHOUT deleting anything —
  // the caller must confirm, then call again with dryRun=false. This satisfies the mandatory
  // "preview → confirm" requirement for cascade deletes.
  // Action items (goal-derived tasks) are deleted by actionItemIds OR by reverse-lookup on
  // relatedGoalId/relatedStrategicGoalId (orphan tasks whose goal was deleted are removed too).
  /**
   * Remove only the topic's retrieval metadata. Entity ownership is handled by
   * the canonical Actions layer, which can clean cross-document references in
   * one state transaction before it calls this helper.
   */
  deleteTopicMetadata(topicId) {
    const idx = this._readIndex();
    const topic = idx.topics?.[topicId];
    if (!topic) return { success: false, error: 'topic not found', topicId };
    const originalIndex = JSON.parse(JSON.stringify(idx));
    const lib = this._readLibrary();
    const originalLibrary = lib ? JSON.parse(JSON.stringify(lib)) : null;
    const rollback = (error) => {
      // Metadata is secondary, but it must not claim a topic was removed when
      // the canonical state transaction was aborted. Best-effort rollback
      // keeps the two views aligned and still makes a write error visible.
      this._writeIndex(originalIndex);
      if (originalLibrary) this._writeLibrary(originalLibrary);
      return { success: false, error: error.message || String(error), topicId };
    };
    delete idx.topics[topicId];
    if (!this._writeIndex(idx)) {
      return { success: false, error: 'Unable to persist topic index', topicId };
    }
    try {
      if (lib) {
        if (lib.topics) delete lib.topics[topic.label];
        for (const category of Object.values(lib.categories || {})) {
          if (Array.isArray(category?.topics)) {
            category.topics = category.topics.filter(label => label !== topic.label);
          }
        }
        if (!this._writeLibrary(lib)) {
          return rollback(new Error('Unable to persist topic library'));
        }
      }
      if (topic.precipitated && topic.file) {
        try {
          fs.unlinkSync(path.join(this.dir, topic.file));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return { success: true, topicId, label: topic.label, topicFile: !!(topic.precipitated && topic.file) };
    } catch (error) {
      return rollback(error);
    }
  }

  // Topic deletion belongs to Actions.topic.delete (canonical cascade). The old
  // unsafe direct cascade was removed; no stub is retained so it cannot be called.
  // Association search: returns the topic + all associated entities (SQL JOIN-like)
  findAssociated(query) {
    const idx = this._readIndex();
    // Resolve by id first (the dashboard calls this with the topic id), then by label.
    let topicId = (query && idx.topics[query] && idx.topics[query].id) || this.detectTopic(query) || this._matchByLabel(query);
    if (!topicId) return { found: false, query };
    const t = idx.topics[topicId];
    const rel = t.related || {};
    const result = {
      found: true,
      topic: { id: t.id, label: t.label, domain: t.domain, keywords: t.keywords, precipitated: t.precipitated },
      related: {},
    };
    const g = this._read(this.files.goals, {});
    const goals = [];
    for (const key of ['strategicGoals', 'currentGoals', 'constraints']) {
      (g[key] || []).forEach(x => { if ((rel.goals || []).includes(x.id)) goals.push({ id: x.id, type: key, title: x.title, completed: !!x.completed }); });
    }
    result.related.goals = goals;
    // Tasks + errands share the actionItems bucket; tolerate legacy tasks/errands keys
    const actionItemIds = [...new Set([...(rel.actionItems || []), ...(rel.tasks || []), ...(rel.errands || [])])];
    const actionItems = [];
    const sch = this._read(this.files.schedule, { days: {} });
    const schDays = sch.schedule?.days || sch.days || {};
    for (const [date, day] of Object.entries(schDays)) {
      (day.tasks || []).forEach(tk => { if (actionItemIds.includes(tk.id)) actionItems.push({ id: tk.id, kind: 'task', date, title: tk.title, time: tk.time }); });
    }
    const er = this._read(this.files.errands, { errands: [] });
    (er.errands || []).filter(x => actionItemIds.includes(x.id)).forEach(x => actionItems.push({ id: x.id, kind: 'errand', title: x.title, commitmentLevel: x.commitmentLevel || 'should' }));
    result.related.actionItems = actionItems;
    const doc = this.getTopicDocument(topicId, { includeNotes: true });
    result.related.notes = (doc && doc.notes) || [];
    return result;
  }

  // Global search: across topics/notes/goals/events; hits include their topic attribution
  // Fuzzy match: query "eng" matches topic "English Speaking" (case-insensitive substring)
  search(query, { limit = 12, offset = 0 } = {}) {
    const q = (query || '').trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 30));
    const safeOffset = Math.max(0, Number(offset) || 0);
    if (!q) return { query, total: 0, hits: [], offset: safeOffset, limit: safeLimit, hasMore: false, nextOffset: null };
    const terms = retrievalTerms(q);
    const idx = this._readIndex();
    const hits = [];

    // 1) Search topic labels first (highest priority) — "eng" matches "English Speaking"
    for (const t of Object.values(idx.topics)) {
      const label = (t.label || '').toLowerCase();
      const keywords = (t.keywords || []).join(' ').toLowerCase();
      if (label.includes(q) || q.includes(label) || keywords.includes(q)) {
        const rc = t.relatedCounts || {};
        const count = (t.related?.goals || []).length + (t.related?.notes || []).length + ((t.related?.actionItems || []).length + (t.related?.tasks || []).length + (t.related?.errands || []).length);
        hits.push({
          type: 'topic',
          topicId: t.id,
          topicLabel: t.label,
          title: t.label,
          snippet: count > 0 ? `${count} linked items` : '',
          id: t.id,
        });
      }
    }
    // 4) Search actionable records. A past visit, an uncompleted fixed-date
    // event, or a decision may be the only durable clue for a later follow-up.
    // Return compact pointers only; callers load the dated schedule/detail when
    // they decide it is relevant.
    const scheduleDoc = this._read(this.files.schedule, { days: {} });
    const errandsDoc = this._read(this.files.errands, { errands: [] });
    const decisionsDoc = this._read(this.files.decisions, { decisions: [] });
    const actionRecords = [];
    for (const [date, day] of Object.entries(scheduleDoc.schedule?.days || scheduleDoc.days || {})) {
      for (const task of (day.tasks || [])) {
        actionRecords.push({
          type: 'task', id: task.id, title: task.title || null, date,
          topicId: task.topicId || null, relatedGoalId: task.relatedGoalId || null,
          snippet: searchSnippet(`${task.description || ''} ${task.contextReason || ''}`, q),
          text: `${task.title || ''} ${task.description || ''} ${task.contextReason || ''}`,
        });
      }
    }
    for (const errand of (errandsDoc.errands || [])) {
      actionRecords.push({
        type: 'errand', id: errand.id, title: errand.title || null, date: errand.date || null,
        topicId: errand.topicId || null, relatedGoalId: errand.goalId || errand.relatedGoalId || null,
        snippet: searchSnippet(`${errand.description || ''} ${errand.contextReason || ''}`, q),
        text: `${errand.title || ''} ${errand.description || ''} ${errand.contextReason || ''}`,
      });
    }
    for (const decision of (decisionsDoc.decisions || [])) {
      actionRecords.push({
        type: 'decision', id: decision.id, title: decision.title || null,
        topicId: (decision.topicIds || [])[0] || null,
        snippet: searchSnippet(`${decision.rationale || ''} ${decision.evidence || ''}`, q),
        text: `${decision.title || ''} ${decision.rationale || ''} ${decision.evidence || ''}`,
      });
    }
    for (const record of actionRecords) {
      if (record.text.toLowerCase().includes(q)) {
        const { text, ...hit } = record;
        hits.push(hit);
      }
    }

    // 2) Search notes (both in notes.json and in precipitated topic files)
    const notesDoc = this._read(this.files.notes, { notes: [] });
    for (const n of (notesDoc.notes || [])) {
      if ((n.content || '').toLowerCase().includes(q)) hits.push({ type: 'note', title: n.title || null, domain: n.domain || 'misc', topicId: n.topicId, snippet: searchSnippet(n.content, q), id: n.id });
    }
    for (const t of Object.values(idx.topics)) {
      if (t.precipitated && t.file) {
        const doc = this._read(path.join(this.dir, t.file), { notes: [] });
        for (const n of (doc.notes || [])) {
          if ((n.content || '').toLowerCase().includes(q)) hits.push({ type: 'note', title: n.title || null, domain: n.domain, topicId: t.id, topicLabel: t.label, snippet: searchSnippet(n.content, q), id: n.id });
        }
      }
    }
    // 3) Search goals
    const g = this._read(this.files.goals, {});
    for (const key of ['strategicGoals', 'currentGoals', 'constraints']) {
      for (const x of (g[key] || [])) {
        if ((x.title || '').toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)) {
          hits.push({ type: 'goal', subtype: key, title: x.title, snippet: searchSnippet(x.description || x.detail || '', q), id: x.id, topicId: x.topicId });
        }
      }
    }
    // Dedup by id (topic hits may overlap with note hits)
    const seen = new Set();
    const unique = hits.filter(h => {
      const key = h.type + ':' + (h.id || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // A natural-language question rarely appears verbatim in a note. If no
    // literal hit exists, rank records by its individual meaningful terms.
    if (unique.length === 0 && terms.length > 0) {
      const ranked = [];
      const addRanked = (hit, text) => {
        const score = relevanceScore(terms, text);
        if (score > 0) ranked.push({ ...hit, score });
      };
      for (const topic of Object.values(idx.topics)) {
        addRanked({ type: 'topic', topicId: topic.id, topicLabel: topic.label, title: topic.label, snippet: '', id: topic.id },
          `${topic.label || ''} ${(topic.keywords || []).join(' ')}`);
      }
      for (const note of (notesDoc.notes || [])) {
        addRanked({ type: 'note', title: note.title || null, domain: note.domain || 'misc', topicId: note.topicId, snippet: searchSnippet(note.content, q), id: note.id },
          `${note.title || ''} ${note.content || ''}`);
      }
      for (const goalType of ['strategicGoals', 'currentGoals', 'constraints']) {
        for (const goal of (g[goalType] || [])) {
          addRanked({ type: 'goal', subtype: goalType, title: goal.title, snippet: searchSnippet(goal.description || goal.detail || '', q), id: goal.id, topicId: goal.topicId },
            `${goal.title || ''} ${goal.description || ''} ${goal.detail || ''}`);
        }
      }
      for (const record of actionRecords) {
        const { text, ...hit } = record;
        addRanked(hit, text);
      }
      ranked.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
      const items = ranked.slice(safeOffset, safeOffset + safeLimit).map(({ score, ...hit }) => ({ ...hit, match: 'term-ranked' }));
      return { query, total: ranked.length, hits: items, retrieval: 'term-ranked', offset: safeOffset, limit: safeLimit, hasMore: safeOffset + items.length < ranked.length, nextOffset: safeOffset + items.length < ranked.length ? safeOffset + items.length : null };
    }
    const items = unique.slice(safeOffset, safeOffset + safeLimit);
    return { query, total: unique.length, hits: items, retrieval: 'literal', offset: safeOffset, limit: safeLimit, hasMore: safeOffset + items.length < unique.length, nextOffset: safeOffset + items.length < unique.length ? safeOffset + items.length : null };
  }

  // ===== Context-aware note retrieval (mem.ai style) =====
  // AI-DRIVEN context retrieval: the AI passes explicit topicIds and the engine returns
  // associated note titles and goal titles for those topics. No keyword matching.
  // Usage: brain.getContext({ topicIds: ['t_abc'], limit: 5 })
  // Legacy string mode (brain.getContext("text")) returns empty — keyword matching removed.
  getContext(userMessageOrOptions, options = {}) {
    let topicIds, limit;
    if (typeof userMessageOrOptions === 'string') {
      return { hasContext: false, items: [], hint: 'Keyword matching removed. Pass { topicIds: [...] } for AI-driven retrieval.' };
    } else if (userMessageOrOptions && Array.isArray(userMessageOrOptions.topicIds)) {
      topicIds = userMessageOrOptions.topicIds;
      limit = userMessageOrOptions.limit || options.limit || 5;
    } else {
      return { hasContext: false, items: [] };
    }
    if (topicIds.length === 0) return { hasContext: false, items: [] };

    const idx = this._readIndex();
    const items = [];
    // Pre-load flat files for enriching context items with actual content
    const _files = this.files;
    let _flatGoals = null, _flatNotes = null;
    const _getFlatGoals = () => {
      if (!_flatGoals) { try { _flatGoals = JSON.parse(require('fs').readFileSync(_files.goals, 'utf-8')); } catch { _flatGoals = {}; } }
      return _flatGoals;
    };
    const _getFlatNotes = () => {
      if (!_flatNotes) { try { _flatNotes = JSON.parse(require('fs').readFileSync(_files.notes, 'utf-8')); } catch { _flatNotes = {}; } }
      return _flatNotes;
    };

    for (const tid of topicIds) {
      const t = idx.topics[tid];
      if (!t) continue;
      const related = t.related || {};
      for (const goalId of (related.goals || [])) {
        const g = _getFlatGoals();
        let goal = null;
        for (const key of ['currentGoals', 'strategicGoals', 'constraints']) {
          const found = (g[key] || []).find(x => x.id === goalId);
          if (found) { goal = found; break; }
        }
        items.push({
          type: 'goal', id: goalId, topicId: tid, topicLabel: t.label, relationOrder: 4,
          title: goal?.title || goalId,
          deadline: goal?.deadline || null,
          completed: goal?.completed || false,
        });
      }
      for (const noteId of (related.notes || [])) {
        const n = _getFlatNotes();
        let note = null;
        const notesArr = n.notes || [];
        const found = notesArr.find(x => x.id === noteId);
        if (found) { note = found; }
        items.push({
          type: 'note', id: noteId, topicId: tid, topicLabel: t.label, relationOrder: 3,
          title: note?.title || '待 AI 归纳',
          needsEnrichment: note?.needsEnrichment === true,
          createdAt: note?.createdAt || null,
        });
      }
      if (t.precipitated && t.file) {
        const doc = this.getTopicDocument(tid, { includeNotes: true });
        for (const n of (doc.notes || [])) {
          items.push({ type: 'note', id: n.id, title: n.title || '待 AI 归纳', needsEnrichment: n.needsEnrichment === true, topicId: tid, topicLabel: t.label, relationOrder: 3, createdAt: n.createdAt });
        }
      }
    }
    items.sort((a, b) => b.relationOrder - a.relationOrder);
    const seen = new Set();
    const result = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const { relationOrder, ...publicItem } = item;
      result.push(publicItem);
      if (result.length >= limit) break;
    }
    const matchingTopics = topicIds
      .map(tid => { const t = idx.topics[tid]; return t ? { id: tid, label: t.label, category: t.category } : null; })
      .filter(Boolean);
    if (result.length === 0 && matchingTopics.length === 0) return { hasContext: false, items: [] };
    return {
      hasContext: true, items: result, matchingTopics,
      hint: 'Entities linked to your specified topics. Use zhigui_get_note_detail / zhigui_get_goal_detail for full content.',
    };
  }

  // Rebuild the entire topic index by rescanning all goals/notes/errands/events.
  // Existing AI-authored topic IDs and labels are preserved; the engine never infers
  // new classifications from entity content while rebuilding associations.
  // IMPORTANT: this fully resets the index — old topics and category counts are cleared
  // before rescanning, so stale associations from deleted data don't linger.
  reindexAll() {
    const stats = { goals: 0, notes: 0, errands: 0, topicsCreated: 0, topicsLinked: 0 };

    // 0) Reset index — clear all topics and category counts, keep version/meta
    const oldIdx = this._readIndex();
    const freshIdx = {
      version: VERSION,
      meta: { ...oldIdx.meta, lastUpdated: ts() },
      topics: {},
      categories: {},
    };
    this._writeIndex(freshIdx);

    const touchedTopics = new Set();
    // Helper: look up topic by existing topicId (check if it still exists in fresh index after reset)
    // If the topic existed before, recreate it via ensureTopic using its original label/keywords
    const oldTopicsCache = oldIdx.topics || {};
    const lookupByTopicId = (topicId) => {
      if (!topicId) return null;
      const oldT = oldTopicsCache[topicId];
      if (!oldT) return null;
      // Recreate the topic with its original label/domain/category/keywords
      return this.ensureTopic(oldT.label, {
        domain: oldT.domain || 'misc',
        category: oldT.category,
        keywords: oldT.keywords || [],
      });
    };

    // 1) Re-scan goals (strategic + current + constraints)
    const g = this._read(this.files.goals, {});
    for (const key of ['strategicGoals', 'currentGoals', 'constraints']) {
      for (const item of (g[key] || [])) {
        // Rebuild associations only from explicit AI-authored links. The index must
        // never infer relevance from words in a goal title or description.
        const tid = lookupByTopicId(item.topicId);
        if (tid) {
          this.linkEntity(tid, 'goals', item.id);
          touchedTopics.add(tid);
          stats.topicsLinked++;
        }
        stats.goals++;
      }
    }

    // 2) Re-scan notes (flat array)
    const notesDoc = this._read(this.files.notes, { notes: [] });
    for (const note of (notesDoc.notes || [])) {
      // Imported/inbox notes remain in the single unclassified bucket until an AI
      // proposal is confirmed by the user.
      const tid = note.needsEnrichment ? null : lookupByTopicId(note.topicId);
      if (tid) {
        this.linkEntity(tid, 'notes', note.id);
        note.topicId = tid;
        touchedTopics.add(tid);
        stats.topicsLinked++;
      }
      stats.notes++;
    }
    // Persist notes with updated topicId
    this._write(this.files.notes, notesDoc);

    // 3) Re-scan errands
    const errDoc = this._read(this.files.errands, { errands: [] });
    for (const item of (errDoc.errands || [])) {
      const tid = lookupByTopicId(item.topicId);
      if (tid) {
        this.linkEntity(tid, 'actionItems', item.id);
        touchedTopics.add(tid);
        stats.topicsLinked++;
      }
      stats.errands++;
    }

    // 4) Re-scan schedule tasks → link each to the topic of its related goal (goal-derived action items)
    const schDoc = this._read(this.files.schedule, { days: {} });
    const goalTopic = new Map();
    for (const key of ['strategicGoals', 'currentGoals']) {
      for (const gItem of (g[key] || [])) if (gItem.id && gItem.topicId) goalTopic.set(gItem.id, gItem.topicId);
    }
    for (const day of Object.values(schDoc.days || {})) {
      for (const tk of (day.tasks || [])) {
        const gtid = tk.relatedGoalId && goalTopic.get(tk.relatedGoalId);
        if (gtid) {
          this.linkEntity(gtid, 'actionItems', tk.id);
          touchedTopics.add(gtid);
        }
      }
    }

    // 5) Reindex all touched topics (update note counts and foreign-key associations)
    for (const tid of touchedTopics) {
      this.reindexTopic(tid);
    }
    stats.topicsCreated = touchedTopics.size;

    // 6) Clean up empty categories (topicCount === 0)
    const finalIdx = this._readIndex();
    if (finalIdx.categories) {
      for (const [name, c] of Object.entries(finalIdx.categories)) {
        if (!c.topicCount || c.topicCount === 0) delete finalIdx.categories[name];
      }
      this._writeIndex(finalIdx);
    }

    return stats;
  }
}

module.exports = { BrainIndex, VERSION };
