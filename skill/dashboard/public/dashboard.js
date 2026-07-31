/**
 * ZhiGui · Decision & Planning Companion - Dashboard Logic
 * SSE real-time updates + state rendering + interactions
 */

// ===== Global State =====
let state = {};
let history = {};
let collapsed = false;   // Fixed expanded panel, no floating ball
// Keep the viewed calendar day as an absolute local date. A relative offset drifts
// when the panel remains open across midnight.
let selectedDate = null;
let theme = 'dark';
let goalModalType = null;  // 'strategicGoal' or 'constraint'
let evtSource = null;
let currentView = (() => {
  try {
    const saved = localStorage.getItem('zhigui_view');
    return ['today', 'knowledge', 'all'].includes(saved) ? saved : 'today';
  } catch {
    return 'today';
  }
})();                            // 'today' | 'knowledge' | 'all'
let pendingDeleteTopic = null;   // Topic pending cascade delete
let pendingActionDelete = null;  // One scheduled task or action pending deletion
// The desktop watcher reports file writes made by this same renderer. Suppress that
// echo briefly: callers already refresh after a successful mutation, and a second
// render recreates the hovered card underneath the pointer.
let localDesktopMutationUntil = 0;
let pendingExternalStateRender = null;
let isRendering = false;
let isPointerDown = false;
let lastSeenVersion = 0;
let pendingRenderReason = null;
// Context is persisted on the action. This set controls only whether its details are open in the panel.
const expandedActionContexts = new Set();
const noteDetails = new Map();
const PAGE_SIZE = { goals: 12, decisions: 10, errands: 12, notes: 12, topics: 12 };
const visibleCounts = {
  goals: PAGE_SIZE.goals,
  decisions: PAGE_SIZE.decisions,
  errands: PAGE_SIZE.errands,
  notes: PAGE_SIZE.notes,
  topics: PAGE_SIZE.topics,
};

function moreLabel(remaining) {
  return lang === 'zh' ? `查看其余 ${remaining} 条` : `Show ${remaining} more`;
}

function renderMoreButton(section, shown, total) {
  const remaining = Math.max(0, total - shown);
  if (!remaining) return '';
  return `<button type="button" class="list-more-btn" onclick="showMore('${section}')">${moreLabel(remaining)}</button>`;
}

function showMore(section) {
  if (!Object.hasOwn(PAGE_SIZE, section)) return;
  visibleCounts[section] += PAGE_SIZE[section];
  const renderers = { goals: renderGoals, decisions: renderDecisions, errands: renderErrands, notes: renderNotes };
  if (section === 'topics') {
    renderTopics();
    return;
  }
  renderers[section]?.();
}

// Track pointer state for click protection during render
document.addEventListener('pointerdown', () => { isPointerDown = true; }, { passive: true, capture: true });
document.addEventListener('pointerup', () => { isPointerDown = false; }, { passive: true, capture: true });

// ===== Internationalization (zh / en) =====
// Two modes only: 'zh' (Chinese) and 'en' (English). Any legacy 'both' value is normalized to 'zh'.
let lang = (() => {
  try {
    const v = localStorage.getItem('zhigui_lang_v3');
    return (v === 'zh' || v === 'en') ? v : 'zh';
  } catch (e) { return 'zh'; }
})();

const I18N = {
  zh: {
    'app.subtitle': '决策与规划助理',
    'view.today': '今日', 'view.knowledge': '知识库', 'view.all': '全部',
    'section.briefing': '今日建议', 'section.schedule': '今日行动',
    'section.goals': '目标', 'section.constraints': '限制',
    'section.current': '当前目标', 'section.events': '事件流',
    'section.errands': '待安排事项', 'section.completed': '今日已完成', 'section.notes': '笔记',
    'action.timePending': '时间待定',
    'section.topics': '主题库',
    'section.decisions': '决策记录', 'section.reflection': '每日复盘',
    'empty.decisions': '暂无决策记录', 'empty.reflection': '今天还没有完成的行动',
    'decision.accepted': '已采纳', 'decision.rejected': '已拒绝', 'decision.pending': '待决定',
    'decision.reversed': '已撤销', 'decision.expired': '已过期', 'decision.resolved': '已结束跟踪',
    'reflection.completed': '今日完成', 'reflection.health': '目标关注信号',
    'reflection.suggestions': 'AI 建议',
    'goal.why': '为什么重要', 'goal.obstacle': '当前障碍', 'goal.status': '当前状态',
    'goal.nextStep': '下一步', 'goal.linkedNotes': '关联笔记',
    'goal.signal.actionable': '可推进', 'goal.signal.needs_confirmation': '待确认', 'goal.signal.blocked': '有阻碍', 'goal.signal.at_risk': '存在风险', 'goal.signal.on_track': '进展正常',
    'empty.goals': '暂无目标', 'errand.all': '全部', 'goal.expand': '点击展开查看衍生任务', 'goal.derivedTasks': '衍生任务', 'goal.derivedGoals': '子目标', 'goal.noDerived': '暂无衍生内容',
    'goal.markComplete': '标记完成', 'goal.markIncomplete': '撤销完成',
    'briefing.must': '必须完成', 'briefing.rec': '今日推荐', 'briefing.not': '不建议', 'briefing.strategic': '战略提醒', 'briefing.dailyQuote': '每日一言',
    'tooltip.pin': '固定', 'tooltip.close': '关闭', 'tooltip.theme': '切换主题', 'tooltip.lang': '语言', 'tooltip.collapse': '收起',
    'unit.pts': '分',
    'btn.addEvent': '添加事件', 'btn.cancel': '取消', 'btn.confirm': '确认',
    'modal.event.title': '添加事件',
    'modal.time.title': '编辑时间', 'modal.time.hint': '清空时间后，此行动会回到“待安排事项”。',
    'modal.actionDelete.title': '删除行动', 'modal.actionDelete.hint': '这会将这条行动从当前列表移除，且无法撤销。', 'modal.actionDelete.btn': '删除行动',
    'note.tab.unclassified': '未分类', 'topic.unclassified.meta': '{n} 条 · 等待 AI 整理', 'note.contentMissing': '此历史笔记缺少可读取的原文。',
    'form.date': '日期', 'form.time': '时间', 'form.title': '标题', 'form.desc': '描述（可选）',
    'modal.conflict.title': '冲突详情', 'modal.conflict.ok': '知道了',
    'modal.goal.title.strategic': '添加战略目标', 'modal.goal.title.constraint': '添加限制',
    'modal.goal.hint': '这是当前偏好，不是永久规则；知归会在有充分理由时提出调整建议。',
    'form.commitment': '承诺级别',
    'modal.errand.title': '添加事项', 'form.duration': '时长（分钟）', 'form.note': '备注（可选）',
    'errand.opt.must': '必须 - 今天做', 'errand.opt.should': '应该 - 尽可能做', 'errand.opt.nice': '可选 - 有空时做',
    'modal.topicDelete.title': '删除主题与其笔记', 'modal.topicDelete.warn': '只删除属于该主题的笔记。关联目标、琐事和日程任务会保留，但会移除已删笔记和主题的关联。', 'modal.topicDelete.btn': '删除主题与笔记',
    'kb.search.ph': '搜索：考试 / 面试 / 智齿…', 'kb.search.btn': '搜索',
    'kb.category.all': '全部分类', 'kb.threshold': '沉淀阈值 {n}',
    'calendar.backToday': '回到今天', 'calendar.legend.arranged': '已排程', 'calendar.legend.today': '今天',
    'calendar.weekdays': '日一二三四五六',
    'topic.empty': '还没有主题。<br>AI 会在整理笔记时判断主题与分类，<br>并逐步构建主题库。',
    'topic.chip.precip': '已归纳', 'topic.chip.active': '活跃',
    'topic.cascade.btn': '删除主题与笔记',
    'topic.reindex': '重建索引',
    'topic.reindexDone': '索引已重建！扫描了 {goals} 个目标、{notes} 条笔记、{errands} 项琐事。新建 {topicsCreated} 个主题，建立 {topicsLinked} 条关联。',
    'topic.reindexFail': '重建索引失败：',
    'lastUpdated.prefix': '最后更新：',
    'collapsed.tip': '今日 {c}/{t} · {p}%  |  点击展开 · 拖拽移动',
    'src.manual': '手动', 'src.ai': 'AI', 'src.recurring': '周期', 'task.record.manual': '手动录入', 'task.record.ai': 'AI 生成', 'task.record.recurring': '周期预排',
    'status.pending': '待处理', 'status.clarifying': '澄清中', 'status.resolved': '已解决',
    'domain.health': '健康', 'domain.relationship': '关系', 'domain.career': '职业', 'domain.academic': '学业', 'domain.social': '社交', 'domain.misc': '其他',
    'errand.must': '必须', 'errand.should': '应该', 'errand.nice': '可选',
    'empty.strategic': '暂无战略目标<br>点击右上角 + 添加，或在对话中告诉 AI',
    'empty.constraints': '暂无限制<br>点击右上角 + 添加',
    'empty.current': '暂无当前目标',
    'goal.current': '当前目标',
    'empty.errands': '暂无待安排事项', 'empty.completed': '暂无已完成事项',
    'completed.aiFollowup': '已记录到面板。AI 不会主动弹出；如需复盘、更新目标或安排后续，请开启一次对话，让它读取这次完成。',
    'empty.notes': '还没有笔记<br><span style="font-size:11px">文件请直接附加到聊天框，由 AI 在当前对话中总结和分类</span>',
    'note.all': '全部', 'note.input.ph': '记录一段原始信息…', 'note.aiHint': '面板记录的是你已确认的标题、主题和正文。',
    'note.addBtn': '＋ 记录笔记', 'note.chatImportHint': '需要 AI 总结、分类的文件，请直接附加到聊天框；AI 会在当前对话处理。',
    'modal.note.title': '记录笔记',
    'note.field.title': '标题', 'note.field.title.ph': '例如：考试报名截止提醒',
    'note.field.content': '内容',
    'note.field.topic': '主题', 'note.topic.none': '不指定（由AI归纳）', 'note.topic.create': '创建新主题', 'note.field.topic.ph': '选择或输入主题…',
    'note.field.newTopic': '新建主题（可选）', 'note.field.newTopic.ph': '输入新主题名称',
    'note.pendingTitle': '待 AI 归纳',
    'note.edit': '编辑', 'note.save': '保存', 'note.cancel': '取消',
    'note.tab.unclassified': '未分类', 'note.contentMissing': '（无内容）',
    'note.when.tooltip': '发生时间', 'note.created.tooltip': '记录时间',
    'empty.events': '暂无事件记录',
    'schedule.empty': '暂无日程',
    'briefing.overdue': '逾期', 'briefing.plan': '按计划执行 {n} 项任务', 'briefing.none': '暂无建议',
    'briefing.constraint': '避免超出限制安排（{title}）',
    'briefing.push': '{title}：每天坚持推进',
    'briefing.empty': '等待 AI 阅读今日上下文后写入晨报',
    'confirm.deleteGoal': '删除“{title}”？',
    'confirm.deleteErrand': '删除事项“{title}”？',
    'confirm.deleteNote': '删除这条笔记？',
    'alert.eventRequired': '请填写日期、时间和标题',
    'alert.goalRequired': '请输入标题',
    'alert.errandRequired': '请输入事项标题',
    'errand.done': '标记未完成', 'errand.undo': '标记完成', 'errand.undoComplete': '恢复', 'errand.completed': '已完成', 'errand.doneToday': '今日已完成',
    'topic.noteEmpty': '暂无笔记', 'topic.relNone': '暂无其他关联',
    'kb.noHits': '未找到匹配项',
    'today': '今天',
    'date.md': '{monthShort} {day}',
    'date.header': '{monthShort} {day} {wd}{today}',
    'calendar.months': '1月,2月,3月,4月,5月,6月,7月,8月,9月,10月,11月,12月',
    'topic.noteCount': '{n} 条笔记',
    'topic.field': '领域：{domain} · 关键词：{kw}',
    'topic.clickLoad': '点击展开加载笔记…',
    'topic.rel.goals': '目标', 'topic.rel.actionItems': '行动项', 'topic.rel.decisions': '决策', 'topic.rel.notes': '笔记',
    'action.task': '计划任务', 'action.unscheduled': '未安排时间', 'action.endsAt': '至 {time}', 'action.editTime': '编辑时间', 'action.scheduleTime': '安排时间',
    'action.retention.transient': '仅本次', 'action.retention.review': '留待复盘', 'action.retention.memory': 'AI 建议沉淀',
    'topic.relGoals': '目标：',
    'topic.tab.empty': '该分类暂无内容',
    'kb.type.topic': '主题', 'kb.type.note': '笔记', 'kb.type.goal': '目标', 'kb.type.event': '事件',
    'empty.loadError': '加载失败',
    'goal.ddl.overdue': '已逾期 {n} 天', 'goal.ddl.today': '今天截止', 'goal.ddl.tomorrow': '明天截止',
    'goal.ddl.left': '还剩 {n} 天', 'goal.ddl.prefix': '截止：',
    'briefing.otherDay': '{wd} 日程概览',
    // Task title i18n
    'task.followup': '💡 Follow up: {title} ({n}d left)', 'task.followup.unknown': '💡 Follow up: {title}',
    'task.phase': '[{phase}] {title}',
    'task.exercise': 'Exercise', 'task.exercise.desc': 'Daily exercise (constraint)',
    'task.locked': '时间由你设定；可继续修改，AI 不会自动覆盖',
    'task.editTimePrompt': 'Enter new time (HH:MM format, e.g. 09:30):',
    'task.editDurationPrompt': 'Enter duration in minutes (e.g. 60):',
    'task.invalidTime': 'Invalid time format. Please use HH:MM (e.g. 09:30).',
    'task.invalidDuration': 'Invalid duration. Please enter a number between 5 and 480.',
    'slot.normal': '普通', 'slot.golden': '黄金', 'slot.deep': '深度', 'slot.light': '轻度',
    'restDay.note': '{wd} 是休息日，无学习任务', 'restDay.label': '休息日',
    'briefing.selfCheckTag': ' · 即时概览',
    'briefing.selfCheckHint': '面板根据目标与行动即时汇总；真正的冲突检查会在 AI 规划或调整日程时执行。',
    'topic.detail.overview': '概览',
    'topic.detail.notes': '详细笔记 ({n})',
    'topic.detail.related': '关联实体',
    'topic.note.src.conv': '对话沉淀',
    'topic.note.src.manual': '手动添加',
    'topic.openHint': '点击展开查看详细内容',
  },
  en: {
    'app.subtitle': 'Decision & Planning Companion',
    'view.today': 'Today', 'view.knowledge': 'Knowledge', 'view.all': 'All',
    'section.briefing': "Today's guidance", 'section.schedule': "Today's Actions",
    'section.goals': 'Goals', 'section.constraints': 'Constraints',
    'section.current': 'Current Goals', 'section.events': 'Event Stream',
    'section.errands': 'Unscheduled actions', 'section.completed': 'Completed Today', 'section.notes': 'Notes',
    'action.timePending': 'Time pending',
    'section.topics': 'Topic Library',
    'section.decisions': 'Decision Records', 'section.reflection': 'Daily Reflection',
    'empty.decisions': 'No decision records yet', 'empty.reflection': 'No completed actions today',
    'decision.accepted': 'Accepted', 'decision.rejected': 'Rejected', 'decision.pending': 'Pending',
    'decision.reversed': 'Reversed', 'decision.expired': 'Expired', 'decision.resolved': 'Tracking ended',
    'reflection.completed': 'Completed Today', 'reflection.health': 'Goal Signals',
    'reflection.suggestions': 'AI Suggestions',
    'goal.why': 'Why it matters', 'goal.obstacle': 'Current obstacle', 'goal.status': 'Current status',
    'goal.nextStep': 'Next step', 'goal.linkedNotes': 'Linked notes',
    'goal.signal.actionable': 'Actionable', 'goal.signal.needs_confirmation': 'Needs confirmation', 'goal.signal.blocked': 'Blocked', 'goal.signal.at_risk': 'At risk', 'goal.signal.on_track': 'On track',
    'empty.goals': 'No goals', 'errand.all': 'All', 'goal.expand': 'Click to view derived tasks', 'goal.derivedTasks': 'Derived tasks', 'goal.derivedGoals': 'Sub-goals', 'goal.noDerived': 'No derived items yet',
    'goal.markComplete': 'Mark complete', 'goal.markIncomplete': 'Undo complete',
    'briefing.must': 'Must Complete', 'briefing.rec': 'Today\'s Pick', 'briefing.not': 'Not Recommended', 'briefing.strategic': 'Strategic Reminder', 'briefing.dailyQuote': 'Daily Quote',
    'tooltip.pin': 'Toggle Pin', 'tooltip.close': 'Close', 'tooltip.theme': 'Toggle Theme', 'tooltip.lang': 'Language', 'tooltip.collapse': 'Collapse',
    'unit.pts': 'pts',
    'btn.addEvent': 'Add Event', 'btn.cancel': 'Cancel', 'btn.confirm': 'Confirm',
    'modal.event.title': 'Add Event',
    'modal.time.title': 'Edit time', 'modal.time.hint': 'Clear the time to move this action back to Unscheduled actions.',
    'modal.actionDelete.title': 'Delete action', 'modal.actionDelete.hint': 'This removes the action from the current list and cannot be undone.', 'modal.actionDelete.btn': 'Delete action',
    'note.tab.unclassified': 'Unclassified', 'topic.unclassified.meta': '{n} notes · AI review pending', 'note.contentMissing': 'This historical note has no readable source text.',
    'form.date': 'Date', 'form.time': 'Time', 'form.title': 'Title', 'form.desc': 'Description (optional)',
    'modal.conflict.title': 'Conflict Detail', 'modal.conflict.ok': 'Got it',
    'modal.goal.title.strategic': 'Add Strategic Goal', 'modal.goal.title.constraint': 'Add Constraint',
    'modal.goal.hint': 'This is a current preference, not a permanent rule. ZhiGui may suggest changes with reasons.',
    'form.commitment': 'Commitment level',
    'modal.errand.title': 'Add action', 'form.duration': 'Duration (min)', 'form.note': 'Note (optional)',
    'errand.opt.must': 'Must - do today', 'errand.opt.should': 'Should - today if possible', 'errand.opt.nice': 'Nice - if free',
    'modal.topicDelete.title': 'Delete topic and owned notes', 'modal.topicDelete.warn': 'Only notes owned by this topic are deleted. Related goals, errands and schedule items stay, with deleted-note and topic links removed.', 'modal.topicDelete.btn': 'Delete topic and notes',
    'kb.search.ph': 'Search notes, goals, topics…', 'kb.search.btn': 'Search',
    'kb.category.all': 'All categories', 'kb.threshold': 'Threshold {n}',
    'calendar.backToday': 'Back to Today', 'calendar.legend.arranged': 'Scheduled', 'calendar.legend.today': 'Today',
    'calendar.weekdays': 'MTWTFSS',
    'topic.empty': 'No topics yet.<br>AI decides the topic and category while organizing notes,<br>then builds the library over time.',
    'topic.chip.precip': 'Precipitated', 'topic.chip.active': 'Active',
    'topic.cascade.btn': 'Delete topic & notes',
    'topic.reindex': 'Rebuild Index',
    'topic.reindexDone': 'Index rebuilt! Scanned {goals} goals, {notes} notes, {errands} errands. Created {topicsCreated} topics, made {topicsLinked} links.',
    'topic.reindexFail': 'Reindex failed: ',
    'lastUpdated.prefix': 'Last updated: ',
    'collapsed.tip': 'Today {c}/{t} · {p}%  |  click to expand · drag to move',
    'src.manual': 'Manual', 'src.ai': 'AI', 'src.recurring': 'Recurring', 'task.record.manual': 'Manual entry', 'task.record.ai': 'AI generated', 'task.record.recurring': 'Recurring preview',
    'status.pending': 'Pending', 'status.clarifying': 'Clarifying', 'status.resolved': 'Resolved',
    'domain.health': 'Health', 'domain.relationship': 'Relations', 'domain.career': 'Career', 'domain.academic': 'Study', 'domain.social': 'Social', 'domain.misc': 'Other',
    'errand.must': 'Must', 'errand.should': 'Should', 'errand.nice': 'Nice',
    'empty.strategic': 'No strategic goals<br>Tap + on top-right to add, or tell AI in chat',
    'empty.constraints': 'No constraints<br>Tap + on top-right to add',
    'empty.current': 'No current goals',
    'goal.current': 'Current',
    'empty.errands': 'No unscheduled actions', 'empty.completed': 'No completed actions yet',
    'completed.aiFollowup': 'Saved to your dashboard. AI will read this completion in your next conversation; start one when you want a review, goal update, or next step.',
    'empty.notes': 'No notes yet<br><span style="font-size:11px">Attach files directly in chat for AI to summarize and classify in this conversation</span>',
    'note.all': 'All', 'note.input.ph': 'Capture the original information…', 'note.aiHint': 'Panel notes use a title, topic and content you have confirmed.',
    'note.addBtn': '+ Add Note', 'note.chatImportHint': 'For AI summary and classification, attach the file directly in chat; AI will process it in this conversation.',
    'modal.note.title': 'Add Note',
    'note.field.title': 'Title', 'note.field.title.ph': 'e.g., Exam registration deadline',
    'note.field.content': 'Content',
    'note.field.topic': 'Topic', 'note.topic.none': 'None (AI decides)', 'note.topic.create': 'Create new topic', 'note.field.topic.ph': 'Select or type a topic…',
    'note.field.newTopic': 'New topic (optional)', 'note.field.newTopic.ph': 'Enter new topic name',
    'note.pendingTitle': 'Awaiting AI summary',
    'note.edit': 'Edit', 'note.save': 'Save', 'note.cancel': 'Cancel',
    'note.tab.unclassified': 'Unclassified', 'note.contentMissing': '(No content)',
    'note.when.tooltip': 'Occurred at', 'note.created.tooltip': 'Recorded at',
    'empty.events': 'No events recorded',
    'schedule.empty': 'No schedule',
    'briefing.overdue': 'overdue', 'briefing.plan': 'Execute {n} tasks as planned', 'briefing.none': 'No recommendation',
    'briefing.constraint': 'Avoid scheduling beyond constraint ({title})',
    'briefing.push': '{title}: keep pushing every day',
    'confirm.deleteGoal': 'Delete "{title}"?',
    'confirm.deleteErrand': 'Delete action "{title}"?',
    'confirm.deleteNote': 'Delete this note?',
    'alert.eventRequired': 'Please fill date, time and title',
    'alert.goalRequired': 'Please enter a title',
    'alert.errandRequired': 'Please enter an action title',
    'errand.done': 'Mark incomplete', 'errand.undo': 'Mark done', 'errand.undoComplete': 'Restore', 'errand.completed': 'Done', 'errand.doneToday': 'Completed today',
    'topic.noteEmpty': 'No notes', 'topic.relNone': 'No other relations',
    'kb.noHits': 'No matches found',
    'today': 'Today',
    'date.md': '{monthShort} {day}',
    'date.header': '{monthShort} {day} {wd}{today}',
    'calendar.months': 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec',
    'topic.noteCount': '{n} notes',
    'topic.field': 'Domain: {domain} · Keywords: {kw}',
    'topic.clickLoad': 'Click to expand and load notes…',
    'topic.rel.goals': 'Goals', 'topic.rel.actionItems': 'Action Items',
    'topic.rel.decisions': 'Decisions', 'topic.rel.notes': 'Notes',
    'action.task': 'Planned task', 'action.unscheduled': 'No time assigned', 'action.endsAt': 'to {time}', 'action.editTime': 'Edit time', 'action.scheduleTime': 'Schedule time',
    'action.retention.transient': 'One-time', 'action.retention.review': 'Keep for review', 'action.retention.memory': 'AI memory candidate',
    'briefing.empty': 'Waiting for the AI to read today\'s context and write the briefing',
    'topic.tab.empty': 'Nothing here',
    'topic.relGoals': 'Goals: ',
    'kb.type.topic': 'Topic', 'kb.type.note': 'Note', 'kb.type.goal': 'Goal', 'kb.type.event': 'Event',
    'empty.loadError': 'Load failed',
    'goal.ddl.overdue': 'Overdue {n} days', 'goal.ddl.today': 'Due today', 'goal.ddl.tomorrow': 'Due tomorrow',
    'goal.ddl.left': '{n} days left', 'goal.ddl.prefix': 'Due: ',
    'briefing.otherDay': '{wd} schedule overview',
    // Task title i18n
    'task.followup': '💡 Follow up: {title} ({n}d left)', 'task.followup.unknown': '💡 Follow up: {title}',
    'task.phase': '[{phase}] {title}',
    'task.exercise': 'Exercise', 'task.exercise.desc': 'Daily exercise (constraint)',
    'task.locked': 'Set by you — you can still edit it; AI will not override it',
    'task.editTimePrompt': 'Enter new time (HH:MM format, e.g. 09:30):',
    'task.editDurationPrompt': 'Enter duration in minutes (e.g. 60):',
    'task.invalidTime': 'Invalid time format. Please use HH:MM (e.g. 09:30).',
    'task.invalidDuration': 'Invalid duration. Please enter a number between 5 and 480.',
    'slot.normal': 'Normal', 'slot.golden': 'Golden', 'slot.deep': 'Deep', 'slot.light': 'Light',
    'restDay.note': '{wd} is a rest day, no study tasks',     'restDay.label': 'Rest day',
    'briefing.selfCheckTag': ' · Live overview',
    'briefing.selfCheckHint': 'A live panel summary. Actual conflict checks run when AI plans or changes the schedule.',
    'topic.detail.overview': 'Overview',
    'topic.detail.notes': 'Detailed Notes ({n})',
    'topic.detail.related': 'Related Entities',
    'topic.note.src.conv': 'From chat',
    'topic.note.src.manual': 'Manual',
    'topic.openHint': 'Click to expand and view details',
  }
};

