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
const AttentionEngine = require('./attention-engine');
const ReflectionEngine = require('./reflection-engine');
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
const DOCUMENT_FILES = {
  goals: path.join(CONFIG.dataDir, 'goals.json'),
  schedule: path.join(CONFIG.dataDir, 'schedule.json'),
  errands: path.join(CONFIG.dataDir, 'errands.json'),
  notes: path.join(CONFIG.dataDir, 'notes.json'),
  decisions: path.join(CONFIG.dataDir, 'decisions.json'),
  reminders: path.join(CONFIG.dataDir, 'reminders.json'),
  userProfile: path.join(CONFIG.dataDir, 'userProfile.json'),
};
const INDEX_FILE = path.join(CONFIG.dataDir, 'documents.json');
const DOCUMENT_TITLES = {
  goals: 'Goals & Constraints',
  schedule: 'Schedule & Morning Briefing',
  errands: 'Errands',
  notes: 'Notes',
  decisions: 'Decisions',
  reminders: 'Reminders',
  userProfile: 'User Profile',
};

// ─── Document read/write tools (delegated to shared persistence layer mcp/storage.js) ──────
// All goes through Storage to ensure the AI process and the Electron panel share the same write path, timestamp reconciliation, and briefings key.

function readDocument(docType) {
  return Storage.readDocument(docType);
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

function writeState(state) {
  return Storage.writeState(state);
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return { conversations: [], meta: { totalConversations: 0, lastConversation: null } };
  }
}

function writeHistory(history) {
  history.meta = history.meta || {};
  // P1-1.8: Enforce FIFO cap to prevent unbounded growth (max 2000 conversations)
  const MAX_HISTORY = 2000;
  if (Array.isArray(history.conversations) && history.conversations.length > MAX_HISTORY) {
    history.conversations = history.conversations.slice(-MAX_HISTORY);
  }
  history.meta.totalConversations = (history.conversations || []).length;
  history.meta.lastConversation = (history.conversations || []).slice(-1)[0]?.timestamp || null;
  // P0-0.5: Use atomic write to prevent half-written JSON on crash
  Storage.writeJsonAtomic(HISTORY_FILE, history);
}

// Task 1.4: genId moved to engine/utils.js

// Chinese labels for value domains (used for matching repeated value signals)
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

// ─── Deadline field maintenance ──────────────────────────────────────
// This is data hygiene only: it refreshes deadline-derived fields.
/**
 * The engine does NOT decide what the person should do. It only refreshes
 * deadline-derived fields; focus order remains an explicit AI judgment.
 */
function refreshGoalDeadlineFields(state) {
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

  }

  return changes;
}

// ─── Information completeness check (follow-up logic) ──────────────────────────

