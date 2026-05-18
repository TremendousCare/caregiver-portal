import { describe, it, expect } from 'vitest';
import { getClientOverdueStatus } from '../../features/clients/utils.js';

// Fixed point so the tests aren't time-of-day dependent. Use Mon
// 2026-05-18 12:00 UTC.
const NOW = new Date('2026-05-18T12:00:00Z').getTime();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('getClientOverdueStatus', () => {
  it('returns null for terminal phases', () => {
    expect(getClientOverdueStatus({ phase: 'won' }, NOW)).toBeNull();
    expect(getClientOverdueStatus({ phase: 'lost' }, NOW)).toBeNull();
    expect(getClientOverdueStatus({ phase: 'nurture' }, NOW)).toBeNull();
  });

  it('returns null when the client has no phase entry timestamp', () => {
    expect(getClientOverdueStatus({ phase: 'new_lead' }, NOW)).toBeNull();
    expect(getClientOverdueStatus({ phase: 'consult', phaseTimestamps: {} }, NOW)).toBeNull();
  });

  it('uses createdAt for the new_lead SLA window', () => {
    // 30 min old — still within the 1-hour Speed-to-Lead window.
    const recent = getClientOverdueStatus(
      { phase: 'new_lead', createdAt: NOW - 30 * 60 * 1000 },
      NOW,
    );
    expect(recent).toBeNull();

    // 2 hours old — past the 1-hour SLA.
    const stale = getClientOverdueStatus(
      { phase: 'new_lead', createdAt: NOW - 2 * HOUR },
      NOW,
    );
    expect(stale).not.toBeNull();
    expect(stale.phase).toBe('new_lead');
    expect(stale.overdueMs).toBe(HOUR); // 2h elapsed - 1h SLA = 1h overdue
  });

  it('treats consult SLA as 3 days', () => {
    const within = getClientOverdueStatus(
      { phase: 'consult', phaseTimestamps: { consult: NOW - 2 * DAY } },
      NOW,
    );
    expect(within).toBeNull();

    const overdue = getClientOverdueStatus(
      { phase: 'consult', phaseTimestamps: { consult: NOW - 5 * DAY } },
      NOW,
    );
    expect(overdue).not.toBeNull();
    expect(overdue.overdueMs).toBe(2 * DAY);
  });

  it('treats proposal SLA as 5 days', () => {
    const within = getClientOverdueStatus(
      { phase: 'proposal', phaseTimestamps: { proposal: NOW - 4 * DAY } },
      NOW,
    );
    expect(within).toBeNull();

    const overdue = getClientOverdueStatus(
      { phase: 'proposal', phaseTimestamps: { proposal: NOW - 7 * DAY } },
      NOW,
    );
    expect(overdue).not.toBeNull();
    expect(overdue.overdueMs).toBe(2 * DAY);
  });

  it('still handles the pre-consolidation phase IDs (transition window)', () => {
    // Pre-consolidation client that hasn't been migrated yet — banner
    // should still light up so the rep isn't blind.
    const stale = getClientOverdueStatus(
      { phase: 'initial_contact', phaseTimestamps: { initial_contact: NOW - 5 * DAY } },
      NOW,
    );
    expect(stale).not.toBeNull();
    expect(stale.phase).toBe('initial_contact');
  });

  it('accepts numeric and ISO timestamps in phaseTimestamps', () => {
    const numericTs = getClientOverdueStatus(
      { phase: 'consult', phaseTimestamps: { consult: NOW - 5 * DAY } },
      NOW,
    );
    const isoTs = getClientOverdueStatus(
      {
        phase: 'consult',
        phaseTimestamps: { consult: new Date(NOW - 5 * DAY).toISOString() },
      },
      NOW,
    );
    expect(numericTs.overdueMs).toBe(isoTs.overdueMs);
  });
});
