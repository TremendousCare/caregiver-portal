/**
 * Tests for supabase/functions/ringcentral-telephony-webhook/parse.ts
 *
 * Pure TS, no Deno-only imports — Vitest loads it directly. These tests
 * cover the status-mapping table, direction derivation, the
 * party-selection rules in parseTelephonyEvent, and the
 * never-go-backwards guard in resolveTargetStatus.
 *
 * Fixtures mirror the documented RingCentral Telephony Sessions event
 * payload shape:
 *   https://developers.ringcentral.com/api-reference/Call-Control/
 */

import { describe, it, expect } from 'vitest';
import {
  mapRcStatusToCallStatus,
  deriveDirection,
  normalizeE164,
  parseTelephonyEvent,
  resolveTargetStatus,
} from '../../../supabase/functions/ringcentral-telephony-webhook/parse.ts';

// ─────────────────────────────────────────────────────────────────
// mapRcStatusToCallStatus
// ─────────────────────────────────────────────────────────────────

describe('mapRcStatusToCallStatus', () => {
  it('treats Setup, Proceeding, Alerting as ringing', () => {
    expect(mapRcStatusToCallStatus('Setup')).toBe('ringing');
    expect(mapRcStatusToCallStatus('Proceeding')).toBe('ringing');
    expect(mapRcStatusToCallStatus('Alerting')).toBe('ringing');
  });

  it('treats Answered and Hold as answered', () => {
    expect(mapRcStatusToCallStatus('Answered')).toBe('answered');
    expect(mapRcStatusToCallStatus('Hold')).toBe('answered');
  });

  it('treats Voicemail as voicemail regardless of casing', () => {
    expect(mapRcStatusToCallStatus('Voicemail')).toBe('voicemail');
    expect(mapRcStatusToCallStatus('voicemail')).toBe('voicemail');
  });

  it('reason=Voicemail on a Disconnected event wins over wasAnswered', () => {
    expect(
      mapRcStatusToCallStatus('Disconnected', {
        wasAnswered: false,
        reason: 'Voicemail',
      }),
    ).toBe('voicemail');
    expect(
      mapRcStatusToCallStatus('Disconnected', {
        wasAnswered: true,
        reason: 'Voicemail',
      }),
    ).toBe('voicemail');
  });

  it('Disconnected after Answered is ended', () => {
    expect(
      mapRcStatusToCallStatus('Disconnected', { wasAnswered: true }),
    ).toBe('ended');
  });

  it('Disconnected before Answered is missed', () => {
    expect(
      mapRcStatusToCallStatus('Disconnected', { wasAnswered: false }),
    ).toBe('missed');
  });

  it('Gone is treated like a pre-answer Disconnected (missed)', () => {
    expect(mapRcStatusToCallStatus('Gone')).toBe('missed');
  });

  it('Parked rolls into missed when not answered', () => {
    expect(mapRcStatusToCallStatus('Parked')).toBe('missed');
  });

  it('unknown statuses fall back to ringing so the row still gets a screen-pop', () => {
    expect(mapRcStatusToCallStatus('SomethingUnexpected')).toBe('ringing');
    expect(mapRcStatusToCallStatus('')).toBe('ringing');
  });
});

// ─────────────────────────────────────────────────────────────────
// deriveDirection
// ─────────────────────────────────────────────────────────────────

describe('deriveDirection', () => {
  it('returns inbound when OUR extension is on the `to` side, regardless of party.direction', () => {
    // This is the exact shape RC sent in the 2026-05-13 incident:
    // direction='Outbound' but to.extensionId is our extension because
    // it's an external caller dialing INTO us. We must override.
    const known = new Set(['792493017']);
    const party = {
      direction: 'Outbound',
      from: { phoneNumber: '+15868720673' },
      to: { extensionId: '792493017', phoneNumber: '+19498732367' },
    };
    expect(deriveDirection(party, known)).toBe('inbound');
  });

  it('returns outbound when OUR extension is on the `from` side', () => {
    const known = new Set(['792493017']);
    const party = {
      direction: 'Inbound',
      from: { extensionId: '792493017', phoneNumber: '+19498732367' },
      to: { phoneNumber: '+15868720673' },
    };
    expect(deriveDirection(party, known)).toBe('outbound');
  });

  it('falls back to RC direction when no known-extension match', () => {
    expect(deriveDirection({ direction: 'Inbound' })).toBe('inbound');
    expect(deriveDirection({ direction: 'Outbound' })).toBe('outbound');
    expect(deriveDirection({ direction: 'INBOUND' })).toBe('inbound');
  });

  it('falls back to from.extensionId presence for outbound when neither RC dir nor known set helps', () => {
    expect(
      deriveDirection({ from: { extensionId: 'ext-1' }, to: { phoneNumber: '+15555550001' } }),
    ).toBe('outbound');
  });

  it('falls back to to.extensionId presence for inbound', () => {
    expect(
      deriveDirection({ from: { phoneNumber: '+15555550001' }, to: { extensionId: 'ext-1' } }),
    ).toBe('inbound');
  });

  it('defaults to inbound when no clues are present', () => {
    expect(deriveDirection({})).toBe('inbound');
  });
});

