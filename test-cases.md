# ZhiGui 第二大脑 - 测试案例

> 覆盖：定时提醒、上下文推送、自动笔记整理、Topic Library 分层归类、级联删除
> 使用方法：将以下用户消息依次发送给 AI，验证预期行为

---

## 一、定时提醒功能

### TC-1: 创建单次定时提醒
**用户输入：**
> 周五下午5点要交Q3报告给老板，通过邮件发送

**预期行为：**
- AI 调用 `zhigui_add_reminder`，参数：
  - `title`: "Submit Q3 report to boss"
  - `triggerAt`: "2026-07-24T17:00:00+08:00"（AI 把"周五5点"转为绝对 ISO 时间）
  - `priority`: "must"
  - `note`: "Send via email"
  - `category`: "career"
- AI 回复确认提醒已设置
- Dashboard 的 Scheduled Reminders 面板出现该提醒卡片

**验证点：**
- [ ] reminder 出现在 state.reminders
- [ ] Dashboard 显示 ⏰ 标记和 MUST 红色标签
- [ ] 晨报 must-do 列表包含该提醒

---

### TC-2: 创建重复提醒
**用户输入：**
> 每天早上9点提醒我吃药

**预期行为：**
- AI 调用 `zhigui_add_reminder`，参数：
  - `title`: "Take medicine"
  - `triggerAt`: "2026-07-21T09:00:00+08:00"（明天9点）
  - `priority`: "must"
  - `repeat`: "daily"
- 提醒触发后自动创建下一次触发（+1天）

**验证点：**
- [ ] Dashboard 显示 🔁 daily 标签
- [ ] 触发后 reminders.json 中出现新的 reminder（id 不同，triggerAt +1天）

---

### TC-3: 提醒触发
**模拟方式：** 手动将 reminder 的 triggerAt 改为过去时间，然后发送任意消息

**预期行为：**
- AI 调用 `zhigui_check_reminders` 时检测到触发
- AI 在回复中用 ⏰ 前缀通知用户：
  > "⏰ MUST: Submit Q3 report to boss (Send via email)"
- reminder 标记为 fired=true

**验证点：**
- [ ] AI 回复包含提醒内容
- [ ] state.reminders 中对应 reminder 的 fired=true
- [ ] 重复提醒触发后产生新的 reminder 记录

---

### TC-4: 删除提醒
**用户输入：**
> 取消每天吃药的提醒

**预期行为：**
- AI 调用 `zhigui_get_reminders` 找到该提醒
- AI 调用 `zhigui_delete_reminder { id: "rm_xxx" }`
- Dashboard 中该提醒卡片消失

**验证点：**
- [ ] state.reminders 中不再包含该 reminder
- [ ] Dashboard 面板更新

---

### TC-5: 查询提醒列表
**用户输入：**
> 我这周有哪些提醒？

**预期行为：**
- AI 调用 `zhigui_get_reminders { from: "2026-07-20", to: "2026-07-26" }`
- AI 列出本周所有提醒，按时间排序

---

## 二、上下文推送功能（mem.ai 风格）

### TC-6: 首次对话无上下文
**前置条件：** 第二大脑为空（或刚清空历史）

**用户输入：**
> 我想开始学习吉他

**预期行为：**
- AI 调用 `zhigui_get_context { userMessage: "我想开始学习吉他" }`
- 返回 `{ hasContext: false, items: [] }`（没有相关笔记）
- AI 正常回复，不引用任何历史笔记

---

### TC-7: 创建笔记后，后续对话推送上下文
**第一步 - 用户输入：**
> 我发现每天练习吉他45分钟效果最好，时间太长手指会痛

**预期行为：**
- AI 调用 `zhigui_create_event`，facts 中包含：
  - `type: "note"`, `content: "每天练习吉他45分钟效果最好，时间太长手指会痛"`
  - `topic: "Guitar Practice"`, `category: "Learning"`
- 笔记存储到 notes.json，关联到 Guitar Practice topic

**第二步 - 用户输入（新对话）：**
> 吉他练习进度怎么样了？

**预期行为：**
- AI 调用 `zhigui_get_context { userMessage: "吉他练习进度怎么样了" }`
- 返回相关笔记：`"每天练习吉他45分钟效果最好，时间太长手指会痛"`
- AI 自然引用：`"上次你提到每天练习45分钟效果最好，手指还好吗？"`