function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key;
  if (vars) {
    for (const k in vars) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    }
  }
  return s;
}

function applyI18n() {
  document.documentElement.setAttribute('lang', lang);
  // Sync date/time input locale so the browser's native picker shows the right language
  document.querySelectorAll('input[type="date"], input[type="time"]').forEach(el => {
    el.setAttribute('lang', lang);
    // Some browsers ignore input.lang; provide a placeholder overlay via a text-input fallback
    if (el.type === 'date') {
      el.setAttribute('placeholder', lang === 'zh' ? '年/月/日' : 'YYYY/MM/DD');
    } else if (el.type === 'time') {
      el.setAttribute('placeholder', lang === 'zh' ? '时:分' : 'HH:MM');
    }
  });
  const lbl = document.getElementById('lang-label');
  if (lbl) lbl.textContent = lang === 'zh' ? 'ZH' : 'EN';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (k) el.textContent = t(k);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const k = el.getAttribute('data-i18n-ph');
    if (k) el.placeholder = t(k);
  });
  // Calendar weekday header
  const cw = document.getElementById('calendar-weekdays-row');
  if (cw) {
    const wk = t('calendar.weekdays');
    cw.innerHTML = wk.split('').map(s => `<span>${s}</span>`).join('');
  }
  // tooltip i18n
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (k) el.title = t(k);
  });
}

function toggleLang() {
  lang = lang === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem('zhigui_lang_v3', lang); } catch (e) {}
  // Electron: persist language preference to state.json
  if (window.zhigui?.isElectron) {
    postJson('/api/lang', { lang });
  }
  applyI18n();
  renderAll();
}

// ===== Initialization =====
async function init() {
  // Restore per-goal expand/collapse state before first render
  loadExpandedGoals();

  // Initialize topic combobox for note modal
  initTopicComboboxEvents();

  const isElectron = window.zhigui?.isElectron;

  // Electron mode flag
  if (isElectron) {
    document.body.classList.add('electron');
  }

  // Electron restores both the persisted presentation mode and the matching
  // native window bounds.  Keep the DOM in the same mode; otherwise a saved
  // 56×56 mini window would render a full dashboard inside itself on restart.
  if (isElectron) {
    await refreshState();
    collapsed = state.meta?.collapsed === true;
    const panel = document.getElementById('expanded-panel');
    const mini = document.getElementById('mini-view');
    const collapseButton = document.getElementById('collapse-toggle');
    if (panel) panel.style.display = collapsed ? 'none' : '';
    if (mini) mini.style.display = collapsed ? 'flex' : 'none';
    document.body.classList.toggle('expanded', !collapsed);
    document.body.classList.toggle('collapsed', collapsed);
    if (collapseButton) collapseButton.classList.toggle('collapsed', collapsed);
    // Pin state: read from state.json (main process createWindow already set window accordingly)
    const pinBtn = document.getElementById('pin-toggle');
    if (pinBtn) {
      const isPinned = state.meta?.alwaysOnTop === true;
      if (isPinned) pinBtn.classList.add('pinned'); else pinBtn.classList.remove('pinned');
    }
    // Language persistence: restore from state.json (normalize legacy 'both' to 'zh')
    if (state.meta?.lang === 'zh' || state.meta?.lang === 'en') {
      lang = state.meta.lang;
      try { localStorage.setItem('zhigui_lang_v3', lang); } catch (e) {}
    }
  } else {
    // Browser: read collapsed state from localStorage
    const savedCollapsed = localStorage.getItem('zhigui_collapsed');
    if (savedCollapsed === 'true') {
      collapsed = true;
      const panel = document.getElementById('expanded-panel');
      const mini = document.getElementById('mini-view');
      if (panel) panel.style.display = 'none';
      if (mini) mini.style.display = 'flex';
      document.body.classList.add('collapsed');
    } else {
      collapsed = false;
      document.body.classList.add('expanded');
    }
    await refreshState();
  }

  await refreshHistory();
  
  // Set theme
  if (state.meta && state.meta.theme) {
    theme = state.meta.theme;
  }
  applyTheme();

  // Apply UI language (zh/en)
  applyI18n();

  // Topic Library: delegated click handling (robust — survives renderTopics innerHTML rewrites
  // and does not depend on inline onclick scope resolution). Clicking anywhere on a topic head
  // toggles its detail view. The container persists across re-renders, so attach once here.
  const topicsContainer = document.getElementById('topics-container');
  if (topicsContainer && !topicsContainer.dataset.delegated) {
    topicsContainer.dataset.delegated = '1';
    topicsContainer.addEventListener('click', (e) => {
      const head = e.target.closest('.topic-head');
      if (!head) return;
      const card = head.closest('.topic-card');
      if (!card) return;
      const tid = card.dataset.topicId;
      if (tid) toggleTopicExpand(tid);
    });
    topicsContainer.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const head = e.target.closest('.topic-head');
      if (!head) return;
      e.preventDefault();
      const tid = head.closest('.topic-card')?.dataset.topicId;
      if (tid) toggleTopicExpand(tid);
    });
  }

  // Render
  try {
    renderAll();
  } catch (e) {
    console.error('renderAll failed:', e);
  }
  // ALWAYS show the current view, even if a single section render threw —
  // otherwise no section gets the `view-active` class and the whole panel stays hidden.
  showView(currentView);

  // Connect real-time updates
  connectSSE();
  
  // Browser mode timed refresh fallback (Electron uses IPC, not needed)
  if (!isElectron) {
    // A fetch alone updates the in-memory state but leaves the visible date
    // stale. Reuse the debounced external-update path so the selected day is
    // rendered after a missed SSE notification.
    setInterval(() => scheduleExternalStateRender(), 30000);
  }
}

// ===== SSE / IPC Connection =====
function connectSSE() {
  // Electron IPC mode
  if (window.zhigui?.isElectron) {
    window.zhigui.onStateUpdate(() => scheduleExternalStateRender());
    window.zhigui.onHistoryUpdate(async () => {
      await refreshHistory();
    });
    // No floating ball, no more "collapse/expand" toggle
    return;
  }

  // Browser SSE mode (compatibility fallback)
  if (evtSource) evtSource.close();
  
  evtSource = new EventSource('/api/events');
  
  evtSource.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'state_update' || data.type === 'file_change') {
        // Use unified debounce (300ms) instead of direct refreshState+renderAll
        // This prevents button flicker and click loss during multi-file writes
        scheduleExternalStateRender(data.changedKeys);
      } else if (data.type === 'history_update') {
        await refreshHistory();
      } else if (data.type === 'theme_update') {
        if (data.theme) {
          theme = data.theme;
          applyTheme();
        }
      } else if (data.type === 'topics_update') {
        if (currentView === 'knowledge') { await renderTopics(); }
      } else if (data.type === 'lock_acquired') {
        // AI is writing — show overlay and disable interaction
        showLockOverlay(data.by || 'ai');
      } else if (data.type === 'lock_released' || data.type === 'lock_held_by_ai') {
        hideLockOverlay();
      }
    } catch (err) {
      console.warn('SSE message parse failed:', err);
    }
  };
  
  evtSource.onerror = () => {
    console.warn('SSE connection lost, reconnecting in 5s...');
    evtSource.close();
    setTimeout(connectSSE, 5000);
  };
}

// ===== Data Fetching =====
async function fetchJson(url) {
  // Electron IPC mode
  if (window.zhigui?.isElectron) {
    if (url === '/api/state') return await window.zhigui.getState();
    if (url === '/api/history') return await window.zhigui.getHistory();
    if (url === '/api/topics') return await window.zhigui.getTopics();
    if (url.startsWith('/api/note?')) {
      const noteId = new URLSearchParams(url.split('?')[1]).get('noteId');
      return await window.zhigui.getNote(noteId);
    }
    if (url.startsWith('/api/topic?')) {
      const topicId = new URLSearchParams(url.split('?')[1]).get('topicId');
      return await window.zhigui.getTopic(topicId);
    }
    if (url.startsWith('/api/associated?')) {
      const q = new URLSearchParams(url.split('?')[1]).get('q');
      return await window.zhigui.findAssociated(q);
    }
    if (url.startsWith('/api/search?')) {
      const q = new URLSearchParams(url.split('?')[1]).get('q');
      return await window.zhigui.search(q);
    }
    return null;
  }
  // Browser HTTP mode
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('Fetch error:', e);
    return null;
  }
}

async function postJson(url, body) {
  // Electron IPC mode
  if (window.zhigui?.isElectron) {
    try {
      if (url === '/api/task/toggle') return await invokeDesktopMutation(() => window.zhigui.toggleTask(body.date, body.taskId));
      if (url === '/api/task/update') return await invokeDesktopMutation(() => window.zhigui.updateTask(body));
      if (url === '/api/task/delete') return await invokeDesktopMutation(() => window.zhigui.deleteTask(body));
      if (url === '/api/task/unlock') return await invokeDesktopMutation(() => window.zhigui.unlockTask(body));
      if (url === '/api/event/add') return await invokeDesktopMutation(() => window.zhigui.addEvent(body));
      if (url === '/api/goal/add') return await invokeDesktopMutation(() => window.zhigui.addGoal(body));
      if (url === '/api/goal/complete') return await invokeDesktopMutation(() => window.zhigui.completeGoal(body));
      if (url === '/api/delete-goal') return await invokeDesktopMutation(() => window.zhigui.deleteGoal(body));
      if (url === '/api/errand/add') return await invokeDesktopMutation(() => window.zhigui.addErrand(body));
      if (url === '/api/errand/update') return await invokeDesktopMutation(() => window.zhigui.updateErrand(body));
      if (url === '/api/errand/delete') return await invokeDesktopMutation(() => window.zhigui.deleteErrand(body));
      if (url === '/api/errand/complete') return await invokeDesktopMutation(() => window.zhigui.completeErrand(body));
      if (url === '/api/errand/undo') return await invokeDesktopMutation(() => window.zhigui.undoErrand(body));
      if (url === '/api/note/add') return await invokeDesktopMutation(() => window.zhigui.addNote(body));
      if (url === '/api/note/update') return await invokeDesktopMutation(() => window.zhigui.updateNote(body));
      if (url === '/api/note/delete') return await invokeDesktopMutation(() => window.zhigui.deleteNote(body));
      if (url === '/api/decision/update') return await invokeDesktopMutation(() => window.zhigui.updateDecision(body));
       if (url === '/api/decision/delete') return await invokeDesktopMutation(() => window.zhigui.deleteDecision(body));
      if (url === '/api/delete/preview') return await window.zhigui.previewDelete(body);
      if (url === '/api/weights/update') return await invokeDesktopMutation(() => window.zhigui.updateWeights(body));
      if (url === '/api/topic/delete') return await invokeDesktopMutation(() => window.zhigui.deleteTopic(body));
      if (url === '/api/reminder/delete') return await invokeDesktopMutation(() => window.zhigui.deleteReminder(body));
      if (url === '/api/theme') return await invokeDesktopMutation(() => window.zhigui.setTheme(body.theme));
      if (url === '/api/lang') return await invokeDesktopMutation(() => window.zhigui.setLang(body.lang));
      const missing = { success: false, error: `Unsupported desktop action: ${url}` };
      showToast(missing.error, 'error');
      return missing;
    } catch (e) {
      const failed = { success: false, error: e?.message || 'Desktop action failed' };
      showToast(failed.error, 'error');
      return failed;
    }
  }
  // Browser HTTP mode
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || data?.error) {
      showToast(data?.error || `Request failed (${res.status})`, 'error');
    } else {
      // Echo suppression: set local mutation window so SSE file_change events
      // triggered by our own write don't cause a redundant re-render
      localDesktopMutationUntil = Date.now() + 900;
    }
    return data;
  } catch (e) {
    console.error('Post error:', e);
    showToast(e.message || 'Operation failed', 'error');
    return { success: false, error: e.message || 'Operation failed' };
  }
}

async function invokeDesktopMutation(operation) {
  const result = await operation();
  if (result && result.success !== false && !result.error) {
    // An action can write several entity files. Its fs.watch echo would otherwise
    // redraw this same card after the UI has already refreshed it.
    localDesktopMutationUntil = Date.now() + 900;
  }
  return result;
}

function scheduleExternalStateRender(changedKeys) {
  // Echo suppression: skip if we just made a local mutation
  if (Date.now() < localDesktopMutationUntil) return;
  // Store the latest changedKeys for incremental rendering
  if (changedKeys) pendingRenderReason = changedKeys;
  if (pendingExternalStateRender) clearTimeout(pendingExternalStateRender);
  pendingExternalStateRender = setTimeout(async () => {
    pendingExternalStateRender = null;
    if (Date.now() < localDesktopMutationUntil) return;
    // Render lock: prevent reentrant rendering
    if (isRendering) {
      // Re-schedule if currently rendering
      pendingExternalStateRender = setTimeout(() => {
        pendingExternalStateRender = null;
        scheduleExternalStateRender(changedKeys);
      }, 50);
      return;
    }
    // Click protection: delay render if user is actively clicking
    if (isPointerDown) {
      pendingExternalStateRender = setTimeout(() => {
        pendingExternalStateRender = null;
        scheduleExternalStateRender(changedKeys);
      }, 100);
      return;
    }
    await refreshState();
    renderAll(pendingRenderReason);
    pendingRenderReason = null;
  }, 300);  // 300ms debounce — merges multi-file write batches
}

