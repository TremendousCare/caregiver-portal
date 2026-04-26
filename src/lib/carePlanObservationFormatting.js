// ─── Pure formatting helpers for care_plan_observations ───
//
// Used by the admin-side views (ShiftCarePlanLog, CarePlanActivity) to
// render observations the caregiver logged. No I/O, no DOM — these
// translate raw observation rows into display-ready { icon, label,
// detail, tone } shapes.
//
// Tone is one of: 'success' | 'warning' | 'danger' | 'neutral' | 'note'.
// Drives colour coding without coupling these helpers to specific CSS
// class names.

const RATING_LABEL = {
  done: 'Done',
  partial: 'Partial',
  not_done: 'Not done',
};

const RATING_TONE = {
  done: 'success',
  partial: 'warning',
  not_done: 'danger',
};

const RATING_ICON = {
  done: '✓',
  partial: '◐',
  not_done: '✗',
};

/**
 * Render an observation as { icon, label, detail, tone }.
 *
 *   - icon    a single-glyph hint (✓, ✗, ✎, ⚠, etc.) the UI prepends
 *   - label   short title for the row ("Bathing — Done", "Refused")
 *   - detail  optional secondary line (note text, refusal reason)
 *   - tone    'success' | 'warning' | 'danger' | 'neutral' | 'note'
 *
 * The taskMap is a Map(taskId → task) used to resolve task names. If
 * an observation references a task we can't find, the label falls
 * back to "(deleted task)" so the row still renders meaningfully —
 * deleted-task observations are real history that shouldn't disappear.
 */
export function formatObservation(obs, taskMap) {
  if (!obs) return null;

  const taskName = obs.taskId
    ? (taskMap?.get?.(obs.taskId)?.taskName || '(deleted task)')
    : null;

  switch (obs.observationType) {
    case 'task_completion': {
      const ratingLabel = RATING_LABEL[obs.rating] || 'Logged';
      const tone = RATING_TONE[obs.rating] || 'neutral';
      const icon = RATING_ICON[obs.rating] || '•';
      return {
        icon,
        label: taskName ? `${taskName} — ${ratingLabel}` : ratingLabel,
        detail: obs.note || null,
        tone,
      };
    }
    case 'refusal':
      return {
        icon: '⚠',
        label: taskName ? `Refused: ${taskName}` : 'Refused',
        detail: obs.note || null,
        tone: 'danger',
      };
    case 'shift_note':
      return {
        icon: '✎',
        label: 'Shift note',
        detail: obs.note || null,
        tone: 'note',
      };
    case 'mood':
      return {
        icon: '☺',
        label: obs.rating ? `Mood: ${obs.rating}` : 'Mood logged',
        detail: obs.note || null,
        tone: 'neutral',
      };
    case 'concern':
      return {
        icon: '!',
        label: 'Concern',
        detail: obs.note || null,
        tone: 'warning',
      };
    case 'positive':
      return {
        icon: '★',
        label: 'Positive moment',
        detail: obs.note || null,
        tone: 'success',
      };
    case 'vital':
      return {
        icon: '♡',
        label: obs.rating ? `Vitals: ${obs.rating}` : 'Vitals logged',
        detail: obs.note || null,
        tone: 'neutral',
      };
    case 'general':
    default:
      return {
        icon: '•',
        label: 'Observation',
        detail: obs.note || null,
        tone: 'neutral',
      };
  }
}

/**
 * Group observations by task_id for the per-task summary view used in
 * the per-shift admin panel. Returns Map(taskId → observations[]).
 * Observations not tied to a task land under the special key '__none__'.
 *
 * Stable order within each group: ascending by loggedAt. The component
 * decides per-task whether "latest wins" (task_completion) or "show
 * everything" (refusals, notes).
 */
export function groupObservationsByTask(observations) {
  const groups = new Map();
  if (!Array.isArray(observations)) return groups;
  for (const obs of observations) {
    if (!obs) continue;
    const key = obs.taskId || '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(obs);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt));
  }
  return groups;
}

/**
 * Group observations by shift_id for the per-client timeline. Returns
 * an array of { shiftId, observations } sorted newest-first, where
 * "newest" is the most recent loggedAt within each group.
 *
 * Observations without a shift_id (rare — office check-in calls etc.)
 * land in a synthetic group with shiftId = null, sorted by their own
 * loggedAt.
 */
export function groupObservationsByShift(observations) {
  if (!Array.isArray(observations) || observations.length === 0) return [];
  const map = new Map();
  for (const obs of observations) {
    if (!obs) continue;
    const key = obs.shiftId || '__none__';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(obs);
  }
  const groups = Array.from(map, ([shiftId, list]) => {
    list.sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt));
    const newestAt = list[list.length - 1]?.loggedAt;
    return {
      shiftId: shiftId === '__none__' ? null : shiftId,
      observations: list,
      newestAt,
    };
  });
  groups.sort((a, b) => new Date(b.newestAt) - new Date(a.newestAt));
  return groups;
}

/**
 * Pick the latest task_completion per task_id from a flat observation
 * list. Returns Map(taskId → observation). Mirrors the helper in
 * src/lib/carePlanShift.js but lives here so the admin views don't
 * pull in caregiver-side dependencies.
 */
export function indexLatestRatings(observations) {
  const out = new Map();
  if (!Array.isArray(observations)) return out;
  for (const obs of observations) {
    if (!obs || obs.observationType !== 'task_completion' || !obs.taskId) continue;
    const prior = out.get(obs.taskId);
    if (!prior || new Date(obs.loggedAt) >= new Date(prior.loggedAt)) {
      out.set(obs.taskId, obs);
    }
  }
  return out;
}

/**
 * Pick the latest shift_note observation, or null if none. Append-only
 * data model: shows the most recent note as the current shift summary.
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
