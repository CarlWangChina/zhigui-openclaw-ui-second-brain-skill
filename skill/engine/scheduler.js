/**
 * engine/scheduler.js
 *
 * Extracted from server.js auto_schedule (Task 1.1).
 * All scheduling sub-functions are pure or explicitly annotated with side effects.
 *
 * Sub-functions:
 *   - computePhaseRanges(allActiveGoals, startDateStr) → { phaseRanges, activeGoals }
 *   - parseConstraintRules(constraints) → { constraintRules, latestTaskTime, restDays, dailyExercise, dailyAvailableHours }
 *   - scheduleSingleDay(opts) → { generatedDay, dayNotes, decisionCount }
 *   - analyzeNotesContext(notes, dateStr) → { intensityModifier, signals, recentNoteCount }
 *   - generateBriefings(opts) → mutates state.briefings + state.morningBriefing
 *   - detectAndMergeConflicts(state, activeGoals, dailySlots, detectConflictsFn) → mutates state.conflicts
 *
 * Helper functions:
 *   - isOneShotGoal(g), mapGoalToDomain(goal), getDomainWeight(domain, valueSystem)
 *   - getProfileAwareSlots(workHabit, latestTaskTime, latestHour, chronotype)
 *   - genId(prefix), daysBetween(dateStr)
 *
 * Dependencies: ./date-utils, ./attention-engine.
 */

const DateUtils = require('./date-utils');
const AttentionEngine = require('./attention-engine');
const logger = require('./logger');

// ─── Constants ────────────────────────────────────────────────────────────

const DOMAIN_ALIAS = {
  'family_health': 'health',
  'academic': 'learning',
  'personal_growth': 'learning',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Utility functions ────────────────────────────────────────────────────

/**
 * Generate a unique ID with a prefix.
 * @param {string} prefix - ID prefix (e.g. 't', 'g', 'n')
 * @returns {string} Unique ID string
 */
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Calculate days between today and a date string.
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number|null} Days difference (negative = past)
 */
function daysBetween(dateStr) {
  if (!dateStr) return null;
  return DateUtils.daysBetween(dateStr);
}

/**
 * Get today's date string in YYYY-MM-DD format.
 * @returns {string}
 */
function todayStr() {
  return DateUtils.todayStr();
}

// ─── Second-brain helper functions ────────────────────────────────────────

/**
 * Determine whether a goal is a "one-shot event" (e.g. dentist appointment, interview).
 * AI-DRIVEN: the AI sets g.isOneShot = true when creating the goal.
 * @param {Object} g - Goal object
 * @returns {boolean}
 */
function isOneShotGoal(g) {
  return g.isOneShot === true;
}

/**
 * Map a goal to one of the six domains (for value-weight sorting).
 * AI-DRIVEN: the AI sets goal.domain when creating the goal.
 * @param {Object} goal - Goal object
 * @returns {string} Domain name
 */
function mapGoalToDomain(goal) {
  return goal.domain || 'misc';
}

/**
 * Look up a domain weight (0-100) from valueSystem.
 * Handles both new domain names (health/family/learning) and legacy names.
 * @param {string} domain - Domain name
 * @param {Object} valueSystem - User's value system with priorities array
 * @returns {number} Weight 0-100
 */
function getDomainWeight(domain, valueSystem) {
  if (!valueSystem || !valueSystem.priorities) return 50;
  const key = String(domain || '').trim().toLowerCase();
  const normalizedDomain = DOMAIN_ALIAS[key] || key;
  const entry = valueSystem.priorities.find(p => {
    const pk = String(p.domain || '').trim().toLowerCase();
    return pk === key || pk === normalizedDomain || DOMAIN_ALIAS[pk] === normalizedDomain;
  });
  if (entry) return entry.weight;
  if (domain) logger.debug(`[scheduler] Unknown domain "${domain}", falling back to weight 50`);
  return 50;
}

/**
 * Analyze the note content of the last 7 days; return an intensity-adjustment factor and signals.
 * AI-DRIVEN: note mood/signal is set by AI when creating notes.
 * @param {Array|Object} notes - Notes array or object
 * @param {string} dateStr - Reference date in YYYY-MM-DD format
 * @returns {{ intensityModifier: number, signals: Array, recentNoteCount: number }}
 */
function analyzeNotesContext(notes, dateStr) {
  const recentNotes = [];
  const cutoffStr = DateUtils.nextDay(dateStr, -7);

  const allNotes = Array.isArray(notes) ? notes : Object.values(notes || {}).flat();
  for (const note of allNotes) {
    if (!note || typeof note !== 'object') continue;
    const noteDate = (note.createdAt || '').split('T')[0];
    if (noteDate >= cutoffStr && noteDate <= dateStr) {
      recentNotes.push(note);
    }
  }

  let intensityModifier = 1.0;
  const signals = [];

  const healthNegNotes = recentNotes.filter(n => n.signal === 'health_negative');
  if (healthNegNotes.length > 0) {
    const reduction = Math.min(healthNegNotes.length * 0.1, 0.4);
    intensityModifier -= reduction;
    signals.push({
      type: 'health_negative',
      impact: `-${Math.round(reduction * 100)}%`,
      reason: `Recent ${healthNegNotes.length} health-negative note(s) (AI-classified)`,
    });
  }

  const stressNotes = recentNotes.filter(n => n.signal === 'emotional_stress');
  if (stressNotes.length > 0) {
    const reduction = Math.min(stressNotes.length * 0.08, 0.2);
    intensityModifier -= reduction;
    signals.push({
      type: 'emotional_stress',
      impact: `-${Math.round(reduction * 100)}%`,
      reason: `Recent ${stressNotes.length} emotional-stress note(s) (AI-classified)`,
    });
  }

  const positiveNotes = recentNotes.filter(n => n.signal === 'positive');
  if (positiveNotes.length > 0) {
    const boost = Math.min(positiveNotes.length * 0.05, 0.15);
    intensityModifier = Math.min(intensityModifier + boost, 1.0);
    signals.push({
      type: 'positive',
      impact: `+${Math.round(boost * 100)}%`,
      reason: `Recent ${positiveNotes.length} positive note(s) (AI-classified)`,
    });
  }

  intensityModifier = Math.max(intensityModifier, 0.3);
  return { intensityModifier, signals, recentNoteCount: recentNotes.length };
}