// ─────────────────────────────────────────────────────────────────
// normalizeE164
// ─────────────────────────────────────────────────────────────────

describe('normalizeE164', () => {
  it('accepts 10-digit US numbers', () => {
    expect(normalizeE164('5551234567')).toBe('+15551234567');
    expect(normalizeE164('(555) 123-4567')).toBe('+15551234567');
  });

  it('accepts 11-digit numbers starting with 1', () => {
    expect(normalizeE164('15551234567')).toBe('+15551234567');
    expect(normalizeE164('1-555-123-4567')).toBe('+15551234567');
  });

  it('returns null for anything else', () => {
    expect(normalizeE164('')).toBe(null);
    expect(normalizeE164(null)).toBe(null);
    expect(normalizeE164('not a phone')).toBe(null);
    expect(normalizeE164('123')).toBe(null);
    expect(normalizeE164('25551234567')).toBe(null); // 11 digits, doesn't start with 1
  });
});

// ─────────────────────────────────────────────────────────────────
// parseTelephonyEvent — real RC event shapes
// ─────────────────────────────────────────────────────────────────

function makeRcEvent({
  telephonySessionId = 'tsess-1',
  subscriptionId = 'sub-1',
  parties,
  eventTime = '2026-05-12T12:00:00.123Z',
}) {
  return {
    uuid: 'evt-uuid',
    event: '/restapi/v1.0/account/12345/telephony/sessions',
    timestamp: eventTime,
    subscriptionId,
    body: {
      sequence: 1,
      sessionId: telephonySessionId,
      telephonySessionId,
      eventTime,
      parties,
    },
  };
}

describe('parseTelephonyEvent — inbound ringing', () => {
  it('extracts the right party, direction, status, and numbers', () => {
    const evt = makeRcEvent({
      parties: [
        {
          id: 'party-1',
          extensionId: 'ext-100',
          direction: 'Inbound',
          to: { phoneNumber: '+15551234567', extensionId: 'ext-100' },
          from: { phoneNumber: '+15559876543', name: 'Jane Caller' },
          status: { code: 'Setup' },
        },
      ],
    });

    const parsed = parseTelephonyEvent(evt);
    expect(parsed).not.toBeNull();
    expect(parsed.telephonySessionId).toBe('tsess-1');
    expect(parsed.partyId).toBe('party-1');
    expect(parsed.direction).toBe('inbound');
    expect(parsed.status).toBe('ringing');
    expect(parsed.fromE164).toBe('+15559876543');
    expect(parsed.toE164).toBe('+15551234567');
    expect(parsed.extensionId).toBe('ext-100');
    expect(parsed.eventTime).toBe('2026-05-12T12:00:00.123Z');
    expect(parsed.recordingId).toBe(null);
  });
});

describe('parseTelephonyEvent — inbound answered with recording', () => {
  it('surfaces the recording id when RC has materialised it', () => {
    const evt = makeRcEvent({
      parties: [
        {
          id: 'party-1',
          extensionId: 'ext-100',
          direction: 'Inbound',
          to: { phoneNumber: '+15551234567', extensionId: 'ext-100' },
          from: { phoneNumber: '+15559876543' },
          status: { code: 'Answered' },
          recordings: [{ id: 'rec-9001', active: true }],
        },
      ],
    });
    const parsed = parseTelephonyEvent(evt);
    expect(parsed.status).toBe('answered');
    expect(parsed.recordingId).toBe('rec-9001');
  });
});

describe('parseTelephonyEvent — outbound ended', () => {
  it('handles outbound direction and the post-Answered Disconnected event', () => {
    const evt = makeRcEvent({
      parties: [
        {
          id: 'party-2',
          extensionId: 'ext-100',
          direction: 'Outbound',
          to: { phoneNumber: '+15559876543' },
          from: { phoneNumber: '+15551234567', extensionId: 'ext-100' },
          status: { code: 'Disconnected', reason: 'Hangup' },
          wasAnswered: true,
        },
      ],
    });
    const parsed = parseTelephonyEvent(evt);
    expect(parsed.direction).toBe('outbound');
    expect(parsed.status).toBe('ended');
  });
});