**验证点：**
- [ ] `zhigui_get_context` 返回 hasContext=true
- [ ] items 中包含之前的笔记
- [ ] AI 回复引用了历史笔记内容

---

### TC-8: 多话题上下文区分
**前置条件：** 已有以下笔记：
- Guitar Practice topic: "每天练习45分钟"
- English Speaking topic: "使用影子跟读法"
- Wife Birthday topic: "老婆喜欢手工礼物"

**用户输入：**
> 英语口语最近有什么进展？

**预期行为：**
- `zhigui_get_context` 只返回 English Speaking 相关笔记
- 不返回 Guitar 或 Wife Birthday 的笔记
- AI 回复只引用英语相关内容

**验证点：**
- [ ] matchingTopics 只包含 English Speaking
- [ ] items 中只有英语相关的笔记

---

### TC-9: 无关消息不推送
**用户输入：**
> 今天天气真好

**预期行为：**
- `zhigui_get_context` 返回 `{ hasContext: false, items: [] }`
- AI 不引用任何历史笔记

---

## 三、自动笔记提取

### TC-10: 提取方法/技巧类笔记
**用户输入：**
> 我最近在用番茄工作法管理时间，25分钟专注然后休息5分钟，效率提升了不少

**预期行为：**
- AI 在 `zhigui_create_event` 的 facts 中提取：
  - `type: "note"`, `content: "使用番茄工作法：25分钟专注+5分钟休息，效率提升"`
  - `topic: "Time Management"`, `category: "Learning"`
- 笔记自动存储

**验证点：**
- [ ] notes.json 中出现该笔记
- [ ] 笔记有 topicId 关联
- [ ] Topic Library 中出现 Time Management topic

---

### TC-11: 提取偏好类笔记
**用户输入：**
> 我更喜欢早上学习，晚上脑子转不动

**预期行为：**
- AI 提取：`type: "note"`, `content: "偏好早上学习，晚上效率低"`
- 自动归类到合适 topic（如 "Study Habits" 或 "Learning"）

---

### TC-12: 提取背景信息类笔记
**用户输入：**
> 我之前在互联网公司做了3年产品经理，现在想转行做开发

**预期行为：**
- AI 提取多条 facts：
  - `type: "note"`, `content: "有3年互联网产品经理经验"`
  - `type: "goal"`, `content: "想转行做开发"`

---

### TC-13: 不提取无价值信息
**用户输入：**
> 嗯，好的，知道了

**预期行为：**
- AI 不提取 note 类型 fact（或标记为 smalltalk）
- 不创建无意义的笔记

---

## 四、自动笔记整理

### TC-14: 合并重复笔记
**前置条件：** 手动添加两条内容相似的笔记：
```
note 1: "每天练习吉他45分钟效果最好"
note 2: "每天练习吉他45分钟效果最好"  (完全相同)
```

**操作：** 调用 `zhigui_organize_notes`

**预期行为：**
- 返回 `{ merged: 1 }`
- notes.json 中只保留一条笔记

---

### TC-15: 重新分类孤立笔记
**前置条件：** 添加一条无 topicId 的笔记：
```
note: "英语口语要用影子跟读法" (无 topicId)
```

**操作：** 调用 `zhigui_organize_notes`

**预期行为：**
- 返回 `{ reclassified: 1 }`
- 该笔记被关联到 English Speaking topic
- index.json 中 English Speaking topic 的 related.notes 包含该笔记 id

---

### TC-16: 标记陈旧笔记
**前置条件：** 添加一条 90 天前的孤立笔记

**操作：** 调用 `zhigui_organize_notes`

**预期行为：**
- 返回 `{ stale: 1 }`
- 该笔记标记 `stale: true`

---

### TC-17: Dry run 模式
**操作：** 调用 `zhigui_organize_notes { dryRun: true }`

**预期行为：**
- 返回统计数据但不修改任何文件
- notes.json 和 index.json 无变化

---

## 五、Topic Library 分层归类

### TC-18: AI 自动分配 category
**用户输入：**
> 我要准备PMP考试，明年3月考

**预期行为：**
- AI 调用 `zhigui_add_goal` 或 `zhigui_create_plan`，传入：
  - `topic: "PMP Exam"`, `category: "Learning"`
- Topic Library 中 PMP Exam 出现在 Learning 分类下

