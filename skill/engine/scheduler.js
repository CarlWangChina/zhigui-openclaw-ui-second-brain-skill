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
 * Zero dependencies beyond Node.js built-ins and ./date-utils.
 */

const DateUtils = require('./date-utils');

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
  return entry ? entry.weight : 50;
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
  const cutoff = new Date(dateStr);
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.getFullYear() + '-' +
    String(cutoff.getMonth() + 1).padStart(2, '0') + '-' +
    String(cutoff.getDate()).padStart(2, '0');

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
        { start: '10:00', end: '12:00', label: 'Regular slot', priority: 'mid', hours: 2 },
        { start: '14:00', end: '17:00', label: 'Prime slot', priority: 'high', hours: 3 },
        { start: '19:00', end: latestTaskTime, label: 'Deep slot', priority: 'high', hours: Math.max(latestHour - 19, 0) },
      ],
      profile: 'night_owl',
      note: 'Night-owl routine; prime slot shifted to afternoon and evening',
    };
  }
  if (profile === 'early_bird') {
    return {
      slots: [
        { start: '07:00', end: '10:00', label: 'Prime slot', priority: 'high', hours: 3 },
        { start: '10:00', end: '12:00', label: 'Regular slot', priority: 'mid', hours: 2 },
        { start: '14:00', end: '17:00', label: 'Light slot', priority: 'low', hours: 3 },
      ],
      profile: 'early_bird',
      note: 'Early-bird routine; prime slot shifted to morning',
    };
  }
  return {
    slots: [
      { start: '09:00', end: '12:00', label: 'Prime slot', priority: 'high', hours: 3 },
      { start: '14:00', end: '17:00', label: 'Regular slot', priority: 'mid', hours: 3 },
      { start: '19:00', end: latestTaskTime, label: 'Light slot', priority: 'low', hours: Math.max(latestHour - 19, 0) },
    ],
    profile: 'standard',
    note: 'Standard routine slots',
  };
}

// ─── Cost-effectiveness calculation ───────────────────────────────────────

/**
 * Cost-effectiveness (0-30): feasibility of completion within remaining time.
 * @param {Object} g - Goal object
 * @param {Object} state - Full state (for userProfile.dailyCapacity)
 * @returns {number} Score 0-30
 */
function computeCostPerf(g, state) {
  const dl = g.deadline ? daysBetween(g.deadline) : null;
  if (dl == null) return 18;
  const est = (g.estimatedHours && g.estimatedHours > 0) ? g.estimatedHours : 12;
  const dailyCap = (state.userProfile && state.userProfile.dailyCapacity) || 3;
  const avail = Math.max(dl, 1) * dailyCap;
  if (est <= avail * 0.7) return 30;
  if (est <= avail) return 24;
  if (est <= avail * 1.5) return 14;
  return 6;
}

// ─── Task 3.3: Pre-computation functions (move loop-invariant work outside the daily loop) ──

/**
 * Pre-compute goal enrichment (domain, domainWeight, costPerf, effectiveScore) for all active goals.
 * These values only depend on the goal itself, the state, and the valueSystem — none of which
 * change between days in a single scheduling run. Computing them once here avoids re-evaluating
 * mapGoalToDomain, getDomainWeight, and computeCostPerf for every goal on every day.
 *
 * @param {Array} activeGoals - All active (incomplete) goals
 * @param {Object} state - Full state (for userProfile.dailyCapacity)
 * @param {Object} valueSystem - User's value system
 * @returns {Array} Enriched goal objects with _domain, _domainWeight, _costPerf, _effectiveScore
 */
