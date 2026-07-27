# Lingxi (灵犀) Project Full Code Review Report

> Review date: 2026-07-16
> Scope: Front-end dashboard, MCP/AI service layer, Electron main process, HTTP service, event engine, second-brain index, scripts, startup flow, data layer
> Conclusion: **No crash-causing syntax/runtime bugs (all JS passes `node --check`; the 14 MCP tools were tested live with no exceptions).** The main issues are concentrated in **dual-storage-architecture data inconsistency** and **cross-platform / cross-mode behavioral divergence**, the most severe of which causes "panel manual edits to be invisible to the AI, and potentially overwritten by AI write-backs."

---

## Severity Overview

| Level | Count | Key Items |
|------|------|--------|
| 🔴 P0 Critical | 1 | Dual-storage divergence: panel manual edits invisible to AI + may be overwritten |
| 🟠 P1 Moderate | 3 | `briefings` three-day window not persisted / cross-platform init inconsistency / `topicThreshold` config drift |
| 🟡 P2 Minor | 5 | `decisionLog` misleading comment / dead code / three duplicated persistence layers / migration script unprotected / standalone recalc script deviation |

---

## 🔴 P0 — Dual-Storage Architecture Divergence (Core Data Consistency Defect)

### Symptom
None of the manual edits made on the Electron panel are visible to the AI/MCP layer; conversely, AI write-backs may **overwrite** the changes the panel just made.

### Root Cause
The project has two parallel sources of truth:

1. **Split documents (primary source of truth for the AI/MCP layer)**: `goals.json` / `schedule.json` / `errands.json` / `notes.json` / `decisions.json` / `userProfile.json` / `events.json`. `mcp/server.js`'s `readState()` (lines 130–167) **prefers to aggregate the split documents**, and only falls back to reading `state.json` (lines 147–153) when "all split documents are empty."
2. **`state.json` (primary source of truth for the Electron panel)**: All of `electron/main.js`'s IPC handlers only read and write `state.json` (the constants don't even contain `GOALS_FILE`/`SCHEDULE_FILE`).

Specific verification (`electron/main.js`):
- `get-state` → reads only `STATE_FILE` (line 239)
- `toggle-task` → reads/writes only `STATE_FILE` (lines 249, 259)
- `update-priority` / `unlock-priority` → only `STATE_FILE` (lines 266/293, 300/313)
- `add-goal` → only `STATE_FILE` (lines 462, 485)
- `add-event` → `STATE_FILE` + writes `events.json` via `EventEngine` (lines 323, 350)

### Two Direct Consequences
- **Consequence A (invisible)**: When the user checks off a task, changes a priority, or adds a goal on the panel, it only goes into `state.json`. Since `setup.js` (Windows) pre-creates all split documents, they are "never empty," so `readState()` always takes the split-document branch and **never reads the manual edits the panel wrote into `state.json`**. The AI's premise of "learning from user interactions" is broken.
- **Consequence B (overwritten / data loss)**: `writeState()` (lines 169–191) writes the AI's complete in-memory `state` back to **both the split documents and `state.json`**. The AI's `state` comes from aggregating the split documents and itself does not contain the panel's just-made manual edits; when the AI writes back, it overwrites the panel's recent edits in `state.json` with stale data. **That is: panel edits are not only invisible, but may also be lost on the next AI write-back.**

> Note: Because `add-event` goes through `EventEngine` and writes to `events.json` (the event stream), "manually adding an event" can be captured by the second brain; but goal/task/priority-type edits are not in the event stream and are completely lost.

### Recommendations (pick any one)
- **Recommended**: Make the Electron IPC handlers also call the unified persistence layer (same source as `writeState` in `mcp/server.js`), so manual edits are also written to the corresponding split documents; or have panel edits first go through `create_event` into the event stream, and be uniformly derived by the event engine.
- **Minimal stopgap**: In `readState()`, merge keys that exist in `state.json` but are absent/modified later in the split documents (resolved by the `meta.lastUpdated` timestamp) to eliminate "overwrites."

---

## 🟠 P1 — Moderate

### 1. `briefings` three-day window never persisted read-back (functionally hollow + cross-mode divergence)
- `auto_schedule` writes a **3-day rolling window** into `state.briefings[dateStr]` (line 2970 resets, `3034` writes, `3066` syncs `morningBriefing` = today).
- But `briefings` is **not** in `DOCUMENT_KEYS` (lines 82–89), so `writeState` will not write it into any split document; only the `state.json` fallback copy (lines 187–190) carries it.
- As a result:
  - **Electron mode**: `get-state` reads `state.json` (which contains `briefings`), so it can be retrieved → appears normal.
  - **HTTP mode**: `get-state` → `readMergedState()` (aggregates only split documents), **does not contain `briefings`** → the dashboard's `renderBriefing` falls back to `state.morningBriefing` (today only). When switching dates, the non-today view will **erroneously display today's morning briefing**.
  - **MCP layer**: `readState()` likewise does not aggregate `briefings`, and discards it on the next read → the three-day window is completely ineffective on the AI side.
- **Recommendation**: Add `briefings` to `DOCUMENT_KEYS` (e.g., add a `briefings` key under the `schedule` document), or change `morningBriefing` to be stored by date directly as an object `morningBriefing[date]`, ensuring consistency across HTTP / Electron / MCP.