/**
 * Return personalized time slots based on the user profile.
 * AI-DRIVEN: uses structured chronotype field set by AI in update_user_profile.
 * @param {string} workHabit - Work habit description (unused but kept for API compat)
 * @param {string} latestTaskTime - Latest allowed task time (HH:MM)
 * @param {number} latestHour - Latest hour as integer
 * @param {string} chronotype - 'night_owl' | 'early_bird' | 'standard'
 * @returns {{ slots: Array, profile: string, note: string }}
 */
function getProfileAwareSlots(workHabit, latestTaskTime, latestHour, chronotype) {
  const profile = chronotype || 'standard';
  if (profile === 'night_owl') {
    return {
      slots: [
        { start: '10:00', end: '12:00', label: 'Regular slot', intensity: 'mid', hours: 2 },
        { start: '14:00', end: '17:00', label: 'Prime slot', intensity: 'high', hours: 3 },
        { start: '19:00', end: latestTaskTime, label: 'Deep slot', intensity: 'high', hours: Math.max(latestHour - 19, 0) },
      ],
      profile: 'night_owl',
      note: 'Night-owl routine; prime slot shifted to afternoon and evening',
    };
  }
  if (profile === 'early_bird') {
    return {
      slots: [
        { start: '07:00', end: '10:00', label: 'Prime slot', intensity: 'high', hours: 3 },
        { start: '10:00', end: '12:00', label: 'Regular slot', intensity: 'mid', hours: 2 },
        { start: '14:00', end: '17:00', label: 'Light slot', intensity: 'low', hours: 3 },
      ],
      profile: 'early_bird',
      note: 'Early-bird routine; prime slot shifted to morning',
    };
  }
  return {
    slots: [
      { start: '09:00', end: '12:00', label: 'Prime slot', intensity: 'high', hours: 3 },
      { start: '14:00', end: '17:00', label: 'Regular slot', intensity: 'mid', hours: 3 },
      { start: '19:00', end: latestTaskTime, label: 'Light slot', intensity: 'low', hours: Math.max(latestHour - 19, 0) },
    ],
    profile: 'standard',
    note: 'Standard routine slots',
  };
}

// ─── Task 3.3: Pre-computation functions (move loop-invariant work outside the daily loop) ──

/**
 * Pre-compute descriptive goal metadata for a schedule that the assistant has
 * already selected. These fields explain a placement; they never select it.
 *
 * @param {Array} activeGoals - All active (incomplete) goals
 * @param {Object} state - Full state (for userProfile valueSystem)
 * @param {Object} valueSystem - User's value system
 * @returns {Array} Enriched goal objects with _domain and _domainWeight
 */
function precomputeGoalEnrichment(activeGoals, state, valueSystem) {
  return activeGoals.map(g => {
    const domain = mapGoalToDomain(g);
    const domainWeight = getDomainWeight(domain, valueSystem);
    return { ...g, _domain: domain, _domainWeight: domainWeight };
  });
}

/**
 * Pre-compute note signals for quick per-day analysis.
 * Instead of re-iterating all notes and creating Date objects on each day, we pre-categorize
 * notes by signal type and pre-compute their date strings. The per-day analyzeNotesContextFast
 * then just filters by pre-computed date strings — no Date object creation in the hot loop.
 *
 * @param {Array|Object} notes - Notes array or object
 * @returns {{ bySignal: Object, allSorted: Array }} Pre-categorized notes
 */
function precomputeNoteSignals(notes) {
  const allNotes = Array.isArray(notes) ? notes : Object.values(notes || {}).flat();
  const bySignal = {
    health_negative: [],
    emotional_stress: [],
    positive: [],
  };
  const allSorted = [];
  for (const note of allNotes) {
    if (!note || typeof note !== 'object') continue;
    const noteDate = (note.createdAt || '').split('T')[0];
    const entry = { note, date: noteDate };
    allSorted.push(entry);
    if (note.signal && bySignal[note.signal]) {
      bySignal[note.signal].push(entry);
    }
  }
  // Sort by date for efficient range queries
  allSorted.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return { bySignal, allSorted };
}

/**
 * Fast per-day note context analysis using pre-computed signals.
 * Replaces analyzeNotesContext for the multi-day scheduling loop.
 *
 * @param {Object} precomputed - Result from precomputeNoteSignals
 * @param {string} dateStr - Reference date in YYYY-MM-DD format
 * @returns {{ intensityModifier: number, signals: Array, recentNoteCount: number }}
 */
