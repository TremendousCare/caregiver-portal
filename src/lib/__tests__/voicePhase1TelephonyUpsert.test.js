/**
 * Tests for supabase/functions/ringcentral-telephony-webhook/upsert.ts
 *
 * Covers the timestamp-locking and never-regress-status logic in
 * planCallSessionUpsert plus the dedupe-key shape.
 */

import { describe, it, expect } from 'vitest';
import {
  planCallSessionUpsert,
  buildEventDedupeKey,
} from '../../../supabase/functions/ringcentral-telephony-webhook/upsert.ts';

// Build a fully-shaped incoming event with overridable fields.
function event(overrides = {}) {
  return {
    telephonySessionId: 'tsess-1',
    partyId: 'party-1',
    direction: 'inbound',
    status: 'ringing',
    fromE164: '+15559876543',
    toE164: '+15551234567',
    extensionId: 'ext-100',
    eventTime: '2026-05-12T12:00:00.000Z',
    recordingId: null,
    ...overrides,
  };
}

function existing(overrides = {}) {
  return {
    id: 'cs-uuid-1',
    status: 'ringing',
    answered_at: null,
    started_at: '2026-05-12T11:59:59.500Z',
    ended_at: null,
    recording_id: null,
    matched_user_id: null,
    matched_entity_type: null,
    matched_entity_id: null,
    ...overrides,
  };
}

describe('planCallSessionUpsert — first event (no existing row)', () => {
  it('writes the incoming status and locks in started_at', () => {
    const plan = planCallSessionUpsert(null, event());
    expect(plan.status).toBe('ringing');
    expect(plan.startedAt).toBe('2026-05-12T12:00:00.000Z');
    expect(plan.answeredAt).toBe(null);
    expect(plan.endedAt).toBe(null);
    expect(plan.durationSeconds).toBe(null);
    expect(plan.isLateRetransmit).toBe(false);
  });

  it('sets answeredAt when the very first event is already Answered', () => {
    const plan = planCallSessionUpsert(null, event({ status: 'answered' }));
    expect(plan.status).toBe('answered');
    expect(plan.answeredAt).toBe('2026-05-12T12:00:00.000Z');
  });

  it('sets endedAt + duration when first event is terminal (rare but possible)', () => {
    const plan = planCallSessionUpsert(
      null,
      event({
        status: 'ended',
        eventTime: '2026-05-12T12:00:30.000Z',
      }),
    );
    expect(plan.endedAt).toBe('2026-05-12T12:00:30.000Z');
    // No answered_at → no duration computed.
    expect(plan.durationSeconds).toBe(null);
  });
});

describe('planCallSessionUpsert — answered → ended progression', () => {
  it('locks in answered_at on the answered event', () => {
    const plan = planCallSessionUpsert(
      existing({ status: 'ringing' }),
      event({ status: 'answered', eventTime: '2026-05-12T12:00:05.000Z' }),
    );
    expect(plan.status).toBe('answered');
    expect(plan.answeredAt).toBe('2026-05-12T12:00:05.000Z');
    expect(plan.endedAt).toBe(null);
  });

  it('computes duration when the ended event arrives', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'answered',
        answered_at: '2026-05-12T12:00:05.000Z',
      }),
      event({ status: 'ended', eventTime: '2026-05-12T12:02:35.000Z' }),
    );
    expect(plan.status).toBe('ended');
    expect(plan.endedAt).toBe('2026-05-12T12:02:35.000Z');
    expect(plan.durationSeconds).toBe(150); // 2 min 30 sec
  });
});

describe('planCallSessionUpsert — never go backwards', () => {
  it('ignores a late ringing event after the row is already answered', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'answered',
        answered_at: '2026-05-12T12:00:05.000Z',
      }),
      event({ status: 'ringing', eventTime: '2026-05-12T12:00:06.000Z' }),
    );
    expect(plan.status).toBe('answered');
    expect(plan.isLateRetransmit).toBe(true);
    // ended_at must not be stamped on a late retransmit even if our
    // status helper would have rolled it forward.
    expect(plan.endedAt).toBe(null);
  });

  it('ignores a late answered after ended', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'ended',
        answered_at: '2026-05-12T12:00:05.000Z',
        ended_at: '2026-05-12T12:02:35.000Z',
      }),
      event({ status: 'answered', eventTime: '2026-05-12T12:03:00.000Z' }),
    );
    expect(plan.status).toBe('ended');
    expect(plan.isLateRetransmit).toBe(true);
    expect(plan.endedAt).toBe('2026-05-12T12:02:35.000Z');
  });
});

