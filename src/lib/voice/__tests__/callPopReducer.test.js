/**
 * Tests for src/lib/voice/callPopReducer.js
 *
 * Pure reducer driving IncomingCallToast + ActiveCallBar visibility.
 * Covers the row → VoiceCall mapping, all transition rules
 * (no-active / same-row update / terminal moves to recentlyEnded /
 * second-ring-during-active no-op), dismiss behaviour, and the
 * selectors.
 */

import { describe, it, expect } from 'vitest';
import {
  initialVoiceState,
  rowToVoiceCall,
  applyRowEvent,
  dismissActiveCall,
  clearRecentlyEnded,
  shouldShowToast,
  shouldShowActiveBar,
} from '../callPopReducer';

function row(overrides = {}) {
  return {
    id: 'cs-1',
    telephony_session_id: 'tsess-1',
    direction: 'inbound',
    status: 'ringing',
    from_e164: '+19498732367',
    to_e164: '+17142691606',
    matched_entity_type: 'caregiver',
    matched_entity_id: 'cg-1',
    started_at: '2026-05-12T20:00:00.000Z',
    answered_at: null,
    ended_at: null,
    duration_seconds: null,
    updated_at: '2026-05-12T20:00:00.000Z',
    ...overrides,
  };
}

// ─── rowToVoiceCall ────────────────────────────────────────────

describe('rowToVoiceCall', () => {
  it('maps snake_case DB row to camelCase VoiceCall', () => {
    const call = rowToVoiceCall(row());
    expect(call.id).toBe('cs-1');
    expect(call.telephonySessionId).toBe('tsess-1');
    expect(call.direction).toBe('inbound');
    expect(call.status).toBe('ringing');
    expect(call.fromE164).toBe('+19498732367');
    expect(call.toE164).toBe('+17142691606');
    expect(call.matchedEntityType).toBe('caregiver');
    expect(call.matchedEntityId).toBe('cg-1');
    expect(call.matchedEntityName).toBe(null);
    expect(call.dismissed).toBe(false);
  });

  it('handles missing optional fields without throwing', () => {
    const call = rowToVoiceCall({ id: 'x', direction: 'outbound', status: 'ringing' });
    expect(call.fromE164).toBe(null);
    expect(call.toE164).toBe(null);
    expect(call.matchedEntityType).toBe(null);
  });
});

// ─── applyRowEvent ─────────────────────────────────────────────

describe('applyRowEvent — first event creates active call', () => {
  it('makes a ringing row the active call when none was active', () => {
    const incoming = rowToVoiceCall(row({ status: 'ringing' }));
    const next = applyRowEvent(initialVoiceState, incoming);
    expect(next.activeCall?.id).toBe('cs-1');
    expect(next.activeCall?.status).toBe('ringing');
    expect(next.recentlyEnded).toBe(null);
  });

  it('terminal-only first event lands in recentlyEnded without popping the toast as active', () => {
    const incoming = rowToVoiceCall(row({ status: 'missed', answered_at: null }));
    const next = applyRowEvent(initialVoiceState, incoming);
    expect(next.activeCall).toBe(null);
    expect(next.recentlyEnded?.status).toBe('missed');
  });
});

describe('applyRowEvent — same-row updates', () => {
  it('merges status updates onto the existing active call', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);

    const answered = rowToVoiceCall(
      row({ status: 'answered', answered_at: '2026-05-12T20:00:05.000Z' }),
    );
    const s2 = applyRowEvent(s1, answered);
    expect(s2.activeCall?.status).toBe('answered');
    expect(s2.activeCall?.answeredAt).toBe('2026-05-12T20:00:05.000Z');
  });

  it('preserves resolved name + pipelinePhase from the prior row', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    ringing.matchedEntityName = 'Sarah Chen';
    ringing.pipelinePhase = 'onboarding';
    const s1 = applyRowEvent(initialVoiceState, ringing);

    const answered = rowToVoiceCall(row({ status: 'answered' }));
    const s2 = applyRowEvent(s1, answered);
    expect(s2.activeCall?.matchedEntityName).toBe('Sarah Chen');
    expect(s2.activeCall?.pipelinePhase).toBe('onboarding');
  });

  it('moves active to recentlyEnded on terminal status', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    const ended = rowToVoiceCall(
      row({
        status: 'ended',
        answered_at: '2026-05-12T20:00:05.000Z',
        ended_at: '2026-05-12T20:02:00.000Z',
      }),
    );
    const s2 = applyRowEvent(s1, ended);
    expect(s2.activeCall).toBe(null);
    expect(s2.recentlyEnded?.status).toBe('ended');
  });

  it('terminal status carries voicemail and missed too', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    const voicemail = rowToVoiceCall(row({ status: 'voicemail' }));
    const s2 = applyRowEvent(s1, voicemail);
    expect(s2.activeCall).toBe(null);
    expect(s2.recentlyEnded?.status).toBe('voicemail');

    const missed = rowToVoiceCall(row({ status: 'missed' }));
    const s3 = applyRowEvent(s1, missed);
    expect(s3.activeCall).toBe(null);
    expect(s3.recentlyEnded?.status).toBe('missed');
  });
});

