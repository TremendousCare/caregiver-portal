import { describe, it, expect } from 'vitest';
import {
  daysSince,
  isCold,
  rankAccounts,
  searchAccounts,
  summarizeWeek,
  fetchAccountsWithActivity,
} from '../../features/bd-portal/lib/bdQueries';

const NOW = new Date('2026-05-09T12:00:00Z').getTime();
const dayAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

describe('daysSince', () => {
  it('returns whole days from an ISO string', () => {
    expect(daysSince(dayAgo(3), NOW)).toBe(3);
  });
  it('returns null for missing or invalid input', () => {
    expect(daysSince(null, NOW)).toBe(null);
    expect(daysSince(undefined, NOW)).toBe(null);
    expect(daysSince('not-a-date', NOW)).toBe(null);
  });
});

describe('isCold', () => {
  it('flags accounts with no activity as cold', () => {
    expect(isCold({ last_activity_at: null }, NOW)).toBe(true);
  });
  it('flags accounts last touched 21+ days ago as cold', () => {
    expect(isCold({ last_activity_at: dayAgo(21) }, NOW)).toBe(true);
    expect(isCold({ last_activity_at: dayAgo(30) }, NOW)).toBe(true);
  });
  it('treats accounts touched within 20 days as warm', () => {
    expect(isCold({ last_activity_at: dayAgo(20) }, NOW)).toBe(false);
    expect(isCold({ last_activity_at: dayAgo(1) }, NOW)).toBe(false);
  });
});

describe('rankAccounts', () => {
  it('puts cold accounts above warm ones', () => {
    const ranked = rankAccounts(
      [
        { id: 'warm', last_activity_at: dayAgo(2), activity_count: 5 },
        { id: 'cold', last_activity_at: dayAgo(45), activity_count: 5 },
      ],
      NOW,
    );
    expect(ranked[0].id).toBe('cold');
    expect(ranked[0]._cold).toBe(true);
    expect(ranked[1]._cold).toBe(false);
  });

  it('among cold accounts, prioritizes longer dormancy', () => {
    const ranked = rankAccounts(
      [
        { id: 'a', last_activity_at: dayAgo(30), activity_count: 5 },
        { id: 'b', last_activity_at: dayAgo(60), activity_count: 5 },
      ],
      NOW,
    );
    expect(ranked[0].id).toBe('b');
  });

  it('treats null last_activity_at as cold (never visited)', () => {
    const ranked = rankAccounts(
      [
        { id: 'warm', last_activity_at: dayAgo(2), activity_count: 5 },
        { id: 'never', last_activity_at: null, activity_count: 0 },
      ],
      NOW,
    );
    expect(ranked[0].id).toBe('never');
    expect(ranked[0]._days_since).toBe(null);
  });

  it('returns an empty array for null input without throwing', () => {
    expect(rankAccounts(null)).toEqual([]);
    expect(rankAccounts(undefined)).toEqual([]);
  });
});

describe('searchAccounts', () => {
  const accounts = [
    { id: '1', name: 'Hoag Hospital',  city: 'Newport Beach' },
    { id: '2', name: 'Atria San Juan', city: 'San Juan Capistrano' },
    { id: '3', name: 'Crystal Cove',   city: null },
  ];

  it('returns the full list when the query is empty or whitespace', () => {
    expect(searchAccounts(accounts, '')).toBe(accounts);
    expect(searchAccounts(accounts, '   ')).toEqual(accounts);
  });

  it('matches case-insensitively on name', () => {
    expect(searchAccounts(accounts, 'hoag').map((a) => a.id)).toEqual(['1']);
    expect(searchAccounts(accounts, 'ATRIA').map((a) => a.id)).toEqual(['2']);
  });

  it('matches on city as well as name', () => {
    expect(searchAccounts(accounts, 'capistrano').map((a) => a.id)).toEqual(['2']);
  });

  it('handles accounts with null city', () => {
    expect(() => searchAccounts(accounts, 'crystal')).not.toThrow();
    expect(searchAccounts(accounts, 'crystal').map((a) => a.id)).toEqual(['3']);
  });
});

