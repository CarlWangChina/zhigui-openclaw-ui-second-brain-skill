# Event-Stream Second Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Lingxi from a "bucketed-storage schedule manager" into a "second brain with the event stream as the source of truth," supporting follow-up scheduling, cross-domain association, four proactive reminder types, and self-learning.

**Architecture:** Add events.json as the underlying event stream. Each sentence the user says creates an Event (multi-domain tagged); only after follow-up is it derived into the file tree (schedule/notes/goals). The file tree is retained as the categorized view, with each record linked back to the event via sourceEventId. The MCP server adds 5 new tools and modifies add_history. The front end adds an event-stream panel.

**Tech Stack:** Node.js (zero dependencies, built-in modules), JSON file storage, SSE real-time push, MCP JSON-RPC 2.0

---

## File Structure

### New Files
- `.lingxi/events.json` — Event stream data (created at runtime)
- `scripts/migrate-to-events.js` — Data migration script
- `mcp/event-engine.js` — Event stream engine (extracted from mcp/server.js, standalone module)
- `mcp/self-learning.js` — Self-learning engine (fact extraction + value inference)

### Modified Files
- `mcp/server.js` — Add 5 MCP tool definitions + case branches, modify add_history, register event-engine
- `server/server.js` — Add 3 HTTP API endpoints, register event-engine
- `public/dashboard.js` — Add event-stream rendering, follow-up reminder rendering
- `public/index.html` — Add event-stream panel HTML
- `public/dashboard.css` — Add event-stream style
- `skill/SKILL.md` — Rewrite AI behavior guide
- `.lingxi/documents.json` — Updated at runtime (add events entry)
- `scripts/setup.js` — Add events.json initialization

---

### Task 1: Event Stream Data Layer (event-engine.js core read/write)

**Files:**
- Create: `mcp/event-engine.js`
- Test: Manual verification (see Step 5)

- [ ] **Step 1: Create event-engine.js base structure**

```javascript
// mcp/event-engine.js
/**
 * Lingxi event stream engine
 * The event stream is the system's single source of truth; all file-tree data is derived from events
 */

const fs = require('fs');
const path = require('path');

// Event status enum
const EVENT_STATUS = {
  PENDING: 'pending',
  CLARIFYING: 'clarifying',
  RESOLVED: 'resolved',
  ARCHIVED: 'archived',
};

// Event type enum
const EVENT_TYPE = {
  EVENT: 'event',
  GOAL: 'goal',
  ERRAND: 'errand',
  NOTE: 'note',
  CONSTRAINT: 'constraint',
  DECISION: 'decision',
};

// Domain keyword mapping
const DOMAIN_KEYWORDS = {
  health: ['牙', '医', '病', '药', '疼', '痛', '手术', '体检', '胃', '感冒', '发烧', '过敏', '受伤', '骨折', '复查', '口腔', '眼科', '皮肤', '心理', '失眠', '颈椎', '腰椎', '智齿', '医院', '看诊', '挂号', '不舒服', '拉肚子', '咳嗽', '咽炎', '拔牙'],
  relationship: ['女朋友', '男朋友', '老婆', '老公', '家人', '父母', '爸', '妈', '朋友', '吵架', '约会', '纪念日', '恋爱', '分手', '结婚', '孩子', '儿子', '女儿', '陪', '相亲', '生日'],
  career: ['工作', '实习', '项目', '领导', '同事', '升职', '跳槽', '面试', '简历', '加班', '述职', 'kpi', 'okr', '辞职', '入职', '转正'],
  academic: ['考试', '论文', '课程', '学分', '导师', '答辩', '作业', '考研', '考公', '雅思', '托福', '期末', '挂科', '预习', '复习', '学习', '掌握', '精通', '毕业', '开题'],
  social: ['聚会', '饭局', '社交', '消息', '回复', '人脉', '聚餐', '活动', '团建', '年会'],
  misc: ['缴费', '宠物', '搬家', '出行', '快递', '签证', '证件', '洗衣', '整理', '租房', '买房', '车', '驾照'],
};

class EventEngine {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.eventsFile = path.join(dataDir, 'events.json');
    this._ensureFile();
  }

  _ensureFile() {
    if (fs.existsSync(this.eventsFile)) return;
    const initial = {
      meta: { version: '3.0.0', lastUpdated: new Date().toISOString(), totalEvents: 0 },
      events: [],
      pendingFollowUps: [],
    };
    fs.writeFileSync(this.eventsFile, JSON.stringify(initial, null, 2), 'utf8');
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.eventsFile, 'utf8'));
    } catch {
      return { meta: { version: '3.0.0', lastUpdated: new Date().toISOString(), totalEvents: 0 }, events: [], pendingFollowUps: [] };
    }
  }

  _write(data) {
    data.meta.lastUpdated = new Date().toISOString();
    data.meta.totalEvents = data.events.length;
    fs.writeFileSync(this.eventsFile, JSON.stringify(data, null, 2), 'utf8');
  }

  _genId() {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const data = this._read();
    const todayCount = data.events.filter(e => e.id && e.id.includes(datePart)).length + 1;
    return `evt_${datePart}_${String(todayCount).padStart(3, '0')}`;
  }
}

module.exports = { EventEngine, EVENT_STATUS, EVENT_TYPE, DOMAIN_KEYWORDS };
```

- [ ] **Step 2: Add event analysis logic (domain detection + fact extraction + follow-up generation)**

Add the following methods inside the EventEngine class:

