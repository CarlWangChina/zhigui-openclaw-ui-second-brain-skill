'use strict';

/**
 * Layer-0 manifest builder.
 *
 * Storage is layered: at the start of every conversation the AI reads ONE brief
 * document that lists what exists (this manifest). It only opens detailed docs
 * (Layer-2) when the conversation actually touches that item — minimal context,
 * maximum awareness.
 *
 * `state`  — the in-memory ZhiGui state (strategicGoals / currentGoals /
 *            constraints / errands / notes / events ...)
 * `brain`  — a BrainIndex instance (topics). Pass null to skip topic data.
 *
 * Every item is reduced to a cheap brief: id + short title + key status fields.
 * Constraints are intentionally title-only — the AI knows they exist but must
 * fetch the full goals+constraints document only when scheduling / conflict-checking.
 */
function buildOverview(state, brain) {
  const sg = (state.strategicGoals || []).map(g => ({
    id: g.id,
    title: g.title,
    deadline: g.deadline || null,
    priority: (typeof g.priority === 'number') ? g.priority : null,
    completed: !!g.completed,
  }));

  const cg = (state.currentGoals || []).map(g => ({
    id: g.id,
    title: g.title,
    deadline: g.deadline || null,
    daysLeft: (g.daysLeft !== undefined && g.daysLeft !== null) ? g.daysLeft : null,
    overdue: !!g.overdue,
    priority: (typeof g.priority === 'number') ? g.priority : null,
    strategicBinding: g.relatedStrategicGoalId || null,
    completed: !!g.completed,
  }));

  // Constraints: title-only on purpose. The full rule body lives in goals.json and
  // is fetched on demand via lingxi_get_document_by_type('goals').
  const constraints = (state.constraints || []).map(c => ({
    id: c.id,
    title: c.title,
  }));

  // Day records are also an index: the assistant knows which dates exist without
  // receiving task titles or times. It loads or creates one day only when needed.
  const scheduleDays = Object.entries(state.schedule?.days || {})
    .map(([date, day]) => ({
      date,
      taskCount: (day.tasks || []).length,
      completedCount: (day.tasks || []).filter(task => task.completed).length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const errands = (state.errands || []).map(e => ({
    id: e.id,
    title: e.title,
    priority: e.priority || null,
    date: e.date || null,
    completed: !!e.completed,
  }));

  let topics = [];
  const topicLabels = {};
  try {
    topics = (brain ? brain.getTopics() : []).map(t => ({
      id: t.id,
      label: t.label,
      noteCount: t.noteCount || 0,
      precipitated: !!t.precipitated,
      related: t.relatedCounts || {},
    }));
    for (const topic of topics) topicLabels[topic.id] = topic.label;
  } catch (e) { /* brain not initialised — topics omitted */ }

  // Titles are the note manifest. Bodies remain in per-note detail files and are
  // intentionally excluded so the AI knows what exists without preloading content.
  const notes = (state.notes || []).map(n => ({
    id: n.id,
    title: n.title || '待 AI 归纳',
    topicId: n.topicId || null,
    topicLabel: n.topicId ? (topicLabels[n.topicId] || n.topicId) : null,
    category: n.category || null,
    relatedDate: n.relatedDate || null,
    needsEnrichment: n.needsEnrichment === true,
  }));

  // Reviews are deliberately title-only. The assistant knows a confirmation is
  // pending without receiving the imported source text or silently resolving it.
  const pendingReviews = (state.pendingReviews || [])
    .filter(review => review?.status === 'pending')
    .map(review => ({
      id: review.id,
      type: review.type,
      noteId: review.noteId || null,
      title: review.title || review.proposal?.title || 'Pending confirmation',
    }));

  const counts = {
    strategicGoals: sg.length,
    currentGoals: cg.length,
    constraints: constraints.length,
    scheduledDays: scheduleDays.length,
    activeErrands: errands.filter(e => !e.completed).length,
    topics: topics.length,
    notes: notes.length,
    pendingNoteEnrichment: notes.filter(n => n.needsEnrichment).length,
    pendingReviews: pendingReviews.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    counts,
    strategicGoals: sg,
    currentGoals: cg,
    constraints,
    scheduleDays,
    errands,
    topics,
    notes,
    pendingReviews,
    hint: 'LAYER-0 manifest: note titles and classifications tell you WHAT exists; note bodies are deliberately absent. Load one body only when relevant with lingxi_get_note_detail(noteId), or a selected topic with lingxi_get_topic_document(topicId). Pending reviews are proposals that require user confirmation; do not apply them silently.',
  };
}

module.exports = { buildOverview };
