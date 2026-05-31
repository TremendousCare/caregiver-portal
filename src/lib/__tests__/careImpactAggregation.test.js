import { describe, it, expect } from 'vitest';
import {
  getTimeRange,
  signalFunnel,
  signalResponseLatency,
  outcomeCounts,
  monthlyOutcomeTrend,
  attributionMatrix,
  impactSummary,
} from '../../features/care-impact/careImpactAggregation';

const DAY = 86_400_000;
const now = Date.parse('2026-05-31T12:00:00Z');
const ago = (d) => new Date(now - d * DAY).toISOString();
const range = { startMs: now - 90 * DAY, endMs: now };

const sig = (o) => ({
  id: o.id,
  client_id: o.client_id ?? 'c1',
  severity: o.severity ?? 'watch',
  status: o.status ?? 'open',
  created_at: o.created_at,
  dispositioned_at: o.dispositioned_at ?? null,
  outcome_event_id: o.outcome_event_id ?? null,
});
const evt = (o) => ({
  id: o.id,
  client_id: o.client_id ?? 'c1',
  event_type: o.event_type,
  occurred_at: o.occurred_at,
  related_discharge_id: o.related_discharge_id ?? null,
  preceding_signal_id: o.preceding_signal_id ?? null,
});

describe('getTimeRange', () => {
  it('returns a known range or defaults to 90d', () => {
    expect(getTimeRange('30d').days).toBe(30);
    expect(getTimeRange('nonsense').id).toBe('90d');
  });
});

describe('signalFunnel', () => {
  it('counts totals, dispositions, severities and the action rate', () => {
    const signals = [
      sig({ id: 's1', status: 'actioned', severity: 'urgent', created_at: ago(5) }),
      sig({ id: 's2', status: 'acknowledged', severity: 'watch', created_at: ago(4) }),
      sig({ id: 's3', status: 'dismissed', severity: 'watch', created_at: ago(3) }),
      sig({ id: 's4', status: 'open', severity: 'info', created_at: ago(2) }),
      sig({ id: 'old', status: 'actioned', created_at: ago(200) }), // out of range
    ];
    const f = signalFunnel(signals, range);
    expect(f.total).toBe(4);
    expect(f.actioned).toBe(1);
    expect(f.acknowledged).toBe(1);
    expect(f.dismissed).toBe(1);
    expect(f.actedOn).toBe(2); // actioned + acknowledged
    expect(f.actionRate).toBeCloseTo(0.5);
    expect(f.bySeverity.urgent).toBe(1);
  });
});

describe('signalResponseLatency', () => {
  it('computes the median minutes to disposition', () => {
    const signals = [
      sig({ id: 's1', created_at: ago(5), dispositioned_at: new Date(now - 5 * DAY + 10 * 60000).toISOString() }), // 10 min
      sig({ id: 's2', created_at: ago(4), dispositioned_at: new Date(now - 4 * DAY + 30 * 60000).toISOString() }), // 30 min
      sig({ id: 's3', created_at: ago(3) }), // never dispositioned
    ];
    const l = signalResponseLatency(signals, range);
    expect(l.n).toBe(2);
    expect(l.medianMinutes).toBe(20); // (10+30)/2
  });

  it('returns null median with no dispositions', () => {
    expect(signalResponseLatency([sig({ id: 's', created_at: ago(1) })], range).medianMinutes).toBeNull();
  });
});

describe('outcomeCounts', () => {
  it('counts hospitalizations, ED, falls and readmissions (attributed + computed)', () => {
    const events = [
      evt({ id: 'd1', event_type: 'hospital_discharge', occurred_at: ago(20) }),
      // hospitalization 10 days after discharge -> computed readmission
      evt({ id: 'h1', event_type: 'hospitalization', occurred_at: ago(10) }),
      // hospitalization flagged via related_discharge_id
      evt({ id: 'h2', event_type: 'hospitalization', occurred_at: ago(8), related_discharge_id: 'dX' }),
      // hospitalization with no prior discharge -> not a readmission
      evt({ id: 'h3', client_id: 'c2', event_type: 'hospitalization', occurred_at: ago(6) }),
      evt({ id: 'e1', event_type: 'ed_visit', occurred_at: ago(4) }),
      evt({ id: 'f1', event_type: 'fall', occurred_at: ago(2) }),
    ];
    const o = outcomeCounts(events, range);
    expect(o.hospitalizations).toBe(3);
    expect(o.readmissions).toBe(2); // h1 (computed) + h2 (attributed)
    expect(o.edVisits).toBe(1);
    expect(o.falls).toBe(1);
  });

  it('does not count a discharge older than 30 days as a readmission anchor', () => {
    const events = [
      evt({ id: 'd1', event_type: 'hospital_discharge', occurred_at: ago(60) }),
      evt({ id: 'h1', event_type: 'hospitalization', occurred_at: ago(10) }),
    ];
    expect(outcomeCounts(events, range).readmissions).toBe(0);
  });
});

