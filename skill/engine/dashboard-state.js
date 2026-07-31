'use strict';

// Shared read-model for the browser dashboard and Electron panel. Keeping this
// projection in one place prevents the two clients from showing different
// attention signals or daily-reflection results for the same state.

const AttentionEngine = require('./attention-engine');
const ReflectionEngine = require('./reflection-engine');
const { todayStr } = require('./date-utils');

function createDashboardState(state = {}, topicIndex = []) {
  let attentionSummary = null;
  try {
    const summary = AttentionEngine.getAttentionSummary(state, { lang: 'zh', maxResults: 50 });
    attentionSummary = { computedAt: summary.computedAt, byType: {} };
    for (const [type, items] of Object.entries(summary.byType || {})) {
      attentionSummary.byType[type] = items.map(item => ({
        id: item.id,
        type: item.type,
        title: item.title,
        signalStrength: item.signalStrength,
      }));
    }
  } catch {}

  let reflection = null;
  try {
    const today = todayStr();
    const hasCompleted = (state.completedActions || []).some(action => action.completedAt?.startsWith(today));
    if (hasCompleted) {
      // Reflection includes memory-lifecycle calculations. Run it on a copy so
      // merely opening the panel cannot mutate durable state.
      reflection = ReflectionEngine.generateReflection(JSON.parse(JSON.stringify(state)), { lang: 'zh', date: today });
    }
  } catch {}

  // The panel is an index-first client.  Shipping every note body on every
  // refresh makes a long knowledge base slow even when the cards are folded.
  // Note details are read only after the user opens one specific card.
  const noteSummaries = (state.notes || []).map(note => ({
    id: note.id,
    title: note.title || null,
    topicId: note.topicId || null,
    topicLabel: note.topicLabel || null,
    category: note.category || null,
    source: note.source || null,
    createdAt: note.createdAt || null,
    updatedAt: note.updatedAt || null,
    lastAccessedAt: note.lastAccessedAt || null,
    relatedDate: note.relatedDate || null,
    relatedTime: note.relatedTime || null,
    signal: note.signal || null,
    needsEnrichment: !!note.needsEnrichment,
    organizationStatus: note.organizationStatus || null,
    lifecycleState: note.lifecycleState || 'active',
    contentLength: String(note.content || '').length,
  }));

  return { ...state, notes: noteSummaries, topicIndex, attentionSummary, reflection };
}

module.exports = { createDashboardState };