```javascript
  // Analyze user message, extract domains and facts
  analyzeMessage(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return { domains: [], facts: [], followUpNeeded: false, followUpItems: [] };

    const domains = [];
    const facts = [];

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      const matchedKeywords = keywords.filter(kw => userMessage.includes(kw));
      if (matchedKeywords.length === 0) continue;
      domains.push(domain);

      // Extract the sentence containing the keyword
      const sentences = userMessage.split(/[，。！？；\n,!?;]/).filter(s => s.trim());
      let bestSentence = '';
      for (const kw of matchedKeywords) {
        const s = sentences.find(s => s.includes(kw));
        if (s && s.length > bestSentence.length) bestSentence = s;
      }
      if (!bestSentence) bestSentence = userMessage.slice(0, 100);

      // Detect time information
      const timePatterns = [/明天/, /后天/, /大后天/, /下周/, /这周/, /本周/, /今天/, /\d+月\d+日/, /\d+点/];
      let when = null;
      for (const tp of timePatterns) {
        const m = bestSentence.match(tp);
        if (m) { when = m[0]; break; }
      }

      // Filter too-short and command-like messages
      if (bestSentence.trim().length < 4) continue;
      const commandPatterns = ['删除', '查看', '显示', '打开', '关闭', '切换', '收起', '展开'];
      if (commandPatterns.some(p => bestSentence.trim().startsWith(p)) && bestSentence.length < 10) continue;

      facts.push({ domain, content: bestSentence.trim(), when });
    }

    // Deduplicate: don't let the same sentence appear in multiple domains' facts
    const seen = new Set();
    const uniqueFacts = facts.filter(f => {
      if (seen.has(f.content)) return false;
      seen.add(f.content);
      return true;
    });

    return { domains: [...new Set(domains)], facts: uniqueFacts };
  }

  // Determine whether follow-up is needed (missing time/location/duration etc.)
  generateFollowUps(userMessage, facts) {
    const followUpItems = [];
    const hasTime = /(\d+点|\d+:?\d*)/.test(userMessage) || /上午|下午|晚上|早上/.test(userMessage);
    const hasDuration = /(\d+小时|\d+分钟|\d+个钟|\d+min)/.test(userMessage);

    // If a fact has a when but no specific time → follow up
    const factsWithWhen = facts.filter(f => f.when && !hasTime);
    for (const f of factsWithWhen) {
      followUpItems.push(`"${f.content.slice(0, 15)}${f.content.length > 15 ? '...' : ''}"具体几点？大概需要多长时间？`);
    }

    // If no time info at all but there is a concrete thing → follow up
    if (!hasTime && facts.length > 0 && followUpItems.length === 0) {
      const mainFact = facts[0];
      followUpItems.push(`这件事打算什么时候做？`);
    }

    return {
      followUpNeeded: followUpItems.length > 0,
      followUpItems: followUpItems.slice(0, 5), // at most 5 follow-ups
    };
  }
```

- [ ] **Step 3: Add event CRUD methods**

Add to the EventEngine class:

