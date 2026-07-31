/**
 * engine/relationship-graph.js
 *
 * Layer 1.5 · Relationship Graph — 实体关系图。
 *
 * 提供实体间的关联查询和路径搜索能力，使 AI 的建议具有可解释性。
 * 例如：AI 建议今天做任务 A → 沿图搜索 → Goal X → 价值观 Y → Decision Z → DDL W
 *
 * 关系类型：
 *   - goal_has_task    : Goal → scheduled Task
 *   - goal_has_errand  : Goal → Errand
 *   - errand_has_note  : Errand → Note
 *   - note_in_topic    : Note → Topic
 *   - goal_in_topic    : Goal → Topic (via relatedGoalId)
 *   - decision_affects_goal : Decision → Goal
 *   - decision_refers_note  : Decision → Note
 *   - decision_refers_topic : Decision → Topic (via relatedNoteIds → note.topicId)
 *   - strategic_has_current : Strategic Goal → Current Goal (via relatedStrategicGoalId)
 *   - task_has_goal    : Task → Goal (via relatedGoalId)
 *
 * 这是一个纯查询层，不修改 state。从现有 state 数据实时构建关系图。
 */

'use strict';

// ─── Relationship types ───────────────────────────────────────────────

const REL_TYPES = {
  GOAL_HAS_TASK: 'goal_has_task',
  GOAL_HAS_ERRAND: 'goal_has_errand',
  ERRAND_HAS_NOTE: 'errand_has_note',
  NOTE_IN_TOPIC: 'note_in_topic',
  GOAL_IN_TOPIC: 'goal_in_topic',
  DECISION_AFFECTS_GOAL: 'decision_affects_goal',
  DECISION_REFERS_NOTE: 'decision_refers_note',
  DECISION_REFERS_TOPIC: 'decision_refers_topic',
  DECISION_AFFECTS_ACTION: 'decision_affects_action',
  STRATEGIC_HAS_CURRENT: 'strategic_has_current',
  TASK_HAS_GOAL: 'task_has_goal',
  TASK_HAS_NOTE: 'task_has_note',
  TASK_USES_DECISION: 'task_uses_decision',
  ACTION_LINKED_TOPIC: 'action_linked_topic',
  CONTEXT_LINKED_GOAL: 'context_linked_goal',
  CONTEXT_LINKED_NOTE: 'context_linked_note',
  CONTEXT_LINKED_DECISION: 'context_linked_decision',
  CONTEXT_LINKED_TOPIC: 'context_linked_topic',
};

// ─── Core: buildGraph ────────────────────────────────────────────────────

// PERF #25: Module-level graph cache — avoid rebuilding the graph for the same
// state version. buildGraph is called by getRelated/findPath/explainEntity on
// every query; caching eliminates redundant rebuilds within a single conversation.
let _graphCache = { stateVersion: null, graph: null };

// Canonical actions keep compact ID arrays for fast rendering and may also
// carry richer contextRefs for explanations. The graph must honour both forms;
// otherwise a valid context link disappears merely because it was recorded
// with a role (instruction/evidence/result) instead of a legacy noteIds field.
function referencedIds(entity, type, arrayKeys = [], scalarKeys = []) {
  if (!entity || typeof entity !== 'object') return [];
  const ids = [];
  for (const key of arrayKeys) {
    if (Array.isArray(entity[key])) ids.push(...entity[key]);
  }
  for (const key of scalarKeys) {
    if (entity[key]) ids.push(entity[key]);
  }
  for (const ref of (entity.contextRefs || [])) {
    if (ref?.type === type && ref.id) ids.push(ref.id);
  }
  return [...new Set(ids.filter(Boolean))];
}

function goalNodeType(goal) {
  if (goal?.type === 'strategic' || goal?.type === 'strategicGoal' || goal?.kind === 'strategic') return 'strategicGoal';
  if (goal?.type === 'constraint' || goal?.kind === 'constraint') return 'constraint';
  return 'currentGoal';
}

