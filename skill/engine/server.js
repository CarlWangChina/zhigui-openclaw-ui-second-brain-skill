#!/usr/bin/env node

/**
 * ZhiGui MCP Server
 * Zero dependencies, only Node.js built-in modules
 * Protocol: JSON-RPC 2.0 over stdio (MCP 2024-11-05)
 *
 * Any MCP-compatible AI tool (WorkBuddy / Trae / Cursor / Claude Desktop)
 * can invoke all of ZhiGui's capabilities through the standard protocol.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, exec } = require('child_process');
const http = require('http');
const { BrainIndex, VERSION: BRAIN_VERSION } = require('./brain-index');
const { buildOverview } = require('./overview');
const DateUtils = require('./date-utils');
const Scheduler = require('./scheduler');
const { genId, todayStr, daysBetween, clamp } = require('./utils');

// ─── Config loading ───────────────────────────────────────────
// Data directory / app directory are resolved by the shared config loader (skill/lib/config.js),
// shared by dashboard and electron so all three sides use the same data location.

const { loadConfig } = require('../lib/config');
const CONFIG = loadConfig();
const STATE_FILE = path.join(CONFIG.dataDir, 'state.json');
const HISTORY_FILE = path.join(CONFIG.dataDir, 'history.json');

// ─── Event stream engine ───────────────────────────────────────
// Second-brain association index layer (topic foreign key + auto-sedimentation)
let brainIndex = null;
function getBrainIndex() {
  if (!brainIndex) {
    brainIndex = new BrainIndex(CONFIG.dataDir);
  }
  return brainIndex;
}

// ─── Document splitting — two-layer retrieval architecture ────────────────────────────
// Layer 1: documents.json → index, tells the AI what documents exist
// Layer 2: goals.json / schedule.json / errands.json etc. → read specific documents on demand
// Persistence goes through the shared module mcp/storage.js (includes readState timestamp reconciliation, briefings key, etc.)

const Storage = require('./storage');
const Actions = require('./actions');
const { ensureDataInitialized } = require('../lib/init-data');

// ─── First-run auto-initialization (complete on import) ────────────────────
const initCount = ensureDataInitialized(CONFIG.dataDir);
if (initCount > 0) {
  process.stderr.write(`[ZhiGui] First-run auto-initialization: created ${initCount} data files\n`);
}

Storage.setDataDir(CONFIG.dataDir);
Actions.configure(CONFIG.dataDir);
const DOCUMENT_KEYS = Storage.DOCUMENT_KEYS;
const DOCUMENT_FILES = {
  goals: path.join(CONFIG.dataDir, 'goals.json'),
  schedule: path.join(CONFIG.dataDir, 'schedule.json'),
  errands: path.join(CONFIG.dataDir, 'errands.json'),
  notes: path.join(CONFIG.dataDir, 'notes.json'),
  reminders: path.join(CONFIG.dataDir, 'reminders.json'),
  userProfile: path.join(CONFIG.dataDir, 'userProfile.json'),
};
const INDEX_FILE = path.join(CONFIG.dataDir, 'documents.json');
const DOCUMENT_TITLES = {
  goals: 'Goals & Constraints',
  schedule: 'Schedule & Morning Briefing',
  errands: 'Errands',
  notes: 'Life Notes',
  reminders: 'Reminders',
  userProfile: 'User Profile',
};

// ─── Document read/write tools (delegated to shared persistence layer mcp/storage.js) ──────
// All goes through Storage to ensure the AI process and the Electron panel share the same write path, timestamp reconciliation, and briefings key.

function readDocument(docType) {
  return Storage.readDocument(docType);
}

function writeDocument(docType, data) {
  return Storage.writeDocument(docType, data);
}

function updateIndexTimestamp(docType) {
  return Storage.updateIndexTimestamp(docType);
}

// ─── Aggregate read/write (hierarchical lazy-loading) ──────────────────
// readState returns LIGHTWEIGHT state: goal/note/schedule indexes only (no full content).
// This saves tokens — AI doesn't load full goal descriptions or all schedule days.
// Use getGoalDetail(id) / getDaySchedule(date) for full content on demand.
// writeState splits writes into index + detail files automatically.

function readState() {
  // Use lightweight state by default (hierarchy-enabled)
  try {
    const s = Storage.readLightweightState();
    if (s && s.meta) s.meta.version = BRAIN_VERSION;
    return s;
  } catch {
    // Fallback to legacy readState if hierarchy fails
    const s = Storage.readState();
    if (s && s.meta) s.meta.version = BRAIN_VERSION;
    return s;
  }
}

// Read FULL state (legacy mode, loads everything) — use sparingly
function readFullState() {
  const s = Storage.readFullState();
  if (s && s.meta) s.meta.version = BRAIN_VERSION;
  return s;
}

// SSE callback — set by the MCP server when it starts, so writeState can push lock events
let _sseCallback = null;
function setSSECallback(cb) { _sseCallback = cb; }

function writeState(state) {
  // Acquire lock with 'ai' process name — dashboard will detect via file watcher and show overlay
  if (_sseCallback) _sseCallback({ type: 'lock_acquired', by: 'ai', timestamp: new Date().toISOString() });
  try {
    const result = Storage.writeState(state);
    return result;
  } finally {
    if (_sseCallback) _sseCallback({ type: 'lock_released', by: 'ai', timestamp: new Date().toISOString() });
  }
}

// Export for dashboard server to hook into SSE
module.exports = { setSSECallback };

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return { conversations: [], meta: { totalConversations: 0, lastConversation: null } };
  }
}

function writeHistory(history) {
  history.meta = history.meta || {};
  history.meta.totalConversations = (history.conversations || []).length;
  history.meta.lastConversation = (history.conversations || []).slice(-1)[0]?.timestamp || null;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

// Task 1.4: genId moved to engine/utils.js

// Chinese labels for value domains (used for signal matching in confidence scoring)
const VALUE_DOMAIN_ZH = {
  health: ['健康', '身体', '医疗', '运动', '睡眠'],
  family: ['家庭', '家人', '父母', '孩子', '老婆', '老公', '家'],
  relationship: ['感情', '伴侣', '恋爱', '婚姻', '对象'],
  career: ['事业', '工作', '职业', '升职', '跳槽'],
  money: ['钱', '金钱', '收入', '薪资', '财富', '物质', '赚钱', '存款'],
  freedom: ['自由', '自主', '时间', '空闲', '弹性', '不想加班'],
  achievement: ['成就', '认可', '成功', '地位', '名声', '影响力'],
  stability: ['稳定', '安全', '保障', '安稳', '铁饭碗'],
  experience: ['体验', '新鲜', '旅行', '尝试', '冒险', '有趣'],
  social: ['社交', '朋友', '聚会', '人脉', '圈子'],
  learning: ['学习', '成长', '提升', '知识', '进步', '技能'],
  misc: [],
};

function getDomainZh(domain) {
  return (VALUE_DOMAIN_ZH[domain] || []).join(' ');
}

// Task 1.4: todayStr, daysBetween moved to engine/utils.js

// ─── Priority recalculation logic ────────────────────────────────────
// NOTE: The engine no longer applies rule-based priority formulas. Priority is
// owned by the AI / user. The recalc job only keeps deadline-derived fields
// (daysLeft, overdue) up to date, and ensures every active goal has a default
// priority when none is set.

function recalcUrgency(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return 10;
  if (daysLeft < 0) return 40;
  if (daysLeft === 0) return 40;
  if (daysLeft <= 2) return 39;
  if (daysLeft <= 7) return 36;
  if (daysLeft <= 30) return 30;
  if (daysLeft <= 90) return 20;
  return 10;
}

// Cost-effectiveness estimate (kept only for lingxi_create_plan initial priority)
function computeCostPerf(g, state) {
  const dl = g.deadline ? daysBetween(g.deadline) : null;
  if (dl == null) return 18; // no deadline → medium
  const est = (g.estimatedHours && g.estimatedHours > 0) ? g.estimatedHours : 12;
  const dailyCap = (state.userProfile && state.userProfile.dailyCapacity) || 3; // ~3h freely available per day
  const avail = Math.max(dl, 1) * dailyCap;
  if (est <= avail * 0.7) return 30;  // comfortably fits
  if (est <= avail) return 24;        // just right
  if (est <= avail * 1.5) return 14;  // tight
  return 6;                           // unrealistic
}

/**
 * Minimal priority maintenance.
 * The engine does NOT overwrite AI/user priority scores. It only:
 *   1. Refreshes daysLeft / overdue for goals with deadlines.
 *   2. Sets a neutral default priority (50) when a goal has none.
 * Returns an empty list unless a missing priority was backfilled.
 */
function recalcPriorities(state) {
  const now = new Date().toISOString();
  const goals = (state.currentGoals || []).filter(g => !g.completed);
  const changes = [];

  for (const g of goals) {
    if (g.deadline) {
      const dl = daysBetween(g.deadline);
      g.daysLeft = dl;
      g.overdue = dl < 0;
    } else {
      g.daysLeft = null;
      g.overdue = false;
    }
    g.lastRecalculated = now;

    if (g.priority === undefined || g.priority === null) {
      const newPriority = 50;
      changes.push({ id: g.id, title: g.title, oldPriority: g.priority, newPriority, daysLeft: g.daysLeft, overdue: g.overdue, scoreSource: 'default' });
      g.priority = newPriority;
      g.updatedAt = now;
    }
  }

  return changes;
}

// ─── Information completeness check (follow-up logic) ──────────────────────────

// ── Generic planning engine (replaces the old exam-specific create_study_plan) ──
// Any "deadline + decomposable" goal goes through here: exams/certifications/theses/projects/fitness challenges, etc.
// Phases can be explicitly specified by the AI via args.phases (embodying intelligence); otherwise auto-split by cycle length.
// Priority is not hand-written by this function — delegated to recalcPriorities for unified computation (already fuses urgency + strategic fit + cost-effectiveness + values).
async function buildPlan(state, args) {
  const now = new Date().toISOString();
  const title = (args.title || args.examType || '').toString().trim();
  const deadline = args.deadline || args.examDate;
  const components = args.components || args.subjects || [];
  const description = (args.description || '').toString().trim();
  const dailyHours = args.dailyHours || args.dailyAvailableHours || 3;
  const preferredSlot = args.preferredTimeSlot || args.preferredSlot || 'all-day';
  const notes = (args.notes || '').toString().trim();
  const isExamFallback = !!args.examType && !args.title;

  if (!title) return { error: 'Missing goal title (or examType)' };
  if (!deadline) return { error: 'Missing deadline (or examDate)' };

  const daysTo = daysBetween(deadline);
  if (daysTo === null) return { error: 'Invalid deadline format: ' + deadline };
  if (daysTo <= 0) return { error: 'Deadline ' + deadline + ' has passed or is today; cannot plan' };

  // ── Second brain: AI-provided topic (no keyword matching) ──
  let topicId = null;
  try {
    const brain = getBrainIndex();
    if (args.topic && typeof args.topic === 'string') {
      topicId = brain.ensureTopic(args.topic, { domain: args.domain || 'academic', category: args.category });
    }
  } catch {}

  state.strategicGoals = state.strategicGoals || [];
  state.currentGoals = state.currentGoals || [];
  state.constraints = state.constraints || [];

  // 1) Strategic goal
  const sgId = genId('sg');
  const sgDesc = [
    'Goal: ' + title,
    'Deadline: ' + deadline + ' (' + daysTo + ' days from now)',
    components.length ? 'Components: ' + components.join(', ') : '',
    description ? 'Note: ' + description : '',
    'Daily available: ' + dailyHours + ' hours, prefers ' + preferredSlot,
    notes ? 'Remarks: ' + notes : '',
  ].filter(Boolean).join('\n');
  const strategicGoal = {
    id: sgId, title: title, description: sgDesc,
    priority: 50, // neutral default; AI/user will own the score
    locked: false, source: 'ai',
    createdAt: now, updatedAt: now,
    subTasks: components.slice(),
    topicId: topicId,
  };
  if (topicId) {
    try { getBrainIndex().linkEntity(topicId, 'goals', sgId); } catch {}
  }
  state.strategicGoals.push(strategicGoal);

  // 2) Phased current goals
  const createdPhases = [];
  let phaseSpecs = [];
  let usePhases = false;
  if (Array.isArray(args.phases) && args.phases.length > 0) {
    const raw = args.phases.slice(0, 5); // guardrail: at most 5 phases
    // guardrail: each phase must have a valid name + valid deadline (>0 and <= total deadline)
    const allValid = raw.every(function (p) {
      return p && typeof p.name === 'string' && p.name.trim() &&
        p.deadline && daysBetween(p.deadline) !== null &&
        daysBetween(p.deadline) > 0 && daysBetween(p.deadline) <= daysTo;
    });
    // guardrail: deadlines must be strictly ascending (otherwise timeline broken → fallback)
    let asc = true;
    for (let i = 1; i < raw.length; i++) {
      if (daysBetween(raw[i].deadline) <= daysBetween(raw[i - 1].deadline)) { asc = false; break; }
    }
    if (allValid && asc) {
      const used = {};
      phaseSpecs = raw.map(function (p, idx) {
        let nm = p.name.trim() || ('Phase ' + (idx + 1));
        if (used[nm]) nm = nm + ' ' + (idx + 1); // dedupe name
        used[nm] = true;
        const det = (p.detail && p.detail.trim()) ? p.detail.trim() : (title + ' - ' + nm);
        const fcs = Array.isArray(p.focus) ? p.focus.map(String).filter(Boolean) : [];
        return { name: nm, deadline: p.deadline, detail: det, focus: fcs };
      });
      usePhases = true;
    }
  }
  if (!usePhases) {
    const n = daysTo > 90 ? 4 : daysTo > 30 ? 3 : daysTo > 14 ? 2 : 1;
    if (n === 1) {
      phaseSpecs = [{ name: '', deadline: deadline, detail: title + ' (overall progress)', focus: [] }];
    } else {
      const labels = n === 2 ? ['Early', 'Late'] : n === 3 ? ['Early', 'Mid', 'Late'] : ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4'];
      for (let i = 0; i < n; i++) {
        const endOffset = Math.round(daysTo * (i + 1) / n);
        const d = new Date();
        d.setDate(d.getDate() + Math.max(endOffset - 1, 1));
        const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        phaseSpecs.push({ name: labels[i], deadline: ds, detail: title + ' - ' + labels[i], focus: [] });
      }
    }
  }

  for (const ps of phaseSpecs) {
    const cgId = genId('cg');
    const dl = daysBetween(ps.deadline);
    // Distinguish phase goals by phaseName in title (avoids duplicate "English Speaking" × 3 in briefing)
    const phaseTitle = ps.name ? `${title} [${ps.name}]` : title;
    const cg = {
      id: cgId,
      title: phaseTitle,
      phaseName: ps.name || '',
      baseTitle: title,
      description: title + ' - ' + (ps.name || 'overall') + (ps.focus && ps.focus.length ? ' (focus: ' + ps.focus.join(', ') + ')' : ''),
      detail: ps.detail,
      focus: ps.focus || [],
      deadline: ps.deadline,
      priority: 50, // neutral default; AI/user will own the score
      locked: false, source: 'ai',
      daysLeft: dl, overdue: dl < 0,
      relatedStrategicGoalId: sgId,
      lastRecalculated: now,
      _lastUrgency: undefined,
      completed: false,
      createdAt: now, updatedAt: now,
      topicId: topicId,  // Link to the AI-provided topic
    };
    // Link the phase goal to the topic (foreign-key association)
    if (topicId) {
      try { getBrainIndex().linkEntity(topicId, 'goals', cgId); } catch {}
    }
    state.currentGoals.push(cg);
    createdPhases.push({ id: cgId, title: cg.title, deadline: ps.deadline });
  }

  // 3) Constraints (not hardcoded — only per explicit user request or sensible defaults)
  const createdConstraints = [];
  const constraintTitles = (Array.isArray(args.constraints) ? args.constraints : [])
    .map(function (c) { return typeof c === 'string' ? c : (c.title || ''); }).filter(Boolean);
  if (constraintTitles.length > 0) {
    for (const ct of constraintTitles) {
      const ctId = genId('ct');
      state.constraints.push({ id: ctId, title: ct, description: ct, priority: 60, locked: false, source: 'ai', createdAt: now, updatedAt: now });
      createdConstraints.push({ id: ctId, title: ct });
    }
  } else if (isExamFallback) {
    const c1 = genId('ct');
    state.constraints.push({ id: c1, title: 'No late nights', description: 'Sleep before 23:00, ensure adequate rest.', priority: 70, locked: false, source: 'ai', createdAt: now, updatedAt: now });
    createdConstraints.push({ id: c1, title: 'No late nights' });
    const c2 = genId('ct');
    state.constraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort'), description: ('Ensure ' + dailyHours + ' hours of effective daily effort; prefers ' + preferredSlot + '.'), priority: 65, locked: false, source: 'ai', createdAt: now, updatedAt: now });
    createdConstraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort') });
  } else if (dailyHours && dailyHours > 0) {
    const c2 = genId('ct');
    state.constraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort'), description: ('Ensure ' + dailyHours + ' hours of daily effort; prefers ' + preferredSlot + '.'), priority: 65, locked: false, source: 'ai', createdAt: now, updatedAt: now });
    createdConstraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort') });
  }

  // 4) Write back + delegate to auto_schedule (recalc computes priorities + generates schedule/briefing here)
  writeState(state);
  const scheduleResult = await handleToolCall('lingxi_auto_schedule', {
    startDate: todayStr(),
    days: daysTo + 1,
  });

  // 5) Don't hand-write the briefing — let auto_schedule's language-aware briefing take effect
  return {
    success: true,
    message: 'Created a structured plan for "' + title + '": ' + daysTo + ' days to deadline, split into ' + phaseSpecs.length + ' phases, covering the full schedule. Priorities default to 50 and are owned by you / the AI.',
    strategicGoal: { id: sgId, title: title },
    currentGoals: createdPhases,
    constraints: createdConstraints,
    scheduleSummary: scheduleResult && scheduleResult.success ? { totalDays: scheduleResult.totalDays } : { error: scheduleResult && scheduleResult.error },
  };
}

function checkGoalInfoSufficiency(args) {
  // AI-DRIVEN: the AI itself decides whether to ask clarifying questions before calling add_goal.
  // The engine no longer uses keyword matching to detect "vague" titles.
  // Basic structural checks only (not semantic):
  const title = (args.title || '').trim();
  if (!title) {
    return {
      missingInfo: ['title'],
      questions: ['What is the title of this goal?'],
      message: 'Goal title is required.',
    };
  }
  return null; // sufficient information — AI handles semantic sufficiency
}

function getConstraintQuestions(title) {
  // AI-DRIVEN: the AI generates appropriate follow-up questions based on context.
  // The engine no longer uses keyword-based question templates.
  return [
    'What is the specific rule for this constraint?',
    'Is it a hard rule or flexible? Are there exceptions?',
  ];
}

function getFollowUpQuestions(type, title) {
  if (type === 'strategicGoal') {
    return [
      `About "${title}", about how much time per day can you invest? Which time slot do you prefer?`,
      'What is your current foundation/progress? Any preparation already done?',
      'Are there any immovable fixed commitments (work/class/other) I should know about?',
      'Do you want me to break this goal down into a concrete schedule plan?',
    ];
  }
  if (type === 'currentGoal') {
    return [
      `Do you want me to slot "${title}" into the schedule? When would you like it arranged?`,
      'Are there any prerequisite dependencies — anything that must be done first before starting?',
      'Compared to your other goals, what is the priority of this task?',
    ];
  }
  if (type === 'constraint') {
    return [
      'Understood. I will treat this constraint as a hard rule for schedule generation, automatically obeyed in future plans.',
      'Are there exceptions to this constraint? For example, weekends/holidays/special occasions?',
    ];
  }
  return [];
}

// ─── Conflict detection logic ──────────────────────────────────────

function detectConflicts(state) {
  // Rebuild derived conflicts on every run. A conflict is a current condition, not
  // permanent history: resolved overlaps and changed deadlines must disappear.
  const conflicts = [];
  const constraints = state.constraints || [];
  const goals = state.currentGoals || [];
  const add = (conflict) => {
    const duplicate = conflicts.some(existing =>
      existing.type === conflict.type && existing.date === conflict.date &&
      JSON.stringify(existing.relatedGoals || []) === JSON.stringify(conflict.relatedGoals || []) &&
      existing.firstId === conflict.firstId && existing.secondId === conflict.secondId &&
      existing.constraintId === conflict.constraintId
    );
    if (!duplicate) conflicts.push({ id: genId('conflict'), createdAt: new Date().toISOString(), ...conflict });
  };

  // 1. Detect overdue goals
  for (const g of goals) {
    if (g.overdue && !g.completed) {
      add({
        type: 'ddl_overdue', severity: 'critical', title: `${g.title} is overdue`,
        description: `Goal "${g.title}" (deadline: ${g.deadline}) is overdue by ${Math.abs(g.daysLeft)} days`,
        suggestion: 'Recommend handling first or adjusting the deadline', relatedGoals: [g.id], relatedConstraints: [],
      });
    }
  }

  // 2. Detect upcoming deadlines (within 48 hours)
  for (const g of goals) {
    if (!g.overdue && !g.completed && g.daysLeft !== null && g.daysLeft <= 2) {
      add({
        type: 'ddl_urgent', severity: 'warning', title: `${g.title} is about to be due`,
        description: `Goal "${g.title}" is only ${g.daysLeft} days from deadline`,
        suggestion: 'Recommend scheduling time to complete first', relatedGoals: [g.id], relatedConstraints: [],
      });
    }
  }

  // 3. Re-check all timed actions. The schedule contains planned tasks while the
  // action list contains user-created timed actions; merge them without double-counting
  // auto-scheduled errand tasks linked by errandId.
  const byDate = new Map();
  const appendEntry = (date, entry) => {
    if (!date || !entry.time || entry.completed) return;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(entry);
  };
  const scheduledErrandIds = new Set();
  for (const [date, day] of Object.entries(state.schedule?.days || {})) {
    for (const task of (day.tasks || [])) {
      if (task.errandId) scheduledErrandIds.add(task.errandId);
      appendEntry(date, {
        id: task.id, title: task.title, time: task.time, duration: task.duration || 60,
        completed: task.completed, kind: task.category === 'errand' ? 'errand' : 'task',
      });
    }
  }
  for (const action of (state.errands || [])) {
    if (!scheduledErrandIds.has(action.id)) {
      appendEntry(action.date, {
        id: action.id, title: action.title, time: action.time, duration: action.duration || 60,
        completed: action.completed, kind: 'errand',
      });
    }
  }

  for (const [date, entries] of byDate) {
    const timed = entries
      .map(item => ({ ...item, start: parseTimeToMin(item.time) }))
      .filter(item => item.start !== null)
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < timed.length; i++) {
      const first = timed[i];
      const firstEnd = first.start + first.duration;
      for (let j = i + 1; j < timed.length; j++) {
        const second = timed[j];
        if (second.start >= firstEnd) break;
        add({
          type: 'schedule_overlap', severity: 'warning', date,
          title: 'Timed actions overlap', firstId: first.id, secondId: second.id,
          description: `"${first.title}" (${first.time}) overlaps with "${second.title}" (${second.time})`,
          suggestion: 'Move one action or shorten its duration.', relatedGoals: [], relatedConstraints: [],
        });
      }
    }
    const totalMinutes = timed.reduce((sum, item) => sum + item.duration, 0);
    if (totalMinutes > 8 * 60) {
      add({
        type: 'day_overload', severity: 'warning', date, title: 'Day is overbooked',
        description: `${Math.round(totalMinutes / 6) / 10} hours of timed actions are scheduled.`,
        suggestion: 'Move, shorten, or explicitly de-prioritize one action.', relatedGoals: [], relatedConstraints: [],
      });
    }
  }

  // 4. Constraints are executable structured rules supplied by the AI, never parsed
  // from a title. Check the current schedule against those rules.
  for (const constraint of constraints) {
    for (const rule of (constraint.rules || [])) {
      if (rule.type === 'no_late_night' && rule.sleepTime) {
        const sleepHour = Number(String(rule.sleepTime).split(':')[0]);
        const latest = Math.max((Number.isFinite(sleepHour) ? sleepHour : 23) - 2, 19) * 60;
        for (const [date, entries] of byDate) {
          for (const item of entries) {
            const start = parseTimeToMin(item.time);
            if (start !== null && start + item.duration > latest) {
              add({
                type: 'constraint_violation', severity: 'warning', date, constraintId: constraint.id,
                title: `Violates "${constraint.title}"`,
                description: `"${item.title}" ends after the latest permitted time.`,
                suggestion: 'Move it earlier or explicitly make an exception.', relatedGoals: [], relatedConstraints: [constraint.id],
              });
            }
          }
        }
      }
      if (rule.type === 'rest_day' && rule.dayOfWeek !== undefined) {
        for (const [date, entries] of byDate) {
          const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
          const workItems = entries.filter(item => item.kind !== 'errand');
          if (dayOfWeek === rule.dayOfWeek && workItems.length) {
            add({
              type: 'constraint_violation', severity: 'warning', date, constraintId: constraint.id,
              title: `Violates "${constraint.title}"`,
              description: `${workItems.length} planned task(s) fall on this rest day.`,
              suggestion: 'Move the task or explicitly make an exception.', relatedGoals: [], relatedConstraints: [constraint.id],
            });
          }
        }
      }
    }
  }

  state.conflicts = conflicts;
  return conflicts;
}

