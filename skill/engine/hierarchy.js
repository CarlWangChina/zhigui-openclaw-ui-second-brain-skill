/**
 * hierarchy.js — Hierarchical lazy-loading storage layer
 *
 * Solves: "reading full goals.json/notes.json/schedule.json every time wastes tokens"
 *
 * Architecture:
 *   Index files (small, always loaded):
 *     goals-index.json     — [{id, title, deadline, priority, completed, topicId, domain}]
 *     notes-index.json     — [{id, title, category, topicId, createdAt, needsEnrichment}]
 *     schedule-index.json  — { "2026-08-01": {taskCount, errandCount}, ... }
 *
 *   Detail files (larger, loaded on demand):
 *     goals/g_xxx.json     — full goal object (description, detail, aiReasoning, aiFactors, ...)
 *     notes/n_xxx.json     — full note object (content, sourceEventId, ...)
 *     schedule/2026-08-01.json — that day's tasks, errands, notes
 *
 * Flow:
 *   1. readState() returns lightweight state with indexes (not full content)
 *   2. When AI needs goal detail → lingxi_get_goal_detail(id) → reads goals/g_xxx.json
 *   3. When conflict detection needs a day → getDaySchedule("2026-08-01") → reads schedule/2026-08-01.json
 *   4. writeGoal() splits into index entry + detail file automatically
 */

const fs = require('fs');
const path = require('path');
const Storage = require('./storage');
const { GOAL_INDEX_FIELDS, NOTE_INDEX_FIELDS, pickIndexFields } = require('./constants');

class Hierarchy {
  constructor(dataDir) {
    this.dir = dataDir;
    this.goalsDir = path.join(dataDir, 'goals');
    this.notesDir = path.join(dataDir, 'notes');
    this.scheduleDir = path.join(dataDir, 'schedule');
    this.files = {
      goalsIndex: path.join(dataDir, 'goals-index.json'),
      notesIndex: path.join(dataDir, 'notes-index.json'),
      scheduleIndex: path.join(dataDir, 'schedule-index.json'),
    };
    this._init();
  }

  _init() {
    fs.mkdirSync(this.goalsDir, { recursive: true });
    fs.mkdirSync(this.notesDir, { recursive: true });
    fs.mkdirSync(this.scheduleDir, { recursive: true });
  }

  _read(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
  }

  _write(p, data) {
    return Storage.withLock('hierarchy', () => {
      Storage.writeJsonAtomic(p, data);
      return true;
    });
  }

  // ===== Goal index + detail =====

  /**
   * Get the lightweight goal index (always loaded, small).
   * Returns: [{id, title, deadline, priority, completed, topicId, domain, category}]
   */
  getGoalsIndex() {
    const idx = this._read(this.files.goalsIndex, { goals: [] });
    return idx.goals || [];
  }

  /**
   * Get full goal detail (loaded on demand).
   * Returns the complete goal object including description, aiReasoning, etc.
   */
  getGoalDetail(goalId) {
    const filePath = path.join(this.goalsDir, `${goalId}.json`);
    return this._read(filePath, null);
  }

  /**
   * Write a goal: updates the index + writes the detail file.
   * The index only stores lightweight fields; the detail file stores everything.
   */
  writeGoal(goal) {
    if (!goal || !goal.id) return false;
    // Update index with lightweight fields (Task 1.3: uses GOAL_INDEX_FIELDS from constants.js)
    const idx = this._read(this.files.goalsIndex, { goals: [] });
    const indexEntry = pickIndexFields(goal, GOAL_INDEX_FIELDS, {
      type: 'current', title: '', deadline: null, priority: 50,
      completed: false, locked: false, topicId: null, domain: 'misc',
      category: null, estimatedHours: null, scoreSource: 'rule',
      baseTitle: null, phaseName: null, relatedStrategicGoalId: null,
    });
    const existing = idx.goals.findIndex(g => g.id === goal.id);
    if (existing >= 0) {
      idx.goals[existing] = indexEntry;
    } else {
      idx.goals.push(indexEntry);
    }
    this._write(this.files.goalsIndex, idx);
    // Write detail file with full content
    this._write(path.join(this.goalsDir, `${goal.id}.json`), goal);
    return true;
  }