describe('planCallSessionUpsert — missed / voicemail', () => {
  it('stamps ended_at on a ringing → missed transition (caller hangup)', () => {
    const plan = planCallSessionUpsert(
      existing({ status: 'ringing' }),
      event({ status: 'missed', eventTime: '2026-05-12T12:00:18.000Z' }),
    );
    expect(plan.status).toBe('missed');
    expect(plan.endedAt).toBe('2026-05-12T12:00:18.000Z');
    // No answered_at → no duration.
    expect(plan.durationSeconds).toBe(null);
  });

  it('stamps ended_at on a ringing → voicemail transition', () => {
    const plan = planCallSessionUpsert(
      existing({ status: 'ringing' }),
      event({ status: 'voicemail', eventTime: '2026-05-12T12:00:30.000Z' }),
    );
    expect(plan.status).toBe('voicemail');
    expect(plan.endedAt).toBe('2026-05-12T12:00:30.000Z');
  });
});

describe('planCallSessionUpsert — backfill answered_at if missing', () => {
  it('backfills answered_at when existing row was answered but timestamp is null', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'answered',
        answered_at: null,
        started_at: '2026-05-12T12:00:00.000Z',
      }),
      event({ status: 'ended', eventTime: '2026-05-12T12:02:00.000Z' }),
    );
    expect(plan.answeredAt).toBe('2026-05-12T12:00:00.000Z');
    expect(plan.endedAt).toBe('2026-05-12T12:02:00.000Z');
    expect(plan.durationSeconds).toBe(120);
  });
});

// ─────────────────────────────────────────────────────────────────
// Coerce missed → ended when the call was previously answered.
// RC fires Disconnected for every party at normal call end; without
// this coercion, a real-world hangup ends up as status='missed' and
// drops out of the post-call processor's pending-transcript index.
// ─────────────────────────────────────────────────────────────────

describe('planCallSessionUpsert — terminal-status coercion', () => {
  it('coerces missed → ended when existing.answered_at is set', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'answered',
        answered_at: '2026-05-12T12:00:05.000Z',
      }),
      event({ status: 'missed', eventTime: '2026-05-12T12:07:30.000Z' }),
    );
    expect(plan.status).toBe('ended');
    expect(plan.endedAt).toBe('2026-05-12T12:07:30.000Z');
    expect(plan.durationSeconds).toBe(445); // 7 min 25 sec
  });

  it('coerces missed → ended when existing.status is answered even with answered_at NULL', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'answered',
        answered_at: null,
        started_at: '2026-05-12T12:00:00.000Z',
      }),
      event({ status: 'missed', eventTime: '2026-05-12T12:05:00.000Z' }),
    );
    expect(plan.status).toBe('ended');
    // answered_at backfill should also kick in.
    expect(plan.answeredAt).toBe('2026-05-12T12:00:00.000Z');
  });

  it('keeps true missed when there is no existing row (caller hung up before pickup)', () => {
    const plan = planCallSessionUpsert(
      existing({ status: 'ringing', answered_at: null }),
      event({ status: 'missed', eventTime: '2026-05-12T12:00:18.000Z' }),
    );
    expect(plan.status).toBe('missed');
    // ended_at is still stamped on the missed transition.
    expect(plan.endedAt).toBe('2026-05-12T12:00:18.000Z');
  });

  it('does not coerce voicemail (only missed is coerced)', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'answered',
        answered_at: '2026-05-12T12:00:05.000Z',
      }),
      event({ status: 'voicemail', eventTime: '2026-05-12T12:00:30.000Z' }),
    );
    expect(plan.status).toBe('voicemail');
  });

  it('coercion still respects the never-go-backwards rule', () => {
    const plan = planCallSessionUpsert(
      existing({
        status: 'ended',
        answered_at: '2026-05-12T12:00:05.000Z',
        ended_at: '2026-05-12T12:02:00.000Z',
      }),
      event({ status: 'missed', eventTime: '2026-05-12T12:03:00.000Z' }),
    );
    // missed → coerced to ended → resolveTargetStatus(ended, ended) = ended.
    expect(plan.status).toBe('ended');
    // Original ended_at is preserved.
    expect(plan.endedAt).toBe('2026-05-12T12:02:00.000Z');
  });
});

describe('buildEventDedupeKey', () => {
  it('combines sessionId + partyId + status', () => {
    expect(buildEventDedupeKey(event())).toBe('tsess-1|party-1|ringing');
  });

  it('uses a placeholder when partyId is null', () => {
    expect(buildEventDedupeKey(event({ partyId: null }))).toBe('tsess-1|_|ringing');
  });

  it('changes when status changes (different state transitions key differently)', () => {
    const a = buildEventDedupeKey(event({ status: 'ringing' }));
    const b = buildEventDedupeKey(event({ status: 'answered' }));
    expect(a).not.toBe(b);
  });
});
