# ZhiGui 测试案例

## 1. 事件沉淀与话题分类（AI 驱动，非关键词匹配）

### TC-1.1 英语口语学习沉淀
**输入**: "我想提高英语口语能力，工作汇报需要用"
**预期**:
- AI 调用 `create_event`，传入 `domains: ["academic"]`，facts 中包含 `topic: "English Speaking"`
- 引擎自动创建 "English Speaking" 话题
- goals.json 中新增一个 goal，`topicId` 指向该话题
- Topic Library 中显示 "English Speaking" 话题
- 话题关联 1 个 goal

### TC-1.2 老婆生日（跨域）
**输入**: "下个月20号老婆生日，要提前准备礼物"
**预期**:
- AI 传入 `domains: ["relationship"]`，`topic: "Wife Birthday"`
- 创建 goal（deadline=2026-08-20）+ 关联话题
- Topic Library 显示 "Wife Birthday"

### TC-1.3 拔智齿（一次性琐事）
**输入**: "后天下午要去拔智齿"
**预期**:
- AI 传入 `domains: ["health"]`，`topic: "Dentist"`，`type: "errand"`
- 创建 errand + 关联话题
- auto_schedule 时该 errand 只在后天出现，不重复

### TC-1.4 闲聊不沉淀
**输入**: "今天天气真好"
**预期**:
- AI 传入 `facts: []`，`type: "smalltalk"`
- 不创建任何 goal/errand/note
- 事件流记录但无派生

---

## 2. 话题沉淀与自动分离

### TC-2.1 话题达到阈值自动分离
**前置**: "English Speaking" 话题已有 5 条笔记
**操作**: 再添加 1 条英语相关笔记
**预期**:
- 笔记数达到 6（阈值）
- 自动从 notes.json 分离到 `topics/t_xxx.json`
- Topic Library 显示 "Precipitated" 标签
- 后续 AI 读取只读独立文件，不扫全部 notes.json

### TC-2.2 重建索引
**前置**: index.json 中 topics 为空（旧数据迁移）
**操作**: 点击 Topic Library 的 "Rebuild Index" 按钮
**预期**:
- 扫描所有 goals/notes/errands/events
- 仅使用已有的 AI 话题 ID/标题重建关联
- 无法判定的笔记保持“待 AI 归纳”，不用关键词猜测
- 返回统计：扫描了多少条目、创建了多少话题
- Topic Library 显示所有话题

---

## 3. 日程安排

### TC-3.1 忙碌日自动延后
**前置**: 今天已有 3 个 must 级琐事，占用 6 小时
**操作**: 调用 `auto_schedule`
**预期**:
- 占用率 ≥ 80%，判定为忙碌日
- 跳过当天发展目标安排
- 决策日志记录 `busy_day_postponed`
- 发展目标延续到下一个空闲日

### TC-3.2 手动锁定任务时间
**操作**: 在看板上点击任务时间，改为 09:00，时长 60 分钟
**预期**:
- 任务标记 `manualLocked: true`
- 显示 🔒 锁定标记
- 下次 `auto_schedule` 不覆盖该任务
- AI 排程自动避开 09:00-10:00 时段
- 决策日志记录 `slot_blocked`

### TC-3.3 一次性目标不重复
**输入**: "7月31日要交项目报告"
**预期**:
- 识别为一次性目标（isOneShotGoal）
- 只在截止日前 3 天出现在日程中
- 完成后标记 goal.completed，后续不再生成

### TC-3.4 长期目标每日安排
**输入**: "我想学吉他，不着急，年内学会"
**预期**:
- 识别为长期目标（非 one-shot）
- 每天在空闲时段安排练习
- 某天忙碌时自动延后，次日延续

---

## 4. 删除与级联

### TC-4.1 删除话题（级联删除）
**操作**: 在 Topic Library 点击 "Cascade delete all" 删除 "English Speaking"
**预期**:
- 先显示预览（多少个 goals/notes/events 将被删除）
- 确认后删除话题及其所有关联数据
- notes.json/goals.json 中对应记录被清除
- 无孤儿数据

### TC-4.2 删除目标
**操作**: 删除一个 currentGoal
**预期**:
- goals.json 中删除该目标
- index.json 中解除话题关联
- 未来日程中该目标的任务不再生成

### TC-4.3 清空数据
**操作**: AI 调用 `zhigui_delete_history`、`zhigui_clear_briefings`
**预期**:
- 对话历史清空
- 晨报清空
- 下次 auto_schedule 重新生成晨报

---

## 5. 日期切换联动

### TC-5.1 切换日期更新所有区域
**操作**: 在看板上从 7/19 切换到 7/17
**预期**:
- 日程区域显示 7/17 的任务
- 琐事区域显示 7/17 的琐事（之前不更新，已修复）
- 晨报区域显示 7/17 的晨报

---

## 6. AI 驱动分类（非关键词）

### TC-6.1 AI 自定义话题名
**输入**: "我报名了一个叫'数据治理工程师'的认证考试"
**预期**:
- AI 判断 `topic: "Data Governance Certification"`（或中文"数据治理认证"）
- 引擎用 AI 提供的话题名创建话题
- 不依赖任何内置关键词或预设分类

### TC-6.2 多话题事实
**输入**: "老婆对花粉过敏，我也要注意"
**预期**:
- AI 传入 2 个 facts：
  - `{domain: "relationship", content: "Wife allergic to pollen", type: "note", topic: "Wife Health"}`
  - `{domain: "health", content: "User needs to be careful with pollen", type: "note", topic: "Allergy"}`
- 创建 2 个话题，各自关联 1 条笔记

---

## 7. Electron 桌面端

### TC-7.1 Rebuild Index 在 Electron 中工作
**操作**: 在 Electron 桌面端点击 "Rebuild Index"
**预期**:
- 通过 IPC 调用 main.js 的 `reindex` handler
- 返回重建统计
- Topic Library 刷新显示话题
- 不再报 "Reindex failed:" 错误

### TC-7.2 任务时间编辑在 Electron 中工作
**操作**: 在 Electron 桌面端点击任务时间修改
**预期**:
- 通过 IPC 调用 main.js 的 `update-task` handler
- 任务时间更新并锁定
- 显示 🔒 标记
