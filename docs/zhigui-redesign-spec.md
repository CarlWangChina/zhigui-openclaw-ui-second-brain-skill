# 知归（ZhiGui）重构实现蓝图

> **文档用途**：这是一份给 AI 执行Agent 的实现规范。包含目标架构、硬约束、分阶段任务，以及每个任务的「引导做法」与「验收检查」。
> **阅读顺序**：先读 §1–§3（背景/原则/约束），再按 §5 阶段顺序执行，每阶段结束跑 §6 全局检查。
> **范围声明**：本蓝图**不包含旧数据迁移**；存储改造直接采用新模型，假定数据为新结构或从空初始化。

---

## 1. 背景与问题

知归原名为“灵犀”，是一个 AI 日程助理 + 第二大脑。当前存在以下结构性问题：

1. **行动被拆成两个互不相见的池子**：`errands`（待安排事项）与 `schedule.days[].tasks`（日程）是独立存储。目标派生出的任务、琐事、笔记触发的任务都是“行动”，却分散在多处。
2. **目标卡片下显示“暂无衍生内容”**，但相关任务其实躺在“待安排事项”里——派生关系断了。
3. **已完成项只划线不消失**，仍占用队列。
4. **琐事是否该变记忆没有显式规则**；笔记沉淀的时机与去向不清晰。
5. 用户希望项目更名为 **知归 / ZhiGui**（由萨摩智能科技开发）。

---

## 2. 核心原则（不可违背）

| # | 原则 | 说明 |
|---|------|------|
| P1 | **用户拥有记忆** | 长期记忆（沉淀内容、归档目标、memory 级行动）的最终决定权永远在用户。 |
| P2 | **AI 提议，用户拍板** | AI 可“建议沉淀/建议保留级/建议关联”，但**实际写入长期记忆必须用户显式确认**。 |
| P3 | **过程透明** | 所有影响记忆的操作（沉淀/遗忘/关联/删除）必须留痕并可被用户查看、回滚。 |
| P4 | **非破坏性完成** | 完成 = 移入归档，绝不静默删除（瞬态除外，但须提前告知）。 |
| P5 | **禁止假设** | 信息不足时追问或显式标记未知，不私自编造模糊字段（延续既有 noAssumptionRule）。 |
| P6 | **自由分类** | 不硬编码“六个域”；AI 自行决定笔记归类（复用或新建主题标签）。 |
| P7 | **薄面优先** | 读取先给 Layer-0 概览，深层内容按需拉取，不一次全量返回。 |

---

## 3. 硬约束（禁止项 / 必须项）

### 3.1 禁止（任何阶段都不得违反）
- ❌ **AI 自动沉淀长期记忆**：禁止在用户未确认时把笔记写入 Tier2（主题沉淀文档）或标记长期记忆。
- ❌ **静默删除长期记忆**：禁止不经确认删除已沉淀笔记、归档目标、memory 级行动。
- ❌ 硬编码分类枚举（如 `enum:['health','relationship',...]`）。
- ❌ 修改打包/启动器/electron 主流程（`start.bat`、`electron/main.js` 窗口尺寸/IPC 契约）除非本蓝图明确要求。
- ❌ 改变数据目录约定（仍为 `.lingxi`）。
- ❌ 破坏 MCP 接口的既有可用性（现有 ~63 个 `lingxi_*` 工具需向后兼容或显式版本化）。
- ❌ 任何用户可控文本进入 `innerHTML` 而不经 `escapeHtml`，进入属性不经 `escapeAttr`。

### 3.2 必须（落地时强制满足）
- ✅ 所有用户可见文案中“灵犀/Lingxi”改为“知归/ZhiGui”。
- ✅ 完成的目标/行动从活跃视图消失，但保留于归档层并可恢复。
- ✅ 记忆相关操作写入「记忆账本（Memory Ledger）」并可在「记忆动态」面板查看。
- ✅ 每个阶段结束执行 §6 全局检查，全部通过方可进入下一阶段。
- ✅ 改动文件后运行 `node --check`，零错误。

---

## 4. 目标架构

