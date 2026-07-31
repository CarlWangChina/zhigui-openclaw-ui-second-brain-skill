'use strict';

const ALLOWED_REF_TYPES = new Set(['note', 'decision']);
const ALLOWED_ROLES = new Set(['instruction', 'reference', 'constraint', 'decision_basis', 'result']);

function uniqueIds(values, limit = 20) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].slice(0, limit);
}

function normalizeContextRefs(payload = {}) {
  const refs = [];
  for (const raw of (Array.isArray(payload.contextRefs) ? payload.contextRefs : [])) {
    if (!raw || !ALLOWED_REF_TYPES.has(raw.type) || typeof raw.id !== 'string' || !raw.id.trim()) continue;
    refs.push({
      type: raw.type,
      id: raw.id.trim(),
      role: ALLOWED_ROLES.has(raw.role) ? raw.role : (raw.type === 'decision' ? 'decision_basis' : 'reference'),
    });
  }
  for (const id of uniqueIds(payload.noteIds)) refs.push({ type: 'note', id, role: 'reference' });
  for (const id of uniqueIds(payload.decisionIds)) refs.push({ type: 'decision', id, role: 'decision_basis' });

  const seen = new Set();
  return refs.filter(ref => {
    const key = `${ref.type}:${ref.id}:${ref.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);
}

function applyExecutionContext(entity, payload = {}) {
  if (payload.relatedGoalId !== undefined || payload.goalId !== undefined) {
    entity.relatedGoalId = payload.relatedGoalId || payload.goalId || null;
  }
  if (payload.relatedStrategicGoalId !== undefined) entity.relatedStrategicGoalId = payload.relatedStrategicGoalId || null;
  if (payload.topicId !== undefined) entity.topicId = payload.topicId || null;
  const refs = normalizeContextRefs(payload);
  if (refs.length || payload.contextRefs !== undefined || payload.noteIds !== undefined || payload.decisionIds !== undefined) {
    entity.contextRefs = refs;
    entity.noteIds = uniqueIds(refs.filter(ref => ref.type === 'note').map(ref => ref.id));
    entity.decisionIds = uniqueIds(refs.filter(ref => ref.type === 'decision').map(ref => ref.id));
  }
  if (payload.contextReason !== undefined) entity.contextReason = String(payload.contextReason || '').trim();
  if (payload.placementReason !== undefined) entity.placementReason = String(payload.placementReason || '').trim();
  return entity;
}

function validateContext(state, entity) {
  const goals = new Set([...(state.currentGoals || []), ...(state.strategicGoals || [])].map(goal => goal.id));
  const notes = new Set((state.notes || []).map(note => note.id));
  const decisions = new Set((state.decisions || []).map(decision => decision.id));
  const missing = [];
  if (entity.relatedGoalId && !goals.has(entity.relatedGoalId)) missing.push({ type: 'goal', id: entity.relatedGoalId });
  if (entity.relatedStrategicGoalId && !goals.has(entity.relatedStrategicGoalId)) missing.push({ type: 'goal', id: entity.relatedStrategicGoalId });
  for (const ref of normalizeContextRefs(entity)) {
    if (ref.type === 'note' && !notes.has(ref.id)) missing.push({ type: 'note', id: ref.id });
    if (ref.type === 'decision' && !decisions.has(ref.id)) missing.push({ type: 'decision', id: ref.id });
  }
  return { valid: missing.length === 0, missing };
}

module.exports = { uniqueIds, normalizeContextRefs, applyExecutionContext, validateContext };