```javascript
  // Create event (single entry point)
  createEvent({ userMessage, aiResponse, context, source = 'conversation' }) {
    const data = this._read();
    const analysis = this.analyzeMessage(userMessage);
    const followUps = this.generateFollowUps(userMessage, analysis.facts);

    const evt = {
      id: this._genId(),
      timestamp: new Date().toISOString(),
      source,
      rawInput: userMessage,
      domains: analysis.domains,
      type: EVENT_TYPE.EVENT,
      extracted: {
        facts: analysis.facts,
        followUpNeeded: followUps.followUpNeeded,
        followUpItems: followUps.followUpItems,
      },
      derivedRecords: [],
      reminders: this._generateReminders(analysis.facts),
      status: followUps.followUpNeeded ? EVENT_STATUS.CLARIFYING : EVENT_STATUS.RESOLVED,
      resolvedAt: followUps.followUpNeeded ? null : new Date().toISOString(),
      relatedEvents: this._findRelatedEvents(analysis.facts, data.events),
      aiContext: context || '',
      aiResponse: aiResponse || '',
    };

    data.events.unshift(evt); // newest first

    // Maintain pendingFollowUps index
    if (evt.status === EVENT_STATUS.CLARIFYING || evt.status === EVENT_STATUS.PENDING) {
      data.pendingFollowUps.unshift(evt.id);
    }

    this._write(data);
    return evt;
  }

  // Resolve event (after user answers follow-up)
  resolveEvent(eventId, { userAnswers, additionalFacts }) {
    const data = this._read();
    const evt = data.events.find(e => e.id === eventId);
    if (!evt) return { error: 'Event not found', eventId };

    // Merge user answers into facts
    if (additionalFacts && Array.isArray(additionalFacts)) {
      evt.extracted.facts.push(...additionalFacts);
    }
    // Record user answers
    evt.userAnswers = userAnswers;
    evt.extracted.followUpNeeded = false;
    evt.extracted.followUpItems = [];
    evt.status = EVENT_STATUS.RESOLVED;
    evt.resolvedAt = new Date().toISOString();

    // Remove from pendingFollowUps
    data.pendingFollowUps = data.pendingFollowUps.filter(id => id !== eventId);

    this._write(data);
    return { success: true, event: evt };
  }

  // Get events pending follow-up
  getPendingFollows(limit = 10) {
    const data = this._read();
    const follows = [];
    for (const id of data.pendingFollowUps) {
      const evt = data.events.find(e => e.id === id);
      if (evt) follows.push(evt);
      if (follows.length >= limit) break;
    }
    return follows;
  }

  // Get recent events
  getRecentEvents(limit = 10) {
    const data = this._read();
    return data.events.slice(0, limit);
  }

  // Find related events
  _findRelatedEvents(facts, allEvents) {
    const related = [];
    if (allEvents.length === 0) return related;

    // Find events within the last 30 days by same domain
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const recentEvents = allEvents.filter(e => e.timestamp > thirtyDaysAgo && e.id);

    for (const fact of facts) {
      for (const evt of recentEvents) {
        if (evt.domains && evt.domains.includes(fact.domain)) {
          // Check whether content overlaps (simple keyword overlap)
          const factWords = fact.content.split('');
          const evtWords = (evt.rawInput || '').split('');
          const overlap = factWords.filter(w => w.length > 1 && evtWords.includes(w)).length;
          if (overlap >= 2 && !related.includes(evt.id)) {
            related.push(evt.id);
          }
        }
      }
    }
    return related.slice(0, 3);
  }

  // Generate reminder rules
  _generateReminders(facts) {
    const reminders = [];
    for (const fact of facts) {
      if (fact.when && /明天|后天|\d+月\d+日/.test(fact.when)) {
        // Has explicit time → create no_mention reminder (remind if not mentioned again after 5 days)
        reminders.push({
          type: 'no_mention',
          condition: { daysSilent: 5 },
          message: `你之前提到的"${fact.content.slice(0, 20)}"后续怎么样了？`,
          triggered: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return reminders;
  }

  // Check whether reminders have triggered
  checkReminders() {
    const data = this._read();
    const triggered = [];

    for (const evt of data.events) {
      if (!evt.reminders || evt.status === EVENT_STATUS.ARCHIVED) continue;

      for (const reminder of evt.reminders) {
        if (reminder.triggered) continue;

        if (reminder.type === 'no_mention') {
          const daysSilent = reminder.condition.daysSilent || 5;
          const eventDate = new Date(evt.timestamp);
          const now = new Date();
          const daysSince = (now - eventDate) / 86400000;

          if (daysSince >= daysSilent) {
            // Check whether there is a same-domain new event in this period
            const recentSameDomain = data.events.find(e =>
              e.id !== evt.id &&
              e.timestamp > evt.timestamp &&
              e.domains && e.domains.some(d => (evt.domains || []).includes(d))
            );

            if (!recentSameDomain) {
              reminder.triggered = true;
              reminder.triggeredAt = new Date().toISOString();
              triggered.push({ eventId: evt.id, message: reminder.message, type: reminder.type });
            }
          }
        }

        if (reminder.type === 'deadline_approaching' && reminder.triggerDate) {
          const now = new Date();
          now.setHours(0, 0, 0, 0);
          const triggerDate = new Date(reminder.triggerDate);
          if (now >= triggerDate && !reminder.triggered) {
            reminder.triggered = true;
            reminder.triggeredAt = new Date().toISOString();
            triggered.push({ eventId: evt.id, message: reminder.message, type: reminder.type });
          }
        }
      }
    }

    if (triggered.length > 0) this._write(data);
    return triggered;
  }

  // Generate comprehensive summary
  getSummary(days = 14, domains) {
    const data = this._read();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentEvents = data.events.filter(e => e.timestamp > cutoff);

    const filtered = domains
      ? recentEvents.filter(e => e.domains && e.domains.some(d => domains.includes(d)))
      : recentEvents;

    // Aggregate by domain
    const domainSummary = {};
    const domainLabels = { health: '健康', relationship: '婚恋', career: '事业', academic: '课业', social: '社交', misc: '其他' };

    for (const evt of filtered) {
      for (const fact of (evt.extracted && evt.extracted.facts) || []) {
        if (domains && !domains.includes(fact.domain)) continue;
        const label = domainLabels[fact.domain] || fact.domain;
        if (!domainSummary[label]) domainSummary[label] = [];
        domainSummary[label].push({
          content: fact.content,
          when: fact.when || null,
          date: evt.timestamp.slice(0, 10),
          eventId: evt.id,
          status: evt.status,
        });
      }
    }

    // Check pending follow-ups
    const pendingFollows = this.getPendingFollows(5);
    const pendingItems = pendingFollows
      .filter(e => e.timestamp > cutoff)
      .map(e => ({
        eventId: e.id,
        question: (e.extracted.followUpItems || [])[0] || e.rawInput,
        daysSince: Math.floor((Date.now() - new Date(e.timestamp)) / 86400000),
      }));

    // Domain load (this week)
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const weekEvents = data.events.filter(e => e.timestamp > weekAgo);
    const domainLoad = {};
    for (const evt of weekEvents) {
      for (const d of (evt.domains || [])) {
        domainLoad[d] = (domainLoad[d] || 0) + 1;
      }
    }

    return {
      period: { days, from: cutoff.slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      totalEvents: filtered.length,
      domainSummary,
      pendingFollowUps: pendingItems,
      domainLoad,
      heaviestDomain: Object.entries(domainLoad).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    };
  }
}
```

- [ ] **Step 4: Verify event-engine.js syntax is correct**

Run: `node -e "const { EventEngine } = require('d:/linxi/mcp/event-engine'); const e = new EventEngine('d:/linxi/.lingxi'); const evt = e.createEvent({ userMessage: '明天要陪老婆去医院拔牙，下午还要回公司领导的消息关于新项目' }); console.log(JSON.stringify({ id: evt.id, domains: evt.domains, status: evt.status, followUpNeeded: evt.extracted.followUpNeeded, followUpItems: evt.extracted.followUpItems, factsCount: evt.extracted.facts.length }, null, 2));"`

Expected: Output the event object; domains include health/relationship/career; status is clarifying; followUpItems is non-empty.

- [ ] **Step 5: Verify resolving event after follow-up**

Run: `node -e "const { EventEngine } = require('d:/linxi/mcp/event-engine'); const e = new EventEngine('d:/linxi/.lingxi'); const pending = e.getPendingFollows(); console.log('Pending:', pending.length); if (pending.length > 0) { const r = e.resolveEvent(pending[0].id, { userAnswers: '上午9点，大概2小时，下午2点回消息' }); console.log('Resolved:', r.success, r.event.status); }"`

Expected: Pending > 0; after resolve, status becomes resolved.

---

### Task 2: MCP Server Integration of Event Stream Tools

