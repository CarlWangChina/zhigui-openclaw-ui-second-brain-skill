# 安全审查报告 — 灵犀 (ZhiGui) AI 日程助理

**审查日期**: 2026-07-17  
**审查范围**: `skill/dashboard/server.js`, `skill/dashboard/public/dashboard.js`, `skill/dashboard/public/index.html`, `skill/electron/main.js`, `skill/electron/preload.js`, `skill/engine/server.js`, `skill/engine/brain-index.js`  
**项目类型**: Node.js (后端 MCP Server + HTTP 看板), 原生 JS (前端), Electron (桌面端)

---

## 执行摘要

项目整体安全架构合理：Electron 正确使用 `contextIsolation: true` + `nodeIntegration: false`，MCP Server 通过 JSON-RPC over stdio 本地通信，数据持久化为本地 JSON 文件。本次审查发现 **3 个高危**、**3 个中危**、**2 个低危**问题，均已修复。

---

## 已修复漏洞

### [S-01] HIGH — XSS：`escapeHtml` 不转义引号，但输出用于 `onclick` 属性中的 JS 字符串

**文件**: `skill/dashboard/public/dashboard.js`  
**位置**: `escapeHtml()` 函数 (原 L1573) 及 6 处 `onclick` 调用

**问题**: `escapeHtml` 使用 `div.textContent = str; return div.innerHTML;`，仅转义 `<`、`>`、`&`，不转义单引号和双引号。但转义后的值被放在 `onclick="openPriorityModal('task','ESCAPED_TITLE',50)"` 中，作为 JS 单引号字符串的参数。攻击者可通过 `task.title` 包含 `');alert(1);//` 来注入任意 JS 代码。

数据来源：MCP 工具接受任意文本（AI 生成或用户输入），存入 `goals.json`/`errands.json`/`notes.json`，前端原样渲染。

**修复**: 
1. 新增 `escapeAttr()` 函数，使用反斜杠转义 JS 字符串上下文中的单引号（`'` → `\'`），同时使用 `&quot;` 转义 HTML 属性上下文中的双引号
2. 将所有 6 处 `onclick` 属性中的 `escapeHtml()` 替换为 `escapeAttr()`
3. `escapeHtml()` 也增加了引号转义，防止未来误用

### [S-02] HIGH — 路径遍历：`startsWith` 检查可被前缀后缀绕过

**文件**: `skill/dashboard/server.js`  
**位置**: `serveStatic()` 函数 (原 L807-815)

**问题**: 原代码使用 `path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '')` + `path.join(PUBLIC_DIR, safePath)` + `filePath.startsWith(PUBLIC_DIR)`。`startsWith` 检查存在经典绕过：若 `PUBLIC_DIR` 为 `.../public`，攻击者请求 `/../publicevil/file`，解析后路径 `.../publicevil/file` 以 `.../public` 开头但实际是兄弟目录。

**修复**: 使用 `path.resolve()` 完全规范化路径，并检查 `filePath.startsWith(resolvedPublic + path.sep)` 添加路径分隔符边界。

### [S-03] HIGH — DoS：POST 请求体无大小限制

**文件**: `skill/dashboard/server.js`  
**位置**: `parseBody()` 函数 (L189-199)

**问题**: `req.on('data', chunk => { body += chunk; })` 无限累积数据，恶意请求可发送超大 body 耗尽内存。

**修复**: 添加 10MB 上限，超限时 `req.destroy()` 并 reject。

### [S-04] MEDIUM — CORS 通配符 `*` 允许任意网站访问本地 API

**文件**: `skill/dashboard/server.js`  
**位置**: HTTP 服务器主函数 (原 L836)

**问题**: `Access-Control-Allow-Origin: *` 允许用户访问的任何恶意网站向本地看板 API (`localhost:7788`) 发起跨域请求，读取/修改日程数据。

**修复**: 仅允许 `localhost:7788`、`127.0.0.1:7788`、`file://`、`app://` (Electron) 来源。

### [S-05] MEDIUM — 无 Content Security Policy (CSP)

**文件**: `skill/dashboard/public/index.html`, `skill/dashboard/server.js`

**问题**: 无 CSP 头，XSS 攻击不受浏览器层缓解。Electron `file://` 模式下也无 CSP meta 标签。

**修复**: 
1. 在 `index.html` 中添加 CSP meta 标签（覆盖 Electron file:// 模式）
2. 在 HTTP 服务器中对 `.html` 响应添加 CSP 头 + `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY`
3. CSP 允许 `self` + `unsafe-inline`（内联脚本/样式需要）+ Google Fonts 来源

### [S-06] MEDIUM — Electron `webPreferences` 未显式设置安全标志

**文件**: `skill/electron/main.js`  
**位置**: L174-178

**问题**: 虽 `contextIsolation` 和 `nodeIntegration` 已正确配置，但未显式设置 `webSecurity: true` 和 `allowRunningInsecureContent: false`，依赖默认值可能在未来 Electron 版本中变更。

**修复**: 显式设置 `webSecurity: true` 和 `allowRunningInsecureContent: false`。

---

## 已知风险（未修复，可接受）

### [S-07] LOW — Electron 证书错误处理绕过 localhost

**文件**: `skill/electron/main.js` L582-589  
**风险**: `certificate-error` 事件中，对 localhost 来源的证书错误调用 `callback(true)` 绕过检查。  
**评估**: 应用仅加载本地文件 (`loadFile`)，不加载外部 HTTPS 内容，风险可接受。若未来加载远程内容，需移除此绕过。

### [S-08] LOW — `genId()` 使用非加密随机数

**文件**: `skill/dashboard/server.js` L202  
**风险**: `genId()` 使用 `Date.now() + Math.random()` 生成 ID，可预测。  
**评估**: ID 用于本地数据管理，非安全敏感场景（无认证/授权），可接受。

---

## 安全架构评估

### 良好实践
- Electron: `contextIsolation: true` + `nodeIntegration: false` + `contextBridge` 受限 API
- MCP Server: JSON-RPC over stdio，无网络暴露
- Preload: 仅暴露明确的方法白名单，无 `eval`/`require` 泄露
- 路径操作: `brain-index.js` 中文件路径通过索引查找（`idx.topics[topicId]`），不直接拼接用户输入
- 无 `eval()`、`new Function()`、`Object.assign()` 原型污染风险

### 建议
- 考虑将 `unsafe-inline` 从 CSP 的 `script-src` 中移除，改用 nonce 或 hash（需重构内联事件处理器）
- 考虑为 API 端点添加输入类型验证（如 `typeof args.title === 'string'`）
- 考虑将 Google Fonts 替换为本地字体文件，消除外部依赖和隐私泄露
