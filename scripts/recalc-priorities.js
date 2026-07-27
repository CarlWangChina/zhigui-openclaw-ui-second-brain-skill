/**
 * 灵犀 DDL 动态重算脚本（独立运行 / 每日巡检兜底）
 *
 * 读取 .lingxi/goals.json，为所有 currentGoals 计算 daysLeft / overdue 并重算优先级。
 *
 * 说明：
 *  - 完整的「组合式（关联）优先级重算」由 MCP 工具 lingxi_recalc_priorities 提供
 *    （含负载超载联动、紧急队列相对降级等）。本脚本作为「无 MCP 环境」
 *    （cron / 手动 / 每日 Automation 兜底）下的独立实现，逻辑与
 *    skill/engine/server.js 的 recalcUrgency 保持一致。
 *  - 数据目录固定为仓库内的 .lingxi/，不依赖外部硬编码绝对路径。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '.lingxi');
const GOALS_FILE = path.join(DATA_DIR, 'goals.json');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('读取失败:', p, e.message);
    return null;
  }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function calcDaysLeft(deadline) {
  if (!deadline) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dl = new Date(deadline);
  dl.setHours(0, 0, 0, 0);
  return Math.round((dl - today) / (1000 * 60 * 60 * 24));
}

// 与 skill/engine/server.js recalcUrgency 保持一致
function calcUrgency(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return 10;
  if (daysLeft < 0) return 40;
  if (daysLeft === 0) return 40;
  if (daysLeft <= 2) return 39;
  if (daysLeft <= 7) return 36;
  if (daysLeft <= 30) return 30;
  if (daysLeft <= 90) return 20;
  return 10;
}

const state = readJson(GOALS_FILE);
if (!state) {
  console.error('无法读取 goals.json');
  process.exit(1);
}

// 同步回退副本 state.json：Electron 面板以 state.json 为主存储，
// 仅重算 goals.json 会导致面板回退副本滞后。保持两者一致。
const STATE_FILE = path.join(DATA_DIR, 'state.json');
try {
  const st = readJson(STATE_FILE) || {};
  st.currentGoals = state.currentGoals;
  st.strategicGoals = state.strategicGoals;
  st.constraints = state.constraints;
  st.meta = st.meta || {};
  st.meta.lastUpdated = now;
  writeJson(STATE_FILE, st);
} catch (e) {
  console.error('state.json 同步失败（非致命）:', e.message);
}

const now = new Date().toISOString();
let changedCount = 0;

state.currentGoals = state.currentGoals || [];
state.currentGoals.forEach(goal => {
  if (goal.completed) return;
  const daysLeft = calcDaysLeft(goal.deadline);
  const overdue = daysLeft !== null && daysLeft < 0;

  goal.daysLeft = daysLeft;
  goal.overdue = overdue;
  goal.lastRecalculated = now;

  if (!goal.locked) {
    const newUrgency = calcUrgency(daysLeft);
    // 保留用户调校的非紧急度部分（战略契合 + 性价比），仅更新紧急度
    const oldUrgency = goal._lastUrgency !== undefined ? goal._lastUrgency : newUrgency;
    const nonUrgencyPart = goal.priority - oldUrgency;
    const newPriority = Math.max(0, Math.min(100, newUrgency + nonUrgencyPart));

    if (Math.abs(newPriority - goal.priority) >= 3) {
      console.log(`  [重算] ${goal.title}: ${goal.priority} -> ${newPriority} (daysLeft=${daysLeft}, urgency=${newUrgency})`);
      goal.priority = newPriority;
      goal.updatedAt = now;
      changedCount++;
    }
    goal._lastUrgency = newUrgency;
  } else {
    console.log(`  [跳过] ${goal.title}: 已锁定 (daysLeft=${daysLeft})`);
  }
});

state.meta = state.meta || {};
state.meta.lastUpdated = now;
writeJson(GOALS_FILE, state);

console.log(`\n重算完成: ${changedCount} 个目标优先级发生变化`);
console.log(`当前目标状态:`);
state.currentGoals.forEach(g => {
  if (g.completed) return;
  const status = g.overdue ? '已逾期' : (g.daysLeft !== null ? `${g.daysLeft}天` : '无DDL');
  console.log(`  - ${g.title} | 优先级=${g.priority} | DDL=${g.deadline || 'N/A'} | ${status}`);
});