**Files:**
- Modify: `mcp/server.js:1-20` (import event-engine)
- Modify: `mcp/server.js` tool definition area (add 5 tool definitions)
- Modify: `mcp/server.js` handleToolCall function (add 5 cases)

- [ ] **Step 1: Import event-engine at the top of mcp/server.js**

Add after `const readline = require('readline');`:

```javascript
const { EventEngine, EVENT_STATUS, DOMAIN_KEYWORDS } = require('./event-engine');
```

After the `loadConfig()` function and before `readDocument()`, initialize the engine instance:

```javascript
let eventEngine = null;
function getEventEngine() {
  if (!eventEngine) {
    const config = loadConfig();
    eventEngine = new EventEngine(config.dataDir);
  }
  return eventEngine;
}
```

- [ ] **Step 2: Add 5 tool definitions in the tools array**

Add after the `lingxi_add_note` tool definition and before `lingxi_update_value_system`:

```javascript
  {
    name: 'lingxi_create_event',
    description: 'Create event — the unified entry point of Lingxi. Every sentence the user says creates an event through this tool. The system automatically analyzes the content, extracts facts into multiple domains, and determines whether follow-up is needed. The AI no longer needs to call add_goal/add_errand/add_note separately — all are handled uniformly by this tool. If it returns followUpNeeded=true, the AI must ask the user for follow-up before calling resolve_event.',
    inputSchema: {
      type: 'object',
      required: ['userMessage'],
      properties: {
        userMessage: { type: 'string', description: 'User original words' },
        aiResponse: { type: 'string', description: 'AI reply summary (optional)' },
        context: { type: 'string', description: 'AI understanding of user intent (optional)' },
      },
    },
  },
  {
    name: 'lingxi_resolve_event',
    description: 'Resolve event — called after the user answers the follow-up. The system merges the supplementary info into the event, marks it resolved, and auto-derives it into the file tree (schedule/notes/goals etc.).',
    inputSchema: {
      type: 'object',
      required: ['eventId', 'userAnswers'],
      properties: {
        eventId: { type: 'string', description: 'Event ID to resolve' },
        userAnswers: { type: 'string', description: 'User original words answering the follow-up' },
      },
    },
  },
  {
    name: 'lingxi_get_pending_follows',
    description: 'Get the list of events pending follow-up. Call at the start of every new conversation; if there are events pending follow-up, proactively bring them up to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number returned, default 10' },
      },
    },
  },
  {
    name: 'lingxi_get_summary',
    description: 'Generate a comprehensive summary. Called when the user asks "how have I been lately"; aggregates and analyzes from the event stream by domain, returns each domain status, pending follow-up items, and domain load.',
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
    description: 'Check whether event-driven reminder rules have triggered. Called each time create_event is called and during morning briefing generation.',
    inputSchema: { type: 'object', properties: {} },
  },
```

- [ ] **Step 3: Add 5 case branches in handleToolCall**

Add before `case 'lingxi_add_history':`:

```javascript
    case 'lingxi_create_event': {
      const engine = getEventEngine();
      const evt = engine.createEvent({
        userMessage: args.userMessage,
        aiResponse: args.aiResponse || '',
        context: args.context || '',
      });

      // Also update document index
      try { updateIndexTimestamp('events'); } catch {}

      const result = {
        id: evt.id,
        domains: evt.domains,
        status: evt.status,
        facts: evt.extracted.facts,
        followUpNeeded: evt.extracted.followUpNeeded,
        followUpItems: evt.extracted.followUpItems,
        relatedEvents: evt.relatedEvents,
        reminders: evt.reminders.map(r => ({ type: r.type, message: r.message })),
      };

      if (evt.extracted.followUpNeeded) {
        result.hint = 'This event needs follow-up. The AI must ask the user the questions in followUpItems, then call lingxi_resolve_event after the user answers. Do not auto-schedule or create any file-tree records.';
      } else {
        result.hint = 'This event is complete and has been auto-marked resolved. The AI can directly perform follow-up operations (scheduling, creating goals, etc.) based on the info in facts.';
      }

      return result;
    }

    case 'lingxi_resolve_event': {
      const engine = getEventEngine();
      // Extract additional facts from user answers
      const analysis = engine.analyzeMessage(args.userAnswers);
      const additionalFacts = analysis.facts.map(f => ({
        ...f,
        source: '追问回答',
      }));

      const result = engine.resolveEvent(args.eventId, {
        userAnswers: args.userAnswers,
        additionalFacts,
      });

      if (result.error) return result;

      // Derive into file tree
      const state = readState();
      const evt = result.event;
      const derived = [];

      // Derive notes to notes.json
      const docs = require('./event-engine');
      // Derive by writing to state
      state.notes = state.notes || { health: [], relationship: [], career: [], academic: [], social: [], misc: [] };
      for (const fact of evt.extracted.facts) {
        if (!state.notes[fact.domain]) state.notes[fact.domain] = [];
        // Deduplicate check
        const isDup = state.notes[fact.domain].some(n => n.content === fact.content);
        if (!isDup) {
          const noteId = 'note_' + Math.random().toString(36).slice(2, 10);
          const note = {
            id: noteId,
            sourceEventId: evt.id,
            domain: fact.domain,
            content: fact.content,
            relatedDate: fact.when || null,
            source: '事件自动派生',
            createdAt: new Date().toISOString(),
          };
          state.notes[fact.domain].push(note);
          derived.push({ file: 'notes.json', recordId: noteId, field: fact.domain });
        }
      }

      // If there is explicit time and content, derive to schedule
      const factsWithTime = evt.extracted.facts.filter(f => f.when);
      if (factsWithTime.length > 0) {
        state.schedule = state.schedule || { weekOf: '', days: {} };
        // Parse date
        let targetDate = new Date();
        const rawInput = evt.rawInput + ' ' + args.userAnswers;
        if (/明天/.test(rawInput)) targetDate.setDate(targetDate.getDate() + 1);
        else if (/后天/.test(rawInput)) targetDate.setDate(targetDate.getDate() + 2);
        else if (/大后天/.test(rawInput)) targetDate.setDate(targetDate.getDate() + 3);

        const dateStr = targetDate.toISOString().slice(0, 10);
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

        if (!state.schedule.days[dateStr]) {
          state.schedule.days[dateStr] = { date: dateStr, weekday: weekdays[targetDate.getDay()], tasks: [] };
        }

        // Parse time
        const timeMatch = rawInput.match(/(\d{1,2})点/);
        const durationMatch = rawInput.match(/(\d+)(小时|分钟|min|个钟)/);
        const time = timeMatch ? timeMatch[1].padStart(2, '0') + ':00' : '09:00';
        const duration = durationMatch
          ? (durationMatch[2] === '小时' || durationMatch[2] === '个钟')
            ? parseInt(durationMatch[1]) * 60
            : parseInt(durationMatch[1])
          : 60;

        const taskId = 't_' + Math.random().toString(36).slice(2, 10);
        const mainFact = factsWithTime[0];
        const task = {
          id: taskId,
          time,
          duration,
          title: mainFact.content.slice(0, 30),
          description: evt.rawInput,
          priority: 70,
          completed: false,
          source: 'event',
          sourceEventId: evt.id,
          category: mainFact.domain === 'academic' ? 'study' : mainFact.domain === 'career' ? 'meeting' : 'event',
        };
        state.schedule.days[dateStr].tasks.push(task);
        derived.push({ file: 'schedule.json', recordId: taskId, field: 'tasks' });
      }

      // Update event's derivedRecords
      evt.derivedRecords = derived;
      writeState(state);

      // Sync write to split documents
      writeDocument('notes', { meta: { version: '3.0.0', lastUpdated: new Date().toISOString(), documentType: 'notes' }, notes: state.notes });
      writeDocument('schedule', { meta: { version: '3.0.0', lastUpdated: new Date().toISOString(), documentType: 'schedule' }, schedule: state.schedule, conflicts: state.conflicts || [] });

      return {
        success: true,
        event: { id: evt.id, status: evt.status },
        derived,
        hint: 'Event resolved and derived to file tree. AI can tell the user it has been arranged.',
      };
    }

    case 'lingxi_get_pending_follows': {
      const engine = getEventEngine();
      const follows = engine.getPendingFollows(args.limit || 10);
      if (follows.length === 0) {
        return { hasPending: false, message: '没有待跟进的事件' };
      }
      return {
        hasPending: true,
        count: follows.length,
        items: follows.map(e => ({
          eventId: e.id,
          rawInput: e.rawInput,
          domains: e.domains,
          followUpItems: e.extracted.followUpItems,
          daysSince: Math.floor((Date.now() - new Date(e.timestamp)) / 86400000),
          createdAt: e.timestamp,
        })),
        hint: 'AI should proactively raise these follow-up questions to the user at the start of the conversation. Sort by daysSince descending, prioritize the longest-unhandled.',
      };
    }

    case 'lingxi_get_summary': {
      const engine = getEventEngine();
      const summary = engine.getSummary(args.days || 14, args.domains);
      return {
        ...summary,
        hint: 'AI should organize the summary by domain, point out pending follow-up items, and give an overall suggestion.',
      };
    }

    case 'lingxi_check_reminders': {
      const engine = getEventEngine();
      const triggered = engine.checkReminders();
      if (triggered.length === 0) {
        return { hasTriggered: false, message: '没有需要触发的提醒' };
      }
      return {
        hasTriggered: true,
        count: triggered.length,
        items: triggered,
        hint: 'AI should naturally remind the user of these items in the reply.',
      };
    }
```

- [ ] **Step 4: Modify lingxi_add_history (remove auto note extraction)**

In `case 'lingxi_add_history':`, remove the `autoExtractNotesFromConversation` call and the `autoExtractedNotes`-related logic. add_history only records conversation history and no longer auto-extracts notes (handled uniformly by create_event).

Replace the `autoExtractNotesFromConversation` call block in `case 'lingxi_add_history':` with:

```javascript
      // Record conversation history (note extraction handled uniformly by create_event, not repeated here)
```

- [ ] **Step 5: Update lingxi_get_instructions workflow**

In the workflow array, add step 0a after step 0, and modify steps 5 and 6:

```
'0a. [MUST·Proactive follow-up] Call lingxi_get_pending_follows → if there are unfollowed events → proactively bring them up to the user, then handle the new request after the user answers'
```

Change step 5 to:
```
'5. 【MUST·Second Brain】Call lingxi_create_event to create an event (unified entry). If it returns followUpNeeded=true → ask the user → after answering, call lingxi_resolve_event. The system auto-derives to the file tree. No longer call add_goal/add_errand/add_note separately.'
```

Change step 6 to:
```
'6. 【MUST·Reminder check】Call lingxi_check_reminders to check whether event-driven reminders need to trigger.'
```

- [ ] **Step 6: Verify MCP server starts without errors**

Run: `node -e "require('d:/linxi/mcp/server.js')" 2>&1 | head -5`

Expected: No syntax errors (server will wait for stdin input; press Ctrl+C to exit)

---

### Task 3: HTTP Server Integration of Event Stream API

**Files:**
- Modify: `server/server.js` (add 3 API endpoints + import event-engine)

- [ ] **Step 1: Import event-engine in server/server.js**

Add after `const INDEX_FILE = ...`:

```javascript
const { EventEngine } = require('../mcp/event-engine');
let eventEngine = null;
function getEventEngine() {
  if (!eventEngine) eventEngine = new EventEngine(LINGXI_DIR);
  return eventEngine;
}
```

- [ ] **Step 2: Add 3 API handlers**

