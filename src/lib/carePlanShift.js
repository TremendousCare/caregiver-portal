// ─── Care plan ↔ shift bridge for the caregiver PWA ───
//
// Loads the active care plan + its tasks for a given shift, and writes
// caregiver observations (task completions, shift notes, refusals) into
// care_plan_observations.
//
// Pure storage layer — no React, no UI state. The component layer
// (CarePlanChecklist, ShiftNotesField) calls these functions and
// renders accordingly.
//
// Reuses the existing care-plans storage helpers (getCarePlanForClient,
// getTasksForVersion) so we don't duplicate queries or mappers.

import { supabase, isSupabaseConfigured } from './supabase';
import {
  getCarePlanForClient,
  getTasksForVersion,
} from '../features/care-plans/storage';

// ─── Observation mapper ───────────────────────────────────────
// camelCase for the app, snake_case for the DB. The mapper is forgiving
// of missing optional fields so callers can pass a partial row.

export function dbToObservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    carePlanId: row.care_plan_id,
    versionId: row.version_id,
    taskId: row.task_id ?? null,
    shiftId: row.shift_id ?? null,
    caregiverId: row.caregiver_id ?? null,
    observationType: row.observation_type,
    rating: row.rating ?? null,
    note: row.note ?? null,
    loggedAt: row.logged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── loadCarePlanForShift ─────────────────────────────────────
//
// Returns:
//   { plan, version, tasks, observations }   on success (any field
//                                            may be empty/null if the
//                                            client has no plan yet)
//   null                                     when Supabase isn't
//                                            configured (dev/test)
//
// Never throws on missing data — the empty states are surfaced via
// null/empty arrays so the UI can render a coherent "no plan yet"
// message instead of an error banner.

export async function loadCarePlanForShift(shift) {
  if (!isSupabaseConfigured()) return null;
  const clientId = shift?.clientId ?? shift?.client_id ?? null;
  const shiftId = shift?.id ?? null;
  if (!clientId) {
    return { plan: null, version: null, tasks: [], observations: [] };
  }

  // 1. Plan + current version.
  const planRes = await getCarePlanForClient(clientId);
  if (!planRes || !planRes.plan) {
    return { plan: null, version: null, tasks: [], observations: [] };
  }
  const { plan, currentVersion } = planRes;

  // 2. Tasks for the current version (empty array if no published version).
  const tasks = currentVersion
    ? await getTasksForVersion(currentVersion.id)
    : [];

  // 3. This caregiver's observations on this shift. The PWA only ever
  // sees its own caregiver_id thanks to RLS, but we filter here too
  // for clarity and to keep the result tight.
  const observations = await loadObservationsForShift(shiftId);

  return { plan, version: currentVersion, tasks, observations };
}

async function loadObservationsForShift(shiftId) {
  if (!shiftId) return [];
  const { data, error } = await supabase
    .from('care_plan_observations')
    .select('*')
    .eq('shift_id', shiftId)
    .order('logged_at', { ascending: true });
  if (error) {
    // Surface the message but don't blow up the whole load — the
    // checklist can still render against an empty observation list.
    console.warn('loadObservationsForShift failed:', error.message);
    return [];
  }
  return (data || []).map(dbToObservation);
}

// ─── Inserts ──────────────────────────────────────────────────
// All four insert helpers share a common shape; thin wrappers below
// keep call sites readable and prevent forgetting required fields
// (observation_type / rating combinations are enforced by the DB
// CHECK constraints, but we preflight them here too).

async function insertObservation(row) {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await supabase
    .from('care_plan_observations')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return dbToObservation(data);
}

/**
 * Log a task-completion observation. Rating must be 'done' | 'partial'
 * | 'not_done' (DB CHECK enforces a free string but the UI only
 * generates these three).
 */