describe('applyRowEvent — different row arriving while another is active', () => {
  it('does not yank the screen — second ringing during active call is dropped', () => {
    const active = rowToVoiceCall(row({ id: 'cs-1', status: 'answered' }));
    const s1 = applyRowEvent(initialVoiceState, active);

    const second = rowToVoiceCall(row({ id: 'cs-2', status: 'ringing' }));
    const s2 = applyRowEvent(s1, second);
    expect(s2.activeCall?.id).toBe('cs-1');
  });

  it('takes over when the existing active call is already terminal', () => {
    const old = rowToVoiceCall(row({ id: 'cs-1', status: 'ended' }));
    // First mark it ended so it lives in recentlyEnded.
    const s1 = applyRowEvent(initialVoiceState, rowToVoiceCall(row({ id: 'cs-1', status: 'ringing' })));
    const s2 = applyRowEvent(s1, old);
    expect(s2.activeCall).toBe(null);
    expect(s2.recentlyEnded?.id).toBe('cs-1');

    // A fresh ringing comes in — should take over since no live active.
    const fresh = rowToVoiceCall(row({ id: 'cs-2', status: 'ringing' }));
    const s3 = applyRowEvent(s2, fresh);
    expect(s3.activeCall?.id).toBe('cs-2');
  });
});

describe('dismissActiveCall', () => {
  it('marks the active call dismissed without clearing it', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    const s2 = dismissActiveCall(s1);
    expect(s2.activeCall?.dismissed).toBe(true);
    expect(s2.activeCall?.id).toBe('cs-1');
  });

  it('dismissed flag survives across subsequent UPDATEs', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    const s2 = dismissActiveCall(s1);
    const answered = rowToVoiceCall(row({ status: 'answered' }));
    const s3 = applyRowEvent(s2, answered);
    expect(s3.activeCall?.dismissed).toBe(true);
    expect(s3.activeCall?.status).toBe('answered');
  });

  it('is a no-op when no active call exists', () => {
    const s1 = dismissActiveCall(initialVoiceState);
    expect(s1).toBe(initialVoiceState);
  });
});

describe('clearRecentlyEnded', () => {
  it('clears the recentlyEnded slot', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    const ended = rowToVoiceCall(row({ status: 'ended' }));
    const s2 = applyRowEvent(s1, ended);
    expect(s2.recentlyEnded).not.toBe(null);
    const s3 = clearRecentlyEnded(s2);
    expect(s3.recentlyEnded).toBe(null);
  });
});

// ─── Selectors ─────────────────────────────────────────────────

describe('shouldShowToast', () => {
  it('true when active and not dismissed', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    expect(shouldShowToast(s1)).toBe(true);
  });

  it('false when active call has been dismissed', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    const s2 = dismissActiveCall(s1);
    expect(shouldShowToast(s2)).toBe(false);
  });

  it('true when recentlyEnded is set even after dismiss', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    const s2 = dismissActiveCall(s1);
    const ended = rowToVoiceCall(row({ status: 'ended' }));
    const s3 = applyRowEvent(s2, ended);
    // ended moved row to recentlyEnded → toast flashes "Call ended".
    expect(shouldShowToast(s3)).toBe(true);
  });

  it('false for initial state', () => {
    expect(shouldShowToast(initialVoiceState)).toBe(false);
  });
});

describe('shouldShowActiveBar', () => {
  it('false for ringing', () => {
    const ringing = rowToVoiceCall(row({ status: 'ringing' }));
    const s1 = applyRowEvent(initialVoiceState, ringing);
    expect(shouldShowActiveBar(s1)).toBe(false);
  });

  it('true for answered', () => {
    const answered = rowToVoiceCall(row({ status: 'answered' }));
    const s1 = applyRowEvent(initialVoiceState, answered);
    expect(shouldShowActiveBar(s1)).toBe(true);
  });

  it('false after call ends', () => {
    const answered = rowToVoiceCall(row({ status: 'answered' }));
    const s1 = applyRowEvent(initialVoiceState, answered);
    const ended = rowToVoiceCall(row({ status: 'ended' }));
    const s2 = applyRowEvent(s1, ended);
    expect(shouldShowActiveBar(s2)).toBe(false);
  });
});