  /**
   * Write multiple goals at once (batch index update + individual detail files).
   */
  writeGoals(goals) {
    if (!goals || goals.length === 0) return false;
    const idx = this._read(this.files.goalsIndex, { goals: [] });
    for (const goal of goals) {
      if (!goal || !goal.id) continue;
      // Task 1.3: uses GOAL_INDEX_FIELDS — normalized with writeGoal (no description/detail in index)
      const indexEntry = pickIndexFields(goal, GOAL_INDEX_FIELDS, {
        type: 'current', title: '', deadline: null, priority: 50,
        completed: false, locked: false, topicId: null, domain: 'misc',
        category: null, estimatedHours: null, scoreSource: 'rule',
        baseTitle: null, phaseName: null, relatedStrategicGoalId: null,
      });
      const existing = idx.goals.findIndex(g => g.id === goal.id);
      if (existing >= 0) {
        idx.goals[existing] = indexEntry;
      } else {
        idx.goals.push(indexEntry);
      }
      // Write detail file
      this._write(path.join(this.goalsDir, `${goal.id}.json`), goal);
    }
    this._write(this.files.goalsIndex, idx);
    return true;
  }

  deleteGoal(goalId) {
    // Remove from index
    const idx = this._read(this.files.goalsIndex, { goals: [] });
    idx.goals = idx.goals.filter(g => g.id !== goalId);
    this._write(this.files.goalsIndex, idx);
    // Delete detail file
    try { fs.unlinkSync(path.join(this.goalsDir, `${goalId}.json`)); } catch {}
    return true;
  }

  /**
   * Update only the index fields (without rewriting the detail file).
   * Used by recalcPriorities which only changes priority/daysLeft/overdue.
   */
  updateGoalIndex(goalId, fields) {
    const idx = this._read(this.files.goalsIndex, { goals: [] });
    const entry = idx.goals.find(g => g.id === goalId);
    if (!entry) return false;
    Object.assign(entry, fields);
    this._write(this.files.goalsIndex, idx);
    return true;
  }

  // ===== Note index + detail =====

  getNotesIndex() {
    const idx = this._read(this.files.notesIndex, { notes: [] });
    return idx.notes || [];
  }

  getNoteDetail(noteId) {
    const filePath = path.join(this.notesDir, `${noteId}.json`);
    return this._read(filePath, null);
  }

  writeNote(note) {
    if (!note || !note.id) return false;
    const idx = this._read(this.files.notesIndex, { notes: [] });
    // Task 1.3: uses NOTE_INDEX_FIELDS from constants.js
    const indexEntry = pickIndexFields(note, NOTE_INDEX_FIELDS, {
      title: '待 AI 归纳', category: null, domain: 'misc', topicId: null,
      createdAt: new Date().toISOString(), relatedDate: null, needsEnrichment: false,
    });
    const existing = idx.notes.findIndex(n => n.id === note.id);
    if (existing >= 0) {
      idx.notes[existing] = indexEntry;
    } else {
      idx.notes.push(indexEntry);
    }
    this._write(this.files.notesIndex, idx);
    this._write(path.join(this.notesDir, `${note.id}.json`), note);
    return true;
  }

  writeNotes(notes) {
    if (!notes || notes.length === 0) return false;
    const idx = this._read(this.files.notesIndex, { notes: [] });
    for (const note of notes) {
      if (!note || !note.id) continue;
      // Task 1.3: uses NOTE_INDEX_FIELDS from constants.js
      const indexEntry = pickIndexFields(note, NOTE_INDEX_FIELDS, {
        title: '待 AI 归纳', category: null, domain: 'misc', topicId: null,
        createdAt: new Date().toISOString(), relatedDate: null, needsEnrichment: false,
      });
      const existing = idx.notes.findIndex(n => n.id === note.id);
      if (existing >= 0) {
        idx.notes[existing] = indexEntry;
      } else {
        idx.notes.push(indexEntry);
      }
      this._write(path.join(this.notesDir, `${note.id}.json`), note);
    }
    this._write(this.files.notesIndex, idx);
    return true;
  }

