# ZhiGui 知归 (只龟）

**A conversation-awakened personal assistant system — your Second Brain as an MCP Skill.**

[English](./README.md) | [中文](./README.zh-CN.md)

---

## What is ZhiGui?

ZhiGui (知归, meaning "knowing where to return") is not another to-do list app. It is a **personal intelligence system** that combines a JSON-file-driven knowledge graph with a desktop visualization panel, connected to any MCP-capable AI assistant.

It does not run in the background or push notifications. Instead, every time you start a conversation with your AI assistant, ZhiGui loads a compact Bootstrap index of your entire context — goals, schedules, notes, decisions, relationships — and uses it to provide decision-making and planning advice: what to prioritize, what can be deferred, what is approaching its deadline, and which actions offer the best return on effort.

### Three Roles, One Brain

ZhiGui's design draws inspiration from three classic archetypes:

| Role | What it does |
|------|-------------|
| **Secretary** | Gives you the full picture at a glance — today's schedule, overdue tasks, goals in progress, morning briefings, and daily reflections. |
| **Butler** | Quietly manages everything behind the scenes — note archiving, topic classification, action tracking, decision recording. You never worry about where data is stored. |
| **Mentor** | Inspired by Yao Lao from *Battle Through the Heavens* — a wise mentor hidden in your consciousness. Based on the information you provide, he helps you make decisions and plans: what to do first, what to do later, which task offers the best ROI, which can be deferred, and which is approaching its deadline and must be started now. He also warns you about what not to do, which goals are fantasy, and which decisions plant hidden risks. |

All three roles are driven by the same underlying knowledge graph: notes, goals, decisions, and schedules are interlinked through foreign keys (`topicId`, `noteIds`, `goalId`, `decisionIds`), forming a **traceable memory network**.

## Key Features

- **40+ MCP Tools** — The AI assistant can read, create, update, and delete goals, schedules, notes, decisions, errands, and reminders through MCP.
- **Relationship Graph** — Every entity is linked. A single schedule item can reference notes from multiple topics, trace back to a strategic goal, and cite an accepted decision.
- **Tiered Indexing** — Titles-first, details-on-demand. The AI loads only lightweight indexes by default, fetching full content only when needed — saving context tokens.
- **Automatic Note Linking** — When you create a schedule item, the AI automatically suggests related notes, goals, and decisions based on topic and context.
- **Long-term Memory** — Entities have lifecycle states: Active → Stale (30 days unreferenced) → Archive Candidate. The reflection engine flags candidates but never auto-deletes; cleanup requires explicit confirmation.
- **Morning Briefings** — AI-generated, date-frozen daily briefings with must-dos, recommendations, and strategic reminders.
- **Daily Reflections** — After completing tasks, the AI generates a reflection covering completed work, goal health, and attention shifts.
- **Reference Integrity** — Deletion always previews the impact first, then waits for confirmation, and cleans up broken references.
- **Recurring & Flexible Items** — Handles fixed-date, time-pending, recurring, and deferrable work items with different logic.
- **Customizable Assistant** — Modify `SKILL.md` to design your own assistant personality, behavior rules, and operational preferences.
- **Electron Desktop Panel** — A dockable visualization panel with collapse/expand toggling, supporting direct editing of schedules, goals, notes, and to-do items.

## Quick Start

### Prerequisites