/**
 * Build an in-memory relationship graph from the current state.
 * This is O(n) where n is total entities — suitable for real-time queries.
 *
 * @param {Object} state - Full application state
 * @returns {{ nodes: Map, edges: Array, adjacency: Map }}
 */
function buildGraph(state) {
  // PERF #25: Check cache — if state hasn't changed, return cached graph
  const stateVersion = state.meta?.stateVersion;
  if (stateVersion !== undefined && _graphCache.stateVersion === stateVersion && _graphCache.graph) {
    return _graphCache.graph;
  }

  const nodes = new Map(); // id -> { id, type, title }
  const edges = [];
  const adjacency = new Map(); // id -> [{ target, relType }]

  // PERF #3 & #4: Build index Maps once — replaces O(n*m) linear finds with O(1) lookups.
  const notesById = new Map((state.notes || []).map(n => [n.id, n]));
  const goalsById = new Map([
    ...(state.currentGoals || []),
    ...(state.strategicGoals || []),
    ...(state.constraints || []),
  ].map(g => [g.id, g]));
  const decisionsById = new Map((state.decisions || []).map(d => [d.id, d]));
  const errandsById = new Map((state.errands || []).map(e => [e.id, e]));
  const tasksById = new Map();
  for (const day of Object.values(state.schedule?.days || {})) {
    for (const task of (day?.tasks || [])) if (task?.id) tasksById.set(task.id, task);
  }
  const completedById = new Map((state.completedActions || []).map(action => [action.id, action]));

  // ── 构建 topicsMap：从 notes 和其他实体中收集所有已知 topic 的 label ──
  const topicsMap = new Map(); // topicId -> { id, label }
  function collectTopic(topicId, label) {
    if (topicId && !topicsMap.has(topicId)) {
      topicsMap.set(topicId, { id: topicId, label: label || topicId });
    }
  }
  // 从 notes 的 topicId 收集
  for (const note of (state.notes || [])) {
    if (note.topicId) collectTopic(note.topicId, note.topicLabel);
  }
  // 从 errands 的 topicId 收集
  for (const errand of (state.errands || [])) {
    if (errand.topicId) collectTopic(errand.topicId, errand.topicLabel);
  }
  // 从 decisions 的 relatedNoteIds 关联到的 note.topicId 收集
  for (const decision of (state.decisions || [])) {
    if (decision.relatedNoteIds) {
      for (const noteId of decision.relatedNoteIds) {
        const note = notesById.get(noteId);
        if (note && note.topicId) collectTopic(note.topicId, note.topicLabel);
      }
    }
  }
  // 从 goals 的 topicId 收集（如果有）
  for (const goal of [...(state.currentGoals || []), ...(state.strategicGoals || []), ...(state.constraints || [])]) {
    if (goal.topicId) collectTopic(goal.topicId, goal.topicLabel);
  }
  for (const day of Object.values(state.schedule?.days || {})) {
    for (const task of (day.tasks || [])) if (task.topicId) collectTopic(task.topicId, task.topicLabel);
  }

  function addNode(id, type, title) {
    if (!nodes.has(id)) {
      nodes.set(id, { id, type, title: title || id });
    }
  }

  function addEdge(source, target, relType) {
    addNode(source.id || source, source.type, source.title);
    addNode(target.id || target, target.type, target.title);
    edges.push({ source: source.id || source, target: target.id || target, relType });
    if (!adjacency.has(source.id || source)) adjacency.set(source.id || source, []);
    if (!adjacency.has(target.id || target)) adjacency.set(target.id || target, []);
    adjacency.get(source.id || source).push({ target: target.id || target, relType });
    adjacency.get(target.id || target).push({ target: source.id || source, relType });
  }

  function linkContextEntity(entity, type, title) {
    if (!entity?.id) return;
    const source = { id: entity.id, type, title: title || entity.title || entity.id };
    for (const goalId of referencedIds(entity, 'goal', ['relatedGoalIds', 'linkedGoalIds'], ['goalId', 'relatedGoalId', 'relatedStrategicGoalId', 'linkedGoalId'])) {
      const goal = goalsById.get(goalId);
      if (goal) addEdge(source, { id: goal.id, type: goalNodeType(goal), title: goal.title }, REL_TYPES.CONTEXT_LINKED_GOAL);
    }
    for (const noteId of referencedIds(entity, 'note', ['noteIds', 'linkedNoteIds', 'relatedNoteIds'], ['noteId', 'linkedNoteId', 'relatedNoteId'])) {
      const note = notesById.get(noteId);
      if (note) addEdge(source, { id: note.id, type: 'note', title: note.title }, REL_TYPES.CONTEXT_LINKED_NOTE);
    }
    for (const decisionId of referencedIds(entity, 'decision', ['decisionIds', 'linkedDecisionIds'], ['decisionId', 'linkedDecisionId'])) {
      const decision = decisionsById.get(decisionId);
      if (decision) addEdge(source, { id: decision.id, type: 'decision', title: decision.title }, REL_TYPES.CONTEXT_LINKED_DECISION);
    }
    for (const topicId of referencedIds(entity, 'topic', ['topicIds', 'linkedTopicIds', 'relatedTopicIds'], ['topicId', 'linkedTopicId', 'relatedTopicId'])) {
      const topic = findTopic(topicsMap, topicId);
      addEdge(source, { id: topicId, type: 'topic', title: topic.label || topicId }, REL_TYPES.CONTEXT_LINKED_TOPIC);
    }
  }

  // ── Goals → Tasks ──
  for (const [date, day] of Object.entries(state.schedule?.days || {})) {
    for (const task of (day.tasks || [])) {
      for (const goalId of referencedIds(task, 'goal', ['relatedGoalIds', 'linkedGoalIds'], ['relatedGoalId', 'relatedStrategicGoalId', 'linkedGoalId'])) {
        const goal = goalsById.get(goalId);
        if (goal) {
          addEdge(
            { id: goal.id, type: goalNodeType(goal), title: goal.title },
            { id: task.id, type: 'task', title: task.title },
            REL_TYPES.GOAL_HAS_TASK,
          );
        }
      }
      for (const noteId of referencedIds(task, 'note', ['noteIds', 'linkedNoteIds', 'relatedNoteIds'])) {
        const note = notesById.get(noteId);
        if (note) addEdge({ id: task.id, type: 'task', title: task.title }, { id: note.id, type: 'note', title: note.title }, REL_TYPES.TASK_HAS_NOTE);
      }
      for (const decisionId of referencedIds(task, 'decision', ['decisionIds', 'linkedDecisionIds'])) {
        const decision = decisionsById.get(decisionId);
        if (decision) addEdge({ id: task.id, type: 'task', title: task.title }, { id: decision.id, type: 'decision', title: decision.title }, REL_TYPES.TASK_USES_DECISION);
      }
      for (const topicId of referencedIds(task, 'topic', ['topicIds', 'linkedTopicIds', 'relatedTopicIds'], ['topicId', 'linkedTopicId', 'relatedTopicId'])) {
        const topic = findTopic(topicsMap, topicId);
        addEdge({ id: task.id, type: 'task', title: task.title }, { id: topicId, type: 'topic', title: topic.label || topicId }, REL_TYPES.ACTION_LINKED_TOPIC);
      }
    }
  }

  // ── Goals → Errands ──
  for (const errand of (state.errands || [])) {
    for (const goalId of referencedIds(errand, 'goal', ['relatedGoalIds', 'linkedGoalIds'], ['goalId', 'relatedGoalId', 'linkedGoalId'])) {
      const goal = goalsById.get(goalId);
      if (goal) {
        addEdge(
            { id: goal.id, type: goalNodeType(goal), title: goal.title },
          { id: errand.id, type: 'errand', title: errand.title },
          REL_TYPES.GOAL_HAS_ERRAND,
        );
      }
    }
  }

  // ── Errands → Notes ──
  for (const errand of (state.errands || [])) {
    for (const noteId of referencedIds(errand, 'note', ['noteIds', 'linkedNoteIds', 'relatedNoteIds'])) {
      const note = notesById.get(noteId);
      if (note) {
        addEdge(
          { id: errand.id, type: 'errand', title: errand.title },
          { id: noteId, type: 'note', title: note.title },
          REL_TYPES.ERRAND_HAS_NOTE,
        );
      }
    }
  }

  // ── Notes → Topics ──
  for (const note of (state.notes || [])) {
    if (note.topicId) {
      const topic = findTopic(topicsMap, note.topicId);
      if (topic) {
        addEdge(
          { id: note.id, type: 'note', title: note.title },
          { id: note.topicId, type: 'topic', title: topic.label || note.topicId },
          REL_TYPES.NOTE_IN_TOPIC,
        );
      }
    }
  }

  // ── Errands → Topics ──
  for (const errand of (state.errands || [])) {
    if (errand.topicId) {
      const topic = findTopic(topicsMap, errand.topicId);
      if (topic) {
        addEdge(
          { id: errand.id, type: 'errand', title: errand.title },
          { id: errand.topicId, type: 'topic', title: topic.label || errand.topicId },
          REL_TYPES.ACTION_LINKED_TOPIC,
        );
      }
    }
  }

  // ── Strategic Goals → Current Goals ──
  for (const goal of (state.currentGoals || [])) {
    if (goal.relatedStrategicGoalId) {
      const sg = goalsById.get(goal.relatedStrategicGoalId);
      if (sg) {
        addEdge(
          { id: sg.id, type: 'strategicGoal', title: sg.title },
          { id: goal.id, type: 'currentGoal', title: goal.title },
          REL_TYPES.STRATEGIC_HAS_CURRENT,
        );
      }
    }
  }

  // ── Decisions → Goals ──
  for (const decision of (state.decisions || [])) {
    for (const goalId of referencedIds(decision, 'goal', ['relatedGoalIds', 'linkedGoalIds'], ['goalId', 'relatedGoalId', 'linkedGoalId'])) {
        const goal = goalsById.get(goalId);
        if (goal) {
          addEdge(
            { id: decision.id, type: 'decision', title: decision.title },
            { id: goalId, type: goalNodeType(goal), title: goal.title },
            REL_TYPES.DECISION_AFFECTS_GOAL,
          );
        }
      }
  }

  // ── Decisions → Notes ──
  for (const decision of (state.decisions || [])) {
    for (const noteId of referencedIds(decision, 'note', ['relatedNoteIds', 'linkedNoteIds'], ['noteId', 'linkedNoteId'])) {
        const note = notesById.get(noteId);
        if (note) {
          addEdge(
            { id: decision.id, type: 'decision', title: decision.title },
            { id: noteId, type: 'note', title: note.title },
            REL_TYPES.DECISION_REFERS_NOTE,
          );
        }
      }
  }

  // ── Decisions → Actions ───────────────────────────────────────────────
  // A direct action link is stronger than a coincidental shared goal: it says
  // this decision specifically governs or was changed by this execution item.
  for (const decision of (state.decisions || [])) {
    for (const actionId of referencedIds(decision, 'action', ['relatedActionIds', 'linkedActionIds'], ['relatedActionId', 'linkedActionId'])) {
      const task = tasksById.get(actionId);
      const errand = errandsById.get(actionId);
      const completed = completedById.get(actionId);
      const action = task || errand || completed;
      if (!action) continue;
      addEdge(
        { id: decision.id, type: 'decision', title: decision.title },
        { id: actionId, type: task ? 'task' : errand ? 'errand' : 'completedAction', title: action.title },
        REL_TYPES.DECISION_AFFECTS_ACTION,
      );
    }
  }

  // ── Decisions → Topics（通过 decision 的 relatedNoteIds 关联到 note 的 topicId）──
  for (const decision of (state.decisions || [])) {
    for (const noteId of referencedIds(decision, 'note', ['relatedNoteIds', 'linkedNoteIds'], ['noteId', 'linkedNoteId'])) {
        const note = notesById.get(noteId);
        if (note && note.topicId) {
          const topic = findTopic(topicsMap, note.topicId);
          if (topic) {
            addEdge(
              { id: decision.id, type: 'decision', title: decision.title },
              { id: note.topicId, type: 'topic', title: topic.label || note.topicId },
              REL_TYPES.DECISION_REFERS_TOPIC,
            );
          }
        }
      }
    for (const topicId of referencedIds(decision, 'topic', ['topicIds', 'linkedTopicIds', 'relatedTopicIds'], ['topicId', 'linkedTopicId', 'relatedTopicId'])) {
      const topic = findTopic(topicsMap, topicId);
      addEdge(
        { id: decision.id, type: 'decision', title: decision.title },
        { id: topicId, type: 'topic', title: topic.label || topicId },
        REL_TYPES.DECISION_REFERS_TOPIC,
      );
    }
  }

  // ── Goals → Topics（通过 goal 的 topicId 字段）──
  for (const goal of [...(state.currentGoals || []), ...(state.strategicGoals || []), ...(state.constraints || [])]) {
    if (goal.topicId) {
      const topic = findTopic(topicsMap, goal.topicId);
      if (topic) {
        addEdge(
          { id: goal.id, type: goalNodeType(goal), title: goal.title },
          { id: goal.topicId, type: 'topic', title: topic.label || goal.topicId },
          REL_TYPES.GOAL_IN_TOPIC,
        );
      }
    }
  }

  // ── Completed Actions → Notes ──
  for (const action of (state.completedActions || [])) {
    linkContextEntity(action, 'completedAction', action.title);
    for (const noteId of referencedIds(action, 'note', ['noteIds', 'linkedNoteIds', 'relatedNoteIds'])) {
      const note = notesById.get(noteId);
      if (note) {
        addEdge(
          { id: action.id, type: 'completedAction', title: action.title },
          { id: noteId, type: 'note', title: note.title },
          REL_TYPES.ERRAND_HAS_NOTE,
        );
      }
    }
  }

  // Follow-ups are durable planning context too. Leaving them out made an
  // explanation graph silently stop at the original task.
  for (const followUp of (state.followUps || [])) linkContextEntity(followUp, 'followUp', followUp.title);

  const result = { nodes, edges, adjacency };

  // PERF #25: Cache the built graph for this state version
  if (stateVersion !== undefined) {
    _graphCache = { stateVersion, graph: result };
  }

  return result;
}