  deleteNote(noteId) {
    const idx = this._read(this.files.notesIndex, { notes: [] });
    idx.notes = idx.notes.filter(n => n.id !== noteId);
    this._write(this.files.notesIndex, idx);
    try { fs.unlinkSync(path.join(this.notesDir, `${noteId}.json`)); } catch {}
    return true;
  }

  // ===== Schedule per-day files =====

  /**
   * Get the schedule index: which dates have records.
   * Returns: { "2026-08-01": {taskCount, errandCount}, ... }
   */
  getScheduleIndex() {
    const idx = this._read(this.files.scheduleIndex, { days: {} });
    return idx.days || {};
  }

  /**
   * Get a specific day's schedule (tasks, errands, notes for that day).
   * Auto-creates an empty day file if it doesn't exist.
   * This is the key function for conflict detection — only reads ONE day, not all schedule.
   */
  getDaySchedule(date) {
    if (!date) return null;
    const filePath = path.join(this.scheduleDir, `${date}.json`);
    let day = this._read(filePath, null);
    if (!day) {
      // Auto-create empty day file
      day = {
        date,
        tasks: [],
        errands: [],
        dayNotes: [],
        createdAt: new Date().toISOString(),
      };
      this._write(filePath, day);
      // Update index
      const idx = this._read(this.files.scheduleIndex, { days: {} });
      idx.days[date] = { taskCount: 0, errandCount: 0, createdAt: day.createdAt };
      this._write(this.files.scheduleIndex, idx);
    }
    return day;
  }

  /**
   * Write a day's schedule (creates/updates the per-day file + index).
   */
  writeDaySchedule(date, dayData) {
    if (!date) return false;
    const filePath = path.join(this.scheduleDir, `${date}.json`);
    dayData.date = date;
    dayData.updatedAt = new Date().toISOString();
    this._write(filePath, dayData);
    // Update index
    const idx = this._read(this.files.scheduleIndex, { days: {} });
    idx.days[date] = {
      taskCount: (dayData.tasks || []).length,
      errandCount: (dayData.errands || []).length,
      updatedAt: dayData.updatedAt,
    };
    this._write(this.files.scheduleIndex, idx);
    return true;
  }

