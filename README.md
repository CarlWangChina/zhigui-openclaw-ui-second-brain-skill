[English](#english) | [简体中文](#chinese)

<a id="english"></a>

[English](#english) | [简体中文](#chinese)

# ZhiGui — A UI-Powered Second-Brain Agent Skill for OpenClaw, Hermes Agent, WorkBuddy, TRAE & QClaw

> Understand your past. Decide today. Plan tomorrow.

> An advanced interactive Agent Skill that turns long-term memory into better decisions and tomorrow's plan.

<!--
README COMPLETION TASK — Kewei Huang

Before public release, complete the first screen of this README in the following order:

1. Add one polished ZhiGui hero image.
2. Add one 10–20 second GIF showing the real interactive UI workflow.
3. Add four real product screenshots:
   - Decision Comparison
   - Tomorrow's Plan
   - Conflict Review
   - Guided Note Import
4. The screenshots and GIF must appear near the top of the README, before the long feature descriptions.
5. Do not use design mockups in place of the real product interface.
6. Save the files under assets/ and uncomment the Markdown below.

Suggested files:

![ZhiGui Hero](assets/zhigui-hero.png)
![ZhiGui Interactive Demo](assets/zhigui-demo.gif)

| Decision Comparison | Tomorrow's Plan |
|---|---|
| ![](assets/decision-comparison.png) | ![](assets/tomorrow-plan.png) |

| Conflict Review | Guided Note Import |
|---|---|
| ![](assets/conflict-review.png) | ![](assets/guided-import.png) |
-->

## Why ZhiGui?

Most note-taking tools help you store more information. ZhiGui helps you use what you already know.

Your ideas are often scattered across different notes, dates, and applications. Some reflect what you believed months or years ago. Others conflict with decisions you have already made.

A conventional note app continues storing all of them. An AI using those notes may therefore make recommendations based on outdated plans, invalid assumptions, or contradictory information.

ZhiGui continuously turns scattered, conflicting, and outdated notes into an up-to-date understanding of your:

- goals;
- priorities;
- preferences;
- constraints;
- commitments;
- previous decisions;
- unfinished tasks;
- relevant long-term memories.

It then uses that understanding to help you make better decisions and automatically build tomorrow's plan.

ZhiGui is not another standalone note-taking app. It is an advanced, UI-powered Agent Skill that runs through supported agent platforms.

## More Than a Prompt-Only Skill

ZhiGui is more than a plain `SKILL.md` or a collection of prompts.

It combines agent reasoning with interactive visual workflows for:

- importing existing notes;
- previewing where each thought will be stored;
- detecting conflicts between old and new ideas;
- comparing different choices;
- reviewing the evidence behind a recommendation;
- generating tomorrow's plan;
- confirming or modifying the final result.

No separate note-taking application is required. Install ZhiGui in a supported agent platform and use its guided UI workflows through the host environment.

## Core Capabilities

### 1. Make Better Decisions

ZhiGui uses your long-term memory—not just your latest prompt—to help you compare options and make choices.

It considers your past experiences, current goals, personal preferences, practical constraints, previous decisions, abandoned plans, and failed attempts.

Instead of returning generic advice, ZhiGui presents the relevant factors through an interactive comparison workflow, helping you understand:

- which option better matches your current goals;
- which past experiences are relevant;
- which constraints could affect the result;
- what you may gain or lose with each choice;
- whether an old preference is still valid;
- which option is more suitable for who you are now.

The final choice remains yours. ZhiGui helps ensure that the decision is based on your complete and current context.

### 2. Automatically Plan Tomorrow

ZhiGui reviews your long-term goals, deadlines, unfinished tasks, recent changes, and current priorities to generate tomorrow's plan automatically.

A task recorded months ago can resurface when its date or conditions become relevant. A task invalidated by a newer decision stays out of the plan.

ZhiGui can:

- identify what needs to be done next;
- remove tasks that are no longer relevant;
- connect daily actions to long-term goals;
- prioritize tasks based on urgency and importance;
- explain why each task appears;
- present the plan through an interactive UI;
- let you confirm, remove, reorder, or modify tasks;
- deliver tomorrow's plan through your existing agent channels.

The result is not a static to-do list. It is a daily action plan that evolves with your goals and decisions.

### 3. Keep Long-Term Memory Current

Accurate decisions and daily plans require accurate long-term memory.

ZhiGui routes scattered thoughts into the right notes, detects contradictions, retires outdated plans, and preserves the information that still matters.

For example, you may once have planned to work at one organization and created many notes around that future. If you later join a different organization, the old plan should not continue shaping your decisions.

ZhiGui identifies the conflict, removes content that is no longer applicable, preserves useful information, and integrates what still matters into your current notes.

The goal is not to erase your history. The goal is to prevent outdated history from steering your present.

### 4. Import and Consolidate Existing Notes

ZhiGui provides a guided UI for importing notes accumulated in other applications.

During the import process, you can:

1. select the notes or files you want to import;
2. preview how the content will be classified;
3. review the topics detected by ZhiGui;
4. inspect conflicts between notes from different dates;
5. choose which idea represents your current position;
6. preserve useful historical context;
7. confirm the final consolidated result before changes are applied.

Instead of turning imported notes into another information pile, ZhiGui transforms them into a current, structured, and actionable memory system.

## Interactive UI

The interactive UI is a core part of ZhiGui, not an optional decoration.

The UI should make the system's reasoning visible and controllable. Users should be able to review important changes instead of allowing the AI to silently rewrite their memory.

The primary UI workflows include:

| Workflow | What the user can do |
|---|---|
| Decision Comparison | Compare options, evidence, trade-offs, and relevant memories |
| Tomorrow's Plan | Review, reorder, modify, remove, and confirm tomorrow's tasks |
| Conflict Review | Inspect conflicting ideas and choose the currently valid version |
| Guided Import | Import old notes and preview classification before applying changes |
| Memory Update | Review which information will be retained, moved, updated, or retired |

## Platform Compatibility

| Platform | Skill Integration | Interactive UI | Status |
|---|---:|---:|---|
| OpenClaw | Compatible build | Under testing | Testing |
| Hermes Agent | Compatible build | Under testing | Testing |
| WorkBuddy | Yes | Yes | Tested |
| TRAE | Yes | Yes | Tested |
| QClaw | Compatible build | Under testing | Testing |

WorkBuddy and TRAE have completed functional and UI testing.

OpenClaw, Hermes Agent, and QClaw compatibility testing is currently in progress. Their status will be changed to `Tested` only after the complete Skill workflow and interactive UI have been verified.

<!--
TASK — Kewei Huang

1. Add the exact installation commands for all five platforms.
2. Do not mark OpenClaw, Hermes Agent, or QClaw as Tested before completing real tests.
3. For every tested platform, verify:
   - Skill installation
   - UI launch
   - Note import
   - Conflict review
   - Decision comparison
   - Tomorrow planning
   - Plan delivery through the platform's existing agent channels
4. Update this table immediately after each platform passes testing.
-->

## Installation

<!--
TASK — Kewei Huang

Replace this comment with exact, copy-paste-ready installation instructions.

Required subsections:

### OpenClaw
### Hermes Agent
### WorkBuddy
### TRAE
### QClaw

Each subsection must contain:

1. Installation command or marketplace path
2. Required permissions and dependencies
3. How to open the interactive UI
4. How to import the first note
5. How to verify that installation succeeded
6. One screenshot of the completed installation
-->

Platform-specific installation instructions will be added after compatibility verification.

## User Guide

A step-by-step illustrated PDF user guide will be included in this repository.

The manual will be written for ordinary users rather than developers. Every major action will include a real screenshot, including:

- installing ZhiGui;
- importing old notes;
- reviewing note classification;
- identifying conflicting ideas;
- confirming the current valid version;
- comparing decisions;
- generating tomorrow's plan;
- modifying and confirming the final plan;
- receiving the plan through existing agent channels.

<!--
TASK — Kewei Huang

Create:

docs/ZhiGui-User-Guide-EN.pdf
docs/ZhiGui-User-Guide-ZH.pdf

The manual must use real screenshots for every key step.

After the files are completed, add:

- [English User Guide](docs/ZhiGui-User-Guide-EN.pdf)
- [中文使用手册](docs/ZhiGui-User-Guide-ZH.pdf)
-->

## Authors

ZhiGui was created by Zihao Wang and Kewei Huang.

- **Zihao Wang** — Product concept, decision and planning workflows, use cases, and project direction
- **Kewei Huang** — System design, UI development, platform integration, and documentation

## License

ZhiGui is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

Personal, educational, and noncommercial research use is permitted. Commercial use requires a separate written license from the copyright holder.

Created by Zihao Wang and Kewei Huang.  
Copyright © 2026 Samoye AI. All rights reserved.

---

<a id="chinese"></a>

[English](#english) | [简体中文](#chinese)

# 知归——适配 OpenClaw、Hermes Agent、WorkBuddy、TRAE 与 QClaw 的交互式 AI 第二大脑 Skill

> 理解过去，决定现在，安排明天。

> 一个利用长期记忆帮助你做出选择、自动规划明天，并提供可视化交互界面的高级 Agent Skill。

## 为什么需要知归？

大多数笔记软件解决的是“如何记录更多”，知归解决的是“如何真正使用已经积累的信息”。

人的想法经常散落在不同的软件、日期和笔记中。有些内容代表几个月甚至几年前的想法，有些内容则与后来做出的决定相互冲突。

普通笔记软件会继续保留所有内容。如果 AI 直接读取这些笔记，就可能根据已经过时的计划、失效的前提或者相互矛盾的信息提供建议。

知归会持续整理零散、冲突和已经过时的笔记，形成对以下信息的准确理解：

- 当前目标；
- 现实约束；
- 个人偏好；
- 任务优先级；
- 已经作出的决定；
- 尚未完成的事项；
- 仍然有效的长期记忆。

在此基础上，知归会利用长期记忆帮助用户做出更合适的选择，并自动生成第二天的行动计划。

知归不是一款需要单独下载的笔记软件，而是一个可以安装在不同智能体平台中的、带交互式 UI 的高级 Agent Skill。

## 不只是一个由提示词组成的普通 Skill

知归不只是一个普通的 `SKILL.md`，也不是一组简单的提示词。

它将智能体推理能力与可视化交互流程结合起来，让用户能够：

- 导入以前积累的笔记；
- 预览每一个想法将被归入什么位置；
- 发现新旧想法之间的冲突；
- 比较不同选择；
- 查看系统给出建议的依据；
- 自动生成第二天的行动计划；
- 确认、删除、调整或者重新排序最终结果。

用户不需要额外下载新的笔记软件，只需要在支持的智能体平台中安装知归，即可通过宿主环境使用完整的交互式工作流程。

## 核心功能

### 1. 帮助用户做出更好的决策

知归不会只根据用户刚刚输入的一段话提供泛泛的建议，而是会综合用户的长期记忆，帮助用户比较不同方案并做出选择。

系统会考虑：

- 用户过去的经历；
- 当前目标；
- 个人偏好；
- 现实约束；
- 已经作出的决定；
- 曾经放弃的计划；
- 以前失败的尝试；
- 当前仍然有效的信息。

知归会通过交互式比较界面，帮助用户理解：

- 哪个方案更符合当前目标；
- 哪些历史经历与这次选择有关；
- 哪些现实约束会影响最终结果；
- 每个方案可能获得和失去什么；
- 以前的偏好现在是否仍然有效；
- 哪个方案更适合现在的自己。

最终选择仍然由用户作出。知归的作用，是让这次选择建立在更加完整、准确并且符合当前情况的信息之上。

### 2. 自动规划明天应该做什么

知归会综合长期目标、时间节点、尚未完成的任务、近期变化和当前优先级，自动生成第二天的行动计划。

一项几个月以前记录的任务，只要到了应该处理的日期或者满足了相关条件，就会重新浮现出来。

如果用户后来作出了新的决定，导致以前的一项任务已经没有必要继续完成，那么这项失效任务就不会继续进入明天的计划。

知归可以：

- 判断接下来最应该完成什么；
- 删除已经不再需要处理的事项；
- 将每日行动与长期目标联系起来；
- 根据重要程度和紧急程度确定优先级；
- 说明每项任务为什么会出现在计划中；
- 通过交互式 UI 展示明日计划；
- 允许用户确认、删除、调整和重新排序任务；
- 通过用户现有的智能体消息渠道发送明日计划。

最终得到的不是一份静态待办清单，而是一份会随着用户目标和决定不断更新的动态行动计划。

### 3. 让长期记忆保持准确

准确的决策和每日计划，必须建立在准确的长期记忆之上。

知归会把零散想法归入正确的笔记，发现新旧内容之间的冲突，淘汰已经失效的计划，并保留对当前仍然有价值的信息。

例如，用户以前计划去某一个单位工作，也围绕这个单位制定了很多规划；后来实际去了另一个单位，那么原来的规划就不应该继续影响现在的选择。

知归会识别其中的冲突，删除已经不再适用的内容，保留仍然有价值的信息，并把这些信息合并到当前有效的笔记中。

它的目的不是抹掉用户的历史，而是避免已经过时的历史继续错误地影响现在。

### 4. 通过引导式 UI 批量导入旧笔记

知归提供可视化引导流程，帮助用户导入以前在其他软件中积累的笔记。

用户可以：

1. 选择需要导入的笔记或文件；
2. 预览内容将被归入哪些主题；
3. 查看知归识别出的不同笔记主题；
4. 检查不同日期笔记之间的冲突；
5. 选择哪个想法代表自己现在的立场；
6. 保留仍然有用的历史信息；
7. 在正式修改前确认最终整理结果。

知归不会把导入的旧笔记变成另一个信息垃圾堆，而是会将其整理成符合当前情况、结构清晰并且可以继续用于决策和行动的长期记忆。

## 交互式 UI

交互式 UI 是知归的核心组成部分，而不是装饰性的附加功能。

重要的长期记忆不能由 AI 在后台静默修改。用户应该能够看到系统准备修改什么、为什么修改，并在重要内容发生变化之前进行确认。

主要交互流程包括：

| 交互流程 | 用户可以完成的操作 |
|---|---|
| 决策比较 | 比较不同方案、依据、得失和相关长期记忆 |
| 明日计划 | 查看、调整、删除、重新排序并确认第二天的任务 |
| 冲突检查 | 查看新旧想法之间的冲突并选择当前有效版本 |
| 引导式导入 | 批量导入旧笔记并在应用修改前预览分类结果 |
| 记忆更新 | 查看哪些内容将被保留、移动、更新或者停用 |

## 平台兼容情况

| 平台 | Skill 适配 | 交互式 UI | 当前状态 |
|---|---:|---:|---|
| OpenClaw | 已提供兼容版本 | 正在测试 | 测试中 |
| Hermes Agent | 已提供兼容版本 | 正在测试 | 测试中 |
| WorkBuddy | 是 | 是 | 已完成测试 |
| TRAE | 是 | 是 | 已完成测试 |
| QClaw | 已提供兼容版本 | 正在测试 | 测试中 |

WorkBuddy 和 TRAE 已经完成功能与交互式 UI 测试。

OpenClaw、Hermes Agent 和 QClaw 正在进行兼容性测试。只有完整 Skill 流程和交互式 UI 通过验证以后，状态才会更新为“已完成测试”。

## 安装方法

各平台的准确安装方法将在兼容性验证完成后补充，包括：

- OpenClaw；
- Hermes Agent；
- WorkBuddy；
- TRAE；
- QClaw。

每个平台的安装说明都会包含：

1. 安装命令或者 Skill 市场入口；
2. 所需权限和依赖；
3. 如何打开交互式 UI；
4. 如何导入第一份笔记；
5. 如何确认安装成功；
6. 完成安装后的实际截图。

## 图文使用手册

本项目将提供面向普通用户的逐步截图 PDF 使用手册，而不是面向开发者的技术说明。

手册将完整展示：

- 如何安装知归；
- 如何导入以前的笔记；
- 如何查看笔记分类结果；
- 如何发现新旧想法冲突；
- 如何确认当前有效版本；
- 如何比较不同选择；
- 如何生成第二天的计划；
- 如何修改和确认最终计划；
- 如何通过现有智能体消息渠道接收计划。

## 作者

知归由王子豪、黄可伟共同创作。

- **王子豪**：产品构想、决策与规划逻辑、使用场景及项目指导
- **黄可伟**：系统设计、交互 UI 开发、平台适配及使用文档

## 许可证

知归依据 [PolyForm Noncommercial License 1.0.0](LICENSE) 以源码可见方式发布。

允许个人、教育和非商业研究使用。任何商业用途均需要获得版权所有者的单独书面授权。

由王子豪、黄可伟共同创作。  
Copyright © 2026 Samoye AI. All rights reserved.

<!--
黄可伟最终检查任务

1. README 第一屏必须加入真实产品主视觉、GIF 和四张核心功能截图。
2. GIF 时长控制在 10～20 秒，展示真实 UI 操作。
3. 补充五个平台准确、可复制的安装方法。
4. WorkBuddy 和 TRAE 保持“已完成测试”。
5. OpenClaw、Hermes Agent 和 QClaw 测试完成后再修改状态。
6. 完成中英文两份逐页截图 PDF 手册并加入下载链接。
7. 检查 README 中所有图片、锚点、文件路径和下载链接。
8. 确保英文内容和中文内容的功能描述保持一致。
-->


# ZhiGui — A Second Brain That Helps You Decide Today and Plan Tomorrow

> An advanced, UI-powered AI second brain Agent Skill for OpenClaw · Hermes Agent · WorkBuddy · TRAE · QClaw

> Understand your past. Decide today. Plan tomorrow.

> ZhiGui uses long-term memory to help you make better decisions, automatically plan tomorrow, resolve conflicting notes, and deliver each day's plan through your existing agent channels.

<!--
IMPORTANT — PRODUCT POSITIONING

This section defines the core positioning of ZhiGui.

Do not change the feature priority:

1. Help users make better decisions.
2. Automatically plan tomorrow.
3. Keep long-term memory accurate as the foundation.

Note organization is not the final product value. It exists to make decision support and daily planning reliable.
-->

## Product Overview

**Product name:** 知归 / ZhiGui

**Chinese positioning:** 一个利用长期记忆帮助你做出选择、自动安排明天的 AI 第二大脑

**English positioning:** A proactive AI second brain that helps you make better decisions and automatically plan tomorrow.

**Repository name:** `zhigui-openclaw-second-brain`

**Skill name:** `zhigui-second-brain`

**README title:** ZhiGui — A Second Brain That Helps You Decide Today and Plan Tomorrow

**Slogan:** Understand your past. Decide today. Plan tomorrow.

ZhiGui is not a note-taking tool that only records and organizes information. It is an AI second brain built on your personal long-term memory.

It continuously understands your past experiences, current goals, practical constraints, and priorities. It helps you make more suitable decisions when facing different choices and automatically determines what you should do tomorrow based on all relevant long-term information.

| Purpose | Recommended Name |
|---|---|
| Chinese product name | 知归 |
| Full Chinese name | 知归 AI 第二大脑 |
| English brand name | ZhiGui |
| Full English name | ZhiGui AI Second Brain |
| GitHub repository | `zhigui-openclaw-second-brain` |
| Skill name | `zhigui-second-brain` |
| Core positioning | Use long-term memory to help users make better decisions and automatically plan tomorrow |
| Chinese slogan | 理解过去，决定现在，安排明天 |
| English slogan | Understand your past. Decide today. Plan tomorrow. |

## Core Value 1: Make Better Decisions

When you need to choose between multiple options, ZhiGui does not answer based only on the few sentences in your latest prompt.

It considers:

- your past experiences and decisions;
- your current goals and priorities;
- your confirmed personal preferences;
- your time, resources, and practical constraints;
- previous attempts that failed or were abandoned;
- long-term plans that are still valid.

The result is not a piece of generic advice. It is a choice analysis grounded in your complete personal context.

Through its interactive UI, ZhiGui can present the relevant factors, evidence, trade-offs, and memories behind each option, helping you make a choice that better fits who you are now.

## Core Value 2: Automatically Plan Tomorrow

ZhiGui combines your long-term goals, recent tasks, important dates, unfinished items, and latest changes to automatically generate what you should do the next day.

No matter how long ago a task was recorded, it can resurface when the right date or condition arrives.

If your later decisions make an earlier task unnecessary, that outdated task will no longer appear in tomorrow's plan.

The result is not a static to-do list. It is a dynamic action plan that continuously changes with your goals and real-life circumstances.

After you review and confirm the plan through the interactive UI, ZhiGui can deliver tomorrow's plan through your existing agent channels.

## Foundation: Keep Long-Term Memory Accurate

To make decision support and daily planning reliable, ZhiGui first solves two fundamental problems found in traditional note-taking systems.

### 1. Put Every Scattered Thought in the Right Place

Every scattered thought can be automatically assigned to the correct topic and note instead of remaining fragmented across different dates, files, and applications.

### 2. Resolve Conflicts Between Old and New Ideas

When new and old ideas conflict, ZhiGui identifies information that has become outdated, preserves what is still valuable, and forms an effective version that reflects your current situation.

Past long-term memories are not simply discarded. They are placed in the right historical context and prevented from incorrectly steering your present decisions.

Therefore, organizing notes is not the final goal.

The purpose is to ensure that the long-term memory used by AI for decision-making and daily planning is accurate, complete, and consistent with your current situation.

<!--
重要：产品定位

以下内容是知归的核心产品定义，不要修改功能优先级：

1. 第一核心功能是帮助用户决策和选择。
2. 第二核心功能是自动规划明天。
3. 笔记整理、冲突处理和长期记忆校正是支撑以上两个功能的底层能力。

笔记整理不是知归的最终用途。
-->

## 产品概览

**产品名称：** 知归 / ZhiGui

**中文定位：** 一个利用长期记忆帮助你做出选择、自动安排明天的 AI 第二大脑

**英文定位：** A proactive AI second brain that helps you make better decisions and automatically plan tomorrow.

**Repository name：** `zhigui-openclaw-second-brain`

**Skill name：** `zhigui-second-brain`

**README title：** ZhiGui — A Second Brain That Helps You Decide Today and Plan Tomorrow

**Slogan：** Understand your past. Decide today. Plan tomorrow.

知归不是一个只负责记录和整理的笔记工具，而是一个建立在个人长期记忆之上的 AI 第二大脑。它会持续理解你过去的经历、现在的目标、现实约束和优先级，帮助你在面对选择时做出更合适的决策，并根据所有长期信息自动规划明天应该做什么。

| 用途 | 推荐名称 |
|---|---|
| 中文产品名 | 知归 |
| 中文完整名称 | 知归 AI 第二大脑 |
| 英文品牌名 | ZhiGui |
| 英文完整名称 | ZhiGui AI Second Brain |
| GitHub 项目名 | `zhigui-openclaw-second-brain` |
| Skill 名称 | `zhigui-second-brain` |
| 核心定位 | 基于长期记忆，帮助用户做出更好的选择，并自动规划明天 |
| 中文宣传语 | 理解过去，决定现在，安排明天 |
| 英文宣传语 | Understand your past. Decide today. Plan tomorrow. |

## 第一核心功能：帮助用户决策和选择

当用户需要在多个方案之间做选择时，知归不是只根据用户刚刚输入的几句话回答，而是会综合考虑：

- 用户过去的经历与决定；
- 当前目标和优先级；
- 已经确认的个人偏好；
- 时间、资源和现实约束；
- 以前做过但已经失败或放弃的尝试；
- 当前仍然有效的长期计划。

最终给出的不是一段泛泛的建议，而是建立在用户完整个人背景之上的选择分析。

知归还会通过交互式 UI 展示不同方案涉及的因素、依据、得失和相关长期记忆，帮助用户做出更加符合当前情况的选择。

## 第二核心功能：自动规划明天

知归会综合长期目标、近期任务、日期节点、未完成事项和最新变化，自动生成第二天应该完成的事情。

不管一件事记录在多久以前，只要到了应该处理的时间，它就会重新浮现；如果用户后来的想法已经发生变化，原来的任务不再需要完成，它就不会继续进入明天的计划。

因此，它规划的不是一份静态待办清单，而是一份会随着用户目标和现实情况持续变化的动态行动计划。

用户通过交互式 UI 检查并确认计划后，知归还可以通过用户现有的智能体消息渠道发送明日计划。

## 底层能力：让长期记忆保持准确

为了让决策和每日规划可靠，知归首先需要解决传统笔记的两个问题：

### 1. 让每一个零散想法归入正确位置

每一个零散想法都能自动归入正确的主题和笔记，而不是继续散落在不同日期、文件和软件中。

### 2. 解决新旧想法之间的冲突

当新旧想法发生冲突时，知归会识别已经过时的内容，保留仍然有价值的信息，最终形成符合用户当前情况的有效版本。

过去的长期记忆不会被简单丢弃，而是会各归其位，被放回正确的历史背景中，避免已经过时的信息继续错误地影响现在的决定。

所以，笔记整理不是最终目的，而是为了保证：

> AI 用来帮助你决策和规划的长期记忆，是准确、完整并且符合当前情况的。