// ── Generic planning engine (replaces the old exam-specific create_study_plan) ──
// Any "deadline + decomposable" goal goes through here: exams/certifications/theses/projects/fitness challenges, etc.
// Phases can be explicitly specified by the AI via args.phases (embodying intelligence); otherwise auto-split by cycle length.
// The plan records the user's confirmed structure; focus remains a contextual assistant judgment.
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

  // ── Second brain: topicId = reuse existing, topic = create new ──
  let topicId = null;
  try {
    const brain = getBrainIndex();
    if (args.topicId && brain._readIndex().topics[args.topicId]) {
      topicId = args.topicId;
    } else if (args.topic && typeof args.topic === 'string') {
      topicId = brain.ensureTopic(args.topic, { domain: args.domain || 'academic', category: args.category });
    }
  } catch {}

  state.strategicGoals = state.strategicGoals || [];
  state.currentGoals = state.currentGoals || [];
  state.constraints = state.constraints || [];
  // P0-0.2: Snapshot the original IDs present before we add new items, so we can
  // merge only our additions onto the latest state under lock at write time.
  const existingSgIds = new Set(state.strategicGoals.map(g => g.id));
  const existingCgIds = new Set(state.currentGoals.map(g => g.id));
  const existingCtIds = new Set(state.constraints.map(c => c.id));

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
    source: 'ai',
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
      source: 'ai',
      daysLeft: dl, overdue: dl < 0,
      relatedStrategicGoalId: sgId,
      lastRecalculated: now,
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
      state.constraints.push({ id: ctId, title: ct, description: ct, source: 'ai', createdAt: now, updatedAt: now });
      createdConstraints.push({ id: ctId, title: ct });
    }
  } else if (isExamFallback) {
    const c1 = genId('ct');
    state.constraints.push({ id: c1, title: 'No late nights', description: 'Sleep before 23:00, ensure adequate rest.', source: 'ai', createdAt: now, updatedAt: now });
    createdConstraints.push({ id: c1, title: 'No late nights' });
    const c2 = genId('ct');
    state.constraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort'), description: ('Ensure ' + dailyHours + ' hours of effective daily effort; prefers ' + preferredSlot + '.'), source: 'ai', createdAt: now, updatedAt: now });
    createdConstraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort') });
  } else if (dailyHours && dailyHours > 0) {
    const c2 = genId('ct');
    state.constraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort'), description: ('Ensure ' + dailyHours + ' hours of daily effort; prefers ' + preferredSlot + '.'), source: 'ai', createdAt: now, updatedAt: now });
    createdConstraints.push({ id: c2, title: ('Daily ' + dailyHours + ' hours of effort') });
  }

  // 4) Write back + prepare the schedule and briefing input data.
  // P0-0.2: Merge only our newly-created goals/constraints onto the latest state under
  // lock, to avoid clobbering concurrent writes by other processes (e.g. Dashboard).
  Storage.withLock('server', () => {
    const freshState = readFullState();
    freshState.strategicGoals = freshState.strategicGoals || [];
    freshState.currentGoals = freshState.currentGoals || [];
    freshState.constraints = freshState.constraints || [];
    for (const g of state.strategicGoals) {
      if (!existingSgIds.has(g.id)) freshState.strategicGoals.push(g);
    }
    for (const g of state.currentGoals) {
      if (!existingCgIds.has(g.id)) freshState.currentGoals.push(g);
    }
    for (const c of state.constraints) {
      if (!existingCtIds.has(c.id)) freshState.constraints.push(c);
    }
    writeState(freshState);
  });
  const scheduleResult = await handleToolCall('zhigui_auto_schedule', {
    startDate: todayStr(),
    days: daysTo + 1,
  });

  // 5) Do not invent a briefing here. The conversational AI must read the
  // resulting context and explicitly save its dated morning briefing.
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
      'What trade-off, constraint, or commitment should guide the next step for this task?',
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
  const _seenSignatures = new Set();
  const constraints = state.constraints || [];
  const goals = state.currentGoals || [];
  const add = (conflict) => {
    const sig = [conflict.type, conflict.date || '', conflict.firstId || '', conflict.secondId || '', conflict.constraintId || ''].join('|');
    if (_seenSignatures.has(sig)) return;
    _seenSignatures.add(sig);
    conflicts.push({ id: genId('conflict'), createdAt: new Date().toISOString(), ...conflict });
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
        description: `${Math.round(totalMinutes / 60 * 10) / 10} hours of timed actions are scheduled.`,
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

// Clock alarms cannot wake an MCP conversation by themselves.  This small,
// idempotent check is therefore run at the start of every bootstrap/overview
// read, so no due reminder is silently skipped merely because the assistant did
// not explicitly remember to call a separate tool.
function runDueReminderCheck(state, now = new Date()) {
  state.reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const fired = [];
  const additions = [];
  for (const reminder of state.reminders) {
    if (reminder.fired) continue;
    const triggerTime = new Date(reminder.triggerAt);
    if (Number.isNaN(triggerTime.getTime()) || now < triggerTime) continue;
    reminder.fired = true;
    reminder.firedAt = now.toISOString();
    fired.push({
      id: reminder.id, title: reminder.title, triggerAt: reminder.triggerAt,
      commitmentLevel: reminder.commitmentLevel || 'should', note: reminder.note || '',
      type: 'scheduled_reminder',
      message: `🔔 ${reminder.commitmentLevel === 'must' ? 'MUST' : 'Reminder'}: ${reminder.title}${reminder.note ? ` (${reminder.note})` : ''}`,
    });
    const interval = reminder.repeat === 'daily' ? 1 : reminder.repeat === 'weekly' ? 7 : 0;
    if (interval || reminder.repeat === 'monthly') {
      const next = new Date(triggerTime);
      // A long gap between conversations produces one surfaced reminder and
      // one future occurrence, never an unbounded backlog of stale alarms.
      do {
        if (reminder.repeat === 'monthly') {
          const originalDate = next.getDate();
          next.setMonth(next.getMonth() + 1);
          if (next.getDate() !== originalDate) {
            next.setDate(0);
          }
        }
        else next.setDate(next.getDate() + interval);
      } while (next <= now);
      additions.push({ ...reminder, id: genId('rm'), fired: false, firedAt: null, triggerAt: next.toISOString(), createdAt: now.toISOString() });
    }
  }
  if (additions.length) state.reminders.push(...additions);
  return { fired, changed: fired.length > 0 };
}

// A lightweight, idempotent daily check. It updates deadline-derived fields and
// current conflicts, but never overwrites a user lock or makes a focus decision.
// Focus remains an explicit, explainable assistant judgment.
function followUpDueDate(item) {
  if (item?.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) return item.dueDate;
  const raw = String(item?.dueAt || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : DateUtils.formatDate(parsed);
}

function runDailyCheck(state) {
  state.meta = state.meta || {};
  // P0-1: Use local timezone (Asia/Shanghai) instead of UTC to prevent
  // day-boundary triggering 8 hours early in UTC+8.
  const today = DateUtils.todayStr();
  // Skip if already checked today — compare using local date, not ISO slice.
  // lastDailyCheck stores an ISO timestamp; we convert it to local date
  // to avoid UTC+8 midnight mismatch.
  const lastCheckRaw = state.meta.lastDailyCheck || '';
  const lastCheckLocal = lastCheckRaw ? DateUtils.formatDate(new Date(lastCheckRaw)) : '';
  if (lastCheckLocal === today) {
    // Already checked today — return null so callers can distinguish
    // "no-op" from "ran and produced results". Returning the full state
    // object caused overview/bootstrap to embed the entire state as
    // dailyCheck, flooding the AI context with redundant data.
    return null;
  }
  const lastCheck = lastCheckLocal;
  const goalFieldUpdates = refreshGoalDeadlineFields(state);
  const conflicts = detectConflicts(state);
  // P0-3: Carry forward incomplete tasks from previous days automatically.
  // No source filter — all incomplete tasks (manual + AI) are carried over.
  const carryForwardResult = carryForwardIncompleteTasks(state, today);
  // P1-2: Roll forward recurring task previews to maintain N-day window.
  const rollForwardResult = rollForwardRecurringTasks(state, today);
  // Auto-trigger reflection on day boundary
  if (lastCheck && lastCheck !== today) {
    try {
      const reflection = ReflectionEngine.generateReflection(state, { lang: 'zh', date: lastCheck || today });
      state.lastReflection = {
        date: reflection.date,
        generatedAt: reflection.generatedAt,
        suggestions: reflection.suggestions,
        lifecycle: reflection.lifecycle,
        completedToday: { totalCount: reflection.completedToday.totalCount, summary: reflection.completedToday.summary },
        goalHealthNeedsAttention: (reflection.goalHealth.needsAttention || []).map(g => ({ id: g.id, title: g.title, type: g.type, healthSignals: g.healthSignals })),
        attentionShift: { pendingDecisionsCount: reflection.attentionShift.pendingDecisionsCount, unresolvedConflictsCount: reflection.attentionShift.unresolvedConflictsCount, staleNotesCount: reflection.attentionShift.staleNotesCount, summary: reflection.attentionShift.summary },
      };
    } catch (reflErr) {
      console.error('[ZhiGui] Reflection engine failed:', reflErr.message);
    }
  }
  state.meta.lastDailyCheck = new Date().toISOString();
  return {
    ranAt: state.meta.lastDailyCheck,
    goalFieldUpdates,
    conflicts: { total: conflicts.length, critical: conflicts.filter(item => item.severity === 'critical').length },
    carryForward: carryForwardResult,
    rollForward: rollForwardResult,
  };
}

// ── P0-3: Carry forward incomplete tasks from previous days to today.
//    Scans all past-date schedule days for incomplete tasks (no source filter),
//    copies them to today's schedule with carriedFrom marker, and removes
//    them from the original date to avoid duplicate display.
function carryForwardIncompleteTasks(state, todayStr) {
  state.schedule = state.schedule || {};
  state.schedule.days = state.schedule.days || {};

  // Ensure today's schedule exists
  if (!state.schedule.days[todayStr]) {
    state.schedule.days[todayStr] = { date: todayStr, weekday: Scheduler.WEEKDAYS[DateUtils.getWeekday(todayStr)], tasks: [] };
  }
  const todayTasks = state.schedule.days[todayStr].tasks || [];
  const carriedTasks = [];
  const missedTasks = [];
  const fixedDateCommitment = task => task?.carryPolicy === 'never'
    || task?.fixedDate === true
    || ['meeting', 'event', 'travel'].includes(task?.category)
    || (task?.pattern === 'one-time' && task?.dateLocked === true);

  for (const [dayDate, dayData] of Object.entries(state.schedule.days)) {
    // Only scan past dates
    if (dayDate >= todayStr) continue;
    if (!dayData.tasks) continue;

    const remainingTasks = [];
    for (const task of dayData.tasks) {
      // Recurring preview tasks are derived from their template and must not be
      // carried forward as if they were independent overdue commitments.
      if (!task.completed && !task.recurringTemplateId && !task.missedAt) {
        if (fixedDateCommitment(task)) {
          task.missedAt = new Date().toISOString();
          task.lifecycleState = 'missed';
          missedTasks.push({ id: task.id, title: task.title, date: dayDate });
          remainingTasks.push(task);
          continue;
        }
        // Move the original entity rather than creating a replacement ID.
        // Decisions, follow-ups and Topic links therefore remain valid.
        if (!todayTasks.some(existing => existing.id === task.id)) {
          task.date = todayStr;
          task.carriedFrom = task.carriedFrom || dayDate;
          task.carriedForwardAt = new Date().toISOString();
          task.completed = false;
          task.completedAt = null;
          task.completedBy = null;
          todayTasks.push(task);
          carriedTasks.push({ id: task.id, title: task.title, from: dayDate });
        }
      } else {
        // Keep completed tasks in original date for historical reference
        remainingTasks.push(task);
      }
    }
    // Replace the day's tasks with only completed ones (carried ones removed)
    dayData.tasks = remainingTasks;
  }

  state.schedule.days[todayStr].tasks = todayTasks;
  return { count: carriedTasks.length, tasks: carriedTasks, missedCount: missedTasks.length, missedTasks };
}

// ── P1-2: Roll forward recurring task previews to maintain N-day window.
//    For each active recurring errand, checks if the farthest preview date
//    is less than N days from today. If so, generates new preview entries
//    until the window is filled.
function rollForwardRecurringTasks(state, todayStr) {
  state.schedule = state.schedule || {};
  state.schedule.days = state.schedule.days || {};

  const PREVIEW_WINDOW_DAYS = 7;
  const rolledForward = [];

  // Find all active recurring errands
  const recurringErrands = (state.errands || []).filter(
    e => e.pattern === 'recurring' && !e.completed
  );

  for (const errand of recurringErrands) {
    const intervalDays = Math.max(1, Number(errand.recurrence?.intervalDays) || 7);

    // Find the farthest preview date for this recurring errand
    let farthestDate = todayStr;
    for (const [dayDate, dayData] of Object.entries(state.schedule.days)) {
      if (dayDate < todayStr) continue;
      if (!dayData.tasks) continue;
      const hasPreview = dayData.tasks.some(
        t => t.recurringTemplateId === errand.id
      );
      if (hasPreview && dayDate > farthestDate) {
        farthestDate = dayDate;
      }
    }

    // Check if we need to roll forward
    const daysAhead = DateUtils.daysBetween(farthestDate, todayStr);
    if (daysAhead >= PREVIEW_WINDOW_DAYS) continue;

    // Generate previews from the farthest date + interval until window is filled
    let nextDate = DateUtils.nextDay(farthestDate, intervalDays);
    while (DateUtils.daysBetween(nextDate, todayStr) < PREVIEW_WINDOW_DAYS) {
      if (!state.schedule.days[nextDate]) {
        state.schedule.days[nextDate] = {
          date: nextDate,
          weekday: Scheduler.WEEKDAYS[DateUtils.getWeekday(nextDate)],
          tasks: [],
        };
      }
      state.schedule.days[nextDate].tasks = state.schedule.days[nextDate].tasks || [];

      const previewTask = {
        id: genId('t'),
        date: nextDate,
        title: errand.title,
        source: 'recurring',
        recurringTemplateId: errand.id,
        completed: false,
        scheduled: true,
        time: errand.time || null,
        duration: errand.duration || 60,
        commitmentLevel: errand.commitmentLevel || 'should',
        category: errand.category || 'misc',
        note: errand.note || '',
      };
      state.schedule.days[nextDate].tasks.push(previewTask);
      rolledForward.push({ date: nextDate, title: errand.title, errandId: errand.id });
      nextDate = DateUtils.nextDay(nextDate, intervalDays);
    }
  }

  return { count: rolledForward.length, tasks: rolledForward };
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
  date, time, duration, title, type,
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
  // ── Topic Reorganization ──
  {
    name: 'zhigui_split_topic',
    description: 'Split a topic into smaller ones. CONVERSATION CONFIRMATION REQUIRED: first read the topic document (zhigui_get_topic_document), design the split, present the full plan to the user in conversation (which notes move where, which new topics are created), and only call this with userConfirmed=true AFTER the user explicitly approved. Executes immediately.',
    inputSchema: {
      type: 'object',
      required: ['sourceTopicId', 'noteMoves', 'newTopics', 'userConfirmed'],
      properties: {
        sourceTopicId: { type: 'string', description: 'The topic ID to split.' },
        noteMoves: { type: 'array', description: 'Notes to move: [{ noteId, targetTopicLabel }]. Notes not listed stay in the source topic.', items: { type: 'object', properties: { noteId: { type: 'string' }, targetTopicLabel: { type: 'string' } }, required: ['noteId', 'targetTopicLabel'] } },
        newTopics: { type: 'array', description: 'New topics to create: [{ label, category, domain? }].', items: { type: 'object', properties: { label: { type: 'string' }, category: { type: 'string' }, domain: { type: 'string' } }, required: ['label', 'category'] } },
        reason: { type: 'string', description: 'Why this split makes sense. Explain the thematic divergence.' },
        userConfirmed: { type: 'boolean', description: 'MUST be true, and may only be set to true after the user explicitly approved this exact split plan in the current conversation. Never assume consent.' },
      },
    },
  },
  {
    name: 'zhigui_merge_topics',
    description: 'Merge one or more related topics into a single topic. Source topics are deleted after the merge; their notes/goals/errands are relinked to the target. CONVERSATION CONFIRMATION REQUIRED: present the merge plan to the user in conversation and only call this with userConfirmed=true AFTER the user explicitly approved. Executes immediately.',
    inputSchema: {
      type: 'object',
      required: ['targetTopicId', 'userConfirmed'],
      properties: {
        sourceTopicId: { type: 'string', description: 'Legacy single source topic to absorb (will be deleted after merge). Prefer sourceTopicIds for multiple sources.' },
        sourceTopicIds: { type: 'array', description: 'Array of topic IDs to absorb into the target. All will be deleted after merge.', items: { type: 'string' } },
        targetTopicId: { type: 'string', description: 'The topic to absorb into (survives the merge).' },
        reason: { type: 'string', description: 'Why these topics should merge. Explain the thematic/project overlap.' },
        userConfirmed: { type: 'boolean', description: 'MUST be true, and may only be set to true after the user explicitly approved this exact merge in the current conversation. Never assume consent.' },
      },
    },
  },
  {
    name: 'zhigui_rename_topic',
    description: 'Rename a topic. CONVERSATION CONFIRMATION REQUIRED: tell the user the old and new label in conversation and only call this with userConfirmed=true AFTER the user explicitly approved. Executes immediately.',
    inputSchema: {
      type: 'object',
      required: ['topicId', 'newLabel', 'userConfirmed'],
      properties: {
        topicId: { type: 'string', description: 'The topic to rename.' },
        newLabel: { type: 'string', description: 'The new label.' },
        reason: { type: 'string', description: 'Why the current label no longer fits. Describe the evolution.' },
        userConfirmed: { type: 'boolean', description: 'MUST be true, and may only be set to true after the user explicitly approved this rename in the current conversation. Never assume consent.' },
      },
    },
  },
  {
    name: 'zhigui_precipitate_topic',
    description: 'Extract a topic\'s notes from notes.json into a standalone topics/<id>.json file (faster retrieval, fewer tokens). CONVERSATION CONFIRMATION REQUIRED: explain the rationale to the user in conversation and only call this with userConfirmed=true AFTER the user explicitly approved. Executes immediately. There is no automatic threshold; the AI decides based on the topic\'s size and coherence.',
    inputSchema: {
      type: 'object',
      required: ['topicId', 'userConfirmed'],
      properties: {
        topicId: { type: 'string', description: 'The topic whose notes should be extracted into a standalone file.' },
        reason: { type: 'string', description: 'Why this topic deserves its own file. Describe size or coherence rationale.' },
        userConfirmed: { type: 'boolean', description: 'MUST be true, and may only be set to true after the user explicitly approved in the current conversation. Never assume consent.' },
      },
    },
  },

  // ── Goal Management ──
  {
    name: 'zhigui_add_goal',
    description: 'Add a strategic goal / current goal / constraint. This tool checks whether information is sufficient — if not, it returns needsClarification=true and a list of follow-up questions; you must ask the user, never assume. Returns success=true only when information is sufficient. Set force=true to skip the check (use only when the user has explicitly provided enough info).',
    inputSchema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        type: { type: 'string', enum: ['strategicGoal', 'currentGoal', 'constraint'] },
        title: { type: 'string', description: 'Goal/constraint title' },
        description: { type: 'string', description: 'Detailed description (strategic goals must provide: specific direction, target field or institution, current foundation, etc.)' },
        deadline: { type: 'string', description: 'YYYY-MM-DD deadline (currentGoal only, optional; omit if no fixed deadline)' },
        detail: { type: 'string', description: 'Supplementary detail (currentGoal only, required: what exactly to do, what the deliverable is)' },
        subTasks: { type: 'array', items: { type: 'string' }, description: 'Sub-task list (strategicGoal only)' },
        force: { type: 'boolean', description: 'Skip information-completeness check. Use only when the user has explicitly provided enough info via conversation. Default false.' },
        domain: { type: 'string', description: 'AI-determined free-form life-domain label. NOT limited to a fixed list - create a new label or reuse an existing one so value-system weighting can match it. No keyword matching.' },
        topicId: { type: 'string', description: 'ID of an existing topic to reuse (from bootstrap topicIndex). Pass this instead of topic when the subject fits an existing topic.' },
        topic: { type: 'string', description: 'Topic label for a NEW topic. Only pass when no existing topic fits — check bootstrap topicIndex first. The engine creates a new topic from this label.' },
        category: { type: 'string', description: 'AI-determined free-form high-level category for Topic Library grouping - invent a new one or reuse an existing label; no fixed list.' },
        isOneShot: { type: 'boolean', description: 'AI-judged: is this a one-shot event goal (a single occurrence rather than an ongoing effort)? true = only appears as a lightweight reminder within 3 days of deadline, not a daily heavy block. The AI should set this based on the nature of the goal, not keyword matching.' },
        relatedStrategicGoalId: { type: 'string', description: 'AI-judged: if this current goal belongs to a strategic goal, pass the strategic goal ID so planning can retain the relationship (no keyword matching).' },
        noteIds: { type: 'array', items: { type: 'string' }, description: 'Note IDs this goal is built on ("this goal came from these notes"). Linked notes are shown under the goal card on the dashboard, like schedule tasks. Unknown ids are dropped; deleting a note auto-detaches it from the goal.' },
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
        why: { type: 'string', description: 'Why this goal matters (motivation, personal meaning)' },
        obstacle: { type: 'string', description: 'Current obstacle blocking progress' },
        risk: { type: 'string', description: 'Key risk that could prevent achievement' },
        statusSignal: { type: 'string', enum: ['actionable', 'needs_confirmation', 'blocked', 'at_risk', 'on_track'], description: 'Explainable current status signal. Never use a numeric score.' },
        statusReason: { type: 'string', description: 'Short evidence-based reason for the status signal. Required whenever statusSignal is set.' },
        successCriteria: { type: 'string', description: 'How success will be measured' },
        nextStep: { type: 'string', description: 'The immediate next step to take' },
      },
    },
  },
  {
    name: 'zhigui_update_goal',
    description: 'Update goal/constraint attributes: title, description, deadline, detail, completion state and decision-relevant context.',
    inputSchema: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: { type: 'string', description: 'Goal ID (sg_xxx / cg_xxx / ct_xxx)' },
        type: { type: 'string', enum: ['strategicGoal', 'currentGoal', 'constraint'] },
        title: { type: 'string' },
        description: { type: 'string' },
        deadline: { type: 'string', description: 'YYYY-MM-DD (currentGoal only, optional)' },
        detail: { type: 'string' },
        completed: { type: 'boolean', description: 'Mark as completed (currentGoal only)' },
        subTasks: { type: 'array', items: { type: 'string' } },
        why: { type: 'string', description: 'Update motivation' },
        obstacle: { type: 'string', description: 'Update or clear obstacle' },
        risk: { type: 'string', description: 'Update or clear risk' },
        statusSignal: { type: 'string', enum: ['actionable', 'needs_confirmation', 'blocked', 'at_risk', 'on_track'], description: 'Update the explainable status signal; never use a numeric score.' },
        statusReason: { type: 'string', description: 'Update or clear the evidence-based status reason.' },
        successCriteria: { type: 'string', description: 'Update success criteria' },
        nextStep: { type: 'string', description: 'Update next step' },
        noteIds: { type: 'array', items: { type: 'string' }, description: 'Replace the full set of linked note IDs (pass every link you want to keep). Unknown ids are dropped.' },
      },
    },
  },
  {
    name: 'zhigui_delete_goal',
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
    name: 'zhigui_add_task',
    description: 'Add one confirmed calendar commitment. Attach only the goal, notes and decisions needed to execute it. If time is unknown, use zhigui_add_errand without time so it stays in the unscheduled queue.',
    inputSchema: {
      type: 'object',
      required: ['date', 'time', 'title'],
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM start time' },
        duration: { type: 'number', description: 'Duration in minutes' },
        title: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string', enum: ['study', 'meeting', 'exercise', 'travel', 'event'] },
        resource: { type: 'string', description: 'Associated learning resource' },
        relatedGoalId: { type: 'string' },
        relatedStrategicGoalId: { type: 'string' },
        topicId: { type: 'string', description: 'Topic ID to link this task to (from bootstrap topicIndex[].id)' },
        noteIds: { type: 'array', items: { type: 'string' } },
        decisionIds: { type: 'array', items: { type: 'string' } },
        contextRefs: { type: 'array', items: { type: 'object' } },
        contextReason: { type: 'string' },
        pattern: { type: 'string', enum: ['one-time', 'recurring', 'continuing'] },
        carryPolicy: { type: 'string', enum: ['auto', 'never'], description: 'auto moves unfinished work to the next day; never preserves a missed fixed-date commitment on its original date. Meetings, travel and events default to never.' },
        fixedDate: { type: 'boolean', description: 'True when the commitment must stay on this calendar date even if missed.' },
        preparationLeadDays: { type: 'number', description: 'How many days before this commitment the assistant should begin considering preparation, rest, travel or materials.' },
      },
    },
  },
  {
    name: 'zhigui_update_task',
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
        completed: { type: 'boolean' },
        completionImpact: { type: 'object', description: 'When completion changes durable context, atomically provide {goalPatches, notePatches, decisionPatches, decisionCreates, followUp}. Use only evidence-supported patches. This is the conversation equivalent of panel activity reconciliation.' },
        category: { type: 'string' },
        resource: { type: 'string' },
        relatedGoalId: { type: 'string' }, relatedStrategicGoalId: { type: 'string' }, topicId: { type: 'string' },
        noteIds: { type: 'array', items: { type: 'string' } }, decisionIds: { type: 'array', items: { type: 'string' } }, contextRefs: { type: 'array', items: { type: 'object' } }, contextReason: { type: 'string' },
      },
    },
  },
  {
    name: 'zhigui_delete_task',
    description: 'Delete a task only after a deletion preview has been shown and the user explicitly confirms. The preview reports linked decisions and follow-ups that will be detached.',
    inputSchema: {
      type: 'object',
      required: ['date', 'taskId'],
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        taskId: { type: 'string' },
        confirm: { type: 'boolean', description: 'false (or omitted) returns the impact preview; true executes only after the user confirms that preview.' },
      },
    },
  },

  // ── Logic Computation ──

  // ── Briefing & History ──
  {
    name: 'zhigui_set_briefing',
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

  // ── Panel Control ──

  // ── Intelligence Layer ──
  {
    name: 'zhigui_update_user_profile',
    description: 'Update the user profile. Call this tool in real time when new user traits are discovered in conversation (preferences, tone, tool tendencies, communication style, etc.). Supports incremental updates — pass only the fields to modify; others remain unchanged. Should be called once at the end of each conversation to record new user traits found during this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        personality: { type: 'string', description: 'User personality traits.' },
        communicationStyle: { type: 'string', description: 'Communication preference.' },
        preferredTools: { type: 'array', items: { type: 'string' }, description: 'Preferred tools/software' },
        workHabit: { type: 'string', description: 'Work habit free-text.' },
        chronotype: { type: 'string', enum: ['night_owl', 'early_bird', 'standard'], description: 'AI-judged chronotype for schedule slot allocation. night_owl = prime slots in afternoon/evening; early_bird = prime slots in morning; standard = balanced. The AI judges this from the user\'s workHabit description, NOT keyword matching.' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Hobbies and interests' },
        tonePreference: { type: 'string', description: 'Tone preference.' },
        responseDetail: { type: 'string', description: 'Response detail preference.' },
        languageStyle: { type: 'string', description: 'Language style preference.' },
        notes: { type: 'string', description: 'Other notes' },
        conversationCount: { type: 'number', description: 'Conversation count (auto-maintained by the system, no need to set manually)' },
        // Identity Layer fields
        longTermDirection: { type: 'string', description: 'Long-term life direction or aspiration.' },
        corePrinciples: {
          type: 'array',
          items: { type: 'string' },
          description: 'Core life principles or values.'
        },
        lifeStage: { type: 'string', description: 'Current life stage.' },
      },
    },
  },
  {
    name: 'zhigui_auto_schedule',
    description: 'Generate a proposed schedule only after the user explicitly asks for planning or accepts a proposed plan. It may read relevant goals, constraints and selected context, then detects conflicts and preserves manual times. Do not call it after a simple note, errand, or meeting statement; do not use it to fill a day with inferred routines.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD plan start date, defaults to today' },
        days: { type: 'number', description: 'How many days of plan to generate. Omit to auto-compute up to the farthest deadline (max 180 days)' },
        focusGoalIds: { type: 'array', items: { type: 'string' }, description: 'Ordered current-goal IDs chosen by the assistant after reading their relevant context. Required when more than one active goal is eligible; this engine only places the selected actions in time.' },
        selectionReason: { type: 'string', description: 'Brief human-readable reason for the selected order and trade-offs.' },
      },
    },
  },
  {
    name: 'zhigui_create_plan',
    description: '[General planning] One-click generation of a structured plan for any "deadline + decomposable" complex goal: strategic goal, confirmed phases, constraints, and a schedule proposal. The assistant makes focus choices from context, values, commitments, and available time; the scheduler only allocates the chosen plan.',
    inputSchema: {
      type: 'object',
      required: ['title', 'deadline'],
      properties: {
        title: { type: 'string', description: 'Strategic goal title — any deadline-bound complex outcome the user wants to achieve' },
        deadline: { type: 'string', description: 'YYYY-MM-DD deadline' },
        components: { type: 'array', items: { type: 'string' }, description: 'Goal components / subjects / milestones to decompose the goal into' },
        description: { type: 'string', description: 'Supplementary description of the goal (optional)' },
        dailyHours: { type: 'number', description: 'Hours available per day (optional, default 3)' },
        preferredTimeSlot: { type: 'string', description: 'Preferred time slot: morning/afternoon/evening/all-day (optional)' },
        phases: { type: 'array', description: 'A phased plan designed by the AI in conversation for a deadline-bound complex goal (embodies intelligence). Each phase contains name/deadline/detail/focus. Recommended to present this plan as a proposal for user confirmation during the follow-up phase before passing it in; if omitted, the system auto-splits into early/mid/late by cycle length.', items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Phase name — a label meaningful to the user for this stage.' },
            deadline: { type: 'string', description: 'Phase deadline YYYY-MM-DD (must be strictly earlier than the next phase and no later than the overall deadline)' },
            detail: { type: 'string', description: 'Specific task description for this phase (what to achieve)' },
            focus: { type: 'array', items: { type: 'string' }, description: 'Components/subjects to focus on in this phase.' },
          },
        } },
        constraints: { type: 'array', description: 'Custom constraint title list (optional)', items: { type: 'string' } },
        notes: { type: 'string', description: 'Other notes (optional)' },
        examType: { type: 'string', description: '[Legacy compat] Exam type, equivalent to a title prefix; when examType is passed without title, it is auto-used as the title' },
        examDate: { type: 'string', description: '[Legacy compat] Equivalent to deadline' },
        subjects: { type: 'array', items: { type: 'string' }, description: '[Legacy compat] Equivalent to components' },
        domain: { type: 'string', description: 'AI-determined free-form life-domain label for this plan (create new or reuse existing; not limited to a fixed list). Default "academic".' },
        topicId: { type: 'string', description: 'ID of an existing topic to reuse (from bootstrap topicIndex). Pass this instead of topic when the subject fits an existing topic. All phase goals and the strategic goal will be linked to this topic.' },
        topic: { type: 'string', description: 'Topic label for a NEW topic. Only pass when no existing topic fits — check bootstrap topicIndex first. All phase goals and the strategic goal will be linked to this topic.' },
        category: { type: 'string', description: 'AI-determined free-form high-level category for Topic Library grouping - invent a new one or reuse an existing label; no fixed list.' },
      },
    },
  },

  // ── Errand System ──
  {
    name: 'zhigui_add_errand',
    description: 'Add an operational action. If date is present but time is omitted, this is a date-fixed, time-pending calendar commitment: it appears on that date in the dashboard, not in the unscheduled queue. Omit date only when no day has been decided. Set commitmentLevel only for a genuine commitment (must / should / nice), never as a numeric rank. IMPORTANT: if the errand relates to existing notes (same topic) or a goal, you MUST fill noteIds and goalId so the user can see related context on the dashboard.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Errand title — the concrete action to perform' },
        date: { type: 'string', description: 'YYYY-MM-DD date, optional. Omit when the action has no scheduled day yet.' },
        time: { type: 'string', description: 'HH:MM start time, optional. If date is set and time is omitted, the action is a date-fixed time-pending calendar commitment.' },
        duration: { type: 'number', description: 'Duration in minutes, default 60' },
        category: { type: 'string', description: 'AI-determined free-form domain label (not limited to a fixed list).' },
        commitmentLevel: { type: 'string', enum: ['must', 'should', 'nice'], description: 'must=confirmed must-do, should=planned, nice=optional. Default should.' },
        retention: { type: 'string', enum: ['transient', 'review', 'memory'], description: 'AI lifecycle judgment. transient (default): operational only and erase on completion; review: keep as a completed action for later review; memory: reserve for a durable outcome that AI will summarize separately as a note.' },
        note: { type: 'string', description: 'Associated note info (free text)' },
        timeCost: { type: 'number', description: 'AI-judged: estimated TOTAL hours this errand will consume, including transit, prep, waiting, and recovery.' },
        requiresPresence: { type: 'boolean', description: 'AI-judged: does this errand require the user to be physically present at a location?' },
        blocksFocus: { type: 'boolean', description: 'AI-judged: will this errand prevent the user from focusing on other work for the rest of the day?' },
        preparationLeadDays: { type: 'number', description: 'Days before this dated commitment when preparation should start influencing planning. Use 0 when no advance preparation is needed.' },
        pattern: { type: 'string', enum: ['one-time', 'recurring'], description: 'one-time: project/meeting/task that completes and should not repeat. recurring: daily habit like exercise/meditation that repeats. Default one-time.' },
        noteIds: { type: 'array', items: { type: 'string' }, description: 'IDs of related notes (from bootstrap noteIndex[].id or zhigui_search). User will see these note titles on the dashboard. Fill if the errand has relevant context notes.' },
        decisionIds: { type: 'array', items: { type: 'string' }, description: 'Decision IDs that constrain or explain this action.' },
        topicId: { type: 'string', description: 'Topic ID to link this errand to (from bootstrap topicIndex[].id)' },
        goalId: { type: 'string', description: 'Goal ID this errand relates to (from bootstrap currentGoals[].id or zhigui_get_goal_detail)' },
        contextRefs: { type: 'array', items: { type: 'object' }, description: 'Explicit note/decision references with role: instruction, reference, constraint, decision_basis, or result.' },
        contextReason: { type: 'string', description: 'Why these links are needed to carry out the action.' },
        recurrence: { type: 'object', properties: { intervalDays: { type: 'number', description: 'For recurring actions, days until the next occurrence.' } } },
      },
    },
  },
  {
    name: 'zhigui_complete_errand',
    description: 'Mark an errand as completed. The errand is moved to completedActions log (no longer in active errands). When completion changes durable context, include completionImpact so goal/note/decision/follow-up effects are committed atomically.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Errand ID' },
        outcome: { type: 'string', enum: ['done', 'skipped', 'cancelled'], description: 'How the errand was resolved. Default done.' },
        summary: { type: 'string', description: 'Brief summary of what was accomplished or learned during this errand.' },
        completionImpact: { type: 'object', description: 'Optional {goalPatches, notePatches, decisionPatches, decisionCreates, followUp}. Use for evidence-supported longer-term effects of this completion.' },
      },
    },
  },
  {
    name: 'zhigui_get_reflection',
    description: '[Reflection Engine] Generate a structured daily reflection — analyze completed actions, goal health, attention shifts, and produce actionable suggestions. Call at end of day or when the user asks for a review. Returns: completedToday (what was done), goalHealth (which goals need attention), attentionShift (decision/conflict/stale trends), and suggestions (prioritized AI-actionable items). This is a pure computation layer; AI decides whether to act on suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD date to reflect on (default: today)' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Language for summaries' },
      },
    },
  },
  {
      name: 'zhigui_add_decision',
      description: 'Record a significant, evolving user decision. Link the exact goals, notes, actions and topics it governs so later planning can retrieve it without scanning every decision. Do not use for routine task completion. A conversation-originated decision is already interpreted; a panel fact is reconciled later with zhigui_reconcile_activity.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Decision title' },
          description: { type: 'string', description: 'Why this decision was made' },
          evidence: { type: 'string', description: 'What evidence or reasoning supports this decision' },
          impact: { type: 'string', description: 'What will change because of this decision' },
          relatedGoalIds: { type: 'array', items: { type: 'string' }, description: 'Goal IDs affected by this decision' },
          relatedNoteIds: { type: 'array', items: { type: 'string' }, description: 'Note IDs referenced by this decision' },
          relatedActionIds: { type: 'array', items: { type: 'string' }, description: 'Exact task, errand or completed-action IDs governed by this decision.' },
          topicIds: { type: 'array', items: { type: 'string' }, description: 'Topic IDs for direct retrieval and relationship-graph links.' },
          status: { type: 'string', enum: ['accepted', 'rejected', 'pending', 'revised', 'reversed', 'expired', 'resolved'], description: 'Decision status (default: accepted).' },
          expiresAt: { type: 'string', description: 'Optional ISO date when this decision expires and needs review' },
          reviewDueAt: { type: 'string', description: 'Optional date to revisit the decision before it expires.' },
          supersedesId: { type: 'string', description: 'Older decision replaced by this new one. The older decision is marked revised.' },
          updateReason: { type: 'string', description: 'Why this decision is being created or changed.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'zhigui_get_decisions',
      description: 'Get decision records. Use before making a recommendation to check if a similar decision was already made. Supports filtering by status and relevance.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Load one full decision detail. Omit for a compact index.' },
          status: { type: 'string', enum: ['accepted', 'rejected', 'pending', 'revised', 'reversed', 'expired', 'resolved'], description: 'Filter by status' },
          goalId: { type: 'string', description: 'Filter by related goal ID' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'zhigui_update_decision',
      description: 'Update a decision when conversation evidence, a panel activity, or time changes it. Preserve the prior record: use supersedesId/replacedById and a status such as revised, reversed, expired or resolved instead of deleting it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Decision ID to update' },
          title: { type: 'string' }, description: { type: 'string' }, evidence: { type: 'string' }, impact: { type: 'string' },
          status: { type: 'string', enum: ['accepted', 'rejected', 'pending', 'revised', 'reversed', 'expired', 'resolved'], description: 'New status' },
          reversedBy: { type: 'string', description: 'If reversing, the ID of the new decision that reverses this one' },
          replacedById: { type: 'string', description: 'New decision ID that replaces this record.' },
          supersedesId: { type: 'string', description: 'Older decision replaced by this record.' },
          expiresAt: { type: 'string', description: 'New expiration date' }, reviewDueAt: { type: 'string' },
          outcome: { type: 'string', description: 'Outcome observed after the decision was made' },
          updateReason: { type: 'string', description: 'Evidence-based reason for this update.' },
          relatedGoalIds: { type: 'array', items: { type: 'string' } }, relatedNoteIds: { type: 'array', items: { type: 'string' } },
          relatedActionIds: { type: 'array', items: { type: 'string' } }, topicIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
    },
    {
      name: 'zhigui_delete_decision',
      description: 'Delete a decision record only when it was recorded in error. Otherwise update it to resolved, revised, reversed or expired. First return the impact preview, then execute only after explicit user confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Decision ID to delete' },
          confirm: { type: 'boolean', description: 'false (or omitted) returns the impact preview; true executes after explicit user confirmation.' },
        },
        required: ['id'],
      },
    },
  {
    name: 'zhigui_update_errand',
    description: 'Update an existing errand in place (reschedule, rename, change duration or commitment level) while preserving its ID, activity history and context links. ALWAYS prefer this over delete-and-recreate when the user changes an errand ("move the hospital visit to Friday", "make paying the bill a must"). Only pass the fields being changed.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Errand ID (e_xxx / errand_xxx)' },
        title: { type: 'string', description: 'New title (only if the user renamed it)' },
        date: { type: 'string', description: 'New date YYYY-MM-DD. Pass empty string to clear the date.' },
        time: { type: 'string', description: 'New time HH:MM' },
        duration: { type: 'number', description: 'New duration in minutes' },
        commitmentLevel: { type: 'string', enum: ['must', 'should', 'nice'], description: 'New commitment level. must-level errands preempt all development goals.' },
        retention: { type: 'string', description: 'Retention level for completion history' },
        relatedGoalId: { type: 'string', description: 'Re-link to a goal ID, or null to unlink' },
        noteIds: { type: 'array', items: { type: 'string' }, description: 'Replace linked note IDs (execution context)' },
        contextReason: { type: 'string', description: 'Why this errand relates to the linked context' },
      },
    },
  },
  {
    name: 'zhigui_delete_errand',
    description: 'Delete an action only after a deletion preview has been shown and the user explicitly confirms.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Errand ID (e_xxx)' },
        confirm: { type: 'boolean', description: 'false (or omitted) returns the impact preview; true executes after explicit user confirmation.' },
      },
    },
  },

  // ── Notes System ──
  {
    name: 'zhigui_add_note',
    description: 'Add one or more AI-organized notes. For a single note, pass title, content, topic, category. For batch import (e.g. user pastes multiple notes or a document), pass "notes" array — each item needs title, content, topic, category. When processing a batch: (1) read ALL notes before classifying, so you can detect contradictions and group related notes; (2) decide whether each note joins an existing topic or warrants a new one; (3) if you detect contradictions between notes (e.g. the user changed their mind), flag them in the "conflicts" field so the user sees them; (4) set "signal" when a note indicates health or emotional state changes. The AI writes the title and decides topic/category — the engine never derives these from keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'AI-written summary title (single note mode). Concise and meaningfully different from the full body.' },
        content: { type: 'string', description: 'Note body text (single note mode).' },
        topicId: { type: 'string', description: 'ID of an existing topic to reuse (from bootstrap topicIndex). Pass this instead of topic when the subject fits an existing topic.' },
        topic: { type: 'string', description: 'Topic label for a NEW topic. Only pass when no existing topic fits — check bootstrap topicIndex first.' },
        domain: { type: 'string', description: 'OPTIONAL free-form soft tag (AI own label - not limited to a fixed list). It is a display hint inherited by the topic. Prefer classifying by topic/category instead.' },
        relatedDate: { type: 'string', description: 'Associated date YYYY-MM-DD (if a reminder to handle on a certain day is needed)' },
        source: { type: 'string', description: 'Information source: extracted from conversation / user-initiated / batch-import / other. Default "extracted from conversation"' },
        category: { type: 'string', description: 'AI-determined free-form high-level category. Invent a new one or reuse an existing label; topics sharing a category are grouped in the Topic Library. No fixed list.' },
        signal: { type: 'string', enum: ['health_negative', 'emotional_stress', 'positive', 'neutral'], description: 'AI-judged emotional/health signal. health_negative (schedule -40%), emotional_stress (-20%), positive (+15%), neutral (normal).' },
        notes: { type: 'array', description: 'Batch mode: array of note objects. Each item: { title, content, topicId?, topic, category, domain?, signal?, conflicts? }. Use this when the user provides multiple notes at once (pasted text, document content, etc.). Process all notes holistically — detect cross-note contradictions and decide topic grouping before calling.', items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, topicId: { type: 'string' }, topic: { type: 'string' }, category: { type: 'string' }, domain: { type: 'string' }, signal: { type: 'string' }, conflicts: { type: 'array', items: { type: 'string' } } }, required: ['title', 'content', 'topic', 'category'] } },
        conflicts: { type: 'array', description: 'Cross-note contradictions detected during batch processing (e.g. two notes disagree on a fact or plan). Shown to user for awareness.', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'zhigui_enrich_note',
    description: 'Organize one pending dashboard or imported note: set its AI-written title, topic and category directly. First load its body with zhigui_get_note_detail(id). This only changes organization metadata (title/topic/category/domain/signal) — the note body is never touched. Applies immediately; tell the user what organization you chose. For body text changes use zhigui_update_note (which requires explicit user confirmation).',
    inputSchema: {
      type: 'object',
      required: ['id', 'title', 'category'],
      properties: {
        id: { type: 'string', description: 'Pending note ID from the overview note index' },
        title: { type: 'string', description: 'AI-written concise summary title' },
        topicId: { type: 'string', description: 'ID of an existing topic to reuse (from bootstrap topicIndex). Pass this instead of topic when the subject fits an existing topic.' },
        topic: { type: 'string', description: 'Topic label for a NEW topic. Only pass when no existing topic fits — check bootstrap topicIndex first. Either topicId or topic is required.' },
        category: { type: 'string', description: 'AI-determined high-level category' },
        domain: { type: 'string', description: 'Optional free-form soft domain tag (AI own label, not limited to a fixed list)' },
        signal: { type: 'string', enum: ['health_negative', 'emotional_stress', 'positive', 'neutral'], description: 'Optional AI-judged signal' },
        reason: { type: 'string', description: 'Brief explanation of why this organization fits the note.' },
        conflicts: { type: 'array', items: { type: 'string' }, description: 'Potential conflicts or ambiguities the user should consider before confirming.' },
      },
    },
  },
  {
    name: 'zhigui_update_note',
    description: 'Directly rewrite the body content of an existing note. STRICT CONFIRMATION PROTOCOL — the user is the source of truth for their own notes: (1) NEVER call this on your own initiative; (2) first show the user the exact proposed new content in conversation; (3) only call this with userConfirmed=true AFTER the user explicitly approved the edit in this conversation. Calling without userConfirmed=true is rejected by the engine. For reclassification (title/topic/category) use zhigui_enrich_note instead — this tool only changes the body text.',
    inputSchema: {
      type: 'object',
      required: ['id', 'content', 'userConfirmed'],
      properties: {
        id: { type: 'string', description: 'Note ID (note_xxx)' },
        content: { type: 'string', description: 'The complete new note body (full replacement, not a diff). Must be the exact text the user approved.' },
        userConfirmed: { type: 'boolean', description: 'MUST be true, and may only be set to true after the user explicitly approved this exact edit in the current conversation. Never assume consent.' },
      },
    },
  },
  {
    name: 'zhigui_delete_note',
    description: 'Delete a note only after a preview reports its references in actions, completion history, decisions and follow-ups, and the user explicitly confirms.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Note ID (note_xxx)' },
        confirm: { type: 'boolean', description: 'false (or omitted) returns the impact preview; true executes after explicit user confirmation.' },
      },
    },
  },

  // ── Event Stream System (v3.0 core) ──
  {
    name: 'zhigui_add_reminder',
    description: 'Add a scheduled time-point reminder. Unlike goal deadlines (which are checked during morning briefing), this is a precise time trigger — e.g. "remind me to submit the report at 5pm this Friday". The AI should create a reminder when the user mentions a specific time-bound obligation. Reminders are checked on every conversation via bootstrap runDailyCheck and surface in the morning briefing.',
    inputSchema: {
      type: 'object',
      required: ['title', 'triggerAt'],
      properties: {
        title: { type: 'string', description: 'Reminder title — the action or obligation to be reminded about' },
        triggerAt: { type: 'string', description: 'ISO 8601 datetime string when the reminder should fire, e.g. "2026-07-25T17:00:00+08:00". The AI should convert user-relative time ("Friday 5pm") to absolute ISO datetime using the current date.' },
        category: { type: 'string', description: 'AI-determined free-form category label (create new or reuse existing; not limited to a fixed list). Default misc.' },
        commitmentLevel: { type: 'string', enum: ['must', 'should', 'nice'], description: 'must=confirmed must-do, should=planned, nice=gentle nudge. Default should.' },
        note: { type: 'string', description: 'Additional context for the reminder' },
        relatedGoalId: { type: 'string', description: 'Optional: link to a goal ID if this reminder is for a goal milestone' },
        relatedErrandId: { type: 'string', description: 'Optional: link to an errand ID if this reminder is for an errand' },
        repeat: { type: 'string', description: 'Optional repeat rule: "daily", "weekly", "monthly", or null. Default null (one-time).' },
      },
    },
  },
  {
    name: 'zhigui_update_reminder',
    description: 'Update an existing reminder in place (change time, title, repeat rule or commitment level) while preserving its ID and links. ALWAYS prefer this over delete-and-recreate when the user reschedules ("move the 5pm reminder to 6pm", "make it repeat weekly"). Rescheduling a fired one-time reminder to a future time re-arms it. Only pass the fields being changed.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Reminder ID (rm_xxx)' },
        title: { type: 'string', description: 'New reminder title' },
        triggerAt: { type: 'string', description: 'New ISO 8601 trigger datetime, e.g. "2026-07-31T18:00:00+08:00". Convert user-relative time to absolute using the current date.' },
        category: { type: 'string', description: 'New free-form category label' },
        commitmentLevel: { type: 'string', enum: ['must', 'should', 'nice'], description: 'New commitment level' },
        note: { type: 'string', description: 'New additional context text' },
        repeat: { type: 'string', description: 'New repeat rule: "daily", "weekly", "monthly", or null for one-time' },
        relatedGoalId: { type: 'string', description: 'Re-link to a goal ID, or null to unlink' },
        relatedErrandId: { type: 'string', description: 'Re-link to an errand ID, or null to unlink' },
      },
    },
  },
  {
    name: 'zhigui_delete_reminder',
    description: 'Delete a scheduled reminder only after showing the user the preview and receiving explicit confirmation.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Reminder ID (rm_xxx)' },
        confirm: { type: 'boolean', description: 'false (or omitted) returns the impact preview; true executes after explicit user confirmation.' },
      },
    },
  },

  // ── Value System ──
  {
    name: 'zhigui_update_value_system',
    description: 'Update the user value system only from an explicit user trade-off or a user-confirmed interpretation. Casual wording may justify a clarification question, never a silent value rewrite.',
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
                description: 'AI-determined free-form value domain label (invent a new one or reuse an existing label - NOT limited to a fixed list). Reuse an existing label when one fits so weights stay comparable.',
              },
              weight: { type: 'number', description: '0-100 weight value. Higher = more important to the user.' },
              note: { type: 'string', description: 'Weight explanation — cite what the user said or observed.' },
              confidence: { type: 'number', description: '0-1 confidence level. Repeated supporting signals increase confidence. Default 0.5 for a single observation.' },
            },
          },
        },
        decisionStyle: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'], description: 'Decision style: conservative (prioritize must-do items), balanced, aggressive (prioritize development goals)' },
        learnedFrom: { type: 'string', description: 'Source explanation for this update — cite the conversation evidence and the resulting weight changes (e.g. date, user quote or observation, domains/weights adjusted, confidence level)' },
        inferredFrom: { type: 'string', description: 'Only after the user explicitly confirms the interpretation; record the original wording for traceability.' },
        evidenceType: { type: 'string', enum: ['explicit', 'confirmed_interpretation'], description: 'Required for changes to priorities or decisionStyle. explicit = user stated the trade-off; confirmed_interpretation = assistant asked and user confirmed.' },
      },
    },
  },

  // ── Document Index ──
  {
    name: 'zhigui_get_assistant_bootstrap',
    description: 'MANDATORY first read for every substantive conversation. Returns a compact continuity packet: UI-safe identity digest, hard constraints, today\'s commitments, recent panel/MCP changes, active decisions, follow-up signals and top attention signals. Do not load all notes or goals before this packet tells you what is relevant.',
    inputSchema: { type: 'object', properties: {
      sinceVersion: { type: 'number', description: 'Optional stateVersion seen in the previous conversation.' },
      pendingActivityOffset: { type: 'number', description: 'Pagination offset for pending panel facts. Start at 0; continue when pendingActivityHasMore is true.' },
      pendingActivityLimit: { type: 'number', description: '1-100 pending facts to return; default 20.' },
      goalIndexOffset: { type: 'number', description: 'Optional active-goal index offset; use only when goalIndexHasMore is true.' },
      noteIndexOffset: { type: 'number', description: 'Optional note index offset; use only when noteIndexHasMore is true.' },
      commitmentOffset: { type: 'number', description: 'Optional upcoming-commitment offset; use only when upcomingCommitmentsHasMore is true.' },
      decisionOffset: { type: 'number', description: 'Optional active-decision offset; use only when decisionsHasMore is true.' },
      followUpOffset: { type: 'number', description: 'Optional due-follow-up offset; use only when followUpsHasMore is true.' },
    } },
  },
  {
    name: 'zhigui_reconcile_activity',
    description: 'Apply the semantic result of one pending panel activity after reading its directly linked details. It may update goal signals, durable note facts, linked decisions and structured follow-ups. Never rewrite a goal title or description merely because a task was completed.',
    inputSchema: {
      type: 'object', required: ['eventId', 'expectedStateVersion', 'disposition'],
      properties: {
        eventId: { type: 'string' },
        expectedStateVersion: { type: 'number' },
        disposition: { type: 'string', enum: ['applied', 'dismissed', 'needs_user'] },
        goalPatches: { type: 'array', items: { type: 'object' } },
        notePatches: { type: 'array', items: { type: 'object' } },
        decisionPatches: { type: 'array', items: { type: 'object' }, description: 'Existing decisions to revise, resolve, expire or relink.' },
        decisionCreates: { type: 'array', items: { type: 'object' }, description: 'At most three significant decisions created from this event. Include direct entity IDs and updateReason.' },
        followUp: { type: 'object', description: 'Optional {mode: check_in|decision_required, dueAt, reason, question, contextRefs}.' },
        note: { type: 'string', description: 'Short explanation of why the activity was handled this way.' },
      },
    },
  },
  {
    name: 'zhigui_resolve_follow_up',
    description: 'Resolve, dismiss, or defer one explicit assistant follow-up after the user answers it. A deferred follow-up stays pending with a new ISO due time; it will be surfaced only when due in a later conversation.',
    inputSchema: {
      type: 'object', required: ['followUpId'],
      properties: {
        followUpId: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'dismissed'] },
        deferUntil: { type: 'string', description: 'Optional ISO datetime to defer instead of resolving.' },
        note: { type: 'string' },
      },
    },
  },
  // ── Hierarchical detail loading (on-demand, saves tokens) ──
  {
    name: 'zhigui_get_goal_detail',
    description: 'Load the FULL detail of a single goal on demand. The default state only contains a lightweight goal index (id, title, deadline, status). Use this when you need the full goal content: description, detail, context, components, relatedStrategicGoalId, etc. This reads only ONE goal file — minimal token cost.',
    inputSchema: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: 'Goal ID (g_xxx) from the goal index' },
      },
      required: ['goalId'],
    },
  },
  {
    name: 'zhigui_get_note_detail',
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
    name: 'zhigui_get_day_schedule',
    description: 'Load a specific day\'s schedule on demand (tasks plus date-fixed actions, including time-pending commitments). The default state only contains a compact future-commitment index. Use this when: (1) the user mentions a specific date, (2) a near-future commitment can change today\'s decision, (3) conflict detection needs that day\'s tasks, (4) the user asks "what\'s on Aug 1?". Auto-creates an empty day file if the date has no records yet. Reads only ONE day file plus that date\'s actions — minimal token cost.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format, e.g. "2026-08-01"' },
      },
      required: ['date'],
    },
  },

  // ── Second Brain · Association Index (topic foreign key + user-confirmed precipitation) ──
  {
    name: 'zhigui_get_topics',
    description: 'Read all topics and their association statistics. Topics are AI-authored aggregation units for notes, goals and action items (schedule tasks + errands). Each topic reports its linked entity counts and whether it has been precipitated into a standalone detail file.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zhigui_get_topic_document',
    description: 'On-demand read of one topic document. Returns note titles and metadata by default; use get_note_detail for one selected body. Notes are paged so a large topic never silently truncates.',
    inputSchema: {
      type: 'object',
      properties: { topicId: { type: 'string', description: 'Topic id' }, offset: { type: 'number', description: 'Zero-based note offset; default 0.' }, limit: { type: 'number', description: 'Notes per page, 1-30; default 12.' }, includeNoteBodies: { type: 'boolean', description: 'Default false. Set true only when all returned notes are directly required and individual detail reads would be insufficient.' } },
      required: ['topicId'],
    },
  },
  {
    name: 'zhigui_search',
    description: 'Conversation-triggered retrieval across notes, goals and topics. Returns titles, IDs and short match snippets only — never complete note bodies. Call get_note_detail only after selecting a relevant hit. Supports paging.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search keyword' }, offset: { type: 'number', description: 'Zero-based result offset.' }, limit: { type: 'number', description: 'Results per page, 1-30; default 12.' } },
      required: ['query'],
    },
  },
  {
    name: 'zhigui_get_context',
    description: '[Two-layer index · Layer-1] Get note titles and goal titles linked to selected topics. Full note bodies are excluded; call zhigui_get_note_detail only for a relevant title.',
    inputSchema: {
      type: 'object',
      properties: {
        topicIds: { type: 'array', items: { type: 'string' }, description: 'Topic IDs (t_xxx) the AI judged relevant to the current conversation. Get available topics from bootstrap topicIndex.' },
        query: { type: 'string', description: 'Optional current user wording. When topic IDs are unknown, retrieve safe candidate context first.' },
        limit: { type: 'number', description: 'Max number of context items to return. Default 5.' },
      },
    },
  },
  {
    name: 'zhigui_delete_topic',
    description: 'Delete a topic only after a preview and explicit user confirmation. It deletes notes owned by that topic, preserves goals and actions, then removes their stale note/topic links.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'The topic id to delete (from zhigui_get_topics)' },
        confirm: { type: 'boolean', description: 'Must explicitly pass true to execute the delete, preventing accidental deletion' },
      },
      required: ['topicId'],
    },
  },

  // ── Data Export / Import ──
];