describe('summarizeWeek', () => {
  it('counts activity types within the last 7 days only', () => {
    const activities = [
      { activity_type: 'visit',    occurred_at: dayAgo(1) },
      { activity_type: 'visit',    occurred_at: dayAgo(2) },
      { activity_type: 'call',     occurred_at: dayAgo(3) },
      { activity_type: 'drop_off', occurred_at: dayAgo(4) },
      { activity_type: 'note',     occurred_at: dayAgo(5) },
      { activity_type: 'visit',    occurred_at: dayAgo(15) }, // outside the window
    ];
    expect(summarizeWeek(activities, NOW)).toEqual({
      visits: 2,
      calls: 1,
      dropOffs: 1,
      other: 1,
      total: 5,
    });
  });

  it('returns zeroes for empty input', () => {
    expect(summarizeWeek([], NOW)).toEqual({
      visits: 0, calls: 0, dropOffs: 0, other: 0, total: 0,
    });
    expect(summarizeWeek(null, NOW)).toEqual({
      visits: 0, calls: 0, dropOffs: 0, other: 0, total: 0,
    });
  });

  it('skips activities with unparseable timestamps', () => {
    const activities = [
      { activity_type: 'visit', occurred_at: 'not-a-date' },
      { activity_type: 'visit', occurred_at: dayAgo(1) },
    ];
    expect(summarizeWeek(activities, NOW).visits).toBe(1);
  });
});

// ─── Supabase fetcher (with a stub client) ───
function makeStubSupabase({ accounts = [], activities = [], accountsErr = null, activitiesErr = null } = {}) {
  return {
    from(table) {
      if (table === 'bd_accounts') {
        return {
          select() { return this; },
          eq() { return this; },
          order() {
            return Promise.resolve({ data: accounts, error: accountsErr });
          },
        };
      }
      if (table === 'bd_activities') {
        return {
          select() { return this; },
          in() {
            return Promise.resolve({ data: activities, error: activitiesErr });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe('fetchAccountsWithActivity', () => {
  it('returns empty data + null error when no client', async () => {
    const r = await fetchAccountsWithActivity(null);
    expect(r).toEqual({ data: [], error: null });
  });

  it('returns the accounts query error if it fails', async () => {
    const err = new Error('boom');
    const stub = makeStubSupabase({ accountsErr: err });
    const r = await fetchAccountsWithActivity(stub);
    expect(r.data).toEqual([]);
    expect(r.error).toBe(err);
  });

  it('skips the activity query when there are no accounts', async () => {
    const stub = makeStubSupabase({ accounts: [] });
    const r = await fetchAccountsWithActivity(stub);
    expect(r).toEqual({ data: [], error: null });
  });

  it('attaches activity_count derived from bd_activities', async () => {
    const stub = makeStubSupabase({
      accounts: [
        { id: 'A', name: 'Hoag', last_activity_at: dayAgo(1) },
        { id: 'B', name: 'Atria', last_activity_at: dayAgo(10) },
      ],
      activities: [
        { account_id: 'A', occurred_at: dayAgo(1), activity_type: 'visit' },
        { account_id: 'A', occurred_at: dayAgo(2), activity_type: 'call' },
        { account_id: 'B', occurred_at: dayAgo(10), activity_type: 'visit' },
      ],
    });
    const r = await fetchAccountsWithActivity(stub);
    expect(r.error).toBe(null);
    const map = Object.fromEntries(r.data.map((a) => [a.id, a.activity_count]));
    expect(map).toEqual({ A: 2, B: 1 });
    expect(r._allActivities).toHaveLength(3);
  });

  it('returns activity error if the activity query fails', async () => {
    const err = new Error('act-boom');
    const stub = makeStubSupabase({
      accounts: [{ id: 'A', name: 'Hoag' }],
      activitiesErr: err,
    });
    const r = await fetchAccountsWithActivity(stub);
    expect(r.error).toBe(err);
  });
});