  /**
   * Get multiple days in a range (for weekly view).
   * Only reads the days that exist — doesn't create empty files for every day in range.
   */
  getDaysInRange(startDate, endDate) {
    const result = {};
    const index = this.getScheduleIndex();
    const start = new Date(startDate);
    const end = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      if (index[dateStr]) {
        result[dateStr] = this.getDaySchedule(dateStr);
      }
    }
    return result;
  }

  /**
   * Add a task/errand to a specific day (without reading the full schedule).
   */
  addItemToDay(date, type, item) {
    const day = this.getDaySchedule(date); // auto-creates if not exists
    if (type === 'task') {
      day.tasks = day.tasks || [];
      day.tasks.push(item);
    } else if (type === 'errand') {
      day.errands = day.errands || [];
      day.errands.push(item);
    } else if (type === 'note') {
      day.dayNotes = day.dayNotes || [];
      day.dayNotes.push(item);
    }
    return this.writeDaySchedule(date, day);
  }

  deleteDaySchedule(date) {
    try { fs.unlinkSync(path.join(this.scheduleDir, `${date}.json`)); } catch {}
    const idx = this._read(this.files.scheduleIndex, { days: {} });
    delete idx.days[date];
    this._write(this.files.scheduleIndex, idx);
    return true;
  }

  // ===== Migration from legacy flat files =====

  /**
   * One-time migration: convert existing goals.json/notes.json/schedule.json
   * to the hierarchical structure (index + detail files).
   * Safe to call multiple times — skips if already migrated.
   */
  migrateFromLegacy(state) {
    const stats = { goalsMigrated: 0, notesMigrated: 0, daysMigrated: 0 };

    // Migrate goals (strategicGoals + currentGoals + constraints)
    if (state.currentGoals || state.strategicGoals || state.constraints) {
      const allGoals = [
        ...(state.strategicGoals || []).map(g => ({ ...g, type: 'strategic' })),
        ...(state.currentGoals || []).map(g => ({ ...g, type: 'current' })),
        ...(state.constraints || []).map(g => ({ ...g, type: 'constraint' })),
      ].filter(g => g && g.id);
      if (allGoals.length > 0) {
        this.writeGoals(allGoals);
        stats.goalsMigrated = allGoals.length;
      }
    }

    // Migrate notes (state.notes is a flat array with topicId as sole classification)
    if (state.notes) {
      const allNotes = Array.isArray(state.notes)
        ? state.notes.filter(n => n && n.id)
        : Object.values(state.notes || {}).flat().filter(n => n && n.id);
      if (allNotes.length > 0) {
        this.writeNotes(allNotes);
        stats.notesMigrated = allNotes.length;
      }
    }

    // Migrate schedule (schedule.json has { days: { "2026-08-01": { tasks, ... } } })
    if (state.schedule && state.schedule.days) {
      for (const [date, dayData] of Object.entries(state.schedule.days)) {
        this.writeDaySchedule(date, dayData);
        stats.daysMigrated++;
      }
    }

    return stats;
  }

  /**
   * Check if migration is needed (index files don't exist yet).
   */
  needsMigration() {
    const goalsIdx = this._read(this.files.goalsIndex, null);
    const notesIdx = this._read(this.files.notesIndex, null);
    const scheduleIdx = this._read(this.files.scheduleIndex, null);
    if (goalsIdx === null || notesIdx === null || scheduleIdx === null) return true;

    // Early versions created empty hierarchy indexes beside non-empty legacy files.
    // Treat that as an incomplete migration instead of silently hiding the records.
    try {
      const flatNotes = this._read(path.join(this.dir, 'notes.json'), { notes: [] });
      if ((flatNotes.notes || []).length > (notesIdx.notes || []).length) return true;
      const flatSchedule = this._read(path.join(this.dir, 'schedule.json'), { schedule: { days: {} } });
      const flatDays = Object.keys(flatSchedule.schedule?.days || {}).length;
      if (flatDays > Object.keys(scheduleIdx.days || {}).length) return true;
    } catch {}
    return false;
  }

  /**
   * Get full state from hierarchical files (for backward compatibility).
   * Reconstructs the legacy state shape from index + detail files.
   * WARNING: this defeats the purpose of lazy loading — only use when truly needed.
   */
  getFullState() {
    const goalsIdx = this.getGoalsIndex();
    const notesIdx = this.getNotesIndex();
    const scheduleIdx = this.getScheduleIndex();

    // Reconstruct goals
    const strategicGoals = [];
    const currentGoals = [];
    const constraints = [];
    for (const gEntry of goalsIdx) {
      const full = this.getGoalDetail(gEntry.id) || gEntry;
      // Classify back to the right array (based on a type field or heuristic)
      if (full.type === 'strategic' || full.kind === 'strategic') {
        strategicGoals.push(full);
      } else if (full.type === 'constraint' || full.kind === 'constraint') {
        constraints.push(full);
      } else {
        currentGoals.push(full);
      }
    }

    // Reconstruct notes (flat array)
    const notes = [];
    for (const nEntry of notesIdx) {
      const full = this.getNoteDetail(nEntry.id) || nEntry;
      notes.push(full);
    }

    // Reconstruct schedule
    const days = {};
    for (const date of Object.keys(scheduleIdx)) {
      days[date] = this.getDaySchedule(date);
    }

    return {
      strategicGoals,
      currentGoals,
      constraints,
      notes,
      schedule: { days },
    };
  }
}

module.exports = { Hierarchy };