- **Node.js ≥ 17** — Download from [https://nodejs.org](https://nodejs.org)
- **An MCP-capable AI tool** — Such as [Trae](https://www.trae.ai/), [Claude Desktop](https://claude.ai/), [Cursor](https://cursor.sh/), [Codex](https://openai.com/codex/), [OpenClaw](https://github.com/anthropics/openclaw), [VS Code Copilot](https://code.visualstudio.com/docs/editor/artificial-intelligence), etc.

### Step 1: Download & Extract

Download the ZIP from GitHub and extract it to any directory:

```
https://github.com/CarlWangChina/zhigui-openclaw-ui-second-brain-skill
```

Extract to, for example, `D:\ZhiGui`. The directory structure:

```
ZhiGui/
├── start.bat                    ← Windows one-click launcher
├── start.sh                     ← macOS/Linux launcher
├── skill/                       ← Skill core package
│   ├── engine/                  ← MCP engine + business logic
│   ├── dashboard/               ← Web panel (server.js + public/)
│   ├── electron/                ← Electron desktop shell
│   ├── lib/                     ← Configuration & data initialization
│   ├── scripts/                 ← Install & seed scripts
│   ├── test/                    ← Test suites
│   ├── SKILL.md                 ← AI skill protocol document
│   ├── config.json              ← Engine configuration
│   ├── mcp-config-template.json ← MCP config template
│   └── package.json             ← Dependency declaration
├── zhigui-user-manual/          ← Chinese user manual (HTML + PDF)
├── zhigui-user-manual-en/       ← English user manual (HTML + PDF)
├── package.json                 ← Electron dependencies
└── README.md
```

### Step 2: Upload Skill to Your AI Agent

Mainstream AI tools (such as Trae, Cursor, Claude Desktop, etc.) support uploading Skills via their settings page. Upload the project's `skill/` directory or the `SKILL.md` file within it.

### Step 3: Configure MCP

Open your AI tool's MCP configuration and add:

```json
{
  "mcpServers": {
    "zhigui": {
      "command": "node",
      "args": ["D:/ZhiGui/skill/engine/server.js"]
    }
  }
}
```

Replace `D:/ZhiGui/skill/engine/server.js` with your actual path. Use forward slashes `/` in JSON to avoid escaping issues.

**Verify:** Start a conversation and say "Show me today's schedule." If the AI calls `zhigui_get_assistant_bootstrap` and returns data, the configuration is successful.

### Optional: Launch the Desktop Panel

```powershell
# Windows
start.bat

# macOS / Linux
./start.sh
```

The first launch auto-installs dependencies (npm install, Electron binary) and initializes the data directory. A narrow panel window will appear on the right side of your desktop.

To run the web panel only (without Electron):

```powershell
cd skill
node dashboard/server.js
# Open http://localhost:7788
```

To load demo data for a quick walkthrough:

```powershell
cd skill
node scripts/seed-demo-data.js        # Chinese demo data
node scripts/seed-demo-data-en.js    # English demo data
```

## How It Works

```text
User panel actions ─┐
                     ├─→ Unified Actions / Linked entities / Activity log
AI conversations   ─┘                    │
                                         ▼
                           Next conversation reads Bootstrap
                                         │
                         On-demand: goals, notes, dates, decisions
                                         │
                        Form suggestions / Update status / Create follow-ups
```

The panel lets you directly view and manipulate data. MCP lets the AI read, reason, and write. They are not substitutes for each other — they share the same data layer, synchronized in real time via file watching (`fs.watch`).

## System Architecture

```text
User ←→ AI Assistant (Trae / Claude Desktop / Cursor / Codex / OpenClaw / etc.)
              ↕ MCP Protocol
         ZhiGui Engine (server.js)
              ↕ JSON File Read/Write
         .zhigui/ Data Directory
              ↕ fs.watch File Watching
         Electron Panel (main.js)
              ↕ IPC Communication
         Frontend UI (dashboard.js)
```

## Usage Conventions

1. After completing a task, if the outcome affects goals, notes, or future plans, tell the AI in the next conversation so it can update the long-term plan.
2. "Done" in conversation and clicking complete in the panel both support the same impact updates — goal status, note facts, decisions, and follow-ups should be written together.
3. Don't fabricate times for items without one; items with a date but no time should appear on that day.
4. Only link notes to schedules when there's genuine execution value — a self-contained "pick up package" errand doesn't need a note attached.
5. Deletion always previews impact first, then waits for confirmation.

## User Manuals

Detailed installation guides, UI panel feature walkthroughs, and usage examples are available in both languages:

| Language | HTML | PDF | Location |
|----------|------|-----|----------|
| Chinese | `zhigui-user-manual/zhigui-user-manual.html` | `zhigui-user-manual/zhigui-user-manual.pdf` | [Open](./zhigui-user-manual/zhigui-user-manual.html) |
| English | `zhigui-user-manual-en/zhigui-user-manual-en.html` | `zhigui-user-manual-en/zhigui-user-manual-en.pdf` | [Open](./zhigui-user-manual-en/zhigui-user-manual-en.html) |

Each manual covers: product overview, three-step installation, MCP configuration, UI panel features, core intelligence (auto-linking, tiered indexing, long-term memory, SKILL.md customization), usage examples, and FAQ.

## Development & Testing

```powershell
npm.cmd test
```

Data is stored in `skill/.zhigui/` by default. Demo data is for demonstrating relationships, completion, reflection, and follow-up flows only.

For the full AI behavior specification, see [skill/SKILL.md](./skill/SKILL.md).

## Deletion & Lifecycle

Deletion is irreversible — both the panel and AI preview the impact first, wait for confirmation, and clean up broken references through the unified command layer. Entities (notes, goals, decisions) have automatic lifecycle states: Active → Stale (30 days unreferenced) → Archive Candidate (long-term inactive). The reflection engine only flags candidates; it never auto-deletes. Cleanup requires explicit user confirmation.

## Feedback

Found a bug or have a suggestion? Email: **huangkkkke16@gmail.com**

## Acknowledgments

This project would not have been possible without the contributions of the following people:

- **Zihao Wang** — Project advisor. Provided invaluable guidance and recommendations throughout the project's lifecycle, shaping the core design philosophy, product direction, and architectural decisions. His mentorship was instrumental in bridging the gap between concept and a working system.
- **Kewei Huang** ([Huangkkkke16](mailto:huangkkkke16@gmail.com)) — Project designer, developer, and tester. Responsible for the full-stack design and implementation of the system — from the MCP engine and knowledge graph architecture to the Electron desktop panel and AI skill protocol. Conducted all testing, debugging, and iterative refinement based on real-world usage.

## License

This project is open source. See the repository for details.
