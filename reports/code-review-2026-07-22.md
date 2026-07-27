# 灵犀 (ZhiGui) 项目审查报告

**审查日期**: 2026-07-22  
**审查范围**: `skill/engine/server.js`(MCP Server, 0.3MB)、`skill/engine/storage.js`、`skill/engine/hierarchy.js`、`skill/engine/brain-index.js`、`skill/dashboard/server.js`、`skill/dashboard/public/dashboard.js`、`skill/electron/main.js`、配置与脚本  
**方法**: 静态阅读 + 对 3 个关键缺陷做了**运行时复现**（Node 脚本实测，结论见下文"已验证"）  
**结论**: 项目功能设计完整、Electron/MCP 安全基线良好（旧 S-01~S-06 已基本修复），但 **hierarchy 分层重构引入了 3 个严重的数据完整性/功能缺陷**，另有若干中低风险项。其中 2 个会静默破坏核心数据模型。

---

## 一、项目是什么 / 做了什么

灵犀是一个 **AI 智能日程助理 + 第二大脑**。它不是"待办清单"，而是把对话沉淀成结构化知识，再基于"价值观 + 目标 + 琐事 + 笔记 + 约束"做多维生活决策。

- **运行形态**：WorkBuddy / Trae / Cursor / Claude Desktop 通过 MCP 协议（JSON-RPC 2.0 over stdio）调用 `zhigui_*` 工具；桌面看板（Electron 或浏览器 `localhost:7788`）实时可视化；数据持久化为本地 JSON。
- **核心理念**：①禁止假设原则（信息不足时反问，绝不替用户脑补）；②事件流为唯一真相源；③组合视角优先级（新事件必须放进"已有全体"中相对定位，而非孤立打分）。

## 二、机制（架构）

```
AI 工具 ──MCP(JSON-RPC/stdio)──> engine/server.js (43 工具)
                                    │
                          ┌─────────┼───────────────┐
                     storage.js   hierarchy.js   brain-index.js
                   (统一持久层)  (分层懒加载)   (主题外键+沉淀)
                          └─────────┴───────────────┘
                                ▼ 写 .zhigui/ 下文件
                   state.json + 分层文件(goals-index/go_*.json 等)
                                ▼ fs.watch / SSE
                          dashboard server (7788) ──> 前端 dashboard.js
```

- **三层持久**：`state.json`(全量兜底) + 分层文件(`goals-index.json`+`goals/g_*.json`、`notes-index`+`notes/n_*.json`、`schedule-index`+`schedule/YYYY-MM-DD.json`) + 主题库(`index.json`+`topics/t_*.json`)。
- **统一读写**：MCP 与看板都走 `Storage.readFullState()/writeState()`，解决旧版"面板↔AI 双写不一致"。
- **第二大脑**：主题自动归纳（种子词 + 高频词自建主题）→ 笔记达阈值(默认 6)自动沉淀为独立文件 → 类 MySQL 外键 `related` 关联 → 一键级联删除。

## 三、功能 / 用户可做什么

| 能力 | 入口 |
|------|------|
| 智能排程（自动识别意图→追问→生成日程） | `zhigui_auto_schedule` |
| 通用规划引擎（考试/考证/论文/项目/健身，AI 提分阶段方案） | `zhigui_create_plan` / `zhigui_create_study_plan` |
| 目标/约束管理（信息不足返回 `needsClarification`） | `zhigui_add_goal` / `update` / `delete` |
| 琐事系统（must/should/nice，must 优先于一切目标） | `zhigui_add_errand` |
| 六域生活笔记（health/relationship/career/academic/social/misc） | `zhigui_add_note` |
| 价值观画像（域权重 0–100，多目标冲突时按价值而非裸分决策） | `zhigui_update_value_system` |
| 决策日志（每次排程记录推理链） | `zhigui_get_decision_log` |
| DDL 驱动动态优先级（越近越升，组合视角过载相对降级） | `zhigui_recalc_priorities` |
| 冲突检测（时间/过载/约束/战略偏离） | `zhigui_detect_conflicts` |
| 第二大脑主题（沉淀/关联检索/一键级联删） | `zhigui_get_topics` / `search_associated` / `delete_topic` |
| 面板控制（展开/收起、明暗主题） | `zhigui_set_panel` / `zhigui_set_theme` |

