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
 *     accepts the proposal in the review queue.
 *  3) One-click cascade delete (foreign-key-like): deleting a topic automatically deletes all
 *     its associated goals/schedule tasks/errands/notes, leaving no orphan data.
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

class BrainIndex {
  constructor(dataDir) {
    this.dir = dataDir;
    this.topicsDir = path.join(dataDir, 'topics');
    this.files = {
      notes: path.join(dataDir, 'notes.json'),
      goals: path.join(dataDir, 'goals.json'),
      schedule: path.join(dataDir, 'schedule.json'),
      errands: path.join(dataDir, 'errands.json'),
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
    try {
      fs.writeFileSync(this.files.library, JSON.stringify(library, null, 2), 'utf8');
      return true;
    } catch { return false; }
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

  // Update library (add/modify categories and topics) — called by lingxi_update_library
  updateLibrary(changes) {
    const library = this._readLibrary();
    const stats = { categoriesAdded: 0, topicsAdded: 0, topicsUpdated: 0 };

    // Add/update categories
    if (changes.categories) {
      for (const [name, data] of Object.entries(changes.categories)) {
        if (!library.categories[name]) {
          library.categories[name] = { icon: data.icon || '📁', topics: data.topics || [] };
          stats.categoriesAdded++;
        } else {
          if (data.icon) library.categories[name].icon = data.icon;
          if (data.topics) library.categories[name].topics = data.topics;
        }
      }
    }

    // Add/update topics
    if (changes.topics) {
      for (const [label, data] of Object.entries(changes.topics)) {
        if (!library.topics[label]) {
          library.topics[label] = {
            keywords: data.keywords || [],
            category: data.category || null,
            builtIn: false,
            createdAt: ts(),
          };
          // Add to category
          const cat = library.topics[label].category;
          if (cat) {
            if (!library.categories[cat]) library.categories[cat] = { icon: '📁', topics: [] };
            if (!library.categories[cat].topics.includes(label)) library.categories[cat].topics.push(label);
          }
          stats.topicsAdded++;
        } else {
          if (data.keywords) library.topics[label].keywords = data.keywords;
          if (data.category) {
            // Remove from old category
            const oldCat = library.topics[label].category;
            if (library.categories[oldCat]) {
              library.categories[oldCat].topics = library.categories[oldCat].topics.filter(t => t !== label);
            }
            library.topics[label].category = data.category;
            // Add to new category
            if (!library.categories[data.category]) library.categories[data.category] = { icon: '📁', topics: [] };
            if (!library.categories[data.category].topics.includes(label)) {
              library.categories[data.category].topics.push(label);
            }
          }
          stats.topicsUpdated++;
        }
      }
    }

    this._writeLibrary(library);
    return { success: true, stats, library };
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
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        return true;
      });
      // After writing split documents, sync to state.json so Electron reads fresh data.
      // Isolated try-catch: failure here must NOT prevent the primary file write.
      try { Storage.syncStateJson(); } catch {}
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
    this._write(this.files.index, idx);
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
    const existing = Object.values(idx.topics).find(t => t.label === label);
    if (existing) {
      const set = new Set([...(existing.keywords || []), ...keywords]);
      existing.keywords = [...set];
      // Update category if AI provides a new one (AI's latest judgment takes priority)
      if (category && category !== existing.category) {
        this._updateCategoryCount(idx, existing.category, -1);
        existing.category = category;
        this._updateCategoryCount(idx, category, 1);
      }
      existing.updatedAt = ts();
      this._writeIndex(idx);
      return existing.id;
    }
    const id = slug(label);
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

  // Read a topic document on demand (only loads that topic, saving tokens)
  getTopicDocument(topicId) {
    const idx = this._readIndex();
    const t = idx.topics[topicId];
    if (!t) return null;
    const notesDoc = this._read(this.files.notes, { notes: [] });
    const candidates = new Map();
    for (const note of (notesDoc.notes || [])) {
      if (note && (note.topicId === topicId || (t.related?.notes || []).includes(note.id))) candidates.set(note.id, note);
    }
    // Read legacy precipitated files only as a recovery source; do not make them a
    // primary store again. Storage.getNoteDetail wins whenever it is available.
    if (t.precipitated && t.file) {
      const archive = this._read(path.join(this.dir, t.file), { notes: [] });
      for (const note of (archive.notes || [])) if (note?.id) candidates.set(note.id, note);
    }
    const notes = [...candidates.values()].map(note => Storage.getNoteDetail(note.id) || note);
    return { topicId, label: t.label, keywords: t.keywords || [], domain: t.domain || 'misc', precipitated: false, notes };
  }

  getTopics() {
    const idx = this._readIndex();
    const dynamic = Object.values(idx.topics);

    // Merge built-in library topics so the Library view is never empty on fresh start
    let builtIn = [];
    try {
      const libPath = path.join(this.dir, 'library.json');
      if (fs.existsSync(libPath)) {
        const lib = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
        // Only surface library seeds whose label is NOT already an existing (dynamic) topic,
        // otherwise the same topic would appear twice (once as dynamic, once as built-in).
        builtIn = Object.entries(lib.topics || {})
          .filter(([label]) => !dynamic.some(t => t.label === label))
          .map(([label, data]) => ({
            id: null, // built-in topics have no index id until activated
            label,
            domain: 'misc',
            category: data.category || 'Other',
            keywords: data.keywords || [],
            noteCount: 0,
            precipitated: false,
            file: null,
            builtIn: true,
            relatedCounts: { notes: 0, goals: 0, actionItems: 0 },
          }));
      }
    } catch {}

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

    return [...dynamic, ...builtIn]
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
  cascadeDelete(topicId, opts = {}) {
    const dryRun = !!(opts && opts.dryRun);
    // P0-2.2: Stale data detection — record notes.json mtime before reading.
    const startMtime = this._statMtime(this.files.notes);
    const idx = this._readIndex();
    const t = idx.topics[topicId];
    if (!t) return { error: 'topic not found', topicId };

    const rel = t.related || {};
    // Tasks and errands share the unified actionItems bucket (reference only; the underlying
    // schedule.json tasks and errands.json files stay separate). Tolerate legacy tasks/errands keys.
    const actionItemIds = [...new Set([...(rel.actionItems || []), ...(rel.tasks || []), ...(rel.errands || [])])];
    const manifest = {
      label: t.label,
      goals: [],
      actionItems: [],
      notes: [],
    };

    // 1) Goals — collect deleted ids for orphan-task reverse lookup
    const g = this._read(this.files.goals, {});
    const deletedGoalIds = new Set();
    for (const key of ['strategicGoals', 'currentGoals', 'constraints']) {
      if (!g[key]) continue;
      for (const x of g[key]) {
        if ((rel.goals || []).includes(x.id)) {
          manifest.goals.push({ id: x.id, title: x.title || x.id, type: key });
          deletedGoalIds.add(x.id);
        }
      }
    }

    // 2) Schedule tasks (goal-derived action items) — actionItemIds OR orphaned via relatedGoalId
    const sch = this._read(this.files.schedule, { days: {} });
    for (const day of Object.values(sch.days || {})) {
      if (!day.tasks) continue;
      for (const tk of day.tasks) {
        if (actionItemIds.includes(tk.id) ||
            (tk.relatedGoalId && deletedGoalIds.has(tk.relatedGoalId)) ||
            (tk.relatedStrategicGoalId && deletedGoalIds.has(tk.relatedStrategicGoalId))) {
          manifest.actionItems.push({
            id: tk.id,
            kind: 'task',
            title: tk.title || tk.id,
            date: day.date,
            relatedGoalId: tk.relatedGoalId || null,
          });
        }
      }
    }

    // 3) Errands (life to-dos not bound to goals) — also land in the actionItems bucket
    const er = this._read(this.files.errands, { errands: [] });
    for (const e of (er.errands || [])) {
      if (actionItemIds.includes(e.id)) {
        manifest.actionItems.push({ id: e.id, kind: 'errand', title: e.title || e.id, priority: e.priority });
      }
    }

    // 5) Notes (precipitated file + leftovers in notes.json)
    const notesDoc = this._read(this.files.notes, { notes: [] });
    for (const n of (notesDoc.notes || [])) {
      if ((rel.notes || []).includes(n.id) || n.topicId === topicId) {
        manifest.notes.push({ id: n.id, title: n.title || '待 AI 归纳', domain: n.domain || 'misc', needsEnrichment: n.needsEnrichment === true });
      }
    }
    if (t.precipitated && t.file) {
      try {
        const tf = this._read(path.join(this.dir, t.file), { notes: [] });
        for (const n of (tf.notes || [])) {
          manifest.notes.push({ id: n.id, title: n.title || '待 AI 归纳', domain: n.domain || 'misc', needsEnrichment: n.needsEnrichment === true, precipitated: true });
        }
      } catch {}
    }

    if (dryRun) {
      const counts = {
        goals: manifest.goals.length,
        actionItems: manifest.actionItems.length,
        notes: manifest.notes.length,
        topicFile: !!(t.precipitated && t.file),
      };
      return { aborted: true, preview: true, topicId, label: t.label, counts, manifest };
    }

    // P0-2.2: If notes.json changed during the read-recompute window, abort the
    // deletion — the manifest was built from stale data and deleting based on it
    // could remove the wrong entities or miss new ones.
    this._checkStale(this.files.notes, startMtime);

    // ---- Actual deletion (only when NOT dryRun) ----
    // 1) Goals
    for (const key of ['strategicGoals', 'currentGoals', 'constraints']) {
      if (!g[key]) continue;
      g[key] = g[key].filter(x => !(rel.goals || []).includes(x.id));
    }
    this._write(this.files.goals, g);

    // 2) Schedule tasks (actionItems + orphan reverse lookup)
    for (const day of Object.values(sch.days || {})) {
      if (!day.tasks) continue;
      day.tasks = day.tasks.filter(tk =>
        !actionItemIds.includes(tk.id) &&
        !(tk.relatedGoalId && deletedGoalIds.has(tk.relatedGoalId)) &&
        !(tk.relatedStrategicGoalId && deletedGoalIds.has(tk.relatedStrategicGoalId))
      );
    }
    this._write(this.files.schedule, sch);

    // 3) Errands
    const erBefore = (er.errands || []).length;
    er.errands = (er.errands || []).filter(x => !actionItemIds.includes(x.id));
    if (er.errands.length !== erBefore) this._write(this.files.errands, er);

    // 5) Notes (precipitated file + leftovers in notes.json)
    if (t.precipitated && t.file) {
      try { fs.unlinkSync(path.join(this.dir, t.file)); } catch {}
    }
    notesDoc.notes = (notesDoc.notes || []).filter(n => !(rel.notes || []).includes(n.id) && n.topicId !== topicId);
    this._write(this.files.notes, notesDoc);

    delete idx.topics[topicId];
    this._writeIndex(idx);

    // P1-2.6: Also remove the topic from library.json. ensureTopic() mirrors every
    // dynamic topic into library.json, and getTopics() re-synthesizes any library
    // seed that is NOT yet a dynamic topic as a built-in (id:null). Without this
    // step the deleted topic would linger in the topic list forever (visible but
    // un-deletable from the panel).
    //
    // Audit confirms cleanup covers ALL four residue locations:
    //   1. library.topics[label]            — top-level topic entry
    //   2. library.categories[].topics[]    — nested topic-label arrays
    //   3. index.json topics[tid]           — deleted above via `delete idx.topics[topicId]`
    //   4. index.json related foreign keys  — deleted with the topic entry (related is
    //      a property of idx.topics[tid], so removing the topic removes its FK table)
    //
    // Bug fix: the category cleanup was previously gated behind
    // `lib.topics[t.label]` existing. If a topic label appeared in a category's
    // topics[] list but not in library.topics (data inconsistency), the nested
    // array cleanup was silently skipped. The cleanup now runs unconditionally.
    try {
      const lib = this._readLibrary();
      if (lib) {
        // 1) Remove from library.topics (keyed by label)
        if (lib.topics) {
          delete lib.topics[t.label];
        }
        // 2) Remove from every category's topics[] array (nested array cleanup)
        if (lib.categories) {
          for (const cat of Object.values(lib.categories)) {
            if (cat && Array.isArray(cat.topics)) {
              cat.topics = cat.topics.filter(x => x !== t.label);
            }
          }
        }
        this._writeLibrary(lib);
      }
    } catch (e) { /* ignore library cleanup failure */ }

    // Sync flat-file changes back to hierarchy so Storage.readFullState() sees them
    try {
      const Storage = require('./storage');
      Storage.syncHierarchyFromFlatFiles();
    } catch (e) { /* ignore sync failure */ }

    return {
      success: true,
      topicId,
      label: t.label,
      deleted: {
        goals: manifest.goals.length,
        actionItems: manifest.actionItems.length,
        notes: manifest.notes.length,
        topicFile: !!(t.precipitated && t.file),
      },
    };
  }

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
    (er.errands || []).filter(x => actionItemIds.includes(x.id)).forEach(x => actionItems.push({ id: x.id, kind: 'errand', title: x.title, priority: x.priority }));
    result.related.actionItems = actionItems;
    const doc = this.getTopicDocument(topicId);
    result.related.notes = (doc && doc.notes) || [];
    return result;
  }

  // Global search: across topics/notes/goals/events; hits include their topic attribution
  // Fuzzy match: query "eng" matches topic "English Speaking" (case-insensitive substring)
  search(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return { query, total: 0, hits: [] };
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
          text: t.label + (count > 0 ? ` (${count} items)` : ''),
          id: t.id,
        });
      }
    }

    // 2) Search notes (both in notes.json and in precipitated topic files)
    const notesDoc = this._read(this.files.notes, { notes: [] });
    for (const n of (notesDoc.notes || [])) {
      if ((n.content || '').toLowerCase().includes(q)) hits.push({ type: 'note', domain: n.domain || 'misc', topicId: n.topicId, text: n.content, id: n.id });
    }
    for (const t of Object.values(idx.topics)) {
      if (t.precipitated && t.file) {
        const doc = this._read(path.join(this.dir, t.file), { notes: [] });
        for (const n of (doc.notes || [])) {
          if ((n.content || '').toLowerCase().includes(q)) hits.push({ type: 'note', domain: n.domain, topicId: t.id, topicLabel: t.label, text: n.content, id: n.id });
        }
      }
    }
    // 3) Search goals
    const g = this._read(this.files.goals, {});
    for (const key of ['strategicGoals', 'currentGoals', 'constraints']) {
      for (const x of (g[key] || [])) {
        if ((x.title || '').toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)) {
          hits.push({ type: 'goal', subtype: key, text: x.title, id: x.id, topicId: x.topicId });
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
    return { query, total: unique.length, hits: unique };
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
    let _flatGoals = null, _flatNotes = null;
    function _getFlatGoals() {
      if (!_flatGoals) { try { _flatGoals = JSON.parse(require('fs').readFileSync(this.files.goals, 'utf-8')); } catch { _flatGoals = {}; } }
      return _flatGoals;
    }
    function _getFlatNotes() {
      if (!_flatNotes) { try { _flatNotes = JSON.parse(require('fs').readFileSync(this.files.notes, 'utf-8')); } catch { _flatNotes = {}; } }
      return _flatNotes;
    }
    _getFlatGoals = _getFlatGoals.bind(this);
    _getFlatNotes = _getFlatNotes.bind(this);

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
          type: 'goal', id: goalId, topicId: tid, topicLabel: t.label, score: 4,
          title: goal?.title || goalId,
          deadline: goal?.deadline || null,
          priority: goal?.priority || null,
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
          type: 'note', id: noteId, topicId: tid, topicLabel: t.label, score: 3,
          title: note?.title || '待 AI 归纳',
          needsEnrichment: note?.needsEnrichment === true,
          createdAt: note?.createdAt || null,
        });
      }
      if (t.precipitated && t.file) {
        const doc = this.getTopicDocument(tid);
        for (const n of (doc.notes || [])) {
          items.push({ type: 'note', id: n.id, title: n.title || '待 AI 归纳', needsEnrichment: n.needsEnrichment === true, topicId: tid, topicLabel: t.label, score: 3, createdAt: n.createdAt });
        }
      }
    }
    items.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const result = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
      if (result.length >= limit) break;
    }
    const matchingTopics = topicIds
      .map(tid => { const t = idx.topics[tid]; return t ? { id: tid, label: t.label, category: t.category } : null; })
      .filter(Boolean);
    if (result.length === 0 && matchingTopics.length === 0) return { hasContext: false, items: [] };
    return {
      hasContext: true, items: result, matchingTopics,
      hint: 'Entities linked to your specified topics. Use lingxi_get_note_detail / lingxi_get_goal_detail for full content.',
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
