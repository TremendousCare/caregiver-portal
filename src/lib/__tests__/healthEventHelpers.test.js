import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPE_META,
  EVENT_TYPES,
  eventTypeMeta,
  eventTypeLabel,
  mapHealthEventRow,
  sortHealthEvents,
  buildHealthEventRow,
  isReadmission,
} from '../../features/care-signals/healthEventHelpers';

// Must mirror the client_health_events CHECK constraint.
const DB_EVENT_TYPES = [
  'hospitalization',
  'ed_visit',
  'fall',
  'infection',
  'hospital_discharge',
  'death',
  'other',
];

describe('event type taxonomy mirrors the DB constraint', () => {
  it('covers exactly the DB-allowed event types', () => {
    expect([...EVENT_TYPES].sort()).toEqual([...DB_EVENT_TYPES].sort());
  });

  it('every type has a label + lucide icon name (no emoji)', () => {
    for (const t of DB_EVENT_TYPES) {
      expect(EVENT_TYPE_META[t].label).toBeTruthy();
      expect(EVENT_TYPE_META[t].icon).toMatch(/^[A-Z][A-Za-z0-9]+$/);
    }
  });

  it('falls back to "Other" for unknown types', () => {
    expect(eventTypeMeta('nope').label).toBe('Other');
    expect(eventTypeLabel('hospitalization')).toBe('Hospitalization');
  });
});

describe('mapHealthEventRow', () => {
  it('maps snake_case to camelCase with null-safe defaults', () => {
    const vm = mapHealthEventRow({
      id: 'e1',
      client_id: 'c1',
      event_type: 'hospitalization',
      occurred_at: '2026-05-31T12:00:00Z',
    });
    expect(vm.clientId).toBe('c1');
    expect(vm.precedingSignalId).toBeNull();
    expect(vm.avoidable).toBeNull();
  });
});

describe('sortHealthEvents', () => {
  it('orders newest first', () => {
    const sorted = sortHealthEvents([
      { id: 'a', occurredAt: '2026-05-20T00:00:00Z' },
      { id: 'b', occurredAt: '2026-05-31T00:00:00Z' },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('buildHealthEventRow', () => {
  it('builds a valid row from a datetime-local string', () => {
    const { row, error } = buildHealthEventRow(
      { clientId: 'c1', eventType: 'fall', occurredAt: '2026-05-31T09:30', note: '  slipped  ' },
      { recordedBy: 'Jessica' },
    );
    expect(error).toBeNull();
    expect(row.client_id).toBe('c1');
    expect(row.event_type).toBe('fall');
    expect(row.source).toBe('office'); // default
    expect(row.note).toBe('slipped'); // trimmed
    expect(row.recorded_by).toBe('Jessica');
    expect(new Date(row.occurred_at).toISOString()).toBe(row.occurred_at); // normalized ISO
  });

  it('rejects an invalid event type', () => {
    const { row, error } = buildHealthEventRow({ clientId: 'c1', eventType: 'made_up', occurredAt: '2026-05-31T09:30' });
    expect(row).toBeNull();
    expect(error.message).toMatch(/valid event type/);
  });

  it('requires occurredAt and clientId', () => {
    expect(buildHealthEventRow({ clientId: 'c1', eventType: 'fall' }).error.message).toMatch(/occurred/);
    expect(buildHealthEventRow({ eventType: 'fall', occurredAt: '2026-05-31T09:30' }).error.message).toMatch(/clientId/);
  });

  it('only accepts known sources, else defaults to office', () => {
    expect(buildHealthEventRow({ clientId: 'c1', eventType: 'fall', occurredAt: '2026-05-31T09:30', source: 'family' }).row.source).toBe('family');
    expect(buildHealthEventRow({ clientId: 'c1', eventType: 'fall', occurredAt: '2026-05-31T09:30', source: 'martian' }).row.source).toBe('office');
  });
});

describe('isReadmission', () => {
  const events = [
    { id: 'd1', clientId: 'c1', eventType: 'hospital_discharge', occurredAt: '2026-05-20T12:00:00Z' },
    { id: 'h1', clientId: 'c1', eventType: 'hospitalization', occurredAt: '2026-05-31T12:00:00Z' },
  ];

  it('flags a hospitalization within 30 days of a discharge', () => {
    expect(isReadmission(events[1], events)).toBe(true);
  });

  it('respects an already-attributed link', () => {
    expect(isReadmission({ ...events[1], relatedDischargeId: 'd1' }, [])).toBe(true);
  });

  it('is false for a discharge outside the window', () => {
    const far = [
      { id: 'd0', clientId: 'c1', eventType: 'hospital_discharge', occurredAt: '2026-03-01T12:00:00Z' },
      { id: 'h1', clientId: 'c1', eventType: 'hospitalization', occurredAt: '2026-05-31T12:00:00Z' },
    ];
    expect(isReadmission(far[1], far)).toBe(false);
  });

  it('is false for non-hospitalization events', () => {
    expect(isReadmission({ id: 'f', clientId: 'c1', eventType: 'fall', occurredAt: '2026-05-31T12:00:00Z' }, events)).toBe(false);
  });
});