let toastTimer = null;
function showToast(message, tone = 'success') {
  const region = document.getElementById('toast-region');
  if (!region || !message) return;
  region.textContent = message;
  region.className = `toast-region visible ${tone}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { region.className = 'toast-region'; }, 3200);
}

async function runAction(url, body, successMessage = '') {
  const result = await postJson(url, body);
  if (!result || result.success === false || result.error) return null;
  if (successMessage) showToast(successMessage, 'success');
  return result;
}

async function refreshState() {
  const data = await fetchJson('/api/state');
  if (data) {
    // State version check: prevent stale data from overwriting newer state
    // (POST response and SSE race condition fix — P0-9.2)
    const incomingVersion = data.meta?.stateVersion || 0;
    if (incomingVersion > 0 && incomingVersion < lastSeenVersion) {
      // Stale data — discard (another write has already been applied locally)
      return;
    }
    if (incomingVersion > 0) lastSeenVersion = incomingVersion;
    state = data;
    // Detail bodies are cached only while their corresponding summary is
    // current.  This prevents a stale expanded note after an AI or panel edit.
    const summaries = new Map((state.notes || []).map(note => [note.id, note]));
    for (const [noteId, detail] of noteDetails) {
      const summary = summaries.get(noteId);
      if (!summary || (summary.updatedAt && detail.updatedAt && summary.updatedAt !== detail.updatedAt)) {
        noteDetails.delete(noteId);
        expandedNotes.delete(noteId);
        if (editingNoteId === noteId) editingNoteId = null;
      }
    }
    if (state.meta && state.meta.theme) {
      theme = state.meta.theme;
      applyTheme();
    }
  }
}

// ===== Optimistic Update (P0-9.2) =====
// Apply changes to local state immediately for instant UI feedback,
// then send the POST. If POST fails, roll back to the snapshot.

/**
 * Apply an optimistic update to local state and re-render.
 * @param {Function} mutateFn - Receives a deep copy of state, modifies it in place
 * @returns {Object|null} snapshot for rollback, or null if state was empty
 */
function applyOptimisticUpdate(mutateFn) {
  if (!state || !state.schedule) return null;
  const snapshot = JSON.parse(JSON.stringify(state));
  try {
    mutateFn(state);
    // Increment local version to prevent SSE stale data override
    if (!state.meta) state.meta = {};
    state.meta.stateVersion = (state.meta.stateVersion || 0) + 1;
    lastSeenVersion = state.meta.stateVersion;
    renderAll();
  } catch (e) {
    // Roll back on error
    state = snapshot;
    console.error('Optimistic update failed:', e);
  }
  return snapshot;
}

/**
 * Roll back to a previous state snapshot after a failed operation.
 * @param {Object} snapshot - Previously captured state snapshot
 */
function rollbackOptimisticUpdate(snapshot) {
  if (!snapshot) return;
  state = snapshot;
  if (state.meta?.stateVersion) lastSeenVersion = state.meta.stateVersion;
  renderAll();
  showToast(t('toast.rollback') || '操作失败，已回滚', 'error');
}

async function refreshHistory() {
  const data = await fetchJson('/api/history');
  if (data) history = data;
}

// ===== Theme Toggle =====
function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  postJson('/api/theme', { theme });
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
}

// ===== Collapse/Expand =====
// toggleCollapseUI (below) is the active handler; the old toggleCollapse() was removed
// as dead code — it only flipped the variable without updating the DOM panel/mini views.

// ===== Pin Toggle =====
async function togglePin() {
  if (!window.zhigui?.isElectron) return;
  const res = await window.zhigui.togglePin();
  const btn = document.getElementById('pin-toggle');
  if (btn && res && res.alwaysOnTop === false) {
    btn.classList.remove('pinned');
  } else if (btn) {
    btn.classList.add('pinned');
  }
}

// ===== Close App =====
function closeApp() {
  if (window.zhigui?.isElectron) {
    window.zhigui.closeApp();
  }
}

// Toggle collapse: full panel <-> mini icon (two-state, no floating ball)
function toggleCollapseUI() {
  const panel = document.getElementById('expanded-panel');
  const mini = document.getElementById('mini-view');
  const btn = document.getElementById('collapse-toggle');

  if (panel.style.display === 'none') {
    // Expand: show full panel, hide mini icon
    collapsed = false;
    panel.style.display = '';
    if (mini) mini.style.display = 'none';
    document.body.classList.add('expanded');
    document.body.classList.remove('collapsed');
    if (btn) btn.classList.remove('collapsed');
    localStorage.setItem('zhigui_collapsed', 'false');
    if (window.zhigui?.isElectron) {
      window.zhigui.toggleCollapse(false);
    }
    refreshState();
  } else {
    // Collapse: hide panel, show mini icon
    collapsed = true;
    panel.style.display = 'none';
    if (mini) mini.style.display = 'flex';
    document.body.classList.remove('expanded');
    document.body.classList.add('collapsed');
    if (btn) btn.classList.add('collapsed');
    localStorage.setItem('zhigui_collapsed', 'true');
    if (window.zhigui?.isElectron) {
      window.zhigui.toggleCollapse(true);
    }
  }
}

// ===== Date Utilities =====
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getViewedDate() {
  if (selectedDate) return parseLocalDate(selectedDate) || new Date();
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function setViewedDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
  selectedDate = formatDate(date);
}

function renderViewedDate() {
  renderFocusHero();
  renderBriefing();
  renderSchedule();
  renderErrands();
  renderCompletedActions();
  renderReflection();
}

function formatDateDisplay(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return '';
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const monthShort = t('calendar.months').split(',')[d.getMonth()];
  return t('date.md', { m, day, monthShort });
}

// Format an ISO timestamp as "MM-DD HH:mm" (China format) for note/summary display
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${hh}:${mm}`;
}

function getWeekdayName(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return '';
  const names = lang === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return names[d.getDay()];
}

function isToday(dateStr) {
  return dateStr === formatDate(new Date());
}

// ===== Render Entry =====
// Supports incremental rendering: if changedKeys is provided, only re-render
// the affected sections. Falls back to full render for backward compatibility.
const SECTION_MAP = {
  schedule: ['renderCollapsed', 'renderFocusHero', 'renderSchedule', 'renderCompletedActions'],
  goals: ['renderGoals', 'renderConstraints', 'renderDecisions'],
  notes: ['renderNotes'],
  errands: ['renderErrands', 'renderCompletedActions'],
  briefing: ['renderBriefing'],
  conflicts: ['renderConflicts'],
  state: null,  // null = full render
};

function renderAll(changedKeys) {
  if (isRendering) return;
  isRendering = true;
  try {
    // If no changedKeys or unknown keys, do full render (backward compatible)
    if (!changedKeys || !Array.isArray(changedKeys) || changedKeys.length === 0) {
      _fullRender();
      return;
    }
    // Check if any key requires full render
    const needsFull = changedKeys.some(k => !SECTION_MAP[k]);
    if (needsFull) {
      _fullRender();
      return;
    }
    // Incremental: render only affected sections
    const rendered = new Set();
    // Always render focus hero and last updated (cheap, shows freshness)
    renderCollapsed();
    renderFocusHero();
    renderLastUpdated();
    for (const key of changedKeys) {
      const sections = SECTION_MAP[key];
      if (!sections) continue;
      for (const fnName of sections) {
        if (rendered.has(fnName)) continue;
        rendered.add(fnName);
        const fn = window[fnName];
        if (typeof fn === 'function') fn();
      }
    }
  } finally {
    isRendering = false;
  }
}

function _fullRender() {
  renderCollapsed();
  renderFocusHero();
  renderBriefing();
  renderSchedule();
  renderGoals();
  renderConstraints();
  renderDecisions();
  renderErrands();
  renderCompletedActions();
  renderReflection();
  renderNotes();
  renderConflicts();
  renderAttentionSignals();
  renderLastUpdated();
  // Refresh Topic Library — deletions in any view must sync to the library.
  // renderTopics() checks container visibility internally to avoid wasted DOM work.
  if (currentView === 'knowledge' || currentView === 'all') renderTopics();
}

function renderFocusHero() {
  const date = formatDate(getViewedDate());
  const viewingToday = isToday(date);
  const tasks = state.schedule?.days?.[date]?.tasks || [];
  const openTasks = tasks.filter(task => !task.completed);
  const openActions = (state.errands || []).filter(action => action.date === date && !action.completed);
  const completedTasks = tasks.filter(task => task.completed).length;
  const completedActions = getTodayCompletedActions(date).filter(action => !action.taskId).length;
  const pendingItems = [...openTasks.map(item => ({ item })), ...openActions.map(item => ({ item }))]
    .sort((a, b) => (a.item.time || '99:99').localeCompare(b.item.time || '99:99'));
  const pendingCount = pendingItems.length;
  const completedCount = completedTasks + completedActions;
  const totalCount = pendingCount + completedCount;
  const mainFocus = pendingItems[0]?.item.title || (completedCount > 0
    ? (lang === 'zh' ? (viewingToday ? '今日已完成' : '当日已完成') : 'All done for this day')
    : (lang === 'zh' ? '暂无安排' : 'No plans for this day'));
  const progress = totalCount ? Math.round(completedCount / totalCount * 100) : 0;

  const title = document.getElementById('focus-title');
  const summary = document.getElementById('focus-summary');
  const dateEl = document.getElementById('focus-date');
  if (title) title.textContent = mainFocus;
  if (dateEl) dateEl.textContent = formatDateDisplay(date);
  if (summary) {
    summary.textContent = lang === 'zh'
      ? (totalCount ? `${pendingCount} 项待处理 · ${completedCount} 项已完成。` : '这一天还没有安排。')
      : (totalCount ? `${pendingCount} pending · ${completedCount} completed.` : 'Nothing is scheduled for this day.');
  }
  const taskCount = document.getElementById('focus-task-count');
  const goalCount = document.getElementById('focus-goal-count');
  const progressEl = document.getElementById('focus-progress');
  if (taskCount) taskCount.textContent = pendingCount;
  if (goalCount) goalCount.textContent = completedCount;
  if (progressEl) progressEl.textContent = `${progress}%`;

  const labels = lang === 'zh'
    ? {
        eyebrow: viewingToday ? '今日概览' : '当日概览', tasks: '待处理', goals: '已完成', progress: viewingToday ? '今日进度' : '当日进度',
        addEvent: '＋ 加入日程', addErrand: '添加事项'
      }
    : {
        eyebrow: viewingToday ? "TODAY AT A GLANCE" : "DAY AT A GLANCE", tasks: 'pending', goals: 'completed', progress: 'day progress',
        addEvent: '＋ Add to schedule', addErrand: 'Add an action'
      };
  const textById = {
    'focus-eyebrow': labels.eyebrow,
    'focus-task-label': labels.tasks,
    'focus-goal-label': labels.goals,
    'focus-progress-label': labels.progress,
    'focus-add-event': labels.addEvent,
    'focus-add-errand': labels.addErrand,
  };
  Object.entries(textById).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });

  const scheduleTitle = document.querySelector('#section-schedule .section-title');
  const completedTitle = document.querySelector('#section-completed .section-title');
  if (scheduleTitle) scheduleTitle.textContent = viewingToday
    ? t('section.schedule')
    : `${formatDateDisplay(date)} ${lang === 'zh' ? '行动安排' : 'Action Schedule'}`;
  if (completedTitle) completedTitle.textContent = viewingToday
    ? t('section.completed')
    : `${formatDateDisplay(date)} ${lang === 'zh' ? '已完成' : 'Completed'}`;
}

// ===== Collapsed State Rendering =====
// Mini icon view has no dynamic content; kept as no-op for render pipeline compatibility.
function renderCollapsed() {}

// ===== Briefing Rendering (P0-9.3 Redesigned) =====
// The briefing now displays a "what to do today" recommendation,
// NOT just pending decisions. It shows:
// 1. Top recommendation (best ROI goal/task)
// 2. Time budget (available vs scheduled)
// 3. Hard constraints (must errands, deadlines, rest days)
// 4. Note signals (health/emotion-based intensity adjustment)
// 5. Goal progress
// 6. Strategic reminder
// 7. Daily quote
//
// Render the AI-authored date-specific briefing. It is not derived from live task state.
function renderBriefing() {
  const displayDate = formatDate(getViewedDate());
  const section = document.getElementById('section-briefing');
  if (!section) return;

  // Always show the briefing section (P0-9.3: never hide)
  section.style.display = '';
  document.getElementById('briefing-date').textContent = formatDateDisplay(displayDate);

  // Briefing is today-only. When viewing another date, clear the blocks.
  if (!isToday(displayDate)) {
    _setBlockContent('must', '');
    _setBlockContent('rec', '');
    _setBlockContent('not', '');
    _setBlockContent('strategic', '');
    _setBlockContent('dailyQuote', '');
    const emptyState = document.getElementById('briefing-empty-state');
    if (emptyState) emptyState.style.display = '';
    return;
  }

  const storedBriefing = (state.briefings && state.briefings[displayDate]) || state.morningBriefing;

  // Extract content into the fixed 5-slot structure: { must, rec, not, strategic, dailyQuote }
  const content = _extractBriefingContent(storedBriefing, displayDate);

  // Update each fixed block's content area
  _setBlockContent('must', content.must);
  _setBlockContent('rec', content.rec);
  _setBlockContent('not', content.not);
  _setBlockContent('strategic', content.strategic);
  _setBlockContent('dailyQuote', content.dailyQuote);

  // A briefing is an AI-authored, date-specific record. It is never inferred
  // from current tasks, goals, or completion state in the dashboard.
  const emptyState = document.getElementById('briefing-empty-state');
  if (emptyState) {
    emptyState.style.display = Object.values(content).some(Boolean) ? 'none' : '';
  }
}

// Extract briefing data from any format into the fixed 5-slot structure
function _extractBriefingContent(storedBriefing, displayDate) {
  const empty = { must: '', rec: '', not: '', strategic: '', dailyQuote: '' };

  if (!storedBriefing || storedBriefing.date !== displayDate) return empty;

  // Free-form sections: AI chose a custom structure — map by label
  if (storedBriefing.sections && storedBriefing.sections.length > 0) {
    return _extractFromSections(storedBriefing.sections, storedBriefing.dailyQuote);
  }

  // New backend-generated briefing data model
  if (_hasNewBriefingContent(storedBriefing)) {
    return _extractFromNewBriefing(storedBriefing);
  }

  // Backward compatibility: old briefing format
  if (hasBriefingContent(storedBriefing)) {
    return {
      must: _joinText(toArray(storedBriefing.mustDo)),
      rec: _joinText(toArray(storedBriefing.recommended)),
      not: _joinText(toArray(storedBriefing.notRecommended)),
      strategic: _joinText(toArray(storedBriefing.strategicReminder)),
      dailyQuote: storedBriefing.dailyQuote || '',
    };
  }

  return empty;
}

// Join array of text items into a single string
function _joinText(items) {
  if (!items || items.length === 0) return '';
  return items.map(it => typeof it === 'string' ? it : (it.content || it.title || '')).filter(Boolean).join('；');
}

// Extract content from free-form sections by matching labels
function _extractFromSections(sections, quote) {
  const mustLabel = t('briefing.must');
  const recLabel = t('briefing.rec');
  const notLabel = t('briefing.not');
  const strategicLabel = t('briefing.strategic');
  const dailyQuoteLabel = t('briefing.dailyQuote');

  // Also match Chinese labels directly for robustness
  const zhMap = { '必须完成': 'must', '今日推荐': 'rec', '不建议': 'not', '战略提醒': 'strategic', '每日一言': 'dailyQuote' };
  const labelMap = { [mustLabel]: 'must', [recLabel]: 'rec', [notLabel]: 'not', [strategicLabel]: 'strategic', [dailyQuoteLabel]: 'dailyQuote' };

  const result = { must: '', rec: '', not: '', strategic: '', dailyQuote: '' };

  // Fixed position mapping for fallback when labels don't match
  const positionalSlots = ['must', 'rec', 'not', 'strategic', 'dailyQuote'];

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const label = (s.label || '').trim();
    let slot = labelMap[label] || zhMap[label];
    // Fallback: if label doesn't match, assign by position
    if (!slot && i < positionalSlots.length) {
      slot = positionalSlots[i];
    }
    if (slot) {
      result[slot] = s.content || '';
    }
  }

  // If dailyQuote from sections is empty, use the top-level quote
  if (!result.dailyQuote && quote) {
    result.dailyQuote = quote;
  }

  return result;
}

// Extract content from the new backend briefing data model
function _extractFromNewBriefing(b) {
  const result = { must: '', rec: '', not: '', strategic: '', dailyQuote: '' };

  // Top recommendation -> rec
  if (b.topRecommendation) {
    const rec = b.topRecommendation;
    result.rec = rec.title || '';
    if (rec.reason) result.rec += ' — ' + rec.reason;
  }

  // Hard constraints -> must
  if (b.hardConstraints && b.hardConstraints.length > 0) {
    result.must = b.hardConstraints.map(c => {
      const icon = c.type === 'must_errand' ? '📌' : c.type === 'rest_day' ? '😴' : c.type === 'deadline_today' ? '⚠️' : '•';
      const text = c.title || c.message || '';
      const timeStr = c.time ? ' ' + c.time : '';
      return `${icon} ${text}${timeStr}`;
    }).join('；');
  }

  // Goal progress -> strategic
  if (b.goalProgress && b.goalProgress.length > 0) {
    result.strategic = b.goalProgress.map(g => {
      const ddl = g.daysLeft != null ? ` · ${g.daysLeft}${lang === 'zh' ? '天' : 'd'}` : '';
      const phase = g.phase ? ` [${g.phase}]` : '';
      const progress = g.weekProgress ? ' ' + g.weekProgress : '';
      return `🎯 ${g.title || ''}${phase}${progress}${ddl}`;
    }).join('；');
  }

  // Strategic reminder -> strategic (append if exists)
  if (b.strategicReminder && b.strategicReminder.title) {
    const str = b.strategicReminder.title;
    const note = b.strategicReminder.weeklyNote ? ' — ' + b.strategicReminder.weeklyNote : '';
    result.strategic = result.strategic ? result.strategic + '；' + str + note : str + note;
  }

  // Daily quote
  result.dailyQuote = b.dailyQuote || '';

  return result;
}

// Extract content locally when no backend briefing exists
// Set content for a fixed briefing block by key
function _setBlockContent(key, text) {
  const el = document.getElementById('briefing-' + key + '-content');
  if (el) {
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
  }
  // Also show/hide the parent block
  const block = document.getElementById('briefing-block-' + key);
  if (block) {
    block.style.display = text ? '' : 'none';
  }
}

// Check if briefing has the new data model fields (used by main briefing card rendering)
function _hasNewBriefingContent(b) {
  if (!b) return false;
  // If briefing is still raw data (AI hasn't composed yet), fall back to old format
  if (b._raw) return false;
  return !!(b.topRecommendation || b.timeBudget || (b.hardConstraints && b.hardConstraints.length > 0) ||
    (b.goalProgress && b.goalProgress.length > 0) ||
    (b.sections && b.sections.length > 0));
}

/** Convert value to array (null/undefined/string → array; already an array returns as-is) */
function toArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

/** Check if briefing object has actual content */
function hasBriefingContent(b) {
  if (!b) return false;
  return ['mustDo', 'recommended', 'notRecommended', 'strategicReminder'].some(k => {
    const v = b[k];
    return typeof v === 'string' ? v.trim().length > 0 : (Array.isArray(v) && v.length > 0);
  });
}

/** Build briefing card innerHTML: each item rendered as a natural paragraph with an inline bold label */
const BRIEFING_DOT = {
  must: 'red', rec: 'green', not: 'white', strategic: 'gold',
};
const BRIEFING_LABEL = {
  must: 'briefing.must', rec: 'briefing.rec', not: 'briefing.not', strategic: 'briefing.strategic',
};