// ─────────────────────────────────────────────────────────────────
// parseTelephonyEvent — real-world incident payloads
// (2026-05-13: matched_user_id was NULL on every event because the
// extension was nested in `to.extensionId` rather than at party
// root, and our parser only looked at the root.)
// ─────────────────────────────────────────────────────────────────

describe('parseTelephonyEvent — nested extension in `to.extensionId`', () => {
  it('matches our extension when RC nests it inside `to.extensionId` (inbound call shape)', () => {
    const known = new Set(['792493017']);
    // Real payload shape from the 2026-05-13 incident, simplified:
    const evt = {
      body: {
        telephonySessionId: 's-incident',
        eventTime: '2026-05-13T00:14:41.707Z',
        parties: [
          {
            id: 'p-incident-1',
            // NO party.extensionId at root
            direction: 'Outbound', // RC's perspective on the caller's leg
            to: { extensionId: '792493017', phoneNumber: '+19498732367', name: 'Tremendous Care' },
            from: { phoneNumber: '+15868720673', name: 'Kevin Nash' },
            status: { code: 'Disconnected' },
          },
        ],
      },
    };
    const parsed = parseTelephonyEvent(evt, known);
    expect(parsed).not.toBeNull();
    expect(parsed.extensionId).toBe('792493017');
    // Crucially, direction is INBOUND from OUR perspective even though
    // RC's party.direction says 'Outbound'.
    expect(parsed.direction).toBe('inbound');
    expect(parsed.fromE164).toBe('+15868720673');
    expect(parsed.toE164).toBe('+19498732367');
  });

  it('matches our extension when RC nests it inside `from.extensionId` (outbound shape)', () => {
    const known = new Set(['792493017']);
    const evt = {
      body: {
        telephonySessionId: 's-outbound',
        parties: [
          {
            id: 'p-outbound-1',
            direction: 'Outbound',
            from: { extensionId: '792493017', phoneNumber: '+19498732367' },
            to: { phoneNumber: '+15868720673' },
            status: { code: 'Setup' },
          },
        ],
      },
    };
    const parsed = parseTelephonyEvent(evt, known);
    expect(parsed.extensionId).toBe('792493017');
    expect(parsed.direction).toBe('outbound');
  });

  it('prefers a party with our extension in `to.extensionId` over a different party with party.extensionId at root', () => {
    const known = new Set(['792493017']);
    const evt = {
      body: {
        telephonySessionId: 's-multi',
        parties: [
          {
            id: 'p-stranger',
            extensionId: 'ext-stranger',
            direction: 'Inbound',
            to: { phoneNumber: '+15555550000' },
            from: { phoneNumber: '+15868720673' },
            status: { code: 'Setup' },
          },
          {
            id: 'p-ours',
            // No party.extensionId at root, but to.extensionId is ours
            direction: 'Outbound',
            to: { extensionId: '792493017', phoneNumber: '+19498732367' },
            from: { phoneNumber: '+15868720673' },
            status: { code: 'Setup' },
          },
        ],
      },
    };
    const parsed = parseTelephonyEvent(evt, known);
    expect(parsed.partyId).toBe('p-ours');
    expect(parsed.extensionId).toBe('792493017');
    expect(parsed.direction).toBe('inbound');
  });

  it('still works when our extension is at party.extensionId root (legacy shape)', () => {
    const known = new Set(['ext-100']);
    const evt = makeRcEvent({
      parties: [
        {
          id: 'p-root',
          extensionId: 'ext-100',
          direction: 'Inbound',
          to: { phoneNumber: '+15551234567', extensionId: 'ext-100' },
          from: { phoneNumber: '+15559876543' },
          status: { code: 'Setup' },
        },
      ],
    });
    const parsed = parseTelephonyEvent(evt, known);
    expect(parsed.extensionId).toBe('ext-100');
    expect(parsed.direction).toBe('inbound');
  });
});

describe('parseTelephonyEvent — missed inbound', () => {
  it('returns missed when caller hangs up before pickup', () => {
    const evt = makeRcEvent({
      parties: [
        {
          id: 'party-1',
          extensionId: 'ext-100',
          direction: 'Inbound',
          to: { phoneNumber: '+15551234567', extensionId: 'ext-100' },
          from: { phoneNumber: '+15559876543' },
          status: { code: 'Disconnected', reason: 'CallerInputRedirect' },
          wasAnswered: false,
        },
      ],
    });
    const parsed = parseTelephonyEvent(evt);
    expect(parsed.status).toBe('missed');
  });
});

