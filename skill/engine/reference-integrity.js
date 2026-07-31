/**
 * Referential-integrity helpers for canonical user entities.
 *
 * Notes may be removed from the panel or through MCP.  Action context is a
 * convenience link, never a second copy of the note, so every durable note
 * reference must be removed in the same state mutation as the note itself.
 */

function withoutId(values, id) {
  if (!Array.isArray(values)) return values;
  return values.filter(value => value !== id);
}

function scrubActionNoteReferences(action, noteId) {
  if (!action || typeof action !== 'object') return false;
  let changed = false;
  for (const key of ['noteIds', 'linkedNoteIds', 'relatedNoteIds']) {
    if (!Array.isArray(action[key])) continue;
    const next = withoutId(action[key], noteId);
    if (next.length !== action[key].length) {
      action[key] = next;
      changed = true;
    }
  }
  for (const key of ['noteId', 'linkedNoteId', 'relatedNoteId']) {
    if (action[key] === noteId) {
      action[key] = null;
      changed = true;
    }
  }
  if (Array.isArray(action.contextRefs)) {
    const next = action.contextRefs.filter(ref => !(ref && ref.type === 'note' && ref.id === noteId));
    if (next.length !== action.contextRefs.length) {
      action.contextRefs = next;
      changed = true;
    }
  }
  return changed;
}

function scrubDeletedNoteReferences(state, noteId) {
  const cleaned = {
    scheduleTasks: 0,
    errands: 0,
    completedActions: 0,
    goals: 0,
    decisions: 0,
    followUps: 0,
  };

  for (const day of Object.values(state.schedule?.days || {})) {
    for (const task of (day?.tasks || [])) {
      if (scrubActionNoteReferences(task, noteId)) cleaned.scheduleTasks++;
    }
  }
  // Goals may pin the notes they were built from (noteIds). Keep those links
  // honest when the note disappears, exactly like schedule tasks and errands.
  for (const goal of [...(state.strategicGoals || []), ...(state.currentGoals || []), ...(state.constraints || [])]) {
    if (scrubActionNoteReferences(goal, noteId)) cleaned.goals++;
  }
  for (const errand of (state.errands || [])) {
    if (scrubActionNoteReferences(errand, noteId)) cleaned.errands++;
  }
  for (const action of (state.completedActions || [])) {
    if (scrubActionNoteReferences(action, noteId)) cleaned.completedActions++;
  }
  for (const followUp of (state.followUps || [])) {
    if (scrubActionNoteReferences(followUp, noteId)) cleaned.followUps++;
  }
  for (const decision of (state.decisions || [])) {
    let changed = scrubActionNoteReferences(decision, noteId);
    if (Array.isArray(decision.relatedNoteIds)) {
      const next = withoutId(decision.relatedNoteIds, noteId);
      if (next.length !== decision.relatedNoteIds.length) {
        decision.relatedNoteIds = next;
        changed = true;
      }
    }
    if (changed) cleaned.decisions++;
  }

  return cleaned;
}