// ─── Query: getRelated ──────────────────────────────────────────────────

/**
 * Get all entities directly related to a given entity.
 *
 * @param {Object} state - Full state
 * @param {string} entityId - The entity to look up
 * @param {Object} [opts]
 * @param {string[]} [opts.relTypes] - Filter by relationship types
 * @param {number} [opts.depth=1] - How many hops to traverse (1 = direct only)
 * @returns {{ entity: Object, related: Array<{ id, type, title, relType, hops }> }}
 */
function getRelated(state, entityId, opts = {}) {
  const graph = buildGraph(state);
  const depth = opts.depth || 1;
  const relFilter = opts.relTypes ? new Set(opts.relTypes) : null;

  const visited = new Set([entityId]);
  const results = [];
  let frontier = [entityId];

  for (let hop = 1; hop <= depth; hop++) {
    const nextFrontier = [];
    for (const nodeId of frontier) {
      const neighbors = graph.adjacency.get(nodeId) || [];
      for (const { target, relType } of neighbors) {
        if (visited.has(target)) continue;
        visited.add(target);
        if (relFilter && !relFilter.has(relType)) continue;

        const nodeData = graph.nodes.get(target);
        if (nodeData) {
          results.push({ ...nodeData, relType, hops: hop });
        }
        nextFrontier.push(target);
      }
    }
    frontier = nextFrontier;
  }

  const sourceNode = graph.nodes.get(entityId);
  return {
    entity: sourceNode || { id: entityId, type: 'unknown', title: entityId },
    related: results,
  };
}