describe('monthlyOutcomeTrend', () => {
  it('buckets events by month, ascending', () => {
    const events = [
      evt({ id: 'h1', event_type: 'hospitalization', occurred_at: '2026-04-10T00:00:00Z' }),
      evt({ id: 'h2', event_type: 'hospitalization', occurred_at: '2026-05-02T00:00:00Z' }),
      evt({ id: 'e1', event_type: 'ed_visit', occurred_at: '2026-05-20T00:00:00Z' }),
    ];
    const t = monthlyOutcomeTrend(events, range);
    expect(t.map((p) => p.month)).toEqual(['2026-04', '2026-05']);
    expect(t[1]).toMatchObject({ hospitalizations: 1, edVisits: 1 });
  });
});

describe('attributionMatrix', () => {
  it('counts caught-early vs missed from preceding_signal_id', () => {
    const events = [
      evt({ id: 'h1', event_type: 'hospitalization', occurred_at: ago(5), preceding_signal_id: 's1' }),
      evt({ id: 'h2', event_type: 'hospitalization', occurred_at: ago(4) }), // missed
      evt({ id: 'e1', event_type: 'ed_visit', occurred_at: ago(3), preceding_signal_id: 's2' }),
    ];
    const m = attributionMatrix([], events, range);
    expect(m.caughtEarly).toBe(2);
    expect(m.missed).toBe(1);
  });

  it('counts true warnings (signal with outcome_event_id)', () => {
    const signals = [sig({ id: 's1', created_at: ago(6), outcome_event_id: 'h1' })];
    expect(attributionMatrix(signals, [], range).trueWarning).toBe(1);
  });

  it('estimated-avoided = actioned signal with NO serious event in the lookahead', () => {
    const signals = [
      sig({ id: 's1', client_id: 'c1', status: 'actioned', created_at: ago(20) }), // no event follows -> avoided
      sig({ id: 's2', client_id: 'c2', status: 'actioned', created_at: ago(20) }), // event follows -> not avoided
      sig({ id: 's3', client_id: 'c3', status: 'dismissed', created_at: ago(20) }), // dismissed -> never avoided
    ];
    const events = [
      evt({ id: 'h2', client_id: 'c2', event_type: 'hospitalization', occurred_at: ago(15) }), // within 14d of s2
    ];
    const m = attributionMatrix(signals, events, { ...range, avoidedLookaheadDays: 14 });
    expect(m.estimatedAvoided).toBe(1); // only s1
  });

  it('does NOT count avoided until the lookahead window has fully elapsed', () => {
    // Actioned 5 days ago; the 14-day window has not matured, so even with
    // no event yet it must not count (would overstate the partner metric).
    const signals = [sig({ id: 's1', client_id: 'c1', status: 'actioned', created_at: ago(5) })];
    const immature = attributionMatrix(signals, [], { ...range, avoidedLookaheadDays: 14, nowMs: now });
    expect(immature.estimatedAvoided).toBe(0);

    // Advance "now" 20 days so the window has elapsed — the same signal counts.
    const matured = attributionMatrix(signals, [], {
      ...range,
      endMs: now + 20 * DAY,
      nowMs: now + 20 * DAY,
      avoidedLookaheadDays: 14,
    });
    expect(matured.estimatedAvoided).toBe(1);
  });

  it('does not count an actioned signal as avoided if it already has an outcome event', () => {
    const signals = [sig({ id: 's1', status: 'actioned', created_at: ago(20), outcome_event_id: 'h1' })];
    const m = attributionMatrix(signals, [], range);
    expect(m.estimatedAvoided).toBe(0);
    expect(m.trueWarning).toBe(1);
  });
});

describe('impactSummary', () => {
  it('bundles funnel, latency, outcomes and attribution', () => {
    const s = impactSummary([sig({ id: 's1', status: 'actioned', created_at: ago(5) })], [], range);
    expect(s).toHaveProperty('funnel');
    expect(s).toHaveProperty('latency');
    expect(s).toHaveProperty('outcomes');
    expect(s).toHaveProperty('attribution');
  });
});