function scrubActionTopicReferences(action, topicId) {
  if (!action || typeof action !== 'object') return false;
  let changed = false;
  for (const key of ['topicId', 'linkedTopicId', 'relatedTopicId']) {
    if (action[key] === topicId) {
      action[key] = null;
      changed = true;
    }
  }
  for (const key of ['topicIds', 'linkedTopicIds', 'relatedTopicIds']) {
    if (!Array.isArray(action[key])) continue;
    const next = withoutId(action[key], topicId);
    if (next.length !== action[key].length) {
      action[key] = next;
      changed = true;
    }
  }
  if (Array.isArray(action.contextRefs)) {
    const next = action.contextRefs.filter(ref => !(ref && ref.type === 'topic' && ref.id === topicId));
    if (next.length !== action.contextRefs.length) {
      action.contextRefs = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * Detach durable entities from a deleted topic without deleting the entities.
 * A topic is a knowledge classification; schedule items and goals may point to
 * it, but do not belong to it in the ownership sense.
 */
function scrubDeletedTopicReferences(state, topicId) {
  const cleaned = {
    scheduleTasks: 0,
    errands: 0,
    completedActions: 0,
    goals: 0,
    decisions: 0,
    followUps: 0,
  };

  for (const day of Object.values(state.schedule?.days || {})) {
    for (const task of (day?.tasks || [])) {
      if (scrubActionTopicReferences(task, topicId)) cleaned.scheduleTasks++;
    }
  }
  for (const errand of (state.errands || [])) {
    if (scrubActionTopicReferences(errand, topicId)) cleaned.errands++;
  }
  for (const action of (state.completedActions || [])) {
    if (scrubActionTopicReferences(action, topicId)) cleaned.completedActions++;
  }
  for (const goal of [...(state.strategicGoals || []), ...(state.currentGoals || []), ...(state.constraints || [])]) {
    if (scrubActionTopicReferences(goal, topicId)) cleaned.goals++;
  }
  for (const decision of (state.decisions || [])) {
    if (scrubActionTopicReferences(decision, topicId)) cleaned.decisions++;
  }
  for (const followUp of (state.followUps || [])) {
    if (scrubActionTopicReferences(followUp, topicId)) cleaned.followUps++;
  }

  return cleaned;
}

function scrubDeletedGoalReferences(state, goalId) {
  const cleaned = { errands: 0, completedActions: 0, decisions: 0, followUps: 0 };
  const scrubAction = (action) => {
    if (!action || typeof action !== 'object') return false;
    let changed = false;
    for (const key of ['relatedGoalId', 'relatedStrategicGoalId', 'goalId', 'linkedGoalId']) {
      if (action[key] === goalId) {
        action[key] = null;
        changed = true;
      }
    }
    for (const key of ['relatedGoalIds', 'linkedGoalIds']) {
      if (Array.isArray(action[key])) {
        const next = withoutId(action[key], goalId);
        if (next.length !== action[key].length) {
          action[key] = next;
          changed = true;
        }
      }
    }
    if (Array.isArray(action.contextRefs)) {
      const next = action.contextRefs.filter(ref => !(ref && ref.type === 'goal' && ref.id === goalId));
      if (next.length !== action.contextRefs.length) {
        action.contextRefs = next;
        changed = true;
      }
    }
    return changed;
  };

  for (const errand of (state.errands || [])) if (scrubAction(errand)) cleaned.errands++;
  for (const action of (state.completedActions || [])) if (scrubAction(action)) cleaned.completedActions++;
  for (const decision of (state.decisions || [])) {
    let changed = false;
    if (Array.isArray(decision.relatedGoalIds)) {
      const next = withoutId(decision.relatedGoalIds, goalId);
      if (next.length !== decision.relatedGoalIds.length) {
        decision.relatedGoalIds = next;
        changed = true;
      }
    }
    if (scrubAction(decision)) changed = true;
    if (changed) cleaned.decisions++;
  }
  for (const followUp of (state.followUps || [])) if (scrubAction(followUp)) cleaned.followUps++;
  return cleaned;
}

function scrubDeletedDecisionReferences(state, decisionId) {
  const cleaned = { scheduleTasks: 0, errands: 0, completedActions: 0, followUps: 0 };
  const scrub = (action) => {
    if (!action || typeof action !== 'object') return false;
    let changed = false;
    for (const key of ['decisionIds', 'linkedDecisionIds']) {
      if (Array.isArray(action[key])) {
        const next = withoutId(action[key], decisionId);
        if (next.length !== action[key].length) {
          action[key] = next;
          changed = true;
        }
      }
    }
    if (Array.isArray(action.contextRefs)) {
      const next = action.contextRefs.filter(ref => !(ref && ref.type === 'decision' && ref.id === decisionId));
      if (next.length !== action.contextRefs.length) {
        action.contextRefs = next;
        changed = true;
      }
    }
    return changed;
  };
  for (const day of Object.values(state.schedule?.days || {})) {
    for (const task of (day?.tasks || [])) if (scrub(task)) cleaned.scheduleTasks++;
  }
  for (const errand of (state.errands || [])) if (scrub(errand)) cleaned.errands++;
  for (const action of (state.completedActions || [])) if (scrub(action)) cleaned.completedActions++;
  for (const followUp of (state.followUps || [])) if (scrub(followUp)) cleaned.followUps++;
  return cleaned;
}

// Decisions may point directly at a task, errand or completed action.  Keep
// that relationship honest when an action is removed or transformed.
function scrubDeletedActionReferences(state, actionId) {
  const cleaned = { decisions: 0, followUps: 0 };
  const scrub = (entity) => {
    if (!entity || typeof entity !== 'object') return false;
    let changed = false;
    for (const key of ['relatedActionIds', 'linkedActionIds']) {
      if (!Array.isArray(entity[key])) continue;
      const next = withoutId(entity[key], actionId);
      if (next.length !== entity[key].length) {
        entity[key] = next;
        changed = true;
      }
    }
    if (Array.isArray(entity.contextRefs)) {
      const next = entity.contextRefs.filter(ref => !(ref && ['task', 'errand', 'completedAction', 'action'].includes(ref.type) && ref.id === actionId));
      if (next.length !== entity.contextRefs.length) {
        entity.contextRefs = next;
        changed = true;
      }
    }
    return changed;
  };
  for (const decision of (state.decisions || [])) if (scrub(decision)) cleaned.decisions++;
  for (const followUp of (state.followUps || [])) if (scrub(followUp)) cleaned.followUps++;
  return cleaned;
}

function replaceActionReference(state, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return { decisions: 0, followUps: 0 };
  const changed = { decisions: 0, followUps: 0 };
  const replace = (entity) => {
    if (!entity || typeof entity !== 'object') return false;
    let didChange = false;
    for (const key of ['relatedActionIds', 'linkedActionIds']) {
      if (!Array.isArray(entity[key]) || !entity[key].includes(fromId)) continue;
      entity[key] = [...new Set(entity[key].map(value => value === fromId ? toId : value))];
      didChange = true;
    }
    if (Array.isArray(entity.contextRefs)) {
      for (const ref of entity.contextRefs) {
        if (ref && ['task', 'errand', 'completedAction', 'action'].includes(ref.type) && ref.id === fromId) {
          ref.id = toId;
          didChange = true;
        }
      }
    }
    return didChange;
  };
  for (const decision of (state.decisions || [])) if (replace(decision)) changed.decisions++;
  for (const followUp of (state.followUps || [])) if (replace(followUp)) changed.followUps++;
  return changed;
}

module.exports = {
  scrubDeletedNoteReferences,
  scrubDeletedGoalReferences,
  scrubDeletedDecisionReferences,
  scrubDeletedActionReferences,
  replaceActionReference,
  scrubDeletedTopicReferences,
};