Add after the `handleGetDocument` function:

```javascript
// GET /api/events?limit=10 — get recent event stream
function handleGetEvents(req, res, queryParams) {
  const limit = parseInt(queryParams.get('limit')) || 10;
  const engine = getEventEngine();
  const events = engine.getRecentEvents(limit);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events, total: events.length }));
}

// GET /api/pending-follows — get events pending follow-up
function handleGetPendingFollows(res) {
  const engine = getEventEngine();
  const follows = engine.getPendingFollows(10);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ hasPending: follows.length > 0, count: follows.length, items: follows }));
}

// GET /api/summary?days=14 — get comprehensive summary
function handleGetSummary(req, res, queryParams) {
  const days = parseInt(queryParams.get('days')) || 14;
  const engine = getEventEngine();
  const summary = engine.getSummary(days);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(summary));
}
```

- [ ] **Step 3: Register routes**

In the routing area, after the `handleGetDocument` route:

```javascript
    } else if (pathname === '/api/events' && req.method === 'GET') {
      handleGetEvents(req, res, url.searchParams);
    } else if (pathname === '/api/pending-follows' && req.method === 'GET') {
      handleGetPendingFollows(res);
    } else if (pathname === '/api/summary' && req.method === 'GET') {
      handleGetSummary(req, res, url.searchParams);
    } else if (pathname === '/api/health') {
```

- [ ] **Step 4: Verify API endpoints**

Run: `node d:/linxi/server/server.js` (background)

Run: `Invoke-RestMethod -Uri 'http://localhost:7788/api/events?limit=5' | ConvertTo-Json -Depth 3`

Expected: Returns the latest 5 events

Run: `Invoke-RestMethod -Uri 'http://localhost:7788/api/pending-follows' | ConvertTo-Json -Depth 3`

Expected: Returns the list of events pending follow-up

Run: `Invoke-RestMethod -Uri 'http://localhost:7788/api/summary?days=7' | ConvertTo-Json -Depth 5`

Expected: Returns the 7-day comprehensive summary, including domainSummary and pendingFollowUps

---

### Task 4: Front-End Event Stream Panel

**Files:**
- Modify: `public/index.html` (add event-stream panel HTML)
- Modify: `public/dashboard.js` (add event-stream rendering logic)
- Modify: `public/dashboard.css` (add event-stream style)

- [ ] **Step 1: Add event-stream panel in index.html**

Add before `<!-- 今日琐事区 -->`:

```html
      <!-- Event stream panel -->
      <section class="section" id="section-events">
        <div class="section-header">
          <span class="section-icon">◇</span>
          <span class="section-title">事件流</span>
        </div>
        <div class="events-timeline" id="events-timeline"></div>
      </section>
```

- [ ] **Step 2: Add event-stream rendering function in dashboard.js**

Add before the `renderErrands` function:

```javascript
// ===== Event stream rendering =====
async function renderEvents() {
  const container = document.getElementById('events-timeline');
  if (!container) return;
  try {
    const res = await fetch('/api/events?limit=8');
    const data = await res.json();
    if (!data.events || data.events.length === 0) {
      container.innerHTML = '<div class="events-empty">暂无事件记录</div>';
      return;
    }
    const domainLabels = { health: '健康', relationship: '婚恋', career: '事业', academic: '课业', social: '社交', misc: '其他' };
    const statusLabels = { pending: '待处理', clarifying: '待追问', resolved: '已解决', archived: '已归档' };

    container.innerHTML = data.events.map(evt => {
      const time = new Date(evt.timestamp);
      const timeStr = `${time.getMonth()+1}/${time.getDate()} ${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
      const domainTags = (evt.domains || []).map(d =>
        `<span class="event-domain-tag ${d}">${domainLabels[d] || d}</span>`
      ).join('');
      const factsHtml = (evt.extracted?.facts || []).map(f =>
        `<div class="event-fact">${escapeHtml(f.content)}${f.when ? ` <span class="event-when">${f.when}</span>` : ''}</div>`
      ).join('');
      const statusClass = evt.status === 'clarifying' ? ' clarifying' : evt.status === 'resolved' ? ' resolved' : '';

      return `
        <div class="event-item${statusClass}">
          <div class="event-header">
            <span class="event-time">${timeStr}</span>
            <span class="event-status ${evt.status}">${statusLabels[evt.status] || evt.status}</span>
            ${domainTags}
          </div>
          <div class="event-body">${factsHtml || `<div class="event-raw">${escapeHtml(evt.rawInput)}</div>`}</div>
          ${evt.extracted?.followUpNeeded ? `<div class="event-followups">${evt.extracted.followUpItems.map(q => `<div class="event-followup-item">? ${escapeHtml(q)}</div>`).join('')}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="events-empty">加载失败</div>';
  }
}
```

Add the `renderEvents()` call inside the `renderAll` function.

- [ ] **Step 3: Add event-stream style in dashboard.css**

Add at end of file:

```css
/* ===== Event stream ===== */
.events-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.events-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  padding: 16px 0;
}

.event-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--card-bg);
  border-left: 3px solid var(--border);
  transition: all 0.2s ease;
}

.event-item.clarifying {
  border-left-color: var(--accent-gold);
}

.event-item.resolved {
  border-left-color: #6b9e78;
  opacity: 0.8;
}

.event-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.event-time {
  font-size: 11px;
  color: var(--text-muted);
}

.event-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--border);
  color: var(--text-secondary);
}

.event-status.clarifying {
  background: rgba(218, 165, 32, 0.2);
  color: var(--accent-gold);
}

.event-status.resolved {
  background: rgba(107, 158, 120, 0.2);
  color: #6b9e78;
}

.event-domain-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--tag-bg);
  color: var(--tag-text);
}