// ─── Query: findPath ────────────────────────────────────────────────────

/**
 * Find a path between two entities using BFS.
 * Returns the shortest path with entity details and relationship types.
 *
 * @param {Object} state - Full state
 * @param {string} fromId - Start entity ID
 * @param {string} toId - Target entity ID
 * @param {Object} [opts]
 * @param {number} [opts.maxHops=6] - Maximum hops to search
 * @returns {{ path: Array<{ id, type, title }>, edges: Array<{ from, to, relType }>, found: boolean, length: number }}
 */
function findPath(state, fromId, toId, opts = {}) {
  const graph = buildGraph(state);
  const maxHops = opts.maxHops || 6;

  if (fromId === toId) {
    const node = graph.nodes.get(fromId);
    return { path: node ? [node] : [], edges: [], found: !!node, length: 0 };
  }

  // BFS
  const visited = new Set([fromId]);
  const queue = [{ id: fromId, path: [fromId], edgePath: [] }];

  while (queue.length > 0) {
    const { id, path, edgePath } = queue.shift();
    if (path.length > maxHops + 1) continue;

    const neighbors = graph.adjacency.get(id) || [];
    for (const { target, relType } of neighbors) {
      if (visited.has(target)) continue;
      visited.add(target);

      const newPath = [...path, target];
      const newEdgePath = [...edgePath, { from: id, to: target, relType }];

      if (target === toId) {
        return {
          path: newPath.map(nid => graph.nodes.get(nid) || { id: nid, type: 'unknown', title: nid }),
          edges: newEdgePath,
          found: true,
          length: newPath.length - 1,
        };
      }

      queue.push({ id: target, path: newPath, edgePath: newEdgePath });
    }
  }

  return { path: [], edges: [], found: false, length: -1 };
}