## 四、可视化面板功能（Electron / `localhost:7788`）

- **三视图切换**：今日 / 知识库（主题卡片+级联删除）/ 全部。
- **今日视图**：日程卡片（逐日切换 ‹ ›）、DDL 倒计时、逾期红框脉冲、优先级分数 + 手动锁/解锁、任务勾选与改时。
- **琐事区 / 生活笔记区（六域 tab）/ 决策日志区 / 冲突横幅**。
- **晨报**：每日 7 天滚动窗口 + 名言。
- **知识库视图**：主题卡片（笔记数、是否已沉淀、关联计数）+ 一键级联删除（先预览后确认）。
- **实时刷新**：`fs.watch` + SSE，毫秒级推送；明暗主题；实时时钟（北京时间）。

## 五、用户权限模型

- **单用户本地应用**，无账号/密码/认证/授权层。
- 看板 ↔ AI 共享同一 `.zhigui` 数据目录，两边权限对等。
- **无 CSRF 防护**：所有写接口仅靠 CORS 响应头限制"读响应"，不限制"执行写"（见缺陷 #4）。
- 级联删除等破坏性操作靠前端 `confirm()` + `confirm=true` 参数作为唯一护栏；MCP 侧 `zhigui_delete_topic` 需 `confirm=true`。
- 文件级：看板可写任意 `.zhigui/*`；MCP 进程可写。

---

## 六、代码审查：漏洞与 Bug（按严重度）

### 🔴 缺陷 1 [严重·已验证] 分层索引丢失目标 `type` —— 战略/约束目标在每次读取后"蒸发"
**文件**：`skill/engine/hierarchy.js` `writeGoal`(L84-113) / `writeGoals`(L118-151) 的 `indexEntry`；读取方 `storage.js` `readLightweightState`(L515-517) / `readFullState`(L365-381)。

**根因**：目标索引项只写了 `id/title/priority/...`，**从不写 `type`/`kind`**。但读取方用 `g.type === 'strategic' | 'constraint'` 来分流。索引里 `type` 恒为 `undefined` → `strategicGoals=[]`、`constraints=[]`、所有目标归入 `currentGoals`。

**影响**：
- `computeStrategicFit` 永远拿到空 `strategicGoals` → 战略契合分恒为中性(15)，战略评分形同虚设；
- `auto_schedule` 的战略目标关联恒失败；
- **所有约束（不熬夜/休息日/每日时长/锻炼）在重读后消失** → 排程完全忽略约束；
- 看板"战略目标/约束"面板恒空。

**复现**：
```
h.writeGoals([{id:'sg1',type:'strategic'},{id:'cg1',type:'current'},{id:'ct1',type:'constraint'}])
=> 索引 type 全部 undefined => 分类: strategic=0, current=3, constraints=0
```
**修复**：在 `writeGoal`/`writeGoals` 的 `indexEntry` 中加 `type: goal.type || 'current'`（detail 文件已含，仅索引漏写）。

### 🔴 缺陷 2 [严重·已验证] 主题级联删除留下孤儿日程任务
**文件**：`skill/engine/brain-index.js` `cascadeDelete`(L663-737)，配合 server.js `auto_schedule`(全程无 `linkEntity(...,'tasks',...)`)。

**根因**：`cascadeDelete` 第 3 步用 `rel.tasks` 删日程任务，但**全代码无任何 `linkEntity(topicId,'tasks',taskId)` 调用**（仅 goals/notes/errands/events/decisions 被关联）。`rel.tasks` 永远为空 → 第 3 步是 no-op。被删目标的日程任务（带 `relatedGoalId`）成为孤儿。

