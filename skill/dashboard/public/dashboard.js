/**
 * ZhiGui · Decision & Planning Companion - Dashboard Logic
 * SSE real-time updates + state rendering + interactions
 */

// ===== Global State =====
let state = {};
let history = {};
let collapsed = false;   // Fixed expanded panel, no floating ball
let currentDayOffset = 0;  // 0 = today, -1 = yesterday, 1 = tomorrow
let theme = 'dark';
let priorityModalContext = null;  // { type, id, name, currentPriority }
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
    'section.briefing': '今日判断', 'section.schedule': '今日行动',
    'section.goals': '目标', 'section.constraints': '限制', 'section.relatedNotes': '相关笔记',
    'section.current': '当前目标', 'section.events': '事件流',
    'section.errands': '待安排事项', 'section.notes': '生活笔记',
    'section.topics': '主题库',
    'empty.goals': '暂无目标', 'errand.all': '全部', 'goal.expand': '点击展开查看衍生任务', 'goal.derivedTasks': '衍生任务', 'goal.derivedGoals': '子目标', 'goal.noDerived': '暂无衍生内容',
    'goal.markComplete': '标记完成', 'goal.markIncomplete': '撤销完成',
    'briefing.must': '必须完成', 'briefing.rec': '今日推荐', 'briefing.not': '不建议', 'briefing.strategic': '战略提醒', 'briefing.dailyQuote': '每日一言',
    'tooltip.pin': '固定', 'tooltip.close': '关闭', 'tooltip.theme': '切换主题', 'tooltip.lang': '语言', 'tooltip.collapse': '收起',
    'unit.pts': '分',
    'btn.addEvent': '添加事件', 'btn.cancel': '取消', 'btn.confirm': '确认',
    'modal.priority.title': '调整优先级', 'modal.priority.hint': '你的选择会被保留；需要时可随时解锁，也可以让 AI 提供不同方案。',
    'modal.event.title': '添加事件',
    'modal.time.title': '编辑时间', 'modal.time.hint': '清空时间后，此行动会回到“待安排事项”。',
    'modal.actionDelete.title': '删除行动', 'modal.actionDelete.hint': '这会将这条行动从当前列表移除，且无法撤销。', 'modal.actionDelete.btn': '删除行动',
    'note.tab.unclassified': '未分类', 'topic.unclassified.meta': '{n} 条 · 等待 AI 整理', 'note.contentMissing': '此历史笔记缺少可读取的原文。',
    'settings.pending': '待确认 {n}', 'modal.review.title': '待确认的整理与冲突', 'modal.review.empty': '暂时没有待确认的问题。', 'review.organization': 'AI 整理建议', 'review.conflict': '设置冲突', 'review.accept': '采纳整理', 'review.reject': '保留原文', 'review.done': '已处理', 'review.question': '需要你确认',
    'form.date': '日期', 'form.time': '时间', 'form.title': '标题', 'form.desc': '描述（可选）',
    'modal.conflict.title': '冲突详情', 'modal.conflict.ok': '知道了',
    'modal.goal.title.strategic': '添加战略目标', 'modal.goal.title.constraint': '添加限制',
    'modal.goal.hint': '这是当前偏好，不是永久规则；知归会在有充分理由时提出调整建议。',
    'form.priority': '优先级',
    'modal.errand.title': '添加事项', 'form.duration': '时长（分钟）', 'form.note': '备注（可选）',
    'errand.opt.must': '必须 - 今天做', 'errand.opt.should': '应该 - 尽可能做', 'errand.opt.nice': '可选 - 有空时做',
    'modal.topicDelete.title': '确认级联删除', 'modal.topicDelete.warn': '这将同时删除该主题下所有关联的目标、日程任务、琐事与笔记，且不可撤销。', 'modal.topicDelete.btn': '确认级联删除',
    'kb.search.ph': '搜索：考试 / 面试 / 智齿…', 'kb.search.btn': '搜索',
    'kb.category.all': '全部分类', 'kb.threshold': '沉淀阈值 {n}',
    'calendar.backToday': '回到今天', 'calendar.legend.arranged': '已排程', 'calendar.legend.today': '今天',
    'calendar.weekdays': '日一二三四五六',
    'topic.empty': '还没有主题。<br>AI 会在整理笔记时判断主题与分类，<br>并逐步构建主题库。',
    'topic.chip.precip': '已归纳', 'topic.chip.active': '活跃',
    'topic.cascade.btn': '级联删除全部',
    'topic.reindex': '重建索引',
    'topic.reindexDone': '索引已重建！扫描了 {goals} 个目标、{notes} 条笔记、{errands} 项琐事。新建 {topicsCreated} 个主题，建立 {topicsLinked} 条关联。',
    'topic.reindexFail': '重建索引失败：',
    'lastUpdated.prefix': '最后更新：',
    'collapsed.tip': '今日 {c}/{t} · {p}%  |  点击展开 · 拖拽移动',
    'src.manual': '手动', 'src.ai': 'AI', 'task.record.manual': '手动录入', 'task.record.ai': 'AI 生成',
    'status.pending': '待处理', 'status.clarifying': '澄清中', 'status.resolved': '已解决', 'status.archived': '已归档',
    'domain.health': '健康', 'domain.relationship': '关系', 'domain.career': '职业', 'domain.academic': '学业', 'domain.social': '社交', 'domain.misc': '其他',
    'errand.must': '必须', 'errand.should': '应该', 'errand.nice': '可选',
    'empty.strategic': '暂无战略目标<br>点击右上角 + 添加，或在对话中告诉 AI',
    'empty.constraints': '暂无限制<br>点击右上角 + 添加',
    'empty.current': '暂无当前目标',
    'goal.current': '当前目标',
    'empty.errands': '暂无待安排事项',
    'empty.notes': '还没有笔记<br><span style="font-size:11px">可以在对话中让 AI 记录，也可以在上方暂存原文</span>',
    'note.all': '全部', 'note.input.ph': '记录一段原始信息…', 'note.aiHint': '这里只记录原文，标题、主题和分类会由 AI 归纳。',
    'note.addBtn': '＋ 记录笔记',
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
    'briefing.empty': '运行 AI 自动排程以生成今日晨报',
    'confirm.deleteGoal': '删除“{title}”？',
    'confirm.deleteErrand': '删除事项“{title}”？',
    'confirm.deleteNote': '删除这条笔记？',
    'alert.eventRequired': '请填写日期、时间和标题',
    'alert.goalRequired': '请输入标题',
    'alert.errandRequired': '请输入事项标题',
    'errand.done': '标记未完成', 'errand.undo': '标记完成',
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
    'task.errand.desc': 'Errand ({priority})',
    'task.locked': '时间由你设定；可继续修改，AI 不会自动覆盖',
    'priority.origin.ai': 'AI 建议', 'priority.origin.manual': '你的设定', 'priority.origin.pending': '待 AI 评估',
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
    'section.briefing': 'Decision check', 'section.schedule': "Today's Actions",
    'section.goals': 'Goals', 'section.constraints': 'Constraints', 'section.relatedNotes': 'Relevant notes',
    'section.current': 'Current Goals', 'section.events': 'Event Stream',
    'section.errands': 'Unscheduled actions', 'section.notes': 'Life Notes',
    'section.topics': 'Topic Library',
    'empty.goals': 'No goals', 'errand.all': 'All', 'goal.expand': 'Click to view derived tasks', 'goal.derivedTasks': 'Derived tasks', 'goal.derivedGoals': 'Sub-goals', 'goal.noDerived': 'No derived items yet',
    'goal.markComplete': 'Mark complete', 'goal.markIncomplete': 'Undo complete',
    'briefing.must': 'Must Complete', 'briefing.rec': 'Today\'s Pick', 'briefing.not': 'Not Recommended', 'briefing.strategic': 'Strategic Reminder', 'briefing.dailyQuote': 'Daily Quote',
    'tooltip.pin': 'Toggle Pin', 'tooltip.close': 'Close', 'tooltip.theme': 'Toggle Theme', 'tooltip.lang': 'Language', 'tooltip.collapse': 'Collapse',
    'unit.pts': 'pts',
    'btn.addEvent': 'Add Event', 'btn.cancel': 'Cancel', 'btn.confirm': 'Confirm',
    'modal.priority.title': 'Adjust Priority', 'modal.priority.hint': 'Your choice is preserved until you release it; AI can still explain alternatives.',
    'modal.event.title': 'Add Event',
    'modal.time.title': 'Edit time', 'modal.time.hint': 'Clear the time to move this action back to Unscheduled actions.',
    'modal.actionDelete.title': 'Delete action', 'modal.actionDelete.hint': 'This removes the action from the current list and cannot be undone.', 'modal.actionDelete.btn': 'Delete action',
    'note.tab.unclassified': 'Unclassified', 'topic.unclassified.meta': '{n} notes · AI review pending', 'note.contentMissing': 'This historical note has no readable source text.',
    'settings.pending': '{n} to review', 'modal.review.title': 'Organization & conflict review', 'modal.review.empty': 'Nothing needs your confirmation right now.', 'review.organization': 'AI organization proposal', 'review.conflict': 'Setting conflict', 'review.accept': 'Accept organization', 'review.reject': 'Keep source text', 'review.done': 'Mark handled', 'review.question': 'Your confirmation is needed',
    'form.date': 'Date', 'form.time': 'Time', 'form.title': 'Title', 'form.desc': 'Description (optional)',
    'modal.conflict.title': 'Conflict Detail', 'modal.conflict.ok': 'Got it',
    'modal.goal.title.strategic': 'Add Strategic Goal', 'modal.goal.title.constraint': 'Add Constraint',
    'modal.goal.hint': 'This is a current preference, not a permanent rule. ZhiGui may suggest changes with reasons.',
    'form.priority': 'Priority',
    'modal.errand.title': 'Add action', 'form.duration': 'Duration (min)', 'form.note': 'Note (optional)',
    'errand.opt.must': 'Must - do today', 'errand.opt.should': 'Should - today if possible', 'errand.opt.nice': 'Nice - if free',
    'modal.topicDelete.title': 'Confirm Cascade Delete', 'modal.topicDelete.warn': 'This will also delete all related events, goals, schedule tasks, errands and notes under this topic. This cannot be undone.', 'modal.topicDelete.btn': 'Confirm Cascade Delete',
    'kb.search.ph': 'Search: exam / interview / wisdom tooth…', 'kb.search.btn': 'Search',
    'kb.category.all': 'All categories', 'kb.threshold': 'Threshold {n}',
    'calendar.backToday': 'Back to Today', 'calendar.legend.arranged': 'Scheduled', 'calendar.legend.today': 'Today',
    'calendar.weekdays': 'MTWTFSS',
    'topic.empty': 'No topics yet.<br>AI decides the topic and category while organizing notes,<br>then builds the library over time.',
    'topic.chip.precip': 'Precipitated', 'topic.chip.active': 'Active',
    'topic.cascade.btn': 'Cascade delete all',
    'topic.reindex': 'Rebuild Index',
    'topic.reindexDone': 'Index rebuilt! Scanned {goals} goals, {notes} notes, {errands} errands. Created {topicsCreated} topics, made {topicsLinked} links.',
    'topic.reindexFail': 'Reindex failed: ',
    'lastUpdated.prefix': 'Last updated: ',
    'collapsed.tip': 'Today {c}/{t} · {p}%  |  click to expand · drag to move',
    'src.manual': 'Manual', 'src.ai': 'AI', 'task.record.manual': 'Manual entry', 'task.record.ai': 'AI generated',
    'status.pending': 'Pending', 'status.clarifying': 'Clarifying', 'status.resolved': 'Resolved', 'status.archived': 'Archived',
    'domain.health': 'Health', 'domain.relationship': 'Relations', 'domain.career': 'Career', 'domain.academic': 'Study', 'domain.social': 'Social', 'domain.misc': 'Other',
    'errand.must': 'Must', 'errand.should': 'Should', 'errand.nice': 'Nice',
    'empty.strategic': 'No strategic goals<br>Tap + on top-right to add, or tell AI in chat',
    'empty.constraints': 'No constraints<br>Tap + on top-right to add',
    'empty.current': 'No current goals',
    'goal.current': 'Current',
    'empty.errands': 'No unscheduled actions',
    'empty.notes': 'No notes yet<br><span style="font-size:11px">Ask AI to remember something, or capture raw text above for later organization</span>',
    'note.all': 'All', 'note.input.ph': 'Capture the original information…', 'note.aiHint': 'This captures raw text only. AI writes the title, topic and category.',
    'note.addBtn': '+ Add Note',
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
    'errand.done': 'Mark incomplete', 'errand.undo': 'Mark done',
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
    'briefing.empty': 'Run AI auto-schedule to generate today\'s briefing',
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
    'task.errand.desc': 'Errand ({priority})',
    'task.locked': 'Set by you — you can still edit it; AI will not override it',
    'priority.origin.ai': 'AI suggestion', 'priority.origin.manual': 'Your setting', 'priority.origin.pending': 'Awaiting AI review',
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

  // Fixed expanded panel mode: no floating ball, always expanded (window size set by main process createWindow)
  if (isElectron) {
    await refreshState();
    collapsed = false;
    document.body.classList.add('expanded');
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
    // Browser: read from localStorage
    const savedCollapsed = localStorage.getItem('zhigui_collapsed');
    if (savedCollapsed === 'false') {
      collapsed = false;
    }
    document.body.classList.add('expanded');
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
    setInterval(refreshState, 30000);
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
      if (url === '/api/priority/update') return await invokeDesktopMutation(() => window.zhigui.updatePriority(body.type, body.id, body.priority));
      if (url === '/api/priority/unlock') return await invokeDesktopMutation(() => window.zhigui.unlockPriority(body.type, body.id));
      if (url === '/api/event/add') return await invokeDesktopMutation(() => window.zhigui.addEvent(body));
      if (url === '/api/goal/add') return await invokeDesktopMutation(() => window.zhigui.addGoal(body));
      if (url === '/api/goal/complete') return await invokeDesktopMutation(() => window.zhigui.completeGoal(body));
      if (url === '/api/delete-goal') return await invokeDesktopMutation(() => window.zhigui.deleteGoal(body));
      if (url === '/api/errand/add') return await invokeDesktopMutation(() => window.zhigui.addErrand(body));
      if (url === '/api/errand/update') return await invokeDesktopMutation(() => window.zhigui.updateErrand(body));
      if (url === '/api/errand/delete') return await invokeDesktopMutation(() => window.zhigui.deleteErrand(body));
      if (url === '/api/errand/complete') return await invokeDesktopMutation(() => window.zhigui.completeErrand(body));
      if (url === '/api/note/add') return await invokeDesktopMutation(() => window.zhigui.addNote(body));
      if (url === '/api/note/update') return await invokeDesktopMutation(() => window.zhigui.updateNote(body));
      if (url === '/api/note/delete') return await invokeDesktopMutation(() => window.zhigui.deleteNote(body));
      if (url === '/api/review/resolve') return await invokeDesktopMutation(() => window.zhigui.resolveReview(body));
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
function toggleCollapse() {
  collapsed = !collapsed;
  document.body.classList.toggle('expanded', !collapsed);
  localStorage.setItem('zhigui_collapsed', collapsed);
  // Electron: sync window size
  if (window.zhigui?.isElectron) {
    window.zhigui.toggleCollapse(collapsed);
  }
}

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
    panel.style.display = '';
    if (mini) mini.style.display = 'none';
    document.body.classList.add('expanded');
    document.body.classList.remove('collapsed');
    if (btn) btn.classList.remove('collapsed');
    if (window.zhigui?.isElectron) {
      window.zhigui.toggleCollapse(false);
    }
    refreshState();
  } else {
    // Collapse: hide panel, show mini icon
    panel.style.display = 'none';
    if (mini) mini.style.display = 'flex';
    document.body.classList.remove('expanded');
    document.body.classList.add('collapsed');
    if (btn) btn.classList.add('collapsed');
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

function formatDateDisplay(dateStr) {
  const d = new Date(dateStr);
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
  const d = new Date(dateStr);
  const names = lang === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return names[d.getDay()];
}

function isToday(dateStr) {
  return dateStr === formatDate(new Date());
}

function getOffsetDate(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ===== Render Entry =====
// Supports incremental rendering: if changedKeys is provided, only re-render
// the affected sections. Falls back to full render for backward compatibility.
const SECTION_MAP = {
  schedule: ['renderCollapsed', 'renderFocusHero', 'renderSchedule'],
  goals: ['renderGoals', 'renderConstraints'],
  notes: ['renderRelatedNotes', 'renderNotes'],
  errands: ['renderErrands'],
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
  renderRelatedNotes();
  renderSchedule();
  renderGoals();
  renderConstraints();
  renderErrands();
  renderPendingReviewBadge();
  renderNotes();
  renderConflicts();
  renderLastUpdated();
  // Refresh Topic Library — deletions in any view must sync to the library.
  // renderTopics() checks container visibility internally to avoid wasted DOM work.
  if (currentView === 'knowledge' || currentView === 'all') renderTopics();
}

function renderFocusHero() {
  const date = formatDate(getOffsetDate(currentDayOffset));
  const tasks = state.schedule?.days?.[date]?.tasks || [];
  const openTasks = tasks.filter(task => !task.completed);
  const completed = tasks.length - openTasks.length;
  const activeGoals = (state.currentGoals || []).filter(goal => !goal.completed);
  const dayErrands = (state.errands || []).filter(errand => errand.date === date && !errand.completed);
  const priorityTask = openTasks.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  const priorityGoal = activeGoals.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  const mainFocus = priorityTask?.title || priorityGoal?.title || (lang === 'zh' ? '给今天留出一点有意识的空间' : 'Leave some intentional space for today');
  const progress = tasks.length ? Math.round(completed / tasks.length * 100) : 0;

  const title = document.getElementById('focus-title');
  const summary = document.getElementById('focus-summary');
  const dateEl = document.getElementById('focus-date');
  if (title) title.textContent = mainFocus;
  if (dateEl) dateEl.textContent = formatDateDisplay(date);
  if (summary) {
    summary.textContent = lang === 'zh'
      ? `${openTasks.length} 项待处理 · ${dayErrands.length} 项生活事项。建议先推进最重要的一步，再根据精力调整。`
      : `${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} · ${dayErrands.length} life action${dayErrands.length === 1 ? '' : 's'}. Start with the highest-leverage move and adapt with your energy.`;
  }
  const taskCount = document.getElementById('focus-task-count');
  const goalCount = document.getElementById('focus-goal-count');
  const progressEl = document.getElementById('focus-progress');
  if (taskCount) taskCount.textContent = openTasks.length;
  if (goalCount) goalCount.textContent = activeGoals.length;
  if (progressEl) progressEl.textContent = `${progress}%`;

  const labels = lang === 'zh'
    ? {
        eyebrow: '今日方向', tasks: '待处理', goals: '进行中目标', progress: '今日进度',
        addEvent: '＋ 加入日程', addErrand: '添加事项'
      }
    : {
        eyebrow: "TODAY'S DIRECTION", tasks: 'open tasks', goals: 'active goals', progress: 'day progress',
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
// "Pending confirmations" and "conflicts" are moved to renderPendingItems().

// Clear today's stored briefing so the dashboard re-derives it from live state.
// Used after a goal is completed/reopened/deleted, so "今日方向" reflects the change.
function invalidateTodayBriefing() {
  const today = formatDate(new Date());
  if (state.briefings && state.briefings[today]) delete state.briefings[today];
  if (state.morningBriefing && state.morningBriefing.date === today) state.morningBriefing = null;
}

function renderBriefing() {
  const displayDate = formatDate(getOffsetDate(currentDayOffset));
  const section = document.getElementById('section-briefing');
  if (!section) return;

  // Always show the briefing section (P0-9.3: never hide)
  section.style.display = '';
  document.getElementById('briefing-date').textContent = formatDateDisplay(displayDate);

  const storedBriefing = (state.briefings && state.briefings[displayDate]) || state.morningBriefing;

  // Extract content into the fixed 5-slot structure: { must, rec, not, strategic, dailyQuote }
  const content = _extractBriefingContent(storedBriefing, displayDate);

  // Update each fixed block's content area
  _setBlockContent('must', content.must);
  _setBlockContent('rec', content.rec);
  _setBlockContent('not', content.not);
  _setBlockContent('strategic', content.strategic);
  _setBlockContent('dailyQuote', content.dailyQuote);
}

// Extract briefing data from any format into the fixed 5-slot structure
function _extractBriefingContent(storedBriefing, displayDate) {
  const empty = { must: '', rec: '', not: '', strategic: '', dailyQuote: '' };

  if (!storedBriefing || storedBriefing.date !== displayDate) {
    // Try local fallback
    return _extractLocalContent(displayDate) || empty;
  }

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

  // Fallback: derive locally
  return _extractLocalContent(displayDate) || empty;
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

  // Note signals -> not
  if (b.noteSignals && b.noteSignals.reason) {
    result.not = b.noteSignals.reason;
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
function _extractLocalContent(displayDate) {
  const dayData = state.schedule?.days?.[displayDate];
  const tasks = dayData?.tasks || [];
  const dayErrands = (state.errands || []).filter(e => e.date === displayDate);
  const activeGoals = (state.currentGoals || []).filter(g => !g.completed);
  const strategicGoals = (state.strategicGoals || []).filter(g => !g.completed);

  if (tasks.length === 0 && activeGoals.length === 0 && dayErrands.length === 0) {
    return null;
  }

  const result = { must: '', rec: '', not: '', strategic: '', dailyQuote: '' };

  // must: must errands + overdue goals
  const mustErrands = dayErrands.filter(e => e.priority === 'must');
  const overdueGoals = activeGoals.filter(g => g.overdue);
  const mustItems = [];
  mustItems.push(...mustErrands.map(e => '📌 ' + e.title));
  mustItems.push(...overdueGoals.map(g => '⚠️ ' + g.title));
  result.must = mustItems.join('；');

  // rec: top priority task or goal
  const topTask = tasks.filter(t => !t.completed).sort((a, b) => b.priority - a.priority)[0];
  const topGoal = activeGoals.slice().sort((a, b) =>
    (b.priority + (b._costPerf || 0)) - (a.priority + (a._costPerf || 0))
  )[0];
  if (topTask) {
    result.rec = topTask.title;
  } else if (topGoal) {
    result.rec = topGoal.title;
  }

  // strategic: strategic goals
  if (strategicGoals.length > 0) {
    result.strategic = strategicGoals.map(g => g.title).join('；');
  }

  return result;
}

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

// Render fixed-format briefing sections as clean labeled blocks (AI fills content only)
// NOTE: This function is now only used by renderPendingItems; kept for backward compat.
function renderBriefingSections(sections, quote) {
  // Fixed 5-section format: label -> dot color mapping
  const zhMap = { '必须完成': 'red', '今日推荐': 'green', '不建议': 'white', '战略提醒': 'gold', '每日一言': 'gold' };
  const blocks = sections.map(s => {
    const dotClass = zhMap[s.label] || 'white';
    return `<div class="briefing-block briefing-block-${dotClass}">
      <div class="briefing-block-head"><span class="briefing-block-label">${escapeHtml(s.label)}</span></div>
      <div class="briefing-row"><span class="briefing-dot ${dotClass}"></span><span class="briefing-row-text">${escapeHtml(s.content)}</span></div>
    </div>`;
  });
  if (quote) {
    blocks.push(`<div class="briefing-quote">${escapeHtml(quote)}</div>`);
  }
  return blocks.join('') || `<div class="briefing-empty">${t('briefing.empty') || (lang === 'zh' ? '暂无晨报数据' : 'No briefing data')}</div>`;
}

// Render the new briefing data model (kept for reference / non-main-card usage)
// NOTE: This function is now unused for the main briefing card; kept for backward compat.
function _renderNewBriefing(b) {
  const parts = [];

  // 1. Top recommendation (decision card)
  if (b.topRecommendation) {
    const rec = b.topRecommendation;
    const scoreBadge = rec.costPerf != null
      ? `<span class="briefing-rec-score">${escapeHtml(String(rec.costPerf))}<span class="briefing-rec-score-unit">${lang === 'zh' ? '分' : 'pts'}</span></span>`
      : '';
    const meta = [
      rec.estimatedTime ? `<span class="briefing-time">${escapeHtml(rec.estimatedTime)}</span>` : '',
      rec.priority != null ? `<span class="briefing-rec-priority">${lang === 'zh' ? '优先级' : 'Priority'} ${rec.priority}</span>` : '',
    ].filter(Boolean).join('<span class="briefing-rec-meta-sep">·</span>');
    parts.push(`
      <div class="briefing-top-rec">
        <div class="briefing-rec-head">
          <div class="briefing-rec-title-wrap">
            <div class="briefing-rec-title">${escapeHtml(rec.title || '')}</div>
            ${rec.reason ? `<div class="briefing-rec-reason">${escapeHtml(rec.reason)}</div>` : ''}
          </div>
          ${scoreBadge}
        </div>
        ${meta ? `<div class="briefing-rec-meta">${meta}</div>` : ''}
      </div>`);
  }

  // 2. Time budget bar
  if (b.timeBudget) {
    const tb = b.timeBudget;
    const totalH = tb.availableHours || 0;
    const schedPct = totalH > 0 ? Math.round((tb.scheduledHours / totalH) * 100) : 0;
    const errandPct = totalH > 0 ? Math.round((tb.errandHours / totalH) * 100) : 0;
    const remainPct = Math.max(0, 100 - schedPct - errandPct);
    parts.push(`
      <div class="briefing-time-budget">
        <div class="briefing-budget-bar">
          <div class="budget-scheduled" style="width:${schedPct}%"></div>
          <div class="budget-errand" style="width:${errandPct}%"></div>
          <div class="budget-remaining" style="width:${remainPct}%"></div>
        </div>
        <div class="briefing-budget-labels">
          <span>${lang === 'zh' ? '已排' : 'Scheduled'} ${tb.scheduledHours || 0}h</span>
          <span>${lang === 'zh' ? '琐事' : 'Errand'} ${tb.errandHours || 0}h</span>
          <span>${lang === 'zh' ? '剩余' : 'Free'} ${tb.remainingHours || 0}h</span>
        </div>
      </div>`);
  }

  // 3. Hard constraints
  if (b.hardConstraints && b.hardConstraints.length > 0) {
    const items = b.hardConstraints.map(c => {
      const icon = c.type === 'must_errand' ? '📌' : c.type === 'rest_day' ? '😴' : c.type === 'deadline_today' ? '⚠️' : '•';
      const text = c.title || c.message || '';
      const timeStr = c.time ? ` ${c.time}` : '';
      return `<div class="briefing-constraint">${icon} ${escapeHtml(text)}${timeStr ? `<span class="briefing-time-tag">${escapeHtml(timeStr)}</span>` : ''}</div>`;
    }).join('');
    parts.push(`<div class="briefing-constraints">${items}</div>`);
  }

  // 4. Note signals
  if (b.noteSignals && b.noteSignals.reason) {
    const ns = b.noteSignals;
    const intensityPct = Math.round((ns.intensityModifier || 1) * 100);
    parts.push(`
      <div class="briefing-signals">
        <div class="briefing-signal-text">${escapeHtml(ns.reason)}</div>
        ${intensityPct < 100 ? `<div class="briefing-intensity">${lang === 'zh' ? '建议强度' : 'Suggested intensity'}: ${intensityPct}%</div>` : ''}
      </div>`);
  }

  // 5. Goal progress
  if (b.goalProgress && b.goalProgress.length > 0) {
    const items = b.goalProgress.map(g => {
      const ddl = g.daysLeft != null ? ` · ${g.daysLeft}${lang === 'zh' ? '天' : 'd'}` : '';
      const phase = g.phase ? ` [${escapeHtml(g.phase)}]` : '';
      const progress = g.weekProgress ? ` ${escapeHtml(g.weekProgress)}` : '';
      return `<div class="briefing-goal-progress">🎯 ${escapeHtml(g.title || '')}${phase}${progress}${ddl}</div>`;
    }).join('');
    parts.push(`<div class="briefing-goal-progress-list">${items}</div>`);
  }

  // 6. Strategic reminder (optional, weekly)
  if (b.strategicReminder && b.strategicReminder.title) {
    parts.push(`
      <div class="briefing-strategic">
        <span class="briefing-strategic-title">${escapeHtml(b.strategicReminder.title)}</span>
        ${b.strategicReminder.weeklyNote ? `<span class="briefing-strategic-note">${escapeHtml(b.strategicReminder.weeklyNote)}</span>` : ''}
      </div>`);
  }

  // 7. Daily quote
  if (b.dailyQuote) {
    parts.push(`<div class="briefing-quote">${escapeHtml(b.dailyQuote)}</div>`);
  }

  return parts.length > 0 ? parts.join('') : `<div class="briefing-empty">${t('briefing.empty') || (lang === 'zh' ? '暂无晨报数据' : 'No briefing data')}</div>`;
}

// Fallback: derive briefing locally when no backend briefing exists
// NOTE: This function is now unused for the main briefing card; kept for backward compat.
function _renderLocalBriefing(displayDate) {
  const content = _extractLocalContent(displayDate);
  if (!content) return `<div class="briefing-empty">${t('briefing.empty') || (lang === 'zh' ? '今天暂无安排' : 'Nothing scheduled today')}</div>`;
  return buildBriefingRows(content, '');
}

// Check if briefing has the new data model fields
function _hasNewBriefingContent(b) {
  if (!b) return false;
  // If briefing is still raw data (AI hasn't composed yet), fall back to old format
  if (b._raw) return false;
  return !!(b.topRecommendation || b.timeBudget || (b.hardConstraints && b.hardConstraints.length > 0) ||
    b.noteSignals || (b.goalProgress && b.goalProgress.length > 0) ||
    (b.sections && b.sections.length > 0));
}

// Render pending items (confirmations + conflicts) as an independent section
// Moved from the old renderLiveBriefing (P0-9.3)
function renderPendingItems() {
  const section = document.getElementById('section-pending-items');
  const card = document.getElementById('pending-items-card');
  if (!section || !card) return;

  const confirmations = (typeof getPendingReviews === 'function' ? getPendingReviews() : [])
    .slice(0, 3)
    .map(review => review.type === 'note_organization'
      ? (review.proposal?.title || review.title || t('review.organization'))
      : (review.title || review.question || t('review.question')))
    .filter(Boolean);
  const urgentGoals = (state.currentGoals || [])
    .filter(goal => !goal.completed && (goal.overdue || (goal.daysLeft != null && goal.daysLeft <= 3)))
    .sort((a, b) => (b.overdue === true) - (a.overdue === true) || (a.daysLeft || 999) - (b.daysLeft || 999))
    .slice(0, 3)
    .map(goal => goal.overdue ? `${goal.title} · ${t('briefing.overdue')}` : `${goal.title} · ${t('goal.ddl.left', { n: goal.daysLeft })}`);
  const conflicts = (state.conflicts || [])
    .filter(conflict => conflict && (conflict.status !== 'resolved'))
    .slice(0, 2)
    .map(conflict => conflict.message || conflict.title || conflict.description)
    .filter(Boolean);

  if (!confirmations.length && !urgentGoals.length && !conflicts.length) {
    section.style.display = 'none';
    card.innerHTML = '';
    return;
  }

  section.style.display = '';
  card.innerHTML = buildBriefingRows({
    must: confirmations,
    rec: urgentGoals,
    not: conflicts,
    strategic: [],
  }, '');
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
  const displayDate = formatDate(getOffsetDate(currentDayOffset));
  
  // Date label: show full date + weekday
  const dateObj = new Date(displayDate);
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  const monthShort = t('calendar.months').split(',')[dateObj.getMonth()];
  document.getElementById('week-label').textContent = 
    t('date.header', { month, day, monthShort, wd: getWeekdayName(displayDate), today: isToday(displayDate) ? ' · ' + t('today') : '' });
  
  const container = document.getElementById('schedule-container');
  const dayData = state.schedule?.days?.[displayDate];
  const scheduledTasks = (dayData?.tasks || [])
    .filter(task => task.time)
    .map(task => ({ kind: 'task', item: task }));
  const scheduledActions = (state.errands || [])
    .filter(action => action.date === displayDate && action.time)
    .map(action => ({ kind: 'action', item: action }));
  const actions = [...scheduledTasks, ...scheduledActions]
    .sort((a, b) => (a.item.time || '99:99').localeCompare(b.item.time || '99:99'));

  if (actions.length === 0) {
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

function getPriorityOrigin(item) {
  if (item.priorityOverride?.source === 'user' || item.prioritySource === 'user' || item.locked === true) {
    return { key: 'manual', label: t('priority.origin.manual') };
  }
  if (item.prioritySource === 'ai' || item.source === 'ai' || item.aiReasoning) {
    return { key: 'ai', label: t('priority.origin.ai') };
  }
  return { key: 'pending', label: t('priority.origin.pending') };
}

function getRetentionInfo(item) {
  const key = ['review', 'memory'].includes(item?.retention) ? item.retention : 'transient';
  return { key, label: t(`action.retention.${key}`) };
}

function renderTaskCard(task, date) {
  const priorityLevel = task.priority >= 75 ? 'high' : task.priority >= 50 ? 'mid' : 'low';
  const sourceLabel = task.source === 'manual' ? t('task.record.manual') : t('task.record.ai');
  const sourceClass = task.source === 'manual' ? 'manual' : '';
  const priorityOrigin = getPriorityOrigin(task);
  const resourceHtml = task.resource ? `<div class="task-resource">📖 ${task.resource}</div>` : '';
  const timingHint = task.manualLocked ? `<span class="locked-badge" title="${t('task.locked')}">✎</span>` : '';

  return `
    <div class="task-card${task.completed ? ' completed' : ''}" onclick="toggleTask('${escapeAttr(date)}', '${escapeAttr(task.id)}')">
      ${renderActionTime(task.time, task.duration, `editTaskTime('${escapeAttr(date)}', '${escapeAttr(task.id)}', '${escapeAttr(task.time)}', ${Number(task.duration) || 60})`)}
      <div class="task-body">
        <div class="task-title">${escapeHtml(translateTaskTitle(task.title))}</div>
        ${task.description ? `<div class="task-desc">${escapeHtml(task.description)}</div>` : ''}
        ${resourceHtml}
        <div class="task-footer">
          <div class="task-priority">
            <span class="task-source ${sourceClass}">${sourceLabel}</span>${timingHint}
            <span class="task-priority-origin ${priorityOrigin.key}">${priorityOrigin.label}</span>
            <button type="button" class="task-priority-score ${priorityOrigin.key}" onclick="event.stopPropagation();openPriorityModal('task','${escapeAttr(task.id)}','${escapeAttr(task.title)}',${task.priority})">${task.priority}${t('unit.pts')}</button>
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
  const priorityLabel = { must: t('errand.must'), should: t('errand.should'), nice: t('errand.nice') };
  const priorityOrigin = getPriorityOrigin(action);
  const retention = getRetentionInfo(action);
  return `
    <div class="task-card scheduled-action${action.completed ? ' completed' : ''}" onclick="toggleErrand('${escapeAttr(action.id)}')">
      ${renderActionTime(action.time, action.duration, `editActionTime('${escapeAttr(action.id)}', '${escapeAttr(action.time)}', ${Number(action.duration) || 60})`)}
      <div class="task-body">
        <div class="task-title">${escapeHtml(action.title)}</div>
        ${action.note ? `<div class="task-desc">${escapeHtml(action.note)}</div>` : ''}
        <div class="task-footer">
          <div class="task-priority">
            <span class="task-source manual">${priorityLabel[action.priority] || t('errand.should')}</span>
            <span class="task-priority-origin ${priorityOrigin.key}">${priorityOrigin.label}</span>
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

  container.innerHTML = items.map(x => renderGoalCard(x.item, x.type)).join('');
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

function renderGoalCard(item, type) {
  const priorityLevel = item.priority >= 75 ? 'high' : item.priority >= 50 ? 'mid' : 'low';
  const expanded = expandedGoals.has(item.id);
  const lockedHtml = item.locked ? 
    `<div class="lock-badge" onclick="event.stopPropagation();unlockPriority('${escapeAttr(type)}','${escapeAttr(item.id)}')" title="Click to unlock, AI will re-score">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="11" width="14" height="10" rx="2"/>
        <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
      </svg>
      <span>Locked</span>
    </div>` : '';
  
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

  return `
    <div class="goal-card${expanded ? ' expanded' : ''}${type === 'currentGoal' && item.overdue ? ' goal-overdue' : ''}${item.completed ? ' completed' : ''}">
      <div class="goal-row" onclick="toggleGoalExpand('${escapeAttr(type)}','${escapeAttr(item.id)}')">
        <span class="goal-caret">${expanded ? '▾' : '▸'}</span>
        <div class="goal-info">
          <div class="goal-title">${escapeHtml(item.title)} ${typeTag}</div>
          ${ddlHtml}
        </div>
        <div class="goal-priority">
          ${lockedHtml}
          <div class="priority-badge ${item.locked ? 'locked' : ''}" data-level="${priorityLevel}"
            onclick="event.stopPropagation();openPriorityModal('${escapeAttr(type)}','${escapeAttr(item.id)}','${escapeAttr(item.title)}',${item.priority})">
            ${item.priority}
          </div>
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
      ${expanded ? `<div class="goal-body">${descHtml}<div class="goal-derived">${renderDerivedForGoal(item, type)}</div></div>` : ''}
    </div>
  `;
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
  invalidateTodayBriefing();
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
  await postJson('/api/task/toggle', { date, taskId });
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
    : await postJson('/api/errand/update', { id: context.id, time: newTime, duration: newDuration });
  if (!result || result.success === false) return;
  closeTimeEditor();
  await refreshState();
  renderAll();
}

// ===== Interaction: Priority Adjustment =====
function openPriorityModal(type, id, name, currentPriority) {
  priorityModalContext = { type, id, name, currentPriority };
  document.getElementById('priority-target-name').textContent = name;
  document.getElementById('priority-slider').value = currentPriority;
  document.getElementById('priority-value-display').textContent = currentPriority;
  document.getElementById('priority-modal').style.display = '';
}

function closePriorityModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('priority-modal').style.display = 'none';
  priorityModalContext = null;
}

function updatePriorityDisplay(value) {
  document.getElementById('priority-value-display').textContent = value;
}

async function confirmPriority() {
  if (!priorityModalContext) return;
  const { type, id } = priorityModalContext;
  const priority = parseInt(document.getElementById('priority-slider').value);
  
  await postJson('/api/priority/update', { type, id, priority });
  closePriorityModal();
  await refreshState();
  renderAll();
}

async function unlockPriority(type, id) {
  await postJson('/api/priority/unlock', { type, id });
  await refreshState();
  renderAll();
}

// ===== Interaction: Manually Add Event =====
function showAddEventForm() {
  // Default date = today
  const today = formatDate(new Date());
  document.getElementById('event-date').value = today;
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
  const today = new Date(formatDate(new Date()));
  const eventDate = new Date(date);
  const diffDays = Math.round((eventDate - today) / (1000 * 60 * 60 * 24));
  currentDayOffset = diffDays;
  
  await refreshState();
  renderAll();
}

// ===== Day Navigation =====
function navigateDay(direction) {
  currentDayOffset += direction;
  renderFocusHero();
  renderBriefing();
  renderRelatedNotes();
  renderSchedule();
  renderErrands();
}

// ===== Calendar View =====
let calendarYear, calendarMonth;  // Currently displayed year and month

function openCalendar() {
  // Start from the currently viewed date
  const baseDate = getOffsetDate(currentDayOffset);
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
  currentDayOffset = 0;
  const today = new Date();
  calendarYear = today.getFullYear();
  calendarMonth = today.getMonth();
  renderCalendar();
  renderFocusHero();
  renderBriefing();
  renderSchedule();
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

  // Currently selected date
  const selectedDate = formatDate(getOffsetDate(currentDayOffset));
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
    const isSelected = dateStr === selectedDate;
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
  // Calculate offset
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
  currentDayOffset = diffDays;

  // Close calendar
  document.getElementById('calendar-modal').style.display = 'none';

  // Refresh briefing, schedule, and errands
  renderBriefing();
  renderSchedule();
  renderErrands();
}

// ===== Interaction: Manually Add Strategic Goal/Constraint =====
function showAddGoalForm(type) {
  goalModalType = type;
  document.getElementById('goal-modal-title').textContent = 
    type === 'strategicGoal' ? t('modal.goal.title.strategic') : t('modal.goal.title.constraint');
  document.getElementById('goal-title').value = '';
  document.getElementById('goal-desc').value = '';
  document.getElementById('goal-priority-slider').value = 50;
  document.getElementById('goal-priority-display').textContent = '50';
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
  const priority = parseInt(document.getElementById('goal-priority-slider').value);
  
  if (!title) {
    alert(t('alert.goalRequired'));
    return;
  }
  
  const result = await runAction('/api/goal/add', {
    type: goalModalType,
    title,
    description: desc,
    priority
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
  const priorityOrder = { must: 0, should: 1, nice: 2 };
  const unscheduledErrands = (state.errands || [])
    .filter(action => !action.time)
    .map(action => ({ kind: 'action', item: action, date: action.date || null }));
  const unscheduledTasks = Object.entries(state.schedule?.days || {}).flatMap(([date, day]) =>
    (day.tasks || []).filter(task => !task.time).map(task => ({ kind: 'task', item: task, date }))
  );
  const actions = [...unscheduledErrands, ...unscheduledTasks].sort((a, b) => {
    const aDone = a.item.completed ? 1 : 0;
    const bDone = b.item.completed ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const ap = a.kind === 'action' ? (priorityOrder[a.item.priority] ?? 1) : 1;
    const bp = b.kind === 'action' ? (priorityOrder[b.item.priority] ?? 1) : 1;
    if (ap !== bp) return ap - bp;
    return (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31');
  });
  dateEl.textContent = currentView === 'all' ? t('errand.all') : t('action.unscheduled');

  if (actions.length === 0) {
    container.innerHTML = '<div class="empty-state">' + t('empty.errands') + '</div>';
    return;
  }

  container.innerHTML = actions.map(action => action.kind === 'task'
    ? unscheduledTaskCardHtml(action.item, action.date)
    : errandCardHtml(action.item)).join('');
}

function getPendingReviews() {
  return (state.pendingReviews || []).filter(review => review && review.status === 'pending');
}

function renderPendingReviewBadge() {
  const pending = getPendingReviews();
  const button = document.getElementById('pending-review-button');
  const count = document.getElementById('pending-review-count');
  if (count) count.textContent = pending.length ? t('settings.pending', { n: pending.length }) : '';
  if (button) {
    button.classList.toggle('has-pending', pending.length > 0);
    button.setAttribute('aria-label', pending.length ? t('settings.pending', { n: pending.length }) : t('modal.review.title'));
  }
}

function openPendingReviewModal() {
  const modal = document.getElementById('pending-review-modal');
  const list = document.getElementById('pending-review-list');
  if (!modal || !list) return;
  const pending = getPendingReviews();
  if (!pending.length) {
    list.innerHTML = `<div class="empty-state">${t('modal.review.empty')}</div>`;
  } else {
    list.innerHTML = pending.map(review => {
      if (review.type === 'note_organization') {
        const source = (state.notes || []).find(note => note.id === review.noteId);
        const proposal = review.proposal || {};
        const conflicts = (proposal.conflicts || []).map(conflict => `<li>${escapeHtml(conflict)}</li>`).join('');
        return `<article class="review-card">
          <div class="review-card-kind">${t('review.organization')}</div>
          <div class="review-card-title">${escapeHtml(proposal.title || review.title || t('note.pendingTitle'))}</div>
          <div class="review-card-source">${escapeHtml(source?.content || t('note.contentMissing'))}</div>
          <div class="review-card-proposal">${escapeHtml(proposal.topic || '')} · ${escapeHtml(proposal.category || '')}</div>
          ${proposal.reason ? `<div class="review-card-reason">${escapeHtml(proposal.reason)}</div>` : ''}
          ${conflicts ? `<ul class="review-card-conflicts">${conflicts}</ul>` : ''}
          <div class="review-card-actions">
            <button class="modal-btn cancel" onclick="resolvePendingReview('${escapeAttr(review.id)}','reject')">${t('review.reject')}</button>
            <button class="modal-btn confirm" onclick="resolvePendingReview('${escapeAttr(review.id)}','accept')">${t('review.accept')}</button>
          </div>
        </article>`;
      }
      if (review.type === 'note_conflict') {
        const noteIds = review.noteIds || [];
        const notePreviews = noteIds.map(nid => {
          const n = (state.notes || []).find(note => note.id === nid);
          return n ? `<div class="review-note-preview"><strong>${escapeHtml(n.title || 'Note')}</strong><p>${escapeHtml((n.content || '').slice(0, 180))}${(n.content || '').length > 180 ? '...' : ''}</p></div>` : '';
        }).join('');
        return `<article class="review-card conflict">
          <div class="review-card-kind">${t('review.noteConflict') || '笔记矛盾'}</div>
          <div class="review-card-title">${escapeHtml(review.title || t('review.question'))}</div>
          <div class="review-card-source">${escapeHtml(review.description || '')}</div>
          ${review.reasoning ? `<div class="review-card-reason">${escapeHtml(review.reasoning)}</div>` : ''}
          ${notePreviews ? `<div class="review-note-previews">${notePreviews}</div>` : ''}
          <div class="review-card-actions">
            <button class="modal-btn cancel" onclick="resolvePendingReview('${escapeAttr(review.id)}','reject')">${t('review.ignore') || '忽略'}</button>
            <button class="modal-btn confirm" onclick="resolvePendingReview('${escapeAttr(review.id)}','accept')">${t('review.confirm') || '确认'}</button>
          </div>
        </article>`;
      }
      const options = (review.options || []).map(option => `<li>${escapeHtml(option)}</li>`).join('');
      return `<article class="review-card conflict">
        <div class="review-card-kind">${t('review.conflict')}</div>
        <div class="review-card-title">${escapeHtml(review.title || t('review.question'))}</div>
        <div class="review-card-source">${escapeHtml(review.question || '')}</div>
        ${options ? `<ul class="review-card-conflicts">${options}</ul>` : ''}
        <div class="review-card-actions"><button class="modal-btn confirm" onclick="resolvePendingReview('${escapeAttr(review.id)}','accept')">${t('review.done')}</button></div>
      </article>`;
    }).join('');
  }
  modal.style.display = '';
}

function closePendingReviewModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById('pending-review-modal');
  if (modal) modal.style.display = 'none';
}

async function resolvePendingReview(reviewId, decision) {
  const result = await runAction('/api/review/resolve', { reviewId, decision }, t('review.done'));
  if (!result) return;
  await refreshState();
  renderAll();
  openPendingReviewModal();
}

function errandCardHtml(e) {
  const priorityLabel = { must: t('errand.must'), should: t('errand.should'), nice: t('errand.nice') };
  const retention = getRetentionInfo(e);
  return `
    <div class="errand-card action-queue${e.completed ? ' completed' : ''}">
      <span class="errand-priority-tag ${e.priority}">${priorityLabel[e.priority] || t('errand.should')}</span>
      <div class="errand-info">
        <div class="errand-title">${escapeHtml(e.title)}</div>
        <div class="errand-meta">
          ${e.date ? escapeHtml(e.date) + ' · ' : ''}${t('action.unscheduled')} · <span class="task-retention ${retention.key}">${retention.label}</span>
          ${e.note ? ' · ' + escapeHtml(e.note) : ''}
        </div>
      </div>
      <div class="errand-actions">
        <button type="button" class="action-time-button" onclick="event.stopPropagation();editActionTime('${escapeAttr(e.id)}', '', ${Number(e.duration) || 60})">${t('action.scheduleTime')}</button>
        <div class="errand-checkbox ${e.completed ? 'checked' : ''}" onclick="event.stopPropagation();toggleErrand('${escapeAttr(e.id)}')" title="${e.completed ? t('errand.done') : t('errand.undo')}"></div>
        <div class="errand-delete-btn" onclick="event.stopPropagation();deleteErrand('${escapeAttr(e.id)}','${escapeAttr(e.title)}')" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </div>
      </div>
    </div>
  `;
}

function unscheduledTaskCardHtml(task, date) {
  return `
    <div class="errand-card action-queue${task.completed ? ' completed' : ''}">
      <span class="errand-priority-tag should">${t('action.task')}</span>
      <div class="errand-info">
        <div class="errand-title">${escapeHtml(translateTaskTitle(task.title))}</div>
        <div class="errand-meta">${escapeHtml(date)} · ${t('action.unscheduled')}</div>
      </div>
      <div class="errand-actions">
        <button type="button" class="action-time-button" onclick="event.stopPropagation();editTaskTime('${escapeAttr(date)}', '${escapeAttr(task.id)}', '', ${Number(task.duration) || 60})">${t('action.scheduleTime')}</button>
        <div class="errand-checkbox ${task.completed ? 'checked' : ''}" onclick="event.stopPropagation();toggleTask('${escapeAttr(date)}', '${escapeAttr(task.id)}')"></div>
      </div>
    </div>
  `;
}

// ===== Life Notes Rendering (topic-driven; six-domain model removed) =====
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
  document.querySelectorAll('.note-tab').forEach(tab => tab.classList.remove('active'));
  const targetTab = document.querySelector(`.note-tab[data-topic="${escapeAttr(topic)}"]`);
  if (targetTab) targetTab.classList.add('active');
  renderNotes();
}

// Build topic filter tabs dynamically from the notes themselves + known topics
function renderNoteTopicTabs() {
  const tabsEl = document.querySelector('#section-notes .note-tabs');
  if (!tabsEl) return;
  const notes = Array.isArray(state.notes) ? state.notes : [];
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
  const notes = Array.isArray(state.notes) ? state.notes.slice() : [];
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

  container.innerHTML = sorted.map(n => {
    const titleText = n.title || t('note.pendingTitle');
    const expanded = expandedNotes.has(n.id);
    const created = formatDateTime(n.createdAt);
    const when = formatNoteWhen(n); // user-specified occurrence time
    const whenHtml = when
      ? `<span class="note-when-tag" title="${t('note.when.tooltip')}">${escapeHtml(when)}</span>`
      : '';
    const topicBadge = n.topicId
      ? `<span class="related-note-topic">${escapeHtml(getTopicLabel(n.topicId))}</span>`
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
              <textarea id="note-edit-textarea-${escapeAttr(n.id)}" class="note-edit-textarea">${escapeHtml(n.content || '')}</textarea>
              <div class="note-edit-actions">
                <button class="note-save-btn" onclick="event.stopPropagation();saveEditNote('${escapeAttr(n.id)}')">${t('note.save') || '保存'}</button>
                <button class="note-cancel-btn" onclick="event.stopPropagation();cancelEditNote()">${t('note.cancel') || '取消'}</button>
              </div>
            </div>`;
          }
          return `<div class="note-content-full">
            <div class="note-content-text">${escapeHtml(n.content || t('note.contentMissing'))}</div>
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
        </div>
      </div>
    `;
  }).join('');
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

function startEditNote(noteId) {
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
  editingNoteId = null;
  await refreshState();
  renderNotes();
}

function toggleNoteExpand(id) {
  if (expandedNotes.has(id)) expandedNotes.delete(id);
  else expandedNotes.add(id);
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

// Legacy alias — kept for any external callers
async function addNoteFromForm() { openNoteModal(); }



function openNoteFromKnowledge(noteId) {
  showView('all');
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

// ===== Related Notes (mem.ai-style auto-push) =====
// Shows the most recent notes from the second brain, ordered by recency.
// When the AI calls zhigui_get_context, the relevant notes are pushed to the user
// via the conversation; this panel provides a visual snapshot.
function renderRelatedNotes() {
  const container = document.getElementById('related-notes-container');
  if (!container) return;
  const allNotes = Array.isArray(state.notes) ? state.notes.slice() : [];
  // Sort by recency (most recent first)
  allNotes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  // Show the 5 most recent notes
  const recent = allNotes.slice(0, 5);
  const meta = document.getElementById('related-notes-meta');
  if (meta) meta.textContent = recent.length > 0 ? `${recent.length} recent` : '';

  if (recent.length === 0) {
    container.innerHTML = '<div class="empty-state">' + (t('empty.relatedNotes') || 'No notes yet — the AI will auto-capture insights as you converse') + '</div>';
    return;
  }

  // Find topic labels for notes that have topicId
  const topicLabels = {};
  if (state.topicIndex) {
    for (const t of state.topicIndex) topicLabels[t.id] = t.label;
  }
  if (state.topics) {
    for (const t of state.topics) {
      topicLabels[t.id] = t.label;
    }
  }

  container.innerHTML = recent.map(n => {
    const time = n.relatedDate ? formatNoteWhen(n) : formatDateTime(n.createdAt);
    const timeTitle = n.relatedDate ? t('note.when.tooltip') : t('note.created.tooltip');
    const topicLabel = n.topicId && topicLabels[n.topicId] ? topicLabels[n.topicId] : '未分类';
    const topicBadge = `<span class="related-note-topic">${escapeHtml(topicLabel)}</span>`;
    return `<div class="related-note-card" onclick="showView('all'); setTimeout(() => toggleNoteExpand('${escapeAttr(n.id)}'), 0)">
      <div class="related-note-meta">${topicBadge} <span class="related-note-time" title="${timeTitle}">${escapeHtml(time)}</span></div>
      <div class="related-note-content">${escapeHtml(n.title || t('note.pendingTitle'))}</div>
    </div>`;
  }).join('');
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
  if (!confirm(t('confirm.deleteGoal', { title }))) return;
  const result = await runAction('/api/delete-goal', { type, id }, 'Goal deleted');
  if (!result) return;
  await refreshState();
  invalidateTodayBriefing();
  renderAll();
}

// ===== Interaction: Errand Management =====
async function toggleErrand(id) {
  const result = await runAction('/api/errand/complete', { id }, 'Errand updated');
  if (!result) return;
  await refreshState();
  renderAll();
}

function requestTaskDelete(date, id, title) {
  requestActionDelete('task', id, title, date);
}

function requestActionDelete(kind, id, title, date = '') {
  pendingActionDelete = { kind, id, title, date };
  const name = document.getElementById('action-delete-name');
  const modal = document.getElementById('action-delete-modal');
  if (name) name.textContent = title;
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
  const isTask = pending.kind === 'task';
  const result = await runAction(
    isTask ? '/api/task/delete' : '/api/errand/delete',
    isTask ? { date: pending.date, taskId: pending.id } : { id: pending.id },
    t('modal.actionDelete.btn'),
  );
  if (!result) return;
  closeActionDeleteModal();
  await refreshState();
  renderAll();
}

function deleteErrand(id, title) {
  requestActionDelete('errand', id, title);
}

// ===== Interaction: Delete Note (panel delete is non-cascade) =====
async function deleteNote(noteId, content) {
  if (!confirm(t('confirm.deleteNote'))) return;
  const result = await runAction('/api/note/delete', { noteId }, 'Note deleted');
  if (!result) return;
  await refreshState();
  renderAll();
}

function showAddErrandForm() {
  const today = formatDate(getOffsetDate(currentDayOffset));
  document.getElementById('errand-date').value = today;
  document.getElementById('errand-time').value = '';
  document.getElementById('errand-title').value = '';
  document.getElementById('errand-duration').value = '60';
  document.getElementById('errand-priority').value = 'should';
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
  const priority = document.getElementById('errand-priority').value;
  const note = document.getElementById('errand-note').value.trim();
  
  if (!title) {
    alert(t('alert.errandRequired'));
    return;
  }
  
  const result = await runAction('/api/errand/add', { title, date, time, duration, priority, note }, 'Errand added');
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
    return;
  }

  // Keep a global topic label cache for the Life Notes view
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

  // Group topics by category
  const grouped = new Map();
  for (const tp of data.topics) {
    const cat = tp.category || 'Other';
    if (activeFilter && cat !== activeFilter) continue;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(tp);
  }

  // Render grouped: Category header + topic cards
  let html = '';
  const unclassified = data.unclassifiedNotes || [];
  if (unclassified.length) {
    html += `<div class="topic-category-group unclassified-group">`;
    html += `<div class="topic-category-header"><span class="topic-category-name">${t('note.tab.unclassified')}</span><span class="topic-category-meta">${t('topic.unclassified.meta', { n: unclassified.length })}</span></div>`;
    html += `<div class="unclassified-note-list">${unclassified.map(note => `
      <button type="button" class="unclassified-note" onclick="openNoteFromKnowledge('${escapeAttr(note.id)}')">
        <span class="tree-caret">▸</span><span>${escapeHtml(note.title || t('note.pendingTitle'))}</span>
      </button>`).join('')}</div>`;
    html += `</div>`;
  }
  for (const [cat, topics] of grouped) {
    const totalNotes = topics.reduce((s, t) => s + (t.noteCount || 0), 0);
    html += `<div class="topic-category-group">`;
    html += `<div class="topic-category-header">`;
    html += `<span class="topic-category-name">${escapeHtml(cat)}</span>`;
    html += `<span class="topic-category-meta">${topics.length} topics · ${totalNotes} notes</span>`;
    html += `</div>`;
    topics.sort((a, b) => b.noteCount - a.noteCount);
    html += topics.map(topicCardHtml).join('');
    html += `</div>`;
  }
  container.innerHTML = html || '<div class="topics-empty">' + (t('topic.empty') || 'No topics') + '</div>';
}

function filterTopicsByCategory(cat) {
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

async function switchTopicTab(topicId, tab) {
  // Retained for backward compatibility; the containment tree no longer uses tabs.
  if (!topicDetailCache[topicId]) await loadTopicDetail(topicId);
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

  // —— 笔记 group (click a note → expand full content) ——
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
      return `<div class="tree-note" onclick="toggleTopicNote(this)">
        <div class="tree-note-heading">
          <span class="tree-caret">▸</span>
          <span class="tree-note-summary${n.needsEnrichment ? ' pending' : ''}">${escapeHtml(n.title || t('note.pendingTitle'))}</span>
        </div>
        <div class="tree-note-meta">${dom}${src}${dt}</div>
        <div class="tree-note-full">${escapeHtml(n.content || '')}</div>
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

function toggleTopicNote(el) {
  const full = el.querySelector('.tree-note-full');
  const caret = el.querySelector('.tree-caret');
  if (!full) return;
  const open = full.style.display !== 'block';
  full.style.display = open ? 'block' : 'none';
  if (caret) caret.textContent = open ? '▾' : '▸';
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
    return `<div class="kb-hit ${isTopicHit ? 'topic-hit' : ''}" onclick="kbHitClick('${escapeAttr(h.type)}','${escapeAttr(tid)}')"><span class="kb-hit-type">${typeMap[h.type] || h.type}</span>${escapeHtml((h.text || '').slice(0, 60))}${topicLabel}</div>`;
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

// Cascade delete topic and all its associations
async function requestTopicDelete(topicId, label) {
  pendingDeleteTopic = { id: topicId, label: label || '' };
  const preview = await apiPost('/api/topic/delete', { topicId, confirm: false });
  const nameEl = document.getElementById('topic-delete-name');
  const prevEl = document.getElementById('topic-delete-preview');
  if (nameEl) nameEl.textContent = `"${label}"`;
  if (prevEl) {
    if (preview && preview.counts) {
      const c = preview.counts;
      const items = [['goals', t('topic.rel.goals'), c.goals], ['actionItems', t('topic.rel.actionItems'), c.actionItems], ['decisions', t('topic.rel.decisions'), c.decisions], ['notes', t('topic.rel.notes'), c.notes]];
      let html = items.map(([k, l, n]) => `<div class="prev-item"><div class="prev-num">${n || 0}</div><div class="prev-label">${l}</div></div>`).join('');
      // Detailed cascade list (sample titles) so the user sees exactly what will be deleted
      const man = preview.manifest || {};
      const detailLines = [];
      const pushDetail = (arr, key) => {
        if (Array.isArray(arr) && arr.length) {
          const sample = arr.slice(0, 8).map(x => escapeHtml(x.title || x.content || x.id)).join('、');
          const more = arr.length > 8 ? ` …(+${arr.length - 8})` : '';
          detailLines.push(`<div class="prev-detail"><b>${t('topic.rel.' + key)}:</b> ${sample}${more}</div>`);
        }
      };
      pushDetail(man.goals, 'goals');
      pushDetail(man.actionItems, 'actionItems');
      pushDetail(man.notes, 'notes');
      pushDetail(man.decisions, 'decisions');
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
  showToast('Topic and related items deleted', 'success');
  const modal = document.getElementById('topic-delete-modal');
  if (modal) modal.style.display = 'none';
  pendingDeleteTopic = null;
  await refreshState();
  renderAll();
}

// ===== Startup =====
window.addEventListener('DOMContentLoaded', init);
