import { describe, it, expect } from 'vitest';
import {
  findPrecedingSignal,
  findRelatedDischarge,
  computeAttribution,
} from '../../../supabase/functions/care-outcome-attribution/attribution.ts';

const ev = (id, clientId, eventType, occurredAt, extra = {}) => ({
  id,
  clientId,
  eventType,
  occurredAt,
  precedingSignalId: null,
  relatedDischargeId: null,
  ...extra,
});
const sig = (id, clientId, createdAt, extra = {}) => ({
  id,
  clientId,
  createdAt,
  outcomeEventId: null,
  ...extra,
});

describe('findPrecedingSignal', () => {
  it('finds the most recent signal within the lookback before the event', () => {
    const event = ev('e1', 'c1', 'hospitalization', '2026-05-31T12:00:00Z');
    const signals = [
      sig('s_old', 'c1', '2026-05-10T12:00:00Z'), // outside 14d
      sig('s1', 'c1', '2026-05-25T12:00:00Z'),
      sig('s2', 'c1', '2026-05-29T12:00:00Z'), // most recent in-window
    ];
    expect(findPrecedingSignal(event, signals, 14).id).toBe('s2');
  });

  it('ignores signals created after the event', () => {
    const event = ev('e1', 'c1', 'hospitalization', '2026-05-31T12:00:00Z');
    const signals = [sig('after', 'c1', '2026-06-01T12:00:00Z')];
    expect(findPrecedingSignal(event, signals, 14)).toBeNull();
  });

  it('ignores signals for other clients', () => {
    const event = ev('e1', 'c1', 'hospitalization', '2026-05-31T12:00:00Z');
    const signals = [sig('s', 'c2', '2026-05-30T12:00:00Z')];
    expect(findPrecedingSignal(event, signals, 14)).toBeNull();
  });
});

describe('findRelatedDischarge', () => {
  it('links a hospitalization to a discharge within the readmission window', () => {
    const admit = ev('e2', 'c1', 'hospitalization', '2026-05-31T12:00:00Z');
    const events = [
      ev('d1', 'c1', 'hospital_discharge', '2026-05-20T12:00:00Z'), // 11 days before
      admit,
    ];
    expect(findRelatedDischarge(admit, events, 30).id).toBe('d1');
  });

  it('returns null when the discharge is outside the window', () => {
    const admit = ev('e2', 'c1', 'hospitalization', '2026-05-31T12:00:00Z');
    const events = [ev('d1', 'c1', 'hospital_discharge', '2026-04-01T12:00:00Z'), admit];
    expect(findRelatedDischarge(admit, events, 30)).toBeNull();
  });

  it('only applies to hospitalizations', () => {
    const fall = ev('e3', 'c1', 'fall', '2026-05-31T12:00:00Z');
    const events = [ev('d1', 'c1', 'hospital_discharge', '2026-05-20T12:00:00Z'), fall];
    expect(findRelatedDischarge(fall, events, 30)).toBeNull();
  });
});

describe('computeAttribution', () => {
  it('produces event + signal updates for a signal-preceded hospitalization', () => {
    const events = [ev('e1', 'c1', 'hospitalization', '2026-05-31T12:00:00Z')];
    const signals = [sig('s1', 'c1', '2026-05-29T12:00:00Z')];
    const { eventUpdates, signalUpdates } = computeAttribution(events, signals);
    expect(eventUpdates).toEqual([{ eventId: 'e1', precedingSignalId: 's1' }]);
    expect(signalUpdates).toEqual([{ signalId: 's1', outcomeEventId: 'e1' }]);
  });

  it('links a readmission to its discharge', () => {
    const events = [
      ev('d1', 'c1', 'hospital_discharge', '2026-05-20T12:00:00Z'),
      ev('e1', 'c1', 'hospitalization', '2026-05-31T12:00:00Z'),
    ];
    const { eventUpdates } = computeAttribution(events, []);
    expect(eventUpdates).toEqual([{ eventId: 'e1', relatedDischargeId: 'd1' }]);
  });

  it('is idempotent: already-linked events/signals produce no updates', () => {
    const events = [
      ev('e1', 'c1', 'hospitalization', '2026-05-31T12:00:00Z', { precedingSignalId: 's1' }),
    ];
    const signals = [sig('s1', 'c1', '2026-05-29T12:00:00Z', { outcomeEventId: 'e1' })];
    const { eventUpdates, signalUpdates } = computeAttribution(events, signals);
    expect(eventUpdates).toEqual([]);
    expect(signalUpdates).toEqual([]);
  });

  it('does not double-claim one signal across two events', () => {
    const events = [
      ev('e1', 'c1', 'hospitalization', '2026-05-30T12:00:00Z'),
      ev('e2', 'c1', 'ed_visit', '2026-05-31T12:00:00Z'),
    ];
    const signals = [sig('s1', 'c1', '2026-05-29T12:00:00Z')];
    const { signalUpdates } = computeAttribution(events, signals);
    // s1 can only be attributed once.
    expect(signalUpdates).toHaveLength(1);
    expect(signalUpdates[0].signalId).toBe('s1');
  });
});