**复现**：建主题 t、关联目标 cg1、建任务 tk1(relatedGoalId=cg1) → `cascadeDelete(t)` 返回 `deleted.tasks=0`，`tk1` 仍残留。

**影响**：删除主题后，看板仍显示已删目标的历史任务，与文档"级联删除所有关联日程"承诺不符，且孤儿任务指向已不存在的目标。

**修复**：`auto_schedule` 生成任务时 `linkEntity(topicId,'tasks',task.id)`；或在 `cascadeDelete` 第 2 步删目标后，额外按 `rel.goals` 反查 `schedule.days[*].tasks` 中 `relatedGoalId∈rel.goals` 一并删除。

### 🔴 缺陷 3 [严重·已验证] 冲突 / 晨报 / 7 天简报写完即"失忆"
**文件**：`storage.js` `readFullState`(L331-406) / `readLightweightState`(L481-541)；写入方 step5(state.json) / step6(schedule.json)。

**根因**：`DOCUMENT_KEYS.schedule = ['schedule','morningBriefing','conflicts','briefings']`，但两个读函数只遍历 `smallDocs = ['errands','decisions','reminders','userProfile']`，**从不遍历 `schedule` 文档**，因此 `conflicts/morningBriefing/briefings` 三个字段永远不被读取（仅 `meta` 从 state.json 读出）。

**复现**：state.json 写入 conflicts/morningBriefing/briefings → `readFullState()`/`readLightweightState()` 三者全返回 `undefined`。

**影响**：
- 看板"冲突面板"恒空；`zhigui_get_today` 的 `activeConflicts=[]`、`briefing=null`；
- 每日 08:00 自动巡检推送的晨报为空；
- 这是旧报告 P1-1 的"换皮版"——虽已把 `briefings` 加进 `DOCUMENT_KEYS`，但读函数漏遍历 `schedule`，缺陷本质未解。

**修复**：在 `readFullState`/`readLightweightState` 中读取 `schedule` 文档并回填 `conflicts/morningBriefing/briefings`（或直接从 `state.json` 显式读出这三个字段）。

### 🟠 缺陷 4 [中] 看板写接口 CSRF：任意网站可静默篡改/清空用户全部数据
**文件**：`skill/dashboard/server.js` 主路由(L975-1096) + 各 `handleXxx` POST。

**根因**：CORS 仅在 `Origin` 命中 localhost/file/app 时回写 `Access-Control-Allow-Origin`，但**请求仍照常处理**——即服务端不校验"写操作"的来源。浏览器会因 CORS 阻止读响应，但 **POST 写操作照常执行**（读响应被挡 ≠ 写被挡）。

**影响**：用户在同一浏览器访问恶意网页时，该页可用 `fetch('http://localhost:7788/api/state',{method:'POST',body:...})` 静默覆盖/清空整个灵犀状态；亦可触发 `/api/topic/delete`、`/api/note/delete` 等破坏性写。结合缺陷 5 可升级为存储型 XSS。

**修复**：写接口增加同源校验（仅当 `Origin` 为空或命中白名单才处理写）+ CSRF Token；或要求 `fetch` 带自定义头触发预检（preflight 会被 CORS 挡掉）。

### 🟠 缺陷 5 [中] 存储型 XSS：onclick 中 `time`/`date` 等字段未转义
**文件**：`skill/dashboard/public/dashboard.js` L935/937/1020/1073/1505/1556。

**根因**：仅 `task.title`/`item.title` 经 `escapeAttr()`；而 `task.time`、`date`、`type`、`task.id`、`e.id`、`n.id` 直接 `${...}` 拼进 `onclick="fn('...')"`。其中 `task.time`、`date` 经 `/api/event/add`(`dashboard/server.js` L453-494，`time` 不校验格式) 可被任意设置。CSP 含 `unsafe-inline`，注入 JS 会执行。