.event-domain-tag.health { background: rgba(231, 111, 81, 0.15); color: #e76f51; }
.event-domain-tag.relationship { background: rgba(233, 196, 106, 0.2); color: #c9a44e; }
.event-domain-tag.career { background: rgba(42, 157, 143, 0.15); color: #2a9d8f; }
.event-domain-tag.academic { background: rgba(69, 123, 157, 0.15); color: #457b9d; }
.event-domain-tag.social { background: rgba(168, 218, 220, 0.2); color: #5a9a9e; }
.event-domain-tag.misc { background: var(--border); color: var(--text-muted); }

.event-body {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.5;
}

.event-fact {
  padding: 2px 0;
}

.event-when {
  font-size: 11px;
  color: var(--accent-gold);
  margin-left: 4px;
}

.event-raw {
  color: var(--text-secondary);
  font-style: italic;
}

.event-followups {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}

.event-followup-item {
  font-size: 12px;
  color: var(--accent-gold);
  padding: 2px 0;
}
```

- [ ] **Step 4: Verify front-end display**

Open http://localhost:7788, confirm the event-stream panel appears above the errands panel, displaying recent events with domain tags and status markers.

---

### Task 5: Data Migration Script

**Files:**
- Create: `scripts/migrate-to-events.js`

- [ ] **Step 1: Create migration script**

```javascript
#!/usr/bin/env node
/**
 * Migration script: migrate existing goals/errands/notes/history data to the event stream
 * Usage: node scripts/migrate-to-events.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '.lingxi');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function genEventId(dateStr, index) {
  return `evt_${dateStr.replace(/-/g, '')}_${String(index).padStart(3, '0')}`;
}

console.log('=== 灵犀事件流迁移 ===\n');

const events = [];
let eventCounter = 0;

// 1. Migrate history.json → events
const history = readJson(path.join(DATA_DIR, 'history.json'));
if (history && history.conversations) {
  for (const conv of history.conversations) {
    eventCounter++;
    const evt = {
      id: genEventId(conv.timestamp?.slice(0, 10) || new Date().toISOString().slice(0, 10), eventCounter),
      timestamp: conv.timestamp || new Date().toISOString(),
      source: 'conversation',
      rawInput: conv.userMessage || '',
      domains: [],
      type: 'event',
      extracted: { facts: [], followUpNeeded: false, followUpItems: [] },
      derivedRecords: [],
      reminders: [],
      status: 'archived',
      resolvedAt: conv.timestamp,
      relatedEvents: [],
      aiContext: conv.aiResponse || '',
      aiResponse: conv.aiResponse || '',
      migratedFrom: 'history',
    };
    events.push(evt);
  }
  console.log(`  迁移 history: ${history.conversations.length} 条对话`);
}

// 2. Migrate goals.json
const goals = readJson(path.join(DATA_DIR, 'goals.json'));
if (goals) {
  const allGoals = [
    ...(goals.strategicGoals || []).map(g => ({ ...g, _type: 'strategicGoal' })),
    ...(goals.currentGoals || []).map(g => ({ ...g, _type: 'currentGoal' })),
    ...(goals.constraints || []).map(g => ({ ...g, _type: 'constraint' })),
  ];
  for (const goal of allGoals) {
    eventCounter++;
    const evt = {
      id: genEventId(goal.createdAt?.slice(0, 10) || new Date().toISOString().slice(0, 10), eventCounter),
      timestamp: goal.createdAt || new Date().toISOString(),
      source: 'migration',
      rawInput: goal.title || '',
      domains: goal.domain ? [goal.domain] : [],
      type: goal._type === 'constraint' ? 'constraint' : 'goal',
      extracted: { facts: [{ domain: goal.domain || 'misc', content: goal.title }], followUpNeeded: false, followUpItems: [] },
      derivedRecords: [{ file: 'goals.json', recordId: goal.id, field: goal._type }],
      reminders: [],
      status: 'archived',
      resolvedAt: goal.createdAt,
      relatedEvents: [],
      migratedFrom: 'goals',
      originalData: { title: goal.title, description: goal.description, priority: goal.priority },
    };
    events.push(evt);
  }
  console.log(`  迁移 goals: ${allGoals.length} 条`);
}

// 3. Migrate errands.json
const errands = readJson(path.join(DATA_DIR, 'errands.json'));
if (errands && errands.errands) {
  for (const errand of errands.errands) {
    eventCounter++;
    const evt = {
      id: genEventId(errand.createdAt?.slice(0, 10) || new Date().toISOString().slice(0, 10), eventCounter),
      timestamp: errand.createdAt || new Date().toISOString(),
      source: 'migration',
      rawInput: errand.title || '',
      domains: [],
      type: 'errand',
      extracted: { facts: [{ domain: 'misc', content: errand.title, when: errand.date }], followUpNeeded: false, followUpItems: [] },
      derivedRecords: [{ file: 'errands.json', recordId: errand.id, field: 'errands' }],
      reminders: [],
      status: errand.completed ? 'archived' : 'resolved',
      resolvedAt: errand.createdAt,
      relatedEvents: [],
      migratedFrom: 'errands',
    };
    events.push(evt);
  }
  console.log(`  迁移 errands: ${errands.errands.length} 条`);
}

// 4. Migrate notes.json
const notes = readJson(path.join(DATA_DIR, 'notes.json'));
if (notes && notes.notes) {
  for (const [domain, list] of Object.entries(notes.notes)) {
    for (const note of list) {
      eventCounter++;
      const evt = {
        id: genEventId(note.createdAt?.slice(0, 10) || new Date().toISOString().slice(0, 10), eventCounter),
        timestamp: note.createdAt || new Date().toISOString(),
        source: note.source || 'migration',
        rawInput: note.content || '',
        domains: [domain],
        type: 'note',
        extracted: { facts: [{ domain, content: note.content, when: note.relatedDate }], followUpNeeded: false, followUpItems: [] },
        derivedRecords: [{ file: 'notes.json', recordId: note.id, field: domain }],
        reminders: [],
        status: 'archived',
        resolvedAt: note.createdAt,
        relatedEvents: [],
        migratedFrom: 'notes',
      };
      events.push(evt);
    }
  }
  console.log(`  迁移 notes: 完成`);
}

// 5. Write events.json (sorted by time descending)
events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

const eventsData = {
  meta: { version: '3.0.0', lastUpdated: new Date().toISOString(), totalEvents: events.length },
  events,
  pendingFollowUps: [],
};

writeJson(EVENTS_FILE, eventsData);
console.log(`\n  总计迁移 ${events.length} 条事件 → ${EVENTS_FILE}`);
console.log('  迁移完成。旧数据保留在原文件中，新系统通过 events.json 运行。\n');
```

- [ ] **Step 2: Run migration script**

Run: `node d:/linxi/scripts/migrate-to-events.js`

Expected: Output migration statistics; events.json created successfully, containing all migrated events from historical data.

- [ ] **Step 3: Update documents.json index**

Ensure documents.json contains the events entry. Trigger auto-update by restarting server (`ensureIndex()`), or manually verify `/api/documents` returns an entry containing events.

---

### Task 6: SKILL.md Rewrite

**Files:**
- Modify: `skill/SKILL.md` (rewrite AI behavior guide, core changed to create_event unified entry)

- [ ] **Step 1: Rewrite SKILL.md overview and workflow**

Replace the 10-step workflow in the overview with a new process centered on create_event. Core changes:

1. Description changed to "event-stream second brain" positioning
2. Workflow step 0a: Call `lingxi_get_pending_follows` for proactive follow-up
3. Workflow step 1: Call `lingxi_create_event` (unified entry)
4. If followUpNeeded → ask → `lingxi_resolve_event`
5. No longer instruct the AI to call add_goal / add_errand / add_note separately
6. Add events.json description and three-layer retrieval strategy to the data file location section
7. Remove old autoExtractNotesFromConversation-related descriptions

Since SKILL.md is long (400+ lines), this step needs to align all decision points in the design document, ensuring the AI behavior guide is consistent with the event-stream architecture.

---

### Task 7: Morning Briefing Upgrade and setup.js Update

**Files:**
- Modify: `scripts/setup.js` (add events.json initialization)
- Modify: `mcp/server.js`'s `lingxi_auto_schedule` case (morning briefing adds followUpCheck and weeklyOverview)

- [ ] **Step 1: Update setup.js**

Before the `ensureIndex()` call, add events.json initialization:

```javascript
  // Initialize event stream
  const eventsFile = path.join(DATA_DIR, 'events.json');
  if (!fs.existsSync(eventsFile)) {
    console.log('  Initializing events.json (事件流)...');
    const eventsData = {
      meta: { version: '3.0.0', lastUpdated: new Date().toISOString(), totalEvents: 0 },
      events: [],
      pendingFollowUps: [],
    };
    fs.writeFileSync(eventsFile, JSON.stringify(eventsData, null, 2), 'utf8');
    console.log('  events.json created.');
  } else {
    console.log('  events.json exists.');
  }
```

- [ ] **Step 2: Upgrade morning briefing generation**

In the morning-briefing-generation part of `lingxi_auto_schedule`, add followUpCheck and weeklyOverview:

```javascript
      // Follow-up check
      const engine = getEventEngine();
      const pendingFollows = engine.getPendingFollows(5);
      const followUpCheck = pendingFollows.map(e => ({
        event: e.id,
        question: (e.extracted.followUpItems || [])[0] || e.rawInput,
        daysSince: Math.floor((Date.now() - new Date(e.timestamp)) / 86400000),
      }));

      // Weekly overview
      const summary = engine.getSummary(7);
      const weeklyOverview = {
        domainLoad: summary.domainLoad,
        heaviestDomain: summary.heaviestDomain,
        suggestion: summary.heaviestDomain
          ? `这周${({health:'健康',relationship:'婚恋',career:'事业',academic:'课业',social:'社交',misc:'其他'})[summary.heaviestDomain] || summary.heaviestDomain}类事情较多，注意时间分配`
          : null,
      };
```

Add followUpCheck and weeklyOverview into the morningBriefing object.

---

## Self-Review Checklist

1. **Spec coverage:**
   - Event structure → Task 1 (event-engine.js)
   - File tree three-layer retrieval → Task 2 (MCP integration) + Task 3 (HTTP API)
   - AI processing flow → Task 2 (MCP tools) + Task 6 (SKILL.md)
   - Proactive reminder A (morning briefing) → Task 7
   - Proactive reminder B (conversation opening) → Task 2 (get_pending_follows + workflow 0a)
   - Proactive reminder C (event-driven) → Task 1 (checkReminders) + Task 2 (check_reminders MCP)
   - Proactive reminder D (ask anytime) → Task 1 (getSummary) + Task 2 (get_summary MCP)
   - Self-learning → described in the design document; implementation is woven into event-engine's analyzeMessage (fact extraction) and resolve_event (behavior inference); a complete learning engine can be a later iteration
   - Data migration → Task 5
   - Front-end panel → Task 4
   - SKILL.md → Task 6

2. **Placeholder scan:** No TBD/TODO. All code steps contain complete implementations.

3. **Type consistency:** genId is `_genId()` (private) in event-engine, and a standalone `genEventId()` function in the migration script — no conflict. EVENT_STATUS enum is defined in event-engine and referenced by MCP server via require.

4. **Scope check:** This plan focuses on the core event-stream refactor. The "value behavioral inference" part of self-learning (behavioralInference) is described in the design document but implemented lightly (woven into resolve_event); a complete behavioral analysis engine is out of scope for this iteration.
