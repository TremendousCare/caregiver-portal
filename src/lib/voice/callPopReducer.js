// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 1 PR 3 — call-pop reducer
//
// Pure state machine that converts a stream of call_sessions row
// changes (from Supabase Realtime postgres_changes) into the UI
// state needed to render IncomingCallToast and ActiveCallBar.
//
// Kept Deno-free and React-free so vitest can exercise every
// transition without spinning up a component tree. Same testability
// philosophy as the upsert / parse helpers in the telephony webhook.
// ─────────────────────────────────────────────────────────────────

/** @typedef {'ringing'|'answered'|'ended'|'missed'|'voicemail'} CallStatus */

/**
 * Shape of one call we're currently tracking in the UI.
 * `name` and `pipelinePhase` are looked up by the provider after
 * the row arrives; the reducer treats them as optional.
 *
 * @typedef {{
 *   id: string,
 *   telephonySessionId: string,
 *   direction: 'inbound'|'outbound',
 *   status: CallStatus,
 *   fromE164: string|null,
 *   toE164: string|null,
 *   matchedEntityType: 'caregiver'|'client'|null,
 *   matchedEntityId: string|null,
 *   matchedEntityName: string|null,
 *   pipelinePhase: string|null,
 *   startedAt: string|null,
 *   answeredAt: string|null,
 *   endedAt: string|null,
 *   durationSeconds: number|null,
 *   updatedAt: string|null,
 *   dismissed: boolean,
 * }} VoiceCall
 */

/**
 * @typedef {{
 *   activeCall: VoiceCall|null,
 *   recentlyEnded: VoiceCall|null,
 * }} VoiceState
 */

/** @type {VoiceState} */
export const initialVoiceState = {
  activeCall: null,
  recentlyEnded: null,
};

const TERMINAL_STATUSES = new Set(['ended', 'missed', 'voicemail']);

/**
 * Normalise a Supabase Realtime payload row (camel-case → camel-case
 * after the column→property map already done by the listener) into
 * a VoiceCall. The listener is responsible for setting matchedEntityName
 * and pipelinePhase; the reducer just preserves them.
 *
 * @param {Record<string, any>} row
 * @returns {VoiceCall}
 */
export function rowToVoiceCall(row) {
  return {
    id: String(row.id),
    telephonySessionId: row.telephony_session_id ?? row.telephonySessionId ?? '',
    direction: row.direction,
    status: row.status,
    fromE164: row.from_e164 ?? row.fromE164 ?? null,
    toE164: row.to_e164 ?? row.toE164 ?? null,
    matchedEntityType: row.matched_entity_type ?? row.matchedEntityType ?? null,
    matchedEntityId: row.matched_entity_id ?? row.matchedEntityId ?? null,
    matchedEntityName: row.matchedEntityName ?? null,
    pipelinePhase: row.pipelinePhase ?? null,
    startedAt: row.started_at ?? row.startedAt ?? null,
    answeredAt: row.answered_at ?? row.answeredAt ?? null,
    endedAt: row.ended_at ?? row.endedAt ?? null,
    durationSeconds: row.duration_seconds ?? row.durationSeconds ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
    dismissed: false,
  };
}

/**
 * Apply a freshly-received row (INSERT or UPDATE) to the existing
 * state. Returns a new state object.
 *
 * Behaviour rules:
 *   - INSERT or UPDATE of a row whose id matches the active call
 *     merges new fields onto the active call.
 *   - INSERT of a new row when no active call exists becomes the
 *     active call (the screen-pop fires).
 *   - INSERT of a new row when an active call exists takes over
 *     ONLY if the existing call is terminal (ended/missed/voicemail).
 *     A second ringing while you're on a live call is rare and
 *     better surfaced as a separate notification — left as a no-op
 *     for now so we don't yank the screen mid-call.
 *   - Terminal status on the active call moves it to recentlyEnded
 *     and clears activeCall. The toast component reads recentlyEnded
 *     to flash a "Call ended" message before the bar disappears.
 *   - Once dismissed, an active call stays dismissed across UPDATEs
 *     until it transitions to terminal (so a missed-call toast
 *     popping back up is impossible after dismissal).
 *
 * @param {VoiceState} state
 * @param {VoiceCall} incoming
 * @returns {VoiceState}
 */
export function applyRowEvent(state, incoming) {
  // Same-row update path.
  if (state.activeCall && state.activeCall.id === incoming.id) {
    const merged = mergeCall(state.activeCall, incoming);
    if (TERMINAL_STATUSES.has(merged.status)) {
      return { activeCall: null, recentlyEnded: merged };
    }
    return { ...state, activeCall: merged };
  }

  // New row arriving.
  if (!state.activeCall || TERMINAL_STATUSES.has(state.activeCall.status)) {
    // Skip late-arriving terminal-only rows when nothing's active —
    // no screen-pop for events that resolve straight to missed without
    // a ringing event we ever saw. We still write them to recentlyEnded
    // so a downstream "recent calls" widget can surface them.
    if (TERMINAL_STATUSES.has(incoming.status)) {
      return { ...state, recentlyEnded: incoming };
    }
    return { activeCall: incoming, recentlyEnded: state.recentlyEnded };
  }

  // Active call is live and a different row arrived — no-op (don't
  // yank the screen). The new row will be picked up if/when the
  // current active call ends.
  return state;
}

/**
 * Mark the active call as dismissed. Used when the user clicks the
 * "X" on the IncomingCallToast — they want to keep working without
 * the popup blocking them. The active-call bar stays visible since
 * the call is still in progress.
 *
 * @param {VoiceState} state
 * @returns {VoiceState}
 */
export function dismissActiveCall(state) {
  if (!state.activeCall) return state;
  return {
    ...state,
    activeCall: { ...state.activeCall, dismissed: true },
  };
}

/**
 * Clear the recently-ended call. Called by the IncomingCallToast on
 * a short timer after the call goes terminal, so the toast doesn't
 * hang around forever.
 *
 * @param {VoiceState} state
 * @returns {VoiceState}
 */
export function clearRecentlyEnded(state) {
  if (!state.recentlyEnded) return state;
  return { ...state, recentlyEnded: null };
}

/**
 * Merge a fresh row into an existing call. Preserve `dismissed` and
 * any frontend-only fields (matchedEntityName, pipelinePhase) that
 * the provider has already resolved from a separate query.
 *
 * @param {VoiceCall} existing
 * @param {VoiceCall} incoming
 * @returns {VoiceCall}
 */
function mergeCall(existing, incoming) {
  return {
    ...incoming,
    matchedEntityName: incoming.matchedEntityName ?? existing.matchedEntityName,
    pipelinePhase: incoming.pipelinePhase ?? existing.pipelinePhase,
    dismissed: existing.dismissed,
  };
}

/**
 * Convenience selector — should the IncomingCallToast be visible?
 * True when we have an active, undismissed call, OR when a recently
 * ended call should briefly flash a "Call ended" notice.
 *
 * @param {VoiceState} state
 * @returns {boolean}
 */
export function shouldShowToast(state) {
  if (state.activeCall && !state.activeCall.dismissed) return true;
  if (state.recentlyEnded) return true;
  return false;
}

/**
 * Convenience selector — should the ActiveCallBar render at the
 * bottom of the screen? True only when the call is actually live
 * (answered) — we don't render the bar during ringing because the
 * toast carries enough info and the bar starts to feel cluttered.
 *
 * @param {VoiceState} state
 * @returns {boolean}
 */
export function shouldShowActiveBar(state) {
  return !!state.activeCall && state.activeCall.status === 'answered';
}