export async function logTaskObservation({
  carePlanId,
  versionId,
  taskId,
  shiftId,
  caregiverId,
  rating,
  note = null,
}) {
  if (!carePlanId || !versionId || !taskId) {
    throw new Error('logTaskObservation: carePlanId, versionId, and taskId are required.');
  }
  if (!['done', 'partial', 'not_done'].includes(rating)) {
    throw new Error(`logTaskObservation: invalid rating '${rating}'.`);
  }
  return insertObservation({
    care_plan_id: carePlanId,
    version_id: versionId,
    task_id: taskId,
    shift_id: shiftId ?? null,
    caregiver_id: caregiverId ?? null,
    observation_type: 'task_completion',
    rating,
    note: note?.trim() || null,
  });
}

/**
 * Log a free-form shift note. One observation per submission — the UI
 * decides when to fire (typically on a "Save Note" tap, not on every
 * keystroke). Append-only by design; admin sees the latest as the
 * current note.
 */
export async function logShiftNote({
  carePlanId,
  versionId,
  shiftId,
  caregiverId,
  note,
}) {
  if (!carePlanId || !versionId) {
    throw new Error('logShiftNote: carePlanId and versionId are required.');
  }
  const trimmed = (note || '').trim();
  if (!trimmed) {
    throw new Error('logShiftNote: note cannot be empty.');
  }
  return insertObservation({
    care_plan_id: carePlanId,
    version_id: versionId,
    task_id: null,
    shift_id: shiftId ?? null,
    caregiver_id: caregiverId ?? null,
    observation_type: 'shift_note',
    rating: null,
    note: trimmed,
  });
}

/**
 * Log a refusal — typically tied to a specific task ("client refused
 * morning meds"). taskId is optional only because not every refusal
 * lines up with a checklist item (e.g. "refused breakfast"); when in
 * doubt, leave taskId null and put the detail in `note`.
 */
export async function logRefusal({
  carePlanId,
  versionId,
  taskId = null,
  shiftId,
  caregiverId,
  note,
}) {
  if (!carePlanId || !versionId) {
    throw new Error('logRefusal: carePlanId and versionId are required.');
  }
  const trimmed = (note || '').trim();
  if (!trimmed) {
    throw new Error('logRefusal: note (reason) cannot be empty.');
  }
  return insertObservation({
    care_plan_id: carePlanId,
    version_id: versionId,
    task_id: taskId,
    shift_id: shiftId ?? null,
    caregiver_id: caregiverId ?? null,
    observation_type: 'refusal',
    rating: null,
    note: trimmed,
  });
}

// ─── Pure helpers for digesting an observation list ──────────
//
// The PWA loads every observation for the shift on first render and
// then derives the "current state" of each task in JS — append-only
// data model, latest wins. Pure functions so they're trivially
// unit-testable without round-tripping the DB.

/**
 * Build a Map(taskId → latest task_completion observation) so the
 * checklist can show each task's current rating. Falls back to an
 * empty Map for non-array input.
 */
export function indexLatestTaskCompletions(observations) {
  const index = new Map();
  if (!Array.isArray(observations)) return index;
  for (const obs of observations) {
    if (!obs || obs.observationType !== 'task_completion') continue;
    if (!obs.taskId) continue;
    const prior = index.get(obs.taskId);
    if (!prior || new Date(obs.loggedAt) >= new Date(prior.loggedAt)) {
      index.set(obs.taskId, obs);
    }
  }
  return index;
}

/**
 * Return the most recent shift_note observation, or null if none.
 * Append-only model: there can be many; the latest is the source of
 * truth shown in the textarea.
 */
export function pickLatestShiftNote(observations) {
  if (!Array.isArray(observations) || observations.length === 0) return null;
  let latest = null;
  for (const obs of observations) {
    if (!obs || obs.observationType !== 'shift_note') continue;
    if (!latest || new Date(obs.loggedAt) > new Date(latest.loggedAt)) {
      latest = obs;
    }
  }
  return latest;
}

/**
 * Return refusal observations in chronological order. Each refusal is
 * an event in its own right (not overwritten), so the UI lists them
 * all rather than picking one.
 */
export function listRefusals(observations) {
  if (!Array.isArray(observations)) return [];
  return observations
    .filter((o) => o && o.observationType === 'refusal')
    .slice()
    .sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt));
}