### 4.1 三柱 + 两层（心智模型）
- **三柱**：目标（方向）｜笔记（知识）｜行动（做）。
  - 行动的两个子集：**琐事**＝无目标归属的行动；**行程/日程**＝带时间的行动。
- **两层**：归档层（完成项，可检索、默认不显示）＋ 主题知识库（沉淀后的笔记）。

### 4.2 存储：统一行动层
- 新增 `actions` 集合，替代 `errands` 与 `schedule.days[].tasks`。
- 字段：`id, title, source('goal'|'note'|'errand'), status('queued'|'scheduled'|'done'|'archived'), relatedGoalId, relatedStrategicGoalId, relatedNoteId, date, time, duration, priority, retention('transient'|'review'|'memory'), completed, completedAt, archivedAt, createdAt`。
- `schedule` 降级为**视图**：从 `actions` 筛 `status='scheduled'`（有 date+time）得到，不再是独立存储。
- 目标派生任务 = `source='goal'` 且带 `relatedGoalId` 的 action，直接挂目标下。

### 4.3 分层索引（四层）
- **Tier0 热**：今日行动、活跃目标、开放队列（常驻）。
- **Tier1 温**：滚动窗口（14–30 天）内已完成项、待审、近期决策。
- **Tier2 冷（=brain-index）**：主题、沉淀文档、归档目标、memory 级行动——这才是“记忆”。
- **Tier3 冻（待清理）**：到期瞬态/待复盘，删除前暂存，可检索不展示。
- 索引：倒排文本索引 + 外键图谱（brain-index.related 跨层链接）+ 时间分区 + 记忆账本。

### 4.4 权限与透明度
- AI 可执行：捕获笔记、建议沉淀、建议保留级、建议关联、生成晨报、写决策日志。
- AI 不可自行执行：实际沉淀（需确认）、实际遗忘/删除长期记忆（需确认）、改用户手动锁定的优先级。
- 遗忘（瞬态/待复盘到期）须先进入「待清理」列表并通知，用户可晋升为 memory 或延长。

---

## 5. 分阶段实施计划

每个任务含：**目标 / 引导做法 / 验收检查**。

### 阶段 A ｜框架与命名（地基）
**A1 项目重命名 Lingxi → 知归（ZhiGui）**
- 目标：品牌三要素统一（中文 知归 / 英文 ZhiGui / 萨摩智能科技开发）。
- 引导做法：先全局搜 `灵犀|Lingxi|lingxi`（grep），逐文件改：`SKILL.md`、`package.json`、`README.md`、`start.bat`/`start.sh` 标题、`electron/main.js` 标题、`dashboard/public/dashboard.js` 的 i18n 字符串、`mcp-config-template.json` 的 skill 名。
- 验收检查：① `grep -ri "lingxi" --include=*.js --include=*.md --include=*.json` 仅剩必须的技术标识符（如目录名 `.lingxi`、配置 key），无用户可见“灵犀/Lingxi”文案；② `node --check` 全过；③ 起 dashboard 看板标题显示“知归”。

**A2 确立三柱+两层心智模型**
- 目标：把框架写入 `SKILL.md` 的引导文案与 `get_instructions`，让 AI 与用户一致理解。
- 引导做法：在 `engine/server.js` 的 `noteExtractionGuide`/`planningGuide` 顶部补“三柱两层”说明；明确沉淀需用户确认（P2）。
- 验收检查：① `get_instructions` 返回内容含“用户拥有记忆”“AI 提议用户拍板”；② 既有测试不回归。

**A3 记忆语义定义**
- 目标：明确“长期记忆＝Tier2 沉淀 + 归档目标 + memory 行动”，AI 不自动写。
- 引导做法：在 `absoluteRules` 增加一条 `noAutoMemoryRule`：禁止未确认即写 Tier2 / 删长期记忆。
- 验收检查：规则文本在 `get_instructions` 中可见，且含违规示例。