// ─── Query: explainEntity ────────────────────────────────────────────────

/**
 * Build an explanation graph for why an entity matters today.
 * Returns all paths from the entity to: goals, decisions, constraints, value system.
 *
 * @param {Object} state - Full state
 * @param {string} entityId - The entity to explain
 * @returns {{ entity: Object, connections: Array<{ path, targetNode, relType }>, summary: string }}
 */
function explainEntity(state, entityId) {
  const graph = buildGraph(state);
  const node = graph.nodes.get(entityId);
  if (!node) return { entity: { id: entityId, type: 'unknown', title: entityId }, connections: [], summary: 'Entity not found' };

  // BFS to find all connected goals, decisions, constraints, topics
  const visited = new Set([entityId]);
  const queue = [{ id: entityId, path: [entityId] }];
  const connections = [];

  const targetTypes = new Set(['strategicGoal', 'currentGoal', 'constraint', 'decision', 'topic']);

  while (queue.length > 0) {
    const { id, path } = queue.shift();
    if (path.length > 5) continue; // max 5 hops

    const neighbors = graph.adjacency.get(id) || [];
    for (const { target, relType } of neighbors) {
      if (visited.has(target)) continue;
      visited.add(target);

      const targetNode = graph.nodes.get(target);
      if (!targetNode) continue;

      // Build path labels
      const pathLabels = path.map(nid => graph.nodes.get(nid)?.title || nid).concat([targetNode.title]);

      if (targetTypes.has(targetNode.type)) {
        connections.push({
          path: pathLabels.join(' → '),
          targetNode,
          relType,
          hops: path.length,
        });
      }

      queue.push({ id: target, path: [...path, target] });
    }
  }

  return {
    entity: node,
    connections,
    summary: connections.length > 0
      ? `Connected to ${connections.length} important entities: ${connections.map(c => c.targetNode.title).join(', ')}`
      : 'No significant connections found',
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findGoal(state, goalId) {
  return (state.currentGoals || []).find(g => g.id === goalId)
    || (state.strategicGoals || []).find(g => g.id === goalId)
    || null;
}

function findTopic(topicsMap, topicId) {
  // 从 buildGraph 内部构建的 topicsMap 查找，避免循环依赖 brain-index
  if (topicsMap && topicsMap.has(topicId)) {
    return topicsMap.get(topicId);
  }
  return { id: topicId, label: topicId };
}

module.exports = {
  getRelated,
  findPath,
  explainEntity,
};