// A lightweight, idempotent daily check. It updates deadline-derived fields and
// current conflicts, but never overwrites a user lock or replaces an AI score with
// a formula. AI re-scoring remains an explicit, explainable judgment.
function runDailyCheck(state) {
  const priorityChanges = recalcPriorities(state);
  const conflicts = detectConflicts(state);
  const aiReviewNeeded = (state.currentGoals || [])
    .filter(goal => !goal.completed && !goal.locked && (goal.aiScoreStale || (goal.scoreSource !== 'ai' && goal.deadline)))
    .map(goal => ({ id: goal.id, title: goal.title, deadline: goal.deadline || null, daysLeft: goal.daysLeft ?? null }));
  state.meta = state.meta || {};
  state.meta.lastDailyCheck = new Date().toISOString();
  return {
    ranAt: state.meta.lastDailyCheck,
    priorityChanges,
    conflicts: { total: conflicts.length, critical: conflicts.filter(item => item.severity === 'critical').length },
    aiReviewNeeded,
  };
}

// ── Same-day conflict detection: checks if a new errand/goal/event conflicts
//    with existing items on the same day. Pure mathematical calculation based on
//    AI-provided fields (timeCost, requiresPresence, blocksFocus) — NO keyword matching.
//    The AI is responsible for assessing the conflict risk of each item; the engine
//    only does the math (time overlap, total time budget, focus-block collision).
//
//    HIERARCHY-OPTIMIZED: Only reads the target day's schedule file + goal index.
//    Does NOT load full state or all schedule days — saves tokens.
function detectSameDayConflicts(state, {
  date, time, duration, title, priority, type,
  timeCost,        // AI-judged: estimated total hours this item will consume (including transit, prep, etc.)
  requiresPresence, // AI-judged: does this require the user to be physically present? (true/false)
  blocksFocus,     // AI-judged: will this item prevent the user from focusing on other work? (true/false)
}) {
  if (!date) return [];
  const conflicts = [];
  const durationMin = duration || (timeCost ? timeCost * 60 : 60);
  const newStart = time ? parseTimeToMin(time) : null;
  const newEnd = newStart !== null ? newStart + durationMin : null;
  const newTimeCost = timeCost || (durationMin / 60);

  // 1. Time overlap with existing errands on the same day (pure math)
  //    HIERARCHY: read errands from state (already lightweight) — errands are small
  const sameDayErrands = (state.errands || []).filter(e => e.date === date && !e.completed && e.title !== title);
  for (const e of sameDayErrands) {
    if (newStart !== null && e.time) {
      const eStart = parseTimeToMin(e.time);
      const eEnd = eStart + (e.duration || 60);
      if (newStart < eEnd && newEnd > eStart) {
        conflicts.push({
          type: 'time_overlap',
          severity: 'warning',
          date,
          existing: e.title,
          existingTime: e.time,
          newItem: title,
          newTime: time,
          message: `Time overlap on ${date}: "${e.title}" (${e.time}) and "${title}" (${time})`,
          suggestion: 'Adjust the time of one of them, or move one to another day',
        });
      }
    }
  }

  // 2. Total time budget check: sum all same-day errand time costs
  let totalDayHours = newTimeCost;
  for (const e of sameDayErrands) {
    totalDayHours += (e.timeCost || (e.duration ? e.duration / 60 : 1));
  }
  if (totalDayHours > 8) {
    conflicts.push({
      type: 'day_overload',
      severity: 'warning',
      date,
      totalHours: Math.round(totalDayHours * 10) / 10,
      newItem: title,
      message: `Total errand time on ${date} reaches ${Math.round(totalDayHours * 10) / 10} hours — little time left for goals/rest`,
      suggestion: 'Consider moving some items to another day, or reducing scope',
    });
  }

  // 3. Goal deadline collision: AI-judged focus-blocking item lands on a deadline day
  //    HIERARCHY: use goal INDEX from lightweight state (has deadline + title + completed)
  //    Does NOT need to load full goal detail — only deadline and title matter here
  const sameDayGoals = (state.currentGoals || []).filter(g => g.deadline === date && !g.completed);
  for (const g of sameDayGoals) {
    const willBlockFocus = blocksFocus === true || requiresPresence === true || newTimeCost >= 4;
    if (willBlockFocus) {
      conflicts.push({
        type: 'deadline_collision',
        severity: 'critical',
        date,
        goal: g.title,
        goalId: g.id,
        newItem: title,
        message: `"${title}" on ${date} conflicts with deadline "${g.title}" — this item will consume ${Math.round(newTimeCost * 10) / 10}h and block focus on a critical day`,
        suggestion: `Recommend moving "${title}" to another day, or finishing "${g.title}" in advance`,
      });
    }
  }

  // 4. Schedule overlap with already-scheduled tasks
  //    HIERARCHY: read ONLY the target day's schedule file, not all schedule days
  let dayTasks = [];
  try {
    const daySchedule = Storage.getDaySchedule(date);
    dayTasks = (daySchedule && daySchedule.tasks) || [];
  } catch {
    // Fallback: read from state.schedule.days if hierarchy not available
    const days = (state.schedule && state.schedule.days) || {};
    const dayData = days[date];
    dayTasks = (dayData && dayData.tasks) || [];
  }
  for (const task of dayTasks) {
    if (task.completed) continue;
    if (newStart !== null && task.time) {
      const tStart = parseTimeToMin(task.time);
      const tEnd = tStart + (task.duration || 60);
      if (newStart < tEnd && newEnd > tStart) {
        conflicts.push({
          type: 'schedule_overlap',
          severity: 'warning',
          date,
          existing: task.title,
          existingTime: task.time,
          newItem: title,
          newTime: time,
          message: `"${title}" (${time}) overlaps with scheduled "${task.title}" (${task.time}) on ${date}`,
          suggestion: 'Reschedule one of them to a non-overlapping slot',
        });
      }
    }
  }

  return conflicts;
}