### 阶段 B ｜存储机制（长期记忆分层）
**B1 统一行动层（替代 errands + schedule tasks）**
- 目标：新增 `actions` 集合；`schedule` 改为视图。
- 引导做法：① 改 `engine/storage.js` 读写支持 `state.actions`；② 改 `engine/actions.js` 的 `addErrand`/`addEvent`/`toggleTask`/`deleteTask` 统一写 `actions`，保留 `relatedGoalId` 等外键；③ 改 `engine/server.js` 相关 MCP 工具；④ `scheduler.js` 生成时写 `actions` 并标 `status='scheduled'`。
- 验收检查：① `node --check` 全过；② 新增 `test/engine-actions.js`：add（goal/note/errand 三来源）→ 读回 `actions` 存在且字段正确；③ `schedule` 视图从 `actions` 正确派生。

**B2 行动生命周期与保留级**
- 目标：transient/review/memory 三级别行为正确。
- 引导做法：`actions.js` 完成逻辑按 retention 分支——transient 完成即 `archived`；review 完成 `archived` 并打 `archiveExpireAt`；memory 完成转 note 或标 `memory=true`。每日巡检（`automation-1784113587657` 风格）清理到期 transient/review。
- 验收检查：`test/engine-actions.js` 覆盖三种 retention 的完成与过期清理（用可控时钟或 mock `archiveExpireAt`）。

**B3 目标记忆模型**
- 目标：战略目标永留归档；当前目标完成进归档；完成时 AI 建议复盘笔记。
- 引导做法：`completeGoal` 对 strategic 标记 `archived` 但不设过期；在 auto_schedule / complete 后由 AI 生成复盘建议（仅建议，不自动写）。
- 验收检查：战略完成仍在归档可查；复盘建议走“AI 提议→用户确认”路径，不由代码静默写入。

**B4 笔记长期沉淀模型**
- 目标：raw → 归类 topic → 稳定后 AI 建议 → 用户确认 → 抽离沉淀文档。
- 引导做法：沿用 `brain-index` 的 `precipitate`，但触发改为“AI `propose_precipitation` + 用户确认”，禁止自动 `_precipitate`。
- 验收检查：无用户确认时 `brain-index` 不被自动沉淀；`propose_precipitation` 产生待审项。

**B5 归档存储**
- 目标：完成项写 archive，移出活跃视图，可恢复/永久删。
- 引导做法：`state.archive` 或 `archived=true`；`deleteGoal`/`completeX` 完成后入档；恢复=置回活跃。
- 验收检查：归档项在活跃视图不可见，在归档视图可见且可恢复。

### 阶段 C ｜分层索引
**C1 四层索引落地**
- 目标：Tier0/1/2/3 各自检索策略。
- 引导做法：在 `engine/overview.js` 与 `brain-index` 增加 tier 标签；`get_overview` 返回 Tier0 热数据。
- 验收检查：`get_overview` 不含完整笔记正文（薄面）；深层按需读取。

**C2 倒排文本索引补全**
- 目标：Tier2 全文检索覆盖笔记/主题。
- 引导做法：扩展 `brain-index` 的索引构建。
- 验收检查：`lingxi_search` 命中沉淀文档内容。

**C3 外键图谱增强**
- 目标：完成项出现在对应主题下。
- 引导做法：`brain-index.related` 增加 actions/goals 的 archived 引用。
- 验收检查：`lingxi_search_associated(某主题)` 返回其下已完成目标/行动。

**C4 记忆账本（Memory Ledger）**
- 目标：追加式记录所有记忆写/忘/关联。
- 引导做法：新增 `state.memoryLedger`（或独立 `ledger.json`）；在 precipitate/forget/link/delete 处追加。
- 验收检查：每次记忆操作在 ledger 有记录，含 operator/what/when/why。

**C5 Layer-0 概览重构**
- 目标：新增统一行动队列摘要 + “建议沉淀/跟进”hint。
- 引导做法：`buildOverview` 加入 actions 按 source/status 计数。
- 验收检查：`get_overview` 返回 actions 摘要且不超过体积预算。

**C6 目标派生读取**
- 目标：根治“暂无衍生内容”。
- 引导做法：`getDerivedActionsForGoal(goalId)` 从 `actions` 按 `relatedGoalId` 读、排除 archived。
- 验收检查：挂了派生 action 的目标，C6 能返回且不含已完成归档项。