function buildBriefingRows(groups, quote) {
  const cats = [
    { key: 'must', dot: 'red', i18n: 'briefing.must' },
    { key: 'rec', dot: 'green', i18n: 'briefing.rec' },
    { key: 'not', dot: 'white', i18n: 'briefing.not' },
    { key: 'strategic', dot: 'gold', i18n: 'briefing.strategic' },
  ];
  const blocks = [];
  for (const c of cats) {
    const raw = groups[c.key];
    if (raw == null) continue;
    const items = (Array.isArray(raw) ? raw : [raw])
      .flatMap(v => typeof v === 'string'
        ? v.split(/[;；]/).map(s => s.trim()).filter(Boolean)
        : [v])
      .filter(Boolean);
    if (items.length === 0) continue;
    const rows = items.map(it => {
      const text = typeof it === 'string' ? it : (it.content || it.title || '');
      return `<div class="briefing-row"><span class="briefing-dot ${c.dot}"></span><span class="briefing-row-text">${escapeHtml(text)}</span></div>`;
    }).join('');
    blocks.push(`
      <div class="briefing-block briefing-block-${c.dot}">
        <div class="briefing-block-head"><span class="briefing-block-label" data-i18n="${c.i18n}">${t(c.i18n)}</span></div>
        ${rows}
      </div>`);
  }
  if (quote) {
    blocks.push(`<div class="briefing-quote">${escapeHtml(quote)}</div>`);
  }
  return blocks.join('') || `<div class="briefing-empty">${t('briefing.empty') || (lang === 'zh' ? '暂无晨报数据' : 'No briefing data')}</div>`;
}

// ===== Schedule Rendering =====
function renderSchedule() {
  const displayDate = formatDate(getViewedDate());
  
  // Date label: show full date + weekday
  const dateObj = parseLocalDate(displayDate);
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  const monthShort = t('calendar.months').split(',')[dateObj.getMonth()];
  document.getElementById('week-label').textContent = 
    t('date.header', { month, day, monthShort, wd: getWeekdayName(displayDate), today: isToday(displayDate) ? ' · ' + t('today') : '' });
  
  const container = document.getElementById('schedule-container');
  const dayData = state.schedule?.days?.[displayDate];
  const scheduledTasks = (dayData?.tasks || [])
    .filter(task => task.time && !task.completed)
    .map(task => ({ kind: 'task', item: task }));
  const dateFixedTasks = (dayData?.tasks || [])
    .filter(task => !task.time && !task.completed)
    .map(task => ({ kind: 'date-fixed-task', item: task }));
  const scheduledActions = (state.errands || [])
    .filter(action => action.date === displayDate && action.time && !action.completed)
    .map(action => ({ kind: 'action', item: action }));
  const dateFixedActions = (state.errands || [])
    .filter(action => action.date === displayDate && !action.time && !action.completed)
    .map(action => ({ kind: 'date-fixed-action', item: action }));
  const actions = [...scheduledTasks, ...scheduledActions]
    .sort((a, b) => (a.item.time || '99:99').localeCompare(b.item.time || '99:99'));

  if (actions.length === 0 && dateFixedTasks.length === 0 && dateFixedActions.length === 0) {
    const todayMark = isToday(displayDate) ? ' · ' + t('today') : '';
    container.innerHTML = `<div class="empty-state">${formatDateDisplay(displayDate)} ${getWeekdayName(displayDate)}${todayMark}<br>${t('schedule.empty')}</div>`;
    return;
  }
  
  container.innerHTML = '';
  actions.forEach(action => {
    container.innerHTML += action.kind === 'task'
      ? renderTaskCard(action.item, displayDate)
      : renderScheduledActionCard(action.item);
  });
  [...dateFixedTasks, ...dateFixedActions].forEach(action => {
    container.innerHTML += action.kind === 'date-fixed-task'
      ? renderTaskCard(action.item, displayDate)
      : renderScheduledActionCard(action.item);
  });
}

function getEndTime(time, duration) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  if (!match) return '';
  const start = Number(match[1]) * 60 + Number(match[2]);
  const total = start + Math.max(0, Number(duration) || 0);
  const end = total % (24 * 60);
  const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  return total >= 24 * 60 ? `${lang === 'zh' ? '次日 ' : 'next day '}${endTime}` : endTime;
}

function renderActionTime(time, duration, editHandler = '') {
  const endTime = getEndTime(time, duration);
  const durationText = duration ? `${duration}min` : '';
  return `<div class="task-time">
    <div class="task-time-value">${escapeHtml(time || '')}</div>
    ${endTime ? `<div class="task-time-end">${t('action.endsAt', { time: endTime })}</div>` : ''}
    ${durationText ? `<div class="task-time-duration">${durationText}</div>` : ''}
    ${editHandler ? `<button type="button" class="task-time-edit" onclick="event.stopPropagation();${editHandler}">${t('action.editTime')}</button>` : ''}
  </div>`;
}

function getRetentionInfo(item) {
  const key = ['review', 'memory'].includes(item?.retention) ? item.retention : 'transient';
  return { key, label: t(`action.retention.${key}`) };
}