**验证点：**
- [ ] index.json 中 topic 的 category 字段为 "Learning"
- [ ] Dashboard 分类筛选下拉框包含 Learning
- [ ] PMP Exam 卡片显示在 Learning 分组下

---

### TC-19: 多 topic 共享同一 category
**操作：** 创建多个 Learning 类别的 topic：
- "English Speaking" (category: Learning)
- "PMP Exam" (category: Learning)
- "Guitar Practice" (category: Learning)

**预期行为：**
- Dashboard 中 Learning 分组显示 "3 topics · X notes"
- 三个 topic 卡片在同一分组下

---

### TC-20: 分类筛选
**操作：** 在 Dashboard Topic Library 中，从下拉框选择 "Health" 分类

**预期行为：**
- 只显示 Health 分类下的 topics
- 其他分类的 topics 隐藏

---

### TC-21: Topic 自动升级（promoted）
**前置条件：** 给某个 topic 添加 15+ 条笔记

**预期行为：**
- `brain._checkPromotion` 自动将 topic 标记为 `promoted: true`
- Dashboard 中该 topic 卡片显示金色边框 + 📂 Sub-category 徽章
- 分类标题显示 "expanded" 标记

**验证点：**
- [ ] index.json 中 topic 的 promoted=true
- [ ] Dashboard 卡片有 .promoted CSS 类

---

## 六、级联删除

### TC-22: 删除 topic 预览
**操作：** 调用 `zhigui_delete_topic { topicId: "t_xxx", confirm: false }`

**预期行为：**
- 返回 `{ aborted: true, preview: { label, notes, goals, events, ... } }`
- 不删除任何数据

---

### TC-23: 确认级联删除
**前置条件：** English Speaking topic 关联了 2 条笔记、1 个 goal、1 个 event

**操作：** 调用 `zhigui_delete_topic { topicId: "t_xxx", confirm: true }`

**预期行为：**
- 删除 topic 本身
- 删除关联的 2 条笔记（从 notes.json）
- 删除关联的 1 个 goal（从 goals.json）
- 删除关联的 1 个 event（从 events.json）
- 返回 `{ success: true, deleted: { notes: 2, goals: 1, events: 1 } }`

**验证点：**
- [ ] index.json 中不再包含该 topic
- [ ] notes.json/goals.json/events.json 中关联记录已删除
- [ ] Dashboard Topic Library 中该 topic 消失
- [ ] All 视图中关联的 goal/note 也消失

---

### TC-24: All 视图删除后 Library 同步
**操作：**
1. 在 All 视图中删除一个关联了 topic 的 goal
2. 切换到 Knowledge 视图

**预期行为：**
- Knowledge 视图中对应 topic 的 relatedCounts.goals 减少
- 如果该 topic 没有任何关联了，从 Library 中消失

**验证点：**
- [ ] topic index 中的 related.goals 不再包含已删除的 goal id
- [ ] Dashboard 显示更新后的关联数

---

## 七、自动脚本测试

运行以下脚本进行自动化测试：

```bash
cd d:\linxi\skill
node test/test-reminder.js      # 定时提醒测试
node test/test-context.js       # 上下文推送测试
node test/test-organize.js      # 自动整理测试
node test/test-category.js      # 分层归类测试
node test/test-cascade.js       # 级联删除测试
```

---

## 八、端到端测试流程

### E2E-1: 完整笔记生命周期
1. 用户："我在用影子跟读法练英语" → 创建 note + topic
2. 用户："英语练得怎么样了？" → 上下文推送该笔记
3. 用户："其实我发现影子跟读法对发音帮助最大" → 创建新 note
4. 调用 `zhigui_organize_notes` → 整理笔记
5. 用户："不学英语了" → 级联删除 English Speaking topic
6. 验证所有相关数据已清除

### E2E-2: 完整提醒生命周期
1. 用户："周五5点交报告" → 创建 reminder
2. 模拟时间到达 → reminder 触发，AI 通知
3. 用户："报告已经交了" → AI 删除/标记 reminder
4. 验证 Dashboard 提醒面板更新

### E2E-3: Dashboard 联动
1. 创建多个不同 category 的 topics
2. 验证分类筛选下拉框
3. 在 All 视图删除 goal → 切换到 Knowledge 验证同步
4. 添加 15+ 笔记 → 验证 topic 自动升级为 promoted