// The model gets a deliberate, small conversational surface.  The dashboard
// owns direct UI operations; maintenance, raw document readers and retired
// APIs must not compete with the assistant's reasoning workflow.
const ASSISTANT_TOOL_NAMES = new Set([
  'zhigui_get_assistant_bootstrap',
  'zhigui_get_goal_detail',
  'zhigui_get_note_detail',
  'zhigui_get_topic_document',
  'zhigui_get_day_schedule',
  'zhigui_get_reflection',
  'zhigui_get_decisions',
  'zhigui_get_context',
  'zhigui_get_topics',
  'zhigui_search',
  'zhigui_add_goal',
  'zhigui_update_goal',
  'zhigui_delete_goal',
  'zhigui_add_task',
  'zhigui_update_task',
  'zhigui_delete_task',
  'zhigui_add_errand',
  'zhigui_update_errand',
  'zhigui_complete_errand',
  'zhigui_delete_errand',
  'zhigui_add_note',
  'zhigui_enrich_note',
  'zhigui_update_note',
  'zhigui_delete_note',
  'zhigui_set_briefing',
  'zhigui_add_decision',
  'zhigui_update_decision',
  'zhigui_delete_decision',
  'zhigui_delete_topic',
  'zhigui_auto_schedule',
  'zhigui_create_plan',
  'zhigui_update_user_profile',
  'zhigui_add_reminder',
  'zhigui_update_reminder',
  'zhigui_delete_reminder',
  'zhigui_resolve_follow_up',
  'zhigui_split_topic',
  'zhigui_merge_topics',
  'zhigui_rename_topic',
  'zhigui_precipitate_topic',
  'zhigui_update_value_system',
  'zhigui_reconcile_activity',
]);
const ACTIVE_TOOLS = TOOLS.filter(tool => ASSISTANT_TOOL_NAMES.has(tool.name));

