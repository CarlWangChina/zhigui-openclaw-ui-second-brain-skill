# ZhiGui 知归

**一个由对话唤醒的个人助理系统 — 作为 MCP 技能运行的第二大脑。**

[English](./README.md) | [中文](./README.zh-CN.md)

---

## 知归是什么？

知归（ZhiGui）不是又一个待办清单应用。它是一个**个人智能系统**，将 JSON 文件驱动的知识图谱与桌面可视化面板结合，通过 MCP 协议连接到任何支持 MCP 的 AI 助手。

它不在后台运行、不推送通知、不替你做决定。相反，每次你与 AI 助手开始对话时，知归会加载一个紧凑的 Bootstrap 索引 — 包含你的全部目标、日程、笔记、决策和关系 — 据此给出精准的、有上下文感知的建议。

### 三种角色，同一大脑

知归的设计灵感来自三种经典的角色模型：

| 角色 | 职责 |
|------|------|
| **秘书** | 帮你看清全局 — 今日日程、逾期任务、推进中的目标、晨报与每日复盘。每次对话开始，它已经知道你今天有什么安排。 |
| **管家** | 默默打理一切日常事务 — 笔记归档、主题分类、行动追踪、决策记录。你不需要操心数据怎么存、存在哪。 |
| **药老** | 灵感来自《斗破苍穹》中的药老 — 藏在你意识深处的老师。他会根据你提供的信息，帮你做决策和规划：先做什么、后做什么，哪个性价比高，哪个不急可以后面再做，哪个快临期了必须动工。他也会提醒你哪些事不该做、哪些目标是空想、哪些决策会埋下隐患。 |

三种角色由同一套知识图谱驱动：笔记、目标、决策、日程通过外键（`topicId`、`noteIds`、`goalId`、`decisionIds`）互相关联，形成**可追溯的记忆网络**。

## 核心特性

- **40+ MCP 工具** — AI 助手可通过 MCP 读取、创建、更新和删除目标、日程、笔记、决策、待办和提醒。
- **关系图谱** — 每个实体都是关联的。一个日程项可以引用多个主题下的笔记，追溯到战略目标，并引用已采纳的决策。
- **分层索引** — 标题优先、详情按需读取。AI 默认只加载轻量索引，需要时才获取完整内容 — 节省上下文 token。
- **自动关联笔记** — 创建日程项时，AI 会根据主题和上下文自动建议关联的笔记、目标和决策。
- **长期记忆** — 实体有生命周期状态：活跃 → 停滞（30 天未引用）→ 归档候选。反思引擎只标记候选，不自动删除；清理需用户显式确认。
- **晨间指引** — AI 生成并按日期冻结的每日晨报，包含必做事项、建议和战略提醒。
- **每日反思** — 完成任务后，AI 生成复盘报告，覆盖已完成工作、目标健康度和注意力转移。
- **引用完整性** — 删除始终先预览影响，再等待确认，并清理失效关系。
- **周期与弹性事项** — 处理固定日期、时间待定、周期性和可延期工作项的不同逻辑。
- **可定制助手** — 修改 `SKILL.md` 来设计你想要的助手性格、行为规则和操作偏好。
- **Electron 桌面面板** — 常驻屏幕边缘的可视化面板，支持收起/展开两态切换，直接编辑日程、目标、笔记和待办事项。

## 快速开始

### 前置条件