function parseTimeToMin(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// ─── MCP tool definitions ──────────────────────────────────────

const TOOLS = [
  // ── Data Reading ──
  {
    name: 'lingxi_get_state',
    description: 'Read ZhiGui state: strategic goals, constraints, current goals, schedule, briefing, conflicts, errands, notes and value system. Optional `sections` limits the returned data.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['strategicGoals', 'constraints', 'currentGoals', 'schedule', 'morningBriefing', 'conflicts', 'meta', 'errands', 'notes', 'userProfile'] },
          description: 'Data sections to read; omit to return all',
        },
      },
    },
  },
  // ── Topic Reorganization ──
  {
    name: 'lingxi_propose_topic_split',
    description: 'Propose splitting a topic into smaller ones. Use when a topic has grown large and contains notes that diverge into distinct sub-themes. First read the topic document (lingxi_get_topic_document), then analyze whether notes naturally cluster into separate groups. The proposal enters the review queue — it is NOT executed until the user accepts it.',
    inputSchema: {
      type: 'object',
      required: ['sourceTopicId', 'noteMoves', 'newTopics'],
      properties: {
        sourceTopicId: { type: 'string', description: 'The topic ID to split.' },
        noteMoves: { type: 'array', description: 'Notes to move: [{ noteId, targetTopicLabel }]. Notes not listed stay in the source topic.', items: { type: 'object', properties: { noteId: { type: 'string' }, targetTopicLabel: { type: 'string' } }, required: ['noteId', 'targetTopicLabel'] } },
        newTopics: { type: 'array', description: 'New topics to create: [{ label, category, domain? }].', items: { type: 'object', properties: { label: { type: 'string' }, category: { type: 'string' }, domain: { type: 'string' } }, required: ['label', 'category'] } },
        reason: { type: 'string', description: 'Why this split makes sense. Explain the thematic divergence.' },
      },
    },
  },
  {
    name: 'lingxi_propose_topic_merge',
    description: 'Propose merging one or more related topics into a single topic. Use when several topics clearly belong to the same project or theme (e.g. five sub-topics all under a neural-network project) and keeping them separate adds noise. First read the topic documents, then assess semantic overlap. The proposal enters the review queue — it is NOT executed until the user accepts it.',
    inputSchema: {
      type: 'object',
      required: ['targetTopicId'],
      properties: {
        sourceTopicId: { type: 'string', description: 'Legacy single source topic to absorb (will be deleted after merge). Prefer sourceTopicIds for multiple sources.' },
        sourceTopicIds: { type: 'array', description: 'Array of topic IDs to absorb into the target. All will be deleted after merge.', items: { type: 'string' } },
        targetTopicId: { type: 'string', description: 'The topic to absorb into (survives the merge).' },
        reason: { type: 'string', description: 'Why these topics should merge. Explain the thematic/project overlap.' },
      },
    },
  },
  {
    name: 'lingxi_propose_topic_rename',
    description: 'Propose renaming a topic. Use when a topic\'s content has evolved and the original label no longer accurately describes it, or when the label can be made clearer. The proposal enters the review queue — it is NOT executed until the user accepts it.',
    inputSchema: {
      type: 'object',
      required: ['topicId', 'newLabel'],
      properties: {
        topicId: { type: 'string', description: 'The topic to rename.' },
        newLabel: { type: 'string', description: 'The proposed new label.' },
        reason: { type: 'string', description: 'Why the current label no longer fits. Describe the evolution.' },
      },
    },
  },
  {
    name: 'lingxi_propose_topic_precipitation',
    description: 'Propose extracting a topic\'s notes from notes.json into a standalone topics/<id>.json file. Use when a topic has grown large enough that splitting it would speed up retrieval and reduce tokens. The proposal enters the review queue — it is NOT executed until the user accepts it. There is no automatic threshold; the AI decides based on the topic\'s size and coherence.',
    inputSchema: {
      type: 'object',
      required: ['topicId'],
      properties: {
        topicId: { type: 'string', description: 'The topic whose notes should be extracted into a standalone file.' },
        reason: { type: 'string', description: 'Why this topic deserves its own file. Describe size or coherence rationale.' },
      },
    },
  },
  {
    name: 'lingxi_get_today',
    description: 'Get today schedule, briefing, urgent items, active topics, and the note title index. Note bodies are deliberately excluded. Read a single body only when relevant with lingxi_get_note_detail(noteId), or load a selected topic with lingxi_get_topic_document(topicId).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingxi_get_history',
    description: 'Read conversation history memory. ZhiGui history is cumulative; the AI should read history before generating a schedule to understand user context.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Most recent N records; omit to return all' },
      },
    },
  },

  // ── Goal Management ──
  {
    name: 'lingxi_add_goal',
    description: 'Add a strategic goal / current goal / constraint. This tool checks whether information is sufficient — if not, it returns needsClarification=true and a list of follow-up questions; you must ask the user, never assume. Returns success=true only when information is sufficient. Set force=true to skip the check (use only when the user has explicitly provided enough info).',
    inputSchema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        type: { type: 'string', enum: ['strategicGoal', 'currentGoal', 'constraint'] },
        title: { type: 'string', description: 'Goal/constraint title' },
        description: { type: 'string', description: 'Detailed description (strategic goals must provide: specific direction, institution/major, current foundation, etc.)' },
        priority: { type: 'number', description: '0-100 priority score; omit to auto-calculate' },
        deadline: { type: 'string', description: 'YYYY-MM-DD deadline (currentGoal only, optional; omit if no fixed deadline)' },
        detail: { type: 'string', description: 'Supplementary detail (currentGoal only, required: what exactly to do, what the deliverable is)' },
        subTasks: { type: 'array', items: { type: 'string' }, description: 'Sub-task list (strategicGoal only)' },
        locked: { type: 'boolean', description: 'Whether to lock priority, default false' },
        force: { type: 'boolean', description: 'Skip information-completeness check. Use only when the user has explicitly provided enough info via conversation. Default false.' },
        domain: { type: 'string', description: 'AI-determined free-form life-domain label. NOT limited to a fixed list - create a new label (e.g. neural_networks, pets, parenting) or reuse an existing one so value-system weighting can match it. No keyword matching.' },
        topic: { type: 'string', description: 'Topic label for second-brain classification, AI-determined (e.g. "PMP Exam", "English Learning", "Guitar Practice"). The engine creates/links the topic automatically — no keyword matching.' },
        category: { type: 'string', description: 'AI-determined free-form high-level category for Topic Library grouping - invent a new one or reuse an existing label; no fixed list.' },
        isOneShot: { type: 'boolean', description: 'AI-judged: is this a one-shot event goal (exam day, appointment, trip, moving)? true = only appears as a lightweight reminder within 3 days of deadline, not a daily heavy study block. The AI should set this based on the nature of the goal, not keyword matching.' },
        relatedStrategicGoalId: { type: 'string', description: 'AI-judged: if this current goal belongs to a strategic goal, pass the strategic goal ID. The engine uses this for priority scoring (no keyword matching).' },
        rules: {
          type: 'array',
          description: 'AI-judged structured constraint rules (only for type=constraint). The engine uses these instead of parsing free-text titles. Each rule has a type and type-specific params.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['no_late_night', 'rest_day', 'daily_exercise', 'daily_hours'], description: 'Rule type' },
              sleepTime: { type: 'string', description: '[no_late_night] Sleep time HH:MM, e.g. "23:00"' },
              dayOfWeek: { type: 'number', description: '[rest_day] 0=Sunday, 6=Saturday' },
              durationMinutes: { type: 'number', description: '[daily_exercise] Exercise duration in minutes' },
              hours: { type: 'number', description: '[daily_hours] Daily study hours' },
            },
          },
        },
      },
    },
  },
  {
    name: 'lingxi_update_goal',
    description: 'Update goal/constraint attributes: title, description, priority, deadline, lock state, completion state, etc.',
    inputSchema: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: { type: 'string', description: 'Goal ID (sg_xxx / cg_xxx / ct_xxx)' },
        type: { type: 'string', enum: ['strategicGoal', 'currentGoal', 'constraint'] },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number', description: '0-100' },
        deadline: { type: 'string', description: 'YYYY-MM-DD (currentGoal only, optional)' },
        detail: { type: 'string' },
        locked: { type: 'boolean', description: 'true=lock, false=unlock' },
        completed: { type: 'boolean', description: 'Mark as completed (currentGoal only)' },
        subTasks: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'lingxi_delete_goal',
    description: 'Delete a goal or constraint. This AUTO-cascades and removes every schedule task derived from this goal. IMPORTANT: first call with confirm:false (or omit) to get a cascade preview — the goal plus every associated task with its date — show that checklist to the user for confirmation, THEN call again with confirm:true to actually delete.',
    inputSchema: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: { type: 'string' },
        type: { type: 'string', enum: ['strategicGoal', 'currentGoal', 'constraint'] },
        confirm: { type: 'boolean', description: 'false (or omitted) = preview the cascade manifest only; true = execute the delete + cascade.' },
      },
    },
  },

  // ── Schedule Tasks ──
  {
    name: 'lingxi_add_task',
    description: 'Add one confirmed calendar commitment. Use only when the user explicitly supplied or accepted the exact date and start time. Never invent a time, duration, adjacent task, or routine. If time is unknown, use lingxi_add_errand without time so it stays in the unscheduled queue.',
    inputSchema: {
      type: 'object',
      required: ['date', 'time', 'title'],
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM start time' },
        duration: { type: 'number', description: 'Duration in minutes' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number', description: '0-100' },
        category: { type: 'string', enum: ['study', 'meeting', 'exercise', 'travel', 'event'] },
        resource: { type: 'string', description: 'Associated learning resource' },
      },
    },
  },
  {
    name: 'lingxi_update_task',
    description: 'Update a task in the schedule (e.g. mark as completed, change time).',
    inputSchema: {
      type: 'object',
      required: ['date', 'taskId'],
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        taskId: { type: 'string' },
        time: { type: 'string' },
        duration: { type: 'number' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        completed: { type: 'boolean' },
        category: { type: 'string' },
        resource: { type: 'string' },
      },
    },
  },
  {
    name: 'lingxi_delete_task',
    description: 'Delete a task from the schedule.',
    inputSchema: {
      type: 'object',
      required: ['date', 'taskId'],
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        taskId: { type: 'string' },
      },
    },
  },

  // ── Logic Computation ──
  {
    name: 'lingxi_recalc_priorities',
    description: 'Refresh deadline-derived fields (daysLeft/overdue) and backfill missing priorities with a neutral default. The engine no longer applies rule-based priority formulas; AI contextual judgment owns the scores.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingxi_score_goals',
    description: 'AI-driven priority scoring. The AI evaluates each active goal with contextual reasoning (not just deadline lookup) and assigns a priority score (0-100). Use this when: (1) rule-based recalc feels too mechanical, (2) soft factors like difficulty/momentum/dependency/emotional state matter, (3) the user\'s value system should influence ranking. The AI should call this after major changes (new goal added, goal completed, value system updated) or when the user asks "what should I focus on?".',
    inputSchema: {
      type: 'object',
      properties: {
        scores: {
          type: 'array',
          description: 'AI-judged scores for active goals. Only include goals the AI wants to re-score (can be a subset).',
          items: {
            type: 'object',
            required: ['goalId', 'score', 'reasoning'],
            properties: {
              goalId: { type: 'string', description: 'Goal ID (g_xxx)' },
              score: { type: 'number', description: '0-100 priority score. Consider: urgency (deadline proximity), importance (value alignment), feasibility (time/effort), momentum (recent progress), dependencies (blocking others), emotional state (user stress level). The AI weighs these factors contextually — not by fixed formula.' },
              reasoning: { type: 'string', description: 'Why this score. e.g. "Deadline in 3 days (urgent), aligns with top strategic goal (important), but user is stressed this week (feasibility down) → 78"' },
              factors: {
                type: 'object',
                description: 'Optional: break down the score into factors for transparency.',
                properties: {
                  urgency: { type: 'number', description: '0-100 urgency sub-score' },
                  importance: { type: 'number', description: '0-100 importance sub-score (value alignment)' },
                  feasibility: { type: 'number', description: '0-100 feasibility sub-score' },
                  momentum: { type: 'number', description: '0-100 momentum sub-score' },
                },
              },
            },
          },
        },
        globalNote: { type: 'string', description: 'Optional: overall reasoning for this scoring round, e.g. "User is in crunch week, prioritized deadline-sensitive goals over development goals"' },
      },
    },
  },
  {
    name: 'lingxi_detect_conflicts',
    description: 'Run conflict detection: overdue goals, upcoming deadlines, time conflicts, constraint violations, strategic drift. Returns the detected conflict list.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Briefing & History ──
  {
    name: 'lingxi_set_briefing',
    description: "Compose today's morning briefing in natural language. After auto_schedule generates the schedule, the briefing contains structured raw data (_raw:true). Use this tool to write the briefing based on that data. YOU decide what to recommend — not formulas. Consider the user's value system, today's constraints, note signals, and goal deadlines. Write in the panel language (check meta.lang). Structure: use the suggested sections below as a gentle guide, not a rigid form. Omit or merge sections when it makes the briefing more natural. Each section should be 1-3 concise sentences.",
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        mustDo: { type: 'string', description: 'Suggested section: what the user MUST do today — deadlines, must-level errands, time-sensitive matters. Natural language. Omit if nothing is truly mandatory.' },
        recommended: { type: 'string', description: 'Suggested section: YOUR recommendation for the best use of today\'s prime time. Explain why (cost-perf, value alignment, deadline urgency). Not just a task name — a decision with reasoning.' },
        notRecommended: { type: 'string', description: 'Suggested section: behavior or choices that conflict with constraints or values today. Omit if not relevant.' },
        strategicReminder: { type: 'string', description: 'Suggested section: long-term direction reminder — connect today\'s work to the bigger picture. Omit if it repeats the recommendation.' },
        dailyQuote: { type: 'string', description: 'Optional closing: a short, relevant inspirational or thought-provoking quote (or skip if it feels forced).' },
        sections: {
          type: 'array',
          description: 'Alternative free-form structure. Use this when the rigid 5 fields feel awkward. Each item is a labeled paragraph; the label will be rendered as a bold inline prefix. Example: [{"label":"必须完成","content":"..."},{"label":"今日推荐","content":"..."}].',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Section label, e.g. 必须完成 / 今日推荐 / 不建议 / 战略提醒 / 每日一言' },
              content: { type: 'string', description: 'Natural-language content for this section. 1-3 sentences.' },
            },
            required: ['label', 'content'],
          },
        },
      },
    },
  },
  {
    name: 'lingxi_add_history',
    description: 'Append a concise record for a meaningful planning conversation. This tool does not extract or classify notes. When a durable note is useful, the AI separately calls lingxi_add_note with its own title, topic and category.',
    inputSchema: {
      type: 'object',
      required: ['userMessage', 'aiResponse'],
      properties: {
        userMessage: { type: 'string', description: 'The user original words' },
        aiResponse: { type: 'string', description: 'AI response summary' },
        extracted_strategicGoals: { type: 'array', items: { type: 'string' } },
        extracted_constraints: { type: 'array', items: { type: 'string' } },
        extracted_currentGoals: { type: 'array', items: { type: 'string' } },
        extracted_conflicts: { type: 'array', items: { type: 'string' } },
        extracted_actions: { type: 'array', items: { type: 'string' } },
      },
    },
  },

  // ── Panel Control ──
  {
    name: 'lingxi_set_panel',
    description: 'Control the dashboard panel expand/collapse state. Prerequisite: the ZhiGui desktop app (Electron) must already be running via start.bat, otherwise the panel will not show. This tool only controls expand/collapse of an already-running app; it does not launch the app itself.',
    inputSchema: {
      type: 'object',
      required: ['collapsed'],
      properties: {
        collapsed: { type: 'boolean', description: 'true=collapse, false=expand' },
      },
    },
  },
  {
    name: 'lingxi_set_theme',
    description: 'Switch the dashboard theme. Prerequisite: the ZhiGui desktop app (Electron) must be running.',
    inputSchema: {
      type: 'object',
      required: ['theme'],
      properties: {
        theme: { type: 'string', enum: ['light', 'dark'] },
      },
    },
  },
  {
    name: 'lingxi_launch_dashboard',
    description: 'Launch the ZhiGui visualization dashboard on the user desktop. Auto-starts the dashboard HTTP server (port 7788) as a detached background process if not already running, then opens the system browser to http://localhost:7788. Should be called at conversation start so the user can see the second brain state in real time. Returns the dashboard URL. Idempotent — safe to call repeatedly; if already running, just opens the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        open: { type: 'boolean', description: 'Whether to open the system browser. Default true. Set false to just start the server without opening a browser tab.' },
      },
    },
  },
  {
    name: 'lingxi_get_config',
    description: 'Get ZhiGui configuration info: data directory path, app directory path. For debugging.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Intelligence Layer ──
  {
    name: 'lingxi_get_instructions',
    description: '[Must call first] Get the full ZhiGui behavior guide. You are the ZhiGui scheduling assistant, not a database operator. Call this tool to get the complete rules for how to think, follow up, plan, and execute tasks. Includes: role positioning, follow-up rules, priority evaluation, conflict detection, constraint enforcement, schedule generation flow, user profile usage. Do not operate any data before reading this guide.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingxi_get_user_profile',
    description: 'Read the user profile when the current request needs preferences, values, communication style, or personal context. Do not load it automatically for unrelated operational actions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingxi_update_user_profile',
    description: 'Update the user profile. Call this tool in real time when new user traits are discovered in conversation (preferences, tone, tool tendencies, communication style, etc.). Supports incremental updates — pass only the fields to modify; others remain unchanged. Should be called once at the end of each conversation to record new user traits found during this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        personality: { type: 'string', description: 'User personality traits, e.g. "impatient/calm/perfectionist/casual"' },
        communicationStyle: { type: 'string', description: 'Communication preference, e.g. "concise & direct/detailed explanation/humorous/serious"' },
        preferredTools: { type: 'array', items: { type: 'string' }, description: 'Preferred tools/software' },
        workHabit: { type: 'string', description: 'Work habit free-text, e.g. "I work best in the afternoon and evening"' },
        chronotype: { type: 'string', enum: ['night_owl', 'early_bird', 'standard'], description: 'AI-judged chronotype for schedule slot allocation. night_owl = prime slots in afternoon/evening; early_bird = prime slots in morning; standard = balanced. The AI judges this from the user\'s workHabit description, NOT keyword matching.' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Hobbies and interests' },
        tonePreference: { type: 'string', description: 'Tone preference, e.g. "formal/casual/encouraging/direct"' },
        responseDetail: { type: 'string', description: 'Response detail preference, e.g. "concise/moderate/detailed"' },
        languageStyle: { type: 'string', description: 'Language style, e.g. "Chinese-dominant/Chinese-English mixed/technical jargon heavy"' },
        notes: { type: 'string', description: 'Other notes' },
        conversationCount: { type: 'number', description: 'Conversation count (auto-maintained by the system, no need to set manually)' },
      },
    },
  },
  {
    name: 'lingxi_auto_schedule',
    description: 'Generate a proposed schedule only after the user explicitly asks for planning or accepts a proposed plan. It may read relevant goals, constraints and selected context, then detects conflicts and preserves manual times. Do not call it after a simple note, errand, or meeting statement; do not use it to fill a day with inferred routines.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD plan start date, defaults to today' },
        days: { type: 'number', description: 'How many days of plan to generate. Omit to auto-compute up to the farthest deadline (max 180 days)' },
      },
    },
  },
  {
    name: 'lingxi_check_impact',
    description: 'Analyze the impact of a new goal/constraint on the existing plan. Call this tool when the user proposes a new requirement. Returns: conflicts with existing goals, contradictions with constraints, whether time budget is overloaded, specific impact on the schedule. Helps you find problems before adding data.',
    inputSchema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        type: { type: 'string', enum: ['strategicGoal', 'currentGoal', 'constraint'], description: 'The type to add' },
        title: { type: 'string', description: 'Title' },
        deadline: { type: 'string', description: 'YYYY-MM-DD (currentGoal only, optional)' },
        description: { type: 'string' },
        constraintAssessments: {
          type: 'array',
          description: 'AI judgments made after loading the relevant constraint details. The engine does not infer contradictions from text.',
          items: {
            type: 'object',
            required: ['constraintId', 'conflicts', 'reasoning'],
            properties: {
              constraintId: { type: 'string' },
              conflicts: { type: 'boolean' },
              reasoning: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'lingxi_create_plan',
    description: '[General planning] One-click generation of a structured plan for any "deadline + decomposable" complex goal: exams/certifications/theses/projects/fitness challenges, etc. 1) Create a strategic goal 2) Create multiple current goals by phase (phases can be explicitly specified by the AI via `phases`, otherwise auto-split into early/mid/late by cycle length) 3) Create constraints (per user request or sensible defaults) 4) Call auto_schedule to generate the full schedule. Priorities are not hand-written — computed uniformly by recalcPriorities based on urgency + strategic fit + cost-effectiveness + values. lingxi_create_study_plan is a compatible alias.',
    inputSchema: {
      type: 'object',
      required: ['title', 'deadline'],
      properties: {
        title: { type: 'string', description: 'Strategic goal title, e.g. "Pass the postgraduate entrance exam", "Finish the thesis", "Pass CFA", "Lose 10 jin"' },
        deadline: { type: 'string', description: 'YYYY-MM-DD deadline' },
        components: { type: 'array', items: { type: 'string' }, description: 'Goal components/subjects/milestones list, e.g. ["Math","English","Politics"] or ["Literature Review","Experiment","Writing"]' },
        description: { type: 'string', description: 'Supplementary description of the goal (optional)' },
        dailyHours: { type: 'number', description: 'Hours available per day (optional, default 3)' },
        preferredTimeSlot: { type: 'string', description: 'Preferred time slot: morning/afternoon/evening/all-day (optional)' },
        phases: { type: 'array', description: 'A phased plan designed by the AI in conversation for a deadline-bound complex goal (embodies intelligence). Each phase contains name/deadline/detail/focus. Recommended to present this plan as a proposal for user confirmation during the follow-up phase before passing it in; if omitted, the system auto-splits into early/mid/late by cycle length.', items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Phase name, e.g. "Foundation", "Intensive", "Data Collection", "Writing"' },
            deadline: { type: 'string', description: 'Phase deadline YYYY-MM-DD (must be strictly earlier than the next phase and no later than the overall deadline)' },
            detail: { type: 'string', description: 'Specific task description for this phase (what to achieve)' },
            focus: { type: 'array', items: { type: 'string' }, description: 'Components/subjects to focus on in this phase, e.g. ["Math","English"]' },
          },
        } },
        constraints: { type: 'array', description: 'Custom constraint title list, e.g. ["No staying up late","Rest on Sundays"] (optional)', items: { type: 'string' } },
        notes: { type: 'string', description: 'Other notes (optional)' },
        examType: { type: 'string', description: '[Legacy compat] Exam type, equivalent to a title prefix; when examType is passed without title, it is auto-used as the title' },
        examDate: { type: 'string', description: '[Legacy compat] Equivalent to deadline' },
        subjects: { type: 'array', items: { type: 'string' }, description: '[Legacy compat] Equivalent to components' },
        domain: { type: 'string', description: 'AI-determined free-form life-domain label for this plan (create new or reuse existing; not limited to a fixed list). Default "academic".' },
        topic: { type: 'string', description: 'Topic label for second-brain classification, AI-determined (e.g. "English Speaking", "PMP Exam", "Thesis Writing"). The engine creates/links the topic automatically — no keyword matching. All phase goals and the strategic goal will be linked to this topic.' },
        category: { type: 'string', description: 'AI-determined free-form high-level category for Topic Library grouping - invent a new one or reuse an existing label; no fixed list.' },
      },
    },
  },

  // ── Errand System ──
  {
    name: 'lingxi_add_errand',
    description: 'Add an operational action that does not need to become a knowledge record. Date and time are optional: use this for an unplanned action as well as a scheduled one. AI chooses the priority and retention with reasons; a one-off action defaults to transient and disappears when completed.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Errand title, e.g. "Accompany spouse to wisdom tooth extraction"' },
        date: { type: 'string', description: 'YYYY-MM-DD date, optional. Omit when the action has no scheduled day yet.' },
        time: { type: 'string', description: 'HH:MM start time, optional. Omit when the action belongs in the unscheduled queue.' },
        duration: { type: 'number', description: 'Duration in minutes, default 60' },
        category: { type: 'string', description: 'Domain: health/relationship/career/academic/social/misc' },
        priority: { type: 'string', enum: ['must', 'should', 'nice'], description: 'must=must do (priority over all goals), should=should do, nice=do if free. Default should' },
        retention: { type: 'string', enum: ['transient', 'review', 'memory'], description: 'AI lifecycle judgment. transient (default): operational only and erase on completion; review: keep as a completed action for later review; memory: reserve for a durable outcome that AI will summarize separately as a note.' },
        note: { type: 'string', description: 'Associated note info' },
        timeCost: { type: 'number', description: 'AI-judged: estimated TOTAL hours this errand will consume, including transit, prep, waiting, and recovery. E.g. "hospital visit" = 4h (transit+wait+procedure+rest), "quick phone call" = 0.5h, "business trip" = 8h. Used for conflict detection math — do NOT leave blank for non-trivial items.' },
        requiresPresence: { type: 'boolean', description: 'AI-judged: does this errand require the user to be physically present at a location? true for travel/doctor/meeting/in-person errands; false for online tasks/phone calls/remote work. Used to assess focus-blocking impact.' },
        blocksFocus: { type: 'boolean', description: 'AI-judged: will this errand prevent the user from focusing on other work for the rest of the day? true for all-day travel, major medical procedures, high-stress events; false for quick tasks. When true and the date has a goal deadline, a critical conflict is triggered.' },
      },
    },
  },
  {
    name: 'lingxi_get_errands',
    description: 'Get a list of errands within a specified date range. Without parameters, returns all incomplete errands.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD start date, defaults to today' },
        endDate: { type: 'string', description: 'YYYY-MM-DD end date, defaults to 7 days later' },
        includeCompleted: { type: 'boolean', description: 'Whether to include completed errands, default false' },
      },
    },
  },
  {
    name: 'lingxi_complete_errand',
    description: 'Mark an errand as completed.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Errand ID (e_xxx)' },
      },
    },
  },
  {
    name: 'lingxi_delete_errand',
    description: 'Delete an errand.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Errand ID (e_xxx)' },
      },
    },
  },

  // ── Life Notes System ──
  {
    name: 'lingxi_add_note',
    description: 'Add one or more AI-organized notes. For a single note, pass title, content, topic, category. For batch import (e.g. user pastes multiple notes or a document), pass "notes" array — each item needs title, content, topic, category. When processing a batch: (1) read ALL notes before classifying, so you can detect contradictions and group related notes; (2) decide whether each note joins an existing topic or warrants a new one; (3) if you detect contradictions between notes (e.g. the user changed their mind), flag them in the "conflicts" field so the user sees them; (4) set "signal" when a note indicates health or emotional state changes. The AI writes the title and decides topic/category — the engine never derives these from keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'AI-written summary title (single note mode). Concise and meaningfully different from the full body.' },
        content: { type: 'string', description: 'Note body text (single note mode).' },
        topic: { type: 'string', description: 'AI-determined topic label, e.g. "Decision Quality". The engine stores the AI decision as-is.' },
        domain: { type: 'string', description: 'OPTIONAL free-form soft tag (AI own label - not limited to a fixed list). It is a display hint inherited by the topic. Prefer classifying by topic/category instead.' },
        relatedDate: { type: 'string', description: 'Associated date YYYY-MM-DD (if a reminder to handle on a certain day is needed)' },
        source: { type: 'string', description: 'Information source: extracted from conversation / user-initiated / batch-import / other. Default "extracted from conversation"' },
        category: { type: 'string', description: 'AI-determined free-form high-level category. Invent a new one or reuse an existing label; topics sharing a category are grouped in the Topic Library. No fixed list.' },
        signal: { type: 'string', enum: ['health_negative', 'emotional_stress', 'positive', 'neutral'], description: 'AI-judged emotional/health signal. health_negative (schedule -40%), emotional_stress (-20%), positive (+15%), neutral (normal).' },
        notes: { type: 'array', description: 'Batch mode: array of note objects. Each item: { title, content, topic, category, domain?, signal?, conflicts? }. Use this when the user provides multiple notes at once (pasted text, document content, etc.). Process all notes holistically — detect cross-note contradictions and decide topic grouping before calling.', items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, topic: { type: 'string' }, category: { type: 'string' }, domain: { type: 'string' }, signal: { type: 'string' }, conflicts: { type: 'array', items: { type: 'string' } } }, required: ['title', 'content', 'topic', 'category'] } },
        conflicts: { type: 'array', description: 'Cross-note contradictions detected during batch processing, e.g. ["Note 3 contradicts note 1 on dietary preference"]. Shown to user for awareness.', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'lingxi_enrich_note',
    description: 'Propose an organization for one pending dashboard or imported note. First load its body with lingxi_get_note_detail(id), then provide an AI-written title, topic and category. The proposal is placed in settings-conflicts.json and is NOT applied to the knowledge index until the user confirms it in the dashboard.',
    inputSchema: {
      type: 'object',
      required: ['id', 'title', 'topic', 'category'],
      properties: {
        id: { type: 'string', description: 'Pending note ID from the overview note index' },
        title: { type: 'string', description: 'AI-written concise summary title' },
        topic: { type: 'string', description: 'AI-determined topic label' },
        category: { type: 'string', description: 'AI-determined high-level category' },
        domain: { type: 'string', description: 'Optional free-form soft domain tag (AI own label, not limited to a fixed list)' },
        signal: { type: 'string', enum: ['health_negative', 'emotional_stress', 'positive', 'neutral'], description: 'Optional AI-judged signal' },
        reason: { type: 'string', description: 'Brief explanation of why this organization fits the note.' },
        conflicts: { type: 'array', items: { type: 'string' }, description: 'Potential conflicts or ambiguities the user should consider before confirming.' },
      },
    },
  },
  {
    name: 'lingxi_raise_setting_conflict',
    description: 'Place a consequential ambiguity or contradiction in the settings review queue. Use this when a decision cannot be safely inferred from imported notes or the user profile. Do not resolve it automatically.',
    inputSchema: {
      type: 'object',
      required: ['title', 'question'],
      properties: {
        title: { type: 'string', description: 'Short label for the setting conflict.' },
        question: { type: 'string', description: 'Plain-language question the user needs to answer.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional concise alternatives.' },
      },
    },
  },
  {
    name: 'lingxi_raise_note_conflict',
    description: 'Report contradictions or inconsistencies between notes and place them in the user review queue. Use this when you detect factual contradictions, timeline conflicts, value contradictions, or goal conflicts across multiple notes. Always include the specific note IDs involved so the user can inspect the source.',
    inputSchema: {
      type: 'object',
      required: ['title', 'description'],
      properties: {
        title: { type: 'string', description: 'Short label describing the contradiction (e.g., "Travel plan conflict").' },
        description: { type: 'string', description: 'Plain-language explanation of what contradicts what, quoting relevant excerpts.' },
        noteIds: { type: 'array', items: { type: 'string' }, description: 'IDs of the conflicting notes.' },
        reasoning: { type: 'string', description: 'Optional: why this matters or what the user should consider.' },
      },
    },
  },
  {
    name: 'lingxi_get_notes',
    description: 'Read notes on demand. Without a filter, returns title-only index entries. With topicId or domain, returns the selected full notes. Prefer lingxi_get_note_detail for one note.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'Get notes for a specific topic only. Omit to return all' },
        domain: { type: 'string', description: 'Optional free-form soft-tag filter. Omit to return all notes.' },
        limit: { type: 'number', description: 'Most recent N, default all' },
      },
    },
  },
  {
    name: 'lingxi_delete_note',
    description: 'Delete a life note.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Note ID (note_xxx)' },
      },
    },
  },

  // ── Event Stream System (v3.0 core) ──
  {
    name: 'lingxi_create_event',
    description: '[RETIRED] Retired compatibility endpoint. Do not call it: save directly to a note, goal, action, reminder, or meaningful conversation history.',
    inputSchema: {
      type: 'object',
      required: ['userMessage', 'domains', 'facts'],
      properties: {
        userMessage: { type: 'string', description: 'The user original words' },
        aiResponse: { type: 'string', description: 'AI response summary (optional)' },
        context: { type: 'string', description: 'The AI understanding of user intent (optional)' },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domains the AI identified in this message. E.g. ["academic"] for "I want to learn English", ["health","relationship"] for "My wife has a pollen allergy".',
        },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              domain: { type: 'string', description: 'AI-determined free-form domain label (create new or reuse existing; not limited to a fixed list).' },
              content: { type: 'string', description: 'The key fact extracted, e.g. "User wants to improve English speaking for work presentations" or "Wife is allergic to pollen"' },
              title: { type: 'string', description: 'For note facts: required AI-written summary title used by the lightweight index. Do not copy or truncate the body.' },
              when: { type: 'string', description: 'Time info if mentioned, e.g. "tomorrow", "next month", "2026-08-01". null if not mentioned.' },
              type: { type: 'string', enum: ['goal', 'errand', 'note', 'constraint', 'smalltalk'], description: 'The AI classification of this fact. For type=note, also provide title, topic and category; the engine performs no automatic summarization or classification.' },
              topic: { type: 'string', description: 'Topic label for second-brain classification, AI-determined (e.g. "English Speaking", "Wife Birthday", "Dentist Appointment"). Engine creates/links topic automatically — no keyword matching.' },
              category: { type: 'string', description: 'AI-determined free-form high-level category for Topic Library grouping - invent a new one or reuse an existing label; no fixed list.' },
              priority: { type: 'string', enum: ['must', 'should', 'nice'], description: 'For errand facts only: AI-judged action priority. Omit for goals and notes.' },
              retention: { type: 'string', enum: ['transient', 'review', 'memory'], description: 'AI lifecycle judgment: transient for one-off operations, review for short-term outcome review, memory only for durable information that warrants a separately summarized note.' },
              planTitle: { type: 'string', description: 'For multi-stage goals: the overarching plan title shared by ALL goals in this plan. REQUIRED when a single message produces multiple goals that are phases of the same plan. E.g. user says "wife birthday Aug 1, need to prepare gift and arrange celebration" → set planTitle:"老婆生日" for BOTH the "prepare gift" goal AND the "arrange celebration" goal. The engine sets baseTitle automatically so only the earliest-deadline phase appears in the current-goals list.' },
              timeCost: { type: 'number', description: 'AI-judged (for errand-type facts only): estimated TOTAL hours this errand will consume, including transit, prep, waiting, recovery. E.g. hospital=4h, phone call=0.5h, business trip=8h.' },
              requiresPresence: { type: 'boolean', description: 'AI-judged (for errand-type facts): does it require physical presence? true for travel/doctor/meeting; false for online/phone.' },
              blocksFocus: { type: 'boolean', description: 'AI-judged (for errand-type facts): will it prevent focusing on other work for the rest of the day? true for all-day travel, major medical, high-stress events.' },
            },
            required: ['domain', 'content', 'type'],
          },
          description: 'Structured facts the AI extracted from the message. Empty array [] for pure smalltalk.',
        },
        valueSignals: {
          type: 'array',
          description: 'Value preference signals inferred from the message. The AI should proactively detect when the user\'s words reveal what they care about — even in casual conversation. Examples: "I\'d rather have free time than overtime pay" → [{domain:"freedom", weight:80, note:"prefers free time over money"}]; "钱不是最重要的" → [{domain:"money", weight:30}]; "家人最重要" → [{domain:"family", weight:90}]. Empty array [] if no value signal detected.',
          items: {
            type: 'object',
            properties: {
              domain: { type: 'string', description: 'AI-determined free-form value domain (invent a new label or reuse an existing one; not limited to a fixed list).' },
              weight: { type: 'number', description: '0-100 inferred weight. Higher = more important to user.' },
              note: { type: 'string', description: 'What signal was detected, e.g. "User said family is the most important thing"' },
            },
            required: ['domain', 'weight'],
          },
        },
        followUpNeeded: { type: 'boolean', description: 'Set true only when missing information materially blocks a decision or commitment. Missing time alone does not always require a question.' },
        followUpItems: { type: 'array', items: { type: 'string' }, description: 'Questions to ask the user, if followUpNeeded is true' },
      },
    },
  },
  {
    name: 'lingxi_resolve_event',
    description: '[RETIRED] Resolve an event — called after the user answers a follow-up. The AI provides the additional facts extracted from the user answers. The engine merges them into the event, marks it as resolved, and derives it into the file tree (schedule/notes/goals, etc.).',
    inputSchema: {
      type: 'object',
      required: ['eventId', 'userAnswers', 'facts'],
      properties: {
        eventId: { type: 'string', description: 'The event ID to resolve' },
        userAnswers: { type: 'string', description: 'The user original words answering the follow-up' },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              domain: { type: 'string', description: 'AI-determined free-form domain label (create new or reuse existing; not limited to a fixed list).' },
              content: { type: 'string', description: 'The fact extracted from the user answer' },
              when: { type: 'string', description: 'Time info, if any' },
              type: { type: 'string', enum: ['goal', 'errand', 'note', 'constraint', 'smalltalk'] },
              topic: { type: 'string', description: 'Topic label for second-brain classification, AI-determined' },
              title: { type: 'string', description: 'AI-written summary title for a durable note; never copy or truncate the body.' },
              category: { type: 'string', description: 'AI-authored category for a durable note.' },
              priority: { type: 'string', enum: ['must', 'should', 'nice'], description: 'For errand facts only: AI-judged action priority.' },
              retention: { type: 'string', enum: ['transient', 'review', 'memory'], description: 'Lifecycle judgment for this fact.' },
              timeCost: { type: 'number', description: 'AI-judged (for errand facts): estimated total hours' },
              requiresPresence: { type: 'boolean', description: 'AI-judged (for errand facts): requires physical presence?' },
              blocksFocus: { type: 'boolean', description: 'AI-judged (for errand facts): blocks focus for the day?' },
            },
            required: ['domain', 'content', 'type'],
          },
          description: 'Additional facts the AI extracted from the user answers',
        },
      },
    },
  },
  {
    name: 'lingxi_get_pending_follows',
    description: '[RETIRED] Get the list of pending follow-up events. Call at the start of every new conversation; if there are pending follow-up events, proactively raise them with the user.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number to return, default 10' },
      },
    },
  },
  {
    name: 'lingxi_get_summary',
    description: '[RETIRED] Retired compatibility endpoint. Review selected current entity documents instead.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback days, default 14' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Filter specific domains (optional)' },
      },
    },
  },
  {
    name: 'lingxi_check_reminders',
    description: 'Check scheduled time-point reminders (for example, "Fri 5pm submit report").',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingxi_add_reminder',
    description: 'Add a scheduled time-point reminder. Unlike goal deadlines (which are checked during morning briefing), this is a precise time trigger — e.g. "remind me to submit the report at 5pm this Friday". The AI should create a reminder when the user mentions a specific time-bound obligation. Reminders are checked on every conversation (via lingxi_check_reminders) and surface in the morning briefing.',
    inputSchema: {
      type: 'object',
      required: ['title', 'triggerAt'],
      properties: {
        title: { type: 'string', description: 'Reminder title, e.g. "Submit Q3 report to boss"' },
        triggerAt: { type: 'string', description: 'ISO 8601 datetime string when the reminder should fire, e.g. "2026-07-25T17:00:00+08:00". The AI should convert user-relative time ("Friday 5pm") to absolute ISO datetime using the current date.' },
        category: { type: 'string', description: 'AI-determined free-form category label (create new or reuse existing; not limited to a fixed list). Default misc.' },
        priority: { type: 'string', enum: ['must', 'should', 'nice'], description: 'must=must do at this time, should=should do, nice=gentle nudge. Default should.' },
        note: { type: 'string', description: 'Additional context, e.g. "Send via email to boss@company.com"' },
        relatedGoalId: { type: 'string', description: 'Optional: link to a goal ID if this reminder is for a goal milestone' },
        relatedErrandId: { type: 'string', description: 'Optional: link to an errand ID if this reminder is for an errand' },
        repeat: { type: 'string', description: 'Optional repeat rule: "daily", "weekly", "monthly", or null. Default null (one-time).' },
      },
    },
  },
  {
    name: 'lingxi_get_reminders',
    description: 'Get all pending reminders, optionally filtered by date range.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive). Default today.' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Default 7 days from today.' },
        includeFired: { type: 'boolean', description: 'Include already-fired reminders. Default false.' },
      },
    },
  },
  {
    name: 'lingxi_delete_reminder',
    description: 'Delete a scheduled reminder by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Reminder ID (rm_xxx)' },
      },
    },
  },

  // ── Value System ──
  {
    name: 'lingxi_update_value_system',
    description: 'Update the user value system. The value system records the user\'s weight preferences across life domains, used for decisions when multiple goals conflict. The AI should auto-update when: (1) the user makes an explicit choice/trade-off, OR (2) the user\'s casual words reveal a value preference (e.g. "I\'d rather have free time than overtime pay" → freedom weight up, money weight down). The AI should proactively infer values from everyday conversation — not wait for explicit statements.',
    inputSchema: {
      type: 'object',
      properties: {
        priorities: {
          type: 'array',
          description: 'Free-form value domain weight list. The AI creates or reuses any domain label - no fixed set.',
          items: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'AI-determined free-form value domain label (invent a new one or reuse an existing label - NOT limited to a fixed list). E.g. neural_networks, pets, parenting, freedom. Reuse an existing label when one fits so weights stay comparable.',
              },
              weight: { type: 'number', description: '0-100 weight value. Higher = more important to the user.' },
              note: { type: 'string', description: 'Weight explanation, e.g. "User said family is the most important thing"' },
              confidence: { type: 'number', description: '0-1 confidence score. Repeated signals increase confidence. Default 0.5 for single observation.' },
            },
          },
        },
        decisionStyle: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'], description: 'Decision style: conservative (prioritize must-do items), balanced, aggressive (prioritize development goals)' },
        learnedFrom: { type: 'string', description: 'Source explanation for this update, e.g. "July 12: user said \'I\'d rather have free time than overtime pay\' → freedom=80, money=40 (confident: explicit trade-off)"' },
        inferredFrom: { type: 'string', description: 'If this update was inferred from casual conversation (not explicit statement), describe the signal. e.g. "User mentioned \'钱不是最重要的\' when discussing job offer"' },
      },
    },
  },

  // ── Document Index ──
  {
    name: 'lingxi_get_overview',
    description: 'LAYER-0 manifest — read this once at the start of a relevant conversation. Returns title-only indexes for goals, constraints, actions and every note, plus topic counts. Note bodies are excluded; retrieve one only when relevant.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lingxi_get_documents_index',
    description: 'File-level index — shows what document FILES exist (goals / schedule / errands / notes / userProfile) with type, size, last-updated. This is a coarse file map. For a per-item brief of what actually exists, prefer lingxi_get_overview (LAYER-0 manifest). Use this only when you specifically need the file-level view.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── Hierarchical detail loading (on-demand, saves tokens) ──
  {
    name: 'lingxi_get_goal_detail',
    description: 'Load the FULL detail of a single goal on demand. The default state only contains a lightweight goal index (id, title, deadline, priority). Use this when you need the full goal content: description, detail, aiReasoning, aiFactors, components, relatedStrategicGoalId, etc. This reads only ONE goal file (goals/g_xxx.json) — minimal token cost.',
    inputSchema: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: 'Goal ID (g_xxx) from the goal index' },
      },
      required: ['goalId'],
    },
  },
  {
    name: 'lingxi_get_note_detail',
    description: 'Load the FULL content of a single note on demand. The default state contains only AI-authored note titles and classifications. Reads only one note detail file.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'Note ID (n_xxx) from the note index' },
      },
      required: ['noteId'],
    },
  },
  {
    name: 'lingxi_get_day_schedule',
    description: 'Load a specific day\'s schedule on demand (tasks, errands, day-notes). The default state only contains a schedule index (which days have records). Use this when: (1) the user mentions a specific date, (2) conflict detection needs that day\'s tasks, (3) the user asks "what\'s on Aug 1?". Auto-creates an empty day file if the date has no records yet. Reads only ONE day file (schedule/YYYY-MM-DD.json) — minimal token cost.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format, e.g. "2026-08-01"' },
      },
      required: ['date'],
    },
  },
  {
    name: 'lingxi_get_days_in_range',
    description: 'Load multiple days\' schedules for a date range (e.g. weekly view). Only reads days that have records — does not create empty files for days with no schedule. Use for "what\'s this week look like?" or planning a multi-day trip.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date YYYY-MM-DD' },
        endDate: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'lingxi_get_document_by_type',
    description: 'Layer-2 retrieval — read specific document content by document type. Must call get_documents_index first to see what documents exist, then call this tool as needed. type must be one of goals / schedule / errands / notes / userProfile.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Document type: goals / schedule / errands / notes / userProfile' },
      },
      required: ['type'],
    },
  },

  // ── Second Brain · Association Index (topic foreign key + user-confirmed precipitation) ──
  {
    name: 'lingxi_get_topics',
    description: 'Read all topics and their association statistics. Topics are AI-authored aggregation units for notes, goals and action items (schedule tasks + errands). Each topic reports its linked entity counts and whether it has been precipitated into a standalone detail file.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingxi_get_library',
    description: 'Read the AI-authored category and topic library. Use it to understand existing organization before deciding whether a new note belongs to an existing topic or needs a new one.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lingxi_update_library',
    description: 'Update categories or topics using AI judgment. Keywords, if supplied, are AI-authored retrieval aliases and are never used by the engine to classify notes automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'object',
          description: 'Categories to add/update. Key = category name, value = { icon, topics }.',
          additionalProperties: {
            type: 'object',
            properties: {
              icon: { type: 'string', description: 'Emoji icon for the category' },
              topics: { type: 'array', items: { type: 'string' }, description: 'Topic labels in this category' },
            },
          },
        },
        topics: {
          type: 'object',
          description: 'Topics to add/update. Key = topic label, value = { keywords, category }.',
          additionalProperties: {
            type: 'object',
            properties: {
              keywords: { type: 'array', items: { type: 'string' }, description: 'Optional AI-authored retrieval aliases' },
              category: { type: 'string', description: 'Which category this topic belongs to' },
            },
          },
        },
      },
    },
  },
  {
    name: 'lingxi_get_topic_document',
    description: 'On-demand read of a topic sedimented document (only that topic notes), for precise retrieval and token savings. topicId comes from lingxi_get_topics.',
    inputSchema: {
      type: 'object',
      properties: { topicId: { type: 'string', description: 'Topic id' } },
      required: ['topicId'],
    },
  },
  {
    name: 'lingxi_search_associated',
    description: 'Associated search: input a topic keyword and return its goals, action items and notes.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Topic keyword or tag' } },
      required: ['query'],
    },
  },
  {
    name: 'lingxi_search',
    description: 'Global search across notes and goals; hits include topic affiliation. Used for fuzzy lookup when it is uncertain which topic something belongs to.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search keyword' } },
      required: ['query'],
    },
  },
  {
    name: 'lingxi_recall',
    description: '[Second brain · AI-selected recall] Return title-only items for topic IDs that the AI selected from the Layer-0 overview. The engine performs no keyword, lexical, or semantic relevance scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Topic IDs chosen by the AI after reading the overview.' },
        limit: { type: 'number', description: 'Maximum title-only items to return; default 8.' },
      },
      required: ['topicIds'],
    },
  },
  {
    name: 'lingxi_get_context',
    description: '[Two-layer index · Layer-1] Get note titles and goal titles linked to selected topics. Full note bodies are excluded; call lingxi_get_note_detail only for a relevant title.',
    inputSchema: {
      type: 'object',
      required: ['topicIds'],
      properties: {
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Topic IDs (t_xxx) the AI judged relevant to the current conversation. Get available topics from lingxi_get_topics or lingxi_get_library.' },
        limit: { type: 'number', description: 'Max number of context items to return. Default 5.' },
      },
    },
  },
  {
    name: 'lingxi_delete_topic',
    description: 'Delete a topic and its associated goals, schedule tasks, errands and notes after an explicit cascade preview and confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'The topic id to delete (from lingxi_get_topics)' },
        confirm: { type: 'boolean', description: 'Must explicitly pass true to execute the delete, preventing accidental deletion' },
      },
      required: ['topicId', 'confirm'],
    },
  },
  {
    name: 'lingxi_delete_history',
    description: 'Delete conversation history records. Can delete a single record by id, or clear all history when no id is provided. Used when the user wants to clear conversation logs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The history record id to delete. If omitted, clears ALL history records.' },
        confirm: { type: 'boolean', description: 'Must explicitly pass true to execute the delete, preventing accidental deletion' },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'lingxi_clear_briefings',
    description: 'Clear all stored morning briefings. Briefings are regenerated on each auto_schedule call, so clearing them is safe.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must explicitly pass true to execute, preventing accidental deletion' },
      },
      required: ['confirm'],
    },
  },

  // ── Data Export / Import ──
  {
    name: 'lingxi_export_data',
    description: 'Export all ZhiGui data (goals, notes, schedule, errands, history, topic index, library) into a single portable JSON file for backup or migration. The export includes metadata with version, timestamp, and checksum.',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: 'Optional file path for the export. If omitted, auto-generates a filename in the data directory.' },
      },
    },
  },
  {
    name: 'lingxi_import_data',
    description: 'Import data from a previously exported ZhiGui JSON file. Supports "replace" mode (overwrite all data) and "merge" mode (combine with existing data, imported items win for duplicates). Validates the import structure and version compatibility before writing.',
    inputSchema: {
      type: 'object',
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Path to the exported JSON file to import' },
        mode: { type: 'string', enum: ['replace', 'merge'], description: 'Import mode: "replace" overwrites all data (default), "merge" combines with existing data' },
      },
    },
  },
];