function renderTaskCard(task, date) {
  const contextKey = `task:${date}:${task.id}`;
  const linkedNotes = getLinkedNotesForTask(task);
  const sourceLabel = task.source === 'manual' ? t('task.record.manual')
    : task.source === 'recurring' ? t('task.record.recurring')
    : t('task.record.ai');
  const sourceClass = task.source === 'manual' ? 'manual' : task.source === 'recurring' ? 'recurring' : '';
  const resourceHtml = task.resource ? `<div class="task-resource">📖 ${task.resource}</div>` : '';
  const timingHint = task.manualLocked ? `<span class="locked-badge" title="${t('task.locked')}">✎</span>` : '';
  // P2-3: Show recurring badge for pre-scheduled recurring task instances
  const recurringBadge = task.source === 'recurring'
    ? '<span class="errand-pattern-tag recurring">🔄</span>'
    : '';

  return `
    <div class="task-card${task.completed ? ' completed' : ''}">
      ${renderActionTime(task.time, task.duration, `editTaskTime('${escapeAttr(date)}', '${escapeAttr(task.id)}', '${escapeAttr(task.time)}', ${Number(task.duration) || 60})`)}
      <div class="task-body">
        <div class="task-title">${escapeHtml(translateTaskTitle(task.title))}${recurringBadge}</div>
        ${task.description ? `<div class="task-desc">${escapeHtml(task.description)}</div>` : ''}
        ${resourceHtml}
        ${linkedNotes}
        ${renderActionContextSummary(task, contextKey)}
        ${renderActionContext(task, contextKey)}
        <div class="task-footer">
          <div class="task-meta">
            <span class="task-source ${sourceClass}">${sourceLabel}</span>${timingHint}
          </div>
          <div class="task-card-actions">
            <button type="button" class="task-delete-btn" onclick="event.stopPropagation();requestTaskDelete('${escapeAttr(date)}','${escapeAttr(task.id)}','${escapeAttr(task.title)}')" title="${t('modal.actionDelete.title')}" aria-label="${t('modal.actionDelete.title')}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
            <div class="task-checkbox ${task.completed ? 'checked' : ''}" onclick="event.stopPropagation();toggleTask('${escapeAttr(date)}', '${escapeAttr(task.id)}')"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderScheduledActionCard(action) {
  const commitmentLabel = { must: t('errand.must'), should: t('errand.should'), nice: t('errand.nice') };
  const retention = getRetentionInfo(action);
  const patternTag = action.pattern === 'recurring'
    ? '<span class="errand-pattern-tag recurring">🔄</span>'
    : '';
  const linkedNotes = getLinkedNotesHtml(action.noteIds);
  const contextKey = `errand:${action.id}`;
  return `
    <div class="task-card scheduled-action${action.completed ? ' completed' : ''}">
      ${action.time
        ? renderActionTime(action.time, action.duration, `editActionTime('${escapeAttr(action.id)}', '${escapeAttr(action.time)}', ${Number(action.duration) || 60})`)
        : `<div class="task-time time-pending"><span>${t('action.timePending')}</span><button type="button" class="action-time-button" onclick="event.stopPropagation();editActionTime('${escapeAttr(action.id)}', '', ${Number(action.duration) || 60})">${t('action.scheduleTime')}</button></div>`}
      <div class="task-body">
        <div class="task-title">${escapeHtml(action.title)}${patternTag}</div>
        ${action.note ? `<div class="task-desc">${escapeHtml(action.note)}</div>` : ''}
        ${linkedNotes}
        ${renderActionContextSummary(action, contextKey)}
        ${renderActionContext(action, contextKey)}
        <div class="task-footer">
          <div class="task-meta">
            <span class="task-source manual">${commitmentLabel[action.commitmentLevel] || t('errand.should')}</span>
            <span class="task-retention ${retention.key}" title="${retention.label}">${retention.label}</span>
          </div>
          <div class="task-card-actions">
            <button type="button" class="task-delete-btn" onclick="event.stopPropagation();requestActionDelete('errand','${escapeAttr(action.id)}','${escapeAttr(action.title)}')" title="${t('modal.actionDelete.title')}" aria-label="${t('modal.actionDelete.title')}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
            <div class="task-checkbox ${action.completed ? 'checked' : ''}" onclick="event.stopPropagation();toggleErrand('${escapeAttr(action.id)}')"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ===== Strategic Goals Rendering =====
// ===== Goals (merged: strategic + current) — each card expandable to show derived tasks =====
function renderGoals() {
  const container = document.getElementById('goals-container');
  if (!container) return;
  const strategic = (state.strategicGoals || []).filter(g => !g.completed);
  const allCurrent = state.currentGoals || [];

  // Phase dedup: for goals sharing the same baseTitle, only show the current active phase
  // (earliest-deadline incomplete one). Later phases stay hidden until the current one is completed.
  // Also: completed goals are hidden from dashboard (restore in knowledge base).
  // Also: current goals with relatedStrategicGoalId are hidden from top-level
  // (they only appear under their parent strategic goal).
  const _phaseGroups = new Map();
  const visibleCurrent = [];
  for (const g of allCurrent) {
    if (g.completed) continue; // hide completed from dashboard
    if (g.relatedStrategicGoalId) continue; // hide: belongs under a strategic goal
    if (g.baseTitle) {
      if (!_phaseGroups.has(g.baseTitle)) _phaseGroups.set(g.baseTitle, []);
      _phaseGroups.get(g.baseTitle).push(g);
    } else {
      visibleCurrent.push(g);
    }
  }
  for (const [, group] of _phaseGroups) {
    const incomplete = group.filter(g => !g.completed);
    if (incomplete.length > 0) {
      incomplete.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
      visibleCurrent.push(incomplete[0]);  // earliest incomplete = current active phase
    } else {
      group.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
      visibleCurrent.push(group[group.length - 1]);
    }
  }

  const items = [
    ...strategic.map(g => ({ item: g, type: 'strategicGoal' })),
    ...visibleCurrent.map(g => ({ item: g, type: 'currentGoal' })),
  ];

  if (items.length === 0) {
    container.innerHTML = `<div class="empty-state">${t('empty.goals')}</div>`;
    return;
  }

  const shown = items.slice(0, visibleCounts.goals);
  container.innerHTML = shown.map(x => renderGoalCard(x.item, x.type)).join('')
    + renderMoreButton('goals', shown.length, items.length);
}

function renderConstraints() {
  const container = document.getElementById('constraints-container');
  const constraints = state.constraints || [];
  
  if (constraints.length === 0) {
    container.innerHTML = `<div class="empty-state">${t('empty.constraints')}</div>`;
    return;
  }
  
  container.innerHTML = constraints.map(c => renderGoalCard(c, 'constraint')).join('');
}

// ===== Decisions Rendering =====
function renderDecisions() {
  const container = document.getElementById('decisions-container');
  if (!container) return;
  const decisions = (state.decisions || []).slice().sort((a, b) => {
    const aArchived = a.lifecycleState === 'archived' ? 1 : 0;
    const bArchived = b.lifecycleState === 'archived' ? 1 : 0;
    return aArchived - bArchived || (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
  });

  if (decisions.length === 0) {
    container.innerHTML = '<div class="empty-state">' + (t('empty.decisions') || '暂无决策记录') + '</div>';
    return;
  }

  const shown = decisions.slice(0, visibleCounts.decisions);
  container.innerHTML = shown.map(d => {
    const statusClass = d.status || 'pending';
    const statusLabel = t('decision.' + statusClass) || d.status;
    const relatedGoals = (d.relatedGoalIds || [])
      .map(id => {
        const g = [...(state.currentGoals || []), ...(state.strategicGoals || [])].find(x => x.id === id);
        return g ? escapeHtml(g.title) : null;
      })
      .filter(Boolean);
    const relatedHtml = relatedGoals.length
      ? '<div class="decision-related">' + (lang === 'zh' ? '关联目标：' : 'Related goals: ') + relatedGoals.join(' · ') + '</div>'
      : '';
    const evidenceHtml = d.evidence
      ? '<div class="decision-evidence">' + escapeHtml(d.evidence.length > 80 ? d.evidence.slice(0, 80) + '…' : d.evidence) + '</div>'
      : '';
    const dateStr = d.createdAt ? formatDateTime(d.createdAt) : '';
    return `
      <div class="decision-card">
        <span class="decision-status-tag ${statusClass}">${statusLabel}</span>
        <div class="decision-info">
          <div class="decision-title">${escapeHtml(d.title)}</div>
          ${evidenceHtml}
          ${relatedHtml}
          <div class="decision-meta">${dateStr}</div>
        </div>
        ${d.lifecycleState !== 'archived' ? `<button type="button" class="decision-resolve-btn" onclick="event.stopPropagation();resolveDecision('${escapeAttr(d.id)}','${escapeAttr(d.title)}')">${lang === 'zh' ? '结束跟踪' : 'End tracking'}</button>` : ''}
        <div class="decision-delete-btn" onclick="event.stopPropagation();deleteDecision('${escapeAttr(d.id)}','${escapeAttr(d.title)}')" title="${lang === 'zh' ? '仅误录时删除' : 'Delete only if recorded in error'}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </div>
      </div>
    `;
  }).join('') + renderMoreButton('decisions', shown.length, decisions.length);
}

async function resolveDecision(id, title) {
  if (!confirm(lang === 'zh'
    ? `结束对“${title}”的跟踪？它会保留为历史记录，但不再参与当前安排。`
    : `End tracking for “${title}”? It will be kept as history and will no longer guide current planning.`)) return;
  const result = await runAction('/api/decision/update', {
    id, status: 'resolved', updateReason: lang === 'zh' ? '用户在面板中结束跟踪。' : 'User ended tracking in the panel.',
  }, lang === 'zh' ? '已结束跟踪' : 'Tracking ended');
  if (!result) return;
  await refreshState();
  renderDecisions();
}

// ===== Daily Reflection Rendering =====
function renderReflection() {
  const container = document.getElementById('reflection-container');
  if (!container) return;

  // The engine persists a completed daily review as lastReflection. It applies
  // only to the date it was generated for; showing it on another date is stale.
  const displayDate = formatDate(getViewedDate());
  const reflection = state.reflection?.date === displayDate
    ? state.reflection
    : (state.lastReflection?.date === displayDate ? state.lastReflection : null);
  if (!reflection) {
    container.innerHTML = '<div class="empty-state">' + (lang === 'zh'
      ? `${formatDateDisplay(displayDate)} 尚未生成复盘`
      : `No reflection generated for ${formatDateDisplay(displayDate)}`) + '</div>';
    return;
  }

  const ct = reflection.completedToday || {};
  const gh = reflection.goalHealth?.items || reflection.goalHealth || reflection.goalHealthNeedsAttention || [];
  const suggestions = reflection.suggestions || [];

  let html = '<div class="reflection-card">';

  // Summary
  if (ct.summary) {
    html += '<div class="reflection-summary">' + escapeHtml(ct.summary) + '</div>';
  }

  // Stats
  html += '<div class="reflection-section-title">' + (t('reflection.completed') || '今日完成') + '</div>';
  html += '<div class="reflection-stats">';
  html += '<div class="reflection-stat"><strong>' + (ct.totalCount || 0) + '</strong>' + (lang === 'zh' ? ' 项总计' : ' total') + '</div>';
  html += '<div class="reflection-stat"><strong>' + (ct.oneTimeCount || 0) + '</strong>' + (lang === 'zh' ? ' 一次性' : ' one-time') + '</div>';
  html += '<div class="reflection-stat"><strong>' + (ct.recurringCount || 0) + '</strong>' + (lang === 'zh' ? ' 周期性' : ' recurring') + '</div>';
  html += '</div>';

  // Goal health signals
  if (gh.length > 0) {
    html += '<div class="reflection-section-title">' + (t('reflection.health') || '目标关注信号') + '</div>';
    for (const item of gh.slice(0, 5)) {
      const signals = (item.healthSignals || []).map(signal => signal.reason || signal.type).filter(Boolean);
      html += `
        <div class="reflection-health-item">
          <span style="flex:1;color:var(--text-secondary)">${escapeHtml(item.title)}</span>
          <span style="font-size:11px;color:var(--text-muted)">${escapeHtml(signals.join(' · ') || (lang === 'zh' ? '持续观察' : 'Monitor'))}</span>
        </div>
      `;
    }
  }

  // Suggestions
  if (suggestions.length > 0) {
    html += '<div class="reflection-section-title">' + (t('reflection.suggestions') || 'AI 建议') + '</div>';
    for (const s of suggestions.slice(0, 5)) {
      html += '<div class="reflection-suggestion">' + escapeHtml(s.message || s.text || s) + '</div>';
    }
  }

  html += '</div>';
  container.innerHTML = html;
}

// ===== Attention Signals Rendering =====
function renderAttentionSignals() {
  const container = document.getElementById('attention-signals');
  if (!container) return;

  const summary = state.attentionSummary || null;
  if (!summary || !summary.byType) {
    container.style.display = 'none';
    return;
  }

  // Build pills by signal type
  const pills = [];
  for (const [type, items] of Object.entries(summary.byType)) {
    if (!items || items.length === 0) continue;
    const labels = {
      overdue: lang === 'zh' ? '逾期' : 'Overdue',
      deadline: lang === 'zh' ? '即将到期' : 'Deadline',
      blocked: lang === 'zh' ? '阻塞' : 'Blocked',
      need_decision: lang === 'zh' ? '待决策' : 'Decision',
      momentum_lost: lang === 'zh' ? '动量丢失' : 'Momentum',
      hint_followup: lang === 'zh' ? '回溯' : 'Follow-up',
      conflict: lang === 'zh' ? '冲突' : 'Conflict',
    };
    const label = labels[type] || type;
    pills.push({ type, label, count: items.length });
  }

  if (pills.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = pills.slice(0, 6).map(p =>
    `<span class="attention-pill ${p.type}">${p.label} <span class="attention-pill-count">${p.count}</span></span>`
  ).join('');
}

function renderGoalCard(item, type) {
  const expanded = expandedGoals.has(item.id);
  
  // DDL countdown and overdue marker (currentGoal only)
  let ddlHtml = '';
  if (type === 'currentGoal' && item.deadline) {
    const daysLeft = item.daysLeft;
    const overdue = item.overdue;
    let ddlText = '';
    let ddlClass = 'ddl-normal';
    
    if (overdue) {
      const expiredDays = Math.abs(daysLeft);
      ddlText = t('goal.ddl.overdue', { n: expiredDays });
      ddlClass = 'ddl-overdue';
    } else if (daysLeft === 0) {
      ddlText = t('goal.ddl.today');
      ddlClass = 'ddl-urgent';
    } else if (daysLeft === 1) {
      ddlText = t('goal.ddl.tomorrow');
      ddlClass = 'ddl-urgent';
    } else if (daysLeft <= 3) {
      ddlText = t('goal.ddl.left', { n: daysLeft });
      ddlClass = 'ddl-urgent';
    } else if (daysLeft <= 7) {
      ddlText = t('goal.ddl.left', { n: daysLeft });
      ddlClass = 'ddl-soon';
    } else {
      ddlText = t('goal.ddl.left', { n: daysLeft });
      ddlClass = 'ddl-normal';
    }
    
    ddlHtml = `<div class="ddl-info ${ddlClass}">
      <span class="ddl-date">${t('goal.ddl.prefix')}${item.deadline}</span>
      <span class="ddl-countdown">${ddlText}</span>
    </div>`;
  }

  const typeTag = type === 'strategicGoal'
    ? '<span class="goal-type-tag strategic">战略</span>'
    : type === 'currentGoal'
      ? '<span class="goal-type-tag current">当前</span>'
      : '';
  
  const descHtml = item.description
    ? `<div class="goal-desc">${escapeHtml(item.description)}</div>`
    : '';

  // Linked notes under the goal: explicit noteIds plus topic-fallback.
  const linkedNotes = getLinkedNotesForGoal(item);
  const _goalNoteIds = new Set(Array.isArray(item.noteIds) ? item.noteIds : []);
  if (item.topicId) _collectTopicNoteIds(item.topicId).forEach(id => _goalNoteIds.add(id));
  const noteBadge = (_goalNoteIds.size > 0 && (state.notes || []).some(n => _goalNoteIds.has(n.id)))
    ? `<span class="goal-note-badge" title="${t('goal.linkedNotes') || '关联笔记'}">📎${_goalNoteIds.size}</span>`
    : '';

  return `
    <div class="goal-card${expanded ? ' expanded' : ''}${type === 'currentGoal' && item.overdue ? ' goal-overdue' : ''}${item.completed ? ' completed' : ''}">
      <div class="goal-row" onclick="toggleGoalExpand('${escapeAttr(type)}','${escapeAttr(item.id)}')">
        <span class="goal-caret">${expanded ? '▾' : '▸'}</span>
        <div class="goal-info">
          <div class="goal-title">${escapeHtml(item.title)} ${typeTag}${noteBadge}</div>
          ${ddlHtml}
        </div>
        <div class="goal-actions">
          ${type === 'currentGoal' || type === 'strategicGoal' ? `<div class="goal-complete-btn${item.completed ? ' completed' : ''}" onclick="event.stopPropagation();toggleGoalComplete('${escapeAttr(item.id)}', ${!item.completed})" title="${item.completed ? t('goal.markIncomplete') : t('goal.markComplete')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>` : ''}
          <div class="goal-delete-btn" onclick="event.stopPropagation();deleteGoal('${escapeAttr(type)}','${escapeAttr(item.id)}','${escapeAttr(item.title)}')" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </div>
        </div>
      </div>
      ${expanded ? `<div class="goal-body">${descHtml}${linkedNotes}${renderGoalEnhanced(item)}<div class="goal-derived">${renderDerivedForGoal(item, type)}</div></div>` : ''}
    </div>
  `;
}

// ===== Goal Enhanced Fields =====
function renderGoalEnhanced(item) {
  let html = '';
  if (!item.why && !item.obstacle && !item.statusSignal && !item.nextStep) return '';

  html += '<div class="goal-enhanced">';
  if (item.why) {
    html += '<div class="goal-field"><div class="goal-field-label">' + (t('goal.why') || '为什么重要') + '</div><div class="goal-field-value">' + escapeHtml(item.why) + '</div></div>';
  }
  if (item.obstacle) {
    html += '<div class="goal-field"><div class="goal-field-label">' + (t('goal.obstacle') || '当前障碍') + '</div><div class="goal-field-value">' + escapeHtml(item.obstacle) + '</div></div>';
  }
  if (item.statusSignal) {
    const signalLabel = t('goal.signal.' + item.statusSignal) || item.statusSignal;
    const reason = item.statusReason ? '<div class="goal-status-reason">' + escapeHtml(item.statusReason) + '</div>' : '';
    html += '<div class="goal-field"><div class="goal-field-label">' + (t('goal.status') || '当前状态') + '</div>';
    html += '<div class="goal-status-signal ' + escapeAttr(item.statusSignal) + '">' + escapeHtml(signalLabel) + '</div>' + reason + '</div>';
  }
  if (item.nextStep) {
    html += '<div class="goal-field"><div class="goal-field-label">' + (t('goal.nextStep') || '下一步') + '</div><div class="goal-field-value">' + escapeHtml(item.nextStep) + '</div></div>';
  }
  html += '</div>';
  return html;
}

// ===== Goal expansion: derived tasks / sub-goals =====
const expandedGoals = new Set();

function loadExpandedGoals() {
  try {
    const saved = localStorage.getItem('zhigui_expanded_goals');
    if (saved) {
      const ids = JSON.parse(saved);
      ids.forEach(id => expandedGoals.add(id));
    }
  } catch (e) {
    // ignore storage errors
  }
}

function saveExpandedGoals() {
  try {
    localStorage.setItem('zhigui_expanded_goals', JSON.stringify([...expandedGoals]));
  } catch (e) {
    // ignore storage errors
  }
}

function toggleGoalExpand(type, id) {
  if (expandedGoals.has(id)) expandedGoals.delete(id);
  else expandedGoals.add(id);
  saveExpandedGoals();
  renderGoals();
}

async function toggleGoalComplete(id, completed) {
  const result = await runAction('/api/goal/complete', { id, completed }, completed ? 'Goal completed' : 'Goal reopened');
  if (!result) return;
  await refreshState();
  renderAll();
}

function getDerivedTasksForGoal(goalId) {
  const tasks = [];
  const days = (state.schedule && state.schedule.days) || {};
  for (const day of Object.keys(days)) {
    for (const tk of (days[day].tasks || [])) {
      if (tk.relatedGoalId === goalId && !tk.completed) tasks.push(Object.assign({}, tk, { _day: day }));
    }
  }
  tasks.sort((a, b) => ((a._day || '') + (a.time || '')).localeCompare((b._day || '') + (b.time || '')));
  return tasks;
}

function renderDerivedForGoal(item, type) {
  if (type === 'strategicGoal') {
    let subs = (state.currentGoals || []).filter(g => g.relatedStrategicGoalId === item.id && !g.completed);
    if (subs.length === 0) return `<div class="goal-derived-empty">${t('goal.noDerived')}</div>`;
    // Phase dedup: for each baseTitle plan, show only the current active phase (earliest incomplete)
    const groups = new Map();
    const standalone = [];
    for (const g of subs) {
      if (g.baseTitle) {
        if (!groups.has(g.baseTitle)) groups.set(g.baseTitle, []);
        groups.get(g.baseTitle).push(g);
      } else {
        standalone.push(g);
      }
    }
    subs = [...standalone];
    for (const [, group] of groups) {
      const incomplete = group.filter(g => !g.completed);
      if (incomplete.length > 0) {
        incomplete.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
        subs.push(incomplete[0]);
      } else {
        group.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
        subs.push(group[group.length - 1]);
      }
    }
    return subs.map(sub => {
      const tasks = getDerivedTasksForGoal(sub.id);
      const subNotes = getLinkedNotesForGoal(sub);
      return `
        <div class="goal-derived-sub">
          <div class="goal-derived-sub-head">
            <div class="goal-derived-sub-title">${escapeHtml(sub.title)}${sub.deadline ? `<span class="goal-derived-ddl">${t('goal.ddl.prefix')}${escapeHtml(sub.deadline)}</span>` : ''}</div>
            <div class="goal-derived-sub-actions">
              <div class="goal-complete-btn${sub.completed ? ' completed' : ''}" onclick="event.stopPropagation();toggleGoalComplete('${escapeAttr(sub.id)}', ${!sub.completed})" title="${sub.completed ? t('goal.markIncomplete') : t('goal.markComplete')}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <div class="goal-delete-btn" onclick="event.stopPropagation();deleteGoal('currentGoal','${escapeAttr(sub.id)}','${escapeAttr(sub.title)}')" title="Delete">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </div>
            </div>
          </div>
          ${subNotes}
          ${tasks.length ? tasks.map(renderDerivedTaskRow).join('') : `<div class="goal-derived-empty">· ${t('goal.noDerived')}</div>`}
        </div>`;
    }).join('');
  }
  if (type === 'currentGoal') {
    const tasks = getDerivedTasksForGoal(item.id);
    if (tasks.length === 0) return `<div class="goal-derived-empty">${t('goal.noDerived')}</div>`;
    return tasks.map(renderDerivedTaskRow).join('');
  }
  return `<div class="goal-derived-empty">${t('goal.noDerived')}</div>`;
}

function renderDerivedTaskRow(t) {
  const day = t._day ? formatDateDisplay(t._day) : '';
  return `<div class="goal-derived-task${t.completed ? ' done' : ''}">
    <span class="goal-derived-check">${t.completed ? '✓' : '○'}</span>
    <span class="goal-derived-title">${escapeHtml(t.title)}</span>
    <span class="goal-derived-meta">${t.time ? escapeHtml(t.time) + ' · ' : ''}${escapeHtml(day)}</span>
  </div>`;
}

// ===== Conflict Rendering =====
function renderConflicts() {
  const conflicts = state.conflicts || [];
  const banner = document.getElementById('conflict-banner');

  // Only show true scheduling conflicts (overlaps, overload, constraint violations).
  // Deadline-related items (ddl_overdue, ddl_urgent) are reminders, not conflicts.
  const trueConflicts = conflicts.filter(c => !c.type?.startsWith('ddl_'));
  if (trueConflicts.length === 0) {
    banner.style.display = 'none';
    return;
  }

  // Show the latest conflict; support both old format (title/description) and new format (message/suggestion)
  const latest = trueConflicts[trueConflicts.length - 1];
  const title = latest.title || latest.message || 'Conflict detected';
  const desc = latest.description || latest.message || '';
  banner.style.display = '';
  document.getElementById('conflict-title').textContent = title;
  document.getElementById('conflict-desc').textContent = desc;
  banner.onclick = () => showConflictDetail({ ...latest, title, description: desc });
}

function showConflictDetail(conflict) {
  const title = conflict.title || conflict.message || 'Conflict detected';
  const desc = conflict.description || conflict.message || '';
  const date = conflict.date ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">📅 ${conflict.date}</div>` : '';
  const suggestion = conflict.suggestion ? `<div class="conflict-detail-suggestion">💡 ${escapeHtml(conflict.suggestion)}</div>` : '';
  document.getElementById('conflict-detail-body').innerHTML = `
    <div style="font-weight:500;color:var(--text-primary);margin-bottom:8px">${escapeHtml(title)}</div>
    ${date}
    <div>${escapeHtml(desc)}</div>
    ${suggestion}
  `;
  document.getElementById('conflict-modal').style.display = '';
}

function closeConflictModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('conflict-modal').style.display = 'none';
}

function dismissConflict() {
  document.getElementById('conflict-banner').style.display = 'none';
}

// ===== Last Updated Time =====
function renderLastUpdated() {
  const el = document.getElementById('last-updated');
  if (!el) return;

  const lu = state.meta?.lastUpdated;
  if (!lu) {
    el.textContent = '';
    return;
  }

  // state.meta.lastUpdated is ISO format (UTC), convert to Beijing time for display
  const d = new Date(lu);
  // Beijing time = UTC+8
  const beijing = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const y = beijing.getUTCFullYear();
  const mo = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const da = String(beijing.getUTCDate()).padStart(2, '0');
  const h = String(beijing.getUTCHours()).padStart(2, '0');
  const mi = String(beijing.getUTCMinutes()).padStart(2, '0');
  el.textContent = `${t('lastUpdated.prefix')}${y}-${mo}-${da} ${h}:${mi}`;
}

// ===== Interaction: Task Toggle =====
async function toggleTask(date, taskId) {
  const result = await postJson('/api/task/toggle', { date, taskId });
  if (!result || result.success === false || result.error) return;
  // SSE will auto-refresh, but also refresh manually for instant feedback
  await refreshState();
  renderAll();
}

// ===== Interaction: Edit action time =====
// Native prompt dialogs are unreliable in the desktop shell, so time changes use the
// same in-app modal system as the other dashboard operations.
let timeEditorContext = null;

function editTaskTime(date, taskId, currentTime, currentDuration) {
  openTimeEditor({ kind: 'task', date, id: taskId, time: currentTime || '', duration: currentDuration });
}

function editActionTime(id, currentTime, currentDuration) {
  openTimeEditor({ kind: 'action', id, time: currentTime || '', duration: currentDuration });
}

function openTimeEditor(context) {
  timeEditorContext = context;
  const modal = document.getElementById('time-editor-modal');
  const target = document.getElementById('time-editor-target');
  const timeInput = document.getElementById('time-editor-time');
  const durationInput = document.getElementById('time-editor-duration');
  if (!modal || !timeInput || !durationInput) return;
  if (target) target.textContent = context.kind === 'task' ? t('action.task') : t('section.errands');
  timeInput.value = context.time || '';
  durationInput.value = context.duration || 60;
  modal.style.display = '';
  setTimeout(() => timeInput.focus(), 0);
}

function closeTimeEditor(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById('time-editor-modal');
  if (modal) modal.style.display = 'none';
  timeEditorContext = null;
}

async function confirmTimeEditor() {
  if (!timeEditorContext) return;
  const timeInput = document.getElementById('time-editor-time');
  const durationInput = document.getElementById('time-editor-duration');
  const newTime = (timeInput?.value || '').trim();
  const newDuration = parseInt(durationInput?.value, 10);
  if (newTime && !/^\d{1,2}:\d{2}$/.test(newTime)) {
    alert(t('task.invalidTime'));
    return;
  }
  if (isNaN(newDuration) || newDuration < 5 || newDuration > 1440) {
    alert(t('task.invalidDuration'));
    return;
  }
  const context = timeEditorContext;
  if (newTime === context.time && newDuration === context.duration) {
    closeTimeEditor();
    return;
  }
  const result = context.kind === 'task'
    ? await postJson('/api/task/update', { date: context.date, taskId: context.id, time: newTime, duration: newDuration })
    : await postJson('/api/errand/update', { id: context.id, time: newTime, duration: newDuration, date: newTime ? context.date || undefined : '' });
  if (!result || result.success === false) return;
  closeTimeEditor();
  await refreshState();
  renderAll();
}

// ===== Interaction: Manually Add Event =====
function showAddEventForm() {
  // Default date = the day the user is currently viewing.
  const date = formatDate(getViewedDate());
  document.getElementById('event-date').value = date;
  document.getElementById('event-time').value = '09:00';
  document.getElementById('event-title').value = '';
  document.getElementById('event-desc').value = '';
  document.getElementById('event-modal').style.display = '';
}

function closeEventModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('event-modal').style.display = 'none';
}

async function confirmAddEvent() {
  const date = document.getElementById('event-date').value;
  const time = document.getElementById('event-time').value;
  const title = document.getElementById('event-title').value.trim();
  const desc = document.getElementById('event-desc').value.trim();
  
  if (!date || !time || !title) {
    alert(t('alert.eventRequired'));
    return;
  }
  
  const result = await runAction('/api/event/add', {
    date, time, title,
    description: desc,
    category: 'event'
  }, 'Schedule item added');
  if (!result) return;
  
  closeEventModal();
  // Navigate to the event's date
  setViewedDate(parseLocalDate(date));
  
  await refreshState();
  renderAll();
}

// ===== Day Navigation =====
function navigateDay(direction) {
  const next = getViewedDate();
  next.setDate(next.getDate() + direction);
  setViewedDate(next);
  renderViewedDate();
}

// ===== Calendar View =====
let calendarYear, calendarMonth;  // Currently displayed year and month

function openCalendar() {
  // Start from the currently viewed date
  const baseDate = getViewedDate();
  calendarYear = baseDate.getFullYear();
  calendarMonth = baseDate.getMonth();
  renderCalendar();
  document.getElementById('calendar-modal').style.display = '';
}

function closeCalendar(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('calendar-modal').style.display = 'none';
}

function navigateCalendarMonth(direction) {
  calendarMonth += direction;
  if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear--;
  } else if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear++;
  }
  renderCalendar();
}

function goToToday() {
  setViewedDate(new Date());
  const today = new Date();
  calendarYear = today.getFullYear();
  calendarMonth = today.getMonth();
  renderCalendar();
  renderViewedDate();
}

function renderCalendar() {
  // Title
  const monthNames = t('calendar.months').split(',');
  document.getElementById('calendar-title').textContent = `${calendarYear} ${monthNames[calendarMonth]}`;

  // Get the set of dates that have tasks
  const scheduledDays = new Set();
  const days = state.schedule?.days || {};
  for (const dateStr of Object.keys(days)) {
    const tasks = days[dateStr]?.tasks || [];
    if (tasks.length > 0) {
      scheduledDays.add(dateStr);
    }
  }
  for (const action of (state.errands || [])) {
    if (action.date && !action.completed) scheduledDays.add(action.date);
  }

  // Currently selected date
  const viewedDate = formatDate(getViewedDate());
  const todayStr = formatDate(new Date());

  // Calculate calendar grid cells
  const firstDay = new Date(calendarYear, calendarMonth, 1);
  const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
  const daysInMonth = lastDay.getDate();
  // Mon=0, Sun=6
  let firstWeekday = firstDay.getDay() - 1;
  if (firstWeekday < 0) firstWeekday = 6;

  const grid = document.getElementById('calendar-grid');
  let html = '';

  // Previous month's trailing dates (for padding)
  const prevMonth = new Date(calendarYear, calendarMonth, 0);
  const prevMonthDays = prevMonth.getDate();
  for (let i = firstWeekday - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const dateStr = formatDate(new Date(calendarYear, calendarMonth - 1, d));
    const hasTasks = scheduledDays.has(dateStr);
    html += `<div class="calendar-day other-month${hasTasks ? ' has-tasks' : ''}" onclick="selectCalendarDay('${escapeAttr(dateStr)}')">${d}</div>`;
  }

  // Current month dates
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = formatDate(new Date(calendarYear, calendarMonth, d));
    const hasTasks = scheduledDays.has(dateStr);
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === viewedDate;
    let classes = 'calendar-day';
    if (hasTasks) classes += ' has-tasks';
    if (isToday) classes += ' today';
    if (isSelected && !isToday) classes += ' selected';
    html += `<div class="${classes}" onclick="selectCalendarDay('${escapeAttr(dateStr)}')">${d}</div>`;
  }

  // Next month's leading dates (fill the last row)
  const totalCells = firstWeekday + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    const dateStr = formatDate(new Date(calendarYear, calendarMonth + 1, d));
    const hasTasks = scheduledDays.has(dateStr);
    html += `<div class="calendar-day other-month${hasTasks ? ' has-tasks' : ''}" onclick="selectCalendarDay('${escapeAttr(dateStr)}')">${d}</div>`;
  }

  grid.innerHTML = html;
}

function selectCalendarDay(dateStr) {
  const target = parseLocalDate(dateStr);
  if (!target) return;
  setViewedDate(target);

  // Close calendar
  document.getElementById('calendar-modal').style.display = 'none';

  renderViewedDate();
}

// ===== Interaction: Manually Add Strategic Goal/Constraint =====
function showAddGoalForm(type) {
  goalModalType = type;
  document.getElementById('goal-modal-title').textContent = 
    type === 'strategicGoal' ? t('modal.goal.title.strategic') : t('modal.goal.title.constraint');
  document.getElementById('goal-title').value = '';
  document.getElementById('goal-desc').value = '';
  document.getElementById('goal-modal').style.display = '';
  // Auto-focus title input
  setTimeout(() => document.getElementById('goal-title').focus(), 100);
}

function closeGoalModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('goal-modal').style.display = 'none';
  goalModalType = null;
}

async function confirmAddGoal() {
  const title = document.getElementById('goal-title').value.trim();
  const desc = document.getElementById('goal-desc').value.trim();
  
  if (!title) {
    alert(t('alert.goalRequired'));
    return;
  }
  
  const result = await runAction('/api/goal/add', {
    type: goalModalType,
    title,
    description: desc
  }, 'Goal added');
  if (!result) return;
  
  closeGoalModal();
  await refreshState();
  renderAll();
}