**C7 归档检索**
- 目标：`get_archive({type,from,to,source})` 支持恢复与永久删。
- 引导做法：在 `engine/server.js` 新增/改造工具。
- 验收检查：按条件返回；恢复后项回到活跃。

**C8 智能联合检索**
- 目标：`get_project_status(goalId)` 一次返回 目标+派生+笔记+决策日志。
- 引导做法：聚合 `actions`/`notes`/`decisionLog`/`brain-index`。
- 验收检查：对一战略目标调用返回完整关联实体。

### 阶段 D ｜用户权限与透明度
**D1 沉淀需用户确认**
- 目标：AI 只能 `propose_precipitation`，执行沉淀必须确认。
- 引导做法：server.js 中沉淀工具分 `propose` 与 `confirm` 两步；`confirm` 需用户端显式调用。
- 验收检查：单测证明未确认时 Tier2 不新增沉淀文档。

**D2 遗忘透明**
- 目标：瞬态/待复盘到期前进「待清理」并通知，用户可抢救。
- 引导做法：巡检先把到期项移入 `state.pendingForget` 并写 ledger；dashboard 展示「待清理」。
- 验收检查：到期项先出现于待清理而非直接消失；用户可晋升 memory。

**D3 记忆动态面板**
- 目标：展示记忆账本，可回溯、可回滚。
- 引导做法：dashboard 新增「记忆动态」视图读 `memoryLedger`；提供回滚动作（调用对应 undo 工具）。
- 验收检查：面板列出沉淀/遗忘/关联/删除；回滚使状态还原。

**D4 确认即权力 UI**
- 目标：沉淀/删除弹确认框，预览将写入/移除内容。
- 引导做法：dashboard 模态框展示 diff 预览。
- 验收检查：确认框显示具体条目；取消不执行。

### 阶段 E ｜界面与体验
**E1 目标视图：项目树**
- 目标：战略→当前→派生行动三层，可展开，每层完成按钮，进度条。
- 引导做法：改 `renderGoals`/`renderGoalCard`/`renderDerivedForGoal`，用 C6 取数；完成按钮 current+strategic 都显示。
- 验收检查：截图验证树形展开、完成按钮、进度；`test/http-dashboard.js` 不回归。

**E2 行动视图（待安排→行动队列）**
- 目标：统一 queued 队列，按来源过滤，完成即消失，保留级徽章。
- 引导做法：改 dashboard 行动渲染读 `actions`；过滤 `status='queued'`；completed 不显示。
- 验收检查：完成项不在队列；徽章正确。

**E3 日程视图**：仅 scheduled 行动，干净时间轴（读 actions 视图）。

**E4 归档视图（新增）**：已完成 goals/actions 可搜索、恢复、永久删（接 C7）。

**E5 修复当前目标无完成按钮**
- 目标：战略/当前目标稳定显示完成按钮。
- 引导做法：核查 `renderGoalCard` 条件与 CSS（可能旧包/缓存）；确认 `toggleGoalComplete` 路径；给 `index.html` 脚本加缓存破坏 `?v=`。
- 验收检查：两种目标类型都可见完成按钮；单测/集成测覆盖。

**E6 琐事保留级选择器**
- 目标：行动表单加 retention + 一句解释；AI 预填建议。
- 引导做法：dashboard 表单加 `retention` 单选；`addErrand` 接受并落 `actions.retention`。
- 验收检查：创建时选 transient/review/memory 均正确存储。

**E7 今日判断排版与联动**
- 目标：沿用分块样式；完成目标后“今日方向”即时刷新。
- 引导做法：保留 `invalidateTodayBriefing`；确认其覆盖显示日。
- 验收检查：`toggleGoalComplete` 后今日方向变化；排版非 cramped。

**E8 知识库树增强**
- 目标：完成项在主题下显示；沉淀建议卡片（预览→确认→沉淀）。
- 引导做法：接 C3/D1；渲染 proposal 卡片。
- 验收检查：主题下见完成项；建议卡片确认后沉淀。