// Event records duplicated canonical entities and survived entity deletion. Keep
// their old handlers below only so older clients fail gracefully, but never
// publish them to an assistant.
const ACTIVE_TOOLS = TOOLS.filter(tool => !new Set([
  'lingxi_create_event',
  'lingxi_resolve_event',
  'lingxi_get_pending_follows',
  'lingxi_get_summary',
]).has(tool.name));

// ─── Tool implementation ──────────────────────────────────────────

async function handleToolCall(name, args) {
  // Layer-0/1 tools must remain genuinely lightweight: the assistant learns what exists
  // from titles and classifications, then chooses one detail document to open. Mutation
  // and detail tools still receive complete entities and are the only tools allowed to
  // write state back.
  const indexOnlyTools = new Set([
    'lingxi_get_overview',
    'lingxi_get_documents_index',
    'lingxi_get_topics',
    'lingxi_get_library',
    'lingxi_recall',
    'lingxi_get_context',
  ]);
  const state = indexOnlyTools.has(name) ? Storage.readState() : readFullState();
  if (!state && !name.startsWith('lingxi_get_config')) {
    return { error: 'Data read failed. Please ensure ZhiGui is initialized (run start.bat).' };
  }

  // Domain alias lookup is now in engine/scheduler.js (Scheduler.DOMAIN_ALIAS)
  // Helper functions (isOneShotGoal, mapGoalToDomain, getDomainWeight, analyzeNotesContext,
  // getProfileAwareSlots) are also in scheduler.js — imported as Scheduler.*

  switch (name) {

  // ── Layer-0 retrieval: single consolidated brief manifest (one document, what exists) ──
  case 'lingxi_get_overview': {
    try {
      // This is the daily/self-check entry point. It keeps DDL-derived fields and
      // actionable conflicts fresh whenever the assistant starts from its manifest.
      // Use full records for a write. Persisting the title-only Layer-0 projection
      // would erase detail fields and note bodies.
      const checkedState = readFullState();
      const dailyCheck = runDailyCheck(checkedState);
      writeState(checkedState);
      const overview = buildOverview(checkedState, getBrainIndex());
      return {
        ...overview,
        dailyCheck,
        hint: overview.hint,
      };
    } catch (e) {
      return { error: 'Failed to build overview: ' + e.message };
    }
  }

  // ── Layer-1 retrieval: document index ──
  case 'lingxi_get_documents_index': {
      try {
        // Dynamically generate the index (always fresh), and merge the topic layer, eliminating the "old static index + new topic layer" dual-index confusion
        const docs = [];
        for (const [docType, filePath] of Object.entries(DOCUMENT_FILES)) {
          try {
            const stat = fs.statSync(filePath);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const meta = data.meta || {};
            docs.push({
              type: docType,
              title: DOCUMENT_TITLES[docType] || docType,
              lastUpdated: meta.lastUpdated || new Date(stat.mtime).toISOString(),
              size: stat.size,
            });
          } catch { /* skip missing files */ }
        }
        let topics = [];
        try {
          topics = getBrainIndex().getTopics().map(t => ({
            label: t.label, noteCount: t.noteCount, precipitated: t.precipitated, related: t.relatedCounts,
          }));
        } catch {}

        return {
          documents: docs,
          topics: topics,
          hint: 'Layer-1 index (dynamically generated, always fresh). Use get_document_by_type to read specific documents as needed; for topic context, rely on the activeTopicIndex already injected in get_instructions — it shows what topics exist (layer 1). When you need full details, call lingxi_get_goal_detail / lingxi_get_topic_document / lingxi_get_note_detail (layer 2).',
          usageGuide: {
              'Understand user goals': 'Read goals first, then userProfile as needed',
              'Generate schedule': 'Read goals + errands + notes + schedule',
              'Update user profile': 'Read userProfile; other documents can be skipped',
              'View decisions': 'Only read decisions',
              'View errands': 'Only read errands',
              'View notes': 'Only read notes',
              'Topic recall': 'Use activeTopicIndex (already in get_instructions) for layer 1; call lingxi_get_goal_detail / lingxi_get_topic_document for layer 2 full details',
            },
        };
      } catch (e) {
        return { error: 'Index generation failed: ' + e.message };
      }
    }

    // ── Hierarchical detail loading (on-demand, saves tokens) ──
    case 'lingxi_get_goal_detail': {
      if (!args.goalId) return { error: 'Missing goalId' };
      try {
        const detail = Storage.getGoalDetail(args.goalId);
        if (!detail) return { error: 'Goal not found: ' + args.goalId };
        return { goal: detail, hint: 'Full goal detail loaded. Use this for decision-making, progress tracking, or explaining to the user.' };
      } catch (e) { return { error: 'Failed to load goal detail: ' + e.message }; }
    }

    case 'lingxi_get_note_detail': {
      if (!args.noteId) return { error: 'Missing noteId' };
      try {
        const detail = Storage.getNoteDetail(args.noteId);
        if (!detail) return { error: 'Note not found: ' + args.noteId };
        return { note: detail };
      } catch (e) { return { error: 'Failed to load note detail: ' + e.message }; }
    }

    case 'lingxi_get_day_schedule': {
      if (!args.date) return { error: 'Missing date' };
      try {
        const daySchedule = Storage.getDaySchedule(args.date);
        return {
          date: args.date,
          tasks: (daySchedule && daySchedule.tasks) || [],
          errands: (daySchedule && daySchedule.errands) || [],
          dayNotes: (daySchedule && daySchedule.dayNotes) || [],
          taskCount: (daySchedule && daySchedule.tasks || []).length,
          errandCount: (daySchedule && daySchedule.errands || []).length,
          hint: daySchedule ? 'Day schedule loaded.' : 'No schedule for this date — empty day file auto-created.',
        };
      } catch (e) { return { error: 'Failed to load day schedule: ' + e.message }; }
    }

    case 'lingxi_get_days_in_range': {
      if (!args.startDate || !args.endDate) return { error: 'Missing startDate or endDate' };
      try {
        const days = Storage.getDaysInRange(args.startDate, args.endDate);
        const dayCount = Object.keys(days).length;
        return {
          days,
          dayCount,
          range: `${args.startDate} to ${args.endDate}`,
          hint: dayCount > 0 ? `${dayCount} day(s) with records found.` : 'No scheduled days in this range.',
        };
      } catch (e) { return { error: 'Failed to load days in range: ' + e.message }; }
    }

    // ── Layer-2 retrieval: read document by type ──
    case 'lingxi_get_document_by_type': {
      const docType = args.type;
      if (!DOCUMENT_FILES[docType]) {
        return { error: `Unknown document type: ${docType}. Available: ${Object.keys(DOCUMENT_FILES).join('/')}` };
      }
      try {
        const data = readDocument(docType);
        if (!data) {
          return { error: `Document ${docType} does not exist or is empty` };
        }
        // Return only data fields, strip meta to reduce context overhead
        const { meta, ...payload } = data;
        return {
          ...payload,
          _meta: meta,
        };
      } catch (err) {
        return { error: `Failed to read document ${docType}: ${err.message}` };
      }
    }

    // ── Data reading ──
    case 'lingxi_get_state': {
      if (args.sections && args.sections.length > 0) {
        const result = {};
        for (const s of args.sections) {
          if (state[s] !== undefined) result[s] = state[s];
        }
        return result;
      }
      return state;
    }

    case 'lingxi_get_today': {
      const today = todayStr();
      const todaySchedule = state.schedule?.days?.[today] || null;
      const briefing = (state.briefings && state.briefings[today])
        ? state.briefings[today]
        : (state.morningBriefing?.date === today ? state.morningBriefing : null);
      // Panel language: lets the daily inspection decide which language to report in (en=English, others=Chinese)
      const panelLang = state.meta?.lang === 'en' ? 'en' : 'zh';
      const urgentGoals = (state.currentGoals || []).filter(g =>
        !g.completed && (g.overdue || (g.daysLeft !== null && g.daysLeft <= 2))
      );
      const activeConflicts = (state.conflicts || []).filter(c =>
        c.severity === 'critical' || c.severity === 'warning'
      );
      // Today's errands
      const todayErrands = (state.errands || []).filter(e =>
        e.date === today && !e.completed
      );
      // Notes that need attention soon (have relatedDate and within 7 days)
      const upcomingNotes = [];
      const allNotes = Array.isArray(state.notes) ? state.notes : [];
      for (const note of allNotes) {
        if (note.relatedDate) {
          const dl = daysBetween(note.relatedDate);
          if (dl !== null && dl >= 0 && dl <= 7) {
            upcomingNotes.push({ ...note, daysUntil: dl });
          }
        }
      }
      // Second brain · topic awareness: bring back active topics (with association counts) so the briefing / today view "actively remembers"
      let activeTopics = [];
      try {
        activeTopics = getBrainIndex().getTopics().map(t => ({
          id: t.id,
          label: t.label,
          noteCount: t.noteCount,
          precipitated: t.precipitated,
          related: t.relatedCounts,
        }));
      } catch {}
      // Topic id → label map (for brief note intros below)
      const topicIdLabel = {};
      for (const t of activeTopics) if (t.id) topicIdLabel[t.id] = t.label;

      // Two-layer note retrieval: return AI-authored titles + classification only.
      // Full content lives in notes.json / precipitated topic files and is fetched on demand via
      // lingxi_get_notes(topicId) or lingxi_get_topic_document(topicId).
      const notesBrief = allNotes
        .slice()
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map(n => ({
          id: n.id,
          topicId: n.topicId || null,
          topicLabel: n.topicId ? (topicIdLabel[n.topicId] || n.topicId) : '未分类',
          title: n.title || '待 AI 归纳',
          category: n.category || null,
          needsEnrichment: n.needsEnrichment === true,
          createdAt: n.createdAt || null,
          relatedDate: n.relatedDate || null,
          source: n.source || 'unknown',
        }));

      return {
        date: today,
        lang: panelLang,
        weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()],
        schedule: todaySchedule,
        briefing: briefing,
        urgentGoals: urgentGoals,
        activeConflicts: activeConflicts,
        todayErrands: todayErrands,
        upcomingNotes: upcomingNotes,
        notesBrief: notesBrief,
        allGoals: state.currentGoals || [],
        activeTopics: activeTopics,
      };
    }

    case 'lingxi_get_history': {
      const history = readHistory();
      const convs = history.conversations || [];
      if (args.limit && args.limit > 0) {
        return {
          conversations: convs.slice(-args.limit),
          total: convs.length,
        };
      }
      return history;
    }

    // ── Goal management ──

    // Auto-extract life notes from goals — REMOVED keyword matching.
    // The AI should provide notes explicitly via lingxi_add_note, or via facts in lingxi_create_event.
    // The engine no longer auto-extracts notes from goal titles/descriptions using keyword matching.
    function autoExtractNotesFromGoal(args, state) {
      return [];
    }

    // ── Conversation-level auto-sedimentation: REMOVED keyword matching ──
    // The AI should call lingxi_add_note explicitly when the user mentions something worth remembering.
    // The engine no longer auto-extracts notes from user messages using keyword matching.
    function autoExtractNotesFromConversation(userMessage, state) {
      return [];
    }

    case 'lingxi_add_goal': {
      const typeMap = {
        strategicGoal: 'strategicGoals',
        currentGoal: 'currentGoals',
        constraint: 'constraints',
      };
      const arrKey = typeMap[args.type];
      if (!arrKey) return { error: 'Invalid type' };
      state[arrKey] = state[arrKey] || [];

      // ── Information completeness check (unless force=true) ──
      if (!args.force) {
        const clarification = checkGoalInfoSufficiency(args);
        if (clarification) {
          return {
            needsClarification: true,
            type: args.type,
            title: args.title,
            missingInfo: clarification.missingInfo,
            questions: clarification.questions,
            message: clarification.message,
            hint: 'Ask the user the above questions, then call this tool again with the collected info (or set force=true to skip the check). Do not make assumptions.',
          };
        }
      }

      const id = genId(args.type === 'strategicGoal' ? 'sg' : args.type === 'currentGoal' ? 'cg' : 'ct');
      const now = new Date().toISOString();
      const item = {
        id,
        title: args.title,
        description: args.description || '',
        priority: args.priority !== undefined ? args.priority : 50,
        locked: args.locked || false,
        source: 'ai',
        createdAt: now,
        updatedAt: now,
      };
      // AI-judged fields (no keyword matching by the engine)
      if (args.domain) item.domain = args.domain;
      if (args.isOneShot !== undefined) item.isOneShot = args.isOneShot;
      if (args.relatedStrategicGoalId) item.relatedStrategicGoalId = args.relatedStrategicGoalId;
      if (args.rules && Array.isArray(args.rules)) item.rules = args.rules;

      if (args.type === 'currentGoal') {
        item.detail = args.detail || '';
        if (args.deadline) {
          item.deadline = args.deadline;
          const dl = daysBetween(args.deadline);
          item.daysLeft = dl;
          item.overdue = dl < 0;
          item.lastRecalculated = now;
        }
      }

      if (args.type === 'strategicGoal' && args.subTasks) {
        item.subTasks = args.subTasks;
      }

      state[arrKey].push(item);

      // ── Second brain: classify the goal into a topic (foreign-key association) ──
      // AI-DRIVEN: AI must pass `topic` explicitly. No keyword-matching fallback.
      let goalTopicId = null;
      try {
        const brain = getBrainIndex();
        if (args.topic && typeof args.topic === 'string') {
          goalTopicId = brain.ensureTopic(args.topic, { domain: args.domain || 'misc', category: args.category, keywords: [] });
        }
        // No fallback — if AI doesn't provide topic, the goal stays unlinked
        if (goalTopicId) {
          brain.linkEntity(goalTopicId, 'goals', item.id);
          item.topicId = goalTopicId;
        }
      } catch {}

      // ── Auto-extract life notes (second brain core) ──
      const autoNotes = autoExtractNotesFromGoal(args, state);
      if (autoNotes.length > 0 || goalTopicId) {
        writeState(state); // save extracted notes + topic foreign keys
        try {
          const brain = getBrainIndex();
          const topicIds = new Set(autoNotes.map(n => n.topicId).filter(Boolean));
          if (goalTopicId) topicIds.add(goalTopicId);
          topicIds.forEach(tid => brain.reindexTopic(tid));
        } catch (e) { require('./logger').error('brain-index', 'reindex failed for topic', { topicIds: [...topicIds], error: e.message }); }
      } else {
        writeState(state);
      }

      // ── Combined priority: after a new goal is added, do a relational recalc across the whole board ──
      // Lets the priority of the "new event" actually connect to other existing events (opportunity cost / overload linkage)
      let priorityShift = null;
      if (args.type === 'currentGoal') {
        try {
          const shifts = recalcPriorities(state);
          if (shifts.length > 0) {
            writeState(state);
            priorityShift = shifts;
          }
        } catch {}
      }

      // Return follow-up questions on success too, guiding the AI to continue the conversation
      const followUp = getFollowUpQuestions(args.type, args.title);
      const hintParts = ['Added successfully. Please refer to followUpQuestions to ask the user for more details so the schedule can be auto-generated later.'];
      const secondBrainHint = [];

      if (autoNotes.length > 0) {
        const domainNames = { health: 'Health', relationship: 'Relationship', career: 'Career', academic: 'Academic', social: 'Social', misc: 'Other' };
        for (const n of autoNotes) {
          secondBrainHint.push(`Auto-created a life note in the "${domainNames[n.domain] || n.domain}" domain`);
        }
        hintParts.push(`The second brain auto-extracted ${autoNotes.length} life notes: ${secondBrainHint.join(', ')}.`);
      }

      // If the goal involves a specific date, prompt the AI to create errands
      if (args.type === 'currentGoal' && args.deadline) {
        hintParts.push('This goal has a deadline. To arrange a concrete execution schedule, call lingxi_auto_schedule.');
      }

      return {
        success: true,
        id: id,
        message: `Added ${args.type === 'strategicGoal' ? 'strategic goal' : args.type === 'currentGoal' ? 'current goal' : 'constraint'}: ${args.title}`,
        followUpQuestions: followUp,
        autoExtractedNotes: autoNotes.length > 0 ? autoNotes : undefined,
        secondBrainHint: secondBrainHint.length > 0 ? secondBrainHint : undefined,
        priorityShift: priorityShift || undefined,
        hint: hintParts.join(' '),
      };
    }

    case 'lingxi_update_goal': {
      const typeMap = {
        strategicGoal: 'strategicGoals',
        currentGoal: 'currentGoals',
        constraint: 'constraints',
      };
      const arrKey = typeMap[args.type];
      if (!arrKey) return { error: 'Invalid type' };
      state[arrKey] = state[arrKey] || [];

      const idx = state[arrKey].findIndex(g => g.id === args.id);
      if (idx === -1) return { error: `Goal with ID ${args.id} not found` };

      const item = state[arrKey][idx];
      const now = new Date().toISOString();

      if (args.title !== undefined) item.title = args.title;
      if (args.description !== undefined) item.description = args.description;
      if (args.priority !== undefined) {
        item.priority = args.priority;
        item.locked = true;
        item.source = 'manual';
      }
      if (args.deadline !== undefined) {
        if (args.deadline) {
          item.deadline = args.deadline;
          const dl = daysBetween(args.deadline);
          item.daysLeft = dl;
          item.overdue = dl < 0;
          item.lastRecalculated = now;
        } else {
          delete item.deadline;
          item.daysLeft = null;
          item.overdue = false;
          item.lastRecalculated = now;
        }
      }
      if (args.detail !== undefined) item.detail = args.detail;
      if (args.locked !== undefined) item.locked = args.locked;
      if (args.completed !== undefined) item.completed = args.completed;
      if (args.subTasks !== undefined) item.subTasks = args.subTasks;
      item.updatedAt = now;

      writeState(state);
      return { success: true, message: `Updated: ${item.title}` };
    }

    case 'lingxi_delete_goal': {
      const typeMap = {
        strategicGoal: 'strategicGoals',
        currentGoal: 'currentGoals',
        constraint: 'constraints',
      };
      const arrKey = typeMap[args.type];
      if (!arrKey) return { error: 'Invalid type' };

      const goalToDelete = (state[arrKey] || []).find(g => g.id === args.id);
      if (!goalToDelete) return { error: `Goal with ID ${args.id} not found` };

      // Gather associated schedule tasks for the cascade preview
      const associatedTasks = [];
      if (state.schedule?.days) {
        for (const [dateStr, day] of Object.entries(state.schedule.days)) {
          if (!day.tasks) continue;
          for (const t of day.tasks) {
            if (t.relatedGoalId === args.id) associatedTasks.push({ id: t.id, title: t.title, date: dateStr, time: t.time });
          }
        }
      }

      // ── Preview (dry-run): report the cascade manifest, do NOT delete ──
      if (args.confirm !== true) {
        return {
          aborted: true,
          reason: 'Not confirmed. Review the cascade manifest below, then call this tool again with confirm: true to delete the goal AND its associated schedule tasks.',
          preview: {
            goal: { id: goalToDelete.id, title: goalToDelete.title, type: args.type },
            associatedTasks,
            counts: { goals: 1, tasks: associatedTasks.length },
          },
        };
      }

      // ── Confirmed: delete the goal and cascade-delete its schedule tasks ──
      state[arrKey] = (state[arrKey] || []).filter(g => g.id !== args.id);
      let deletedTaskCount = 0;
      let affectedDates = [];
      if (state.schedule?.days) {
        for (const [dateStr, day] of Object.entries(state.schedule.days)) {
          if (!day.tasks) continue;
          const beforeCount = day.tasks.length;
          day.tasks = day.tasks.filter(t => t.relatedGoalId !== args.id);
          const removed = beforeCount - day.tasks.length;
          if (removed > 0) {
            deletedTaskCount += removed;
            affectedDates.push(dateStr);
          }
        }
      }

      writeState(state);
      // Second brain: unbind this goal from the topic foreign key (cascade-cleanup references)
      try { getBrainIndex().unlinkEntityCascade('goals', args.id); } catch {}
      return {
        success: true,
        message: `Deleted ${args.type === 'strategicGoal' ? 'strategic goal' : args.type === 'currentGoal' ? 'current goal' : 'constraint'}: ${goalToDelete?.title || args.id}`,
        cascadingDelete: {
          deletedTasks: deletedTaskCount,
          affectedDates: affectedDates,
          message: deletedTaskCount > 0
            ? `Cascade-deleted ${deletedTaskCount} associated schedule tasks (across ${affectedDates.length} days)`
            : 'No associated schedule tasks to delete',
        },
      };
    }

    // ── Schedule tasks ──
    case 'lingxi_add_task': {
      state.schedule = state.schedule || {};
      state.schedule.days = state.schedule.days || {};
      const day = state.schedule.days[args.date];
      if (!day) {
        const d = new Date(args.date);
        state.schedule.days[args.date] = { date: args.date, weekday: Scheduler.WEEKDAYS[d.getDay()], tasks: [] };
      }
      const task = {
        id: genId('t'),
        time: args.time,
        duration: args.duration || 60,
        title: args.title,
        description: args.description || '',
        priority: args.priority || 50,
        completed: false,
        source: 'ai',
        category: args.category || 'event',
      };
      if (args.resource) task.resource = args.resource;
      state.schedule.days[args.date].tasks.push(task);
      writeState(state);
      return { success: true, id: task.id, message: `Added task on ${args.date}: ${args.title}` };
    }

    case 'lingxi_update_task': {
      const day = state.schedule?.days?.[args.date];
      if (!day) return { error: `No schedule found for ${args.date}` };
      const task = day.tasks.find(t => t.id === args.taskId);
      if (!task) return { error: `Task ${args.taskId} not found` };

      if (args.time !== undefined) task.time = args.time;
      if (args.duration !== undefined) task.duration = args.duration;
      if (args.title !== undefined) task.title = args.title;
      if (args.description !== undefined) task.description = args.description;
      if (args.priority !== undefined) task.priority = args.priority;
      if (args.completed !== undefined) task.completed = args.completed;
      if (args.category !== undefined) task.category = args.category;
      if (args.resource !== undefined) task.resource = args.resource;

      // When completing a task: cascade to goal + remove future instances
      if (args.completed === true && task.relatedGoalId) {
        const goal = (state.currentGoals || []).find(g => g.id === task.relatedGoalId);
        if (goal && Scheduler.isOneShotGoal(goal)) {
          goal.completed = true;
          goal.completedDate = todayStr();
        }
        // Remove all future tasks with the same relatedGoalId
        if (state.schedule && state.schedule.days) {
          for (const [dayDate, dayData] of Object.entries(state.schedule.days)) {
            if (dayDate > args.date && dayData.tasks) {
              dayData.tasks = dayData.tasks.filter(t => !(t.relatedGoalId === task.relatedGoalId && !t.completed));
            }
          }
        }
      }

      writeState(state);
      return { success: true, message: `Updated task: ${task.title}` };
    }

    case 'lingxi_delete_task': {
      const day = state.schedule?.days?.[args.date];
      if (!day) return { error: `No schedule found for ${args.date}` };
      const before = day.tasks.length;
      day.tasks = day.tasks.filter(t => t.id !== args.taskId);
      if (day.tasks.length === before) return { error: `Task ${args.taskId} not found` };
      writeState(state);
      return { success: true, message: 'Deleted task' };
    }

    // ── Logic computation ──
    case 'lingxi_recalc_priorities': {
      const changes = recalcPriorities(state);
      if (changes.length > 0) {
        // After recalc, re-sort incomplete tasks in the schedule by priority
        for (const dateKey of Object.keys(state.schedule?.days || {})) {
          const day = state.schedule.days[dateKey];
          day.tasks.sort((a, b) => {
            if (a.completed !== b.completed) return a.completed ? 1 : -1;
            return b.priority - a.priority;
          });
        }
      }
      writeState(state);
      return {
        recalculated: (state.currentGoals || []).filter(g => !g.completed).length,
        changed: changes,
        message: changes.length > 0
          ? `${changes.length} goal(s) had priority changes`
          : 'No goal priorities changed',
      };
    }

    case 'lingxi_score_goals': {
      // AI-driven priority scoring with contextual reasoning
      const scores = args.scores || [];
      if (scores.length === 0) {
        return { success: false, error: 'No scores provided' };
      }
      const changes = [];
      const now = new Date().toISOString();

      // Build a map of goalId → score for quick lookup
      const scoreMap = new Map();
      for (const s of scores) {
        scoreMap.set(s.goalId, s);
      }

      // Apply AI scores to goals
      for (const g of (state.currentGoals || [])) {
        if (g.completed || g.locked) continue;
        const aiScore = scoreMap.get(g.id);
        if (!aiScore) continue;

        const oldPriority = g.priority;
        const newPriority = clamp(aiScore.score);

        // Store AI reasoning and factors on the goal for transparency
        g.priority = newPriority;
        g.aiReasoning = aiScore.reasoning;
        g.aiScoredAt = now;
        if (aiScore.factors) {
          g.aiFactors = {
            urgency: aiScore.factors.urgency,
            importance: aiScore.factors.importance,
            feasibility: aiScore.factors.feasibility,
            momentum: aiScore.factors.momentum,
          };
        }
        g.lastRecalculated = now;
        g.updatedAt = now;

        // Mark as AI-scored (distinct from rule-based recalc)
        g.scoreSource = 'ai';

        if (Math.abs(newPriority - oldPriority) >= 1) {
          changes.push({
            id: g.id,
            title: g.title,
            oldPriority,
            newPriority,
            reasoning: aiScore.reasoning,
            scoreSource: 'ai',
          });
        }
      }

      // Re-sort schedule tasks by new priority
      for (const dateKey of Object.keys(state.schedule?.days || {})) {
        const day = state.schedule.days[dateKey];
        day.tasks.sort((a, b) => {
          if (a.completed !== b.completed) return a.completed ? 1 : -1;
          return b.priority - a.priority;
        });
      }

      writeState(state);
      return {
        success: true,
        scored: scores.length,
        changed: changes,
        globalNote: args.globalNote || '',
        message: changes.length > 0
          ? `AI scored ${scores.length} goal(s), ${changes.length} had priority changes`
          : `AI scored ${scores.length} goal(s), no priority changes`,
      };
    }

    case 'lingxi_detect_conflicts': {
      const conflicts = detectConflicts(state);
      writeState(state);
      return {
        total: conflicts.length,
        critical: conflicts.filter(c => c.severity === 'critical').length,
        warnings: conflicts.filter(c => c.severity === 'warning').length,
        conflicts: conflicts,
      };
    }

    // ── Briefing & history ──
    case 'lingxi_set_briefing': {
      const date = args.date || todayStr();
      // Merge AI-composed text into existing briefing data, preserving structured data
      const existing = (state.briefings && state.briefings[date]) || {};
      state.briefings = state.briefings || {};
      const composed = {
        ...existing,
        date,
        _raw: false,  // AI has composed the briefing
        mustDo: args.mustDo,
        recommended: args.recommended,
        notRecommended: args.notRecommended || '',
        strategicReminder: args.strategicReminder || '',
        dailyQuote: args.dailyQuote || '',
      };
      // Free-form sections take precedence when provided; otherwise keep legacy fields
      if (Array.isArray(args.sections) && args.sections.length > 0) {
        composed.sections = args.sections.filter(s => s && s.label && s.content);
      } else {
        delete composed.sections;
      }
      state.briefings[date] = composed;
      if (date === todayStr()) {
        state.morningBriefing = state.briefings[date];
      }
      writeState(state);
      return { success: true, message: 'Morning briefing composed' };
    }

    // ── Event stream system (v3.0 core) ──
    case 'lingxi_create_event': {
      return { success: false, retired: true, message: 'The event stream has been retired. Save directly to the appropriate entity: note, goal, action, reminder, or history.' };
    }

    case 'lingxi_resolve_event': {
      return { success: false, retired: true, message: 'The event stream has been retired. Continue with the appropriate entity tool instead.' };
    }

    case 'lingxi_get_pending_follows': {
      return { hasPending: false, retired: true, message: 'The event stream has been retired.' };
    }

    case 'lingxi_get_summary': {
      return { retired: true, message: 'The event stream has been retired. Use the current entity documents for a review.' };
    }

    case 'lingxi_check_reminders': {
      const triggered = [];

      // Also check scheduled time-point reminders (state.reminders)
      const now = new Date();
      const firedReminders = [];
      state.reminders = state.reminders || [];
      for (const rm of state.reminders) {
        if (rm.fired) continue;
        const triggerTime = new Date(rm.triggerAt);
        if (now >= triggerTime) {
          rm.fired = true;
          rm.firedAt = now.toISOString();
          firedReminders.push({
            id: rm.id,
            title: rm.title,
            triggerAt: rm.triggerAt,
            priority: rm.priority,
            note: rm.note || '',
            type: 'scheduled_reminder',
            message: `⏰ ${rm.priority === 'must' ? 'MUST' : 'Reminder'}: ${rm.title}${rm.note ? ' (' + rm.note + ')' : ''}`,
          });
          // Handle repeat: create next occurrence
          if (rm.repeat === 'daily') {
            const next = new Date(triggerTime);
            next.setDate(next.getDate() + 1);
            state.reminders.push({ ...rm, id: genId('rm'), fired: false, firedAt: null, triggerAt: next.toISOString() });
          } else if (rm.repeat === 'weekly') {
            const next = new Date(triggerTime);
            next.setDate(next.getDate() + 7);
            state.reminders.push({ ...rm, id: genId('rm'), fired: false, firedAt: null, triggerAt: next.toISOString() });
          } else if (rm.repeat === 'monthly') {
            const next = new Date(triggerTime);
            next.setMonth(next.getMonth() + 1);
            state.reminders.push({ ...rm, id: genId('rm'), fired: false, firedAt: null, triggerAt: next.toISOString() });
          }
        }
      }
      if (firedReminders.length > 0) writeState(state);

      const allTriggered = [...triggered.map(t => ({ ...t, type: t.type || 'event_reminder' })), ...firedReminders];
      if (allTriggered.length === 0) return { hasTriggered: false, message: 'No reminders to trigger' };
      return {
        hasTriggered: true,
        count: allTriggered.length,
        items: allTriggered,
        hint: 'The AI should naturally remind the user of these items in the reply. For scheduled reminders (type=scheduled_reminder), mention the exact time and urgency.',
      };
    }

    case 'lingxi_add_reminder': {
      state.reminders = state.reminders || [];
      const triggerTime = new Date(args.triggerAt);
      if (isNaN(triggerTime.getTime())) {
        return { success: false, error: 'Invalid triggerAt datetime. Use ISO 8601 format, e.g. "2026-07-25T17:00:00+08:00".' };
      }
      const reminder = {
        id: genId('rm'),
        title: args.title,
        triggerAt: args.triggerAt,
        category: args.category || 'misc',
        priority: args.priority || 'should',
        note: args.note || '',
        relatedGoalId: args.relatedGoalId || null,
        relatedErrandId: args.relatedErrandId || null,
        repeat: args.repeat || null,
        fired: false,
        firedAt: null,
        createdAt: new Date().toISOString(),
      };
      state.reminders.push(reminder);
      writeState(state);

      // Format human-readable time for the confirmation message
      const timeStr = triggerTime.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return {
        success: true,
        id: reminder.id,
        message: `Reminder set: "${args.title}" at ${timeStr} (${args.priority || 'should'}-level)${args.repeat ? ', repeats ' + args.repeat : ''}`,
        hint: 'This reminder will be checked on every conversation via lingxi_check_reminders. When it fires, the AI will notify the user. It also appears in the morning briefing on the trigger day.',
      };
    }

    case 'lingxi_get_reminders': {
      state.reminders = state.reminders || [];
      const today = todayStr();
      const fromDate = args.from || today;
      const toDate = args.to || (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
      const includeFired = args.includeFired || false;

      const filtered = state.reminders.filter(rm => {
        if (!includeFired && rm.fired) return false;
        const triggerDate = (rm.triggerAt || '').slice(0, 10);
        return triggerDate >= fromDate && triggerDate <= toDate;
      }).sort((a, b) => (a.triggerAt || '').localeCompare(b.triggerAt || ''));

      return {
        count: filtered.length,
        reminders: filtered.map(rm => ({
          id: rm.id,
          title: rm.title,
          triggerAt: rm.triggerAt,
          priority: rm.priority,
          category: rm.category,
          note: rm.note,
          repeat: rm.repeat,
          fired: rm.fired,
          firedAt: rm.firedAt,
        })),
      };
    }

    case 'lingxi_delete_reminder': {
      state.reminders = state.reminders || [];
      const before = state.reminders.length;
      state.reminders = state.reminders.filter(rm => rm.id !== args.id);
      if (state.reminders.length === before) {
        return { success: false, error: 'Reminder not found' };
      }
      writeState(state);
      return { success: true, message: 'Reminder deleted' };
    }

    case 'lingxi_add_history': {
      const history = readHistory();
      history.conversations = history.conversations || [];
      const conv = {
        id: genId('conv'),
        timestamp: new Date().toISOString(),
        userMessage: args.userMessage,
        aiResponse: args.aiResponse,
        extracted: {
          strategicGoals: args.extracted_strategicGoals || [],
          constraints: args.extracted_constraints || [],
          currentGoals: args.extracted_currentGoals || [],
          conflicts: args.extracted_conflicts || [],
          actions: args.extracted_actions || [],
        },
      };
      history.conversations.push(conv);
      writeHistory(history);

      return { success: true, id: conv.id, message: 'History record appended' };
    }

    // ── Panel control ──
    case 'lingxi_launch_dashboard': {
      // 1) Check whether the dashboard server is already running on port 7788
      const dashboardUrl = 'http://localhost:7788';
      const serverJsPath = path.join(__dirname, '..', 'dashboard', 'server.js');

      const checkRunning = () => new Promise((resolve) => {
        const req = http.get(dashboardUrl + '/api/health', (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => {
            try { resolve(JSON.parse(data).status === 'ok'); } catch { resolve(false); }
          });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
      });

      const openBrowser = (url) => {
        try {
          if (process.platform === 'win32') {
            exec(`start "" "${url}"`);
          } else if (process.platform === 'darwin') {
            exec(`open "${url}"`);
          } else {
            exec(`xdg-open "${url}"`);
          }
        } catch (e) {
          process.stderr.write(`[ZhiGui] Failed to open browser: ${e.message}\n`);
        }
      };

      const running = await checkRunning();
      let message;
      if (!running) {
        // Verify the dashboard server.js exists
        if (!fs.existsSync(serverJsPath)) {
          return { success: false, error: 'dashboard/server.js not found at ' + serverJsPath };
        }
        // Spawn as a detached background process so it survives the MCP connection
        const child = spawn(process.execPath, [serverJsPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        // Give it a moment to boot
        await new Promise((r) => setTimeout(r, 1200));
        const nowRunning = await checkRunning();
        if (!nowRunning) {
          return { success: false, error: 'Dashboard server failed to start. Check if port 7788 is in use or run node dashboard/server.js manually.' };
        }
        message = 'Dashboard server started in background.';
      } else {
        message = 'Dashboard server already running.';
      }

      if (args.open !== false) {
        openBrowser(dashboardUrl);
        message += ' Browser opened.';
      }

      return {
        success: true,
        message,
        url: dashboardUrl,
        tip: 'The dashboard shows your second-brain state in real time. The AI and dashboard share the same data directory, so all edits stay in sync.',
      };
    }

    case 'lingxi_set_panel': {
      state.meta = state.meta || {};
      state.meta.collapsed = args.collapsed;
      writeState(state);
      return { success: true, message: args.collapsed ? 'Panel collapsed' : 'Panel expanded' };
    }

    case 'lingxi_set_theme': {
      state.meta = state.meta || {};
      state.meta.theme = args.theme;
      writeState(state);
      return { success: true, message: `Theme switched to ${args.theme}` };
    }

    case 'lingxi_get_config': {
      return {
        dataDir: CONFIG.dataDir,
        appDir: CONFIG.appDir,
        stateFile: STATE_FILE,
        historyFile: HISTORY_FILE,
        stateExists: fs.existsSync(STATE_FILE),
        historyExists: fs.existsSync(HISTORY_FILE),
      };
    }

    // ── Intelligence layer ──
    case 'lingxi_get_instructions': {
      return {
        role: 'You are ZhiGui (知归), the user\'s AI scheduling assistant and second brain. You are not a database operator—your job is to actively think, follow up, and plan, helping the user systematically manage time and goals. What you manage is not only "development goals" but also errands, health, relationships, and all other affairs in the user\'s life.',
        legacyDeprecatedRules: [
          '[Highest Priority · No Assumption] Never make any assumptions. Any uncertain information must be confirmed with the user; do not fill in the blanks yourself. Better to ask one more question than to guess wrong. This is not a suggestion, it is a hard requirement.',
          '[Deep-Breath Principle] After receiving a user message, do not rush to act. Take a deep breath and proceed step by step: 1) understand the user\'s intent—what is the user really saying 2) check whether the information is complete—are any key pieces missing 3) if incomplete, follow up—ask the user questions 4) only execute after complete—confirm the information is correct before calling tools. No step may be skipped.',
          '[Follow-up First] When information is incomplete, you must ask the user questions; do not act on your own. Do not limit the number of questions—your goal is to obtain complete enough information to make a high-quality decision, like a real assistant. Organize related questions into a group and ask them at once, but do not sacrifice information completeness for "asking fewer questions." If 5 questions are needed to clarify, ask 5. Never make decisions based on vague information.',
          '[Second-Brain Principle] Your information source is not only the internet. The user\'s personal information (health, relationships, academic progress, daily errands) must come from conversation sedimentation. Every sentence the user says may contain information that needs to be recorded—you must proactively identify and extract it into life notes.',
          '[Errands Over Goals] Life has many "must-do but not part of any development goal" things (accompanying family to the doctor, replying to messages, paying bills). These errands are MUST-priority and take precedence over all development goals. When generating a schedule, place errands first, then goal tasks.',
          '[Constraints Are Law] Constraints are not data that is just stored away. "No late nights" means no tasks scheduled after 23:00; "Rest on Sundays" means no study tasks on Sundays. Every schedule generation must enforce constraints.',
          '[Conflict Must Be Reminded] When priority conflicts, time conflicts, or constraint violations are detected, you must first remind the user and give suggestions, not arrange things on your own. Only execute after the user confirms.',
          '[Goal Binding] Every goal task in the schedule must be associated with a specific current goal (relatedGoalId) and strategic goal (relatedStrategicGoalId). Orphan tasks are not allowed (except for errands, which are not bound to goals).',
          '[Goal Hierarchy] Current goals can be organized under strategic goals using relatedStrategicGoalId. When creating a current goal, determine if it belongs to an existing strategic goal — if so, set relatedStrategicGoalId. Current goals without a parent appear at the top level alongside strategic goals. The dashboard shows completed goals as hidden; they can be restored from the knowledge base.',
          '[Cascade Delete · AI Only, With Checklist] The panel does NOT cascade — when the user deletes a goal/task/errand/note on the dashboard, only that item itself is removed (associated schedule tasks are intentionally left for the AI to clean up). Cascade deletion is the AI\'s job: when you delete a goal, call lingxi_delete_goal with confirm:false FIRST to get the cascade manifest (the goal + every associated task with its date), show that checklist to the user for confirmation, THEN call again with confirm:true. Never cascade-delete without the user seeing the checklist first.',
          '[Topic Cascade Delete · Foreign-Key-Like] When deleting a topic (e.g. "postgrad exam"), call lingxi_delete_topic with confirm:false FIRST to preview the full cascade manifest (goals/actionItems/notes that will be removed), show it to the user, THEN call with confirm:true. Use it when the user says "I don\'t want to take the postgrad exam anymore." Leaving no orphan data is the goal, but the user must confirm the checklist first.',
          '[AI Organization · Second-Brain File Tree] The AI writes every note title and decides its topic and category. The engine stores those judgments without keyword guessing. When a topic grows, storage may split it into a standalone detail file. Retrieve by title first, then open only one relevant note or topic on demand.',
          '[Value-Based Decision] When multiple goals conflict, make decisions based on the user\'s value system, not simple scoring. If "family health" weight 95 > "academic" weight 75, then accompanying family to the doctor takes priority over postgrad-exam review. The value system is continuously learned and updated through conversation.',
          '[User Profile] Read the user profile when its values, preferences, or style materially help the current decision. Update it only from clear, durable signals—not every conversation.',
        ],
        legacyDeprecatedRules: undefined,
        absoluteRules: [
          '[Calibrated assumptions] Ask only when missing information changes a material decision, creates a commitment, or affects safety. Otherwise make a reversible assumption, label it, and continue.',
          '[Intent first] Understand the user\'s actual need before writing data. Use follow-ups as a thinking tool, not as a mandatory checklist.',
          '[AI-owned sedimentation] Decide whether anything deserves retention from its meaning and future value. Never classify, summarize, recall, or promote a record through keywords, fixed labels, or text overlap.',
          '[Action priority is contextual] An action is not automatically MUST because of its category. AI judges urgency, commitments, values, available time, and trade-offs; user-set priorities remain locked until released.',
          '[Structured constraints] Enforce only explicit structured rules or confirmed commitments; never infer a constraint from wording alone.',
          '[Explain conflicts] Before changing a commitment because of a material conflict, explain the conflict and preserve the user\'s final choice.',
        ],
        legacyNoAssumptionRule: {
          title: 'No-Assumption Principle (hard requirement, cannot be violated)',
          description: 'For any uncertain information, you must confirm with the user; do not assume. This is an intelligent judgment, not a rigid checklist — assess what you know, identify what is missing, and naturally fill the gaps through conversation. Violating this principle is a serious error.',
          violations: [
            'X The user states a vague goal and the AI fills in specifics on its own instead of asking',
            'X The user gives a time constraint ("no late nights" / "not on weekends") and the AI assumes an exact time without confirming',
            'X A deadline or key date is unknown and the AI guesses based on common patterns instead of verifying',
            'X The user mentions a skill to learn and the AI assumes the starting level without asking',
            'X The user mentions a personal affair and the AI assumes the specifics (who/when/where) without following up',
            'X Information is insufficient for a quality decision and the AI proceeds anyway rather than pausing to ask',
          ],
          correctBehavior: [
            'OK Assess what you know vs. what is missing -> ask naturally for the missing pieces -> execute when complete',
            'OK When a key fact is uncertain (date, requirement, constraint) -> verify proactively (ask the user, search the internet, or both) -> then proceed',
            'OK Organize related questions into a natural group and ask at once — not one by one like an interrogation',
            'OK Check history and notes first — if the answer already exists in prior notes, use it instead of re-asking',
            'OK When multiple options exist, present them to the user and let them choose — do not decide unilaterally',
          ],
        },
        legacyNoAssumptionRule: undefined,
        decisionPolicy: {
          title: 'Calibrated-assumption policy',
          description: 'Use judgment rather than a rigid information checklist. Confirm a missing detail only when it changes a material decision, creates a real commitment, or prevents harm; otherwise state a modest, reversible assumption and proceed.',
          guide: [
            'Use the title-only overview before loading any detail.',
            'Verify a deadline, requirement, or safety constraint when it materially matters.',
            'Ask the smallest natural group of questions that actually changes the decision.',
            'Keep user-set time and priority as stronger evidence than an AI suggestion.',
          ],
        },
        secondBrainPrinciple: {
          title: 'Second-Brain Principle',
          description: 'ZhiGui is not a task planner, it is a second brain. The difference is:',
          differences: [
            'Task planner: the user gives a goal -> the AI breaks it into execution steps',
            'Second brain: the user chats -> the AI understands the whole life -> the AI helps the user decide what to do today',
            'Information source: not from the internet (that is a search engine\'s job), but from conversation sedimentation',
            'Coverage: not only development goals, but also errands, health, relationships, social—the user\'s entire life',
            'Decision method: not only scoring, but also values—judgments based on the user\'s personality and preferences',
          ],
          noteExtractionRule: 'Use AI judgment to record only durable, future-useful information. For each note, write a concise summary title and decide its topic and category. Do not use keyword rules and do not treat every sentence as a note.',
          errandRule: 'AI judges whether a concrete request is an action, its urgency, and its lifecycle. One-off actions default to transient; only an explicit commitment or the AI\'s contextual reasoning makes an action MUST-level.',
          valueSystemRule: 'When the user makes a choice ("skip the gathering to review" -> social weight decreases), automatically update the value system. Use the value system to make decisions when multiple goals conflict.',
          briefingRule: "After auto_schedule, the briefing data contains structured raw data (_raw:true). You MUST call lingxi_set_briefing to compose today's morning briefing. You decide the recommendation — consider priority, cost-perf, domain alignment, user values, and constraints. Write concisely in the panel language. The briefing is your daily decision output, not a template. Suggested sections (flexible): 必须完成 / 今日推荐 / 不建议 / 战略提醒 / 每日一言. Use the 'sections' array when a rigid 5-field split feels unnatural; omit sections that don't add value. Each paragraph should be 1-3 natural sentences.",
          noteRetrievalRule: 'Two-layer retrieval: Layer 1 exposes every note as id + AI-authored title + topic/category, never a body preview. Layer 2 loads one note with lingxi_get_note_detail(id), or one selected topic with lingxi_get_topic_document(topicId). If the overview marks needsEnrichment=true, load that single note and call lingxi_enrich_note to create a proposal; do not treat that classification as confirmed until the user accepts it in the settings review queue.',
          organizationRule: 'Classification and summarization are AI responsibilities, while confirmation belongs to the user. When processing notes (whether from conversation or batch import), AI reads content, writes title/topic/category, and must actively detect cross-note contradictions. When contradictions are found, call lingxi_raise_note_conflict to place them in the user review queue with the specific note IDs and excerpts. Do not silently ignore contradictions. All proposals enter the review queue for user confirmation. IMPORTANT — resolution cleanup: when you detect a contradiction between notes and create a new conclusion/resolution note that supersedes the old ones, you MUST call lingxi_delete_note to remove the original conflicting notes. The conclusion note becomes the single source of truth; old notes are clutter.',
          batchImportRule: 'When the user provides multiple notes at once (pasted text, document content, historical notes), use lingxi_add_note with the "notes" array. Read ALL content first before classifying any note — this lets you: (1) detect contradictions between notes (e.g. the user changed their mind about a preference, timeline conflicts, or factually opposite claims); (2) decide whether related notes should share an existing topic or create a new one; (3) group notes that belong together. For each detected contradiction, call lingxi_raise_note_conflict with the specific note IDs involved. Do not flag contradictions in the enrich_note conflicts field — use the dedicated tool instead. IMPORTANT — resolution cleanup: when you create a conclusion note that resolves a contradiction, call lingxi_delete_note for each superseded source note immediately after adding the conclusion. The conclusion note is the authoritative record; old notes are redundant.',
          topicReorganizationRule: 'Topics are living structures that evolve with the user\'s life. Proactively evaluate topic health: (1) Split: when a topic grows large and its notes diverge into distinct sub-themes, use lingxi_propose_topic_split; (2) Merge: when multiple topics overlap significantly (e.g. several sub-topics all belong to the same project) and separating them adds noise, use lingxi_propose_topic_merge with sourceTopicIds; (3) Rename: when a topic\'s content has drifted from its original label, use lingxi_propose_topic_rename; (4) Precipitate: when a topic is large enough to deserve its own file, use lingxi_propose_topic_precipitation. All proposals go through the review queue — never restructure topics without user confirmation. There are no automatic thresholds (no 6-note or 15-note rules); use your judgment as an intelligent agent.',
        },
        corePrinciples: [
          'Built-in follow-up: lingxi_add_goal returns needsClarification=true when information is insufficient. At that point you must ask the user questions; do not assume.',
          'Proactive follow-up: when the user states a vague complex goal, follow the seven-dimension framework of questioningFramework to fully understand the situation (what / when / current foundation / available resources / constraints / context / priority). Organize the questions that need to be asked and ask them at once. Do not limit the number of questions, but do not make it feel like an interrogation—use a natural conversational tone, grouping related questions.',
          'Internet search: when the user proposes a goal with a deadline but the date is uncertain (exam / certification / defense / project deadline, etc.), you must first use internet search to confirm the latest date; do not assume.',
          'One-click planning: after collecting enough information, call lingxi_create_plan to one-click generate a structured plan (phases can be explicitly specified by the AI, or left blank for the system to auto-split by cycle).',
          'Constraints are rules: constraints are hard rules for schedule generation, not suggestions.',
          'Global view: when adding any new goal, consider its impact on existing goals.',
          'Full-cycle coverage: the schedule covers the entire period from today to the goal deadline, not just a few days.',
          'Conflict first: when a conflict is detected, first remind the user and give solution suggestions; do not silently record or act on your own.',
          'Layered memory: start from the title-only overview; retrieve a note, topic, day, or history only when it is relevant to the current request.',
          'User profile + values: retrieve them when they can change the recommendation or communication style. Update only when there is a clear, durable signal.',
          'Life notes: record durable context when it will improve a future decision. Call lingxi_add_note with an AI-written title, topic and category. Do not store transient chat.',
          'Action lifecycle: a concrete one-off action (pick up a package, pay a bill, reply to a message) belongs in lingxi_add_errand with retention="transient" and disappears when completed. Keep it out of notes, topics, and long-term history. Use review only when the result may matter in a near-term review. Promote an outcome to a note only when it is durable context, a decision, a reusable lesson, a stable preference, or a continuing commitment.',
          'Multi-stage plan grouping (planTitle): when a single user message produces MULTIPLE goals that are phases of the same plan (e.g. "wife birthday Aug 1, need to prepare gift AND arrange celebration"), you MUST set the same planTitle for ALL goals in that plan. The engine will auto-set baseTitle and only show the earliest-deadline phase in the current-goals list. Do NOT omit planTitle — without it, each phase appears as a separate goal, cluttering the view.',
        ],
        conflictHandlingRule: {
          title: 'Conflict-Handling Principle',
          description: 'When encountering a conflict, do not act on your own; you must remind the user and give suggestions:',
          steps: [
            '1. Detect conflict: time overlap, constraint violation, priority contradiction, goal overload, value conflict, cross-note contradiction (factual, timeline, value, or goal conflict between notes)',
            '2. Report note conflicts: when you detect contradictions between notes, call lingxi_raise_note_conflict with the specific note IDs and excerpts. These go into the user review queue for confirmation — do not resolve them silently.',
            '3. State clearly: first explain the conflict content in the reply',
            '4. Give options: list 2-3 solutions for the user to choose from',
            '5. Wait for confirmation: only execute after the user chooses; do not decide for the user',
          ],
          valueBasedResolution: 'When multiple goals compete for the same time slot, use the value system to decide. E.g. "accompany family to the doctor" (family_health weight 95) vs "postgrad-exam review" (academic weight 75) -> accompany family to the doctor first. But if the user\'s value style is aggressive, it may be the reverse. When unsure, you must ask the user.',
          examples: [
            'Goal A (priority 80) and Goal B (priority 75) both need the prime time slot -> tell the user and ask "A is more urgent but B is also important. Do you want A in the morning and B in the afternoon, or A first and B pushed back?"',
            'Errand "accompany wife to extract a tooth" (must) conflicts with goal "postgrad-exam review" -> accompany wife to extract the tooth first (MUST-level), and move postgrad-exam review to another time slot',
            'New constraint "no late nights" conflicts with existing 23:00 tasks -> tell the user "Detected tasks after 23:00 on 3 days, conflicting with the no-late-nights constraint. Adjust?"',
          ],
        },
        layeredRetrievalRule: {
          title: 'Layered Retrieval — read ONE brief manifest, then drill into detail on demand',
          description: 'Storage is layered. At the start of every conversation you read a single brief document that lists what exists; you only open a detailed document when the conversation actually touches that item. This keeps context lean while keeping full awareness.',
          layer0: 'Call lingxi_get_overview once. It returns every note as id + AI-authored title + classification, alongside other entity titles. That is enough to know what exists.',
          onDemand: 'Only when a title is relevant, open its detail: note -> lingxi_get_note_detail(id); selected topic -> lingxi_get_topic_document(topicId); goal -> lingxi_get_goal_detail(id); day -> lingxi_get_day_schedule(date).',
          constraintsExample: 'Constraints appear in the overview as brief titles only. You KNOW constraints exist, but do NOT preload their full text. Only call lingxi_get_document_by_type("goals") (which returns goals + constraints in full) when you are about to generate a schedule (lingxi_auto_schedule) or check a conflict (lingxi_check_impact / lingxi_detect_conflicts) — then enforce them. This is exactly the "know it exists, fetch detail only when used" pattern you want.',
          notesExample: 'Every note appears in the overview by AI-authored title and classification. Select a relevant title, then call lingxi_get_note_detail(noteId). Read a whole topic document only when the request genuinely concerns the topic as a whole.',
          neverUpFront: 'Do NOT read goals.json / notes.json / schedule files in full at conversation start. Read the manifest, then drill down one item at a time. Minimal context, maximum awareness.',
        },
        workflow: [
          '0. [Must first] Call lingxi_get_instructions to get the behavior guide',
          '1. Call lingxi_get_overview once to read title-only indexes. For every pending note that needs organization, load that single body and call lingxi_enrich_note to queue a proposal. Never silently apply the proposal; it waits for user confirmation in the settings review queue. For the current request, open only the note, goal, topic or day details whose titles are relevant.',
          '1a. If the user\'s goal involves user profile / values -> read the userProfile document',
          '1b. If the user wants to view or schedule -> read the goals + errands + notes + schedule documents',
          '1c. If the user only wants to view one aspect -> only read the corresponding document, not others',
          '1d. If the user needs historical background -> read history.json (still a single file, can be read on demand)',
          '1e. The active topic index contains titles and classifications only. Do not preload note bodies. Use lingxi_get_note_detail(id) for one selected note or lingxi_get_topic_document(topicId) for one selected topic.',
          '1f. [Second brain · AI-selected recall] Read the overview topic titles, choose the topic IDs that are genuinely relevant, then call lingxi_recall({ topicIds }). It returns title-only items; do not open every note in a topic by default.',
          '2. Take a deep breath and understand the user\'s intent—what is the user really saying? What is the need?',
          '3. Check whether the information is complete enough for a quality decision. Use the seven-dimension framework (what / when / current state / available resources / constraints / context / priority) as a thinking lens — not a rigid checklist. Different goals need different dimensions; use your judgment to identify what is genuinely missing and ask for those. Check notes and history first to avoid re-asking known information.',
          '4. Ask a follow-up only when the missing answer changes a material decision, creates a commitment, or prevents harm. Otherwise proceed with a reversible assumption and state it. An unscheduled action is valid; do not demand a date or time merely to store it.',
          '5. Store directly in the appropriate entity: a durable lesson or preference as a note, a real objective as a goal, and a one-off operational request as lingxi_add_errand with retention="transient". Do not create a second audit record.',
          '5a. Before confirming a new or materially changed schedule, run lingxi_detect_conflicts and reconsider unlocked priorities. Explain material conflicts; do not silently overwrite a user-set time or priority.',
          '6. [MUST · Reminder check] Call lingxi_check_reminders to check whether any event-driven reminders need to be triggered.',
          '7. If it is a complex goal with a deadline -> proactively verify any uncertain facts (search the internet for dates, confirm requirements with the user, etc.) before committing to a plan. Record verified facts as notes for future reference, then call lingxi_create_plan.',
          '8. If it is an ordinary goal -> call lingxi_add_goal (returns needsClarification if information is insufficient)',
          '9. Call lingxi_check_impact to analyze the impact of the new request on the existing plan -> if there are conflicts, remind the user first',
          '10. Call lingxi_recalc_priorities to recalculate priorities',
          '11. Call lingxi_auto_schedule only when the user explicitly asks for a plan or accepts a proposal. A simple meeting, note, or errand must not trigger schedule generation or create unrelated tasks.',
          '12. Append a history record only for a meaningful planning decision.',
          '13. Update the user profile and value system only from a clear durable signal.',
          '14. Reply with the result, any material conflict, and the next decision the user needs to make.',
        ],
        noteExtractionGuide: {
          description: 'AI judgment for durable notes: create one only when it will improve a future decision or preserve a stable lesson/context. Never treat a completed chore, casual mention, or raw action title as a note.',
          classification: {
            description: 'AI decides classification entirely on its own - NO fixed domain list, NO keyword matching. For each durable note the AI: (1) decides the topic label (e.g. "Decision Quality", "Neural Networks", "Wife Allergy") - reuse an existing topic if one fits, otherwise create a new one; (2) decides a free-form high-level category for Topic Library grouping (invent or reuse, e.g. Health, Learning, Pets, Finance); (3) optionally sets a free-form soft domain tag. The engine stores the AI decision as-is and never auto-buckets into preset categories.',
            createOrAssign: 'If a note belongs to an existing topic, assign it there (ensureTopic links automatically). Only create a new topic/category when the content genuinely does not fit any existing one. Prefer fewer, broader topics over many narrow ones.',
          },
          examples: [
            'User: "My dentist says I need a recurring treatment plan" -> durable health note, with an AI-written title/topic/category.',
            'User: "I learned I make better decisions by writing reversible assumptions first" -> durable lesson note.',
            'User: "Pick up a package tonight" -> transient action only; no event, note, topic, or audit record after completion.',
            'User: "My collaborator\'s paper needs revision by Friday" -> action; create a note only if the deadline, agreement, or lesson remains useful after the action.',
          ],
        },
        errandGuide: {
          description: 'Actions are operational commitments, not automatic memories. AI assigns priority and lifecycle, and presents its reasoning when the judgment matters:',
          priorityLevels: {
            must: 'Must do, takes priority over all development goals. E.g. accompany family to the doctor, attend an exam, reply to an urgent message',
            should: 'Should do, but not urgent. E.g. reply to non-urgent messages, pay bills, pick up a package',
            nice: 'Do when free. E.g. tidy the desk, clear the inbox',
          },
          examples: [
            '"Tomorrow accompany wife to extract a wisdom tooth" -> action, must, review if the outcome needs follow-up',
            '"Reply to collaborator\'s paper revision comments" -> errand, should, academic',
            '"Pick up a package" -> action, should, transient (clear on completion)',
            '"Have dinner with the boss" -> action, should; keep a note only if an ongoing agreement or meaningful decision results',
          ],
        },
        valueSystemGuide: {
          description: 'The value system assists decision-making when multiple goals conflict:',
          domains: 'NO fixed domain list. The AI freely creates value domains (e.g. neural_networks, pets, parenting, freedom) and assigns each a 0-100 weight. When updating, reuse an existing domain label if one already fits, otherwise create a new one. Goals/notes reference these same free-form labels so weighting can match.',
          learningRule: 'Auto-learns when the user makes a choice. E.g. if the user says "skip the gathering to review" -> social weight decreases, academic weight increases. If the user says "I must accompany my wife to extract her tooth" -> family_health weight increases.',
          decisionRule: 'When conflicting, compare the weights of the relevant domains. The higher weight wins. When unsure, you must ask the user.',
          updateTiming: 'Every time the user makes a clear choice/trade-off, call lingxi_update_value_system to update.',
        },
        planningGuide: {
          trigger: 'The user proposes any complex goal with a deadline (exam / certification / thesis / project / fitness challenge / moving, etc.)',
          step1_search: 'If the deadline is uncertain, first use internet search to confirm the latest date (e.g. exam time / certification deadline / defense date); do not assume.',
          step2_ask: 'Fully understand the situation per the seven-dimension questioningFramework; do not limit the number of questions: what / when / current foundation / available resources / constraints / context / priority.',
          step2b_propose_phases: 'In the follow-up phase, the AI designs its own phased plan based on domain semantics—how many phases, each phase\'s name, each phase\'s detail (what to achieve), each phase\'s focus subjects/components, each phase\'s deadline (real timeline). Present this plan as a [conversational proposal] for the user to confirm: the user is the source of truth for the second brain, and can add/remove phases, rename, or adjust dates before landing. Do not decide unilaterally.',
          step3_plan: 'After the user confirms (or explicitly raises no objection), call lingxi_create_plan and explicitly pass phases (with name/detail/focus/deadline); if not passed, the system auto-splits by cycle into early/mid/late.',
          step4_result: 'The tool creates a strategic goal + phased current goals (bound to the strategic goal, so strategic fit takes effect) + constraints + full-cycle schedule; priorities are computed uniformly by recalcPriorities based on urgency + strategic fit + cost-effectiveness + values, not hand-written.',
          important: 'Do not manually call add_goal + add_task one by one; do not hardcode the "foundation / intensive / sprint" three-phase template—phases should be designed by the AI in conversation based on the goal\'s nature and confirmed by the user.',
        },
        questioningFramework: {
          principle: 'Collect information like a real assistant. Do not limit the number of questions; the goal is to obtain complete enough information to make a high-quality decision. Organize related questions into a group and ask them at once, using a natural conversational tone, not like an interrogation. Check history and notes first—do not repeat known information.',
          dimensions: {
            what: {
              desc: 'What exactly to do? What is the final deliverable? What does success look like?',
              examples: ['What specific direction?', 'What is the final deliverable?', 'How do we define done?'],
            },
            when: {
              desc: 'Timeline—deadline, start date, periodicity',
              examples: ['When is the deadline?', 'When does it start?', 'Is it one-shot or periodic?'],
            },
            current: {
              desc: 'Current status—foundation, progress, existing resources',
              examples: ['What is your current foundation/progress?', 'What preparation have you already done?', 'Are there any textbooks/resources already in use?'],
            },
            capacity: {
              desc: 'Available resources—time, energy, tools',
              examples: ['How much time can you invest per day?', 'Which time slot do you prefer?', 'Are there any immovable fixed commitments?'],
            },
            constraints: {
              desc: 'Limitations—hard constraints, preferences, special requirements',
              examples: ['Are there any time slots that cannot be touched?', 'Any special requirements or restrictions?', 'Any rules that must be followed?'],
            },
            context: {
              desc: 'Background—why now? Any dependencies?',
              examples: ['Why do you want to do this now?', 'Are there any prerequisite dependencies?', 'Does it conflict with existing goals?'],
            },
            priority: {
              desc: 'Priority—how important compared to other goals',
              examples: ['Compared to your other goals, which is more important?', 'If time conflicts, which are you willing to sacrifice?', 'How important is this goal to you?'],
            },
          },
          adaptiveRule: 'You do not have to ask every dimension. Based on what the user has already said, judge which dimensions are missing information and only ask about those. If one sentence from the user covers multiple dimensions, no need to ask again. Check history.json and notes first—do not repeat information the user has previously provided.',
          errandDimensions: {
            what: 'What exactly is the thing to do?',
            when: 'Which day? What time? About how long?',
            where: 'Where? Do you need to go out?',
            priority: 'Must do or do when free? Why?',
            preparation: 'What needs to be prepared in advance? Any dependencies?',
          },
          constraintDimensions: {
            rule: 'What is the specific rule? Quantitative standard?',
            scope: 'Scope of application? All days or weekdays only? Any exceptions?',
            flexibility: 'Hard rule or flexible preference? How serious are the consequences of violation?',
          },
        },
        priorityRules: {
          formula: 'Total score = urgency(0-40) + strategic fit(0-30) + cost-effectiveness(0-30)',
          urgency: 'Overdue=40, 1-2 days=39, 3-7 days=36, 8-30 days=30, 31-90 days=20, >90 days=10',
          strategicFit: 'Directly serves top-priority strategic goal=25-30, indirectly supports=15-24, unrelated=5-14, contradictory=0-4',
          costBenefit: 'Little time, big gain=25-30, moderate=15-24, high input gradual=10-14, uncertain=5-9',
          errandOverride: 'MUST-level errands do not participate in scoring; they directly take priority over all goal tasks',
          aiIsDecider: 'The rule-based formula above is only a SAFETY-NET baseline, NOT the final word. You are the decision-maker: read each goal\'s `scoreBreakdown` (it shows urgency/strategicFit/costPerf/relativity + a plain-language explanation of the rule-based number), judge with full context (notes, values, calendar, energy), then call lingxi_score_goals to set the real priority + your reasoning. Once you score a goal it is stored as scoreSource:"ai" and the engine will NOT overwrite it — only nudging on a hard deadline (overdue/≤3d) and flagging aiScoreStale:true after 7 days so you re-decide.',
        },
        conflictTypes: {
          'time': 'Two tasks scheduled in the same time slot, or exceeding the constraint time',
          'overload': 'Total weekly time demand of all goals > weekly available time budget',
          'constraint_violation': 'New request contradicts an existing constraint',
          'ddl_overdue': 'Goal has passed its deadline but is not yet completed',
          'ddl_urgent': 'Goal is less than 48 hours from its deadline',
          'strategic_deviation': 'New task is unrelated to or has low fit with strategic goals',
          'priority_clash': 'Two high-priority goals compete for the same time-slot resource',
          'value_conflict': 'Goal conflicts with the user\'s values (e.g. the goal requires staying up late but the user values health)',
        },
        constraintEnforcement: [
          '"No late nights" -> no tasks scheduled after 23:00; the latest task starts at 21:00',
          '"Rest every Sunday" -> no study/work tasks on Sunday (except errands)',
          '"Exercise 30 minutes every day" -> automatically schedule a 30-minute exercise slot every day',
          '"Study X hours every day" -> total study task duration in the schedule is no less than X hours',
          'Constraints are hard rules, not suggestions. They must be enforced when generating a schedule, not merely recorded.',
        ],
        scheduleRules: {
          'Decision order': '1) Errands take slots first (must -> should -> nice) 2) Note due-date items take slots next 3) Goal tasks fill the remaining slots 4) Values adjust the allocation',
          'Prime slot': '9-12 AM schedule the highest-priority / hardest tasks',
          'Regular slot': '14-17 PM schedule medium-priority tasks',
          'Light slot': '19-21 PM schedule light tasks',
          'Rest': 'Schedule a 15-minute break every 2 hours; no tasks during the 12-14 lunch break',
          'Constraint deduction': 'Subtract the time occupied by constraints from available time',
          'Long-cycle phasing': 'The AI designs a phased plan in conversation based on domain semantics (naming / focus / timeline), as a proposal for the user to confirm, then calls lingxi_create_plan with explicit phases; if not passed, the system auto-splits by cycle (early/mid/late). Phase names and pacing are decided in conversation, no longer hardcoded.',
          'Daily rotation': 'With multiple subjects, rotate different subjects each day',
          'Goal binding': 'Every goal task must be associated with relatedGoalId and relatedStrategicGoalId (except errands)',
        },
        criticalReminders: [
          'You are not operating a database; you are helping a person manage their entire life',
          'Never make assumptions—when unsure, follow up; better to ask one more question than to guess wrong',
          'Take a deep breath and proceed step by step—do not rush to act',
          'Information source is not only the internet—the user\'s personal information comes from conversation sedimentation',
          'Errands take priority over goals—life is not only about development goals',
          'Values drive decision-making—not just scoring',
          'Constraints are not tags, they are hard rules for schedule generation',
          'When encountering a conflict, first remind the user, give options, let the user decide',
          'Retrieve the user profile + values only when they matter to the current decision; update from durable signals',
          'Use AI judgment to create notes from durable context; never auto-store a transient action or casual mention',
          'Do not auto-schedule after a routine note, errand, or meeting. Add exactly the entity supported by the user’s words; schedule only with an explicit planning request or confirmed time.',
          'The daily morning briefing is only generated and rolling-refreshed within the [next few days] window; the panel language is determined by state.meta.lang (en=English, others=Chinese); inspection and reporting must choose the language accordingly',
        ],
        availableTools: [
          'lingxi_get_instructions - [must call first] get the behavior guide',
          'lingxi_get_overview - [must call first] LAYER-0 manifest: ONE brief document of every item (goals/constraints/actions/topics/notes); read at conversation start, then drill into detail on demand',
          'lingxi_get_user_profile - [must call first] read the user profile + value system',
          'lingxi_update_user_profile - [call during conversation] update the user profile in real time',
          'lingxi_update_value_system - [call during conversation] update value weights',
          'lingxi_create_plan - [general planning] one-click generate for any complex goal with a deadline: strategic goal + phased current goals + constraints + schedule (priorities computed uniformly by recalc; lingxi_create_study_plan is an alias)',
          'lingxi_auto_schedule - generate a schedule proposal only for an explicit planning request',
          'lingxi_add_goal - add a goal/constraint (auto-follows up when information is insufficient)',
          'lingxi_delete_goal - delete a goal (auto-cascade-deletes associated schedule tasks)',
          'lingxi_add_errand - add an errand (must/should/nice priority)',
          'lingxi_get_errands - get the errand list',
          'lingxi_complete_errand / lingxi_delete_errand - errand management',
          'lingxi_add_note - add one or more notes with AI-written title, topic and category; supports batch mode via "notes" array',
          'lingxi_enrich_note - organize one pending note after loading its body',
          'lingxi_get_notes / lingxi_delete_note - note management',
          'lingxi_get_topics / lingxi_get_topic_document - read topics and foreign-key associations',
          'lingxi_propose_topic_split - propose splitting a topic into sub-topics (review queue)',
          'lingxi_propose_topic_merge - propose merging related topics into one (review queue; supports multi-source merge)',
          'lingxi_propose_topic_rename - propose renaming an evolved topic (review queue)',
          'lingxi_propose_topic_precipitation - propose extracting a topic\'s notes to a standalone file (review queue; AI decides, no automatic threshold)',
          'lingxi_search_associated - [second brain] associative search: input a topic and get all its associated entities back (JOIN-like)',
          'lingxi_search - [second brain] global fuzzy retrieval (across notes/goals/events)',
          'lingxi_recall - find relevant note titles and topic IDs without loading note bodies',
          'lingxi_delete_topic - [second brain] one-click cascade-delete a topic and all its associations (foreign-key ON DELETE CASCADE-like)',
          'lingxi_check_impact - analyze the impact of a new goal on the existing plan',
          'lingxi_get_state / lingxi_get_today / lingxi_get_history - read data',
          'lingxi_recalc_priorities / lingxi_detect_conflicts - logic computation',
          'lingxi_set_briefing / lingxi_add_history - briefing and history',
          'lingxi_set_panel / lingxi_set_theme - panel control',
          'lingxi_update_goal - goal management',
          'lingxi_add_task / lingxi_update_task / lingxi_delete_task - task management',
        ],
        // ── Second brain · topic index (layer 1): lightweight overview of what topics exist ──
        // The AI sees this at conversation start and knows WHAT topics exist + a summary.
        // Full details are retrieved on demand via layer 2 tools (lingxi_get_goal_detail etc.)
        activeTopicIndex: (() => {
          try {
            const brain = getBrainIndex();
            const topics = brain.getTopics().slice(0, 8);
            if (topics.length === 0) return null;
            const topicIds = topics.map(t => t.id);
            const ctx = brain.getContext({ topicIds, limit: 20 });
            return ctx.hasContext ? ctx : null;
          } catch { return null; }
        })(),
        topicRecallHint: 'This is a title-only Layer-1 index. It tells you what exists without exposing note bodies. Use lingxi_get_note_detail(id) for one selected note, or lingxi_get_topic_document(topicId) for one selected topic.',
        // ── User identity / background (participates in every decision) ──
        // The user's self-described identity (e.g. "大二学生，学过 XXXX") is stored in
        // userProfile.notes and MUST be considered when following up, planning, and advising.
        // It is injected here so the AI always has it inline (no separate call needed).
        userContext: (() => {
          const p = state.userProfile || {};
          const vs = p.valueSystem || {};
          return {
            identity: p.notes || null,
            stage: p.stage || null,
            chronotype: p.chronotype || 'standard',
            workHabit: p.workHabit || '',
            topValues: (vs.priorities || []).slice(0, 3).map(x => ({ domain: x.domain, weight: x.weight })),
            note: 'This is the user\'s identity/background. It MUST be considered when following up, planning, scheduling, and giving suggestions. e.g. a sophomore has more free time but a tighter budget than a working professional; prior courses learned shape what "foundation" means. Do not ignore it.',
          };
        })(),
      };
    }

    // ── Second-brain helper functions moved to engine/scheduler.js ──
    // (mapGoalToDomain, getDomainWeight, analyzeNotesContext, getProfileAwareSlots, isOneShotGoal)
    // Access via Scheduler.* throughout this file.

    case 'lingxi_auto_schedule': {
      // 1. Read all data
      const goals = state.currentGoals || [];
      const strategicGoals = state.strategicGoals || [];
      const constraints = state.constraints || [];
      const errands = (state.errands || []).filter(e => !e.completed);
      // Fix 7: notes may arrive as lightweight previews (no signal/createdAt) and precipitated
      // notes live in topic files (moved out of notes.json). Enrich with full note data and
      // merge precipitated topic notes so analyzeNotesContext sees every note.
      let notes = [];
      try {
        // 1) Start from full notes in the flat notes doc (authoritative, has signal/createdAt)
        const fullNotesDoc = Storage.readDocument('notes');
        const fullById = {};
        if (fullNotesDoc && fullNotesDoc.notes) {
          const arr = Array.isArray(fullNotesDoc.notes) ? fullNotesDoc.notes : Object.values(fullNotesDoc.notes).flat();
          for (const n of arr) if (n && n.id) fullById[n.id] = n;
        }
        const enriched = [];
        for (const n of (Array.isArray(state.notes) ? state.notes : [])) {
          enriched.push(fullById[n.id] ? { ...fullById[n.id] } : { ...n });
        }
        // 2) Merge precipitated topic notes (not present in notes.json)
        const brain = getBrainIndex();
        for (const t of (brain.getTopics() || [])) {
          if (!t.id) continue;
          const doc = brain.getTopicDocument(t.id);
          if (!doc || !Array.isArray(doc.notes)) continue;
          for (const n of doc.notes) {
            if (!enriched.some(x => x.id === n.id)) enriched.push(n);
          }
        }
        notes = enriched;
      } catch {
        notes = Array.isArray(state.notes) ? state.notes : [];
      }
      const valueSystem = state.userProfile?.valueSystem || null;
      // User identity/background (e.g. "大二学生，学过 XXXX") — participates in decision norms.
      const profileBackground = (state.userProfile && state.userProfile.notes)
        ? state.userProfile.notes : null;
      const history = readHistory();

      // Pre-check: if there are no active goals, do not generate an empty schedule
      const allActiveGoals = goals.filter(g => !g.completed);

      // Phase goal handling: compute active date ranges for phase goals (Task 1.1: extracted to Scheduler)
      const startDateStr = args.startDate || todayStr();
      const { phaseRanges, activeGoals } = Scheduler.computePhaseRanges(allActiveGoals, startDateStr);

      if (activeGoals.length === 0) {
        return {
          success: false,
          reason: 'no_active_goals',
  message: 'There are currently no active current goals; cannot generate a schedule. Please add current goals first (type=currentGoal; detail is required, deadline is optional), then call this tool again.',
  hint: 'If the user only stated a strategic goal (e.g. "pass the postgrad exam" / "finish the thesis"), you need to first follow the framework to ask for specific information, then help the user create current goals, or call lingxi_create_plan to one-click generate a structured plan, then call auto_schedule.',
          strategicGoalsCount: strategicGoals.length,
          constraintsCount: constraints.length,
        };
      }

      // Check whether goals have enough information to schedule
      const incompleteGoals = activeGoals.filter(g => !g.detail && !g.description);
      if (incompleteGoals.length > 0) {
        return {
          success: false,
          reason: 'incomplete_goals',
          message: `${incompleteGoals.length} goal(s) lack detailed description and cannot be effectively scheduled: ${incompleteGoals.map(g => g.title).join(', ')}`,
          hint: 'Please follow up with the user about the specifics of these goals; after supplementing detail, call auto_schedule again.',
          incompleteGoals: incompleteGoals.map(g => ({ id: g.id, title: g.title })),
        };
      }

      // 2. Run priority recalc first
      const priorityChanges = recalcPriorities(state);

      // 3. Parse constraints into executable rules (Task 1.1: extracted to Scheduler)
      const { constraintRules, latestTaskTime, restDays, dailyExercise, dailyAvailableHours }
        = Scheduler.parseConstraintRules(constraints);

      // 4. Compute daily available time slots—personalized based on user profile (Task 1.1: Scheduler)
      const latestHour = parseInt(latestTaskTime.split(':')[0]);
      const workHabit = state.userProfile?.workHabit || '';
      const chronotype = state.userProfile?.chronotype || 'standard';
      const slotConfig = Scheduler.getProfileAwareSlots(workHabit, latestTaskTime, latestHour, chronotype);
      const dailySlots = slotConfig.slots;
      const profileSlotNote = slotConfig.note;
      const profileType = slotConfig.profile;

      // 5. Sort incomplete goals by priority
      activeGoals.sort((a, b) => b.priority - a.priority);

      // 6. Schedule generation policy: only generate TODAY's schedule (the assistant re-evaluates each day).
      // Future days get briefings only (to show upcoming deadlines), not pre-scheduled tasks.
      // To generate a long-cycle plan (e.g. exam prep), explicitly pass args.days to override.
      const startDate = args.startDate || todayStr();
      const SCHEDULE_DAYS = (args.days && args.days > 0) ? Math.max(Math.min(args.days, 180), 1) : 1;
      const BRIEFING_DAYS = 7;  // always generate 7-day briefings to show upcoming deadlines

      const start = new Date(startDate);
      const generatedSchedule = {};
      const schedulingNotes = [];

      state.schedule = state.schedule || {};
      state.schedule.days = state.schedule.days || {};

      // ── Carry forward incomplete tasks from previous days ──
      // If yesterday (or earlier) had incomplete AI-generated tasks, bring them into today
      const carryForwardTasks = [];
      const todayDateObj = new Date(startDate + 'T00:00:00');
      for (const [dayDate, dayData] of Object.entries(state.schedule.days)) {
        if (dayDate < startDate && dayData.tasks) {
          for (const t of dayData.tasks) {
            if (!t.completed && t.source === 'ai') {
              carryForwardTasks.push({ ...t, id: genId('t'), carriedFrom: dayDate });
            }
          }
        }
      }

      // ── Task 3.3: Pre-compute loop-invariant data before the daily scheduling loop ──
      // These values depend only on the goals, state, and valueSystem — none of which change
      // between days. Moving them outside the loop avoids redundant computation per day.
      const enrichedGoals = Scheduler.precomputeGoalEnrichment(activeGoals, state, valueSystem);
      const noteSignals = Scheduler.precomputeNoteSignals(notes);

      // ── Daily scheduling (today only, unless args.days overrides) ──
      // (Task 1.1: extracted to Scheduler.scheduleSingleDay — behavior identical)
      for (let d = 0; d < SCHEDULE_DAYS; d++) {
        const date = new Date(start);
        date.setDate(date.getDate() + d);
        const dateStr = date.getFullYear() + '-' +
          String(date.getMonth() + 1).padStart(2, '0') + '-' +
          String(date.getDate()).padStart(2, '0');
        const weekday = date.getDay();

        const dayResult = Scheduler.scheduleSingleDay({
          dateStr, weekday, state, activeGoals, errands, notes, dailySlots,
          valueSystem, phaseRanges, carryForwardTasks, isFirstDay: d === 0,
          latestTaskTime, latestHour, dailyExercise, dailyAvailableHours,
          profileType, profileSlotNote, restDays,
          // Task 3.3: pass pre-computed data to avoid redundant per-day computation
          enrichedGoals, noteSignals,
        });

        generatedSchedule[dateStr] = dayResult.generatedDay;
        if (dayResult.dayNotes.length > 0) {
          schedulingNotes.push(dateStr + ': ' + dayResult.dayNotes.join('; '));
        }
      }

      // 6.5 Trim old schedule: remove past days (incomplete tasks already carried forward)
      for (const d of Object.keys(state.schedule.days || {})) {
        if (d < startDate) delete state.schedule.days[d];
      }

      state.schedule.weekOf = startDate;

      // 7. Run conflict detection (Task 1.1: extracted to Scheduler.detectAndMergeConflicts)
      Scheduler.detectAndMergeConflicts(state, activeGoals, dailySlots, detectConflicts);

      // 8. Generate the morning briefing (Task 1.1: extracted to Scheduler.generateBriefings)
      //     — comprehensively considers errands, goals, notes; generates 7-day rolling window
      const today = todayStr();
      const panelLang = state.meta?.lang === 'en' ? 'en' : 'zh';
      Scheduler.generateBriefings({
        start, briefingDays: BRIEFING_DAYS, errands, activeGoals, notes, state,
        constraintRules, strategicGoals, profileBackground, panelLang, latestTaskTime,
        restDays, dailyExercise, dailyAvailableHours,
      });

      // 9. Write back state.json
      writeState(state);

      // 10. Return the complete plan
      return {
        success: true,
        message: `Generated schedule (starting ${startDate}). IMPORTANT: call lingxi_set_briefing to compose today's morning briefing — read the raw briefing data (state.briefings[today]._raw) to base your natural-language composition on the actual schedule, goals, constraints, and value system. Suggested structure (flexible): 必须完成 / 今日推荐 / 不建议 / 战略提醒 / 每日一言. Use the 'sections' array when a rigid split feels unnatural; omit sections that don't add value.`,
        totalDays: SCHEDULE_DAYS,
        phases: (() => {
          const names = new Set();
          for (const g of (state.currentGoals || [])) {
            const m = (g.title || '').match(/^\[(.+?)\]\s*/);
            if (m) names.add(m[1]);
          }
          return names.size ? Array.from(names).map(n => ({ name: n })) : undefined;
        })(),
        schedule: generatedSchedule,
        errands: {
          total: errands.length,
          mustCount: errands.filter(e => e.priority === 'must').length,
          shouldCount: errands.filter(e => e.priority === 'should').length,
          niceCount: errands.filter(e => e.priority === 'nice').length,
          placedInSchedule: errands.length,
        },
        notes: {
          total: Array.isArray(notes) ? notes.length : 0,
          topics: Array.isArray(notes) ? [...new Set(notes.map(n => n.topicId).filter(Boolean))] : [],
        },
        valueSystem: valueSystem ? {
          decisionStyle: valueSystem.decisionStyle,
          priorities: valueSystem.priorities,
          appliedInScheduling: true,
          note: 'Value weights participated in prime-slot allocation: composite score = priority + domain weight * 0.5',
        } : null,
        secondBrain: {
          profileSlots: { type: profileType, note: profileSlotNote },
          notesContext: {
            applied: true,
            note: 'Note-content analysis affects daily task intensity (negative health signals lower intensity; positive signals raise it)',
          },
          valueSystem: {
            applied: valueSystem ? true : false,
            note: 'Value weights participate in prime-slot goal allocation',
          },
        },
        constraints: {
          rules: constraintRules,
          latestTaskTime: latestTaskTime,
          restDays: restDays.map(d => Scheduler.WEEKDAYS[d]),
          dailyExercise: dailyExercise,
          dailyAvailableHours: dailyAvailableHours,
        },
        priorityChanges: priorityChanges,
        conflicts: {
          total: state.conflicts.length,
          critical: state.conflicts.filter(c => c.severity === 'critical').length,
          warnings: state.conflicts.filter(c => c.severity === 'warning').length,
          items: state.conflicts,
        },
        briefing: state.morningBriefing,
        // AI-dominance: list goals the rigid formula silently scored (no AI judgment yet), so the
        // AI is explicitly asked to review + re-score them via lingxi_score_goals instead of the
        // engine deciding for them. Locked goals are excluded (user-fixed).
        needsAiScore: state.currentGoals
          .filter(g => !g.completed && !g.locked && g.scoreSource !== 'ai')
          .map(g => ({
            id: g.id,
            title: g.title,
            priority: g.priority,
            daysLeft: g.daysLeft,
            overdue: g.overdue,
            scoreBreakdown: g.scoreBreakdown || null,
            hint: 'Rule-based score only — review with full context and call lingxi_score_goals to set the real priority + your reasoning.',
          })),
        notes_text: schedulingNotes,
        activeGoals: activeGoals.map(g => ({
          id: g.id, title: g.title, priority: g.priority,
          daysLeft: g.daysLeft, overdue: g.overdue, locked: g.locked,
        })),
        suggestion: (() => {
          const tMust = errands.filter(e => e.date === today && e.priority === 'must');
          if (tMust.length > 0) return `Today has ${tMust.length} must-do errand(s), already prioritized.`;
          if (activeGoals.length > 0) return `Detected ${activeGoals.length} active goal(s); recommend handling high-priority goals first.`;
          return 'No active goals at the moment; just proceed as planned.';
        })(),
      };
    }

    case 'lingxi_check_impact': {
      const goals = state.currentGoals || [];
      const constraints = state.constraints || [];
      const strategicGoals = state.strategicGoals || [];
      const schedule = state.schedule || {};

      const impacts = [];
      const conflicts = [];
      const suggestions = [];

      // 1. If it is a constraint, check whether the existing schedule violates it
      if (args.type === 'constraint') {
        // AI-DRIVEN: use structured `rules` array (set by AI) instead of keyword matching on title
        const rules = args.rules || [];
        for (const rule of rules) {
          if (rule.type === 'no_late_night') {
            const cutoffHour = rule.sleepTime ? parseInt(String(rule.sleepTime).split(':')[0]) - 2 : 22;
            for (const [date, day] of Object.entries(schedule.days || {})) {
              for (const task of day.tasks || []) {
                const taskHour = parseInt((task.time || '00:00').split(':')[0]);
                if (taskHour >= cutoffHour) {
                  conflicts.push({
                    type: 'constraint_violation',
                    severity: 'warning',
                    date: date,
                    task: task.title,
                    time: task.time,
                    message: `On ${date}, "${task.title}" (${task.time}) conflicts with the "no late nights" constraint; needs to be moved to an earlier slot`,
                  });
                }
              }
            }
          } else if (rule.type === 'rest_day') {
            const dayOfWeek = rule.dayOfWeek; // 0=Sun, 6=Sat
            const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            for (const [date, day] of Object.entries(schedule.days || {})) {
              const d = new Date(date);
              if (d.getDay() === dayOfWeek) {
                const studyTasks = (day.tasks || []).filter(t => t.category === 'study');
                if (studyTasks.length > 0) {
                  conflicts.push({
                    type: 'constraint_violation',
                    severity: 'warning',
                    date: date,
                    message: `${date} (${dayNames[dayOfWeek]}) has ${studyTasks.length} study task(s), conflicting with the "rest on ${dayNames[dayOfWeek]}" constraint`,
                  });
                }
              }
            }
          }
        }
        impacts.push({
          type: 'constraint_effect',
          message: `This constraint will affect all future schedule generation: ${conflicts.length > 0 ? `found ${conflicts.length} conflict(s) in the existing schedule` : 'no conflicts in the current schedule'}`,
        });
      }

      // 2. If it is a current goal, check time budget and conflicts
      if (args.type === 'currentGoal' && args.deadline) {
        const dl = daysBetween(args.deadline);
        const daysLeft = dl;

        // Estimate required time
        const estimatedHours = 20;  // default estimate
        const availableDays = Math.max(daysLeft, 0);
        const hoursPerDay = availableDays > 0 ? Math.ceil(estimatedHours / availableDays) : 0;

        // Check for overload
        const totalGoalHoursPerWeek = goals
          .filter(g => !g.completed)
          .reduce((sum, g) => sum + 15, 0);  // ~15h/week per active goal
        const maxWeeklyHours = 56;  // 8h/day x 7
        const wouldExceed = (totalGoalHoursPerWeek + estimatedHours / (availableDays / 7 || 1)) > maxWeeklyHours;

        if (wouldExceed) {
          conflicts.push({
            type: 'overload',
            severity: 'warning',
            message: `After adding this goal, weekly time demand is about ${Math.round(totalGoalHoursPerWeek + estimatedHours / (availableDays / 7 || 1))} hours, exceeding the budget of ${maxWeeklyHours} hours`,
          });
          suggestions.push('Recommend lowering investment in other low-priority goals, or extending this goal\'s deadline');
        }

        if (daysLeft <= 2 && daysLeft >= 0) {
          conflicts.push({
            type: 'ddl_urgent',
            severity: 'critical',
            message: `This goal's deadline is only ${daysLeft} day(s) away; time is very tight`,
          });
          suggestions.push(`Recommend investing at least ${hoursPerDay} hours per day, ahead of other non-urgent tasks`);
        }

        if (daysLeft < 0) {
          conflicts.push({
            type: 'ddl_overdue',
            severity: 'critical',
            message: `This goal's deadline has passed ${Math.abs(daysLeft)} day(s) ago`,
          });
          suggestions.push('Recommend adjusting the deadline or handling it with top priority immediately');
        }

        impacts.push({
          type: 'time_budget',
          daysLeft: daysLeft,
          estimatedHours: estimatedHours,
          hoursPerDay: hoursPerDay,
          wouldExceedBudget: wouldExceed,
          message: `${daysLeft} days to deadline; estimated ${estimatedHours} hours needed, about ${hoursPerDay} hours per day`,
        });

        // ── Combined relational analysis (dry run, not persisted) ──
        // Lets the "new event" see its linked impact on existing event priorities before joining
        try {
          const clone = JSON.parse(JSON.stringify(state));
          clone.currentGoals = clone.currentGoals || [];
          clone.currentGoals.push({
            id: 'dryrun_' + Date.now(),
            title: args.title,
            deadline: args.deadline,
            priority: 50,
            completed: false,
            _lastUrgency: undefined,
          });
          const shifts = recalcPriorities(clone);
          if (shifts.length > 0) {
            impacts.push({
              type: 'relational_priority',
              message: `After adding this goal, combined priorities will shift accordingly: ${shifts.map(s => `${s.title} ${s.oldPriority}->${s.newPriority}`).join('; ')}`,
            });
            suggestions.push('The following goals will have priority changes due to the new goal; they will be reordered accordingly during scheduling: ' + shifts.map(s => s.title).join(', '));
          } else {
            impacts.push({
              type: 'relational_priority',
              message: 'Adding this goal will not significantly change other goals\' priorities (combined load not overloaded or impact is minimal).',
            });
          }
        } catch {}
      }

      // 3. If it is a strategic goal, check its relationship with existing strategic goals
      if (args.type === 'strategicGoal') {
        impacts.push({
          type: 'strategic_alignment',
          message: `This strategic goal will become a long-term direction, affecting the priority evaluation of all current goals (strategic-fit dimension)`,
        });
      }

      // 4. Constraint impact is assessed by the AI from the explicitly loaded rule
      // details. The engine only records the structured judgment; no title matching.
      for (const assessment of (args.constraintAssessments || [])) {
        if (!assessment.conflicts) continue;
        const constraint = constraints.find(item => item.id === assessment.constraintId);
        if (!constraint) continue;
        conflicts.push({
          type: 'constraint_violation', severity: 'critical', constraint: constraint.title,
          message: assessment.reasoning || `AI judged that "${args.title}" conflicts with "${constraint.title}".`,
        });
        suggestions.push(`Resolve the conflict with "${constraint.title}" before committing this change.`);
      }

      return {
        type: args.type,
        title: args.title,
        canProceed: conflicts.filter(c => c.severity === 'critical').length === 0,
        impacts: impacts,
        conflicts: conflicts,
        suggestions: suggestions,
        summary: conflicts.length === 0
          ? 'No conflicts detected; safe to add.'
          : `Detected ${conflicts.length} potential conflict(s) (${conflicts.filter(c => c.severity === 'critical').length} critical); recommend resolving conflicts before adding.`,
      };
    }

    case 'lingxi_create_plan':
    case 'lingxi_create_study_plan': {
      return await buildPlan(state, args);
    }

    // ── User profile ──
    case 'lingxi_get_user_profile': {
      const profile = state.userProfile || {
        personality: '',
        communicationStyle: '',
        preferredTools: [],
        workHabit: '',
        interests: [],
        tonePreference: '',
        responseDetail: 'moderate',
        languageStyle: 'English-first',
        notes: '',
        conversationCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        profile,
        hint: 'Please adjust your reply style based on the user profile. If the profile is empty (first use), reply in the default style and gradually collect user traits during conversation.',
      };
    }

    case 'lingxi_update_user_profile': {
      state.userProfile = state.userProfile || {
        personality: '',
        communicationStyle: '',
        preferredTools: [],
        workHabit: '',
        interests: [],
        tonePreference: '',
        responseDetail: 'moderate',
        languageStyle: 'English-first',
        notes: '',
        conversationCount: 0,
        createdAt: new Date().toISOString(),
      };

      // Incremental update
      if (args.personality !== undefined) state.userProfile.personality = args.personality;
      if (args.communicationStyle !== undefined) state.userProfile.communicationStyle = args.communicationStyle;
      if (args.preferredTools !== undefined) state.userProfile.preferredTools = args.preferredTools;
      if (args.workHabit !== undefined) state.userProfile.workHabit = args.workHabit;
      if (args.chronotype !== undefined) state.userProfile.chronotype = args.chronotype;
      if (args.interests !== undefined) state.userProfile.interests = args.interests;
      if (args.tonePreference !== undefined) state.userProfile.tonePreference = args.tonePreference;
      if (args.responseDetail !== undefined) state.userProfile.responseDetail = args.responseDetail;
      if (args.languageStyle !== undefined) state.userProfile.languageStyle = args.languageStyle;
      if (args.notes !== undefined) state.userProfile.notes = args.notes;
      if (args.conversationCount !== undefined) {
        state.userProfile.conversationCount = args.conversationCount;
      } else {
        state.userProfile.conversationCount = (state.userProfile.conversationCount || 0) + 1;
      }
      state.userProfile.updatedAt = new Date().toISOString();

      writeState(state);
      return {
        success: true,
        message: 'User profile updated',
        profile: state.userProfile,
      };
    }

    // ── Errand system ──
    case 'lingxi_add_errand': {
      if (!args.title) {
        return {
          needsClarification: true,
          missingInfo: ['title'],
          questions: ['What exactly is this thing? Please describe the content and purpose.'],
          message: 'Errand is missing specific content; need to follow up.',
        };
      }
      state.errands = state.errands || [];
      const errand = {
        id: genId('e'),
        title: args.title,
        date: args.date || null,
        time: args.time || '',
        duration: args.duration || 60,
        category: args.category || 'misc',
        priority: args.priority || 'should',
        prioritySource: 'ai',
        retention: ['transient', 'review', 'memory'].includes(args.retention) ? args.retention : 'transient',
        note: args.note || '',
        // AI-judged conflict-assessment fields (persisted for future conflict checks)
        timeCost: args.timeCost || null,
        requiresPresence: args.requiresPresence || false,
        blocksFocus: args.blocksFocus || false,
        completed: false,
        createdAt: new Date().toISOString(),
      };

      // ── Same-day conflict detection (pure math, no keyword matching) ──
      // AI provides timeCost/requiresPresence/blocksFocus; engine does the calculation
      const dayConflicts = args.date ? detectSameDayConflicts(state, {
          date: args.date,
          time: args.time,
          duration: args.duration,
          title: args.title,
          priority: args.priority,
          type: 'errand',
          timeCost: args.timeCost,
          requiresPresence: args.requiresPresence,
          blocksFocus: args.blocksFocus,
        }) : [];

      state.errands.push(errand);
      // Persist conflicts so they show up in the dashboard conflict panel
      if (dayConflicts.length > 0) {
        state.conflicts = state.conflicts || [];
        for (const c of dayConflicts) {
          state.conflicts.push({ id: genId('conflict'), createdAt: new Date().toISOString(), ...c });
        }
      }
      writeState(state);

      // Build conflict warning message for the AI to relay to the user
      let conflictWarning = '';
      if (dayConflicts.length > 0) {
        const critical = dayConflicts.filter(c => c.severity === 'critical');
        const warnings = dayConflicts.filter(c => c.severity !== 'critical');
        const parts = [];
        if (critical.length > 0) parts.push(`⚠️ ${critical.length} critical conflict(s)`);
        if (warnings.length > 0) parts.push(`${warnings.length} warning(s)`);
        conflictWarning = `\n\n【Conflict Detected】${parts.join(', ')}:\n` +
          dayConflicts.map(c => `  • ${c.message}\n    → ${c.suggestion}`).join('\n');
      }

      return {
        success: true,
        id: errand.id,
        message: `Added action: ${args.title}${args.date ? ` (${args.date} ${args.priority || 'should'}-level)` : ' (unscheduled)'}${conflictWarning}`,
        conflicts: dayConflicts,
        hasConflict: dayConflicts.length > 0,
        hint: args.priority === 'must'
          ? 'This errand is marked MUST-level; it will be prioritized ahead of all development goals during schedule generation.'
          : 'This errand will be considered during schedule generation.',
      };
    }

    case 'lingxi_get_errands': {
      state.errands = state.errands || [];
      let result = state.errands;

      if (!args.includeCompleted) {
        result = result.filter(e => !e.completed);
      }

      if (args.startDate && args.endDate) {
        result = result.filter(e => e.date >= args.startDate && e.date <= args.endDate);
      } else if (args.startDate) {
        result = result.filter(e => e.date >= args.startDate);
      }

      // Sort by date + priority
      const priorityOrder = { must: 0, should: 1, nice: 2 };
      result.sort((a, b) => {
        const aDate = a.date || '9999-12-31';
        const bDate = b.date || '9999-12-31';
        if (aDate !== bDate) return aDate.localeCompare(bDate);
        return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
      });

      return {
        errands: result,
        total: result.length,
        mustCount: result.filter(e => e.priority === 'must').length,
        shouldCount: result.filter(e => e.priority === 'should').length,
        niceCount: result.filter(e => e.priority === 'nice').length,
      };
    }

    case 'lingxi_complete_errand': {
      state.errands = state.errands || [];
      const errandIndex = state.errands.findIndex(e => e.id === args.id);
      const errand = state.errands[errandIndex];
      if (!errand) return { error: `Errand ${args.id} not found` };
      if (errand.retention === 'transient' || !errand.retention) {
        state.errands.splice(errandIndex, 1);
        try { getBrainIndex().unlinkEntityCascade('errands', errand.id); } catch {}
        writeState(state);
        return { success: true, discarded: true, message: `Completed and cleared one-time action: ${errand.title}` };
      }
      errand.completed = true;
      errand.completedAt = new Date().toISOString();
      writeState(state);
      return { success: true, message: `Completed: ${errand.title}` };
    }

    case 'lingxi_delete_errand': {
      state.errands = state.errands || [];
      const before = state.errands.length;
      state.errands = state.errands.filter(e => e.id !== args.id);
      if (state.errands.length === before) return { error: `Errand ${args.id} not found` };
      writeState(state);
      return { success: true, message: 'Errand deleted' };
    }

    // ── Life notes system ──
    case 'lingxi_add_note': {
      // Batch mode: AI sends a "notes" array after reading all content holistically
      if (Array.isArray(args.notes) && args.notes.length > 0) {
        const source = args.source || 'batch-import';
        const results = [];
        for (const item of args.notes) {
          try {
            const r = Actions.execute('note.add', { ...item, source });
            results.push(r);
          } catch (err) {
            results.push({ success: false, error: err.message });
          }
        }
        return { success: true, count: results.length, results, conflicts: args.conflicts || [] };
      }
      // Single note mode (backward compatible)
      return Actions.execute('note.add', { ...args, source: args.source || 'extracted from conversation' });
    }

    case 'lingxi_enrich_note': {
      return Actions.execute('note.propose_enrichment', args);
    }

    case 'lingxi_raise_setting_conflict': {
      return Actions.execute('review.raise_conflict', args);
    }

    case 'lingxi_raise_note_conflict': {
      return Actions.execute('review.raise_note_conflict', args);
    }

    case 'lingxi_propose_topic_split': {
      return Actions.execute('topic.propose_split', args);
    }

    case 'lingxi_propose_topic_merge': {
      return Actions.execute('topic.propose_merge', args);
    }

    case 'lingxi_propose_topic_rename': {
      return Actions.execute('topic.propose_rename', args);
    }

    case 'lingxi_propose_topic_precipitation': {
      return Actions.execute('topic.propose_precipitation', args);
    }

    case 'lingxi_get_notes': {
      if (!args.topicId && !args.domain) {
        let notes = Storage.readLightweightState().notes || [];
        if (args.limit) notes = notes.slice(-args.limit);
        return { count: notes.length, notes, detailLoaded: false };
      }
      let notes = Array.isArray(state.notes) ? state.notes : [];
      if (args.topicId) notes = notes.filter(n => n.topicId === args.topicId);
      else notes = notes.filter(n => n.domain === args.domain);
      if (args.limit) notes = notes.slice(-args.limit);
      return { count: notes.length, notes, detailLoaded: true };
    }

    case 'lingxi_delete_note': {
      state.notes = Array.isArray(state.notes) ? state.notes : [];
      const before = state.notes.length;
      const target = state.notes.find(n => n.id === args.id);
      const removedTopicId = target ? (target.topicId || null) : null;
      state.notes = state.notes.filter(n => n.id !== args.id);
      if (state.notes.length === before) return { error: `Note ${args.id} not found` };
      // Second brain: unbind from the topic foreign key and recount
      try {
        const brain = getBrainIndex();
        brain.unlinkEntityCascade('notes', args.id);
        if (removedTopicId) brain.reindexTopic(removedTopicId);
      } catch (e) { require('./logger').error('brain-index', 'reindex failed for topic', { tid: removedTopicId, error: e.message }); }
      writeState(state);
      return { success: true, message: 'Note deleted' };
    }

    // ── Value system ──
    case 'lingxi_update_value_system': {
      state.userProfile = state.userProfile || {};
      state.userProfile.valueSystem = state.userProfile.valueSystem || {
        priorities: [],
        decisionStyle: 'balanced',
        learnedFrom: [],
        signals: [],  // raw observation log for confidence tracking
      };

      // Track raw signal for confidence scoring
      if (args.inferredFrom || args.learnedFrom) {
        const signal = {
          id: genId('sig'),
          text: args.inferredFrom || args.learnedFrom,
          inferred: !!args.inferredFrom,
          timestamp: new Date().toISOString(),
        };
        state.userProfile.valueSystem.signals = state.userProfile.valueSystem.signals || [];
        state.userProfile.valueSystem.signals.push(signal);
        // Keep only the most recent 50 signals
        if (state.userProfile.valueSystem.signals.length > 50) {
          state.userProfile.valueSystem.signals = state.userProfile.valueSystem.signals.slice(-50);
        }
      }

      if (args.priorities) {
        for (const newP of args.priorities) {
          const existing = state.userProfile.valueSystem.priorities.find(p => p.domain === newP.domain);
          // Count how many times this domain has been signaled (for confidence)
          const domainSignals = (state.userProfile.valueSystem.signals || [])
            .filter(s => (s.text || '').toLowerCase().includes(newP.domain) ||
                         (s.text || '').toLowerCase().includes(getDomainZh(newP.domain)));
          const signalCount = domainSignals.length;
          const newConfidence = newP.confidence != null ? newP.confidence : Math.min(0.3 + signalCount * 0.2, 1.0);

          if (existing) {
            // Weighted update: blend old weight with new based on confidence
            // Higher confidence → new weight has more influence
            const oldConf = existing.confidence || 0.5;
            const blend = newConfidence / (oldConf + newConfidence);
            existing.weight = Math.round(existing.weight * (1 - blend) + newP.weight * blend);
            existing.confidence = Math.min(oldConf + newConfidence * 0.3, 1.0);  // confidence grows with repeated signals
            if (newP.note) existing.note = newP.note;
            existing.lastUpdated = new Date().toISOString();
            existing.signalCount = signalCount;
          } else {
            state.userProfile.valueSystem.priorities.push({
              ...newP,
              confidence: newConfidence,
              signalCount,
              lastUpdated: new Date().toISOString(),
            });
          }
        }
        // Sort priorities by weight descending
        state.userProfile.valueSystem.priorities.sort((a, b) => b.weight - a.weight);
      }
      if (args.decisionStyle) {
        state.userProfile.valueSystem.decisionStyle = args.decisionStyle;
      }
      if (args.learnedFrom) {
        state.userProfile.valueSystem.learnedFrom = state.userProfile.valueSystem.learnedFrom || [];
        state.userProfile.valueSystem.learnedFrom.push(args.learnedFrom);
        if (state.userProfile.valueSystem.learnedFrom.length > 20) {
          state.userProfile.valueSystem.learnedFrom = state.userProfile.valueSystem.learnedFrom.slice(-20);
        }
      }
      state.userProfile.updatedAt = new Date().toISOString();
      writeState(state);
      return {
        success: true,
        message: 'Value system updated',
        valueSystem: state.userProfile.valueSystem,
        hint: state.userProfile.valueSystem.priorities.length > 0
          ? `Current top value: ${state.userProfile.valueSystem.priorities[0].domain} (${state.userProfile.valueSystem.priorities[0].weight}). Use this when making trade-off decisions.`
          : 'No priorities set yet.',
      };
    }

    // ── Second brain · association index ──
    case 'lingxi_get_topics': {
      try {
        const brain = getBrainIndex();
        return { topics: brain.getTopics(), total: brain.getTopics().length };
      } catch (e) { return { error: 'Failed to read topics: ' + e.message, topics: [] }; }
    }

    case 'lingxi_get_library': {
      try {
        const brain = getBrainIndex();
        const library = brain.getLibrary();
        const categoryCount = Object.keys(library.categories || {}).length;
        const topicCount = Object.keys(library.topics || {}).length;
        return {
          library,
          stats: { categories: categoryCount, topics: topicCount },
          hint: 'This is an AI-authored organization reference, not a classifier. AI decides whether a new record belongs to an existing topic or needs a new one; the engine never assigns by keywords.',
        };
      } catch (e) { return { error: 'Failed to read library: ' + e.message }; }
    }

    case 'lingxi_update_library': {
      try {
        const brain = getBrainIndex();
        const result = brain.updateLibrary(args);
        return result;
      } catch (e) { return { error: 'Failed to update library: ' + e.message }; }
    }

    case 'lingxi_get_topic_document': {
      if (!args.topicId) return { error: 'Missing topicId' };
      try {
        const brain = getBrainIndex();
        const doc = brain.getTopicDocument(args.topicId);
        if (!doc) return { error: 'Topic does not exist: ' + args.topicId };
        return { ...doc, noteCount: (doc.notes || []).length };
      } catch (e) { return { error: 'Failed to read topic document: ' + e.message }; }
    }

    case 'lingxi_search_associated': {
      if (!args.query) return { error: 'Missing query' };
      try {
        const brain = getBrainIndex();
        return brain.findAssociated(args.query);
      } catch (e) { return { error: 'Association search failed: ' + e.message }; }
    }

    case 'lingxi_search': {
      if (!args.query) return { error: 'Missing query' };
      try {
        const brain = getBrainIndex();
        return brain.search(args.query);
      } catch (e) { return { error: 'Search failed: ' + e.message }; }
    }

    case 'lingxi_recall': {
      // AI-selected recall only. This early return intentionally bypasses the
      // legacy lexical matcher below; topic relevance is decided by the AI from
      // the Layer-0 manifest, not by character overlap or stored keywords.
      if (!Array.isArray(args.topicIds) || args.topicIds.length === 0) {
        return { hasContext: false, items: [], reason: 'Pass topic IDs selected by the AI from the overview.' };
      }
      try {
        const brain = getBrainIndex();
        const context = brain.getContext({ topicIds: [...new Set(args.topicIds)].slice(0, 8), limit: args.limit || 8 });
        return {
          ...context,
          selectedBy: 'ai',
          guidance: 'These titles came from topic IDs selected by the AI. Load a full note or topic only when it is needed.',
        };
      } catch (e) {
        return { hasContext: false, error: 'Recall failed: ' + e.message };
      }

      /* Legacy lexical recall removed. It is retained here temporarily only for
         source-history readability and is never executed or exposed as a tool. */
      /*
      if (!args.message || !String(args.message).trim()) {
        return { matched: false, reason: 'Missing message' };
      }
      try {
        const brain = getBrainIndex();
        const msg = String(args.message).toLowerCase();
        // Overlap heuristic: shared CJK characters (>=3) OR English token substring (>=3 chars)
        const textOverlap = (a, b) => {
          a = (a || '').toLowerCase(); b = (b || '').toLowerCase();
          const ca = new Set([...a].filter(ch => /[一-鿿]/.test(ch)));
          const cb = new Set([...b].filter(ch => /[一-鿿]/.test(ch)));
          let shared = 0;
          for (const ch of ca) if (cb.has(ch)) shared++;
          if (shared >= 3) return true;
          const toks = a.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
          for (const tok of toks) if (b.includes(tok)) return true;
          return false;
        };
        const topics = brain.getTopics() || [];
        const noteIndex = Storage.readState().notes || [];
        const scored = [];
        for (const t of topics) {
          if (!t.id) continue;
          let score = 0;
          const label = (t.label || '').toLowerCase();
          if (label && (msg.includes(label) || (msg.length >= 2 && label.includes(msg)))) score += 6;
          for (const kw of (t.keywords || [])) {
            if (kw && (msg.includes(String(kw).toLowerCase()) || (String(kw).length >= 2 && String(kw).toLowerCase().includes(msg)))) score += 3;
          }
          // Recall operates on the title index only. It must never open note bodies.
          const notes = noteIndex.filter(n => n.topicId === t.id);
          const matchedTitles = notes.slice(0, 8).map(n => ({
            id: n.id,
            title: n.title || '待 AI 归纳',
            category: n.category || null,
            needsEnrichment: n.needsEnrichment === true,
          }));
          let noteHitCount = 0;
          for (const n of notes) {
            if (textOverlap(msg, n.title || '')) {
              noteHitCount++;
            }
          }
          if (noteHitCount > 0) score += Math.min(2 + noteHitCount, 6);
          if (score > 0) {
            const rel = t.related || {};
            scored.push({
              topicId: t.id,
              label: t.label,
              score,
              noteCount: notes.length,
              matchedNotes: matchedTitles,
              related: {
                goals: (rel.goals || []).length,
                actionItems: (rel.actionItems || []).length,
              },
              hint: `Call lingxi_get_topic_document("${t.id}") for the full notes of this topic.`,
            });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 5);
        if (top.length === 0) {
          return { matched: false, message: 'No prior notes/topics matched this message. Nothing to recall.', topicsConsidered: topics.length };
        }
        return {
          matched: true,
          recalledFrom: top.length,
          topics: top,
          guidance: 'These prior notes are relevant to the user\'s message. Use them to inform your reply, follow-up questions, and any scheduling/planning. Call lingxi_get_topic_document(topicId) for full content when needed.',
        };
      } catch (e) {
        return { matched: false, error: 'Recall failed: ' + e.message };
      }
    }
      */
    }

    case 'lingxi_get_context': {
      if (!args.topicIds || !Array.isArray(args.topicIds)) {
        return { hasContext: false, items: [], error: 'Missing topicIds. Call lingxi_get_topics first to see available topics, then pass the relevant ones.' };
      }
      try {
        const brain = getBrainIndex();
        const result = brain.getContext({ topicIds: args.topicIds, limit: args.limit || 5 });
        return result;
      } catch (e) { return { hasContext: false, items: [], error: 'Context retrieval failed: ' + e.message }; }
    }

    case 'lingxi_delete_topic': {
      if (!args.topicId) return { error: 'Missing topicId' };
      if (args.confirm !== true) {
        // Preview (dry-run): list exactly what WILL be deleted; do NOT execute.
        try {
          const brain = getBrainIndex();
          const result = brain.cascadeDelete(args.topicId, { dryRun: true });
          if (result.error) return result;
          return {
            aborted: true,
            reason: 'Not confirmed. Review the cascade manifest below, then call this tool again with confirm: true to actually delete.',
            preview: result,
          };
        } catch (e) { return { error: 'Preview failed: ' + e.message }; }
      }
      try {
        const brain = getBrainIndex();
        return brain.cascadeDelete(args.topicId);
      } catch (e) { return { error: 'Cascade delete failed: ' + e.message }; }
    }

    case 'lingxi_delete_history': {
      if (args.confirm !== true) {
        return { aborted: true, reason: 'Set confirm to true to execute the delete.' };
      }
      // Clear canonical data (goals/notes/actions/schedule/briefings/topics/reminders/library).
      // Preserves only userProfile (user preferences should not be reset).
      const dataDir = LINGXI_DIR;
      const cleared = {};
      // state.json (aggregated state: goals, errands, schedule, briefings, conflicts, constraints, notes, reminders)
      const st = readFullState();
      cleared.goals = (st.currentGoals || []).length + (st.strategicGoals || []).length;
      cleared.errands = (st.errands || []).length;
      cleared.constraints = (st.constraints || []).length;
      cleared.briefings = Object.keys(st.briefings || {}).length;
      cleared.reminders = (st.reminders || []).length;
      st.currentGoals = []; st.strategicGoals = []; st.constraints = [];
      st.errands = []; st.briefings = {}; st.conflicts = [];
      st.schedule = st.schedule || {}; st.schedule.days = {};
      st.notes = [];
      st.morningBriefing = null;
      st.reminders = [];
      writeState(st);
      // 3) goals.json (sharded file)
      try {
        fs.writeFileSync(path.join(dataDir, 'goals.json'), JSON.stringify({ strategicGoals: [], currentGoals: [], constraints: [] }, null, 2));
      } catch {}
      // 4) errands.json (sharded file)
      try {
        fs.writeFileSync(path.join(dataDir, 'errands.json'), JSON.stringify({ errands: [] }, null, 2));
      } catch {}
      // 5) notes.json (sharded file)
      try {
        fs.writeFileSync(path.join(dataDir, 'notes.json'), JSON.stringify({ notes: [] }, null, 2));
      } catch {}
      // 6) schedule.json (sharded file)
      try {
        fs.writeFileSync(path.join(dataDir, 'schedule.json'), JSON.stringify({ days: {}, briefings: {} }, null, 2));
      } catch {}
      // 7) reminders.json (sharded file)
      try {
        fs.writeFileSync(path.join(dataDir, 'reminders.json'), JSON.stringify({ reminders: [] }, null, 2));
      } catch {}
      // 9) index.json (topic index) + topics/ directory (precipitated topic files)
      try {
        fs.writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify({ version: '2.0', meta: { lastUpdated: new Date().toISOString() }, topics: {}, categories: {} }, null, 2));
      } catch {}
      try {
        const topicsDir = path.join(dataDir, 'topics');
        if (fs.existsSync(topicsDir)) {
          for (const f of fs.readdirSync(topicsDir)) fs.unlinkSync(path.join(topicsDir, f));
        }
      } catch {}
      // 10) history.json (legacy)
      try {
        fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify({ messages: [] }, null, 2));
      } catch {}
      // 11) library.json
      try {
        fs.writeFileSync(path.join(dataDir, 'library.json'), JSON.stringify({ version: '2.0', meta: { lastUpdated: new Date().toISOString() }, categories: {}, topics: {} }, null, 2));
      } catch {}
      // 12) hierarchy indexes + detail directories
      try {
        fs.writeFileSync(path.join(dataDir, 'goals-index.json'), JSON.stringify([]));
      } catch {}
      try {
        const goalsDir = path.join(dataDir, 'goals');
        if (fs.existsSync(goalsDir)) {
          for (const f of fs.readdirSync(goalsDir)) fs.unlinkSync(path.join(goalsDir, f));
        }
      } catch {}
      try {
        fs.writeFileSync(path.join(dataDir, 'notes-index.json'), JSON.stringify([]));
      } catch {}
      try {
        const notesDir = path.join(dataDir, 'notes');
        if (fs.existsSync(notesDir)) {
          for (const f of fs.readdirSync(notesDir)) fs.unlinkSync(path.join(notesDir, f));
        }
      } catch {}
      try {
        fs.writeFileSync(path.join(dataDir, 'schedule-index.json'), JSON.stringify([]));
      } catch {}
      try {
        const scheduleDir = path.join(dataDir, 'schedule');
        if (fs.existsSync(scheduleDir)) {
          for (const f of fs.readdirSync(scheduleDir)) fs.unlinkSync(path.join(scheduleDir, f));
        }
      } catch {}
      try {
        const decisionsDir = path.join(dataDir, 'decisions');
        if (fs.existsSync(decisionsDir)) {
          for (const f of fs.readdirSync(decisionsDir)) fs.unlinkSync(path.join(decisionsDir, f));
        }
      } catch {}
      // 13) documents.json (reset index)
      try {
        fs.writeFileSync(path.join(dataDir, 'documents.json'), JSON.stringify({ meta: { lastUpdated: new Date().toISOString(), description: 'ZhiGui document index - first-layer retrieval' }, documents: [] }, null, 2));
      } catch {}
      return {
        success: true,
        message: 'All data cleared. Conversation history, goals, errands, notes, schedule, briefings, topics, reminders, library, decisions, and hierarchy files have been reset. User profile is preserved.',
        cleared,
      };
    }

    case 'lingxi_clear_briefings': {
      if (args.confirm !== true) {
        return { aborted: true, reason: 'Set confirm to true to execute the delete.' };
      }
      const st = readFullState();
      st.briefings = {};
      st.morningBriefing = null;
      writeState(st);
      return { success: true, message: 'All briefings cleared. They will be regenerated on the next auto_schedule call.' };
    }

    // ── Data Export / Import ──
    case 'lingxi_export_data': {
      try {
        const { exportData } = require('./export-import');
        const dataDir = CONFIG.dataDir;
        // Auto-generate output path if not provided
        const outputPath = args.outputPath || path.join(dataDir, `lingxi-export-${DateUtils.todayStr()}.json`);
        const result = exportData(dataDir, { outputPath });
        return {
          success: true,
          filePath: outputPath,
          exportedAt: result.meta.exportedAt,
          checksum: result.meta.checksum,
          stats: result.stats,
        };
      } catch (err) {
        return { error: `Export failed: ${err.message}` };
      }
    }

    case 'lingxi_import_data': {
      try {
        const { importData } = require('./export-import');
        const dataDir = CONFIG.dataDir;
        const filePath = args.filePath;
        const mode = args.mode || 'replace';

        // Read the import file
        if (!fs.existsSync(filePath)) {
          return { error: `Import file not found: ${filePath}` };
        }
        const importObj = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Execute import
        const result = importData(dataDir, importObj, { mode });
        return result;
      } catch (err) {
        return { error: `Import failed: ${err.message}` };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── MCP protocol layer ────────────────────────────────────────

const PROTOCOL_VERSION = '2024-11-05';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore unparseable lines
  }

  // Notification messages do not need a response
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'lingxi', version: '1.0.0' },
        },
      });
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: ACTIVE_TOOLS },
      });
      break;

    case 'tools/call': {
      const toolName = msg.params?.name;
      const toolArgs = msg.params?.arguments || {};
      const tool = ACTIVE_TOOLS.find(t => t.name === toolName);

      if (!tool) {
        sendError(msg.id, -32601, `Tool does not exist: ${toolName}`);
        break;
      }

      try {
        const result = await handleToolCall(toolName, toolArgs);
        sendResult(msg.id, result);
      } catch (err) {
        sendError(msg.id, -32603, `Tool execution error: ${err.message}`);
      }
      break;
    }

    case 'ping':
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      break;

    default:
      sendError(msg.id, -32601, `Unknown method: ${msg.method}`);
  }
});

// Startup prompt (output to stderr so it does not interfere with the stdio protocol)
process.stderr.write(`[ZhiGui MCP Server] Started\n`);
process.stderr.write(`  Data directory: ${CONFIG.dataDir}\n`);
process.stderr.write(`  State file: ${STATE_FILE}\n`);
process.stderr.write(`  Tool count: ${ACTIVE_TOOLS.length} (includes planning + errands + layered notes + values + user profile)\n`);