describe('parseTelephonyEvent — multi-party (queue forward)', () => {
  it('prefers a party whose extensionId is in the known set', () => {
    const known = new Set(['ext-known']);
    const evt = makeRcEvent({
      parties: [
        {
          id: 'party-other',
          extensionId: 'ext-stranger',
          direction: 'Inbound',
          to: { phoneNumber: '+15551234567', extensionId: 'ext-stranger' },
          from: { phoneNumber: '+15559876543' },
          status: { code: 'Disconnected', reason: 'CallForwarded' },
        },
        {
          id: 'party-ours',
          extensionId: 'ext-known',
          direction: 'Inbound',
          to: { phoneNumber: '+15551234567', extensionId: 'ext-known' },
          from: { phoneNumber: '+15559876543' },
          status: { code: 'Setup' },
        },
      ],
    });

    const parsed = parseTelephonyEvent(evt, known);
    expect(parsed.partyId).toBe('party-ours');
    expect(parsed.extensionId).toBe('ext-known');
    expect(parsed.status).toBe('ringing');
  });

  it('falls back to the first party with any extensionId when none are known', () => {
    const evt = makeRcEvent({
      parties: [
        { id: 'p1', from: { phoneNumber: '+15559876543' }, to: {}, status: { code: 'Setup' } },
        { id: 'p2', extensionId: 'ext-200', from: { phoneNumber: '+15559876543' }, to: { extensionId: 'ext-200' }, status: { code: 'Setup' } },
      ],
    });
    const parsed = parseTelephonyEvent(evt);
    expect(parsed.partyId).toBe('p2');
    expect(parsed.extensionId).toBe('ext-200');
  });
});

describe('parseTelephonyEvent — robustness', () => {
  it('returns null for missing telephonySessionId', () => {
    const evt = makeRcEvent({ parties: [{ id: 'p1', status: { code: 'Setup' } }] });
    delete evt.body.telephonySessionId;
    delete evt.body.sessionId;
    expect(parseTelephonyEvent(evt)).toBeNull();
  });

  it('returns null for empty parties array', () => {
    const evt = makeRcEvent({ parties: [] });
    expect(parseTelephonyEvent(evt)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseTelephonyEvent(null)).toBeNull();
    expect(parseTelephonyEvent(undefined)).toBeNull();
    expect(parseTelephonyEvent('not an object')).toBeNull();
  });

  it('handles flat (no body wrapper) shape', () => {
    const flat = {
      telephonySessionId: 'tsess-flat',
      parties: [
        {
          id: 'p1',
          extensionId: 'ext-1',
          direction: 'Inbound',
          to: { phoneNumber: '+15551234567', extensionId: 'ext-1' },
          from: { phoneNumber: '+15559876543' },
          status: { code: 'Setup' },
        },
      ],
    };
    const parsed = parseTelephonyEvent(flat);
    expect(parsed).not.toBeNull();
    expect(parsed.telephonySessionId).toBe('tsess-flat');
  });
});

// ─────────────────────────────────────────────────────────────────
// resolveTargetStatus
// ─────────────────────────────────────────────────────────────────

describe('resolveTargetStatus', () => {
  it('takes the incoming status when there is no existing row', () => {
    expect(resolveTargetStatus(null, 'ringing')).toBe('ringing');
    expect(resolveTargetStatus(undefined, 'answered')).toBe('answered');
  });

  it('never goes backwards on ringing-after-answered late retransmits', () => {
    expect(resolveTargetStatus('answered', 'ringing')).toBe('answered');
    expect(resolveTargetStatus('ended', 'ringing')).toBe('ended');
    expect(resolveTargetStatus('ended', 'answered')).toBe('ended');
  });

  it('advances normally on forward transitions', () => {
    expect(resolveTargetStatus('ringing', 'answered')).toBe('answered');
    expect(resolveTargetStatus('answered', 'ended')).toBe('ended');
    expect(resolveTargetStatus('ringing', 'missed')).toBe('missed');
  });

  it('treats missed and voicemail as the same terminal rank', () => {
    expect(resolveTargetStatus('missed', 'voicemail')).toBe('voicemail');
    expect(resolveTargetStatus('voicemail', 'missed')).toBe('missed');
    expect(resolveTargetStatus('ended', 'voicemail')).toBe('ended');
  });
});