// ===== Unscheduled action queue =====
// Legacy errands remain compatible in storage; in the UI they are simply actions that
// have not been assigned a start time. Timed actions render together with scheduled tasks.
function renderErrands() {
  const container = document.getElementById('errands-container');
  const dateEl = document.getElementById('errands-date');
  const commitmentOrder = { must: 0, should: 1, nice: 2 };
  const unscheduledErrands = (state.errands || [])
    .filter(action => !action.date && !action.time)
    .map(action => ({ kind: 'action', item: action, date: action.date || null }));
  const unscheduledTasks = Object.entries(state.schedule?.days || {}).flatMap(([date, day]) =>
    (day.tasks || []).filter(task => !task.time).map(task => ({ kind: 'task', item: task, date }))
  );
  const actions = [...unscheduledErrands, ...unscheduledTasks].sort((a, b) => {
    const aDone = a.item.completed ? 1 : 0;
    const bDone = b.item.completed ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const ap = a.kind === 'action' ? (commitmentOrder[a.item.commitmentLevel] ?? 1) : 1;
    const bp = b.kind === 'action' ? (commitmentOrder[b.item.commitmentLevel] ?? 1) : 1;
    if (ap !== bp) return ap - bp;
    return (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31');
  });
  if (dateEl) dateEl.textContent = currentView === 'all' ? t('errand.all') : t('action.unscheduled');

  if (!container) return;
  if (actions.length === 0) {
    container.innerHTML = '<div class="empty-state">' + t('empty.errands') + '</div>';
    return;
  }

  const shown = actions.slice(0, visibleCounts.errands);
  let html = shown.map(action => action.kind === 'task'
    ? unscheduledTaskCardHtml(action.item, action.date)
    : errandCardHtml(action.item)).join('') + renderMoreButton('errands', shown.length, actions.length);
  container.innerHTML = html;
}

function completedActionCardHtml(action) {
  const linkedNotes = getLinkedNotesHtml(action.linkedNoteIds);
  const contextKey = `completed:${action.id}`;
  const timeStr = action.completedAt ? new Date(action.completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  const restoreButton = action.taskId
    ? `<button type="button" class="action-undo-button" onclick="event.stopPropagation();restoreCompletedTask('${escapeAttr(action.scheduleDate || '')}','${escapeAttr(action.taskId)}')">${t('errand.undoComplete') || '恢复'}</button>`
    : `<button type="button" class="action-undo-button" onclick="event.stopPropagation();undoCompleteErrand('${escapeAttr(action.id)}')">${t('errand.undoComplete') || '恢复'}</button>`;
  return `
    <div class="errand-card completed-action">
      <span class="commitment-tag done">${t('errand.completed') || 'Done'}</span>
      <div class="errand-info">
        <div class="errand-title">${escapeHtml(action.title)}</div>
        <div class="errand-meta">
          ${timeStr ? escapeHtml(timeStr) + ' · ' : ''}<span class="task-retention done">${action.outcome || 'done'}</span>
          ${action.summary ? ' · ' + escapeHtml(action.summary) : ''}
        </div>
        ${linkedNotes}
        ${renderActionContextSummary(action, contextKey)}
        ${renderActionContext(action, contextKey)}
      </div>
      <div class="errand-actions">
        ${restoreButton}
      </div>
    </div>
  `;
}

// P0-4: Replace getTodayCompletedActions with getCompletedForDate.
// Reads completed tasks from the schedule file for the given date (not UTC),
// then supplements with errand completion records (errands are not in schedule).
function getCompletedForDate(displayDate) {
  if (!displayDate) return [];

  // 1. Completed tasks from schedule file (tasks belong to this date)
  const dayData = state.schedule?.days?.[displayDate];
  const completedTasks = (dayData?.tasks || [])
    .filter(t => t.completed)
    .map(t => ({
      id: t.id,
      taskId: t.id,
      scheduleDate: displayDate,
      title: t.title,
      completedAt: t.completedAt,
      completedBy: t.completedBy || null,
      source: t.source || null,
      time: t.time || null,
      relatedGoalId: t.relatedGoalId || null,
      pattern: t.pattern || 'one-time',
      category: t.category || 'misc',
      outcome: 'done',
      summary: '',
      linkedNoteIds: t.noteIds || [],
      linkedDecisionIds: t.decisionIds || [],
      contextRefs: t.contextRefs || [],
    }));

  // 2. Errand completion records (errands are not in schedule files)
  const completedErrands = (state.completedActions || [])
    .filter(a => a.scheduleDate === displayDate && a.errandId)
    .map(a => ({
      ...a,
      // Ensure errand records have consistent shape for card rendering
      scheduleDate: a.scheduleDate || displayDate,
    }));

  return [...completedTasks, ...completedErrands]
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
}

// Keep old name as alias for backward compatibility (FocusHero uses it)
function getTodayCompletedActions(targetDate) {
  const displayDate = targetDate || formatDate(getViewedDate());
  return getCompletedForDate(displayDate);
}

// P2-1: Get cross-day completions — tasks completed today but belonging to
// a different date. Shows when a user finishes yesterday's task at midnight.
function getCrossDayCompleted(today) {
  return (state.completedActions || [])
    .filter(a => {
      if (!a.completedAt || !a.scheduleDate) return false;
      const completedDate = a.completedAt.slice(0, 10);
      return completedDate === today && a.scheduleDate !== today;
    })
    .map(a => ({
      id: a.id,
      title: a.title,
      scheduleDate: a.scheduleDate,
      completedAt: a.completedAt,
      pattern: a.pattern || 'one-time',
      errandId: a.errandId || null,
      outcome: a.outcome || 'done',
      summary: a.summary || '',
      linkedNoteIds: a.linkedNoteIds || [],
    }))
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
}

function renderCompletedActions() {
  const container = document.getElementById('completed-container');
  if (!container) return;
  const displayDate = formatDate(getViewedDate());
  const todayCompleted = getCompletedForDate(displayDate);
  const crossDayCompleted = getCrossDayCompleted(displayDate);

  if (todayCompleted.length === 0 && crossDayCompleted.length === 0) {
    container.innerHTML = '<div class="empty-state">' + (t('empty.completed') || '暂无已完成事项') + '</div>';
    return;
  }

  let html = '';
  if (todayCompleted.length > 0) {
    html += todayCompleted.map(a => completedActionCardHtml(a)).join('');
  }
  if (crossDayCompleted.length > 0) {
    const crossDayLabel = lang === 'zh' ? '跨日完成（今日操作）' : 'Cross-day (completed today)';
    html += `<div class="cross-day-section">
      <div class="cross-day-header">${escapeHtml(crossDayLabel)}</div>
      ${crossDayCompleted.map(a => {
        const originLabel = lang === 'zh'
          ? `属于 ${escapeHtml(a.scheduleDate)}`
          : `Belongs to ${escapeHtml(a.scheduleDate)}`;
        const timeStr = a.completedAt ? new Date(a.completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        const restoreButton = a.errandId
          ? `<button type="button" class="action-undo-button" onclick="event.stopPropagation();undoCompleteErrand('${escapeAttr(a.id)}')">${t('errand.undoComplete') || '恢复'}</button>`
          : '';
        return `<div class="errand-card completed-action cross-day">
          <span class="commitment-tag done">${t('errand.completed') || 'Done'}</span>
          <div class="errand-info">
            <div class="errand-title">${escapeHtml(a.title)}</div>
            <div class="errand-meta">
              ${timeStr ? escapeHtml(timeStr) + ' · ' : ''}${originLabel}
              ${a.summary ? ' · ' + escapeHtml(a.summary) : ''}
            </div>
          </div>
          <div class="errand-actions">${restoreButton}</div>
        </div>`;
      }).join('')}
    </div>`;
  }
  html += '<div class="ai-followup-reminder" role="note">' + escapeHtml(t('completed.aiFollowup')) + '</div>';
  container.innerHTML = html;
}

function getActionContextRefs(action) {
  const refs = [];
  const seen = new Set();
  const add = (type, id, role) => {
    if (!id || !['note', 'decision'].includes(type)) return;
    const key = `${type}:${id}:${role || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ type, id, role: role || (type === 'decision' ? 'decision_basis' : 'reference') });
  };
  for (const ref of (Array.isArray(action.contextRefs) ? action.contextRefs : [])) add(ref.type, ref.id, ref.role);
  for (const id of (action.noteIds || action.linkedNoteIds || [])) add('note', id, 'reference');
  for (const id of (action.decisionIds || action.linkedDecisionIds || [])) add('decision', id, 'decision_basis');
  return refs;
}

function getContextRoleLabel(role) {
  const labels = lang === 'zh'
    ? { instruction: '执行说明', reference: '参考', constraint: '限制', decision_basis: '决策依据', result: '结果' }
    : { instruction: 'Instruction', reference: 'Reference', constraint: 'Constraint', decision_basis: 'Decision basis', result: 'Result' };
  return labels[role] || labels.reference;
}

function getActionGoal(action) {
  const goalId = action.relatedGoalId || action.goalId || action.linkedGoalId || action.relatedStrategicGoalId;
  return [...(state.currentGoals || []), ...(state.strategicGoals || [])].find(goal => goal.id === goalId) || null;
}

function contextText(value, length = 260) {
  const text = String(value || '').trim();
  return text.length > length ? text.slice(0, length) + '…' : text;
}

function renderActionContextSummary(action, contextKey) {
  const refs = getActionContextRefs(action);
  const goal = getActionGoal(action);
  const topicId = action.topicId || action.linkedTopicId;
  const reasons = [action.contextReason, action.placementReason].filter(Boolean);
  if (!refs.length && !goal && !topicId && !reasons.length) return '';
  const expanded = expandedActionContexts.has(contextKey);
  const parts = [];
  const noteCount = refs.filter(ref => ref.type === 'note').length;
  const decisionCount = refs.filter(ref => ref.type === 'decision').length;
  if (goal) parts.push(lang === 'zh' ? '关联目标' : 'Goal');
  // Do not collapse different context types into “N linked items”: a decision
  // is evidence for the action, not a third note.  The compact header must
  // make that distinction before the user expands the card.
  if (noteCount) parts.push(lang === 'zh' ? `${noteCount} 条笔记` : `${noteCount} notes`);
  if (decisionCount) parts.push(lang === 'zh' ? `${decisionCount} 项决策` : `${decisionCount} decisions`);
  if (topicId) parts.push(getTopicLabel(topicId));
  const label = expanded ? (lang === 'zh' ? '收起执行上下文' : 'Hide context') : (lang === 'zh' ? '查看执行上下文' : 'View context');
  return `<button type="button" class="action-context-toggle" aria-expanded="${expanded}" onclick="event.stopPropagation();toggleActionContext('${escapeAttr(contextKey)}')"><span>${escapeHtml(label)}</span>${parts.length ? `<span class="action-context-summary">${escapeHtml(parts.join(' · '))}</span>` : ''}<span aria-hidden="true">${expanded ? '⌃' : '⌄'}</span></button>`;
}

function renderActionContext(action, contextKey) {
  if (!expandedActionContexts.has(contextKey)) return '';
  const refs = getActionContextRefs(action);
  const goal = getActionGoal(action);
  const topicId = action.topicId || action.linkedTopicId;
  const notes = state.notes || [];
  const decisions = state.decisions || [];
  const sections = [];

  if (goal) sections.push(`<div class="action-context-line"><span class="action-context-label">${lang === 'zh' ? '目标' : 'Goal'}</span><span>${escapeHtml(goal.title)}</span></div>`);
  if (topicId) sections.push(`<div class="action-context-line"><span class="action-context-label">${lang === 'zh' ? '主题' : 'Topic'}</span><span>${escapeHtml(getTopicLabel(topicId))}</span></div>`);
  if (action.contextReason) sections.push(`<div class="action-context-reason"><span class="action-context-label">${lang === 'zh' ? '为什么关联' : 'Why this context'}</span>${escapeHtml(contextText(action.contextReason, 400))}</div>`);
  if (action.placementReason) sections.push(`<div class="action-context-reason"><span class="action-context-label">${lang === 'zh' ? '为什么现在做' : 'Why now'}</span>${escapeHtml(contextText(action.placementReason, 400))}</div>`);

  for (const ref of refs) {
    const entity = ref.type === 'note' ? notes.find(note => note.id === ref.id) : decisions.find(decision => decision.id === ref.id);
    const typeLabel = ref.type === 'note' ? (lang === 'zh' ? '笔记' : 'Note') : (lang === 'zh' ? '决策' : 'Decision');
    if (!entity) {
      sections.push(`<div class="action-context-item missing"><span class="action-context-item-type">${escapeHtml(typeLabel)} · ${escapeHtml(getContextRoleLabel(ref.role))}</span><span>${lang === 'zh' ? '关联内容已不存在' : 'Linked content is no longer available'}</span></div>`);
      continue;
    }
    const openNote = ref.type === 'note'
      ? `<button type="button" class="action-context-open-note" onclick="event.stopPropagation();openNoteFromKnowledge('${escapeAttr(entity.id)}')">${lang === 'zh' ? '查看完整笔记' : 'Open full note'}</button>`
      : '';
    // A note body belongs to the knowledge view.  Rendering it here makes a
    // single long note stretch every linked action card, so execution context
    // carries only its title and a deliberate navigation affordance.
    const detail = ref.type === 'decision' ? (entity.evidence || entity.impact || entity.outcome || '') : '';
    sections.push(`<div class="action-context-item ${ref.type === 'note' ? 'note-reference' : 'decision-reference'}"><span class="action-context-item-type">${escapeHtml(typeLabel)} · ${escapeHtml(getContextRoleLabel(ref.role))}</span><strong>${escapeHtml(entity.title || '')}</strong>${detail ? `<p>${escapeHtml(contextText(detail))}</p>` : ''}${openNote}</div>`);
  }

  if (!sections.length) return '';
  return `<div class="action-context" role="region" aria-label="${lang === 'zh' ? '执行上下文' : 'Execution context'}">${sections.join('')}</div>`;
}

function toggleActionContext(contextKey) {
  if (expandedActionContexts.has(contextKey)) expandedActionContexts.delete(contextKey);
  else expandedActionContexts.add(contextKey);
  renderAll();
}

function getLinkedNotesHtml(noteIds) {
  if (!noteIds || !noteIds.length) return '';
  const allNotes = state.notes || [];
  const linked = noteIds
    .map(id => allNotes.find(n => n.id === id))
    .filter(Boolean);
  if (!linked.length) return '';
  return '<div class="errand-linked-notes">' +
    linked.map(n => `<span class="errand-linked-note" title="${escapeHtml(n.title)}">📎 ${escapeHtml(n.title)}</span>`).join('') +
    '</div>';
}

// Topic-fallback linked notes: when an entity has no explicit noteIds, still
// surface notes that share its topic (or its related goal's topic) so the
// knowledge-base association is visible on cards even before the AI links them.
function _collectTopicNoteIds(topicId) {
  if (!topicId) return [];
  return (state.notes || []).filter(n => n.topicId === topicId).map(n => n.id);
}
function _goalById(id) {
  if (!id) return null;
  const g = state.goals || {};
  return [...(g.currentGoals || []), ...(g.strategicGoals || [])].find(x => x.id === id) || null;
}
function getLinkedNotesForTask(task) {
  const ids = new Set(Array.isArray(task.noteIds) ? task.noteIds : []);
  const g = _goalById(task.relatedGoalId);
  if (g) {
    (g.noteIds || []).forEach(id => ids.add(id));
    _collectTopicNoteIds(g.topicId).forEach(id => ids.add(id));
  }
  if (task.topicId) _collectTopicNoteIds(task.topicId).forEach(id => ids.add(id));
  return getLinkedNotesHtml(Array.from(ids));
}
function getLinkedNotesForGoal(goal) {
  const ids = new Set(Array.isArray(goal.noteIds) ? goal.noteIds : []);
  if (goal.topicId) _collectTopicNoteIds(goal.topicId).forEach(id => ids.add(id));
  return getLinkedNotesHtml(Array.from(ids));
}

function errandCardHtml(e) {
  const commitmentLabel = { must: t('errand.must'), should: t('errand.should'), nice: t('errand.nice') };
  const retention = getRetentionInfo(e);
  const patternTag = e.pattern === 'recurring'
    ? '<span class="errand-pattern-tag recurring">🔄</span>'
    : '';
  const linkedNotes = getLinkedNotesHtml(e.noteIds);
  const contextKey = `errand:${e.id}`;
  return `
    <div class="task-card action-queue unscheduled-action${e.completed ? ' completed' : ''}">
      <div class="task-time action-queue-time">
        <span class="commitment-tag ${e.commitmentLevel || 'should'}">${commitmentLabel[e.commitmentLevel] || t('errand.should')}</span>
        ${patternTag}
      </div>
      <div class="task-body">
        <div class="task-title">${escapeHtml(e.title)}</div>
        <div class="task-desc">
          ${e.date ? escapeHtml(e.date) + ' · ' : ''}${t('action.unscheduled')}${e.note ? ' · ' + escapeHtml(e.note) : ''}
        </div>
        ${linkedNotes}
        ${renderActionContextSummary(e, contextKey)}
        ${renderActionContext(e, contextKey)}
        <div class="task-footer">
          <div class="task-meta"><span class="task-retention ${retention.key}">${retention.label}</span></div>
          <div class="task-card-actions">
            <button type="button" class="action-time-button" onclick="event.stopPropagation();editActionTime('${escapeAttr(e.id)}', '', ${Number(e.duration) || 60})">${t('action.scheduleTime')}</button>
            <button type="button" class="task-delete-btn" onclick="event.stopPropagation();deleteErrand('${escapeAttr(e.id)}','${escapeAttr(e.title)}')" title="Delete" aria-label="Delete">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
            <div class="task-checkbox ${e.completed ? 'checked' : ''}" onclick="event.stopPropagation();toggleErrand('${escapeAttr(e.id)}')" title="${e.completed ? t('errand.done') : t('errand.undo')}"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function unscheduledTaskCardHtml(task, date) {
  const contextKey = `task:${date}:${task.id}`;
  return `
    <div class="errand-card action-queue${task.completed ? ' completed' : ''}">
      <span class="commitment-tag should">${t('action.task')}</span>
      <div class="errand-info">
        <div class="errand-title">${escapeHtml(translateTaskTitle(task.title))}</div>
        <div class="errand-meta">${escapeHtml(date)} · ${t('action.unscheduled')}</div>
        ${renderActionContextSummary(task, contextKey)}
        ${renderActionContext(task, contextKey)}
      </div>
      <div class="errand-actions">
        <button type="button" class="action-time-button" onclick="event.stopPropagation();editTaskTime('${escapeAttr(date)}', '${escapeAttr(task.id)}', '', ${Number(task.duration) || 60})">${t('action.scheduleTime')}</button>
        <div class="errand-checkbox ${task.completed ? 'checked' : ''}" onclick="event.stopPropagation();toggleTask('${escapeAttr(date)}', '${escapeAttr(task.id)}')"></div>
      </div>
    </div>
  `;
}

// ===== Notes Rendering (topic-driven; six-domain model removed) =====
let currentNoteTab = '__all';
// Notes are shown as a short summary (Layer-0 style); the user clicks to expand the full content.
const expandedNotes = new Set();

// Global topic label cache, kept in sync by renderTopics()
const topicMap = {};
function getTopicLabel(topicId) {
  if (!topicId) return '未分类';
  const indexed = (state.topicIndex || []).find(topic => topic.id === topicId);
  if (indexed?.label) return indexed.label;
  if (topicMap[topicId] && topicMap[topicId].label) return topicMap[topicId].label;
  return '未分类';
}

function switchNoteTab(topic) {
  currentNoteTab = topic;
  visibleCounts.notes = PAGE_SIZE.notes;
  document.querySelectorAll('.note-tab').forEach(tab => tab.classList.remove('active'));
  const targetTab = document.querySelector(`.note-tab[data-topic="${escapeAttr(topic)}"]`);
  if (targetTab) targetTab.classList.add('active');
  renderNotes();
}

// Build topic filter tabs dynamically from the notes themselves + known topics
function renderNoteTopicTabs() {
  const tabsEl = document.querySelector('#section-notes .note-tabs');
  if (!tabsEl) return;
  const notes = Array.isArray(state.notes) ? state.notes.filter(note => note.lifecycleState !== 'archived') : [];
  const allTopicIds = [...new Set(notes.filter(note => !note.needsEnrichment).map(n => n.topicId).filter(Boolean))];
  // Defensive: filter out topics that no longer exist in the topic index
  const validTopicIds = allTopicIds.filter(tid => (state.topicIndex || []).some(t => t.id === tid));
  const unclassifiedCount = notes.filter(note => note.needsEnrichment || !note.topicId).length;
  // If current tab points to a deleted topic, reset to __all
  if (currentNoteTab !== '__all' && currentNoteTab !== '__unclassified' && !validTopicIds.includes(currentNoteTab)) {
    currentNoteTab = '__all';
  }
  // Build labels: prefer topicMap, fall back to topicId
  const tabsHtml = [`<button class="note-tab ${currentNoteTab === '__all' ? 'active' : ''}" data-topic="__all" onclick="switchNoteTab('__all')">${t('note.all') || 'All'}</button>`];
  if (unclassifiedCount) {
    tabsHtml.push(`<button class="note-tab ${currentNoteTab === '__unclassified' ? 'active' : ''}" data-topic="__unclassified" onclick="switchNoteTab('__unclassified')">${t('note.tab.unclassified')} · ${unclassifiedCount}</button>`);
  }
  for (const tid of validTopicIds) {
    const label = getTopicLabel(tid);
    const active = currentNoteTab === tid ? 'active' : '';
    tabsHtml.push(`<button class="note-tab ${active}" data-topic="${escapeAttr(tid)}" onclick="switchNoteTab('${escapeAttr(tid)}')">${escapeHtml(label)}</button>`);
  }
  tabsEl.innerHTML = tabsHtml.join('');
}

function renderNotes() {
  const container = document.getElementById('notes-container');
  if (!container) return;  // section may not be in DOM — never let this abort renderAll
  const notes = Array.isArray(state.notes) ? state.notes.filter(note => note.lifecycleState !== 'archived') : [];
  const filtered = currentNoteTab === '__all'
    ? notes
    : currentNoteTab === '__unclassified'
      ? notes.filter(note => note.needsEnrichment || !note.topicId)
    : notes.filter(n => n.topicId === currentNoteTab);

  renderNoteTopicTabs();

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">${t('empty.notes')}</div>`;
    return;
  }

  // Sort by time descending
  const sorted = filtered.sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || '')
  );

  const shown = sorted.slice(0, visibleCounts.notes);
  container.innerHTML = shown.map(n => {
    const titleText = n.title || t('note.pendingTitle');
    const expanded = expandedNotes.has(n.id);
    const detail = noteDetails.get(n.id);
    const fullContent = detail?.content;
    const created = formatDateTime(n.createdAt);
    const when = formatNoteWhen(n); // user-specified occurrence time
    const whenHtml = when
      ? `<span class="note-when-tag" title="${t('note.when.tooltip')}">${escapeHtml(when)}</span>`
      : '';
    const topicBadge = n.topicId
      ? `<span class="note-topic-badge">${escapeHtml(getTopicLabel(n.topicId))}</span>`
      : '';
    return `
      <div class="note-card${expanded ? ' expanded' : ''}">
        <div class="note-delete-btn" onclick="event.stopPropagation();deleteNote('${escapeAttr(n.id)}','${escapeAttr(titleText)}')" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </div>
        <div class="note-row" onclick="toggleNoteExpand('${escapeAttr(n.id)}')">
          <span class="note-caret">${expanded ? '▾' : '▸'}</span>
          <span class="note-summary${n.needsEnrichment ? ' pending' : ''}">${escapeHtml(titleText)}</span>
        </div>
        ${expanded ? (() => {
          const isEditing = editingNoteId === n.id;
          if (isEditing) {
            return `<div class="note-content-full note-editing">
              <textarea id="note-edit-textarea-${escapeAttr(n.id)}" class="note-edit-textarea">${escapeHtml(fullContent || '')}</textarea>
              <div class="note-edit-actions">
                <button class="note-save-btn" onclick="event.stopPropagation();saveEditNote('${escapeAttr(n.id)}')">${t('note.save') || '保存'}</button>
                <button class="note-cancel-btn" onclick="event.stopPropagation();cancelEditNote()">${t('note.cancel') || '取消'}</button>
              </div>
            </div>`;
          }
          return `<div class="note-content-full">
            <div class="note-content-text">${escapeHtml(fullContent || (n.contentLength ? t('note.contentMissing') : ''))}</div>
            <div class="note-edit-actions">
              <button class="note-edit-btn" onclick="event.stopPropagation();startEditNote('${escapeAttr(n.id)}')">${t('note.edit') || '编辑'}</button>
            </div>
          </div>`;
        })() : ''}
        <div class="note-meta">
          <span class="note-created" title="${t('note.created.tooltip')}">${created}</span>
          ${topicBadge}
          <span class="note-source-tag">${escapeHtml(n.source || 'Chat extracted')}</span>
          ${whenHtml}
          ${n.signal ? '<span class="note-signal-badge ' + escapeAttr(n.signal) + '">' + (n.signal === 'health_negative' ? (lang === 'zh' ? '健康' : 'Health') : n.signal === 'emotional_stress' ? (lang === 'zh' ? '情绪' : 'Emotion') : '✓') + '</span>' : ''}
        </div>
      </div>
    `;
  }).join('') + renderMoreButton('notes', shown.length, sorted.length);
  // Auto-focus textarea when editing
  if (editingNoteId) {
    const ta = document.getElementById('note-edit-textarea-' + editingNoteId);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

// Format a note's user-specified occurrence time (relatedDate + optional relatedTime)
function formatNoteWhen(n) {
  if (!n.relatedDate) return '';
  const [y, m, d] = n.relatedDate.split('-');
  if (!m || !d) return n.relatedDate;
  let s = `${m}-${d}`;
  if (n.relatedTime) s += ` ${n.relatedTime}`;
  return s;
}

// ===== Note Edit =====
let editingNoteId = null;

async function ensureNoteDetail(noteId) {
  const cached = noteDetails.get(noteId);
  if (cached) return cached;
  const data = await fetchJson(`/api/note?noteId=${encodeURIComponent(noteId)}`);
  if (data?.note) {
    noteDetails.set(noteId, data.note);
    return data.note;
  }
  return null;
}

async function startEditNote(noteId) {
  const detail = await ensureNoteDetail(noteId);
  if (!detail) return;
  editingNoteId = noteId;
  renderNotes();
}

function cancelEditNote() {
  editingNoteId = null;
  renderNotes();
}

async function saveEditNote(noteId) {
  const textarea = document.getElementById('note-edit-textarea-' + noteId);
  if (!textarea) return;
  const content = textarea.value.trim();
  if (!content) return;
  const result = await runAction('/api/note/update', { noteId, content }, 'Note updated');
  if (!result) return;
  const cached = noteDetails.get(noteId);
  if (cached) noteDetails.set(noteId, { ...cached, content, updatedAt: result.note?.updatedAt || cached.updatedAt });
  editingNoteId = null;
  await refreshState();
  renderNotes();
}

async function toggleNoteExpand(id) {
  if (expandedNotes.has(id)) {
    expandedNotes.delete(id);
  } else {
    const detail = await ensureNoteDetail(id);
    if (!detail) return;
    expandedNotes.add(id);
  }
  renderNotes();
}

// ===== Note Modal =====
let topicComboboxActive = -1; // index of highlighted item, -1 = none

function getTopicComboboxItems() {
  const input = document.getElementById('note-modal-topic');
  const dropdown = document.getElementById('note-modal-topic-dropdown');
  if (!input || !dropdown) return [];
  return Array.from(dropdown.querySelectorAll('.topic-combobox-item'));
}

function showTopicDropdown(filter) {
  const input = document.getElementById('note-modal-topic');
  const dropdown = document.getElementById('note-modal-topic-dropdown');
  if (!input || !dropdown) return;
  const q = (filter || '').trim().toLowerCase();
  const topics = state.topicIndex || [];
  let html = '';
  let idx = 0;
  for (const tp of topics) {
    const label = tp.label || tp.id;
    if (q && !label.toLowerCase().includes(q)) continue;
    html += `<div class="topic-combobox-item" data-value="${escapeAttr(label)}" data-index="${idx}">${escapeHtml(label)}</div>`;
    idx++;
  }
  // If input text doesn't match any existing topic, show a "create new" hint
  if (q && idx === 0) {
    html += `<div class="topic-combobox-item hint" data-value="${escapeAttr(filter.trim())}" data-index="${idx}">${escapeHtml(t('note.topic.create'))}</div>`;
  }
  if (!html) { dropdown.style.display = 'none'; return; }
  dropdown.innerHTML = html;
  dropdown.style.display = '';
  topicComboboxActive = -1;
}

function hideTopicDropdown() {
  const dropdown = document.getElementById('note-modal-topic-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  topicComboboxActive = -1;
}

function selectTopicComboboxItem(el) {
  const input = document.getElementById('note-modal-topic');
  if (!input || !el) return;
  const val = el.getAttribute('data-value') || '';
  input.value = val;
  hideTopicDropdown();
}

function initTopicComboboxEvents() {
  const input = document.getElementById('note-modal-topic');
  const dropdown = document.getElementById('note-modal-topic-dropdown');
  if (!input || !dropdown) return;

  input.addEventListener('focus', () => { showTopicDropdown(input.value); });
  input.addEventListener('input', () => { showTopicDropdown(input.value); });

  dropdown.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.topic-combobox-item');
    if (item) { e.preventDefault(); selectTopicComboboxItem(item); }
  });

  input.addEventListener('keydown', (e) => {
    const items = getTopicComboboxItems();
    if (dropdown.style.display === 'none' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (topicComboboxActive < items.length - 1) topicComboboxActive++;
      items.forEach((it, i) => it.classList.toggle('active', i === topicComboboxActive));
      items[topicComboboxActive]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (topicComboboxActive > 0) topicComboboxActive--;
      items.forEach((it, i) => it.classList.toggle('active', i === topicComboboxActive));
      items[topicComboboxActive]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (topicComboboxActive >= 0 && items[topicComboboxActive]) {
        selectTopicComboboxItem(items[topicComboboxActive]);
      } else {
        // User typed a custom value and pressed Enter — keep it
        hideTopicDropdown();
      }
    } else if (e.key === 'Escape') {
      hideTopicDropdown();
    }
  });

  // Close on click outside
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.topic-combobox')) hideTopicDropdown();
  });
}