function analyzeNotesContextFast(precomputed, dateStr) {
  if (!precomputed) return { intensityModifier: 1.0, signals: [], recentNoteCount: 0 };

  // Compute cutoff date string (7 days before dateStr)
  const cutoffStr = DateUtils.nextDay(dateStr, -7);

  // Count notes by signal in the [cutoff, dateStr] window using pre-computed date strings
  let recentNoteCount = 0;
  const healthNeg = [];
  const stress = [];
  const positive = [];

  for (const entry of precomputed.allSorted) {
    if (entry.date >= cutoffStr && entry.date <= dateStr) {
      recentNoteCount++;
      if (entry.note.signal === 'health_negative') healthNeg.push(entry.note);
      else if (entry.note.signal === 'emotional_stress') stress.push(entry.note);
      else if (entry.note.signal === 'positive') positive.push(entry.note);
    }
  }

  let intensityModifier = 1.0;
  const signals = [];

  if (healthNeg.length > 0) {
    const reduction = Math.min(healthNeg.length * 0.1, 0.4);
    intensityModifier -= reduction;
    signals.push({
      type: 'health_negative',
      impact: `-${Math.round(reduction * 100)}%`,
      reason: `Recent ${healthNeg.length} health-negative note(s) (AI-classified)`,
    });
  }

  if (stress.length > 0) {
    const reduction = Math.min(stress.length * 0.08, 0.2);
    intensityModifier -= reduction;
    signals.push({
      type: 'emotional_stress',
      impact: `-${Math.round(reduction * 100)}%`,
      reason: `Recent ${stress.length} emotional-stress note(s) (AI-classified)`,
    });
  }

  if (positive.length > 0) {
    const boost = Math.min(positive.length * 0.05, 0.15);
    intensityModifier = Math.min(intensityModifier + boost, 1.0);
    signals.push({
      type: 'positive',
      impact: `+${Math.round(boost * 100)}%`,
      reason: `Recent ${positive.length} positive note(s) (AI-classified)`,
    });
  }

  intensityModifier = Math.max(intensityModifier, 0.3);
  return { intensityModifier, signals, recentNoteCount };
}

// ─── Sub-function 1: computePhaseRanges ──────────────────────────────────

/**
 * Compute active date ranges for phase goals (goals sharing a baseTitle).
 * Phase goals are sequential: p1 active from start to d1, p2 from d1+1 to d2, etc.
 *
 * @param {Array} allActiveGoals - All incomplete goals
 * @param {string} startDateStr - Schedule start date (YYYY-MM-DD)
 * @returns {{ phaseRanges: Map<string, {start: string, end: string}>, activeGoals: Array }}
 *          activeGoals is reordered: non-phase goals first, then phase goals grouped by baseTitle
 */
function computePhaseRanges(allActiveGoals, startDateStr) {
  const phaseRanges = new Map();
  const baseTitleGroups = new Map();
  const activeGoals = [];

  for (const g of allActiveGoals) {
    if (g.baseTitle) {
      if (!baseTitleGroups.has(g.baseTitle)) baseTitleGroups.set(g.baseTitle, []);
      baseTitleGroups.get(g.baseTitle).push(g);
    } else {
      activeGoals.push(g);
    }
  }

  for (const [bt, group] of baseTitleGroups) {
    group.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
    for (let i = 0; i < group.length; i++) {
      const prevDeadline = i > 0 ? group[i - 1].deadline : null;
      const rangeStart = prevDeadline ? DateUtils.nextDay(prevDeadline) : startDateStr;
      phaseRanges.set(group[i].id, { start: rangeStart, end: group[i].deadline });
    }
    activeGoals.push(...group);
  }

  return { phaseRanges, activeGoals };
}

// ─── Sub-function 2: parseConstraintRules ────────────────────────────────

/**
 * Parse constraints into executable scheduling rules.
 * AI-DRIVEN: constraints carry a structured `rules` array set by the AI at creation time.
 *
 * @param {Array} constraints - Constraint objects with rules arrays
 * @returns {{ constraintRules: Array, latestTaskTime: string, restDays: Array<number>,
 *            dailyExercise: number, dailyAvailableHours: number }}
 */
function parseConstraintRules(constraints) {
  const constraintRules = [];
  let latestTaskTime = '23:00';
  let restDays = [];
  let dailyExercise = 0;
  let dailyAvailableHours = 8;

  for (const c of constraints) {
    const rules = c.rules || [];
    for (const rule of rules) {
      if (rule.type === 'no_late_night') {
        if (rule.sleepTime) {
          const sleepHour = parseInt(String(rule.sleepTime).split(':')[0], 10);
          latestTaskTime = String(Math.max(sleepHour - 2, 19)).padStart(2, '0') + ':00';
        }
        constraintRules.push({ type: 'no_late_night', rule: `latest task time ${latestTaskTime}`, constraintId: c.id });
      } else if (rule.type === 'rest_day') {
        const dayOfWeek = rule.dayOfWeek;
        if (dayOfWeek !== undefined) restDays.push(dayOfWeek);
        const dayName = WEEKDAYS_FULL[dayOfWeek] || 'that day';
        constraintRules.push({ type: 'rest_day', rule: `no study/work tasks on ${dayName}`, constraintId: c.id });
      } else if (rule.type === 'daily_exercise') {
        dailyExercise = rule.durationMinutes || 30;
        constraintRules.push({ type: 'daily_exercise', rule: `exercise ${dailyExercise} minutes every day`, constraintId: c.id });
      } else if (rule.type === 'daily_hours') {
        dailyAvailableHours = rule.hours || 4;
        constraintRules.push({ type: 'daily_hours', rule: `study ${dailyAvailableHours} hours every day`, constraintId: c.id });
      }
    }
  }

  return { constraintRules, latestTaskTime, restDays, dailyExercise, dailyAvailableHours };
}

// ─── Sub-function 3: scheduleSingleDay ───────────────────────────────────

/**
 * Schedule tasks for a single day.
 *
 * Handles: day initialization, locked time ranges, rest-day check, goal filtering,
 * errand placement, note reminders, intensity analysis, busy-day detection,
 * value-based goal enrichment, and slot-by-slot goal allocation.
 *
 * // mutates: state.schedule.days[dateStr] (writes tasks, weekday)
 *
 * @param {Object} opts - Scheduling options
 * @param {string} opts.dateStr - Date in YYYY-MM-DD format
 * @param {number} opts.weekday - Day of week (0=Sun, 6=Sat)
 * @param {Object} opts.state - Full state object (mutated)
 * @param {Array} opts.activeGoals - Sorted active goals
 * @param {Array} opts.errands - Incomplete errands
 * @param {Array} opts.notes - Enriched notes
 * @param {Array} opts.dailySlots - Time slots from getProfileAwareSlots
 * @param {Object} opts.valueSystem - User's value system
 * @param {Map} opts.phaseRanges - Phase ranges from computePhaseRanges
 * @param {Array} opts.carryForwardTasks - Tasks carried from previous days
 * @param {boolean} opts.isFirstDay - Whether this is the first scheduled day
 * @param {string} opts.latestTaskTime - Latest allowed task time
 * @param {number} opts.latestHour - Latest hour as integer
 * @param {number} opts.dailyExercise - Exercise duration in minutes
 * @param {number} opts.dailyAvailableHours - Available hours per day
 * @param {string} opts.profileType - Profile type string
 * @param {string} opts.profileSlotNote - Profile slot note
 * @param {Array} [opts.enrichedGoals] - Task 3.3: Pre-enriched goals (skip per-day enrichment)
 * @param {Object} [opts.noteSignals] - Task 3.3: Pre-computed note signals (skip per-day analyzeNotesContext)
 * @returns {{ generatedDay: Object, dayNotes: Array, decisionCount: number }}
 */
