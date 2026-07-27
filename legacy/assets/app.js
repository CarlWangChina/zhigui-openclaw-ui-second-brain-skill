/* ====== 灵犀 Demo - 总行程整合规划 ====== */
(function () {
  'use strict';

  var state = {
    phase: 'idle',
    currentDay: 0,
    currentWeek: 0,
    demands: [],
    schedule: null,
    reminderOn: true,
    autoNextOn: true,
    reminderShown: {},
    dialogQueue: [],
    dialogIndex: 0,
    waitingForAnswer: false,
    authMode: 'login',
    currentUser: null,
    strategyGoals: [],    // 战略目标
    strategyConstraints: [] // 约束规则
  };

  var ZHS = {};
  var chatArea = document.getElementById('chatArea');
  var demandIdCounter = 0;
  var pendingQueue = []; // 收集过程中提交的需求，等待排队处理

  /* ====== 登录/注册 ====== */
  // 默认用户名为"灵犀"，不强制登录
  state.currentUser = '灵犀';

  ZHS.switchTab = function (tab) {
    var tabs = ['chat', 'goals', 'brain'];
    tabs.forEach(function (t) {
      var tabEl = document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1));
      var panelEl = document.getElementById('panel' + t.charAt(0).toUpperCase() + t.slice(1));
      if (tabEl && panelEl) {
        if (t === tab) {
          tabEl.classList.add('active');
          panelEl.classList.add('active');
        } else {
          tabEl.classList.remove('active');
          panelEl.classList.remove('active');
        }
      }
    });
  };

  /* ====== 战略目标管理 ====== */
  ZHS.addStrategyGoal = function (text, source) {
    var input = document.getElementById('strategyGoalInput');
    text = text || input.value.trim();
    if (!text) return;
    var priority = source === 'ai' ? autoPriorityForText(text) : 'auto';
    state.strategyGoals.push({ text: text, source: source || 'manual', priority: priority, expanded: false, detail: source === 'ai' ? '由 AI 分析生成，基于你的描述自动判断优先级' : '手动添加' });
    if (input) input.value = '';
    renderStrategyPanel();
  };

  ZHS.addConstraint = function (text, source) {
    var input = document.getElementById('strategyConstraintInput');
    text = text || input.value.trim();
    if (!text) return;
    var priority = source === 'ai' ? autoPriorityForText(text) : 'auto';
    state.strategyConstraints.push({ text: text, source: source || 'manual', priority: priority, expanded: false, detail: source === 'ai' ? '由 AI 分析生成，基于你的描述自动判断优先级' : '手动添加' });
    if (input) input.value = '';
    renderStrategyPanel();
  };

  function autoPriorityForText(text) {
    var t = text.toLowerCase();
    if (/紧急|立即|马上|本周|这周|deadline|ddl|考试|面试/.test(t)) return 'high';
    if (/重要|长期|今年|年度|目标/.test(t)) return 'mid';
    if (/偶尔|有时|如果|也许|考虑/.test(t)) return 'low';
    return 'mid';
  }

  ZHS.removeStrategyGoal = function (idx) {
    state.strategyGoals.splice(idx, 1);
    renderStrategyPanel();
  };

  ZHS.removeConstraint = function (idx) {
    state.strategyConstraints.splice(idx, 1);
    renderStrategyPanel();
  };

  ZHS.toggleStrategyExpand = function (type, idx) {
    var arr = type === 'goal' ? state.strategyGoals : state.strategyConstraints;
    if (arr[idx]) {
      arr[idx].expanded = !arr[idx].expanded;
      renderStrategyPanel();
    }
  };

  ZHS.cycleStrategyPriority = function (type, idx) {
    var arr = type === 'goal' ? state.strategyGoals : state.strategyConstraints;
    if (!arr[idx]) return;
    var cycle = ['auto', 'high', 'mid', 'low'];
    var current = arr[idx].priority || 'auto';
    var i = cycle.indexOf(current);
    arr[idx].priority = cycle[(i + 1) % cycle.length];
    renderStrategyPanel();
  };

  /* ====== 战略AI对话 ====== */
  ZHS.chatStrategy = function (type) {
    var inputId = type === 'goal' ? 'strategyChatInput' : 'strategyConstraintChatInput';
    var input = document.getElementById(inputId);
    var text = input.value.trim();
    if (!text) return;
    input.value = '';

    // 模拟 AI 分析过程
    setTimeout(function () {
      var analysis = analyzeStrategyText(text, type);
      analysis.forEach(function (item, i) {
        setTimeout(function () {
          if (type === 'goal') {
            ZHS.addStrategyGoal(item.text, 'ai');
          } else {
            ZHS.addConstraint(item.text, 'ai');
          }
        }, i * 300);
      });
    }, 500);
  };

  function analyzeStrategyText(text, type) {
    var goals = [];
    var subTasks = [];
    var constraints = [];
    var t = text.toLowerCase();

    if (type === 'goal') {
      // 只提取高层战略目标，子任务标记为行动项
      if (/考研|研究生/.test(t)) {
        goals.push({ text: '考研上岸' });
        subTasks.push('完成考研复习全书');
      }
      if (/python|数据分析|编程|代码|开发/.test(t)) {
        goals.push({ text: '掌握 Python 数据分析' });
        subTasks.push('完成 2 个实战项目');
      }
      if (/创业|startup|mvp/.test(t)) {
        goals.push({ text: '完成创业 MVP' });
      }
      if (/英语|四六级|雅思|托福/.test(t)) {
        goals.push({ text: '英语达到流利水平' });
      }
      if (/减肥|健身|运动/.test(t)) {
        goals.push({ text: '保持健康体魄' });
        subTasks.push('坚持每周运动 3 次');
      }
      if (goals.length === 0) {
        goals.push({ text: text });
      }
      return { goals: goals, subTasks: subTasks };
    } else {
      if (/熬夜|晚睡/.test(t)) {
        constraints.push({ text: '不熬夜，23点前睡觉' });
      }
      if (/恋爱|谈恋爱/.test(t)) {
        constraints.push({ text: '今年不谈恋爱' });
      }
      if (/休息|周末/.test(t)) {
        constraints.push({ text: '每周日休息' });
      }
      if (/游戏|刷手机|短视频|娱乐/.test(t)) {
        constraints.push({ text: '限制娱乐时间，每天不超过1小时' });
      }
      if (constraints.length === 0) {
        constraints.push({ text: text });
      }
      return { constraints: constraints };
    }
  }

  /* ====== 目标冲突分析 ====== */
  function analyzeGoalConflict(text) {
    var t = text.toLowerCase();
    var goals = [];
    var constraints = [];

    // 识别用户提到的目标
    if (/考研|研究生/.test(t)) goals.push({ name: '考研', timePerWeek: 40, deadline: '年底', priority: 'high' });
    if (/python|编程|数据分析/.test(t)) goals.push({ name: 'Python 数据分析', timePerWeek: 15, deadline: '2个月', priority: 'high' });
    if (/创业|startup|mvp/.test(t)) goals.push({ name: '创业 MVP', timePerWeek: 20, deadline: '3个月', priority: 'mid' });
    if (/健身|运动|减肥/.test(t)) goals.push({ name: '健身', timePerWeek: 6, deadline: '持续', priority: 'mid' });
    if (/英语|四六级|雅思/.test(t)) goals.push({ name: '英语提升', timePerWeek: 8, deadline: '半年', priority: 'low' });
    if (/读书|阅读/.test(t)) goals.push({ name: '阅读习惯', timePerWeek: 5, deadline: '持续', priority: 'low' });

    // 检查现有约束
    state.strategyConstraints.forEach(function (c) {
      if (/不熬夜|23点|睡眠/.test(c.text)) constraints.push('每天睡眠至少 7 小时');
      if (/周日休息/.test(c.text)) constraints.push('每周日不安排任务');
      if (/娱乐|游戏/.test(c.text)) constraints.push('每天娱乐不超过 1 小时');
    });

    var totalWeekly = goals.reduce(function (sum, g) { return sum + g.timePerWeek; }, 0);
    var availableWeekly = 7 * 24 - 7 * 8 - 7 * 2 - 7 * 1; // 减去睡眠+吃饭+通勤
    if (constraints.length > 0) {
      if (constraints.some(function (c) { return /周日/.test(c); })) availableWeekly -= 16; // 周日休息扣16h
      if (constraints.some(function (c) { return /睡眠/.test(c); })) availableWeekly -= 7; // 不熬夜扣1h/天
    }

    var msg = '<div class="advisor-msg">';
    msg += '<div class="advisor-label">🧠 目标冲突分析报告</div>';

    // 目标列表
    msg += '<strong>检测到 ' + goals.length + ' 个目标：</strong><br>';
    goals.forEach(function (g) {
      var pColor = g.priority === 'high' ? 'var(--accent)' : g.priority === 'mid' ? 'var(--gold)' : 'var(--muted)';
      msg += '• <span style="color:' + pColor + ';font-weight:600">' + g.name + '</span> — 每周约 ' + g.timePerWeek + 'h，截止 ' + g.deadline + '<br>';
    });

    // 时间预算
    msg += '<br><strong>⏱ 时间预算：</strong><br>';
    msg += '总需求：' + totalWeekly + 'h/周<br>';
    msg += '可用时间：' + availableWeekly + 'h/周<br>';

    if (totalWeekly > availableWeekly) {
      var overflow = totalWeekly - availableWeekly;
      msg += '<br>⚠️ <strong style="color:var(--danger)">冲突警告：超出 ' + overflow + 'h/周！</strong><br>';
      msg += 'AI 建议：<br>';

      // 按优先级排序建议
      var highGoals = goals.filter(function (g) { return g.priority === 'high'; });
      var midGoals = goals.filter(function (g) { return g.priority === 'mid'; });
      var lowGoals = goals.filter(function (g) { return g.priority === 'low'; });

      if (lowGoals.length > 0) {
        msg += '① 降低优先级：' + lowGoals.map(function (g) { return g.name; }).join('、') + ' 可延后或减少投入<br>';
      }
      if (midGoals.length > 0 && overflow > 20) {
        msg += '② 暂缓推进：' + midGoals.map(function (g) { return g.name; }).join('、') + ' 建议等高优先级完成后再启动<br>';
      }
      msg += '③ 聚焦核心：优先保证 ' + highGoals.map(function (g) { return g.name; }).join('、') + '<br>';
      msg += '④ 碎片时间：健身可拆为每天 30min，融入间隙<br>';
    } else {
      msg += '<br>✅ <strong style="color:var(--success)">时间充裕，可全部推进！</strong><br>';
      msg += '建议按优先级排序执行，高优先级目标投入更多时间。<br>';
    }

    // 约束影响
    if (constraints.length > 0) {
      msg += '<br><strong>📋 已考虑约束：</strong><br>';
      constraints.forEach(function (c) { msg += '• ' + c + '<br>'; });
    }

    msg += '<br>💡 已自动将高优先级目标加入战略大脑，低优先级目标降为「待评估」。可在「战略大脑」中调整。';
    msg += '</div>';

    // 自动将目标加入战略大脑
    highGoals.forEach(function (g) {
      var exists = state.strategyGoals.some(function (sg) { return sg.text === g.name; });
      if (!exists) ZHS.addStrategyGoal(g.name, 'ai');
    });
    lowGoals.forEach(function (g) {
      var exists = state.strategyGoals.some(function (sg) { return sg.text === g.name; });
      if (!exists) {
        var goal = { text: g.name, source: 'ai', priority: 'low', expanded: false, detail: '冲突分析中降级为低优先级' };
        state.strategyGoals.push(goal);
        renderStrategyPanel();
      }
    });

    return msg;
  }

  function renderStrategyPanel() {
    // 渲染战略目标
    var goalsHtml = '';
    if (state.strategyGoals.length === 0) {
      goalsHtml = '<span style="font-size:0.75rem;color:var(--muted);padding:0.5rem">暂无战略目标，手动添加或与 AI 对话</span>';
    }
    state.strategyGoals.forEach(function (g, i) {
      var priority = g.priority || 'auto';
      var priorityLabel = { high: '高', mid: '中', low: '低', auto: '自动' }[priority];
      var sourceLabel = g.source === 'ai' ? 'AI' : '手动';
      var sourceClass = g.source === 'ai' ? 'ai' : 'manual';
      goalsHtml += '<div class="strategy-item">';
      goalsHtml += '<span class="item-source ' + sourceClass + '">' + sourceLabel + '</span>';
      goalsHtml += '<span class="item-text">' + g.text + '</span>';
      goalsHtml += '<span class="priority-select ' + priority + '" onclick="event.stopPropagation();ZHS.cycleStrategyPriority(\'goal\',' + i + ')" title="点击切换优先级">' + priorityLabel + '</span>';
      goalsHtml += '<span class="del" onclick="event.stopPropagation();ZHS.removeStrategyGoal(' + i + ')">✕</span>';
      goalsHtml += '</div>';
    });
    document.getElementById('strategyGoals').innerHTML = goalsHtml;

    // 渲染约束规则
    var consHtml = '';
    if (state.strategyConstraints.length === 0) {
      consHtml = '<span style="font-size:0.75rem;color:var(--muted);padding:0.5rem">暂无约束规则，手动添加或在对话中告诉 AI</span>';
    }
    state.strategyConstraints.forEach(function (c, i) {
      var priority = c.priority || 'auto';
      var priorityLabel = { high: '高', mid: '中', low: '低', auto: '自动' }[priority];
      var sourceLabel = c.source === 'ai' ? 'AI' : '手动';
      var sourceClass = c.source === 'ai' ? 'ai' : 'manual';
      consHtml += '<div class="strategy-item">';
      consHtml += '<span class="item-source ' + sourceClass + '">' + sourceLabel + '</span>';
      consHtml += '<span class="item-text">' + c.text + '</span>';
      consHtml += '<span class="priority-select ' + priority + '" onclick="event.stopPropagation();ZHS.cycleStrategyPriority(\'constraint\',' + i + ')" title="点击切换优先级">' + priorityLabel + '</span>';
      consHtml += '<span class="del" onclick="event.stopPropagation();ZHS.removeConstraint(' + i + ')">✕</span>';
      consHtml += '</div>';
    });
    document.getElementById('strategyConstraints').innerHTML = consHtml;
  }

  /* ====== 战略冲突检查 ====== */
  function checkStrategyConflict(text) {
    var conflicts = [];
    var t = text.toLowerCase();

    state.strategyConstraints.forEach(function (c) {
      var ct = c.text.toLowerCase();
      if (/不|禁止|不能|不要|避免/.test(ct)) {
        var core = ct.replace(/不|禁止|不能|不要|避免/g, '').trim();
        if (core && t.includes(core)) {
          conflicts.push('与约束「' + c.text + '」冲突');
        }
      }
    });

    return conflicts;
  }

  /* ====== 战略契合度评分 ====== */
  function calcStrategyAlignment(text) {
    var t = text.toLowerCase();
    var score = 0;
    state.strategyGoals.forEach(function (g) {
      var gt = g.text.toLowerCase();
      var keywords = gt.split(/[\s/、，,]+/).filter(function (k) { return k.length > 1; });
      keywords.forEach(function (kw) {
        if (t.includes(kw)) {
          // 优先级高的目标权重更大
          var weight = g.priority === 'high' ? 40 : g.priority === 'mid' ? 30 : g.priority === 'low' ? 15 : 25;
          score += weight;
        }
      });
    });
    return Math.min(score, 100);
  }

  /* ====== AI 顾问建议 ====== */
  function generateAdvisorMessage(text, type) {
    var conflicts = checkStrategyConflict(text);
    var alignment = calcStrategyAlignment(text);

    var msg = '<div class="advisor-msg">';
    msg += '<div class="advisor-label">🧠 AI 顾问分析</div>';

    // 冲突检查
    if (conflicts.length > 0) {
      msg += '⚠️ <strong>检测到冲突：</strong>' + conflicts.join('；') + '<br>';
      msg += '建议：请重新评估此需求，或调整约束规则。<br>';
    }

    // 战略契合度
    if (state.strategyGoals.length > 0) {
      if (alignment >= 60) {
        msg += '✅ 与战略目标高度契合（' + alignment + '%），建议优先推进。<br>';
      } else if (alignment >= 30) {
        msg += '⚡ 部分契合战略目标（' + alignment + '%），可适度投入。<br>';
      } else if (alignment > 0) {
        msg += '🔹 弱关联战略目标（' + alignment + '%），建议利用碎片时间。<br>';
      } else {
        msg += '📌 未匹配到现有战略目标，可前往「战略大脑」设定目标。<br>';
      }
    } else {
      msg += '📌 暂无战略目标，可前往「战略大脑」设定。<br>';
    }

    msg += '</div>';
    return msg;
  }

  /* ====== 性价比评分 ====== */
  function calcPriorityScore(block, dayIndex, totalDays) {
    var urgency = 0;      // 紧急度
    var alignment = 0;    // 战略契合度
    var score = 0;

    // 紧急度：越靠前越紧急
    if (dayIndex < 7) urgency = 80 + (7 - dayIndex) * 2;
    else if (dayIndex < 30) urgency = 50;
    else urgency = 30;

    // 事件类任务（航班、会议）紧急度高
    if (block.type === 'event') urgency = Math.min(urgency + 30, 100);

    // 检查是否有用户手动设置的优先级
    var userOverride = null;
    var blockText = (block.title + ' ' + (block.detail || '')).toLowerCase();
    state.demands.forEach(function (d) {
      if (d.userPriority) {
        var demandText = d.text.toLowerCase();
        // 检查关键词重叠
        var keywords = demandText.split(/[\s,，、]+/).filter(function (k) { return k.length > 1; });
        var matched = keywords.some(function (kw) { return blockText.includes(kw); });
        if (matched) userOverride = d.userPriority;
      }
    });

    if (userOverride === 'high') return { level: 'high', label: '高性价比', score: 90, userSet: true };
    if (userOverride === 'mid') return { level: 'mid', label: '中性价比', score: 55, userSet: true };
    if (userOverride === 'low') return { level: 'low', label: '低优先级', score: 20, userSet: true };

    // 战略契合度
    if (block.title) {
      alignment = calcStrategyAlignment(block.title + ' ' + (block.detail || ''));
    }

    // 综合评分 = 紧急度 * 0.6 + 战略契合度 * 0.4
    score = Math.round(urgency * 0.6 + alignment * 0.4);

    if (score >= 70) return { level: 'high', label: '高性价比', score: score };
    if (score >= 40) return { level: 'mid', label: '中性价比', score: score };
    return { level: 'low', label: '低优先级', score: score };
  }

  ZHS.showAuth = function () {
    document.getElementById('authOverlay').style.display = 'flex';
    document.getElementById('authUsername').focus();
  };

  ZHS.hideAuth = function () {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('authUsername').value = '';
    document.getElementById('authPassword').value = '';
  };

  ZHS.toggleAuthMode = function () {
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    document.getElementById('authTitle').textContent = state.authMode === 'login' ? '登录' : '注册';
    document.getElementById('authBtn').textContent = state.authMode === 'login' ? '登录' : '注册';
    document.getElementById('authSwitch').innerHTML = state.authMode === 'login'
      ? '还没有账号？<span onclick="ZHS.toggleAuthMode()">立即注册</span>'
      : '已有账号？<span onclick="ZHS.toggleAuthMode()">立即登录</span>';
  };

  ZHS.handleAuth = function () {
    var username = document.getElementById('authUsername').value.trim();
    var password = document.getElementById('authPassword').value.trim();
    if (!username || !password) {
      showToast('请填写用户名和密码');
      return;
    }

    if (state.authMode === 'register') {
      var users = JSON.parse(localStorage.getItem('zhs_users') || '{}');
      if (users[username]) {
        showToast('用户名已存在');
        return;
      }
      users[username] = { password: password, created: Date.now() };
      localStorage.setItem('zhs_users', JSON.stringify(users));
      showToast('注册成功，请登录');
      ZHS.toggleAuthMode();
      return;
    }

    var users = JSON.parse(localStorage.getItem('zhs_users') || '{}');
    if (!users[username] || users[username].password !== password) {
      showToast('用户名或密码错误');
      return;
    }

    state.currentUser = username;
    localStorage.setItem('zhs_current_user', username);
    ZHS.hideAuth();
    document.getElementById('userInfo').style.display = 'flex';
    document.getElementById('userName').textContent = username;
    document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();
    document.getElementById('loginBtn').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'inline-flex';
    showToast('欢迎回来，' + username);
  };

  ZHS.logout = function () {
    state.currentUser = '灵犀';
    localStorage.removeItem('zhs_current_user');
    document.getElementById('userName').textContent = '灵犀';
    document.getElementById('userAvatar').textContent = '智';
    document.getElementById('loginBtn').style.display = 'inline-flex';
    document.getElementById('logoutBtn').style.display = 'none';
    showToast('已退出登录');
  };

  // 检查是否已登录（有保存的用户则自动登录）
  var savedUser = localStorage.getItem('zhs_current_user');
  if (savedUser) {
    var users = JSON.parse(localStorage.getItem('zhs_users') || '{}');
    if (users[savedUser]) {
      state.currentUser = savedUser;
      document.getElementById('userName').textContent = savedUser;
      document.getElementById('userAvatar').textContent = savedUser.charAt(0).toUpperCase();
      document.getElementById('loginBtn').style.display = 'none';
      document.getElementById('logoutBtn').style.display = 'inline-flex';
    }
  }

  function classifyDemand(text) {
    var t = text.toLowerCase();
    // 目标冲突检测
    if (/同时.*和|同时.*跟|时间够吗|时间来得及|冲突|兼顾/.test(t)) return 'conflict';
    // 战略目标/约束检测
    if (/我的目标是|年度目标|战略目标|今年要|我想达到|长期目标/.test(t)) return 'strategy_goal';
    if (/我的原则|约束|不能|不许|禁止|坚持不|绝不|每年.*不|每周.*不|每天.*不/.test(t)) return 'strategy_constraint';
    if (/飞机|航班|机票|机场|飞行|出差.*飞|去.*飞/.test(t)) return 'flight';
    if (/学会|学习|掌握|目标|计划|备考|考试|考证/.test(t)) return 'goal';
    if (/调整|修改|移到|改到|提前|延后|取消/.test(t)) return 'modify';
    if (/会议|课|活动|聚餐|约会|面试|比赛/.test(t)) return 'event';
    return 'goal';
  }

  function extractDaysFromDemand(text, type) {
    if (type === 'flight') return 0;
    var match = text.match(/(\d+)\s*天/);
    if (match) return parseInt(match[1]);
    match = text.match(/(\d+)\s*周/);
    if (match) return parseInt(match[1]) * 7;
    match = text.match(/(\d+)\s*个月/);
    if (match) return parseInt(match[1]) * 30;
    if (/两\s*个月/.test(text)) return 60;
    if (/一\s*个月/.test(text)) return 30;
    return 21;
  }

  /* ====== 自动搜索学习资源 ====== */
  function searchResourcesForDemand(demand) {
    var text = demand.text.toLowerCase();
    var resources = [];

    if (/python|数据分析|data|pandas|numpy/.test(text)) {
      resources = [
        { title: 'Python 官方文档 - Tutorial', source: 'python.org', type: '文档' },
        { title: 'Pandas 入门教程（10分钟上手）', source: 'pandas.pydata.org', type: '教程' },
        { title: 'NumPy 用户指南', source: 'numpy.org', type: '文档' },
        { title: 'Matplotlib 可视化教程', source: 'matplotlib.org', type: '教程' },
        { title: 'Kaggle - Python 数据分析实战', source: 'kaggle.com', type: '实战' },
        { title: 'B站 - Python数据分析从入门到精通', source: 'bilibili.com', type: '视频' }
      ];
    } else if (/英语|四六级|雅思|托福|cet/.test(text)) {
      resources = [
        { title: '新概念英语 1-4 册', source: '外研社', type: '教材' },
        { title: '每日英语听力 APP', source: '每日英语', type: 'App' },
        { title: 'BBC Learning English', source: 'bbc.co.uk', type: '网站' },
        { title: '剑桥雅思真题 4-18', source: 'Cambridge', type: '真题' },
        { title: '墨墨背单词 - 雅思核心词汇', source: 'momo.com', type: 'App' }
      ];
    } else if (/考研|研究生|gre|gmat/.test(text)) {
      resources = [
        { title: '考研数学复习全书', source: '李永乐', type: '教材' },
        { title: '考研英语红宝书', source: '新东方', type: '词汇' },
        { title: '肖秀荣政治精讲精练', source: '肖秀荣', type: '教材' },
        { title: '历年考研真题解析', source: '教育部', type: '真题' }
      ];
    } else if (/前端|html|css|javascript|react|vue/.test(text)) {
      resources = [
        { title: 'MDN Web 文档', source: 'developer.mozilla.org', type: '文档' },
        { title: 'freeCodeCamp 前端课程', source: 'freecodecamp.org', type: '课程' },
        { title: 'Vue.js 官方教程', source: 'vuejs.org', type: '文档' },
        { title: 'React 官方文档', source: 'react.dev', type: '文档' },
        { title: 'CSS-Tricks 布局指南', source: 'css-tricks.com', type: '教程' }
      ];
    } else if (/java|spring|后端/.test(text)) {
      resources = [
        { title: 'Java 核心技术 卷 I', source: 'Cay Horstmann', type: '教材' },
        { title: 'Spring Boot 官方文档', source: 'spring.io', type: '文档' },
        { title: 'LeetCode Java 题解', source: 'leetcode.com', type: '练习' },
        { title: 'B站 - Java 从入门到实战', source: 'bilibili.com', type: '视频' }
      ];
    } else if (/设计|ps|photoshop|ui|figma/.test(text)) {
      resources = [
        { title: 'Figma 官方教程', source: 'figma.com', type: '教程' },
        { title: '设计心理学', source: 'Don Norman', type: '书籍' },
        { title: 'Dribbble 设计灵感', source: 'dribbble.com', type: '灵感' },
        { title: '站酷 - UI设计入门', source: 'zcool.com.cn', type: '教程' }
      ];
    } else {
      resources = [
        { title: '相关领域入门指南', source: 'zhihu.com', type: '文章' },
        { title: 'B站 系统教程合集', source: 'bilibili.com', type: '视频' },
        { title: 'Coursera 在线课程', source: 'coursera.org', type: '课程' },
        { title: 'GitHub 开源项目参考', source: 'github.com', type: '项目' }
      ];
    }

    return resources;
  }

  /* ====== 提取航班信息 ====== */
  function extractFlightInfo(text) {
    var info = { airline: '', flightNo: '', airport: '', time: '', date: '' };
    // 提取航班号
    var flightMatch = text.match(/([A-Z]{2}\d{3,4})/);
    if (flightMatch) info.flightNo = flightMatch[1];
    // 提取时间
    var timeMatch = text.match(/(\d{1,2})[点时:：](\d{0,2})/);
    if (timeMatch) info.time = timeMatch[1] + ':' + (timeMatch[2] || '00');
    // 提取机场/目的地
    var airportKeywords = ['首都机场', '大兴机场', '浦东机场', '虹桥机场', '白云机场', '宝安机场', '天府机场', '双流机场', '萧山机场', '长乐机场'];
    for (var i = 0; i < airportKeywords.length; i++) {
      if (text.includes(airportKeywords[i])) {
        info.airport = airportKeywords[i];
        break;
      }
    }
    // 如果没提取到具体机场，尝试从"飞XX"提取目的地城市
    if (!info.airport) {
      var destMatch = text.match(/飞(\S{2,4})/);
      if (destMatch) {
        var cityAirports = {
          '北京': '首都机场', '上海': '浦东机场', '广州': '白云机场',
          '深圳': '宝安机场', '成都': '天府机场', '重庆': '江北机场',
          '杭州': '萧山机场', '西安': '咸阳机场', '昆明': '长水机场',
          '南京': '禄口机场', '武汉': '天河机场', '长沙': '黄花机场',
          '厦门': '高崎机场', '青岛': '胶东机场', '大连': '周水子机场',
          '三亚': '凤凰机场', '海口': '美兰机场'
        };
        info.airport = cityAirports[destMatch[1]] || '';
        if (info.airport) info.destCity = destMatch[1];
      }
    }
    // 提取日期关键词
    if (/明天/.test(text)) info.date = '明天';
    else if (/后天/.test(text)) info.date = '后天';
    else if (/大后天/.test(text)) info.date = '大后天';
    else if (/下周/.test(text)) info.date = '下周';
    else info.date = '今天';
    return info;
  }

  /* ====== 搜索航班静态资源（不依赖用户回答） ====== */
  function searchFlightStaticResources(demand) {
    var info = extractFlightInfo(demand.text);
    var resources = [];
    var airport = info.airport || (info.destCity ? info.destCity + '机场' : '目标机场');
    resources.push({ title: airport + ' 航站楼/登机口分布图', source: airport + '官网', type: '信息' });
    resources.push({ title: airport + ' 值机/安检/登机全流程指南', source: '航旅纵横', type: '攻略' });
    if (info.flightNo) {
      resources.push({ title: info.flightNo + ' 航班实时动态查询', source: '飞常准', type: '动态' });
    }
    return resources;
  }

  /* ====== 搜索航班路线资源（依赖用户回答后调用） ====== */
  function searchFlightRouteResources(demand) {
    var answers = demand.answers || {};
    var info = extractFlightInfo(demand.text);
    var resources = [];
    var airport = answers.airport || info.airport || (info.destCity ? info.destCity + '机场' : '机场');
    var transport = answers.transport || '';
    var location = answers.departLocation || '';

    if (location && transport) {
      resources.push({ title: '高德地图：' + location + ' → ' + airport + ' · ' + transport + '路线', source: 'amap.com', type: '导航' });
    } else if (location) {
      resources.push({ title: '高德地图：' + location + ' → ' + airport + ' 路线', source: 'amap.com', type: '导航' });
    }
    if (transport) {
      resources.push({ title: airport + ' · ' + transport + '乘车指南', source: '高德地图', type: '交通' });
    }
    return resources;
  }

  /* ====== 展示智能推荐路线结果 ====== */
  function showRouteRecommendations(demand) {
    var answers = demand.answers || {};
    var info = extractFlightInfo(demand.text);
    var airport = answers.airport || info.airport || (info.destCity ? info.destCity + '机场' : '机场');
    var location = answers.departLocation || '';

    var msg = '为你找到以下路线方案：<br>';
    var recs = [
      { mode: '打车', time: '约40分钟', cost: '¥80-120', best: true },
      { mode: '地铁', time: '约50分钟', cost: '¥8-12', best: false },
      { mode: '机场大巴', time: '约70分钟', cost: '¥25', best: false }
    ];
    recs.forEach(function (r, i) {
      var badge = r.best ? ' <span style="color:var(--accent);font-weight:600">[推荐]</span>' : '';
      msg += (i + 1) + '. <strong>' + r.mode + '</strong>：' + r.time + '，' + r.cost + badge + '<br>';
    });
    msg += '<br>推荐方案：<strong>打车</strong>，用时最短。';
    addSystemMessage(msg);
  }

  function unskipStep(key, demandId) {
    state.dialogQueue.forEach(function (step) {
      if (step.key === key && step.demandId === demandId) {
        step.skip = false;
      }
    });
  }

  function generateQuestionsForDemand(demand) {
    var questions = [];
    var type = demand.type;
    var text = demand.text;

    if (type === 'goal') {
      questions.push({ ai: '关于「' + text.substring(0, 18) + '...」，你目前有基础吗？', key: 'level' });
      questions.push({ ai: '每天能投入多少时间？', key: 'hours' });
      questions.push({ ai: '偏好哪个时段学习？', key: 'period' });
      if (/项目|作品|简历/.test(text)) {
        questions.push({ ai: '希望最终产出什么？', key: 'outcome' });
      }
    } else if (type === 'flight') {
      var info = extractFlightInfo(text);
      var hasTime = info.time;
      var hasAirport = info.airport;
      var hasFlightNo = info.flightNo;

      questions.push({ ai: '你当前所在的位置是哪里？（如：XX区XX路）', key: 'departLocation' });
      if (!hasAirport) {
        questions.push({ ai: '目的地是哪个机场？', key: 'airport' });
      }
      if (!hasFlightNo) {
        questions.push({ ai: '航班号是多少？', key: 'flightNo' });
      }
      if (!hasTime) {
        questions.push({ ai: '航班大概几点起飞？', key: 'flightTime' });
      }
      // 路线规划方式选择
      questions.push({ ai: '你希望我怎么帮你规划路线？回复数字选择：<br>1. 智能推荐 - 我帮你搜索最快路线<br>2. 自主选择 - 你告诉我怎么过去', key: 'routeMode' });
      // 条件问题：根据 routeMode 回答动态显示
      questions.push({ ai: '你打算怎么去机场？（地铁/打车/自驾/机场大巴）', key: 'transport', skip: true });
      questions.push({ ai: '是否接受推荐方案（打车）？回复「是」接受，或回复具体交通方式（地铁/打车/自驾/机场大巴）', key: 'acceptRoute', skip: true });
      questions.push({ ai: '需要提前多久到机场办理手续？', key: 'arriveEarly' });
    } else if (type === 'event') {
      var hasTime = /\d{1,2}[点时:：]/.test(text);
      var hasDuration = /小时|分钟|半小时/.test(text);
      if (!hasTime) {
        questions.push({ ai: '事件大概在什么时间？', key: 'timePeriod' });
      }
      if (!hasDuration) {
        questions.push({ ai: '预计持续多久？', key: 'duration' });
      }
      questions.push({ ai: '每周固定还是一次性？', key: 'frequency' });
    } else if (type === 'modify') {
      questions.push({ ai: '具体想怎么调整？', key: 'adjustType' });
    }

    return questions;
  }

  /* ====== 对话渲染 ====== */
  function addAiMessage(text, key) {
    var msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg ai';
    msgDiv.innerHTML = '<div class="chat-bubble"><span class="sender">灵犀</span>' + text + '</div>';
    chatArea.appendChild(msgDiv);
    chatArea.scrollTop = chatArea.scrollHeight;

    state.waitingForAnswer = true;
    state.currentQuestionKey = key;
    document.getElementById('chatInputBar').style.display = 'flex';
    document.getElementById('chatInput').focus();
  }

  function addUserMessage(text) {
    var msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg user';
    msgDiv.innerHTML = '<div class="chat-bubble"><span class="sender">你</span>' + text + '</div>';
    chatArea.appendChild(msgDiv);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function addSystemMessage(text) {
    var msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg ai';
    msgDiv.innerHTML = '<div class="chat-bubble"><span class="sender">灵犀</span>' + text + '</div>';
    chatArea.appendChild(msgDiv);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  /* ====== 运行对话队列 ====== */
  function runDialogQueue() {
    // 跳过标记为 skip 的条件问题
    while (state.dialogIndex < state.dialogQueue.length && state.dialogQueue[state.dialogIndex].skip) {
      state.dialogIndex++;
    }

    if (state.dialogIndex >= state.dialogQueue.length) {
      finishCollecting();
      return;
    }
    var step = state.dialogQueue[state.dialogIndex];
    setTimeout(function () {
      if (step.ai.startsWith('---')) {
        // 分隔线消息：直接显示，不等待回答
        addSystemMessage(step.ai);
        state.dialogIndex++;
        runDialogQueue();
      } else if (step.isSystem) {
        // 系统消息（如"信息收集完毕"）：直接显示，不等待回答，继续队列
        addSystemMessage(step.ai);
        state.dialogIndex++;
        runDialogQueue();
      } else {
        // 真正的问题：等待用户回答
        addAiMessage(step.ai, step.key);
        state.dialogIndex++;
      }
    }, step.delay || 500);
  }

  /* ====== 统一输入入口：回答 AI 问题 或 提交新需求 ====== */
  ZHS.fillExample = function (type) {
    var examples = {
      python: '我想两个月学会 Python 数据分析',
      flight: '后天下午飞北京，航班 CA1234，14:00 起飞',
      goal: '我的目标是今年考研上岸，同时掌握 Python 编程',
      constraint: '我的原则是不熬夜，每周日休息，限制娱乐时间',
      conflict: '我想同时考研、学Python、创业、健身，时间够吗？'
    };
    var input = document.getElementById('chatInput');
    input.value = examples[type] || '';
    input.focus();
  };

  ZHS.copyExample = function (text, el) {
    var input = document.getElementById('chatInput');
    input.value = text;
    input.focus();

    // 尝试复制到剪贴板
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(function () {});
    }

    // 视觉反馈
    if (el) {
      el.classList.add('copied');
      var hint = el.querySelector('.copy-hint');
      if (hint) {
        var origText = hint.textContent;
        hint.textContent = '已复制到输入框';
        setTimeout(function () {
          el.classList.remove('copied');
          hint.textContent = origText;
        }, 1500);
      }
    }
  };

  ZHS.toggleGuide = function () {
    var el = document.getElementById('guideFloat');
    var toggle = document.getElementById('guideToggle');
    if (el.classList.contains('collapsed')) {
      el.classList.remove('collapsed');
      toggle.textContent = '收起 ▾';
    } else {
      el.classList.add('collapsed');
      toggle.textContent = '展开 ▸';
    }
  };

  ZHS.submitAnswer = function () {
    var input = document.getElementById('chatInput');
    var text = input.value.trim();
    if (!text) return;

    // 如果 AI 没在提问，当作新需求提交
    if (!state.waitingForAnswer) {
      input.value = '';
      document.getElementById('demandInput').value = text;
      ZHS.submitDemand();
      return;
    }

    state.waitingForAnswer = false;
    input.value = '';

    var currentStep = state.dialogQueue[state.dialogIndex - 1];
    if (currentStep && currentStep.demandId) {
      var demand = state.demands.find(function (d) { return d.id === currentStep.demandId; });
      if (demand) {
        demand.answers[currentStep.key] = text;
      }
    }

    addUserMessage(text);

    // 航班路线模式处理：根据用户选择展示不同后续
    if (currentStep && currentStep.key === 'routeMode' && currentStep.demandId) {
      var demand = state.demands.find(function (d) { return d.id === currentStep.demandId; });
      if (demand) {
        if (/1|推荐|智能/.test(text)) {
          // 智能推荐模式
          var info = extractFlightInfo(demand.text);
          var airport = demand.answers.airport || info.airport || (info.destCity ? info.destCity + '机场' : '机场');
          var location = demand.answers.departLocation || '';
          if (location) {
            addSystemMessage('🔍 正在搜索从「' + location + '」到「' + airport + '」的最快路线...');
          } else {
            addSystemMessage('🔍 正在搜索到「' + airport + '」的最快路线...');
          }
          setTimeout(function () {
            showRouteRecommendations(demand);
            demand.answers.transport = '打车'; // 默认推荐
            unskipStep('acceptRoute', demand.id);
            runDialogQueue();
          }, 800);
          return;
        } else {
          // 自主选择模式
          addSystemMessage('好的，请自主选择交通方式。');
          unskipStep('transport', demand.id);
          setTimeout(runDialogQueue, 300);
          return;
        }
      }
    }

    // 接受推荐处理：用户可能接受或选择其他交通方式
    if (currentStep && currentStep.key === 'acceptRoute' && currentStep.demandId) {
      var demand = state.demands.find(function (d) { return d.id === currentStep.demandId; });
      if (demand) {
        if (/是|同意|接受|好|可以/.test(text)) {
          // 接受推荐，transport 已设为"打车"
          addSystemMessage('✅ 已选择推荐方案：打车。');
        } else if (/地铁/.test(text)) {
          demand.answers.transport = '地铁';
          addSystemMessage('✅ 已切换为地铁方案。');
        } else if (/打车|滴滴|出租/.test(text)) {
          demand.answers.transport = '打车';
          addSystemMessage('✅ 已切换为打车方案。');
        } else if (/自驾/.test(text)) {
          demand.answers.transport = '自驾';
          addSystemMessage('✅ 已切换为自驾方案。');
        } else if (/大巴/.test(text)) {
          demand.answers.transport = '机场大巴';
          addSystemMessage('✅ 已切换为机场大巴方案。');
        }
      }
    }

    setTimeout(runDialogQueue, 300);
  };

  /* ====== 提交需求 ====== */
  ZHS.submitDemand = function () {
    var input = document.getElementById('demandInput');
    var text = input.value.trim();
    if (!text) return;

    var type = classifyDemand(text);

    // 目标冲突分析
    if (type === 'conflict') {
      input.value = '';
      addUserMessage(text);
      addSystemMessage('🧠 AI 正在分析目标冲突...');
      setTimeout(function () {
        var analysis = analyzeGoalConflict(text);
        addSystemMessage(analysis);
      }, 800);
      return;
    }

    // 战略目标/约束：直接处理，不走对话队列
    if (type === 'strategy_goal' || type === 'strategy_constraint') {
      input.value = '';
      addUserMessage(text);
      var strategyType = type === 'strategy_goal' ? 'goal' : 'constraint';
      addSystemMessage('🧠 AI 正在分析你的' + (strategyType === 'goal' ? '战略目标' : '约束原则') + '...');
      setTimeout(function () {
        var analysis = analyzeStrategyText(text, strategyType);
        var mainItems = strategyType === 'goal' ? analysis.goals : analysis.constraints;
        var subTasks = analysis.subTasks || [];

        // 添加战略目标/约束
        mainItems.forEach(function (item, i) {
          setTimeout(function () {
            if (strategyType === 'goal') {
              ZHS.addStrategyGoal(item.text, 'ai');
            } else {
              ZHS.addConstraint(item.text, 'ai');
            }
          }, i * 300);
        });

        // 子任务加入需求列表（作为待安排行动项）
        subTasks.forEach(function (task, i) {
          setTimeout(function () {
            var taskDemand = {
              id: ++demandIdCounter,
              type: 'goal',
              text: task,
              days: extractDaysFromDemand(task, 'goal'),
              answers: {},
              questions: [],
              fromStrategy: true
            };
            state.demands.push(taskDemand);
            renderDemandList();
          }, (mainItems.length + i) * 300);
        });

        setTimeout(function () {
          var msg = '✅ 已提取 ' + mainItems.length + ' 条' + (strategyType === 'goal' ? '战略目标' : '约束原则');
          if (subTasks.length > 0) {
            msg += '，' + subTasks.length + ' 条行动任务已加入「现有目标」并自动生成行程';
          }
          msg += '。可在「战略大脑」中查看和调整优先级。';
          addSystemMessage(msg);

          // 如果有子任务加入需求列表，自动生成行程
          if (subTasks.length > 0 && state.phase === 'idle') {
            setTimeout(function () {
              ZHS.generateSchedule();
            }, 500);
          }
        }, (mainItems.length + subTasks.length) * 300 + 200);
      }, 600);
      return;
    }

    // 如果当前正在收集信息，排队等待处理
    if (state.phase !== 'idle') {
      var pendingDemand = {
        id: ++demandIdCounter,
        type: type,
        text: text,
        days: extractDaysFromDemand(text, type),
        answers: {},
        questions: [],
        pending: true
      };
      state.demands.push(pendingDemand);
      pendingQueue.push(pendingDemand);
      renderDemandList();
      input.value = '';
      addUserMessage(text);
      var typeNames = { goal: '学习目标', event: '日程事件', modify: '调整需求', flight: '航班出行', strategy_goal: '战略目标', strategy_constraint: '约束原则', conflict: '冲突分析' };
      addSystemMessage('📋 已记录' + typeNames[type] + '，将在当前信息收集完成后自动处理。');
      // AI 顾问分析
      setTimeout(function () {
        addSystemMessage(generateAdvisorMessage(text, type));
      }, 400);
      return;
    }

    var demand = {
      id: ++demandIdCounter,
      type: type,
      text: text,
      days: extractDaysFromDemand(text, type),
      answers: {},
      questions: []
    };

    state.demands.push(demand);
    renderDemandList();
    input.value = '';

    addUserMessage(text);
    setTimeout(function () {
      var typeNames = { goal: '学习目标', event: '日程事件', modify: '调整需求', flight: '航班出行', strategy_goal: '战略目标', strategy_constraint: '约束原则', conflict: '冲突分析' };
      var daysText = type === 'flight' ? '当日' : demand.days + ' 天';
      addSystemMessage('收到' + typeNames[type] + '「' + text.substring(0, 20) + (text.length > 20 ? '...' : '') + '」，约 <strong>' + daysText + '</strong>。');

      // AI 顾问分析
      setTimeout(function () {
        addSystemMessage(generateAdvisorMessage(text, type));
      }, 500);

      // 如果当前没有正在进行的对话，自动开始收集信息
      if (state.phase === 'idle') {
        setTimeout(function () {
          ZHS.generateSchedule();
        }, 600);
      }
    }, 200);
  };

  /* ====== 计算航班出发时间 ====== */
  function calcFlightSchedule(demand, dayIndex) {
    var answers = demand.answers || {};
    var info = extractFlightInfo(demand.text);
    var flightTime = info.time || answers.flightTime || '14:00';
    var transport = answers.transport || '地铁';
    var arriveEarly = answers.arriveEarly || '2小时';
    var airport = answers.airport || info.airport || (info.destCity ? info.destCity + '机场' : '机场');
    var flightNo = answers.flightNo || info.flightNo || '';

    // 解析起飞时间
    var ftParts = flightTime.split(':');
    var ftHour = parseInt(ftParts[0]);
    var ftMin = parseInt(ftParts[1] || 0);

    // 根据交通方式估算路上时间
    var travelMinutes = 60; // 默认1小时
    if (/地铁/.test(transport)) travelMinutes = 50;
    else if (/打车|出租车|滴滴/.test(transport)) travelMinutes = 40;
    else if (/自驾/.test(transport)) travelMinutes = 45;
    else if (/大巴|机场大巴/.test(transport)) travelMinutes = 70;

    // 解析提前到达时间：纯数字视为分钟，带"小时"才乘60
    var earlyMatch = arriveEarly.match(/(\d+)/);
    var earlyMinutes = 120; // 默认2小时
    if (earlyMatch) {
      var num = parseInt(earlyMatch[1]);
      if (/小时/.test(arriveEarly)) {
        earlyMinutes = num * 60;
      } else if (/分钟/.test(arriveEarly)) {
        earlyMinutes = num;
      } else {
        // 纯数字，<=120视为分钟，>120视为小时
        earlyMinutes = num <= 120 ? num : num * 60;
      }
    }

    // 计算各节点时间（带天数偏移保护）
    function addMin(h, m, delta) {
      var total = h * 60 + m + delta;
      var dayOffset = 0;
      while (total < 0) { total += 1440; dayOffset -= 1; }
      while (total >= 1440) { total -= 1440; dayOffset += 1; }
      return { hour: Math.floor(total / 60), min: total % 60, dayOffset: dayOffset };
    }

    var arrive = addMin(ftHour, ftMin, -earlyMinutes);
    var depart = addMin(arrive.hour, arrive.min, -travelMinutes);

    // 格式化时间
    function fmt(h, m) {
      h = ((h % 24) + 24) % 24; // 确保 0-23
      return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    var blocks = [];

    // 1. 从家出发
    var departTime = fmt(depart.hour, depart.min);
    var arriveAirportTime = fmt(arrive.hour, arrive.min);
    blocks.push({
      start: departTime,
      end: arriveAirportTime,
      title: '🚗 从家出发前往' + airport,
      detail: '乘坐' + transport + '，预计' + travelMinutes + '分钟到达' + airport,
      type: 'event',
      source: '高德地图 · ' + transport + '路线'
    });

    // 2. 到达机场，办理值机（最长40分钟或到起飞前15分钟）
    var checkinDuration = Math.min(40, ftHour * 60 + ftMin - (arrive.hour * 60 + arrive.min) - 15);
    if (checkinDuration > 0) {
      var checkinEnd = addMin(arrive.hour, arrive.min, checkinDuration);
      blocks.push({
        start: arriveAirportTime,
        end: fmt(checkinEnd.hour, checkinEnd.min),
        title: '🛫 到达' + airport + '，办理值机/托运/安检',
        detail: '提前抵达，办理登机手续',
        type: 'event',
        source: airport + '官网 · 值机指南'
      });

      // 3. 候机（checkin结束到起飞前15分钟）
      var waitStart = { hour: checkinEnd.hour, min: checkinEnd.min };
      var waitEnd = addMin(ftHour, ftMin, -15);
      if (waitEnd.hour > waitStart.hour || (waitEnd.hour === waitStart.hour && waitEnd.min > waitStart.min)) {
        blocks.push({
          start: fmt(waitStart.hour, waitStart.min),
          end: fmt(waitEnd.hour, waitEnd.min),
          title: '☕ 候机休息',
          detail: '前往登机口等候，可处理邮件或休息',
          type: 'event',
          source: airport + ' · 登机口信息'
        });
      }
    } else {
      // 时间不够，直接候机
      var waitEnd2 = addMin(ftHour, ftMin, -15);
      if (waitEnd2.hour > arrive.hour || (waitEnd2.hour === arrive.hour && waitEnd2.min > arrive.min)) {
        blocks.push({
          start: arriveAirportTime,
          end: fmt(waitEnd2.hour, waitEnd2.min),
          title: '☕ 候机休息',
          detail: '已到达机场，前往登机口等候',
          type: 'event',
          source: airport + ' · 登机口信息'
        });
      }
    }

    // 4. 登机起飞
    var gateClose = addMin(ftHour, ftMin, 15);
    blocks.push({
      start: flightTime,
      end: fmt(gateClose.hour, gateClose.min),
      title: '✈️ ' + (flightNo ? flightNo + ' ' : '') + '航班起飞',
      detail: '目的地：' + airport + '，请留意登机广播',
      type: 'event',
      source: flightNo ? '飞常准 · ' + flightNo + '动态' : '航旅纵横'
    });

    return blocks;
  }

  function renderDemandList() {
    var list = document.getElementById('demandList');
    if (state.demands.length === 0) {
      list.innerHTML = '<span style="font-size:0.78rem;color:var(--muted);text-align:center;padding:1rem">暂无目标，在「与AI对话」中提交需求</span>';
      return;
    }
    var html = '';
    state.demands.forEach(function (d) {
      var typeNames = { goal: '目标', event: '事件', modify: '调整', flight: '航班' };
      var typeColors = { goal: 'goal', event: 'event', modify: 'modify', flight: 'flight' };

      // 计算或获取优先级
      var priority = d.userPriority || 'auto';
      var priorityLabel = { high: '高', mid: '中', low: '低', auto: '自动' }[priority];
      var priorityScore = '';
      if (priority === 'auto') {
        var score = calcStrategyAlignment(d.text);
        priorityScore = score + '%';
      }

      html += '<div class="demand-tag">';
      html += '<span class="type ' + typeColors[d.type] + '">' + typeNames[d.type] + '</span>';
      html += '<span class="demand-text">' + d.text + '</span>';
      html += '<span class="demand-days">' + (d.type === 'flight' ? '当日' : d.days + '天') + '</span>';
      html += '<span class="priority-select ' + priority + '" onclick="ZHS.cycleDemandPriority(' + d.id + ')" title="点击切换优先级">' + priorityLabel + (priorityScore ? ' ' + priorityScore : '') + '</span>';
      html += '<span class="del" onclick="ZHS.removeDemand(' + d.id + ')">✕</span>';
      html += '</div>';
    });
    list.innerHTML = html;
  }

  ZHS.cycleDemandPriority = function (id) {
    var demand = state.demands.find(function (d) { return d.id === id; });
    if (!demand) return;
    var cycle = ['auto', 'high', 'mid', 'low'];
    var current = demand.userPriority || 'auto';
    var idx = cycle.indexOf(current);
    var next = cycle[(idx + 1) % cycle.length];
    demand.userPriority = next === 'auto' ? null : next;
    renderDemandList();
  };

  ZHS.removeDemand = function (id) {
    state.demands = state.demands.filter(function (d) { return d.id !== id; });
    renderDemandList();
  };

  /* ====== 生成总行程 ====== */
  ZHS.generateSchedule = function () {
    if (state.demands.length === 0) return;
    if (state.phase !== 'idle') return;

    // 如果已有行程，只收集新需求的信息，然后更新
    if (state.schedule) {
      var newDemands = state.demands.filter(function (d) {
        return !d.questions || d.questions.length === 0;
      });

      if (newDemands.length === 0) {
        // 没有新需求需要收集，直接重新生成
        state.phase = 'generating';
        state.schedule = buildIntegratedSchedule();
        state.currentDay = 0;
        state.currentWeek = 0;
        state.phase = 'ready';
        renderSchedule();
        addSystemMessage('🔄 总行程表已更新！整合 <strong>' + state.demands.length + ' 个需求</strong>。');
        setTimeout(function () {
          addSystemMessage('可继续提交新需求，AI 会更新总行程。');
        }, 400);
        state.phase = 'idle';
        return;
      }

      // 有新需求，进入增量收集模式
      state.phase = 'collecting';
      state.dialogQueue = [];
      state.dialogIndex = 0;

      // 只为新需求搜索资源
      newDemands.forEach(function (demand) {
        if (demand.type === 'goal') {
          var resources = searchResourcesForDemand(demand);
          demand.resources = resources;
        } else if (demand.type === 'flight') {
          var resources = searchFlightStaticResources(demand);
          demand.resources = resources;
        }
      });

      // 构建只针对新需求的对话队列
      newDemands.forEach(function (demand) {
        if (demand.type === 'goal' && demand.resources && demand.resources.length > 0) {
          var searchMsg = '🔍 正在搜索「' + demand.text.substring(0, 20) + '」相关学习资源...';
          state.dialogQueue.push({ ai: searchMsg, delay: 400, isSystem: true });
          var foundMsg = '找到 <strong>' + demand.resources.length + ' 个</strong>推荐资源：';
          state.dialogQueue.push({ ai: foundMsg, delay: 600, isSystem: true });
          demand.resources.forEach(function (res, idx) {
            var resMsg = (idx + 1) + '. <strong>' + res.title + '</strong> <span style="color:var(--muted);font-size:0.78rem">[' + res.type + ' · ' + res.source + ']</span>';
            state.dialogQueue.push({ ai: resMsg, delay: 150, isSystem: true });
          });
        }

        if (demand.type === 'flight' && demand.resources && demand.resources.length > 0) {
          var flightInfo = extractFlightInfo(demand.text);
          var airportName = flightInfo.airport || (flightInfo.destCity ? flightInfo.destCity + '机场' : '目标机场');
          var searchMsg = '🔍 正在搜索「' + airportName + '」机场服务信息...';
          state.dialogQueue.push({ ai: searchMsg, delay: 400, isSystem: true });
          var foundMsg = '找到 <strong>' + demand.resources.length + ' 个</strong>参考信息：';
          state.dialogQueue.push({ ai: foundMsg, delay: 600, isSystem: true });
          demand.resources.forEach(function (res, idx) {
            var resMsg = (idx + 1) + '. <strong>' + res.title + '</strong> <span style="color:var(--muted);font-size:0.78rem">[' + res.type + ' · ' + res.source + ']</span>';
            state.dialogQueue.push({ ai: resMsg, delay: 150, isSystem: true });
          });
        }

        var questions = generateQuestionsForDemand(demand);
        demand.questions = questions;
        if (questions.length > 0) {
          var headerDays = demand.type === 'flight' ? '当日' : demand.days + '天';
          state.dialogQueue.push({ ai: '--- 新需求 #' + demand.id + '：' + demand.text.substring(0, 12) + '...（' + headerDays + '）---', delay: 300 });
          questions.forEach(function (q) {
            state.dialogQueue.push(Object.assign({}, q, { demandId: demand.id }));
          });
        }
      });

      state.dialogQueue.push({ ai: '信息收集完毕！正在更新总行程表...', delay: 800, isSystem: true });
      addSystemMessage('检测到新需求，开始收集信息。');
      setTimeout(runDialogQueue, 400);
      return;
    }

    state.phase = 'collecting';
    state.dialogQueue = [];
    state.dialogIndex = 0;
    // 不清空聊天区域，保留历史对话

    // 先为每个需求自动搜索资源
    state.demands.forEach(function (demand) {
      if (demand.type === 'goal') {
        var resources = searchResourcesForDemand(demand);
        demand.resources = resources;
      } else if (demand.type === 'flight') {
        var resources = searchFlightStaticResources(demand);
        demand.resources = resources;
      }
    });

    // 构建对话队列：搜索展示 -> 提问
    state.demands.forEach(function (demand) {
      // 搜索资源展示（系统消息，不等待回答）
      if (demand.type === 'goal' && demand.resources && demand.resources.length > 0) {
        var searchMsg = '🔍 正在搜索「' + demand.text.substring(0, 20) + '」相关学习资源...';
        state.dialogQueue.push({ ai: searchMsg, delay: 400, isSystem: true });

        var foundMsg = '找到 <strong>' + demand.resources.length + ' 个</strong>推荐资源：';
        state.dialogQueue.push({ ai: foundMsg, delay: 600, isSystem: true });

        demand.resources.forEach(function (res, idx) {
          var resMsg = (idx + 1) + '. <strong>' + res.title + '</strong> <span style="color:var(--muted);font-size:0.78rem">[' + res.type + ' · ' + res.source + ']</span>';
          state.dialogQueue.push({ ai: resMsg, delay: 150, isSystem: true });
        });
      }

      // 航班静态信息搜索展示（不依赖用户回答）
      if (demand.type === 'flight' && demand.resources && demand.resources.length > 0) {
        var flightInfo = extractFlightInfo(demand.text);
        var airportName = flightInfo.airport || (flightInfo.destCity ? flightInfo.destCity + '机场' : '目标机场');
        var searchMsg = '🔍 正在搜索「' + airportName + '」机场服务信息...';
        state.dialogQueue.push({ ai: searchMsg, delay: 400, isSystem: true });

        var foundMsg = '找到 <strong>' + demand.resources.length + ' 个</strong>参考信息：';
        state.dialogQueue.push({ ai: foundMsg, delay: 600, isSystem: true });

        demand.resources.forEach(function (res, idx) {
          var resMsg = (idx + 1) + '. <strong>' + res.title + '</strong> <span style="color:var(--muted);font-size:0.78rem">[' + res.type + ' · ' + res.source + ']</span>';
          state.dialogQueue.push({ ai: resMsg, delay: 150, isSystem: true });
        });
      }

      // 提问
      var questions = generateQuestionsForDemand(demand);
      demand.questions = questions;
      if (questions.length > 0) {
        var headerDays = demand.type === 'flight' ? '当日' : demand.days + '天';
        state.dialogQueue.push({ ai: '--- 需求 #' + demand.id + '：' + demand.text.substring(0, 12) + '...（' + headerDays + '）---', delay: 300 });
        questions.forEach(function (q) {
          state.dialogQueue.push(Object.assign({}, q, { demandId: demand.id }));
        });
      }
    });

    state.dialogQueue.push({ ai: '信息收集完毕！正在整合生成总行程表...', delay: 800, isSystem: true });

    addSystemMessage('开始收集每个需求的信息。');
    setTimeout(runDialogQueue, 400);
  };

  function finishCollecting() {
    var isUpdate = !!state.schedule; // 是否增量更新
    state.phase = 'generating';
    state.schedule = buildIntegratedSchedule();
    if (!isUpdate) {
      state.currentDay = 0;
      state.currentWeek = 0;
    }
    state.phase = 'ready';

    renderSchedule();
    document.getElementById('totalProgress').style.display = 'block';
    document.getElementById('weekNav').style.display = 'flex';

    var total = calcTotalProgress();
    if (isUpdate) {
      addSystemMessage('🔄 总行程表已更新！整合 <strong>' + state.demands.length + ' 个需求</strong>，共 ' + state.schedule.length + ' 天，' + total.total + ' 个任务。');
    } else {
      addSystemMessage('✅ 总行程表已生成！整合 <strong>' + state.demands.length + ' 个需求</strong>，共 ' + state.schedule.length + ' 天，' + total.total + ' 个任务。');
    }

    setTimeout(function () {
      addSystemMessage('可继续提交新需求，AI 会更新总行程。<br><span style="color:var(--muted);font-size:0.78rem">💡 试试：后天下午飞北京，航班 CA1234，14:00 起飞</span>');
    }, 600);

    setTimeout(function () {
      if (state.reminderOn) showReminder(state.schedule[0]);
    }, 1500);

    state.phase = 'idle';

    // 自动处理排队中的需求
    if (pendingQueue.length > 0) {
      var queued = pendingQueue.slice();
      pendingQueue = [];
      setTimeout(function () {
        var count = queued.length;
        addSystemMessage('📋 开始自动处理 ' + count + ' 个排队中的需求...');
        setTimeout(function () {
          // 清除这些需求的 pending 标记
          queued.forEach(function (qd) { delete qd.pending; });
          ZHS.generateSchedule();
        }, 500);
      }, 1200);
    }
  }

  /* ====== 构建整合后的总行程（只包含目标任务和事件） ====== */
  function buildIntegratedSchedule() {
    var baseEvents = {
      '周一': [
        { start: '08:00', end: '12:00', title: '上课', detail: '已有日程', type: 'event' },
        { start: '14:00', end: '16:00', title: '英语课', detail: '已有日程', type: 'event' }
      ],
      '周二': [{ start: '10:00', end: '12:00', title: '组会', detail: '已有日程', type: 'event' }],
      '周三': [{ start: '08:00', end: '10:00', title: '实验课', detail: '已有日程', type: 'event' }],
      '周四': [{ start: '08:00', end: '12:00', title: '上课', detail: '已有日程', type: 'event' }],
      '周五': [
        { start: '08:00', end: '12:00', title: '上课', detail: '已有日程', type: 'event' },
        { start: '14:00', end: '16:00', title: '体育课', detail: '已有日程', type: 'event' }
      ],
      '周六': [],
      '周日': []
    };

    var goals = state.demands.filter(function (d) { return d.type === 'goal'; });
    var events = state.demands.filter(function (d) { return d.type === 'event'; });
    var flights = state.demands.filter(function (d) { return d.type === 'flight'; });

    var maxDays = 21;
    state.demands.forEach(function (d) {
      if (d.days > maxDays) maxDays = d.days;
    });
    if (maxDays > 60) maxDays = 60;

    var weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    var schedule = [];
    var startDate = new Date(2026, 5, 23); // 2026-06-23，基准日期

    // 计算航班目标日期索引
    var flightDayMap = {};
    flights.forEach(function (f) {
      var info = extractFlightInfo(f.text);
      var dayOffset = 0;
      if (info.date === '明天') dayOffset = 1;
      else if (info.date === '后天') dayOffset = 2;
      else if (info.date === '大后天') dayOffset = 3;
      else if (info.date === '下周') dayOffset = 7;
      flightDayMap[f.id] = dayOffset;
    });

    for (var i = 0; i < maxDays; i++) {
      var weekday = weekDays[i % 7];
      var weekNum = Math.floor(i / 7) + 1;
      var blocks = [];

      var fixed = baseEvents[weekday] || [];
      fixed.forEach(function (e) { blocks.push(Object.assign({}, e)); });

      // 如果今天有航班事件，插入航班日程块（优先于学习任务）
      flights.forEach(function (f) {
        if (flightDayMap[f.id] === i) {
          var flightBlocks = calcFlightSchedule(f, i);
          flightBlocks.forEach(function (fb) { blocks.push(fb); });
        }
      });

      var learnStart = 19;
      goals.forEach(function (goal, gi) {
        var period = goal.answers.period || '晚上';
        var startH = period === '晚上' ? 19 : (period === '上午' ? 8 : 14);
        var offset = gi * 2;
        var s1 = startH + offset;
        var s2 = s1 + 1;

        var task = generateTaskForGoal(goal, i, gi);
        if (task) {
          blocks.push({
            start: s1 + ':00',
            end: s1 + ':50',
            title: task.title,
            detail: task.detail,
            type: 'learning',
            source: task.source || goal.text.substring(0, 15),
            done: false,
            goalId: goal.id
          });
          if (task.subtask) {
            blocks.push({
              start: s2 + ':00',
              end: s2 + ':50',
              title: task.subtask.title,
              detail: task.subtask.detail,
              type: 'learning',
              source: task.subtask.source || goal.text.substring(0, 15),
              done: false,
              goalId: goal.id
            });
          }
        }
      });

      events.forEach(function (evt) {
        var freq = evt.answers.frequency || '每周固定';
        if (freq === '每周固定' || (freq === '仅本周' && i < 7)) {
          var evtWeekday = extractWeekday(evt.text);
          if (evtWeekday === weekday) {
            var timeInfo = extractTime(evt.text);
            blocks.push({
              start: timeInfo.start,
              end: timeInfo.end,
              title: evt.text.replace(/\d{1,2}[点时:：]\d{0,2}/g, '').trim() || '新事件',
              detail: '用户添加',
              type: 'event'
            });
          }
        }
      });

      blocks.sort(function (a, b) { return parseTime(a.start) - parseTime(b.start); });

      var currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + i);
      var month = currentDate.getMonth() + 1;
      var date = currentDate.getDate();

      schedule.push({
        label: '第 ' + (i + 1) + ' 天',
        weekday: weekday,
        theme: goals.length > 0 ? goals[0].text.substring(0, 20) + '...' : '总行程',
        week: weekNum,
        blocks: blocks,
        dateLabel: month + '月' + date + '日',
        dateStr: month + '/' + date
      });
    }

    return schedule;
  }

  function generateTaskForGoal(goal, dayIndex, goalIndex) {
    // 如果有搜索到的资源，用真实资源名称填充任务
    var resources = goal.resources || [];
    var hasResources = resources.length > 0;

    var texts = [
      { title: '学习核心概念', detail: '阅读教材/观看视频，理解基础知识点', source: '学习资源' },
      { title: '完成练习题', detail: '做相关练习题巩固所学内容', source: '练习题库' },
      { title: '实践项目', detail: '动手实践，完成一个小项目或案例', source: '项目实战' },
      { title: '复习总结', detail: '回顾本周学习内容，整理笔记', source: '复习清单' },
      { title: '进阶学习', detail: '深入学习进阶内容，挑战难题', source: '进阶课程' },
      { title: '综合应用', detail: '将所学知识综合应用到实际场景中', source: '综合实践' },
      { title: '成果产出', detail: '完成最终成果，如项目、报告等', source: '成果产出' }
    ];

    var idx = dayIndex % texts.length;
    var task = Object.assign({}, texts[idx]);

    // 用搜索到的真实资源替换通用描述
    if (hasResources) {
      var resIdx = dayIndex % resources.length;
      var res = resources[resIdx];
      task.source = res.title + ' · ' + res.source;

      // 根据资源类型定制详情
      if (res.type === '视频') {
        task.detail = '观看「' + res.title + '」，完成对应章节学习笔记';
      } else if (res.type === '文档' || res.type === '教程') {
        task.detail = '阅读「' + res.title + '」，理解核心概念并做笔记';
      } else if (res.type === '实战' || res.type === '项目') {
        task.detail = '跟随「' + res.title + '」完成实战练习';
      } else if (res.type === '真题' || res.type === '练习') {
        task.detail = '完成「' + res.title + '」对应章节练习';
      } else if (res.type === 'App') {
        task.detail = '使用「' + res.title + '」进行每日练习';
      } else {
        task.detail = '学习「' + res.title + '」，掌握相关知识点';
      }
    }

    task.title = goal.text.substring(0, 10) + ' - ' + task.title;

    var subtask = null;
    if (dayIndex % 3 === 0 && dayIndex > 0) {
      var checkRes = hasResources ? resources[(dayIndex + 1) % resources.length] : null;
      subtask = {
        title: '检查进度并调整',
        detail: checkRes ? '回顾「' + checkRes.title + '」学习情况，根据实际进度调整后续计划' : '回顾完成情况，根据实际进度调整后续计划',
        source: checkRes ? checkRes.source : '系统反馈'
      };
    }

    return { title: task.title, detail: task.detail, source: task.source, subtask: subtask };
  }

  function extractWeekday(text) {
    var days = { '周一': '周一', '周二': '周二', '周三': '周三', '周四': '周四', '周五': '周五', '周六': '周六', '周日': '周日' };
    for (var d in days) {
      if (text.includes(d)) return days[d];
    }
    return '周一';
  }

  function extractTime(text) {
    var match = text.match(/(\d{1,2})[点时:：](\d{0,2})/);
    var h = match ? parseInt(match[1]) : 14;
    var start = (h < 10 ? '0' : '') + h + ':00';
    var endH = h + 1;
    var end = (endH < 10 ? '0' : '') + endH + ':00';
    return { start: start, end: end };
  }

  function parseTime(s) {
    if (!s) return 0;
    var p = s.split(':');
    return parseInt(p[0]) * 60 + parseInt(p[1]);
  }

  function calcTotalProgress() {
    if (!state.schedule) return { done: 0, total: 0 };
    var done = 0, total = 0;
    for (var i = 0; i < state.schedule.length; i++) {
      var blocks = state.schedule[i].blocks;
      for (var j = 0; j < blocks.length; j++) {
        if (blocks[j].type === 'learning') {
          total++;
          if (blocks[j].done) done++;
        }
      }
    }
    return { done: done, total: total };
  }

  function updateTotalProgress() {
    var p = calcTotalProgress();
    document.getElementById('totalNum').textContent = p.done + '/' + p.total;
    var pct = p.total > 0 ? (p.done / p.total * 100) : 0;
    document.getElementById('totalFill').style.width = pct + '%';
  }

  function checkDayComplete(dayIndex) {
    var day = state.schedule[dayIndex];
    if (!day) return false;
    var learningBlocks = day.blocks.filter(function (b) { return b.type === 'learning'; });
    if (learningBlocks.length === 0) return false;
    return learningBlocks.every(function (b) { return b.done; });
  }

  /* ====== 周切换 ====== */
  ZHS.prevWeek = function () {
    if (state.currentWeek > 0) {
      state.currentWeek--;
      state.currentDay = state.currentWeek * 7;
      renderSchedule();
    }
  };

  ZHS.nextWeek = function () {
    var totalWeeks = Math.ceil(state.schedule.length / 7);
    if (state.currentWeek < totalWeeks - 1) {
      state.currentWeek++;
      state.currentDay = state.currentWeek * 7;
      renderSchedule();
    }
  };

  function renderSchedule() {
    var container = document.getElementById('scheduleContainer');
    var tabsEl = document.getElementById('dayNav');
    var titleEl = document.getElementById('mainTitle');
    var weekLabel = document.getElementById('weekLabel');
    var prevBtn = document.getElementById('prevWeekBtn');
    var nextBtn = document.getElementById('nextWeekBtn');

    if (!state.schedule) {
      container.innerHTML = '<div class="empty-state"><span class="icon">📅</span><p>在左侧提交需求<br>AI 收集信息并生成整合后的总行程表</p></div>';
      tabsEl.innerHTML = '';
      titleEl.textContent = '总行程规划';
      document.getElementById('weekNav').style.display = 'none';
      return;
    }

    titleEl.textContent = '整合总行程 · 共 ' + state.schedule.length + ' 天';

    var totalWeeks = Math.ceil(state.schedule.length / 7);
    weekLabel.textContent = '第' + (state.currentWeek + 1) + '周 / 共' + totalWeeks + '周';
    prevBtn.disabled = state.currentWeek === 0;
    nextBtn.disabled = state.currentWeek >= totalWeeks - 1;

    // 只渲染当前周的7天
    var weekStart = state.currentWeek * 7;
    var weekEnd = Math.min(weekStart + 7, state.schedule.length);

    var tabsHtml = '';
    for (var i = weekStart; i < weekEnd; i++) {
      var day = state.schedule[i];
      var isComplete = checkDayComplete(i);
      var isActive = i === state.currentDay;
      var cls = 'day-tab';
      if (isActive) cls += ' active';
      if (isComplete) cls += ' done-day';

      tabsHtml += '<button class="' + cls + '" onclick="ZHS.switchDay(' + i + ')">';
      tabsHtml += day.dateLabel;
      tabsHtml += '<span class="day-date">' + day.weekday + '</span>';
      if (isComplete) tabsHtml += '<span style="font-size:0.6rem"> ✓</span>';
      tabsHtml += '</button>';
    }
    tabsEl.innerHTML = tabsHtml;

    var currentDayData = state.schedule[state.currentDay];
    var learningBlocks = currentDayData.blocks.filter(function (b) { return b.type === 'learning'; });
    var completedCount = learningBlocks.filter(function (b) { return b.done; }).length;
    var isDayComplete = checkDayComplete(state.currentDay);

    var html = '';

    if (isDayComplete && state.autoNextOn && state.currentDay < state.schedule.length - 1) {
      html += '<div class="day-complete-banner">';
      html += '<p>🎉 ' + currentDayData.dateLabel + ' ' + currentDayData.weekday + ' 全部完成！</p>';
      html += '<button onclick="ZHS.goNextDay()">下一天 →</button>';
      html += '</div>';
    } else if (isDayComplete) {
      html += '<div class="day-complete-banner">';
      html += '<p>🎉 恭喜！全部完成！</p>';
      html += '</div>';
    }

    // 日期头部 - 使用日期+周X格式
    var statusBadgeCls = isDayComplete ? 'completed' : (completedCount > 0 ? 'in-progress' : 'upcoming');
    var statusBadgeText = isDayComplete ? '已完成' : (completedCount > 0 ? '进行中' : '未开始');
    html += '<div class="day-header">';
    html += '<div class="day-num">' + currentDayData.dateLabel + '</div>';
    html += '<div class="day-info">';
    html += '<div class="day-title">' + currentDayData.weekday + ' · 第' + currentDayData.week + '周</div>';
    html += '<div class="day-meta">' + currentDayData.theme + '</div>';
    html += '</div>';
    html += '<div style="text-align:right">';
    html += '<span class="day-status-badge ' + statusBadgeCls + '">' + statusBadgeText + '</span>';
    html += '<div style="margin-top:0.3rem;font-size:0.78rem;color:var(--muted)"><span class="mono" style="color:var(--accent);font-weight:700">' + completedCount + '/' + learningBlocks.length + '</span> 任务</div>';
    html += '</div></div>';

    // 每日晨报
    var eventBlocks = currentDayData.blocks.filter(function (b) { return b.type === 'event'; });
    var mustDo = [];
    var recommend = [];
    var avoid = [];

    eventBlocks.forEach(function (b) {
      mustDo.push(b.title);
    });
    if (learningBlocks.length > 0) {
      var topTask = learningBlocks[0];
      recommend.push(topTask.title);
    }
    // 检查约束
    state.strategyConstraints.forEach(function (c) {
      if (/不熬夜|早睡/.test(c.text) && currentDayData.weekday === '周六') {
        avoid.push('注意「' + c.text + '」，今晚不要熬夜');
      }
    });
    if (mustDo.length === 0 && recommend.length === 0 && avoid.length === 0) {
      recommend.push('今天没有强制安排，可自由安排学习进度');
    }

    var briefingHtml = '<div class="briefing-title">🌅 每日晨报 · AI 顾问建议</div>';
    if (mustDo.length > 0) {
      briefingHtml += '<div class="briefing-row must"><span class="b-icon">🔴</span><div class="b-text"><strong>必做：</strong>' + mustDo.join('；') + '</div></div>';
    }
    if (recommend.length > 0) {
      briefingHtml += '<div class="briefing-row recommend"><span class="b-icon">🟢</span><div class="b-text"><strong>推荐：</strong>' + recommend.join('；') + '</div></div>';
    }
    if (avoid.length > 0) {
      briefingHtml += '<div class="briefing-row avoid"><span class="b-icon">⚪</span><div class="b-text"><strong>不建议：</strong>' + avoid.join('；') + '</div></div>';
    }
    // 战略目标提醒
    if (state.strategyGoals.length > 0 && state.currentDay === 0) {
      briefingHtml += '<div class="briefing-row recommend"><span class="b-icon">🎯</span><div class="b-text"><strong>战略目标：</strong>' + state.strategyGoals.map(function(g){ return g.text; }).join(' / ') + '</div></div>';
    }
    var briefingEl = document.getElementById('dailyBriefing');
    if (briefingEl) {
      briefingEl.innerHTML = briefingHtml;
      briefingEl.style.display = 'block';
    }

    // 任务卡片网格
    html += '<div class="tasks-grid">';
    for (var b = 0; b < currentDayData.blocks.length; b++) {
      var block = currentDayData.blocks[b];
      var cardCls = 'task-card ' + block.type;
      if (block.done) cardCls += ' done';
      html += '<div class="' + cardCls + '">';

      // 勾选框
      if (block.type === 'learning') {
        html += '<div class="task-card-check' + (block.done ? ' done' : '') + '" onclick="ZHS.toggleTask(' + state.currentDay + ',' + b + ')">' + (block.done ? '✓' : '') + '</div>';
      }

      // 性价比评分
      var priority = calcPriorityScore(block, state.currentDay, state.schedule.length);

      // 时间和类型标签
      html += '<div class="task-card-header">';
      html += '<div class="task-card-time">' + block.start + '<span class="time-sep">→</span>' + block.end + '</div>';
      html += '<span class="priority-badge ' + priority.level + '" title="' + (priority.userSet ? '手动设置' : 'AI自动评分') + '">' + priority.label + ' ' + priority.score + (priority.userSet ? ' ✋' : '') + '</span>';
      // 提醒按钮
      var reminderOn = block.reminder !== false; // 默认开启
      html += '<span class="reminder-toggle' + (reminderOn ? ' on' : '') + '" onclick="ZHS.toggleReminder(' + state.currentDay + ',' + b + ')" title="点击开启/关闭手机提醒">' + (reminderOn ? '🔔 提醒' : '🔕 关') + '</span>';
      html += '</div>';

      // 标题
      html += '<div class="task-card-title">' + block.title + '</div>';

      // 详情
      if (block.detail) html += '<div class="task-card-detail">' + block.detail + '</div>';

      // 来源
      if (block.source) html += '<div class="task-card-source">' + block.source + '</div>';

      html += '</div>';
    }
    html += '</div>';

    container.innerHTML = html;
    updateTotalProgress();
  }

  ZHS.switchDay = function (index) {
    if (index < 0 || index >= state.schedule.length) return;
    state.currentDay = index;
    state.currentWeek = Math.floor(index / 7);
    renderSchedule();

    if (state.reminderOn && !state.reminderShown[index]) {
      var day = state.schedule[index];
      var learningBlocks = day.blocks.filter(function (b) { return b.type === 'learning'; });
      var incomplete = learningBlocks.filter(function (b) { return !b.done; });
      if (incomplete.length > 0) {
        setTimeout(function () { showReminder(day); }, 300);
        state.reminderShown[index] = true;
      }
    }
  };

  ZHS.goNextDay = function () {
    if (state.currentDay < state.schedule.length - 1) {
      state.currentDay++;
      state.currentWeek = Math.floor(state.currentDay / 7);
      renderSchedule();
      showToast('已跳转到 ' + state.schedule[state.currentDay].dateLabel);
      if (state.reminderOn) {
        setTimeout(function () {
          showReminder(state.schedule[state.currentDay]);
          state.reminderShown[state.currentDay] = true;
        }, 500);
      }
    }
  };

  ZHS.toggleTask = function (dayIndex, blockIdx) {
    var block = state.schedule[dayIndex].blocks[blockIdx];
    if (!block || block.type !== 'learning') return;

    block.done = !block.done;
    renderSchedule();

    if (block.done) {
      showToast('✓ ' + block.title + ' 已完成');
    }

    if (checkDayComplete(dayIndex)) {
      var day = state.schedule[dayIndex];
      addSystemMessage('🎉 太棒了！' + day.dateLabel + ' ' + day.weekday + ' 的所有任务已完成！');

      if (state.autoNextOn && dayIndex < state.schedule.length - 1) {
        setTimeout(function () {
          if (state.currentDay === dayIndex) {
            ZHS.goNextDay();
          }
        }, 3000);
      }
    }
  };

  /* ====== 提醒开关 ====== */
  ZHS.toggleReminder = function (dayIndex, blockIdx) {
    var block = state.schedule[dayIndex].blocks[blockIdx];
    if (!block) return;
    block.reminder = block.reminder === false ? true : false;
    renderSchedule();
    showToast(block.reminder ? '🔔 已开启「' + block.title + '」的手机提醒' : '🔕 已关闭「' + block.title + '」的提醒');
  };

  /* ====== 手动添加事件 ====== */
  ZHS.addManualEvent = function () {
    var startInput = document.getElementById('newEventStart');
    var endInput = document.getElementById('newEventEnd');
    var titleInput = document.getElementById('newEventTitle');
    var title = titleInput.value.trim();
    if (!title) {
      showToast('请输入事件标题');
      return;
    }
    if (!state.schedule || state.schedule.length === 0) {
      showToast('请先生成行程表');
      return;
    }

    var newBlock = {
      start: startInput.value,
      end: endInput.value,
      title: title,
      detail: '手动添加的事件',
      type: 'event',
      source: '手动添加',
      reminder: true,
      manual: true
    };

    state.schedule[state.currentDay].blocks.push(newBlock);
    // 按时间排序
    state.schedule[state.currentDay].blocks.sort(function (a, b) {
      return a.start.localeCompare(b.start);
    });

    titleInput.value = '';
    renderSchedule();
    showToast('✅ 已添加「' + title + '」到当天行程');
  };

  function showReminder(day) {
    var learningBlocks = day.blocks.filter(function (b) { return b.type === 'learning'; });
    var incomplete = learningBlocks.filter(function (b) { return !b.done; });
    if (incomplete.length === 0) return;

    var overlay = document.createElement('div');
    overlay.className = 'reminder-overlay';
    overlay.id = 'reminderOverlay';

    var tasksList = '';
    for (var i = 0; i < Math.min(incomplete.length, 3); i++) {
      tasksList += '<div class="task-item"><span class="time">' + incomplete[i].start + '</span>' + incomplete[i].title + '</div>';
    }
    if (incomplete.length > 3) {
      tasksList += '<div style="padding:0.2rem 0;font-size:0.78rem;color:var(--muted)">...还有 ' + (incomplete.length - 3) + ' 项</div>';
    }

    overlay.innerHTML =
      '<div class="reminder-modal">' +
        '<h3>📋 ' + day.dateLabel + ' ' + day.weekday + ' 任务提醒</h3>' +
        '<div style="margin-bottom:0.6rem;font-size:0.82rem;color:var(--muted)">' + day.theme + '</div>' +
        tasksList +
        '<div class="actions">' +
          '<button class="btn btn-primary" onclick="ZHS.closeReminder()">知道了</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) ZHS.closeReminder();
    });
  }

  ZHS.closeReminder = function () {
    var overlay = document.getElementById('reminderOverlay');
    if (overlay) overlay.remove();
  };

  ZHS.handleImageUpload = function (input) {
    var file = input.files[0];
    if (!file) return;

    addSystemMessage('📷 已收到图片：「' + file.name + '」。正在识别...');

    setTimeout(function () {
      var recognizedEvents = [
        '周一 08:00-10:00 高等数学',
        '周一 14:00-16:00 大学英语',
        '周二 10:00-12:00 数据结构',
        '周三 08:00-10:00 线性代数',
        '周四 14:00-16:00 操作系统',
        '周五 08:00-12:00 计算机网络'
      ];

      addSystemMessage('识别完成！提取到以下课程：');

      recognizedEvents.forEach(function (evt, i) {
        setTimeout(function () {
          addSystemMessage('• ' + evt);
        }, i * 150);
      });

      setTimeout(function () {
        addSystemMessage('已添加到固定日程。可继续提交其他需求。');
      }, recognizedEvents.length * 150 + 200);

      var demand = {
        id: ++demandIdCounter,
        type: 'event',
        text: '图片：' + file.name,
        days: 0,
        answers: { recognized: recognizedEvents },
        questions: []
      };
      state.demands.push(demand);
      renderDemandList();

      // 自动生成行程
      if (state.phase === 'idle') {
        setTimeout(function () {
          ZHS.generateSchedule();
        }, 500);
      }
    }, 1200);

    input.value = '';
  };

  function showToast(text) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 3000);
  }

  window.ZHS = ZHS;

  renderSchedule();
  renderStrategyPanel();

  // 默认预填一些示例战略目标
  if (state.strategyGoals.length === 0) {
    state.strategyGoals = [
      { text: '掌握Python数据分析', source: 'manual', priority: 'high', expanded: false, detail: '手动添加' },
      { text: '考研上岸', source: 'manual', priority: 'mid', expanded: false, detail: '手动添加' }
    ];
    state.strategyConstraints = [
      { text: '不熬夜，23点前睡觉', source: 'ai', priority: 'high', expanded: false, detail: '由 AI 分析生成' },
      { text: '每周日休息', source: 'manual', priority: 'mid', expanded: false, detail: '手动添加' }
    ];
    renderStrategyPanel();
  }

  document.getElementById('reminderToggle').addEventListener('change', function () {
    state.reminderOn = this.checked;
    showToast(state.reminderOn ? '提醒已开启' : '提醒已关闭');
  });

  document.getElementById('autoNextToggle').addEventListener('change', function () {
    state.autoNextOn = this.checked;
    showToast(state.autoNextOn ? '自动跳转已开启' : '自动跳转已关闭');
  });

  document.getElementById('demandInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ZHS.submitDemand();
    }
  });

  document.getElementById('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      ZHS.submitAnswer();
    }
  });

  document.getElementById('strategyGoalInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); ZHS.addStrategyGoal(); }
  });
  document.getElementById('strategyConstraintInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); ZHS.addConstraint(); }
  });

  document.getElementById('authPassword').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      ZHS.handleAuth();
    }
  });

  /* ====== 左侧栏拖动调整宽度 ====== */
  (function () {
    var handle = document.getElementById('resizeHandle');
    var sidebar = document.getElementById('sidebar');
    var appEl = document.querySelector('.app');
    if (!handle || !sidebar || !appEl) return;

    var isResizing = false;
    handle.addEventListener('mousedown', function (e) {
      isResizing = true;
      handle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!isResizing) return;
      var newWidth = e.clientX;
      if (newWidth < 280) newWidth = 280;
      if (newWidth > 600) newWidth = 600;
      sidebar.style.width = newWidth + 'px';
      appEl.style.gridTemplateColumns = newWidth + 'px 1fr';
    });

    document.addEventListener('mouseup', function () {
      if (isResizing) {
        isResizing = false;
        handle.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  })();
})();