**E9 极速捕获入口**
- 目标：全局 1 步记下；Capture-then-process。
- 引导做法：dashboard 顶部常驻“＋ 记一笔”；来源/保留级可空，AI 后续建议。
- 验收检查：1 步捕获入 actions（queued，无来源）；后续可被 AI 归类。

### 阶段 F ｜ AI 智能
**F1 沉淀建议**：topic 稳定/达标时 AI 提议，附理由，用户确认（接 D1）。
**F2 保留级建议**：新增琐事 AI 按语义建议 retention，可改（带家人看病→review/memory；取快递→transient）。
**F3 目标拆解**：复杂目标 AI 提议阶段+派生行动挂目标下（接 B1/E1）。
**F4 优先级归 AI 所有**：无硬规则，AI 打分并写 decisionLog；用户可锁/解。
**F5 晨报引导式叙述**：自然语言“今日判断”，结构化不强制；综合健康/精力/价值观/战略契合。
**F6 冲突与过载检测**：AI 发现排程冲突、截止压力，基于价值观给取舍。
**F7 笔记自由归类+目标关联**：无六域，相关时关联目标。
**F8 完成即复盘**：目标完成触发 AI 建议写复盘笔记→沉淀（P2 确认）。
**F9 第二大脑推理链**：排程前 AI 综合笔记/价值观/契合度，decisionLog 解释每个选择。

> 阶段 F 多为 `engine/server.js` 的 guide 文本与 `scheduler.js` 推理增强；每条验收检查＝对应 guide 文本在 `get_instructions` 可见 + 至少一个行为测试证明 AI 走建议而非自动写。

### 阶段 G ｜验证
**G1 单测**：行动生命周期、保留级、派生读取、归档检索、记忆账本（新增 `test/engine-actions.js`、`test/engine-memory.js`）。
**G2 集成测**：扩展 `test/http-dashboard.js` 与 `test/engine-goals.js` 覆盖新模型。
**G3 透明与权限回归**：验证“AI 不能自动沉淀”“遗忘前出现在待清理”“记忆动态留痕”。
**G4 视觉走查**：新 UI 各视图无回归。

---

## 6. 全局检查清单（每阶段结束必跑）

- [ ] `node --check engine/*.js dashboard/public/dashboard.js scripts/*.js` 零错误。
- [ ] 既有 `test/http-dashboard.js` 与 `test/engine-goals.js` 仍 PASS（未破坏路径）。
- [ ] 本阶段新增测试 PASS。
- [ ] 违反 §3 硬约束的改动为零（grep 复核）。
- [ ] 用户可见文案无残留“灵犀/Lingxi”（技术标识符除外）。
- [ ] XSS：新增 innerHTML/属性拼接均经 escapeHtml/escapeAttr（grep 复核）。
- [ ] 完成项从活跃视图消失、归档可恢复（手动或测试验证）。
- [ ] 记忆写操作均留痕于 memoryLedger（grep 复核调用点）。

---

## 7. 反模式与风险提示

- 🚫 **AI 自作主张写长期记忆**：最易犯。任何 precipitate/forget/delete-memory 必须走“提议→确认”。
- 🚫 **双写不一致**：若 `schedule` 与 `actions` 并存写入会漂移——必须让 schedule 成为 actions 的纯视图。
- 🚫 **完成即删**：违反 P4；只有 transient 经“待清理”通知后才可清。
- 🚫 **硬编码分类**：违反 P6；分类交给 AI 自由决定。
- 🚫 **大包全量返回**：违反 P7；坚持 Layer-0 薄面。
- ⚠️ **缓存导致旧 JS**：dashboard 脚本加 `?v=` 缓存破坏，避免“修了但用户看不见”。
- ⚠️ **MCP 工具破坏性改名**：优先新增 `propose_*`/`confirm_*` 而非改旧工具签名，保兼容。

---

**执行纪律**：严格按 A→B→C→D→E→F→G 顺序；任一层验收未过不得进入下一层；遇到模糊需求按 P5 追问或显式标记未知，不假设。