function scheduleSingleDay(opts) {
  const {
    dateStr, weekday, state, activeGoals, errands, notes, dailySlots,
    valueSystem, phaseRanges, carryForwardTasks, isFirstDay,
    latestTaskTime, latestHour, dailyExercise, dailyAvailableHours,
    profileType, profileSlotNote,
    enrichedGoals, noteSignals,
  } = opts;

  const newTasks = [];
  const dayNotes = [];
  const assignedGoalIds = new Set();
  const decisionReasons = [];

  // Record profile slot decision on the first day
  if (isFirstDay && profileSlotNote) {
    decisionReasons.push({
      type: 'profile_slots',
      title: `Slot strategy: ${profileType}`,
      reason: profileSlotNote,
    });
  }

  // Initialize the day
  if (!state.schedule.days[dateStr]) {
    state.schedule.days[dateStr] = { date: dateStr, weekday: WEEKDAYS[weekday], tasks: [] };
  }
  // Preserve manual tasks, manually-locked AI tasks, and carried-forward tasks
  // (carriedFrom indicates the task was moved here by runDailyCheck's carry-forward)
  const existingTasks = state.schedule.days[dateStr].tasks.filter(t =>
    t.source !== 'ai' || t.manualLocked === true || t.carriedFrom
  );

  // Calculate time ranges occupied by locked tasks
  const lockedTimeRanges = existingTasks
    .filter(t => t.manualLocked || t.source !== 'ai')
    .map(t => {
      if (!t.time || typeof t.time !== 'string') return null;
      const startMin = parseInt(t.time.split(':')[0], 10) * 60 + parseInt(t.time.split(':')[1] || '0', 10);
      const dur = t.duration || 60;
      return { start: startMin, end: startMin + dur, title: t.title };
    })
    .filter(Boolean);

  const isTimeBlocked = (slotStart, slotEnd) => {
    const sMin = parseInt(slotStart.split(':')[0], 10) * 60 + parseInt(slotStart.split(':')[1] || '0', 10);
    const eMin = parseInt(slotEnd.split(':')[0], 10) * 60 + parseInt(slotEnd.split(':')[1] || '0', 10);
    return lockedTimeRanges.some(r => sMin < r.end && eMin > r.start);
  };

  // Rest-day check
  if (opts.restDays && opts.restDays.includes(weekday)) {
    dayNotes.push(`${WEEKDAYS[weekday]} is a rest day; no study tasks scheduled`);
    state.schedule.days[dateStr].tasks = existingTasks;
    return {
      generatedDay: { date: dateStr, weekday: WEEKDAYS[weekday], tasks: existingTasks, note: 'Rest day' },
      dayNotes,
      decisionCount: decisionReasons.length,
    };
  }

  // Filter today's focus goals (phase-aware + one-shot window)
  let todayGoals = activeGoals.filter(g => {
    if (g.baseTitle) {
      const range = phaseRanges.get(g.id);
      if (!range) return false;
      if (dateStr < range.start || dateStr > range.end) return false;
    }
    if (!isOneShotGoal(g)) return true;
    if (!g.deadline) return true;
    const deadlineLocal = new Date(g.deadline + 'T00:00:00');
    const dateLocal = new Date(dateStr + 'T00:00:00');
    const daysLeft = Math.round((deadlineLocal - dateLocal) / 86400000);
    return daysLeft >= 0 && daysLeft <= 3;
  });

  // Errands take slots first
  const todayErrands = errands.filter(e => e.date === dateStr);
  const errandTasks = [];
  for (const errand of todayErrands) {
    const errandTask = {
      id: genId('t'),
      time: errand.time || '09:00',
      duration: errand.duration || 60,
      title: errand.title,
      description: errand.note || `Errand (${errand.commitmentLevel} commitment)`,
      completed: false,
      source: 'errand',
      category: 'errand',
      errandId: errand.id,
    };
    errandTasks.push(errandTask);
    if (errand.commitmentLevel === 'must') {
      decisionReasons.push({
        type: 'errand_placed',
        title: `Errand first: ${errand.title}`,
        reason: `This errand is MUST-level, scheduled ahead of all development goals at ${errand.time || '09:00'}`,
      });
    }
  }

  // Check for due items in notes
  const dueNotes = [];
  for (const note of notes) {
    if (note.relatedDate === dateStr) {
      dueNotes.push({ ...note });
      decisionReasons.push({
        type: 'note_reminder',
        title: `Note reminder: ${(note.content || '').substring(0, 30)}`,
        reason: `Note is due: ${note.content}`,
      });
    }
  }

  // Analyze note context for intensity adjustment
  // Task 3.3: use pre-computed note signals when available (avoids re-iterating all notes per day)
  const noteContext = noteSignals
    ? analyzeNotesContextFast(noteSignals, dateStr)
    : analyzeNotesContext(notes, dateStr);
  const intensityModifier = noteContext.intensityModifier;
  if (noteContext.signals.length > 0) {
    for (const sig of noteContext.signals) {
      decisionReasons.push({
        type: 'note_intensity',
        title: `Note affects intensity: ${sig.impact}`,
        reason: sig.reason,
      });
    }
  }

  // Busy-day detection
  const occupiedMinutes = errandTasks.reduce((sum, t) => sum + (t.duration || 60), 0)
                        + existingTasks.reduce((sum, t) => sum + (t.duration || 60), 0);
  const totalAvailableMinutes = dailySlots.reduce((sum, s) => sum + s.hours * 60, 0);
  const occupancyRate = totalAvailableMinutes > 0 ? occupiedMinutes / totalAvailableMinutes : 0;
  const isBusyDay = occupancyRate >= 0.8 || (dailyAvailableHours > 0 && occupiedMinutes >= dailyAvailableHours * 60 * 0.8);

  if (isBusyDay && todayGoals.length > 0) {
    decisionReasons.push({
      type: 'busy_day_postponed',
      title: `Development goals postponed (busy day: ${Math.round(occupancyRate * 100)}% occupied)`,
      reason: `Errands and existing tasks occupy ${occupiedMinutes} min out of ${totalAvailableMinutes} min available. Development goals will be carried forward to the next available day.`,
    });
    dayNotes.push(`Busy day (${Math.round(occupancyRate * 100)}% occupied) — development goals postponed`);
    const allTasksBusy = [...existingTasks, ...errandTasks];
    if (isFirstDay && carryForwardTasks.length > 0) {
      allTasksBusy.push(...carryForwardTasks);
    }
    state.schedule.days[dateStr].tasks = allTasksBusy.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    state.schedule.days[dateStr].weekday = WEEKDAYS[weekday];
    return {
      generatedDay: { date: dateStr, weekday: WEEKDAYS[weekday], tasks: state.schedule.days[dateStr].tasks, note: 'Busy day - goals postponed' },
      dayNotes,
      decisionCount: decisionReasons.length,
    };
  }

  // The incoming order is the assistant's explicit focus order. Scheduler only
  // allocates time around constraints; it must not re-rank goals.
  // PERF #5: Build a Map for O(1) lookup instead of linear .find() per goal.
  const enrichedById = enrichedGoals
    ? new Map(enrichedGoals.map(eg => [eg.id, eg]))
    : null;
  const enrichedTodayGoals = enrichedById
    ? todayGoals.map(g => {
        const pre = enrichedById.get(g.id);
        return pre || (() => {
          const domain = mapGoalToDomain(g);
          const domainWeight = getDomainWeight(domain, valueSystem);
          return { ...g, _domain: domain, _domainWeight: domainWeight };
        })();
      })
    : todayGoals.map(g => {
        const domain = mapGoalToDomain(g);
        const domainWeight = getDomainWeight(domain, valueSystem);
        return { ...g, _domain: domain, _domainWeight: domainWeight };
      });

  // PERF #5: Build a Map for enrichedTodayGoals to avoid repeated .find() in the slot loop.
  const todayGoalsById = new Map(enrichedTodayGoals.map(g => [g.id, g]));

  // Pre-mark carried-forward goals
  const carriedGoalIds = new Set();
  if (isFirstDay) {
    for (const ct of carryForwardTasks) {
      if (ct.relatedGoalId) carriedGoalIds.add(ct.relatedGoalId);
    }
  }

  // Slot allocation loop
  for (const slot of dailySlots) {
    const slotHour = parseInt(slot.start.split(':')[0], 10);
    if (slotHour >= latestHour && slot.intensity === 'low') break;
    if (slot.hours <= 0) continue;

    if (isTimeBlocked(slot.start, slot.end)) {
      decisionReasons.push({
        type: 'slot_blocked',
        title: `Skip ${slot.start}-${slot.end} (${slot.label})`,
        reason: `Slot occupied by manually-locked task: ${lockedTimeRanges.find(r => parseInt(slot.start.split(':')[0], 10) * 60 < r.end && parseInt(slot.end.split(':')[0], 10) * 60 > r.start)?.title || 'locked'}`,
      });
      continue;
    }

    let selectedGoal = null;
    const assignedBaseTitles = new Set();
    for (const id of assignedGoalIds) {
      // PERF #5: Use Map lookup instead of linear find
      const g = todayGoalsById.get(id);
      if (g && g.baseTitle) assignedBaseTitles.add(g.baseTitle);
    }

    const unassigned = enrichedTodayGoals.filter(g => {
      if (assignedGoalIds.has(g.id) || carriedGoalIds.has(g.id)) return false;
      if (g.baseTitle && assignedBaseTitles.has(g.baseTitle)) return false;
      return true;
    });

    if (unassigned.length > 0) {
      selectedGoal = unassigned[0];
      assignedGoalIds.add(selectedGoal.id);
      if (selectedGoal.baseTitle) assignedBaseTitles.add(selectedGoal.baseTitle);
    } else if (slot.intensity === 'low') {
      const reappearance = enrichedTodayGoals.find(g => g.repeatInDay === true && assignedGoalIds.has(g.id) && !isOneShotGoal(g));
      if (reappearance) {
        selectedGoal = reappearance;
      }
    }

    if (selectedGoal) {
      const baseDuration = slot.intensity === 'high' ? 120 : slot.intensity === 'mid' ? 90 : 60;
      const isOneShot = isOneShotGoal(selectedGoal);
      const taskDuration = Math.round((isOneShot ? 30 : baseDuration) * intensityModifier);
      const taskCategory = isOneShot ? 'reminder' : 'study';

      let taskTitle = selectedGoal.title;
      if (isOneShot) {
        const ddl = selectedGoal.deadline;
        const cnt = ddl ? Math.max(0, DateUtils.daysBetween(ddl, dateStr)) : null;
        taskTitle = `Follow-up: ${taskTitle} (${cnt != null ? cnt : '?'} days left)`;
      } else if (selectedGoal.phaseName) {
        taskTitle = `[${selectedGoal.phaseName}] ${taskTitle}`;
      }

      const relatedStrategicGoalId = selectedGoal.relatedStrategicGoalId || null;

      const task = {
        id: genId('t'),
        time: slot.start,
        duration: taskDuration,
        title: taskTitle,
        description: selectedGoal.detail || selectedGoal.description || '',
        completed: false,
        source: 'ai',
        category: taskCategory,
        relatedGoalId: selectedGoal.id,
        relatedStrategicGoalId: relatedStrategicGoalId,
        noteIds: Array.isArray(selectedGoal.noteIds) ? [...selectedGoal.noteIds] : undefined,
      };

      const allExisting = [...existingTasks, ...errandTasks];
      const conflict = allExisting.some(t => {
        if (!t.time || typeof t.time !== 'string') return false;
        const tHour = parseInt(t.time.split(':')[0], 10);
        const sHour = parseInt(slot.start.split(':')[0], 10);
        const eHour = parseInt(slot.end.split(':')[0], 10);
        return tHour >= sHour && tHour < eHour;
      });

      if (!conflict) {
        newTasks.push(task);
        let placeReason = `${selectedGoal.title} placed at ${slot.start} because it is next in the assistant-provided focus order and this slot is not occupied by an errand`;
        if (selectedGoal._domain) placeReason += `. Context domain: ${selectedGoal._domain}`;
        if (intensityModifier < 1.0) {
          placeReason += `. Today's task intensity adjusted to ${Math.round(intensityModifier * 100)}% (based on note-context analysis); task duration changed from ${baseDuration} minutes to ${taskDuration} minutes`;
        }
        decisionReasons.push({
          type: 'goal_task_placed',
          title: `${slot.label}: ${taskTitle}`,
          reason: placeReason,
        });
      } else {
        dayNotes.push(`The ${slot.start} slot is already occupied by an errand/existing task; skipping`);
        decisionReasons.push({
          type: 'slot_skipped',
          title: `Skip the ${slot.start} slot`,
          reason: `This slot is already occupied by an errand or existing task`,
        });
      }
    }

    // Daily exercise
    if (dailyExercise > 0 && slot.intensity === 'low' && newTasks.length > 0) {
      const exerciseTask = {
        id: genId('t'),
        time: latestTaskTime,
        duration: dailyExercise,
        title: 'Exercise',
        description: 'Daily exercise (constraint)',
        completed: false,
        source: 'ai',
        category: 'exercise',
      };
      newTasks.push(exerciseTask);
    }
  }

  // Merge tasks and sort by time
  const allTasks = [...existingTasks, ...errandTasks, ...newTasks];
  if (isFirstDay && carryForwardTasks.length > 0) {
    allTasks.push(...carryForwardTasks);
    decisionReasons.push({
      type: 'carry_forward',
      title: `${carryForwardTasks.length} task(s) carried forward from previous days`,
      reason: carryForwardTasks.map(t => `${t.title} (from ${t.carriedFrom})`).join('; '),
    });
  }
  state.schedule.days[dateStr].tasks = allTasks.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  state.schedule.days[dateStr].weekday = WEEKDAYS[weekday];

  const generatedDay = {
    date: dateStr,
    weekday: WEEKDAYS[weekday],
    tasks: [...errandTasks, ...newTasks],
    errands: errandTasks.length,
    existingTasks: existingTasks.length,
    phase: undefined,
    note: dayNotes.length > 0 ? dayNotes.join('; ') : undefined,
    decisions: decisionReasons.length,
  };

  return { generatedDay, dayNotes, decisionCount: decisionReasons.length };
}

