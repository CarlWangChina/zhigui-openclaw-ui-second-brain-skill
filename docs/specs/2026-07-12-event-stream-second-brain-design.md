# Event-Stream Second Brain — Design Document

> Date: 2026-07-12
> Status: Pending Review
> Author: Brainstorming Session

## Background and Problem

### Problems with the Current System

Lingxi currently forces every sentence the user says into isolated buckets:
- "Development goal" → scheduled
- "Errand" → to-do list, not scheduled
- "Note" → stored and basically never looked at again

**Typical problem case**: The user says "Tomorrow I have to accompany my wife to the hospital to have a tooth pulled, and in the afternoon I still need to reply to my company leader's message about the new project." The system throws it into the errands list — it is neither scheduled nor does it follow up on time details, nor does it make cross-domain associations.

This is not a bug; it is an architecture design problem — "errands" are treated as second-class citizens, whereas real-life events are cross-domain, require follow-up, and need to be remembered.

### User Expectations

Confirmed via brainstorming, the user's expectations for the "second brain" are:

1. **Follow-up then schedule** (don't auto-schedule; clarify details first)
2. **Long-term memory** (everything said becomes accumulated knowledge, retrievable anytime)
3. **Proactive reminders** (not "only when you ask," but the system proactively reaches out to you)
4. **Cross-domain association** (discover multiple-domain events happening in the same week and proactively warn of time pressure)
5. **Self-learning** (learn habits and values from behavior; the more you use it, the better it understands you)

### Architecture Decisions

- **Core refactor**: Use the event stream as the underlying source of truth; existing goals/errands/notes become views derived from events
- **Preserve the file tree**: Different types go to different files to reduce AI context length and save tokens
- **All four reminder types required**: Morning briefing upgrade + conversation-opening prompt + event-driven + ask-anytime

---

## I. Event Structure

### Event Data Structure

```json
{
  "id": "evt_20260712_001",
  "timestamp": "2026-07-12T14:30:00.000Z",
  "source": "conversation",
  "rawInput": "明天要陪老婆去医院拔牙，下午还要回公司领导的消息关于新项目",

  "domains": ["health", "relationship", "career"],
  "type": "event",

  "extracted": {
    "facts": [
      { "domain": "health",       "content": "陪老婆去医院拔牙", "when": "明天" },
      { "domain": "relationship",  "content": "老婆要拔牙" },
      { "domain": "career",        "content": "公司领导发消息关于新项目", "when": "明天下午" }
    ],
    "followUpNeeded": true,
    "followUpItems": ["明天几点去医院？", "大概多长时间？", "下午几点回领导消息？"]
  },

  "derivedRecords": [
    { "file": "schedule.json", "recordId": "t_xxx", "field": "tasks" },
    { "file": "notes.json",    "recordId": "note_xxx", "field": "health" },
    { "file": "notes.json",    "recordId": "note_yyy", "field": "relationship" }
  ],

  "reminders": [
    {
      "type": "deadline_approaching",
      "condition": { "daysBefore": 3 },
      "triggerDate": "2026-07-15",
      "message": "论文初稿这周五要交，还剩3天",
      "triggered": false
    },
    {
      "type": "no_mention",
      "condition": { "daysSilent": 5 },
      "message": "你5天没提到考研复习了，进度怎么样？",
      "triggered": false
    },
    {
      "type": "domain_overload",
      "condition": { "sameDomainInWeek": 4 },
      "message": "这周事业类事件已4件，注意别过载",
      "triggered": false
    }
  ],

  "status": "pending",
  "resolvedAt": null,
  "relatedEvents": ["evt_20260705_003"]
}
```

### Field Description

| Field | Type | Description |
|------|------|------|
| `id` | string | Unique event ID, format `evt_YYYYMMDD_NNN` |
| `timestamp` | ISO | Creation time |
| `source` | enum | `conversation` / `automation` / `user_action` |
| `rawInput` | string | User's original words |
| `domains` | string[] | Domains involved in the event (can be multi-domain) |
| `type` | enum | `event` / `goal` / `errand` / `note` / `constraint` / `decision` |
| `extracted.facts` | array | Facts extracted from the event; each fact is bound to a domain |
| `extracted.followUpNeeded` | bool | Whether follow-up is needed |
| `extracted.followUpItems` | string[] | Specific questions that need follow-up |
| `derivedRecords` | array | List of records derived into the file tree |
| `reminders` | array | Event-driven reminder rules |
| `status` | enum | `pending` → `clarifying` → `resolved` → `archived` |
| `resolvedAt` | ISO\|null | Timestamp after the user answers the follow-up |
| `relatedEvents` | string[] | IDs of other related events |

### Event Lifecycle

```
pending → clarifying → resolved → archived
  │          │            │
  │          │            └── Not mentioned for over 30 days
  │          └── Needs follow-up; after user answers
  └── Just created, awaiting analysis
```

### events.json File Structure

```json
{
  "meta": {
    "version": "3.0.0",
    "lastUpdated": "2026-07-12T14:30:00.000Z",
    "totalEvents": 0
  },
  "events": [],
  "pendingFollowUps": []
}
```

`pendingFollowUps` is an index array storing the IDs of all events whose `status` is `pending` or `clarifying`, so the system can find events needing follow-up without iterating over all events.

---

## II. File Tree Structure (Three-Layer Retrieval)

### Full File Tree

```
.lingxi/

├── documents.json          ← Layer 0: file index
│   └── Lists the purpose/size/update time of all files
│
├── events.json             ← Layer 1: event stream (core, new)
│   ├── Complete records of all events
│   ├── pendingFollowUps index
│   └── AI reads here first to understand global context
│
├── goals.json              ← Layer 2: categorized content
├── schedule.json           ← Layer 2
├── errands.json            ← Layer 2
├── notes.json              ← Layer 2
├── decisions.json          ← Layer 2
├── userProfile.json        ← Layer 2
│
├── history.json            ← Kept, raw conversation records
└── state.json              ← Kept, aggregated fallback copy
```

### AI Read Strategy (Core of Token Saving)

| Scenario | Read Order | Read Volume |
|------|---------|--------|
| User just chatting | `events.json` (only latest 10) | ~2KB |
| User asks about schedule | `schedule.json` | ~2KB |
| User asks "how have things been lately" | `events.json` (latest 30) + `notes.json` | ~4KB |
| User adds new goal | `goals.json` (only currentGoals) | ~1KB |
| Morning briefing generation | `events.json` (pendingFollowUps) + `schedule.json` + `goals.json` | ~5KB |
| Full read (rarely needed) | `state.json` | ~10KB+ |

### documents.json Index Update

New events.json entry:

```json
{
  "type": "events",
  "title": "事件流",
  "description": "所有用户对话和系统操作的统一事件记录，是系统真相源。AI 应先读这里了解全局上下文",
  "size": 4096,
  "lastUpdated": "2026-07-12T14:30:00.000Z",
  "readStrategy": "默认只读最近10条；生成晨报时读pendingFollowUps；用户问'最近怎么样'时读最近30条"
}
```

### File Tree Records Link to Events

Each record in the file tree adds a new `sourceEventId` field:

```json
{
  "id": "note_xxx",
  "sourceEventId": "evt_20260712_001",
  "domain": "health",
  "content": "陪老婆去医院拔牙",
  "createdAt": "..."
}
```

When AI reads notes.json and needs more context, it can trace back to the complete event in events.json via `sourceEventId`.

---

## III. AI Processing Flow

### Processing Flow (7 Steps)

```
User speaks
  │
  ▼
① Create event (events.json)
   - Parse out facts, mark multiple domains
   - Mark clarifying + followUpItems when info is missing
  │
  ▼
② AI asks the user for follow-up (does not auto-schedule)
   - Ask questions based on followUpItems
  │
  ▼
③ User answers → update event status to resolved
   - Supplement time info into extracted.facts
  │
  ▼
④ Derive and write into file tree (automatic)
   - schedule.json ← schedule it
   - notes.json ← notes per domain
   - Each record writes sourceEventId
  │
  ▼
⑤ Association analysis
   - Check conflicts (time/constraint/overload)
   - Check relatedEvents (historical associations)
   - Check domain load
  │
  ▼
⑥ Update userProfile (self-learning)
   - Fact learning: extract new user traits from events
   - Value learning: infer priorities from behavior
  │
  ▼
⑦ Reply to user
   - Confirm it has been scheduled
   - Warn of conflicts (if any)
   - Association reminders (if any)
```

### Core Difference from Current System

| Stage | Current System | New System |
|------|---------|--------|
| Entry | AI judges category → calls add_goal/add_errand/add_note separately | Unified call to create_event |
| Follow-up | No follow-up, store directly | When info is missing, mark clarifying; must follow up before scheduling |
| Scheduling | Errands don't go into schedule | After event resolved, auto-derived to schedule |
| Sedimentation | Keyword matching, create standalone note | Extract facts from event, note carries sourceEventId |
| Association | None | Events connected via relatedEvents |
| Learning | No learning | Auto-update userProfile from every conversation |

### MCP Tool Changes

5 new tools added:

1. **`lingxi_create_event`** — Unified entry point, replaces scattered add_goal/add_errand/add_note
2. **`lingxi_resolve_event`** — After user answers follow-up, supplement info and trigger derivation
3. **`lingxi_get_pending_follows`** — Get the list of events pending follow-up
4. **`lingxi_get_summary`** — Comprehensive analysis; user can ask "how have things been lately" anytime
5. **`lingxi_check_reminders`** — Check whether event-driven reminders have triggered

1 tool modified:

- **`lingxi_add_history`** — No longer auto-extracts notes (handled uniformly by create_event); only records conversation history

### Tool Call Flow Comparison

**Current** (AI needs to decide which tool to call, 4 calls):
```
User speaks → AI judges "this is an errand" → add_errand
                              → add_note (health)
                              → add_note (relationship)
                              → add_history
```

**New system** (unified entry, 2 calls):
```
User speaks → create_event (1 call, system handles everything automatically)
User answers follow-up → resolve_event (1 call, after supplementing info, auto-derives)
```

---

## IV. Proactive Reminder System

### 1. Morning Briefing Upgrade (A)

Executes automatically at 8:00 every day, containing 4 sections:

```json
{
  "morningBriefing": {
    "date": "2026-07-13",
    "mustDo": "上午9点陪老婆去医院拔牙",
    "recommended": "今天有空的话复习一下高数第3章",
    "notRecommended": "注意不要熬夜，23点前睡觉",
    "strategicReminder": "考研倒计时165天，数学进度落后于计划",

    "followUpCheck": {
      "items": [
        { "event": "evt_20260705_003", "question": "上周你说胃不舒服，后来去看了吗？", "daysSince": 7 },
        { "event": "evt_20260710_002", "question": "导师催论文的初稿这周五要交，进展如何？", "daysSince": 2 }
      ]
    },

    "weeklyOverview": {
      "domainLoad": { "health": 2, "career": 4, "academic": 3, "relationship": 1 },
      "heaviestDomain": "career",
      "suggestion": "这周事业类事情较多，建议推迟非必要社交"
    },

    "dailyQuote": "种一棵树最好的时间是十年前，其次是现在"
  }
}
```

**Trigger**: Executes automatically at 8:00 every day (automation already exists; just modify the content)

### 2. Proactive Prompt When Opening a Conversation (B)

Every time the user starts a new conversation, the AI's first action is to scan `pendingFollowUps`:

```
AI: Good morning. There are two things I'd like to follow up on:
1. Last week you said your stomach was uncomfortable, did you go get it checked?
2. Your advisor is pushing for the thesis draft due this Friday, how is it coming along?

After these two, what else do you have planned for today?
```

**Implementation**: Add step 0a to the workflow in `lingxi_get_instructions`:
```
0a. Call lingxi_get_pending_follows → if there are unfollowed events → proactively bring them up to the user
```

### 3. Event-Driven Reminder (C)

Create reminder rules synchronously when an event is created; trigger when conditions are met:

| Reminder Type | Trigger Condition | Example |
|---------|---------|------|
| `deadline_approaching` | N days before deadline | "Thesis draft due this Friday, 3 days left" |
| `no_mention` | Event not mentioned for N days | "You haven't mentioned grad-school review in 5 days, how is it going?" |
| `domain_overload` | Over N events in same domain within a week | "4 career-type events this week, watch out for overload" |

**Check timing**: Each time create_event is called, plus during morning briefing generation.

### 4. Ask Anytime (D)

The user can ask "how have I been lately" anytime, and the system analyzes comprehensively from the event stream:

```
User: How have I been lately?

AI: Here's a summary of the last two weeks —

Health: You said on July 5 your stomach was uncomfortable, but it's not followed up whether you saw a doctor. Suggest handling it this week.
Relationship: On July 12 you accompanied your wife to the hospital for tooth extraction, already scheduled for tomorrow.
Career: A busy week, the company's new project kicked off, your leader reached out to you. 4 career-type events have occurred.
Academic: Thesis draft due Friday, but you only mentioned it once, progress unclear.
Social: No social activities recently.

Overall suggestion: High dual pressure from career + academics this week, suggest pushing social activities to next week. Also don't forget to follow up on the stomach issue.
```

### Reminder System Overview

| Type | Trigger Timing | Data Source | Tool |
|------|---------|---------|------|
| Morning briefing upgrade | 8:00 daily | events + schedule + goals | Modify `lingxi_set_briefing` |
| Conversation opening | Every new conversation | events.pendingFollowUps | `lingxi_get_pending_follows` |
| Event-driven | When condition met | events.reminders | `lingxi_check_reminders` |
| Ask anytime | User asks actively | events (comprehensive analysis) | `lingxi_get_summary` |

---

## V. Self-Learning Mechanism

### 1. Fact Learning (extracted from events)

Each time create_event is called, automatically check whether it contains new user-profile information:

```
User says "Tomorrow I have to accompany my wife to the hospital for tooth extraction"
  → Fact extraction: user has a wife → userProfile.basicInfo.maritalStatus = "married"
  → Fact extraction: wife is getting tooth pulled → record to health domain, can be associated in future

User says "Advisor is pushing for thesis"
  → Fact extraction: user is a graduate student → userProfile.basicInfo.occupation = "graduate student"
  → Fact extraction: has an advisor → userProfile.affiliations = ["导师"]
```

No need to update every time; only incrementally update when new information is detected. Learning rules are stored in `learnedFacts` of userProfile to avoid duplication.

### 2. Value Learning (inferred from behavior)

What choices the user makes reflects what they truly value:

| Behavioral Signal | Inference |
|---------|------|
| User says "I have to accompany my wife to the hospital tomorrow" + user confirms the time | Values relationship |
| User says "advisor is pushing for thesis" but hasn't followed up for 3 consecutive days | Academic priority may be lower than expected |
| User studies at 9am for 5 consecutive days | Prefers morning study |

These inferences are written to `userProfile.valueSystem.behavioralInference`, stored separately from the user's explicitly declared `valueSystem.priorities`. When the AI schedules, it references both, with behavioral inference weighted lower than explicit declarations.

---

## VI. Data Migration

### Migration Plan

Migration script `scripts/migrate-to-events.js`:

```
Step 1: Create events.json (empty)
Step 2: Iterate over each conversation in history.json → create event
Step 3: Iterate over goals.json → create an event for each goal, derivedRecords points to itself
Step 4: Iterate over errands.json → same as above
Step 5: Iterate over notes.json → same as above
Step 6: Add sourceEventId field to all existing records
Step 7: Write aggregated copy to state.json
```

After migration, old data is retained (not deleted); the new system runs via dual-write of events.json + file tree.

---

## VII. Front-End Dashboard Changes

Minimal dashboard changes — only add the event-stream timeline and follow-up reminders:

1. **New "Event Stream" panel**: Display the recent event stream (timeline form) at the top of the dashboard; each event shows a status label (pending / resolved)
2. **Morning briefing area upgrade**: Add follow-up reminders and weekly overview sections
3. **Existing panels retained**: Goal/errand/note/schedule panels unchanged; data source changes from direct read/write to being derived from events

---

## VIII. Refactoring Scope Summary

| File | Change Type | Description |
|------|---------|------|
| `.lingxi/events.json` | New | Event stream data |
| `mcp/server.js` | 5 new tools + 1 modified tool | create_event, resolve_event, get_pending_follows, get_summary, check_reminders; modify add_history |
| `server/server.js` | 3 new APIs | /api/events, /api/pending-follows, /api/summary |
| `public/dashboard.js` | New rendering | Event stream timeline, follow-up reminders |
| `public/index.html` | New panel | Event stream panel |
| `public/dashboard.css` | New style | Event stream style |
| `skill/SKILL.md` | Rewrite | AI behavior guide, core changed to create_event unified entry |
| `scripts/migrate-to-events.js` | New | Data migration script |
| `.lingxi/documents.json` | Update | Add events entry |

Of the existing 33 MCP tools, most remain unchanged (get_state, get_today, auto_schedule, etc.); only 5 new tools are added and 1 is modified. Front-end changes only add panels, without breaking existing functionality.
