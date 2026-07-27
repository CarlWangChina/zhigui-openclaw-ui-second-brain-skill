const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');

const { dataDir } = loadConfig();
const today = new Date().toISOString().slice(0, 10);
const tomorrowDate = new Date();
tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
const tomorrow = tomorrowDate.toISOString().slice(0, 10);

// This script is a development fixture generator. It only resets the configured
// Lingxi data directory and is never invoked by normal application startup.
fs.rmSync(dataDir, { recursive: true, force: true });
ensureDataInitialized(dataDir);
Storage.setDataDir(dataDir);
Actions.configure(dataDir);

const northStar = Actions.execute('goal.add', {
  type: 'strategicGoal',
  title: '构建一个真正懂取舍的个人 AI 助理',
  description: '让记忆、决策和计划服务于行动，而不是增加管理负担。',
  priority: 88,
});
const reliability = Actions.execute('goal.add', {
  type: 'currentGoal',
  title: '完成可靠的知归 3.2 版本',
  description: '统一数据链路，消除双端差异，并让前端操作有明确反馈。',
  priority: 92,
});
const fieldTest = Actions.execute('goal.add', {
  type: 'currentGoal',
  title: '完成一周真实场景试用',
  description: '用工作安排、个人事务和复盘场景检验建议是否自然。',
  priority: 76,
});

const review = Actions.execute('event.add', {
  date: today, time: '09:30', duration: 45, title: '回顾昨天的关键决策',
  description: '只关注产生实际影响的选择。', priority: 72,
});
Actions.execute('task.toggle', { date: today, taskId: review.task.id });
Actions.execute('event.add', {
  date: today, time: '11:00', duration: 90, title: '完成前端交互验收',
  description: '检查新增、编辑、完成、删除和错误提示。', priority: 94,
});
Actions.execute('event.add', {
  date: today, time: '15:00', duration: 60, title: '设计柔性决策策略',
  description: '区分事实、偏好、假设、方案与承诺。', priority: 86,
});
Actions.execute('event.add', {
  date: tomorrow, time: '10:00', duration: 45, title: '邀请一位朋友试用',
  description: '观察对方是否理解页面和建议逻辑。', priority: 68,
});

Actions.execute('errand.add', {
  title: '整理三条最重要的使用反馈', date: today, time: '17:00', duration: 30, priority: 'must',
});
Actions.execute('errand.add', {
  title: '晚上散步 30 分钟', date: today, time: '20:30', duration: 30, priority: 'nice',
  note: '给大脑留一点空白。',
});

Actions.execute('note.add', {
  title: '低风险信息缺失时优先使用可逆假设',
  topic: '决策质量', category: '产品方法', domain: 'misc',
  content: '当信息缺失但风险很低时，先给出可逆假设，比机械追问更自然。',
  relatedDate: today,
});
Actions.execute('note.add', {
  title: '手动修改代表当下意图而非永久规则',
  topic: '产品原则', category: '产品方法', domain: 'misc',
  content: '用户的手动修改代表当下意图，但不应自动升级为永久规则。',
});
Actions.execute('note.add', {
  title: '写操作必须提供完整状态反馈',
  topic: '前端体验', category: '产品设计', domain: 'career',
  content: '任何写操作都应有进行中、成功和失败三种明确状态；失败时保留用户输入。',
});

const state = Storage.readFullState();
const reliabilityGoal = state.currentGoals.find(goal => goal.id === reliability.goal.id);
const fieldTestGoal = state.currentGoals.find(goal => goal.id === fieldTest.goal.id);
reliabilityGoal.deadline = tomorrow;
reliabilityGoal.relatedStrategicGoalId = northStar.goal.id;
reliabilityGoal.daysLeft = 1;
fieldTestGoal.relatedStrategicGoalId = northStar.goal.id;
fieldTestGoal.daysLeft = 7;
state.briefings = {
  [today]: {
    date: today,
    mustDo: ['完成前端交互验收', '保留一次端到端验证记录'],
    recommended: ['先解决会破坏数据的缺陷，再处理视觉细节'],
    notRecommended: ['继续增加新的硬编码规则'],
    strategicReminder: ['每一次自动化都应让用户更轻松，而不是更受约束'],
    dailyQuote: '好的助理不是替你决定，而是让你更容易看清真正的选择。',
  },
};
state.userProfile = state.userProfile || {};
state.userProfile.valueSystem = {
  priorities: [
    { domain: 'product-quality', weight: 90, confidence: 0.9, strength: 'soft', source: 'observed' },
    { domain: 'wellbeing', weight: 74, confidence: 0.7, strength: 'soft', source: 'user' },
  ],
  decisionStyle: 'adaptive',
  learnedFrom: ['Prefer reversible experiments before permanent rules'],
};
Storage.writeState(state);

console.log(`Seeded dashboard data in ${path.resolve(dataDir)}`);