// ─── Tool implementation ──────────────────────────────────────────

async function handleToolCall(name, args) {
  // The assistant and the panel must mutate the same command layer. That
  // layer owns validation, relationship links, lifecycle effects and the
  // compact activity journal used by the next conversation.
  const actionForTool = {
    zhigui_add_goal: 'goal.add',
    zhigui_update_goal: 'goal.update',
    zhigui_add_task: 'task.add',
    zhigui_delete_task: 'task.delete',
    zhigui_add_errand: 'errand.add',
    zhigui_complete_errand: 'errand.complete',
    zhigui_delete_errand: 'errand.delete',
    zhigui_delete_note: 'note.delete',
    zhigui_set_briefing: 'briefing.set',
    zhigui_add_reminder: 'reminder.add',
    zhigui_delete_reminder: 'reminder.delete',
    zhigui_update_user_profile: 'profile.update',
    zhigui_add_decision: 'decision.add',
    zhigui_update_decision: 'decision.update',
    zhigui_delete_decision: 'decision.delete',
    zhigui_reconcile_activity: 'activity.reconcile',
  };
  const deletionTargets = {
    zhigui_delete_goal: { entityType: 'goal', payload: { id: args.id, type: args.type } },
    zhigui_delete_task: { entityType: 'task', payload: { date: args.date, taskId: args.taskId } },
    zhigui_delete_errand: { entityType: 'errand', payload: { id: args.id } },
    zhigui_delete_note: { entityType: 'note', payload: { noteId: args.noteId || args.id } },
    zhigui_delete_decision: { entityType: 'decision', payload: { id: args.id } },
    zhigui_delete_reminder: { entityType: 'reminder', payload: { id: args.id } },
    zhigui_delete_topic: { entityType: 'topic', payload: { topicId: args.topicId } },
  };
  if (deletionTargets[name]) {
    const target = deletionTargets[name];
    if (args.confirm !== true) {
      return Actions.execute('deletion.preview', { entityType: target.entityType, ...target.payload });
    }
    const action = {
      zhigui_delete_goal: 'goal.delete', zhigui_delete_task: 'task.delete', zhigui_delete_errand: 'errand.delete',
      zhigui_delete_note: 'note.delete', zhigui_delete_decision: 'decision.delete', zhigui_delete_reminder: 'reminder.delete',
      zhigui_delete_topic: 'topic.delete',
    }[name];
    return Actions.execute(action, { ...target.payload, confirm: true, source: 'ai' });
  }
  if (name === 'zhigui_add_goal' && !args.force) {
    const clarification = checkGoalInfoSufficiency(args);
    if (clarification) {
      return {
        needsClarification: true,
        type: args.type,
        title: args.title,
        missingInfo: clarification.missingInfo,
        questions: clarification.questions,
        message: clarification.message,
        hint: 'Ask the user the above questions, then retry with the collected information (or set force=true to skip the check).',
      };
    }
  }
  if (actionForTool[name]) {
    const actionPayload = {
      ...args,
      source: 'ai',
    };
    // MCP's historical note tool used `id`; the shared action intentionally
    // uses the explicit `noteId` field. Translate at the boundary once.
    if (name === 'zhigui_delete_note') actionPayload.noteId = args.noteId || args.id;
    return Actions.execute(actionForTool[name], actionPayload);
  }
  if (name === 'zhigui_update_task') {
    const actionArgs = { ...args, source: 'ai' };
    if (typeof args.completed === 'boolean') {
      const before = readFullState();
      const task = before.schedule?.days?.[args.date]?.tasks?.find(item => item.id === args.taskId);
      if (!task) return { error: 'Task not found' };
      if (args.completed) {
        const completion = Actions.execute('task.complete', actionArgs);
        const updateKeys = ['time', 'duration', 'title', 'description', 'category', 'resource', 'relatedGoalId', 'relatedStrategicGoalId', 'topicId', 'noteIds', 'decisionIds', 'contextRefs', 'contextReason'];
        if (!updateKeys.some(key => args[key] !== undefined)) return completion;
        const update = Actions.execute('task.update', actionArgs);
        return { ...completion, task: update.task, followUp: completion.impact?.followUp || null };
      }
      if (task.completed !== args.completed) return Actions.execute('task.toggle', actionArgs);
    }
    return Actions.execute('task.update', actionArgs);
  }

  // Layer-0/1 tools must remain genuinely lightweight: the assistant learns what exists
  // from titles and classifications, then chooses one detail document to open. Mutation
  // and detail tools still receive complete entities and are the only tools allowed to
  // write state back.
  const indexOnlyTools = new Set([
    'zhigui_get_topics',
    'zhigui_get_context',
    // Context-economy: these tools only read lightweight index fields
    'zhigui_get_decisions',
  ]);
  const state = indexOnlyTools.has(name) ? Storage.readState() : readFullState();
  if (!state && !name.startsWith('zhigui_get_config')) {
    return { error: 'Data read failed. Please ensure ZhiGui is initialized (run start.bat).' };
  }

  // Domain alias lookup is now in engine/scheduler.js (Scheduler.DOMAIN_ALIAS)
  // Helper functions (isOneShotGoal, mapGoalToDomain, getDomainWeight, analyzeNotesContext,
  // getProfileAwareSlots) are also in scheduler.js — imported as Scheduler.*

  switch (name) {

  // ── Layer-0 retrieval: single consolidated brief manifest (one document, what exists) ──


  case 'zhigui_get_assistant_bootstrap': {
    // P1-3: Run daily check inside bootstrap so the AI gets carry-forward
    // and conflict results in a single cold-start call, eliminating the
    // need for a separate overview call.
    // P0-0.2: Read full state for dailyCheck under lock to prevent lost-update race
    let dailyCheckResult = null;
    let reminderCheckResult = null;
    let full = null;
    try {
      full = Storage.withLock('server', () => {
        const freshState = readFullState();
        dailyCheckResult = runDailyCheck(freshState);
        reminderCheckResult = runDueReminderCheck(freshState);
        if ((dailyCheckResult && dailyCheckResult.ranAt) || reminderCheckResult.changed) {
          writeState(freshState);
        }
        return freshState;
      });
    } catch {}
    if (!full) full = readFullState();
    const today = todayStr();
    const indexPage = (items, offset, limit) => {
      const safeOffset = Math.max(0, Number(offset) || 0);
      const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
      const page = items.slice(safeOffset, safeOffset + safeLimit);
      return { items: page, total: items.length, offset: safeOffset, hasMore: safeOffset + page.length < items.length, nextOffset: safeOffset + page.length < items.length ? safeOffset + page.length : null };
    };
    const todaySchedule = full.schedule?.days?.[today] || { date: today, tasks: [] };
    const todayBriefing = (full.briefings && full.briefings[today])
      || (full.morningBriefing?.date === today ? full.morningBriefing : null);
    const briefingHasAiText = !!todayBriefing && !todayBriefing._raw && (
      (Array.isArray(todayBriefing.sections) && todayBriefing.sections.some(section => section?.content))
      || ['mustDo', 'recommended', 'notRecommended', 'strategicReminder', 'dailyQuote']
        .some(key => String(todayBriefing[key] || '').trim())
    );
    const attention = AttentionEngine.getAttentionSummary(full, { lang: full.meta?.lang === 'en' ? 'en' : 'zh', maxResults: 12 });
    const activeDecisionSource = (full.decisions || [])
      .filter(decision => ['accepted', 'pending'].includes(decision.status) && (!decision.lifecycleState || decision.lifecycleState !== 'archived'))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const activeDecisionPage = indexPage(activeDecisionSource, args.decisionOffset, 12);
    const activeDecisions = activeDecisionPage.items
      .map(decision => ({
        id: decision.id, title: decision.title, status: decision.status,
        updatedAt: decision.updatedAt || decision.createdAt || null,
        reviewDueAt: decision.reviewDueAt || decision.expiresAt || null,
        relatedGoalIds: decision.relatedGoalIds || [], relatedNoteIds: decision.relatedNoteIds || [],
        relatedActionIds: decision.relatedActionIds || [], topicIds: decision.topicIds || [],
      }));
    const pendingActivityPage = Storage.readPendingActivityPage({
      offset: args.pendingActivityOffset,
      limit: args.pendingActivityLimit || 20,
    });
    const pendingActivity = pendingActivityPage.items;
    const dueFollowUpSource = (full.followUps || [])
      .filter(item => item.status === 'pending' && followUpDueDate(item) && followUpDueDate(item) <= today)
      .sort((a, b) => String(followUpDueDate(a)).localeCompare(String(followUpDueDate(b))));
    const dueFollowUpPage = indexPage(dueFollowUpSource, args.followUpOffset, 12);
    const dueFollowUps = dueFollowUpPage.items.map(item => ({ id: item.id, mode: item.mode, dueAt: item.dueAt, dueDate: followUpDueDate(item), reason: item.reason || null, question: item.question, contextRefs: item.contextRefs || [] }));
    // P1-1.12 + P6-6.11: Filter out archived entities and sort by most recently active
    const _isActive = e => !e.lifecycleState || e.lifecycleState === 'active' || e.lifecycleState === 'stale';
    const goalIndexSource = [...(full.currentGoals || []), ...(full.strategicGoals || [])]
      .filter(goal => !goal.completed && _isActive(goal))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const goalIndexPage = indexPage(goalIndexSource, args.goalIndexOffset, 30);
    const goalIndex = goalIndexPage.items.map(goal => ({ id: goal.id, title: goal.title, deadline: goal.deadline || null, statusSignal: goal.statusSignal || null, statusReason: goal.statusReason || null, nextStep: goal.nextStep || null, topicId: goal.topicId || null, updatedAt: goal.updatedAt || null }));
    const noteIndexSource = (full.notes || [])
      .filter(_isActive)
      .sort((a, b) => (b.lastAccessedAt || b.updatedAt || b.createdAt || '').localeCompare(a.lastAccessedAt || a.updatedAt || a.createdAt || ''));
    const noteIndexPage = indexPage(noteIndexSource, args.noteIndexOffset, 30);
    const noteIndex = noteIndexPage.items.map(note => ({ id: note.id, title: note.title || null, topicId: note.topicId || null, relatedDate: note.relatedDate || null, updatedAt: note.lastAccessedAt || note.updatedAt || note.createdAt || null }));
    // Proactive link suggestions: notes that share a topic with an active
    // goal/task/errand but are not yet referenced by that entity's noteIds.
    // Surfaced at cold start so the AI can offer to link them in the next
    // conversation — covers notes added later or via panel operations.
    const _targets = [
      ...goalIndexSource.map(g => ({ id: g.id, title: g.title, kind: 'goal', topicId: g.topicId || null, noteIds: Array.isArray(g.noteIds) ? g.noteIds : [] })),
      ...(full.errands || []).filter(e => !e.completed && _isActive(e)).map(e => ({ id: e.id, title: e.title, kind: 'errand', topicId: e.topicId || null, noteIds: Array.isArray(e.noteIds) ? e.noteIds : [] })),
    ];
    for (const [date, day] of Object.entries(full.schedule?.days || {})) {
      for (const task of (day.tasks || [])) {
        if (task.completed) continue;
        _targets.push({ id: task.id, title: task.title, kind: 'task', topicId: task.topicId || null, noteIds: Array.isArray(task.noteIds) ? task.noteIds : [] });
      }
    }
    const _topicTargets = {};
    for (const t of _targets) {
      if (!t.topicId) continue;
      (_topicTargets[t.topicId] = _topicTargets[t.topicId] || []).push(t);
    }
    const linkSuggestions = [];
    const _seenNote = new Set();
    for (const note of noteIndexSource) {
      if (!note.topicId || _seenNote.has(note.id)) continue;
      const matches = (_topicTargets[note.topicId] || []).filter(t => !t.noteIds.includes(note.id));
      if (matches.length === 0) continue;
      _seenNote.add(note.id);
      linkSuggestions.push({
        noteId: note.id,
        noteTitle: note.title || null,
        topicId: note.topicId,
        suggestedTargets: matches.slice(0, 5).map(m => ({ kind: m.kind, id: m.id, title: m.title })),
      });
      if (linkSuggestions.length >= 12) break;
    }
    // Context-economy: expose totals and hasMore so the assistant knows when to
    // fetch additional records instead of treating the slice as the full set.
    const goalIndexTotal = goalIndexSource.length;
    const noteIndexTotal = noteIndexSource.length;
    // Compact topic index — gives the AI the complete topic list (id + label)
    // at cold start so it can reuse existing topics via topicId instead of
    // creating duplicates.
    const topicIndex = getBrainIndex().getTopics().map(t => ({
      id: t.id,
      label: t.label,
      category: t.category || null,
      noteCount: t.noteCount,
    }));
    const horizon = DateUtils.nextDay(today, 14);
    const withinHorizon = date => date && date >= today && date <= horizon;
    const upcomingCommitments = [];
    const preparationCommitments = [];
    const considerPreparation = item => {
      if (!item?.date || item.date < today) return;
      const leadDays = Math.max(0, Number(item.preparationLeadDays) || 0);
      const daysUntil = DateUtils.daysBetween(item.date, today);
      if (leadDays > 0 && daysUntil >= 0 && daysUntil <= leadDays && !withinHorizon(item.date)) {
        preparationCommitments.push({ ...item, daysUntil, preparationLeadDays: leadDays });
      }
    };
    for (const [date, day] of Object.entries(full.schedule?.days || {})) {
      for (const task of (day.tasks || [])) {
        if (task.completed || task.missedAt) continue;
        const item = { id: task.id, date, time: task.time || null, timing: task.time ? 'timed' : 'time_pending', title: task.title, kind: 'task', relatedGoalId: task.relatedGoalId || null, preparationLeadDays: task.preparationLeadDays || 0 };
        if (withinHorizon(date)) upcomingCommitments.push(item);
        else considerPreparation(item);
      }
    }
    for (const action of (full.errands || [])) {
      if (action.completed || !action.date) continue;
      const item = { id: action.id, date: action.date, time: action.time || null, timing: action.time ? 'timed' : 'time_pending', title: action.title, kind: 'action', commitmentLevel: action.commitmentLevel || 'should', relatedGoalId: action.goalId || action.relatedGoalId || null, preparationLeadDays: action.preparationLeadDays || 0 };
      if (withinHorizon(action.date)) upcomingCommitments.push(item);
      else considerPreparation(item);
    }
    upcomingCommitments.sort((a, b) => `${a.date}|${a.time || '99:99'}`.localeCompare(`${b.date}|${b.time || '99:99'}`));
    const upcomingCommitmentPage = indexPage(upcomingCommitments, args.commitmentOffset, 30);
    preparationCommitments.sort((a, b) => `${a.date}|${a.time || '99:99'}`.localeCompare(`${b.date}|${b.time || '99:99'}`));
    const missedCommitments = [];
    for (const [date, day] of Object.entries(full.schedule?.days || {})) {
      for (const task of (day.tasks || [])) {
        if (task.missedAt) missedCommitments.push({ id: task.id, date, title: task.title, missedAt: task.missedAt, category: task.category || 'event' });
      }
    }
    missedCommitments.sort((a, b) => String(b.missedAt).localeCompare(String(a.missedAt)));
    return {
      _tier: 'layer0',
      protocolVersion: '2026-07-assistant-v2',
      stateVersion: full.meta?.stateVersion || 0,
      generatedAt: new Date().toISOString(),
      sections: {
        identityVersion: full.userProfile?.updatedAt || null,
        goalsVersion: Math.max(...goalIndexSource.map(goal => Date.parse(goal.updatedAt || 0) || 0), 0) || null,
        activityVersion: pendingActivity[0]?.stateVersion || null,
        todayDate: today,
      },
      identity: {
        longTermDirection: full.userProfile?.longTermDirection || null,
        corePrinciples: full.userProfile?.corePrinciples || [],
        lifeStage: full.userProfile?.lifeStage || null,
        decisionStyle: full.userProfile?.valueSystem?.decisionStyle || 'balanced',
      },
      // Constraints are never omitted, but Bootstrap carries only a compact
      // manifest. Read a specific constraint detail before applying a rule.
      hardConstraints: (full.constraints || []).map(constraint => ({ id: constraint.id, title: constraint.title, statusSignal: constraint.statusSignal || null, topicId: constraint.topicId || null })),
      today: {
        date: today,
        tasks: (todaySchedule.tasks || []).slice(0, 50).map(task => ({ id: task.id, time: task.time, title: task.title, completed: !!task.completed, relatedGoalId: task.relatedGoalId || null })),
        taskTotal: (todaySchedule.tasks || []).length,
        tasksTruncated: (todaySchedule.tasks || []).length > 50,
        activeErrands: (full.errands || []).filter(errand => errand.date === today && !errand.completed).slice(0, 50).map(errand => ({ id: errand.id, title: errand.title, time: errand.time || '', commitmentLevel: errand.commitmentLevel })),
        errandTotal: (full.errands || []).filter(errand => errand.date === today && !errand.completed).length,
      },
      morningBriefing: {
        date: today,
        status: !todayBriefing ? 'missing' : (briefingHasAiText ? 'composed' : 'awaiting_ai'),
        generatedAt: todayBriefing?.composedAt || todayBriefing?.updatedAt || null,
      },
      // `changes` is incremental when a same-thread caller supplies a version;
      // `pendingActivity` is cross-thread and is never hidden by another chat.
      changes: Storage.readRecentActivity({ sinceVersion: args.sinceVersion, limit: 20 }),
      pendingActivity,
      pendingActivityTotal: pendingActivityPage.total,
      pendingActivityOffset: pendingActivityPage.offset,
      pendingActivityHasMore: pendingActivityPage.hasMore,
      pendingActivityNextOffset: pendingActivityPage.nextOffset,
      pendingActivityBacklogWarning: pendingActivityPage.total > 200,
      pendingActivitySummary: pendingActivityPage.summary,
      upcomingCommitments: upcomingCommitmentPage.items,
      upcomingCommitmentsTotal: upcomingCommitmentPage.total,
      upcomingCommitmentsOffset: upcomingCommitmentPage.offset,
      upcomingCommitmentsHasMore: upcomingCommitmentPage.hasMore,
      upcomingCommitmentsNextOffset: upcomingCommitmentPage.nextOffset,
      preparationCommitments: preparationCommitments.slice(0, 12),
      preparationCommitmentsTotal: preparationCommitments.length,
      preparationCommitmentsHasMore: preparationCommitments.length > 12,
      missedCommitments: missedCommitments.slice(0, 12),
      missedCommitmentsTotal: missedCommitments.length,
      missedCommitmentsHasMore: missedCommitments.length > 12,
      goalIndex,
      goalIndexTotal,
      goalIndexOffset: goalIndexPage.offset,
      goalIndexHasMore: goalIndexPage.hasMore,
      goalIndexNextOffset: goalIndexPage.nextOffset,
      topicIndex,
      noteIndex,
      noteIndexTotal,
      noteIndexOffset: noteIndexPage.offset,
      noteIndexHasMore: noteIndexPage.hasMore,
      noteIndexNextOffset: noteIndexPage.nextOffset,
      linkSuggestions,
      decisions: activeDecisions,
      decisionsTotal: activeDecisionPage.total,
      decisionsOffset: activeDecisionPage.offset,
      decisionsHasMore: activeDecisionPage.hasMore,
      decisionsNextOffset: activeDecisionPage.nextOffset,
      attention: attention.topSignals,
      followUps: dueFollowUps,
      followUpsTotal: dueFollowUpPage.total,
      followUpsOffset: dueFollowUpPage.offset,
      followUpsHasMore: dueFollowUpPage.hasMore,
      followUpsNextOffset: dueFollowUpPage.nextOffset,
      dueReminders: reminderCheckResult?.fired || [],
      // P1-3: Include dailyCheck results in bootstrap so the AI doesn't
      // need a separate overview call on cold start.
      dailyCheck: dailyCheckResult,
      // Include last reflection summary for continuity — the AI can see
      // yesterday's suggestions and goal health without calling
      // zhigui_get_reflection separately.
      lastReflection: full.lastReflection || null,
      instruction: 'Treat this as a fresh cross-thread checkpoint. Read pendingActivity before planning when it can affect the reply; then load only directly linked entities. Signals rank investigation only. Inspect upcomingCommitments before composing a morning briefing; read a specific future day only when it can change today\'s decision. dailyCheck includes carry-forward and conflict results — no need for a separate overview call for this data. If lastReflection exists, review its suggestions for continuity with yesterday. topicIndex lists all existing topics (id + label) — to reuse a topic, pass its id as topicId on any create call; to create a new topic, pass the label as topic. linkSuggestions lists notes that share a topic with an active goal/task/errand but are not yet linked — at cold start, proactively offer to connect them (e.g. "I saw you added note X on topic Y; link it to goal Z?"); do this before planning. This also covers notes added through the dashboard/panel between sessions.',
    };
  }

  // ── Layer-1 retrieval: document index ──

    // ── Hierarchical detail loading (on-demand, saves tokens) ──
    case 'zhigui_get_goal_detail': {
      if (!args.goalId) return { error: 'Missing goalId' };
      try {
        const detail = Storage.getGoalDetail(args.goalId);
        if (!detail) return { error: 'Goal not found: ' + args.goalId };
        // P6-6.9: Update lastAccessedAt to track memory freshness
        Storage.touchGoalLastAccessed(args.goalId);
        return { _tier: 'layer1', goal: detail, hint: 'Full goal detail loaded. Use this for decision-making, progress tracking, or explaining to the user.' };
      } catch (e) { return { error: 'Failed to load goal detail: ' + e.message }; }
    }

    case 'zhigui_get_note_detail': {
      if (!args.noteId) return { error: 'Missing noteId' };
      try {
        const detail = Storage.getNoteDetail(args.noteId);
        if (!detail) return { error: 'Note not found: ' + args.noteId };
        // P6-6.9: Update lastAccessedAt to track memory freshness
        Storage.touchNoteLastAccessed(args.noteId);
        return { _tier: 'layer1', note: detail };
      } catch (e) { return { error: 'Failed to load note detail: ' + e.message }; }
    }

    case 'zhigui_get_day_schedule': {
      if (!args.date) return { error: 'Missing date' };
      try {
        // Context-economy + avoid auto-creating empty files for exploratory reads.
        // The lightweight state's schedule.days is an index keyed by date; if the
        // date is missing there is no day file, so return an empty structure
        // instead of calling Storage.getDaySchedule (which auto-creates one).
        if (!state.schedule?.days?.[args.date]) {
          // Even when no schedule file exists for this date, still compute
          // date-fixed errands so the caller can see time-pending commitments.
          const dateActions = (state.errands || []).filter(action => action.date === args.date && !action.completed);
          return {
            _tier: 'layer1',
            date: args.date,
            weekday: DateUtils.getWeekday(args.date),
            tasks: [],
            errands: dateActions,
            timedActions: dateActions.filter(action => !!action.time),
            dateFixedActions: dateActions.filter(action => !action.time),
            dayNotes: [],
            taskCount: 0,
            errandCount: dateActions.length,
            message: 'No schedule for this date.',
          };
        }
        const daySchedule = Storage.getDaySchedule(args.date);
        const dateActions = (state.errands || []).filter(action => action.date === args.date && !action.completed);
        return {
          _tier: 'layer1',
          date: args.date,
          tasks: (daySchedule && daySchedule.tasks) || [],
          errands: [...((daySchedule && daySchedule.errands) || []), ...dateActions],
          timedActions: dateActions.filter(action => !!action.time),
          dateFixedActions: dateActions.filter(action => !action.time),
          dayNotes: (daySchedule && daySchedule.dayNotes) || [],
          taskCount: (daySchedule && daySchedule.tasks || []).length,
          errandCount: ((daySchedule && daySchedule.errands) || []).length + dateActions.length,
          hint: daySchedule ? 'Day schedule loaded.' : 'No schedule for this date — empty day file auto-created.',
        };
      } catch (e) { return { error: 'Failed to load day schedule: ' + e.message }; }
    }


    // ── Layer-2 retrieval: read document by type ──

    // ── Data reading ──



    // ── Goal management ──
    // zhigui_add_goal / zhigui_update_goal are routed through actionForTool
    // (goal.add / goal.update) and the pre-check at the top of this function.
    // zhigui_delete_goal is handled by the unified deletionTargets path above.

    case 'zhigui_resolve_follow_up': {
      return Actions.execute('followup.resolve', {
        followUpId: args.followUpId,
        status: args.status,
        deferUntil: args.deferUntil,
        note: args.note,
        source: 'ai',
      });
    }

    // ── Panel control ──




    // ── Intelligence layer ──
    case 'zhigui_auto_schedule': {
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
      let { phaseRanges, activeGoals } = Scheduler.computePhaseRanges(allActiveGoals, startDateStr);

      if (activeGoals.length === 0) {
        return {
          success: false,
          reason: 'no_active_goals',
  message: 'There are currently no active current goals; cannot generate a schedule. Please add current goals first (type=currentGoal; detail is required, deadline is optional), then call this tool again.',
  hint: 'If the user only stated a strategic goal without specifics, you need to first follow the framework to ask for specific information, then help the user create current goals, or call zhigui_create_plan to one-click generate a structured plan, then call auto_schedule.',
          strategicGoalsCount: strategicGoals.length,
          constraintsCount: constraints.length,
        };
      }

      // Signal and constraint engines may narrow the field, but choosing what
      // deserves the person's time is an explicit assistant judgment. Never
      // silently turn stored numeric fields into that judgment.
      const focusGoalIds = Array.isArray(args.focusGoalIds) ? args.focusGoalIds.filter(Boolean) : [];
      if (activeGoals.length > 1 && focusGoalIds.length === 0) {
        return {
          success: false,
          reason: 'focus_selection_required',
          message: 'More than one active goal is eligible. Read the relevant goal/context details, decide an ordered focus list, then call auto_schedule with focusGoalIds and selectionReason.',
          candidates: activeGoals.map(goal => ({ id: goal.id, title: goal.title, deadline: goal.deadline || null, relatedStrategicGoalId: goal.relatedStrategicGoalId || null })),
        };
      }
      if (focusGoalIds.length > 0) {
        const byId = new Map(activeGoals.map(goal => [goal.id, goal]));
        const unknown = focusGoalIds.filter(id => !byId.has(id));
        if (unknown.length) return { error: `Unknown or inactive focus goal: ${unknown.join(', ')}` };
        activeGoals = focusGoalIds.map(id => byId.get(id));
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

      // 2. Refresh only deadline-derived fields; it is not a decision engine.
      const goalFieldUpdates = refreshGoalDeadlineFields(state);

      // 3. Parse constraints into executable rules (Task 1.1: extracted to Scheduler)
      const { constraintRules, latestTaskTime, restDays, dailyExercise, dailyAvailableHours }
        = Scheduler.parseConstraintRules(constraints);

      // 4. Compute daily available time slots—personalized based on user profile (Task 1.1: Scheduler)
      const latestHour = parseInt((latestTaskTime || '23:00').split(':')[0], 10) || 23;
      const workHabit = state.userProfile?.workHabit || '';
      const chronotype = state.userProfile?.chronotype || 'standard';
      const slotConfig = Scheduler.getProfileAwareSlots(workHabit, latestTaskTime, latestHour, chronotype);
      const dailySlots = slotConfig.slots;
      const profileSlotNote = slotConfig.note;
      const profileType = slotConfig.profile;

      // 5. Schedule generation policy: only generate TODAY's schedule (the assistant re-evaluates each day).
      // Future days get briefings only (to show upcoming deadlines), not pre-scheduled tasks.
      // To generate a long-cycle plan, explicitly pass args.days to override.
      const startDate = args.startDate || todayStr();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        return { success: false, error: 'Invalid startDate format (expected YYYY-MM-DD)' };
      }
      const SCHEDULE_DAYS = (args.days && args.days > 0) ? Math.max(Math.min(args.days, 180), 1) : 1;
      const BRIEFING_DAYS = 1;  // briefing is today-only; upcoming deadlines already live in goals/notes

      const start = new Date(startDate + 'T00:00:00');
      const generatedSchedule = {};
      const schedulingNotes = [];

      state.schedule = state.schedule || {};
      state.schedule.days = state.schedule.days || {};

      // Carry-forward is handled by runDailyCheck (runs on every bootstrap/overview).
      // The old inline carry-forward here only covered source==='ai' tasks and
      // duplicated the work. scheduleSingleDay now preserves carriedFrom tasks
      // via existingTasks, so no inline carry-forward is needed.
      const carryForwardTasks = [];

      // Pre-compute descriptive fields only. No synthetic decision value is created or consumed.
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

      state.schedule.weekOf = startDate;

      // 7. Run conflict detection (Task 1.1: extracted to Scheduler.detectAndMergeConflicts)
      Scheduler.detectAndMergeConflicts(state, activeGoals, dailySlots, detectConflicts);

      // 8. Prepare raw briefing input (Task 1.1: Scheduler.generateBriefings).
      //     — today-only; stale briefings are discarded on every schedule run.
      const today = todayStr();
      const panelLang = state.meta?.lang === 'en' ? 'en' : 'zh';
      Scheduler.generateBriefings({
        start, briefingDays: BRIEFING_DAYS, errands, activeGoals, notes, state,
        constraintRules, strategicGoals, profileBackground, panelLang, latestTaskTime,
        restDays, dailyExercise, dailyAvailableHours,
      });

      // 9. Write back state.json
      // P0-0.2: Persist only the scheduling-derived fields under lock. Re-read the latest
      // state to avoid clobbering concurrent writes to goals/errands/notes by other processes
      // (e.g. Dashboard via actions.js). Re-run refreshGoalDeadlineFields on the fresh state so
      // deadline-derived fields stay consistent without overwriting the entity arrays.
      // IMPORTANT: Only overwrite the single day we just scheduled; never overwrite the
      // entire schedule.days map with a stale in-memory copy.
      Storage.withLock('server', () => {
        const freshState = readFullState();
        // Re-apply deadline-derived field refresh on the latest goals (idempotent).
        refreshGoalDeadlineFields(freshState);
        freshState.schedule = freshState.schedule || {};
        freshState.schedule.days = freshState.schedule.days || {};
        // Merge every day this run (re)scheduled into the fresh schedule map.
        // scheduleSingleDay mutates state.schedule.days in place, so the generated
        // days live there; only upsert the [start, start+SCHEDULE_DAYS) window to
        // avoid clobbering other dates another process may have touched (audit P1).
        for (let i = 0; i < SCHEDULE_DAYS; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const ds = d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
          if (state.schedule && state.schedule.days && state.schedule.days[ds]) {
            freshState.schedule.days[ds] = state.schedule.days[ds];
          }
        }
        freshState.schedule.weekOf = startDate;
        // Conflicts are computed from the just-scheduled day; briefings are today-only.
        freshState.conflicts = state.conflicts;
        freshState.briefings = state.briefings;
        freshState.morningBriefing = state.morningBriefing;
        writeState(freshState);
      });

      // 10. Return the complete plan
      return {
        success: true,
        message: `Generated schedule (starting ${startDate}). IMPORTANT: call zhigui_set_briefing to compose today's morning briefing — read the raw briefing data (state.briefings[today]._raw) to base your natural-language composition on the actual schedule, goals, constraints, and value system. Suggested structure (flexible): 必须完成 / 今日推荐 / 不建议 / 战略提醒 / 每日一言. Use the 'sections' array when a rigid split feels unnatural; omit sections that don't add value.`,
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
          mustCount: errands.filter(e => e.commitmentLevel === 'must').length,
          shouldCount: errands.filter(e => e.commitmentLevel === 'should').length,
          niceCount: errands.filter(e => e.commitmentLevel === 'nice').length,
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
          note: 'Value preferences were provided as context for the assistant-selected focus order; the scheduler preserved that order when allocating slots.',
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
        goalFieldUpdates,
        conflicts: {
          total: state.conflicts.length,
          critical: state.conflicts.filter(c => c.severity === 'critical').length,
          warnings: state.conflicts.filter(c => c.severity === 'warning').length,
          items: state.conflicts,
        },
        briefing: state.morningBriefing,
        notes_text: schedulingNotes,
        activeGoals: activeGoals.map(g => ({ id: g.id, title: g.title, daysLeft: g.daysLeft, overdue: g.overdue })),
        suggestion: (() => {
          const tMust = errands.filter(e => e.date === today && e.commitmentLevel === 'must');
          if (tMust.length > 0) return `Today has ${tMust.length} confirmed must-do errand(s).`;
          if (activeGoals.length > 0) return `Detected ${activeGoals.length} active goal(s); focus order was supplied by the assistant.`;
          return 'No active goals at the moment; just proceed as planned.';
        })(),
      };
    }


    case 'zhigui_create_plan': {
      return await buildPlan(state, args);
    }

    // ── User profile ──

    case 'zhigui_update_user_profile': {
      // P0-0.2: Apply profile field updates under lock; re-read latest state first.
      const updatedProfile = Storage.withLock('server', () => {
        const freshState = readFullState();
        freshState.userProfile = freshState.userProfile || {
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
        if (args.personality !== undefined) freshState.userProfile.personality = args.personality;
        if (args.communicationStyle !== undefined) freshState.userProfile.communicationStyle = args.communicationStyle;
        if (args.preferredTools !== undefined) freshState.userProfile.preferredTools = args.preferredTools;
        if (args.workHabit !== undefined) freshState.userProfile.workHabit = args.workHabit;
        if (args.chronotype !== undefined) freshState.userProfile.chronotype = args.chronotype;
        if (args.interests !== undefined) freshState.userProfile.interests = args.interests;
        if (args.tonePreference !== undefined) freshState.userProfile.tonePreference = args.tonePreference;
        if (args.responseDetail !== undefined) freshState.userProfile.responseDetail = args.responseDetail;
        if (args.languageStyle !== undefined) freshState.userProfile.languageStyle = args.languageStyle;
        if (args.notes !== undefined) freshState.userProfile.notes = args.notes;
        if (args.conversationCount !== undefined) {
          freshState.userProfile.conversationCount = args.conversationCount;
        } else {
          freshState.userProfile.conversationCount = (freshState.userProfile.conversationCount || 0) + 1;
        }
        // Identity Layer fields
        if (args.longTermDirection !== undefined) freshState.userProfile.longTermDirection = String(args.longTermDirection).trim();
        if (Array.isArray(args.corePrinciples)) freshState.userProfile.corePrinciples = args.corePrinciples.map(s => String(s).trim()).filter(Boolean);
        if (args.lifeStage !== undefined) freshState.userProfile.lifeStage = String(args.lifeStage).trim();

        freshState.userProfile.updatedAt = new Date().toISOString();

        writeState(freshState);
        return freshState.userProfile;
      });
      return {
        success: true,
        message: 'User profile updated',
        profile: updatedProfile,
      };
    }

    // ── Errand system ──
    case 'zhigui_add_errand': {
      if (!args.title) {
        return {
          needsClarification: true,
          missingInfo: ['title'],
          questions: ['What exactly is this thing? Please describe the content and purpose.'],
          message: 'Errand is missing specific content; need to follow up.',
        };
      }
      state.errands = state.errands || [];
      const pattern = ['one-time', 'recurring'].includes(args.pattern) ? args.pattern : 'one-time';
      const errand = {
        id: genId('e'),
        title: args.title,
        date: args.date || null,
        time: args.time || '',
        duration: args.duration || 60,
        category: args.category || 'misc',
        commitmentLevel: args.commitmentLevel || 'should',
        retention: ['transient', 'review', 'memory'].includes(args.retention) ? args.retention : 'transient',
        note: args.note || '',
        // AI-judged conflict-assessment fields (persisted for future conflict checks)
        timeCost: args.timeCost || null,
        requiresPresence: args.requiresPresence || false,
        blocksFocus: args.blocksFocus || false,
        completed: false,
        createdAt: new Date().toISOString(),
        // 关联字段：AI 创建行程时前置绑定笔记/目标/topic
        pattern,
        noteIds: Array.isArray(args.noteIds) ? args.noteIds.filter(n => typeof n === 'string').slice(0, 20) : [],
        topicId: args.topicId || null,
        goalId: args.goalId || null,
      };

      // ── Same-day conflict detection (pure math, no keyword matching) ──
      // AI provides timeCost/requiresPresence/blocksFocus; engine does the calculation
      const dayConflicts = args.date ? detectSameDayConflicts(state, {
          date: args.date,
          time: args.time,
          duration: args.duration,
          title: args.title,
          commitmentLevel: args.commitmentLevel,
          type: 'errand',
          timeCost: args.timeCost,
          requiresPresence: args.requiresPresence,
          blocksFocus: args.blocksFocus,
        }) : [];

      // P0-0.2: Append the new errand + conflict records under lock; re-read latest state.
      // Build the conflict records up front (pure) so we just append inside the lock.
      const newConflictRecords = dayConflicts.length > 0
        ? dayConflicts.map(c => ({ id: genId('conflict'), createdAt: new Date().toISOString(), ...c }))
        : [];
      Storage.withLock('server', () => {
        const freshState = readFullState();
        freshState.errands = freshState.errands || [];
        freshState.errands.push(errand);
        if (newConflictRecords.length > 0) {
          freshState.conflicts = freshState.conflicts || [];
          for (const c of newConflictRecords) freshState.conflicts.push(c);
        }
        writeState(freshState);
      });
      // 若指定了 topicId，将 errand 挂到 brain-index 的 topic hub
      if (errand.topicId) {
        try {
          const brain = getBrainIndex();
          brain.linkEntity(errand.topicId, 'actionItems', errand.id);
          // Ensure noteIds are also linked to the topic (not just stored on the errand)
          if (errand.noteIds && errand.noteIds.length > 0) {
            for (const nid of errand.noteIds) {
              brain.linkEntity(errand.topicId, 'notes', nid);
            }
          }
        } catch {}
      }

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
        message: `Added action: ${args.title}${args.date ? ` (${args.date} ${args.commitmentLevel || 'should'} commitment)` : ' (unscheduled)'}${conflictWarning}`,
        conflicts: dayConflicts,
        hasConflict: dayConflicts.length > 0,
        hint: args.commitmentLevel === 'must'
          ? 'This errand is marked MUST-level; it will be prioritized ahead of all development goals during schedule generation.'
          : 'This errand will be considered during schedule generation.',
      };
    }



    case 'zhigui_get_reflection': {
      try {
        const lang = args.lang || (state.userProfile?.panelLang === 'en' ? 'en' : 'zh');
        let result;
        // Reflection changes lifecycle fields (stale/archive). Generate it from
        // the same fresh snapshot that is persisted, otherwise a manual
        // reflection would return lifecycle changes that disappear immediately.
        Storage.withLock('server', () => {
          const freshState = readFullState();
          result = ReflectionEngine.generateReflection(freshState, { lang, date: args.date });
          freshState.lastReflection = {
            date: result.date,
            generatedAt: result.generatedAt,
            suggestions: result.suggestions,
            lifecycle: result.lifecycle,
            completedToday: { totalCount: result.completedToday.totalCount, summary: result.completedToday.summary },
            goalHealthNeedsAttention: (result.goalHealth.needsAttention || []).map(g => ({ id: g.id, title: g.title, type: g.type, healthSignals: g.healthSignals })),
            attentionShift: { pendingDecisionsCount: result.attentionShift.pendingDecisionsCount, unresolvedConflictsCount: result.attentionShift.unresolvedConflictsCount, staleNotesCount: result.attentionShift.staleNotesCount, summary: result.attentionShift.summary },
          };
          writeState(freshState);
        });
        return {
          _tier: 'layer2',
          ...result,
          hint: 'Reflection Engine: structured daily review. AI should review suggestions and decide which to act on — update goal statusSignal/statusReason, obstacle, risk, or nextStep as needed.',
        };
      } catch (e) {
        return { error: 'Reflection generation failed: ' + e.message };
      }
    }





    case 'zhigui_add_decision': {
      const decision = {
        id: genId('dec'),
        title: String(args.title || '').trim(),
        description: String(args.description || '').trim(),
        evidence: String(args.evidence || '').trim(),
        impact: String(args.impact || '').trim(),
        relatedGoalIds: Array.isArray(args.relatedGoalIds) ? args.relatedGoalIds : [],
        relatedNoteIds: Array.isArray(args.relatedNoteIds) ? args.relatedNoteIds : [],
        status: ['accepted', 'rejected', 'pending', 'reversed', 'expired'].includes(args.status) ? args.status : 'accepted',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: args.expiresAt || null,
        reversedBy: args.reversedBy || null,
        outcome: null,
      };
      if (!decision.title) return { error: 'Decision title is required' };
      // P0-0.2: Append the new decision under lock; re-read latest state.
      Storage.withLock('server', () => {
        const freshState = readFullState();
        freshState.decisions = freshState.decisions || [];
        freshState.decisions.push(decision);
        writeState(freshState);
      });
      return { success: true, decision };
    }

    case 'zhigui_get_decisions': {
      state.decisions = state.decisions || [];
      let result = [...state.decisions].reverse(); // newest first
      if (args.status) result = result.filter(d => d.status === args.status);
      if (args.goalId) result = result.filter(d => (d.relatedGoalIds || []).includes(args.goalId));
      const limit = Math.min(Math.max(args.limit || 20, 1), 100);
      result = result.slice(0, limit);
      return {
        decisions: result,
        total: result.length,
        hint: 'Decision Log: check this before making recommendations to avoid re-suggesting decisions the user has already made or rejected.',
      };
    }

    case 'zhigui_update_decision': {
      // P0-0.2: Find + mutate + write under lock.
      const updateResult = Storage.withLock('server', () => {
        const freshState = readFullState();
        freshState.decisions = freshState.decisions || [];
        const decision = freshState.decisions.find(d => d.id === args.id);
        if (!decision) return { error: 'Decision not found: ' + args.id };
        if (args.status && ['accepted', 'rejected', 'pending', 'reversed', 'expired'].includes(args.status)) {
          decision.status = args.status;
        }
        if (args.reversedBy) decision.reversedBy = args.reversedBy;
        if (args.expiresAt) decision.expiresAt = args.expiresAt;
        if (args.outcome) decision.outcome = String(args.outcome).trim();
        decision.updatedAt = new Date().toISOString();
        writeState(freshState);
        return { success: true, decision };
      });
      return updateResult;
    }

    case 'zhigui_delete_decision': {
      // P0-0.2: Find + splice + write under lock.
      const deleteResult = Storage.withLock('server', () => {
        const freshState = readFullState();
        freshState.decisions = freshState.decisions || [];
        const idx = freshState.decisions.findIndex(d => d.id === args.id);
        if (idx < 0) return { error: 'Decision not found: ' + args.id };
        freshState.decisions.splice(idx, 1);
        writeState(freshState);
        return { success: true, deleted: args.id };
      });
      return deleteResult;
    }

    case 'zhigui_update_errand': {
      const result = Actions.execute('errand.update', { ...args, source: 'ai' });
      if (!result.success) return result;
      return { success: true, errand: result.errand, message: `Errand updated in place: ${result.errand?.title || args.id}. ID and context links preserved.` };
    }

    case 'zhigui_update_reminder': {
      const result = Actions.execute('reminder.update', { ...args, source: 'ai' });
      if (!result.success) return result;
      return { success: true, reminder: result.reminder, message: `Reminder updated in place: ${result.reminder?.title || args.id}${args.triggerAt ? ' → ' + args.triggerAt : ''}. ID preserved.` };
    }

    case 'zhigui_update_note': {
      // Hard guardrail: the engine refuses unconfirmed direct edits regardless
      // of what the calling AI believes. The user is the source of truth for
      // their own notes — consent must be explicit and per-edit.
      if (args.userConfirmed !== true) {
        return {
          success: false,
          error: 'CONFIRMATION_REQUIRED: show the user the exact proposed content and get explicit approval in this conversation first, then retry with userConfirmed=true. For reclassification use zhigui_enrich_note (applies metadata immediately, no confirmation needed) instead.',
        };
      }
      const result = Actions.execute('note.update', { noteId: args.id, content: args.content, source: 'ai' });
      if (!result.success) return result;
      return { success: true, noteId: args.id, message: 'Note body updated with user-confirmed content.' };
    }

    case 'zhigui_complete_errand': {
      const result = Actions.execute('errand.complete', { ...args, source: 'ai' });
      if (!result.success) return result;
      try { getBrainIndex().unlinkEntityCascade('errands', args.id); } catch {}
      const cleanupMsg = result.action?.noteCleanupHint === 'suggest_delete'
        ? ' Related one-time notes may be cleaned up later.'
        : ' Recurring action notes are preserved for future reference.';
      return { success: true, discarded: false, action: result.action, message: `Completed: ${result.errand?.title || ''}.${cleanupMsg}` };
    }

    // ── Life notes system ──
    case 'zhigui_add_note': {
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

    case 'zhigui_enrich_note': {
      // Direct metadata organization (title/topic/category). The note body is
      // never touched here — body edits go through zhigui_update_note, which
      // enforces explicit per-edit user confirmation.
      return Actions.execute('note.enrich', args);
    }

    case 'zhigui_split_topic':
    case 'zhigui_merge_topics':
    case 'zhigui_rename_topic':
    case 'zhigui_precipitate_topic': {
      // Hard guardrail: structural knowledge-base changes execute immediately,
      // so the engine refuses them unless the AI declares the user approved
      // the exact plan in this conversation.
      if (args.userConfirmed !== true) {
        return {
          success: false,
          error: 'CONFIRMATION_REQUIRED: present the full plan to the user in conversation and get explicit approval first, then retry with userConfirmed=true.',
        };
      }
      const actionName = {
        zhigui_split_topic: 'topic.split',
        zhigui_merge_topics: 'topic.merge',
        zhigui_rename_topic: 'topic.rename',
        zhigui_precipitate_topic: 'topic.precipitate',
      }[name];
      return Actions.execute(actionName, args);
    }

    // ── Value system ──
    case 'zhigui_update_value_system': {
      if ((args.priorities || args.decisionStyle) && !['explicit', 'confirmed_interpretation'].includes(args.evidenceType)) {
        return {
          needsConfirmation: true,
          message: 'Value preferences require an explicit user statement or a confirmed interpretation.',
          hint: 'Ask the user to confirm the interpretation, then call again with evidenceType="confirmed_interpretation"; use evidenceType="explicit" only for a direct stated trade-off.',
        };
      }
      // P0-0.2: Apply value-system updates under lock; re-read latest state first.
      const updatedValueSystem = Storage.withLock('server', () => {
        const freshState = readFullState();
        freshState.userProfile = freshState.userProfile || {};
        freshState.userProfile.valueSystem = freshState.userProfile.valueSystem || {
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
          freshState.userProfile.valueSystem.signals = freshState.userProfile.valueSystem.signals || [];
          freshState.userProfile.valueSystem.signals.push(signal);
          // Keep only the most recent 50 signals
          if (freshState.userProfile.valueSystem.signals.length > 50) {
            freshState.userProfile.valueSystem.signals = freshState.userProfile.valueSystem.signals.slice(-50);
          }
        }

        if (args.priorities) {
          for (const newP of args.priorities) {
            const existing = freshState.userProfile.valueSystem.priorities.find(p => p.domain === newP.domain);
            // Count how many times this domain has been signaled (for confidence)
            const domainSignals = (freshState.userProfile.valueSystem.signals || [])
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
              freshState.userProfile.valueSystem.priorities.push({
                ...newP,
                confidence: newConfidence,
                signalCount,
                lastUpdated: new Date().toISOString(),
              });
            }
          }
          // Sort priorities by weight descending
          freshState.userProfile.valueSystem.priorities.sort((a, b) => b.weight - a.weight);
        }
        if (args.decisionStyle) {
          freshState.userProfile.valueSystem.decisionStyle = args.decisionStyle;
        }
        if (args.learnedFrom) {
          freshState.userProfile.valueSystem.learnedFrom = freshState.userProfile.valueSystem.learnedFrom || [];
          freshState.userProfile.valueSystem.learnedFrom.push(args.learnedFrom);
          if (freshState.userProfile.valueSystem.learnedFrom.length > 20) {
            freshState.userProfile.valueSystem.learnedFrom = freshState.userProfile.valueSystem.learnedFrom.slice(-20);
          }
        }
        freshState.userProfile.updatedAt = new Date().toISOString();
        writeState(freshState);
        return freshState.userProfile.valueSystem;
      });
      return {
        success: true,
        message: 'Value system updated',
        valueSystem: updatedValueSystem,
        hint: updatedValueSystem.priorities.length > 0
          ? `Current top value: ${updatedValueSystem.priorities[0].domain} (${updatedValueSystem.priorities[0].weight}). Use this when making trade-off decisions.`
          : 'No priorities set yet.',
      };
    }

    // ── Second brain · association index ──
    case 'zhigui_get_topics': {
      try {
        const brain = getBrainIndex();
        return { topics: brain.getTopics(), total: brain.getTopics().length };
      } catch (e) { return { error: 'Failed to read topics: ' + e.message, topics: [] }; }
    }



    case 'zhigui_get_topic_document': {
      if (!args.topicId) return { error: 'Missing topicId' };
      try {
        const brain = getBrainIndex();
        const doc = brain.getTopicDocument(args.topicId, { includeNotes: true });
        if (!doc) return { error: 'Topic does not exist: ' + args.topicId };
        const noteCount = (doc.notes || []).length;
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 12));
        const selectedNotes = (doc.notes || []).slice(offset, offset + limit);
        const notes = args.includeNoteBodies === true
          ? selectedNotes
          : selectedNotes.map(note => ({ id: note.id, title: note.title || null, category: note.category || null, domain: note.domain || null, relatedDate: note.relatedDate || null, updatedAt: note.updatedAt || note.createdAt || null, contentLength: String(note.content || '').length }));
        const hasMore = offset + notes.length < noteCount;
        return { ...doc, notes, noteBodiesIncluded: args.includeNoteBodies === true, noteCount, offset, limit, hasMore, nextOffset: hasMore ? offset + notes.length : null };
      } catch (e) { return { error: 'Failed to read topic document: ' + e.message }; }
    }


    case 'zhigui_search': {
      if (!args.query) return { error: 'Missing query' };
      try {
        const brain = getBrainIndex();
        return brain.search(args.query, { offset: args.offset, limit: args.limit });
      } catch (e) { return { error: 'Search failed: ' + e.message }; }
    }


    case 'zhigui_get_context': {
      try {
        const brain = getBrainIndex();
        let topicIds = Array.isArray(args.topicIds) ? args.topicIds.filter(Boolean) : [];
        let retrieval = null;
        if (topicIds.length === 0 && args.query) {
          retrieval = brain.search(args.query, { limit: 12 });
          topicIds = [...new Set((retrieval.hits || []).map(hit => hit.topicId).filter(Boolean))].slice(0, 8);
        }
        if (topicIds.length === 0) {
          // A dated task/errand or a detached decision can be relevant without
          // belonging to a topic. Preserve those compact retrieval pointers so
          // the assistant can read its specific day/detail instead of treating
          // "no topic" as "no context".
          const directItems = (retrieval?.hits || []).slice(0, args.limit || 5);
          return {
            hasContext: directItems.length > 0,
            items: directItems,
            retrieval,
            guidance: directItems.length
              ? 'These are compact direct matches without a selected topic. Load the specific note, goal, or date only if it changes the answer.'
              : 'Pass topicIds or a query to retrieve candidate context.',
          };
        }
        const result = brain.getContext({ topicIds, limit: args.limit || 5 });
        return { ...result, retrieval };
      } catch (e) { return { hasContext: false, items: [], error: 'Context retrieval failed: ' + e.message }; }
    }

    case 'zhigui_delete_topic': {
      if (!args.topicId) return { error: 'Missing topicId' };
      try {
        return Actions.execute(args.confirm === true ? 'topic.delete' : 'topic.preview_delete', {
          topicId: args.topicId,
          confirm: args.confirm === true,
          source: 'ai',
        });
      } catch (e) { return { error: 'Cascade delete failed: ' + e.message }; }
    }




    // ── Data Export / Import ──


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
          serverInfo: { name: 'zhigui', version: '1.0.0' },
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
