import { supabase, isSupabaseConfigured } from './supabase';
import { getCurrentPhase, getDaysInPhase, getDaysSinceApplication, isTaskDone } from './utils';
import { getClientPhase, getDaysInClientPhase, getDaysSinceCreated, isTaskDone as clientIsTaskDone } from '../features/clients/utils';

// ═══════════════════════════════════════════════════════════════
// Configurable Action Item Engine
//
// Evaluates rules from the action_item_rules table against
// caregiver/client data to produce prioritized action items.
// Falls back to hardcoded logic if rules haven't loaded yet.
//
// Evaluator logic extracted to _shared/helpers/evaluators.ts
// (Phase 4). This file re-exports for backward compatibility.
// ═══════════════════════════════════════════════════════════════

// ─── Shared Evaluators (from _shared/helpers/evaluators.ts) ──
// Re-exported so all existing imports from this file continue to work.

import {
  evaluatePhaseTime as _evaluatePhaseTime,
  evaluateTaskIncomplete as _evaluateTaskIncomplete,
  evaluateTaskStale as _evaluateTaskStale,
  evaluateDateExpiring as _evaluateDateExpiring,
  evaluateTimeSinceCreation as _evaluateTimeSinceCreation,
  evaluateLastNoteStale as _evaluateLastNoteStale,
  evaluateSprintDeadline as _evaluateSprintDeadline,
  EVALUATORS as _EVALUATORS,
  URGENCY_ORDER as _URGENCY_ORDER,
  resolveTemplate as _resolveTemplate,
  resolveUrgency as _resolveUrgency,
  evaluateRulesForEntity as _evaluateRulesForEntity,
} from '../../supabase/functions/_shared/helpers/evaluators.ts';

export const evaluatePhaseTime = _evaluatePhaseTime;
export const evaluateTaskIncomplete = _evaluateTaskIncomplete;
export const evaluateTaskStale = _evaluateTaskStale;
export const evaluateDateExpiring = _evaluateDateExpiring;
export const evaluateTimeSinceCreation = _evaluateTimeSinceCreation;
export const evaluateLastNoteStale = _evaluateLastNoteStale;
export const evaluateSprintDeadline = _evaluateSprintDeadline;
export const resolveTemplate = _resolveTemplate;
export const evaluateRulesForEntity = _evaluateRulesForEntity;

const EVALUATORS = _EVALUATORS;
const URGENCY_ORDER = _URGENCY_ORDER;
const resolveUrgency = _resolveUrgency;

// ─── Rules Cache ─────────────────────────────────────────────

let _rulesCache = null;
let _rulesLoading = false;

export function getActionItemRules() {
  return _rulesCache;
}

export async function loadActionItemRules() {
  if (!isSupabaseConfigured()) return null;
  if (_rulesLoading) return _rulesCache;

  _rulesLoading = true;
  try {
    const { data, error } = await supabase
      .from('action_item_rules')
      .select('*')
      .eq('enabled', true)
      .order('sort_order', { ascending: true });

    if (!error && data) {
      _rulesCache = data;
    }
  } catch (err) {
    console.warn('Failed to load action item rules:', err);
  } finally {
    _rulesLoading = false;
  }
  return _rulesCache;
}

export function clearActionItemRulesCache() {
  _rulesCache = null;
}

// ─── Entity Adapters ─────────────────────────────────────────

const caregiverAdapter = {
  entityType: 'caregiver',
  getId: (cg) => cg.id,
  getName: (cg) => `${cg.firstName || ''} ${cg.lastName || ''}`.trim() || 'Unnamed',
  getPhase: (cg) => getCurrentPhase(cg),
  getDaysInPhase: (cg) => getDaysInPhase(cg),
  getDaysSinceCreation: (cg) => getDaysSinceApplication(cg),
  getMinutesSinceCreation: (cg) => {
    if (!cg.applicationDate) return 0;
    return (Date.now() - new Date(cg.applicationDate).getTime()) / 60000;
  },
  isTaskDone: (cg, taskId) => isTaskDone(cg.tasks?.[taskId]),
  getDateField: (cg, field) => cg[field] || null,
  getPhaseTimestamp: (cg, phase) => cg.phaseTimestamps?.[phase] || null,
  getLastNoteDate: (cg) => {
    const notes = cg.notes || [];
    if (notes.length === 0) return null;
    return Math.max(...notes.map((n) => new Date(n.timestamp || n.date || 0).getTime()));
  },
  isTerminalPhase: () => false,
};

const clientAdapter = {
  entityType: 'client',
  getId: (cl) => cl.id,
  getName: (cl) => `${cl.firstName || ''} ${cl.lastName || ''}`.trim() || 'Unnamed',
  getPhase: (cl) => getClientPhase(cl),
  getDaysInPhase: (cl) => getDaysInClientPhase(cl),
  getDaysSinceCreation: (cl) => getDaysSinceCreated(cl),
  getMinutesSinceCreation: (cl) => {
    if (!cl.createdAt) return 0;
    const created = typeof cl.createdAt === 'number' ? cl.createdAt : new Date(cl.createdAt).getTime();
    return (Date.now() - created) / 60000;
  },
  isTaskDone: (cl, taskId) => clientIsTaskDone(cl.tasks?.[taskId]),
  getDateField: (cl, field) => cl[field] || null,
  getPhaseTimestamp: (cl, phase) => cl.phaseTimestamps?.[phase] || null,
  getLastNoteDate: (cl) => {
    const notes = cl.notes || [];
    if (notes.length === 0) return null;
    return Math.max(...notes.map((n) => new Date(n.timestamp || n.date || 0).getTime()));
  },
  isTerminalPhase: (cl) => {
    const phase = getClientPhase(cl);
    return phase === 'won' || phase === 'lost';
  },
};

// ─── Generate from Rules ───────────────────────────────────────

function generateFromRules(entities, entityType) {
  const rules = _rulesCache;
  if (!rules || rules.length === 0) return null; // signal to use fallback

  const adapter = entityType === 'caregiver' ? caregiverAdapter : clientAdapter;
  const relevantRules = rules.filter((r) => r.entity_type === entityType);
  if (relevantRules.length === 0) return null;

  const items = [];
  for (const entity of entities) {
    const entityItems = evaluateRulesForEntity(entity, relevantRules, adapter);
    items.push(...entityItems);
  }

  items.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
  return items;
}

// ─── Exports (Drop-in replacements) ──────────────────────────
// These match the exact signatures of the old hardcoded engines
// so dashboards can swap imports without any other changes.

import { generateActionItems as hardcodedCaregiverEngine } from './actionEngine';
import { generateClientActionItems as hardcodedClientEngine } from '../features/clients/actionEngine';

export function generateActionItems(caregivers) {
  const result = generateFromRules(caregivers, 'caregiver');
  if (result !== null) return result;
  // Fallback to hardcoded engine while rules are loading
  return hardcodedCaregiverEngine(caregivers);
}

export function generateClientActionItems(clients) {
  const result = generateFromRules(clients, 'client');
  if (result !== null) return result;
  // Fallback to hardcoded engine while rules are loading
  return hardcodedClientEngine(clients);
}
