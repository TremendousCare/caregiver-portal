// Pure (Deno-free) helpers for the call_sessions upsert path.
// Kept here so the row-shaping logic is testable from Vitest without
// spinning up an edge function.

import type { CallEventNormalized } from './parse.ts';
import { resolveTargetStatus } from './parse.ts';

export interface ExistingCallSessionRow {
  id: string;
  status: CallEventNormalized['status'];
  answered_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  recording_id: string | null;
  matched_user_id: string | null;
  matched_entity_type: string | null;
  matched_entity_id: string | null;
}

export interface CallSessionUpsertPlan {
  /**
   * The final status that should be written. May equal the existing status
   * if the incoming event is older (a late retransmit) — in which case
   * `shouldUpdateNonStatusFields` is still true for things like
   * recording_id and raw_event_payload.
   */
  status: CallEventNormalized['status'];
  /**
   * The timestamp fields that should be set/updated on this upsert call.
   * Existing values win (we never overwrite an earlier started_at).
   */
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  /** Was this an outright regression (eg. ringing-after-answered late event)? */
  isLateRetransmit: boolean;
}

/**
 * Decide what timestamps + status to write given the existing row (which
 * may be null on first event) and the freshly-parsed event. The caller
 * supplies `now` for testability.
 */
export function planCallSessionUpsert(
  existing: ExistingCallSessionRow | null,
  incoming: CallEventNormalized,
  now: Date = new Date(),
): CallSessionUpsertPlan {
  const resolvedStatus = resolveTargetStatus(existing?.status, incoming.status);
  const isLateRetransmit = !!existing && resolvedStatus !== incoming.status;
  const eventTimeIso = incoming.eventTime || now.toISOString();

  // started_at: lock in on first event, never overwrite.
  const startedAt = existing?.started_at || eventTimeIso;

  // answered_at: lock in the first time we see 'answered'.
  let answeredAt = existing?.answered_at || null;
  if (!answeredAt && resolvedStatus === 'answered') {
    answeredAt = eventTimeIso;
  }
  // Edge case: existing row was already 'answered' and never got an
  // answered_at (eg. status came in via a non-Answered party). Backfill.
  if (!answeredAt && existing?.status === 'answered') {
    answeredAt = existing.started_at || eventTimeIso;
  }

  // ended_at: lock in once any terminal status is reached.
  const isTerminal =
    resolvedStatus === 'ended' ||
    resolvedStatus === 'missed' ||
    resolvedStatus === 'voicemail';
  let endedAt = existing?.ended_at || null;
  if (!endedAt && isTerminal && !isLateRetransmit) {
    endedAt = eventTimeIso;
  }

  // duration_seconds: only meaningful when we have both answered_at and
  // ended_at. Computed off the resolved timestamps so the value lines up
  // with what's actually persisted.
  let durationSeconds: number | null = null;
  if (answeredAt && endedAt) {
    const ms = Date.parse(endedAt) - Date.parse(answeredAt);
    if (Number.isFinite(ms) && ms >= 0) {
      durationSeconds = Math.round(ms / 1000);
    }
  }

  return {
    status: resolvedStatus,
    startedAt,
    answeredAt,
    endedAt,
    durationSeconds,
    isLateRetransmit,
  };
}

/**
 * Dedupe key for a Telephony Sessions event. RC retransmits events on
 * webhook retry; we use (sessionId, partyId, status) as the natural
 * dedupe key. Two events with the same triple are effectively identical
 * from our perspective and the second can be skipped.
 */
export function buildEventDedupeKey(
  event: CallEventNormalized,
): string {
  return [
    event.telephonySessionId,
    event.partyId || '_',
    event.status,
  ].join('|');
}