- **Node.js ≥ 17** — 下载地址：[https://nodejs.org](https://nodejs.org)
- **支持 MCP 的 AI 工具** — 如 [Trae](https://www.trae.ai/)、Cursor 等

### 第一步：下载并解压

从 GitHub 下载 ZIP 并解压到任意目录：

```
https://github.com/CarlWangChina/zhigui-openclaw-ui-second-brain-skill
```

解压到例如 `D:\ZhiGui`。目录结构：

```
ZhiGui/
├── start.bat                    ← Windows 一键启动脚本
├── start.sh                     ← macOS/Linux 启动脚本
├── skill/                       ← 技能核心包
│   ├── engine/                  ← MCP 引擎 + 业务逻辑
│   ├── dashboard/               ← Web 面板 (server.js + public/)
│   ├── electron/                ← Electron 桌面壳
│   ├── lib/                     ← 配置与数据初始化
│   ├── scripts/                 ← 安装与种子脚本
│   ├── test/                    ← 测试套件
│   ├── SKILL.md                 ← AI 技能协议文档
│   ├── config.json              ← 引擎配置
│   ├── mcp-config-template.json ← MCP 配置模板
│   └── package.json             ← 依赖声明
├── zhigui-user-manual/          ← 中文用户手册 (HTML + PDF)
├── zhigui-user-manual-en/       ← 英文用户手册 (HTML + PDF)
├── package.json                 ← Electron 依赖
└── README.md
```

### 第二步：上传 Skill 到 AI 助手

如果你使用的 AI 工具支持「技能目录」（如 Trae 的 `~/.trae-cn/skills/`），将 `skill/` 目录内容复制过去：

```powershell
# 以 Trae 为例
Copy-Item -Path .\skill\* -Destination $env:USERPROFILE\.trae-cn\skills\zhigui\ -Recurse
```

或者使用项目自带的 setup 脚本自动完成：

```powershell
node skill/scripts/setup.js <项目目录> <技能目录> <node路径>
```

### 第三步：配置 MCP

打开 AI 工具的 MCP 配置页面，添加：

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

将 `D:/ZhiGui/skill/engine/server.js` 替换为你的实际路径。JSON 中建议使用正斜杠 `/`，避免反斜杠转义问题。

**验证：** 开始对话，说"帮我查看今日安排"。如果 AI 调用了 `zhigui_get_assistant_bootstrap` 工具并返回数据，说明配置成功。

### 可选：启动桌面面板

```powershell
# Windows
start.bat

# macOS / Linux
./start.sh
```

首次启动会自动安装依赖（npm install、Electron 二进制文件）并初始化数据目录。桌面右侧会出现一个窄长的面板窗口。

仅运行 Web 面板（无需 Electron）：

```powershell
cd skill
node dashboard/server.js
# 浏览器打开 http://localhost:7788
```

加载演示数据快速了解系统：

```powershell
cd skill
node scripts/seed-demo-data.js        # 中文演示数据
node scripts/seed-demo-data-en.js    # 英文演示数据
```

## 工作方式

```text
用户面板操作 ─┐
               ├─→ 统一 Actions / 关联实体 / 活动日志
用户与 AI 对话 ─┘                 │
                                  ▼
                    下一次相关对话读取 Bootstrap
                                  │
                  按需读取目标、笔记、日期或决策详情
                                  │
                 形成建议 / 更新状态 / 创建后续跟进
```

面板负责让用户直接查看和操作；MCP 负责让 AI 读取、推理和写入。两者不是彼此的替代品 — 它们共享同一套数据层，通过文件监视（`fs.watch`）实时同步。

## 系统架构

```text
用户 ←→ AI 助手 (Trae / Cursor 等)
              ↕ MCP 协议
         ZhiGui 引擎 (server.js)
              ↕ JSON 文件读写
         .zhigui/ 数据目录
              ↕ fs.watch 文件监视
         Electron 面板 (main.js)
              ↕ IPC 通信
         前端 UI (dashboard.js)
```

## 使用约定

1. 完成事项后，如其结果会影响目标、笔记或后续安排，请在下一次对话告诉 AI 结果；AI 才能解释这个事实并更新长期计划。
2. 对话中的"完成了"与面板点击完成都支持同一类影响更新 — 目标状态、笔记事实、决策和后续跟进应一起写入。
3. 没有明确时间的事项不要伪造时间；有确定日期但没有时间的事项应出现在那一天。
4. 笔记只在确有执行价值时关联到行程 — "取快递"这类自包含事项不需要强行挂笔记。
5. 删除始终先预览影响，再等待用户确认。

## 用户手册

详细的安装指南、UI 面板功能介绍和使用示例，提供中英文两个版本：

| 语言 | HTML | PDF | 位置 |
|------|------|-----|------|
| 中文 | `zhigui-user-manual/zhigui-user-manual.html` | `zhigui-user-manual/zhigui-user-manual.pdf` | [打开](./zhigui-user-manual/zhigui-user-manual.html) |
| 英文 | `zhigui-user-manual-en/zhigui-user-manual-en.html` | `zhigui-user-manual-en/zhigui-user-manual-en.pdf` | [打开](./zhigui-user-manual-en/zhigui-user-manual-en.html) |

每份手册覆盖：产品概述、三步安装流程、MCP 配置、UI 面板功能详解、核心智能特性（自动关联、分层索引、长期记忆、SKILL.md 自定义）、使用示例和常见问题。

## 开发与验证

```powershell
npm.cmd test
```

数据默认位于 `skill/.zhigui/`。其中的示例数据仅用于演示关联、完成、复盘和后续跟进流程。

详细的 AI 行为规范见 [skill/SKILL.md](./skill/SKILL.md)。

## 删除与生命周期

删除是不可逆的 — 面板与 AI 都会先展示关联影响，再等待确认，并由统一命令层清理失效关系。实体（笔记、目标、决策）有自动生命周期状态：活跃 → 停滞（30 天未引用）→ 归档候选（长期不活跃）。反思引擎只标记候选，不自动删除；清理需用户显式确认。

## 反馈

发现问题或有建议？邮箱：**huangkkkke16@gmail.com**

## 许可

本项目开源。详见仓库说明。