function openNoteModal() {
  // Reset fields
  const titleEl = document.getElementById('note-modal-title');
  const contentEl = document.getElementById('note-modal-content');
  const topicInput = document.getElementById('note-modal-topic');
  const dateEl = document.getElementById('note-modal-date');
  const timeEl = document.getElementById('note-modal-time');
  if (titleEl) titleEl.value = '';
  if (contentEl) contentEl.value = '';
  if (topicInput) topicInput.value = '';
  if (dateEl) { dateEl.value = ''; dateEl.type = 'text'; }
  if (timeEl) { timeEl.value = ''; timeEl.type = 'text'; }
  hideTopicDropdown();
  document.getElementById('note-modal').style.display = '';
  setTimeout(() => { if (contentEl) contentEl.focus(); }, 100);
}

function closeNoteModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('note-modal').style.display = 'none';
  hideTopicDropdown();
}

async function confirmAddNote() {
  const titleEl = document.getElementById('note-modal-title');
  const contentEl = document.getElementById('note-modal-content');
  const topicInput = document.getElementById('note-modal-topic');
  const dateEl = document.getElementById('note-modal-date');
  const timeEl = document.getElementById('note-modal-time');
  const title = (titleEl && titleEl.value || '').trim();
  const content = (contentEl && contentEl.value || '').trim();
  const topic = (topicInput && topicInput.value || '').trim();
  if (!content) return;
  if (!title) { titleEl?.focus(); return; }
  if (!topic) { topicInput?.focus(); return; }
  const relatedDate = (dateEl && dateEl.value || '') || null;
  const relatedTime = (timeEl && timeEl.value || '') || null;
  const payload = { title, content, topic, relatedDate, relatedTime, source: 'manual' };
  const result = await runAction('/api/note/add', payload, 'Note added');
  if (!result) return;
  closeNoteModal();
  await refreshState();
  renderAll();
}



async function openNoteFromKnowledge(noteId) {
  showView('all');
  currentNoteTab = '__all';
  visibleCounts.notes = PAGE_SIZE.notes;
  document.querySelectorAll('.note-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.topic === '__all'));
  const detail = await ensureNoteDetail(noteId);
  if (!detail) return;
  expandedNotes.add(noteId);
  renderNotes();
  document.getElementById('section-notes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function translateTaskTitle(title) {
  if (!title) return title;
  const followMatch = title.match(/^💡\s*Follow-up:\s*(.+?)\s*\((\d+)\s*days?\s*(?:left|remaining)\)$/i);
  if (followMatch) return t('task.followup', { title: followMatch[1], n: followMatch[2] });
  const followMatch2 = title.match(/^💡\s*Follow-up:\s*(.+)$/i);
  if (followMatch2) return t('task.followup.unknown', { title: followMatch2[1] });
  const phaseMatch = title.match(/^\[(.+?)\]\s*(.+)$/);
  if (phaseMatch) return t('task.phase', { phase: phaseMatch[1], title: phaseMatch[2] });
  return title;
}

// ===== Utility Functions =====
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  // Security: also escape quotes so the result is safe inside HTML attributes
  // (e.g. onclick="fn('...')") — div.innerHTML alone does NOT escape ' or "
  return div.innerHTML.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// Security: escape a string for use inside a JS single-quoted string within an
// HTML attribute (e.g. onclick="fn('ESCAPED')"). HTML entities like &#39; are
// decoded by the HTML parser BEFORE JS execution, so we must use backslash
// escaping for the JS layer and &quot; for the HTML attribute layer.
function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')   // escape backslashes first (prevent escape injection)
    .replace(/'/g, "\\'")      // escape single quotes for JS string context
    .replace(/"/g, '&quot;')   // escape double quotes for HTML attribute context
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '\\n')     // escape newlines for JS
    .replace(/\r/g, '\\r');
}

// ===== Interaction: Delete Goal/Constraint =====
async function deleteGoal(type, id, title) {
  await requestEntityDelete('goal', { id, goalType: type }, title);
}

// ===== Interaction: Errand Management =====
async function toggleErrand(id) {
  const result = await postJson('/api/errand/complete', { id });
  // 无论成功还是已完成，都刷新状态重新渲染（completedActions 中的 errand 会从列表消失）
  if (result && result.success === false && result.code === 'ALREADY_DONE') {
    // errand 已完成（可能因双击或竞态），静默刷新即可
    await refreshState();
    renderAll();
    return;
  }
  if (!result || result.success === false || result.error) return;
  await refreshState();
  renderAll();
}

async function undoCompleteErrand(actionId) {
  const result = await postJson('/api/errand/undo', { actionId });
  if (!result || result.success === false || result.error) {
    if (result && result.error) showToast(result.error, 'error');
    return;
  }
  await refreshState();
  renderAll();
}

async function restoreCompletedTask(date, taskId) {
  if (!date || !taskId) {
    showToast(lang === 'zh' ? '该历史任务缺少原始日期，无法恢复' : 'This completed task has no original date to restore.', 'error');
    return;
  }
  await toggleTask(date, taskId);
}

function requestTaskDelete(date, id, title) {
  requestActionDelete('task', id, title, date);
}

async function requestActionDelete(kind, id, title, date = '') {
  const payload = kind === 'task' ? { date, taskId: id } : { id };
  await requestEntityDelete(kind, payload, title);
}

function deletionImpactHtml(preview) {
  const labels = {
    scheduleTasks: lang === 'zh' ? '日程' : 'schedule items',
    recurringPreviews: lang === 'zh' ? '周期预排' : 'recurring previews',
    errands: lang === 'zh' ? '待安排事项' : 'actions',
    completedActions: lang === 'zh' ? '完成记录' : 'completed records',
    decisions: lang === 'zh' ? '决策记录' : 'decision records',
    followUps: lang === 'zh' ? '后续提醒' : 'follow-ups',
    notes: lang === 'zh' ? '笔记' : 'notes',
    preservedActionItems: lang === 'zh' ? '保留的行动' : 'preserved actions',
    preservedGoals: lang === 'zh' ? '保留的目标' : 'preserved goals',
  };
  const rows = Object.entries(preview?.impact || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `<div class="prev-item"><div class="prev-num">${Number(count)}</div><div class="prev-label">${escapeHtml(labels[key] || key)}</div></div>`);
  const taskSamples = preview?.samples?.scheduleTasks || [];
  const sample = taskSamples.length
    ? `<div class="prev-detail"><b>${lang === 'zh' ? '受影响日程：' : 'Affected schedule: '}</b>${taskSamples.map(item => escapeHtml(item.title || item.id)).join('、')}</div>`
    : '';
  const hint = lang === 'zh'
    ? '删除后会立即清理上述实体中的失效关联；此操作不可撤销。'
    : 'Deletion immediately removes the affected stale links and cannot be undone.';
  return `${rows.length ? `<div class="topic-delete-preview">${rows.join('')}</div>` : ''}${sample}<div class="topic-delete-warn">${hint}</div>`;
}

async function requestEntityDelete(entityType, payload, title) {
  const preview = await postJson('/api/delete/preview', { entityType, ...payload });
  if (!preview || preview.success === false || preview.error) return;
  pendingActionDelete = { entityType, payload, title };
  const name = document.getElementById('action-delete-name');
  const heading = document.getElementById('action-delete-title');
  const impact = document.getElementById('action-delete-impact');
  const modal = document.getElementById('action-delete-modal');
  if (name) name.textContent = title;
  if (heading) heading.textContent = lang === 'zh' ? '确认删除' : 'Confirm deletion';
  if (impact) impact.innerHTML = deletionImpactHtml(preview);
  if (modal) modal.style.display = '';
}

function closeActionDeleteModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById('action-delete-modal');
  if (modal) modal.style.display = 'none';
  pendingActionDelete = null;
}

async function confirmActionDelete() {
  const pending = pendingActionDelete;
  if (!pending) return;
  const routes = {
    task: { url: '/api/task/delete', body: pending.payload },
    errand: { url: '/api/errand/delete', body: pending.payload },
    note: { url: '/api/note/delete', body: pending.payload },
    decision: { url: '/api/decision/delete', body: pending.payload },
    goal: { url: '/api/delete-goal', body: { id: pending.payload.id, type: pending.payload.goalType } },
  };
  const route = routes[pending.entityType];
  if (!route) return;
  const result = await runAction(
    route.url,
    route.body,
    lang === 'zh' ? '已删除并清理关联' : 'Deleted and references cleaned',
  );
  if (!result) return;
  closeActionDeleteModal();
  await refreshState();
  renderAll();
}

function deleteErrand(id, title) {
  requestActionDelete('errand', id, title);
}

// ===== Interaction: Delete Note (removes stale action/decision references too) =====
async function deleteNote(noteId, title) {
  await requestEntityDelete('note', { noteId }, title);
}

async function deleteDecision(id, title) {
  await requestEntityDelete('decision', { id }, title);
}

function showAddErrandForm() {
  const today = formatDate(getViewedDate());
  document.getElementById('errand-date').value = today;
  document.getElementById('errand-time').value = '';
  document.getElementById('errand-title').value = '';
  document.getElementById('errand-duration').value = '60';
  document.getElementById('errand-commitment').value = 'should';
  document.getElementById('errand-note').value = '';
  document.getElementById('errand-modal').style.display = '';
  setTimeout(() => document.getElementById('errand-title').focus(), 100);
}

function closeErrandModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('errand-modal').style.display = 'none';
}