function precomputeGoalEnrichment(activeGoals, state, valueSystem) {
  // effectiveScore: AI-scored goals use their AI priority directly (AI already
  // factored in domain alignment, cost-perf, and user values). Rule-scored goals
  // get a small domain-weight nudge as a heuristic — but the AI can override anytime.
  return activeGoals.map(g => {
    const domain = mapGoalToDomain(g);
    const domainWeight = getDomainWeight(domain, valueSystem);
    const costPerf = computeCostPerf(g, state);
    const effectiveScore = g.scoreSource === 'ai'
      ? g.priority
      : g.priority + domainWeight * 0.5;
    return { ...g, _domain: domain, _domainWeight: domainWeight, _costPerf: costPerf, _effectiveScore: effectiveScore };
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
  const cutoff = new Date(dateStr);
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.getFullYear() + '-' +
    String(cutoff.getMonth() + 1).padStart(2, '0') + '-' +
    String(cutoff.getDate()).padStart(2, '0');

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
          const sleepHour = parseInt(String(rule.sleepTime).split(':')[0]);
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
  // Preserve manual tasks + manually-locked AI tasks
  const existingTasks = state.schedule.days[dateStr].tasks.filter(t => t.source !== 'ai' || t.manualLocked === true);

  // Calculate time ranges occupied by locked tasks
  const lockedTimeRanges = existingTasks
    .filter(t => t.manualLocked || t.source !== 'ai')
    .map(t => {
      const startMin = t.time ? parseInt(t.time.split(':')[0]) * 60 + parseInt(t.time.split(':')[1] || '0') : 0;
      const dur = t.duration || 60;
      return { start: startMin, end: startMin + dur, title: t.title };
    });

  const isTimeBlocked = (slotStart, slotEnd) => {
    const sMin = parseInt(slotStart.split(':')[0]) * 60 + parseInt(slotStart.split(':')[1] || '0');
    const eMin = parseInt(slotEnd.split(':')[0]) * 60 + parseInt(slotEnd.split(':')[1] || '0');
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
      description: errand.note || `Errand (${errand.priority} level)`,
      priority: errand.priority === 'must' ? 100 : errand.priority === 'should' ? 60 : 30,
      completed: false,
      source: 'errand',
      category: 'errand',
      errandId: errand.id,
    };
    errandTasks.push(errandTask);
    if (errand.priority === 'must') {
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

  // Value-based goal enrichment
  // Task 3.3: use pre-enriched goals when available (avoids re-computing domain/weight/costPerf per day)
  const _calcEffectiveScore = (g, domainWeight) => g.scoreSource === 'ai'
    ? g.priority
    : g.priority + domainWeight * 0.5;
  const enrichedTodayGoals = enrichedGoals
    ? todayGoals.map(g => {
        const pre = enrichedGoals.find(eg => eg.id === g.id);
        return pre || (() => {
          const domain = mapGoalToDomain(g);
          const domainWeight = getDomainWeight(domain, valueSystem);
          const costPerf = computeCostPerf(g, state);
          return { ...g, _domain: domain, _domainWeight: domainWeight, _costPerf: costPerf, _effectiveScore: _calcEffectiveScore(g, domainWeight) };
        })();
      })
    : todayGoals.map(g => {
        const domain = mapGoalToDomain(g);
        const domainWeight = getDomainWeight(domain, valueSystem);
        const costPerf = computeCostPerf(g, state);
        return { ...g, _domain: domain, _domainWeight: domainWeight, _costPerf: costPerf, _effectiveScore: _calcEffectiveScore(g, domainWeight) };
      });

  // Pre-mark carried-forward goals
  const carriedGoalIds = new Set();
  if (isFirstDay) {
    for (const ct of carryForwardTasks) {
      if (ct.relatedGoalId) carriedGoalIds.add(ct.relatedGoalId);
    }
  }

  // Slot allocation loop
  for (const slot of dailySlots) {
    const slotHour = parseInt(slot.start.split(':')[0]);
    if (slotHour >= latestHour && slot.priority === 'low') break;
    if (slot.hours <= 0) continue;

    if (isTimeBlocked(slot.start, slot.end)) {
      decisionReasons.push({
        type: 'slot_blocked',
        title: `Skip ${slot.start}-${slot.end} (${slot.label})`,
        reason: `Slot occupied by manually-locked task: ${lockedTimeRanges.find(r => parseInt(slot.start.split(':')[0]) * 60 < r.end && parseInt(slot.end.split(':')[0]) * 60 > r.start)?.title || 'locked'}`,
      });
      continue;
    }

    let selectedGoal = null;
    let valueBasedSelection = false;

    const assignedBaseTitles = new Set();
    for (const id of assignedGoalIds) {
      const g = enrichedTodayGoals.find(x => x.id === id);
      if (g && g.baseTitle) assignedBaseTitles.add(g.baseTitle);
    }

    const unassigned = enrichedTodayGoals.filter(g => {
      if (assignedGoalIds.has(g.id) || carriedGoalIds.has(g.id)) return false;
      if (g.baseTitle && assignedBaseTitles.has(g.baseTitle)) return false;
      return true;
    });

    if (unassigned.length > 0) {
      if (slot.priority === 'high' && valueSystem) {
        unassigned.sort((a, b) => b._effectiveScore - a._effectiveScore);
        selectedGoal = unassigned[0];
        valueBasedSelection = true;
      } else {
        selectedGoal = unassigned[0];
      }
      assignedGoalIds.add(selectedGoal.id);
      if (selectedGoal.baseTitle) assignedBaseTitles.add(selectedGoal.baseTitle);
    } else if (slot.priority === 'low') {
      const reappearance = enrichedTodayGoals.find(g => g.priority >= 75 && assignedGoalIds.has(g.id) && !isOneShotGoal(g));
      if (reappearance) {
        selectedGoal = reappearance;
      }
    }

    if (selectedGoal) {
      const baseDuration = slot.priority === 'high' ? 120 : slot.priority === 'mid' ? 90 : 60;
      const isOneShot = isOneShotGoal(selectedGoal);
      const taskDuration = Math.round((isOneShot ? 30 : baseDuration) * intensityModifier);
      const taskCategory = isOneShot ? 'reminder' : 'study';

      let taskTitle = selectedGoal.title;
      if (isOneShot) {
        const ddl = selectedGoal.deadline;
        const cnt = ddl ? Math.max(0, Math.round((new Date(ddl) - new Date(dateStr)) / 86400000)) : null;
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
        priority: selectedGoal.priority,
        costPerf: selectedGoal._costPerf,
        completed: false,
        source: 'ai',
        category: taskCategory,
        relatedGoalId: selectedGoal.id,
        relatedStrategicGoalId: relatedStrategicGoalId,
      };

      const allExisting = [...existingTasks, ...errandTasks];
      const conflict = allExisting.some(t => {
        const tHour = parseInt(t.time.split(':')[0]);
        const sHour = parseInt(slot.start.split(':')[0]);
        const eHour = parseInt(slot.end.split(':')[0]);
        return tHour >= sHour && tHour < eHour;
      });

      if (!conflict) {
        newTasks.push(task);
        let placeReason = `${selectedGoal.title} (priority ${selectedGoal.priority}) scheduled at ${slot.start}, because this slot is not occupied by an errand`;
        if (valueBasedSelection && selectedGoal._domain) {
          placeReason += `. Value-based decision: ${selectedGoal._domain} domain weight ${selectedGoal._domainWeight}, composite score ${selectedGoal._effectiveScore.toFixed(1)} (priority ${selectedGoal.priority} + weight ${selectedGoal._domainWeight}*0.5)`;
        }
        const cpLabel = selectedGoal._costPerf >= 30 ? 'high (comfortably fits remaining time)'
          : selectedGoal._costPerf >= 24 ? 'good (fits remaining time)'
          : selectedGoal._costPerf >= 14 ? 'tight (may overrun)'
          : 'low (unrealistic for remaining time)';
        placeReason += `. Cost-effectiveness ${selectedGoal._costPerf}/30 — ${cpLabel}`;
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
    if (dailyExercise > 0 && slot.priority === 'low' && newTasks.length > 0) {
      const exerciseTask = {
        id: genId('t'),
        time: latestTaskTime,
        duration: dailyExercise,
        title: 'Exercise',
        description: 'Daily exercise (constraint)',
        priority: 60,
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
  state.schedule.days[dateStr].tasks = allTasks.sort((a, b) => a.time.localeCompare(b.time));
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
 * Generate the morning briefing for a rolling window of days.
 *
 * // mutates: state.briefings (replaced), state.morningBriefing (set to today's)
 *
 * @param {Object} opts
 * @param {string} opts.start - Start date (YYYY-MM-DD)
 * @param {number} opts.briefingDays - Number of days to generate briefings for
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
    start, briefingDays, errands, activeGoals, notes, state,
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
        priority: 'priority',
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
        priority: '优先级',
        noLate: (t) => `避免在 ${t} 之后安排任务（约束：不熬夜）`,
        push: (title) => `${title}：保持每日推进`,
        weekNote: (dom) => `本周${dom}类事务较多，注意时间分配`,
      };

  const noteDomZh = { health: '健康', relationship: '关系', career: '职业', academic: '学业', social: '社交', misc: '其他' };
  const noteDomEn = { health: 'Health', relationship: 'Relationship', career: 'Career', academic: 'Academic', social: 'Social', misc: 'Other' };
  const domLabel = (d) => (panelLang === 'en' ? (noteDomEn[d] || d) : (noteDomZh[d] || d));

  state.briefings = {};
  for (let bd = 0; bd < briefingDays; bd++) {
    const bdDate = new Date(start);
    bdDate.setDate(bdDate.getDate() + bd);
    const bdDateStr = bdDate.getFullYear() + '-' +
      String(bdDate.getMonth() + 1).padStart(2, '0') + '-' +
      String(bdDate.getDate()).padStart(2, '0');
    const bdOffset = bd;

    const dayErrands = errands.filter(e => e.date === bdDateStr);
    const mustErrands = dayErrands.filter(e => e.priority === 'must');

    const upcomingGoalsBd = activeGoals.filter(g => {
      if (g.overdue) return true;
      if (g.daysLeft === null || g.daysLeft === undefined) return false;
      return (g.daysLeft - bdOffset) <= upcomingWindowDays;
    }).sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return ((a.daysLeft || 0) - bdOffset) - ((b.daysLeft || 0) - bdOffset);
    }).filter((g, idx, arr) => {
      const key = g.baseTitle || g.title;
      return idx === arr.findIndex(x => (x.baseTitle || x.title) === key);
    });

    const upcomingNoteReminders = [];
    for (const note of notes) {
      if (!note.relatedDate) continue;
      const dl = daysBetween(note.relatedDate);
      if (dl === null) continue;
      const dlOnDay = dl - bdOffset;
      if (dlOnDay >= 0 && dlOnDay <= upcomingWindowDays) {
        upcomingNoteReminders.push({ ...note, daysUntil: dlOnDay });
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
        const daysLeft = g.daysLeft - bdOffset;
        if (daysLeft === 0) return `[DUE] ${g.title}`;
        return `[${daysLeft}d] ${g.title}`;
      }));
    }

    // ── Build structured briefing data for AI to compose natural-language report ──
    const dayTasks = state.schedule?.days?.[bdDateStr]?.tasks || [];
    const incompleteTasks = dayTasks.filter(t => !t.completed);
    const totalScheduledMin = incompleteTasks.reduce((s, t) => s + (t.duration || 60), 0);
    const errandMin = mustErrands.length * 60;
    const dailyCap = state.userProfile?.dailyCapacity || 480;
    const scheduledHours = Math.round(totalScheduledMin / 60 * 10) / 10;
    const errandHours = Math.round(errandMin / 60 * 10) / 10;

    const topTask = incompleteTasks.sort((a, b) =>
      ((b.priority || 0) + (b.costPerf || 0)) - ((a.priority || 0) + (a.costPerf || 0))
    )[0];

    // Collect note signals for today's context
    const noteSignals = [];
    const recentNotes = notes.filter(n => {
      if (!n.createdAt) return false;
      return daysBetween(n.createdAt) === 0 || (n.relatedDate && daysBetween(n.relatedDate) === 0);
    });
    for (const n of recentNotes.slice(0, 5)) {
      noteSignals.push({ id: n.id, title: n.title, domain: n.domain, topicId: n.topicId });
    }

    // Goal progress (deduplicated by baseTitle)
    const goalProgress = upcomingGoalsBd.slice(0, 5).map(g => ({
      id: g.id, title: g.title, domain: g.domain,
      priority: g.priority, daysLeft: g.daysLeft - bdOffset, overdue: g.overdue,
      phase: g.phaseName || g.baseTitle || null,
    }));

    // Hard constraints for today
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
    if (dailyCap < 480) {
      hardConstraints.push({ type: 'limited_hours', hours: Math.round(dailyCap / 60) });
    }

    // Value system snapshot (for AI to reason about trade-offs)
    const valueSnapshot = valueSystem ? {
      decisionStyle: valueSystem.decisionStyle || 'balanced',
      topDomains: (valueSystem.priorities || []).slice(0, 5).map(p => ({ domain: p.domain, weight: p.weight })),
    } : null;

    state.briefings[bdDateStr] = {
      date: bdDateStr,
      // Structured data — AI will compose natural language via lingxi_set_briefing
      _raw: true,  // flag: briefing not yet composed by AI
      mustReminders: dayReminders.map(rm => ({ id: rm.id, title: rm.title, time: (rm.triggerAt || '').slice(11, 16), priority: rm.priority })),
      mustErrands: mustErrands.map(e => ({ id: e.id, title: e.title, priority: e.priority })),
      upcomingGoals: upcomingGoalsBd.map(g => ({ id: g.id, title: g.title, daysLeft: g.daysLeft - bdOffset, overdue: g.overdue })),
      noteReminders: upcomingNoteReminders.slice(0, 3).map(n => ({ id: n.id, domain: n.domain, content: n.content, daysUntil: n.daysUntil })),
      topTask: topTask ? { id: topTask.id, title: topTask.title, priority: topTask.priority, costPerf: topTask.costPerf, time: topTask.time, duration: topTask.duration, estimatedTime: topTask.estimatedTime } : null,
      timeBudget: { availableHours: Math.round(dailyCap / 60), scheduledHours, errandHours },
      hardConstraints,
      noteSignals,
      goalProgress,
      valueSystem: valueSnapshot,
      userContext: profileBackground ? { identity: profileBackground } : undefined,
      // Fallback text fields (used when AI hasn't composed yet — frontend renders these)
      mustDo: mustItems.join('; ') || I18.noTask,
      recommended: topTask ? `${topTask.title} (${I18.priority} ${topTask.priority}${topTask.costPerf != null ? `, 性价比 ${topTask.costPerf}/30` : ''}, ${topTask.time})` : (activeGoals.length > 0 ? `${activeGoals[0].title} (${I18.priority} ${activeGoals[0].priority})` : I18.none),
      notRecommended: constraintRules.find(r => r.type === 'no_late_night') ? I18.noLate(latestTaskTime) : '',
      strategicReminder: strategicGoals.length > 0 ? I18.push(strategicGoals[0].title) : '',
      dailyQuote: I18.quote,
    };

    if (bd === 0) {
      state.morningBriefing = state.briefings[bdDateStr];
    }
  }
}

// ─── Sub-function 5: detectAndMergeConflicts ─────────────────────────────

/**
 * Run conflict detection and merge with priority-clash detection.
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

  // Priority-conflict detection
  const priorityClashes = [];
  const highPriorityGoals = activeGoals.filter(g => g.priority >= 70);
  if (highPriorityGoals.length > dailySlots.length) {
    for (let i = dailySlots.length; i < highPriorityGoals.length; i++) {
      priorityClashes.push({
        type: 'priority_clash',
        severity: 'warning',
        title: 'High-priority goal slot competition',
        description: `${highPriorityGoals.length} high-priority goals (>=70) compete for ${dailySlots.length} daily slots; "${highPriorityGoals[i].title}" (${highPriorityGoals[i].priority}) may not get enough prime-slot time`,
        suggestion: `Suggestion: 1) lower the priority of "${highPriorityGoals[i].title}" 2) schedule it into a non-standard slot 3) consider splitting it into smaller sub-goals`,
        relatedGoals: [highPriorityGoals[i].id],
      });
    }
  }

  // Check competition among same-score goals
  const scoreGroups = {};
  for (const g of activeGoals) {
    const bucket = Math.floor(g.priority / 10) * 10;
    if (!scoreGroups[bucket]) scoreGroups[bucket] = [];
    scoreGroups[bucket].push(g);
  }
  for (const [bucket, goals] of Object.entries(scoreGroups)) {
    if (goals.length > 2 && parseInt(bucket) >= 60) {
      priorityClashes.push({
        type: 'priority_clash',
        severity: 'info',
        title: `${bucket}-score bucket is dense`,
        description: `${goals.length} goals fall in the ${bucket}-${parseInt(bucket) + 9} score bucket: ${goals.map(g => g.title).join(', ')}. These goals may compete with each other for time resources.`,
        suggestion: 'Suggestion: further differentiate the priorities of these goals to spread out the scores and make scheduling more reasonable.',
      });
    }
  }

  state.conflicts = [...detectedConflicts, ...priorityClashes];
  return state.conflicts;
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  DOMAIN_ALIAS,
  WEEKDAYS,
  WEEKDAYS_FULL,
  // Utility functions
  genId,
  daysBetween,
  todayStr,
  // Helper functions
  isOneShotGoal,
  mapGoalToDomain,
  getDomainWeight,
  analyzeNotesContext,
  getProfileAwareSlots,
  computeCostPerf,
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