**复现向量**：`POST /api/event/add {time:"');alert(1);//"}` → 渲染 `editTaskTime('...','...','');alert(1);//',60)` 触发弹窗。

**修复**：对所有注入 `onclick` 的字符串参数统一走 `escapeAttr()`（含 `time`/`date`/`type`/`id`）；并校验 `time` 格式（`^\d{2}:\d{2}$`）。

### 🟠 缺陷 6 [中] 时区混用导致一次性目标"临近度"算错
**文件**：`skill/engine/server.js` `auto_schedule` L3591（另 L3762 写法不同，前后不一致）。

**根因**：`Math.round((new Date(g.deadline) - new Date(dateStr+'T00:00:00'))/86400000)` —— `new Date(g.deadline)` 按 **UTC 零点**解析，`new Date(dateStr+'T00:00:00')` 按**本地零点**解析。UTC+X 环境下二者相差约一天，一次性目标（如"交报告"）的 3 天窗口会整体偏移 ~1 天（误包含/误排除）。`daysBetween`(L229) 与 L3762 均统一解析方式，唯独此处不一致。

**修复**：统一为本地解析（`new Date(dateStr+'T00:00:00')` 两侧一致）或统一 UTC。

### 🟡 缺陷 7 [低-中] `zhigui_add_errand` 不给琐事关联主题
**文件**：`skill/engine/server.js` `zhigui_add_errand`(L4449-4547)。

**根因**：直接添加的琐事不接收/不 `linkEntity` 主题；而由 `zhigui_create_event` 派生的琐事会被关联(L2428)。结果：手动加的琐事永不出现在主题关联检索与级联删除中，与事件派生琐事行为不一致。

**修复**：`add_errand` 支持 `topic` 参数并 `linkEntity`。

### 🟡 缺陷 8 [低] `genId` 可预测
`Date.now()+Math.random()`（server.js L198、dashboard L186、electron L63）。本地无认证场景可接受，但 ID 可被枚举。

### 🟡 缺陷 9 [低] 文件锁忙等自旋
`storage.js` `acquireLockBlocking`(L90-98) 同步 `busy wait` 最高 3s，竞争时占满单核。建议改异步/指数退避。

### 🟡 缺陷 10 [低] 注释与实现不符
`server.js` 决策日志 180 条上限(L3893) 附近注释仍写"保留最近 30 天"，应改为按条数截断（或按时间截断）。

---

## 七、既往报告状态（一致性核对）

| 旧项 | 现状 |
|------|------|
| P0 双写不一致 | ✅ 已修复（看板改用统一 Storage） |
| P1-1 briefings 不持久 | ⚠️ 未真正修复（换皮：读函数漏遍历 `schedule`，见缺陷 3） |
| P1-2 跨平台初始化不一致 | ⚠️ 未复核（start.sh 是否复用 setup.js 存疑） |
| P1-3 topicThreshold 漂移(10 vs 6) | ✅ 已修复（`init-data.js` L32 已写 6，匹配默认值） |
| S-01 XSS | ✅ 标题已用 `escapeAttr`；但 `time`/`date` 仍漏（缺陷 5） |
| S-02 路径遍历 / S-03 DoS / S-04 CORS / S-05 CSP / S-06 Electron | ✅ 均已修复（已抽查 electron/main.js L190-195：contextIsolation+nodeIntegration 关闭+webSecurity 开启） |

---

## 八、优先级建议

1. **[P0] 缺陷 1**：索引补 `type` 字段（一行改动，阻断核心数据模型崩溃）。
2. **[P0] 缺陷 3**：读函数回填 conflicts/morningBriefing/briefings（恢复冲突面板与晨报）。
3. **[P1] 缺陷 2**：级联删补删日程任务（或 auto_schedule 关联 tasks）。
4. **[P1] 缺陷 4+5**：写接口同源校验 + onclick 全参数转义（防 CSRF→XSS 链）。
5. **[P2] 缺陷 6/7/9/10**：时区统一、errand 主题关联、锁退避、注释修正。