async function confirmAddErrand() {
  const title = document.getElementById('errand-title').value.trim();
  const date = document.getElementById('errand-date').value;
  const time = document.getElementById('errand-time').value;
  const duration = parseInt(document.getElementById('errand-duration').value) || 60;
  const commitmentLevel = document.getElementById('errand-commitment').value;
  const note = document.getElementById('errand-note').value.trim();
  
  if (!title) {
    alert(t('alert.errandRequired'));
    return;
  }
  
  const result = await runAction('/api/errand/add', { title, date, time, duration, commitmentLevel, note }, 'Errand added');
  if (!result) return;
  closeErrandModal();
  await refreshState();
  renderAll();
}

// ===== Second Brain · View Switch + Topic Library =====

// ===== Lock overlay: when AI is writing, show overlay and disable user interaction =====
function showLockOverlay(by) {
  let overlay = document.getElementById('lock-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'lock-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center;pointer-events:all;';
    overlay.innerHTML = '<div style="background:var(--bg-card,#1e1e2e);border:1px solid var(--border-color,#333);border-radius:12px;padding:24px 32px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.4);">' +
      '<div style="font-size:28px;margin-bottom:8px;">⏳</div>' +
      '<div style="font-size:14px;color:var(--text-primary,#eee);font-weight:600;">AI 正在更新数据...</div>' +
      '<div style="font-size:12px;color:var(--text-muted,#888);margin-top:4px;">请稍候，操作完成后自动恢复</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
}

function hideLockOverlay() {
  const overlay = document.getElementById('lock-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Native fetch wrapper — delegates to postJson for Electron IPC compatibility
async function apiGet(url) {
  return await fetchJson(url);
}
async function apiPost(url, body) {
  return await postJson(url, body);
}

// View switch: declutter core
function showView(view) {
  if (view !== 'today' && view !== 'knowledge' && view !== 'all') view = 'today';
  currentView = view;
  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.dashboard-body [data-view]').forEach(s => {
    const views = (s.dataset.view || '').split(/\s+/);
    s.classList.toggle('view-active', views.includes(view));
  });
  // Errands is shared by Today + All and its content depends on the active view
  // (today = that day only; all = every errand). Re-render so the visible set is correct.
  if (view === 'today') renderErrands();
  try { localStorage.setItem('zhigui_view', view); } catch (e) {}
  // Force-refresh Topic Library when switching to knowledge view —
  // ensures deletions made in other views are reflected immediately.
  if (view === 'knowledge') {
    // Clear the container first to show a loading state, then fetch fresh data
    const c = document.getElementById('topics-container');
    if (c) c.innerHTML = '<div class="topics-empty">Loading...</div>';
    renderTopics();
  }
}

// Topic overview rendering
async function renderTopics() {
  const container = document.getElementById('topics-container');
  if (!container) return;
  const data = await apiGet('/api/topics');
  // Badge
  const badge = document.getElementById('kb-badge');
  const total = data ? (data.total || 0) : 0;
  if (badge) {
    if (total > 0) { badge.style.display = 'inline-flex'; badge.textContent = total; }
    else badge.style.display = 'none';
  }
  const th = document.getElementById('topics-threshold');
  if (th) th.textContent = '';
  if (!data || !data.topics || data.topics.length === 0) {
    container.innerHTML = '<div class="topics-empty">' + t('topic.empty') + '</div>';
    const filter = document.getElementById('kb-category-filter');
    if (filter) {
      filter.innerHTML = '<option value="">' + (t('kb.category.all') || 'All Categories') + ' (0)</option>';
    }
    return;
  }

  // Keep a global topic label cache for the Notes view
  for (const tp of data.topics) topicMap[tp.id] = tp;

  // Update category filter dropdown
  const filter = document.getElementById('kb-category-filter');
  if (filter) {
    const currentValue = filter.value;
    const topics = data.topics;
    const catMap = new Map();
    for (const tp of topics) {
      const cat = tp.category || 'Other';
      if (!catMap.has(cat)) catMap.set(cat, { count: 0, notes: 0 });
      const c = catMap.get(cat);
      c.count++;
      c.notes += (tp.noteCount || 0);
    }
    const cats = [...catMap.entries()].sort((a, b) => b[1].notes - a[1].notes);
    filter.innerHTML = '<option value="">' + (t('kb.category.all') || 'All Categories') + ' (' + topics.length + ')</option>' +
      cats.map(([name, c]) => `<option value="${escapeAttr(name)}">${escapeHtml(name)} (${c.count}, ${c.notes} notes)</option>`).join('');
    filter.value = currentValue;
  }

  // Get active filter
  const activeFilter = filter ? filter.value : '';

  // Group topics by category, then show a bounded cross-category page.  The
  // knowledge index remains complete in storage; the panel does not grow with it.
  const grouped = new Map();
  for (const tp of data.topics) {
    const cat = tp.category || 'Other';
    if (activeFilter && cat !== activeFilter) continue;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(tp);
  }

  // Topics use the same bounded paging state as every other list.  Without an
  // initial value, Array#slice receives `undefined`, renders no cards for most
  // categories, and leaves misleading category headers behind.
  const visibleTopicLimit = Number.isFinite(visibleCounts.topics) && visibleCounts.topics > 0
    ? visibleCounts.topics
    : PAGE_SIZE.topics;
  let remainingTopicSlots = visibleTopicLimit;
  let visibleTopicTotal = 0;

  // Render grouped: Category header + topic cards
  let html = '';
  const unclassified = data.unclassifiedNotes || [];
  if (unclassified.length && remainingTopicSlots > 0) {
    const unclassifiedShown = unclassified.slice(0, Math.max(0, remainingTopicSlots));
    remainingTopicSlots -= unclassifiedShown.length;
    visibleTopicTotal += unclassifiedShown.length;
    html += `<div class="topic-category-group unclassified-group">`;
    html += `<div class="topic-category-header"><span class="topic-category-name">${t('note.tab.unclassified')}</span><span class="topic-category-meta">${t('topic.unclassified.meta', { n: unclassified.length })}</span></div>`;
    html += `<div class="unclassified-note-list">${unclassifiedShown.map(note => `
      <button type="button" class="unclassified-note" onclick="openNoteFromKnowledge('${escapeAttr(note.id)}')">
        <span class="tree-caret">▸</span><span>${escapeHtml(note.title || t('note.pendingTitle'))}</span>
      </button>`).join('')}</div>`;
    html += `</div>`;
  }
  for (const [cat, topics] of grouped) {
    if (remainingTopicSlots <= 0) break;
    const totalNotes = topics.reduce((s, t) => s + (t.noteCount || 0), 0);
    const visibleTopics = topics.slice().sort((a, b) => b.noteCount - a.noteCount).slice(0, remainingTopicSlots);
    remainingTopicSlots -= visibleTopics.length;
    visibleTopicTotal += visibleTopics.length;
    // Do not render a category heading if its cards are deferred to a later
    // page; a header with no clickable topic is a dead end for the user.
    if (!visibleTopics.length) continue;
    html += `<div class="topic-category-group">`;
    html += `<div class="topic-category-header">`;
    html += `<span class="topic-category-name">${escapeHtml(cat)}</span>`;
    html += `<span class="topic-category-meta">${topics.length} topics · ${totalNotes} notes</span>`;
    html += `</div>`;
    html += visibleTopics.map(topicCardHtml).join('');
    html += `</div>`;
  }
  const totalDisplayItems = [...grouped.values()].reduce((total, topics) => total + topics.length, 0) + unclassified.length;
  container.innerHTML = (html || '<div class="topics-empty">' + (t('topic.empty') || 'No topics') + '</div>')
    + renderMoreButton('topics', visibleTopicTotal, totalDisplayItems);
}

function filterTopicsByCategory(cat) {
  visibleCounts.topics = PAGE_SIZE.topics;
  renderTopics();
}

const DOMAIN_LABEL = { health: t('domain.health'), relationship: t('domain.relationship'), career: t('domain.career'), academic: t('domain.academic'), social: t('domain.social'), misc: t('domain.misc') };

function topicCardHtml(topic) {
  const rc = topic.relatedCounts || {};
  const precipBadge = topic.precipitated ? `<span class="topic-chip precip">${t('topic.chip.precip')}</span>` : `<span class="topic-chip">${t('topic.chip.active')}</span>`;
  // Containment summary mirroring the backend tree: 笔记 / 目标
  const chip = `<span class="topic-count">📝 ${rc.notes || 0} · 🎯 ${rc.goals || 0}</span>`;
  return `
    <div class="topic-card" data-topic-id="${topic.id}">
      <div class="topic-head" role="button" tabindex="0">
        <span class="topic-caret">▶</span>
        <span class="topic-label">${escapeHtml(topic.label)}</span>
        ${precipBadge}
        ${chip}
      </div>
      <div class="topic-body">
        <div class="topic-tree" id="topic-tree-${escapeAttr(topic.id)}"><span class="kb-hits-empty">${t('topic.clickLoad')}</span></div>
        <div class="topic-actions">
          <button class="btn-cascade-del" onclick="event.stopPropagation();requestTopicDelete('${escapeAttr(topic.id)}','${escapeAttr(topic.label)}')">${t('topic.cascade.btn')}</button>
        </div>
      </div>
    </div>`;
}

async function toggleTopicExpand(topicId) {
  const card = document.querySelector(`.topic-card[data-topic-id="${topicId}"]`);
  if (!card) return;
  const expanded = card.classList.toggle('expanded');
  if (expanded) await loadTopicDetail(topicId);
}

// Cache of expanded topic detail (notes + associated entities) keyed by topicId
const topicDetailCache = {};

async function loadTopicDetail(topicId) {
  const [doc, a] = await Promise.all([
    apiGet(`/api/topic?topicId=${encodeURIComponent(topicId)}`),
    apiGet(`/api/associated?q=${encodeURIComponent(topicId)}`),
  ]);
  const related = (a && a.found) ? (a.related || {}) : {};
  topicDetailCache[topicId] = { doc: doc || {}, related };
  renderTopicTree(topicId);
}

// ===== Topic containment tree: topic(琐事, 笔记, goal(tasks)) =====
// Front-end of the backend file tree. A topic owns notes + errands + goals, and
// each goal owns its derived schedule tasks. Every node is expandable on click.
function renderTopicTree(topicId) {
  const card = document.querySelector(`.topic-card[data-topic-id="${topicId}"]`);
  if (!card) return;
  const container = card.querySelector('.topic-tree');
  if (!container) return;
  const cache = topicDetailCache[topicId] || { doc: {}, related: {} };
  const doc = cache.doc || {};
  const rel = cache.related || {};
  const notes = doc.notes || [];
  const goals = rel.goals || [];
  if (!notes.length && !goals.length) {
    container.innerHTML = `<span class="kb-hits-empty">${t('topic.tab.empty')}</span>`;
    return;
  }

  let html = '';

  // —— 笔记 group (title-only; the full body opens in the Notes view) ——
  html += `<div class="tree-group">
    <div class="tree-group-head"><span class="tree-ico">📝</span>${t('topic.rel.notes')}<span class="tree-cnt">${notes.length}</span></div>
    <div class="tree-group-body">`;
  if (notes.length) {
    html += notes.map(n => {
      const dom = n.domain ? `<span class="topic-note-domain">${escapeHtml(DOMAIN_LABEL[n.domain] || n.domain)}</span>` : '';
      const dt = (n.relatedDate || n.createdAt)
        ? `<span class="tree-note-time" title="${n.relatedDate ? t('note.when.tooltip') : t('note.created.tooltip')}">${escapeHtml(n.relatedDate ? formatNoteWhen(n) : formatDateTime(n.createdAt))}</span>`
        : '';
      const src = n.source === 'manual' ? `<span class="topic-note-src manual">${t('topic.note.src.manual')}</span>` : (n.source ? `<span class="topic-note-src">${t('topic.note.src.conv')}</span>` : '');
      return `<div class="tree-note">
        <div class="tree-note-heading">
          <span class="tree-note-summary${n.needsEnrichment ? ' pending' : ''}">${escapeHtml(n.title || t('note.pendingTitle'))}</span>
        </div>
        <div class="tree-note-meta">${dom}${src}${dt}</div>
        <button type="button" class="action-context-open-note" onclick="event.stopPropagation();openNoteFromKnowledge('${escapeAttr(n.id)}')">${lang === 'zh' ? '查看完整笔记' : 'Open full note'}</button>
      </div>`;
    }).join('');
  } else {
    html += `<div class="tree-empty">${t('topic.noteEmpty')}</div>`;
  }
  html += `</div></div>`;

  // —— 目标 group (each goal expandable into its derived tasks) ——
  html += `<div class="tree-group">
    <div class="tree-group-head"><span class="tree-ico">🎯</span>${t('topic.rel.goals')}<span class="tree-cnt">${goals.length}</span></div>
    <div class="tree-group-body">`;
  if (goals.length) {
    html += goals.map(g => {
      const tag = g.completed
        ? `<span class="rel-tag completed">${t('goal.completed')}</span>`
        : g.type === 'strategicGoals' ? `<span class="rel-tag strategic">${t('briefing.strategic')}</span>`
        : g.type === 'constraints' ? `<span class="rel-tag constraint">${t('section.constraints')}</span>`
        : `<span class="rel-tag current">${t('goal.current')}</span>`;
      const tasks = getDerivedTasksForGoal(g.id);
      const taskHtml = tasks.length ? tasks.map(renderDerivedTaskRow).join('') : `<div class="tree-empty">${t('goal.noDerived')}</div>`;
      const restoreBtn = g.completed
        ? `<span class="tree-goal-restore" onclick="event.stopPropagation();toggleGoalComplete('${escapeAttr(g.id)}', false)" title="${t('goal.markIncomplete')}">↩ ${t('goal.markIncomplete')}</span>`
        : '';
      return `<div class="tree-goal">
        <div class="tree-goal-head" onclick="toggleTopicGoal(this)">
          <span class="tree-caret">▸</span><div class="tree-goal-body">${tag}<span class="rel-title">${escapeHtml(g.title || g.id)}</span>${restoreBtn}</div>
        </div>
        <div class="tree-goal-tasks">${taskHtml}</div>
      </div>`;
    }).join('');
  } else {
    html += `<div class="tree-empty">${t('topic.tab.empty')}</div>`;
  }
  html += `</div></div>`;

  container.innerHTML = html;
}

function toggleTopicGoal(el) {
  const tasks = el.parentElement.querySelector('.tree-goal-tasks');
  const caret = el.querySelector('.tree-caret');
  if (!tasks) return;
  const open = tasks.style.display !== 'block';
  tasks.style.display = open ? 'block' : 'none';
  if (caret) caret.textContent = open ? '▾' : '▸';
}

// Association search: fuzzy-match across topic labels + notes + goals + events
async function runKbSearch() {
  const input = document.getElementById('kb-search-input');
  const results = document.getElementById('kb-search-results');
  if (!results) return;
  const q = (input && input.value || '').trim();
  if (!q) {
    results.innerHTML = '';
    // Restore all topic cards when search is cleared
    document.querySelectorAll('.topic-card').forEach(c => c.style.display = '');
    return;
  }
  const data = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
  if (!data || !data.hits || data.hits.length === 0) {
    results.innerHTML = '<div class="kb-hits-empty">' + t('kb.noHits') + '</div>';
    // Hide all topic cards since nothing matched
    document.querySelectorAll('.topic-card').forEach(c => c.style.display = 'none');
    return;
  }
  const typeMap = { topic: t('kb.type.topic') || 'Topic', note: t('kb.type.note'), goal: t('kb.type.goal'), event: t('kb.type.event') };
  results.innerHTML = data.hits.slice(0, 20).map(h => {
    const topicLabel = h.topicLabel ? ` · <span class="kb-hit-topic">${escapeHtml(h.topicLabel)}</span>` : '';
    const tid = h.topicId ? encodeURIComponent(h.topicId) : '';
    const isTopicHit = h.type === 'topic';
    const label = h.title || h.snippet || h.text || '';
    return `<div class="kb-hit ${isTopicHit ? 'topic-hit' : ''}" onclick="kbHitClick('${escapeAttr(h.type)}','${escapeAttr(tid)}')"><span class="kb-hit-type">${typeMap[h.type] || h.type}</span>${escapeHtml(label.slice(0, 60))}${topicLabel}</div>`;
  }).join('');
  // Filter topic cards: only show topics that appear in search hits
  const matchedTopicIds = new Set(data.hits.filter(h => h.type === 'topic' || h.topicId).map(h => h.topicId));
  document.querySelectorAll('.topic-card').forEach(c => {
    const tid = c.dataset.topicId;
    c.style.display = (!tid || matchedTopicIds.has(tid)) ? '' : 'none';
  });
}

async function kbHitClick(type, topicIdEnc) {
  const topicId = topicIdEnc ? decodeURIComponent(topicIdEnc) : '';
  if (!topicId) return;
  if (currentView !== 'knowledge') showView('knowledge');
  await renderTopics();
  await toggleTopicExpand(topicId);
}

// Delete a topic's owned notes while preserving linked action items.
async function requestTopicDelete(topicId, label) {
  pendingDeleteTopic = { id: topicId, label: label || '' };
  const preview = await apiPost('/api/topic/delete', { topicId, confirm: false });
  const nameEl = document.getElementById('topic-delete-name');
  const prevEl = document.getElementById('topic-delete-preview');
  if (nameEl) nameEl.textContent = `"${label}"`;
  if (prevEl) {
    if (preview && preview.counts) {
      const c = preview.counts;
      const items = [
        ['notes', t('topic.rel.notes'), c.notes],
        ['preservedActionItems', lang === 'zh' ? '保留的行程/任务' : 'Preserved actions', c.preservedActionItems],
        ['preservedGoals', lang === 'zh' ? '保留的目标' : 'Preserved goals', c.preservedGoals],
      ];
      let html = items.map(([k, l, n]) => `<div class="prev-item"><div class="prev-num">${n || 0}</div><div class="prev-label">${l}</div></div>`).join('');
      // The preview clearly separates notes that will be deleted from entities
      // that will survive with their broken links removed.
      const man = preview.manifest || {};
      const detailLines = [];
      const pushDetail = (arr, key) => {
        if (Array.isArray(arr) && arr.length) {
          const sample = arr.slice(0, 8).map(x => escapeHtml(x.title || x.content || x.id)).join('、');
          const more = arr.length > 8 ? ` …(+${arr.length - 8})` : '';
          detailLines.push(`<div class="prev-detail"><b>${t('topic.rel.' + key)}:</b> ${sample}${more}</div>`);
        }
      };
      pushDetail(man.notes, 'notes');
      if (detailLines.length) html += `<div class="prev-detail-list">${detailLines.join('')}</div>`;
      prevEl.innerHTML = html;
    } else {
      prevEl.innerHTML = '<div class="prev-item"><div class="prev-num">—</div><div class="prev-label">Topic</div></div>';
    }
  }
  const modal = document.getElementById('topic-delete-modal');
  if (modal) modal.style.display = '';
}

function closeTopicDeleteModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById('topic-delete-modal');
  if (modal) modal.style.display = 'none';
}

async function confirmTopicDelete() {
  if (!pendingDeleteTopic) return;
  const result = await apiPost('/api/topic/delete', { topicId: pendingDeleteTopic.id, confirm: true });
  if (!result || result.error) return;
  showToast(lang === 'zh' ? '主题及其笔记已删除，关联行程已保留并清理引用' : 'Topic notes deleted; linked actions were preserved and cleaned', 'success');
  const modal = document.getElementById('topic-delete-modal');
  if (modal) modal.style.display = 'none';
  pendingDeleteTopic = null;
  await refreshState();
  renderAll();
}

// ===== Startup =====
window.addEventListener('DOMContentLoaded', init);