// ─── Sub-function 4: generateBriefings ───────────────────────────────────

/**
 * Generate the morning briefing for today only.
 *
 * Non-today briefings are intentionally not generated or persisted. The briefing
 * is a daily, date-specific signal — keeping a rolling window leaks stale
 * guidance and makes the storage model confusing.
 *
 * // mutates: state.briefings (replaced with today's only), state.morningBriefing
 *
 * @param {Object} opts
 * @param {string} opts.start - Start date (YYYY-MM-DD), must be today
 * @param {Array} opts.errands - Incomplete errands
 * @param {Array} opts.activeGoals - Active goals (with daysLeft, overdue computed)
 * @param {Array} opts.notes - All notes
 * @param {Object} opts.state - Full state (mutated: briefings, morningBriefing)
 * @param {Array} opts.constraintRules - Parsed constraint rules
 * @param {Array} opts.strategicGoals - Strategic goals
 * @param {string|null} opts.profileBackground - User identity/background
 * @param {string} opts.panelLang - 'en' or 'zh'
 * @returns {void}
 */
function generateBriefings(opts) {
  const {
    start, errands, activeGoals, notes, state,
    constraintRules, strategicGoals, profileBackground, panelLang,
    restDays, dailyExercise, dailyAvailableHours,
  } = opts;

  const upcomingWindowDays = 7;
  const latestTaskTime = opts.latestTaskTime || '23:00';
  const valueSystem = state.userProfile?.valueSystem || null;
  const safeRestDays = restDays || [];

  const I18 = panelLang === 'en'
    ? {
        quote: 'The best time to plant a tree was ten years ago. The second best is now.',
        noTask: 'Follow today\u2019s planned tasks',
        none: 'No recommendation',
        mustErrand: 'Must-do errand',
        overdue: 'OVERDUE',
        noLate: (t) => `Avoid scheduling tasks after ${t} (constraint: no late nights)`,
        push: (title) => `${title}: keep making daily progress`,
        weekNote: (dom) => `This week has more ${dom}-type matters — watch your time allocation`,
      }
    : {
        quote: '种一棵树最好的时间是十年前，其次是现在。',
        noTask: '按今日计划任务执行',
        none: '暂无推荐',
        mustErrand: '必办琐事',
        overdue: '已逾期',
        noLate: (t) => `避免在 ${t} 之后安排任务（约束：不熬夜）`,
        push: (title) => `${title}：保持每日推进`,
        weekNote: (dom) => `本周${dom}类事务较多，注意时间分配`,
      };

  const noteDomZh = { health: '健康', relationship: '关系', career: '职业', academic: '学业', social: '社交', misc: '其他' };
  const noteDomEn = { health: 'Health', relationship: 'Relationship', career: 'Career', academic: 'Academic', social: 'Social', misc: 'Other' };
  const domLabel = (d) => (panelLang === 'en' ? (noteDomEn[d] || d) : (noteDomZh[d] || d));

  // ── Today only ──
  const bdDateStr = DateUtils.todayStr();
  const bdDate = new Date(bdDateStr + 'T00:00:00');

  // Replace briefings with today's single entry only; discard any stale entries.
  state.briefings = {};

  // ── Action index: ultra-lightweight summaries for AI to decide what to deep-read ──
  // Engine does NOT truncate or select — it gives the full index, letting AI decide relevance.
  // All fields are index-level (no body content, no summary) to minimize token cost.

  // Recent actions index (7 days): id + title + pattern + completedAt only
  const recentActionsCutoff = new Date();
  recentActionsCutoff.setDate(recentActionsCutoff.getDate() - 7);
  const recentActions = (state.completedActions || [])
    .filter(a => new Date(a.completedAt) >= recentActionsCutoff)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .map(a => ({ id: a.id, title: a.title, pattern: a.pattern, completedAt: a.completedAt }));

  // Past action hints index (3-30 days, one-time, not yet hinted): for proactive recall
  const proactiveCutoff = new Date();
  proactiveCutoff.setDate(proactiveCutoff.getDate() - 3);
  const proactiveOldCutoff = new Date();
  proactiveOldCutoff.setDate(proactiveOldCutoff.getDate() - 30);
  const pastActionHints = (state.completedActions || [])
    .filter(a => {
      if (a.pattern === 'recurring') return false;
      if (a._hinted) return false;
      const d = new Date(a.completedAt);
      return d >= proactiveOldCutoff && d < proactiveCutoff;
    })
    .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))
    .map(a => {
      const daysAgo = Math.round((new Date() - new Date(a.completedAt)) / 86400000);
      return { id: a.id, title: a.title, daysAgo, category: a.category || 'misc' };
    });

  const dayErrands = errands.filter(e => e.date === bdDateStr);
  const mustErrands = dayErrands.filter(e => e.commitmentLevel === 'must');

  const upcomingGoalsBd = activeGoals.filter(g => {
    if (g.overdue) return true;
    if (g.daysLeft === null || g.daysLeft === undefined) return false;
    return g.daysLeft <= upcomingWindowDays;
  }).sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return (a.daysLeft || 0) - (b.daysLeft || 0);
  }).filter((g, idx, arr) => {
    const key = g.baseTitle || g.title;
    return idx === arr.findIndex(x => (x.baseTitle || x.title) === key);
  });

  const upcomingNoteReminders = [];
  for (const note of notes) {
    if (!note.relatedDate) continue;
    const dl = daysBetween(note.relatedDate);
    if (dl === null) continue;
    if (dl >= 0 && dl <= upcomingWindowDays) {
      upcomingNoteReminders.push({ ...note, daysUntil: dl });
    }
  }

  // ── Collect must-items for fallback text ──
  const dayReminders = (state.reminders || []).filter(rm => {
    if (rm.fired && !rm.repeat) return false;
    const rmDate = (rm.triggerAt || '').slice(0, 10);
    return rmDate === bdDateStr;
  });
  const mustItems = [];
  if (dayReminders.length > 0) {
    mustItems.push(...dayReminders.map(rm => {
      const time = (rm.triggerAt || '').slice(11, 16);
      return `\u23f0 ${rm.title}${time ? ' ' + time : ''}`;
    }));
  }
  if (mustErrands.length > 0) {
    mustItems.push(...mustErrands.map(e => e.title));
  }
  if (upcomingGoalsBd.length > 0) {
    mustItems.push(...upcomingGoalsBd.map(g => {
      if (g.overdue) return `[${I18.overdue}] ${g.title}`;
      const daysLeft = g.daysLeft;
      if (daysLeft === 0) return `[DUE] ${g.title}`;
      return `[${daysLeft}d] ${g.title}`;
    }));
  }

  // ── Build structured briefing data for AI to compose natural-language report ──
  const dayTasks = state.schedule?.days?.[bdDateStr]?.tasks || [];
  const incompleteTasks = dayTasks.filter(t => !t.completed);
  const totalScheduledMin = incompleteTasks.reduce((s, t) => s + (t.duration || 60), 0);
  const errandMin = mustErrands.length * 60;
  const scheduledHours = Math.round(totalScheduledMin / 60 * 10) / 10;
  const errandHours = Math.round(errandMin / 60 * 10) / 10;
  // Capacity is NOT computed or surfaced here. The butler-style "day looks
  // full" nudge and the high-stakes-day guard are AI behaviors defined in
  // SKILL.md — the AI sums task durations from zhigui_get_day_schedule itself.
  // We only expose neutral scheduling facts (how much is already placed on the day).

  const topTask = incompleteTasks.sort((a, b) => (a.time || '').localeCompare(b.time || ''))[0];

  // Goal progress (deduplicated by baseTitle) — full list, no artificial truncation
  const goalProgress = upcomingGoalsBd.map(g => ({
    id: g.id, title: g.title, domain: g.domain,
    daysLeft: g.daysLeft, overdue: g.overdue,
    phase: g.phaseName || g.baseTitle || null,
  }));

  // Hard constraints for today
  const weekday = bdDate.getDay();
  const hardConstraints = [];
  if (constraintRules.find(r => r.type === 'no_late_night')) {
    hardConstraints.push({ type: 'no_late_night', latestTime: latestTaskTime });
  }
  if (safeRestDays.includes(weekday)) {
    hardConstraints.push({ type: 'rest_day' });
  }
  if (dailyExercise) {
    hardConstraints.push({ type: 'daily_exercise', duration: dailyExercise });
  }
  // Capacity is NOT a hard constraint — the AI applies a soft butler-style
  // reminder per SKILL.md; we never cap or trim the schedule in code.

  // Value system snapshot (for AI to reason about trade-offs)
  const valueSnapshot = valueSystem ? {
    decisionStyle: valueSystem.decisionStyle || 'balanced',
    topDomains: (valueSystem.priorities || []).map(p => ({ domain: p.domain, weight: p.weight })),
  } : null;

  state.briefings[bdDateStr] = {
    date: bdDateStr,
    // Structured data — AI will compose natural language via zhigui_set_briefing
    _raw: true,  // flag: briefing not yet composed by AI
    mustReminders: dayReminders.map(rm => ({ id: rm.id, title: rm.title, time: (rm.triggerAt || '').slice(11, 16), commitmentLevel: rm.commitmentLevel })),
    mustErrands: mustErrands.map(e => ({ id: e.id, title: e.title, commitmentLevel: e.commitmentLevel })),
    upcomingGoals: upcomingGoalsBd.map(g => ({ id: g.id, title: g.title, daysLeft: g.daysLeft, overdue: g.overdue })),
    noteReminders: upcomingNoteReminders.map(n => ({ id: n.id, title: n.title, domain: n.domain, daysUntil: n.daysUntil })),
    topTask: topTask ? { id: topTask.id, title: topTask.title, time: topTask.time, duration: topTask.duration, estimatedTime: topTask.estimatedTime } : null,
    timeBudget: { scheduledHours, errandHours },
    hardConstraints,
    goalProgress,
    valueSystem: valueSnapshot,
    userContext: profileBackground ? { identity: profileBackground } : undefined,
    recentActions,
    pastActionHints,
    // Fallback text fields (used when AI hasn't composed yet — frontend renders these)
    mustDo: mustItems.join('; ') || I18.noTask,
    recommended: topTask ? `${topTask.title} (${topTask.time})` : (activeGoals.length > 0 ? activeGoals[0].title : I18.none),
    notRecommended: constraintRules.find(r => r.type === 'no_late_night') ? I18.noLate(latestTaskTime) : '',
    strategicReminder: strategicGoals.length > 0 ? I18.push(strategicGoals[0].title) : '',
    dailyQuote: I18.quote,
  };

  state.morningBriefing = state.briefings[bdDateStr];

  // ── Attention digest: Situation / Risks / Opportunities / Decisions Needed ──
  try {
    const attentionSummary = AttentionEngine.getAttentionSummary(state, { lang: panelLang === 'en' ? 'en' : 'zh' });

    const SITUATION_TYPES = new Set(['deadline', 'overdue', 'momentum_lost', 'recurrence_due']);
    const RISK_TYPES = new Set(['blocked', 'conflict', 'stale']);
    const OPPORTUNITY_TYPES = new Set(['hint_followup']);
    const DECISION_NEEDED_TYPES = new Set(['need_decision']);

    const mapSignal = (s) => ({
      id: s.id,
      type: s.type,
      signalType: s.signalType,
      signalStrength: s.signalStrength,
      attentionReasons: s.attentionReasons || [],
    });

    const situation = (attentionSummary.topSignals || []).filter(s => SITUATION_TYPES.has(s.signalType)).map(mapSignal);
    const risks = (attentionSummary.topSignals || []).filter(s => RISK_TYPES.has(s.signalType)).map(mapSignal);
    const opportunities = (attentionSummary.topSignals || []).filter(s => OPPORTUNITY_TYPES.has(s.signalType)).map(mapSignal);
    const decisionsNeeded = (attentionSummary.topSignals || []).filter(s => DECISION_NEEDED_TYPES.has(s.signalType)).map(mapSignal);

    state.morningBriefing.attentionDigest = {
      situation,
      risks,
      opportunities,
      decisionsNeeded,
    };
    state.morningBriefing.meta = {
      attentionComputedAt: attentionSummary.computedAt,
      totalSignals: attentionSummary.totalEntities,
    };
  } catch (err) {
    // AttentionEngine failure should not block morning briefing generation
    state.morningBriefing.attentionDigest = { situation: [], risks: [], opportunities: [], decisionsNeeded: [] };
    state.morningBriefing.meta = { attentionComputedAt: null, totalSignals: 0 };
  }

  // ── Pending decisions ──
  const pendingDecisions = (state.decisions || [])
    .filter(d => d.status === 'pending')
    .map(d => ({
      id: d.id,
      title: d.title,
      description: d.description,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
    }));
  state.morningBriefing.pendingDecisions = pendingDecisions;
}

// ─── Sub-function 5: detectAndMergeConflicts ─────────────────────────────

/**
 * Run conflict detection and persist the detected conflicts.
 *
 * // mutates: state.conflicts (replaced with merged array)
 *
 * @param {Object} state - Full state (mutated: conflicts)
 * @param {Array} activeGoals - Active goals
 * @param {Array} dailySlots - Time slots
 * @param {Function} detectConflictsFn - detectConflicts function from server.js
 * @returns {Array} The merged conflicts array
 */
function detectAndMergeConflicts(state, activeGoals, dailySlots, detectConflictsFn) {
  const detectedConflicts = detectConflictsFn(state);

  state.conflicts = detectedConflicts;
  return state.conflicts;
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  WEEKDAYS,
  // Helper functions
  isOneShotGoal,
  getDomainWeight,
  getProfileAwareSlots,
  // Task 3.3: Pre-computation functions (move loop-invariant work outside the daily loop)
  precomputeGoalEnrichment,
  precomputeNoteSignals,
  analyzeNotesContextFast,
  // Sub-functions
  computePhaseRanges,
  parseConstraintRules,
  scheduleSingleDay,
  generateBriefings,
  detectAndMergeConflicts,
};