### 2. Cross-platform initialization inconsistency (Windows full vs macOS/Linux partial)
- `start.bat` → calls `scripts/setup.js`, **fully initializing** split documents + `events.json` + `documents.json` index + `history.json`.
- `start.sh` (macOS/Linux) **only creates** `state.json` + `history.json`, and generates `config.json`/`SKILL.md` inline; it does **not create** split documents, `events.json`, or `documents.json`.
- Consequence: On macOS/Linux, the MCP depends on the "all split documents empty → fall back to state.json" branch to run; the two-layer-retrieval `documents.json` index is only generated on the first MCP write, during which the two-layer retrieval degrades. Robustness differs between the two platforms.
- **Recommendation**: Have `start.sh` also call `scripts/setup.js` (or extract a common initialization function) to eliminate duplication and ensure consistency.

### 3. `topicThreshold` config drift (code intent vs actual data)
- Code `DEFAULT_THRESHOLD = 6` (`brain-index.js:26`); both the working memory and comments say "lowered to 6, easier to trigger sedimentation and save tokens."
- But the shipped `.lingxi/index.json` actually contains `"topicThreshold": 10`.
- `getThreshold()` (line 118) prioritizes reading `idx.meta.topicThreshold`, so **the actually effective threshold is 10, not 6**; whereas a freshly initialized index is set to 6 (line 104). The same code behaves differently under different data states, and deviates from the design intent.
- **Recommendation**: Unify to 6 (or explicitly change `index.json` to 6 and sync the comments), and add a temporal note in `getThreshold` stating "the persisted value takes precedence."

---

## 🟡 P2 — Minor / Technical Debt

### 1. `decisionLog` 180-cap does not match comment
- `mcp/server.js:2870-2871` truncates with `slice(-180)` (to prevent unbounded growth, which is reasonable), but an old nearby comment says "keep last 30 days," which is misleading. The current `decisions.json` has reached ~105KB (180-item cap). Suggest fixing the comment, and consider truncating by time (30 days) rather than by count.

### 2. Dead code: root `index.html` + `assets/app.js`
- The root `index.html` (42KB) and `assets/app.js` (2161 lines) are an independent old Demo (login/chat/goal pages) that is **neither loaded by the HTTP service (serves `public/`) nor by Electron (loads `public/index.html`)**. This is technical debt that should be cleaned up or explicitly archived to avoid accidental modification.

### 3. Three nearly duplicated persistence implementations
- `server/server.js`'s `readMergedState/writeMergedState`, `mcp/server.js`'s `readState/writeState`, and `electron/main.js`'s direct `state.json` read/write — three sets of logic evolving separately. The current `briefings`/`DOCUMENT_KEYS` divergence is a direct product of this.
- **Recommendation**: Extract a shared `storage.js` module (split-document read/write + aggregation + fallback) used by all three ends, eliminating drift at the root.

### 4. `scripts/migrate-to-events.js` overwrites `events.json` without protection
- Directly overwrites with `writeJson(EVENTS_FILE, …)` with no guard of "abort/confirm if real events already exist." If the data directory already contains non-migrated events, re-running will **clear the existing event stream**. Suggestion: when `totalEvents>0` is detected, abort and prompt for a backup.

### 5. `scripts/recalc-priorities.js` standalone implementation not fully consistent with MCP
- This script only recalculates the "urgency" portion (`priority = urgency + retained non-urgency`), and does not perform the MCP `recalc_priorities`'s "combined view / load-overload linkage / queue relative degradation." Standalone runs may differ from AI patrol results.
- Also it only writes `goals.json` and does not write back the `state.json` fallback copy (though MCP reads split documents first so the AI is unaffected, the Electron fallback copy will lag).
- **Recommendation**: Have the script directly `require` MCP's `recalcPriorities` function for reuse, avoiding duplicate implementations.

---

## Items Verified as Problem-Free (Rest Assured)
- All `.js` files pass `node --check` with no syntax errors.
- The MCP service was driven live via JSON-RPC to exercise 14 tools (including `create_plan` / `auto_schedule` / `search` / `delete_topic`, etc.), with no uncaught exceptions and no crashes.
- The `fs.watch` / SSE / IPC push mechanisms, i18n, light/dark theme switching, and cascade-delete (including `fs.unlinkSync` of already-sedimented topic files) logic loops are sound.
- The `EventEngine` event stream and the `BrainIndex` topic induction / automatic sedimentation / cascade-delete design and implementation are self-consistent.

---

## Fix Priority Roadmap (Recommendation)
1. **P0**: Unify the persistence layer to eliminate the "panel ↔ AI" dual-storage divergence (stop the data overwrite first, then fix visibility).
2. **P1-1**: Add `briefings` to `DOCUMENT_KEYS` to unify the three-end morning-briefing reads.
3. **P1-2**: Have `start.sh` reuse `setup.js` to unify cross-platform initialization.
4. **P1-3**: Align `topicThreshold` to 6 (or explicitly calibrate and comment).
5. **P2**: Clean up dead code, extract the shared `storage.js`, add guards to the migration script, and reuse the recalc function.
