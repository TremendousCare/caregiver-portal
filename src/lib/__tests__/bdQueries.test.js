import { describe, it, expect } from 'vitest';
import {
  daysSince,
  isCold,
  isProspect,
  rankAccounts,
  searchAccounts,
  summarizeWeek,
  fetchAccountsWithActivity,
  fetchAccount,
  fetchAccountContacts,
  fetchAccountActivities,
  formatActivityDate,
  formatAccountSubtitle,
  ACTIVITY_TYPE_LABELS,
  haversineMeters,
  findNearestAccount,
  buildAppleMapsRouteUrl,
  formatStopAddress,
  hasRoutableAddress,
  hasPreciseCoordinate,
  DEFAULT_NEARBY_RADIUS_METERS,
  normalizeCityForMatch,
  filterToTerritory,
  fetchCurrentUserTerritoryCities,
  fetchTerritoryCitiesForUser,
  fetchStarredAccountIdsForUser,
  fetchAuditableReps,
} from '../../features/bd-portal/lib/bdQueries';
import { ACTIVITY_TYPE_ICON_TYPES } from '../../features/bd-portal/lib/activityTypeIcon';

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

describe('isProspect', () => {
  it('flags research_import rows with zero activities', () => {
    expect(isProspect({ source: 'research_import', activity_count: 0 })).toBe(true);
  });
  it('does not flag research_import rows once any activity is logged', () => {
    expect(isProspect({ source: 'research_import', activity_count: 1 })).toBe(false);
    expect(isProspect({ source: 'research_import', activity_count: 7 })).toBe(false);
  });
  it('treats missing activity_count as zero (the column is computed in JS)', () => {
    expect(isProspect({ source: 'research_import' })).toBe(true);
    expect(isProspect({ source: 'research_import', activity_count: undefined })).toBe(true);
    expect(isProspect({ source: 'research_import', activity_count: null })).toBe(true);
  });
  it('never flags manual / trello_import / null-source rows even with zero activity', () => {
    expect(isProspect({ source: 'manual',        activity_count: 0 })).toBe(false);
    expect(isProspect({ source: 'trello_import', activity_count: 0 })).toBe(false);
    expect(isProspect({ source: null,            activity_count: 0 })).toBe(false);
    expect(isProspect({                          activity_count: 0 })).toBe(false);
    expect(isProspect(null)).toBe(false);
    expect(isProspect(undefined)).toBe(false);
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

  it('annotates research_import accounts with zero activity as _prospect, not _cold', () => {
    const ranked = rankAccounts(
      [
        { id: 'p', source: 'research_import', last_activity_at: null, activity_count: 0 },
      ],
      NOW,
    );
    expect(ranked[0]._prospect).toBe(true);
    expect(ranked[0]._cold).toBe(false);
  });

  it('ranks true cold (engaged but dormant) above prospects (never engaged)', () => {
    const ranked = rankAccounts(
      [
        { id: 'prospect', source: 'research_import', last_activity_at: null, activity_count: 0 },
        { id: 'cold',     source: 'manual',          last_activity_at: dayAgo(45), activity_count: 5 },
      ],
      NOW,
    );
    expect(ranked[0].id).toBe('cold');
    expect(ranked[0]._cold).toBe(true);
    expect(ranked[1].id).toBe('prospect');
    expect(ranked[1]._prospect).toBe(true);
  });

  it('ranks prospects above warm accounts so they still surface', () => {
    const ranked = rankAccounts(
      [
        { id: 'warm',     source: 'manual',          last_activity_at: dayAgo(2),  activity_count: 5 },
        { id: 'prospect', source: 'research_import', last_activity_at: null,        activity_count: 0 },
      ],
      NOW,
    );
    expect(ranked[0].id).toBe('prospect');
    expect(ranked[1].id).toBe('warm');
  });

  it('annotates starred accounts with _starred=true', () => {
    const ranked = rankAccounts(
      [
        { id: 'a', last_activity_at: dayAgo(2), activity_count: 0 },
        { id: 'b', last_activity_at: dayAgo(2), activity_count: 0 },
      ],
      NOW,
      { starredIds: new Set(['a']) },
    );
    expect(ranked.find((r) => r.id === 'a')._starred).toBe(true);
    expect(ranked.find((r) => r.id === 'b')._starred).toBe(false);
  });

  it('treats a missing or non-Set starredIds option as no stars', () => {
    const ranked = rankAccounts(
      [{ id: 'a', last_activity_at: dayAgo(2), activity_count: 0 }],
      NOW,
    );
    expect(ranked[0]._starred).toBe(false);
    const ranked2 = rankAccounts(
      [{ id: 'a', last_activity_at: dayAgo(2), activity_count: 0 }],
      NOW,
      { starredIds: ['a'] },  // wrong type — should be Set
    );
    expect(ranked2[0]._starred).toBe(false);
  });

  it('ranks a starred warm account above an unstarred cold account', () => {
    const ranked = rankAccounts(
      [
        { id: 'cold',    source: 'manual', last_activity_at: dayAgo(45), activity_count: 5 },
        { id: 'starred', source: 'manual', last_activity_at: dayAgo(2),  activity_count: 5 },
      ],
      NOW,
      { starredIds: new Set(['starred']) },
    );
    // Star bonus (+75) outweighs cold bonus (+50) so starred surfaces first.
    expect(ranked[0].id).toBe('starred');
    expect(ranked[0]._starred).toBe(true);
  });

  it('among multiple starred accounts, prioritizes longer dormancy', () => {
    const ranked = rankAccounts(
      [
        { id: 'recent',  source: 'manual', last_activity_at: dayAgo(3),  activity_count: 5 },
        { id: 'dormant', source: 'manual', last_activity_at: dayAgo(40), activity_count: 5 },
      ],
      NOW,
      { starredIds: new Set(['recent', 'dormant']) },
    );
    // Both starred → recency drives order. Dormant is also flagged cold
    // so it earns the cold bonus on top of the star bonus.
    expect(ranked[0].id).toBe('dormant');
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

// ─── Profile fetchers ───
function chainable(finalResult) {
  // Builds a thenable that records every chain method called and
  // resolves to the supplied result when awaited.
  const chain = {};
  const methods = ['select', 'eq', 'order', 'limit'];
  for (const m of methods) chain[m] = () => chain;
  chain.single = () => Promise.resolve(finalResult);
  chain.then = (resolve) => Promise.resolve(finalResult).then(resolve);
  return chain;
}

describe('fetchAccount', () => {
  it('returns null + null when client or id is missing', async () => {
    expect(await fetchAccount(null, 'abc')).toEqual({ data: null, error: null });
    expect(await fetchAccount({}, null)).toEqual({ data: null, error: null });
  });

  it('queries bd_accounts by id and uses .single()', async () => {
    const account = { id: 'A', name: 'Hoag' };
    const stub = { from: () => chainable({ data: account, error: null }) };
    const r = await fetchAccount(stub, 'A');
    expect(r.data).toEqual(account);
    expect(r.error).toBe(null);
  });
});

describe('fetchAccountContacts', () => {
  it('returns empty when missing inputs', async () => {
    expect(await fetchAccountContacts(null, 'a')).toEqual({ data: [], error: null });
    expect(await fetchAccountContacts({}, null)).toEqual({ data: [], error: null });
  });

  it('returns the contacts for an account', async () => {
    const contacts = [{ id: 'c1', name: 'Sarah', is_primary: true }];
    const stub = { from: () => chainable({ data: contacts, error: null }) };
    const r = await fetchAccountContacts(stub, 'A');
    expect(r.data).toEqual(contacts);
  });
});

describe('fetchAccountActivities', () => {
  it('returns empty when missing inputs', async () => {
    expect(await fetchAccountActivities(null, 'a')).toEqual({ data: [], error: null });
    expect(await fetchAccountActivities({}, null)).toEqual({ data: [], error: null });
  });

  it('returns activities for an account', async () => {
    const acts = [{ id: 'x', activity_type: 'visit', occurred_at: dayAgo(1) }];
    const stub = { from: () => chainable({ data: acts, error: null }) };
    const r = await fetchAccountActivities(stub, 'A');
    expect(r.data).toEqual(acts);
  });
});

describe('formatActivityDate', () => {
  it('handles Today / Yesterday / N days', () => {
    const now = new Date('2026-05-09T20:00:00');
    expect(formatActivityDate(new Date('2026-05-09T08:00:00').toISOString(), now)).toBe('Today');
    expect(formatActivityDate(new Date('2026-05-08T08:00:00').toISOString(), now)).toBe('Yesterday');
    expect(formatActivityDate(new Date('2026-05-06T08:00:00').toISOString(), now)).toBe('3 days ago');
  });

  it('omits the year for same-year dates', () => {
    const now = new Date('2026-05-09T12:00:00');
    expect(formatActivityDate(new Date('2026-02-14T12:00:00').toISOString(), now)).not.toMatch(/2026/);
  });

  it('includes the year for prior-year dates', () => {
    const now = new Date('2026-05-09T12:00:00');
    expect(formatActivityDate(new Date('2025-12-25T12:00:00').toISOString(), now)).toMatch(/2025/);
  });

  it('returns empty string for missing/invalid input', () => {
    expect(formatActivityDate(null)).toBe('');
    expect(formatActivityDate('garbage')).toBe('');
  });
});

describe('formatAccountSubtitle', () => {
  it('combines facility subtype with city/state', () => {
    expect(formatAccountSubtitle({
      account_type: 'facility',
      facility_subtype: 'snf',
      city: 'Laguna Hills',
      state: 'CA',
    })).toBe('snf · Laguna Hills, CA');
  });

  it('uses professional subtype when account_type is professional', () => {
    expect(formatAccountSubtitle({
      account_type: 'professional',
      professional_subtype: 'attorney',
      city: 'Newport Beach',
      state: 'CA',
    })).toBe('attorney · Newport Beach, CA');
  });

  it('falls back to generic labels when subtype is null', () => {
    expect(formatAccountSubtitle({ account_type: 'facility', city: 'Irvine', state: 'CA' }))
      .toBe('Facility · Irvine, CA');
    expect(formatAccountSubtitle({ account_type: 'professional', state: 'CA' }))
      .toBe('Professional · CA');
  });

  it('returns empty for null input', () => {
    expect(formatAccountSubtitle(null)).toBe('');
  });
});

describe('activity-type lookup tables', () => {
  it('cover all bd_activities.activity_type CHECK values', () => {
    const expected = ['visit', 'call', 'email', 'sms', 'drop_off', 'event', 'referral_received', 'note'];
    for (const t of expected) {
      expect(ACTIVITY_TYPE_LABELS[t], `label for ${t}`).toBeTruthy();
      expect(ACTIVITY_TYPE_ICON_TYPES, `icon for ${t}`).toContain(t);
    }
  });
});

// ─── Geofence + routing helpers ─────────────────────────────────

describe('DEFAULT_NEARBY_RADIUS_METERS', () => {
  it('is a sensible parking-lot-sized default', () => {
    // Tight enough to avoid false positives on adjacent buildings,
    // loose enough for the rep to be anywhere on a hospital campus.
    expect(DEFAULT_NEARBY_RADIUS_METERS).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_NEARBY_RADIUS_METERS).toBeLessThanOrEqual(500);
  });
});

describe('haversineMeters', () => {
  it('returns zero for the same point', () => {
    expect(haversineMeters(33.65, -117.74, 33.65, -117.74)).toBe(0);
  });

  // Known fixture: ~1 degree of latitude ≈ 111 km. Allow 1% tolerance.
  it('approximates 111km for one degree of latitude', () => {
    const d = haversineMeters(33.0, -117.74, 34.0, -117.74);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  // Two points ~200m apart in Laguna Hills. Hand-computed reference.
  it('measures sub-kilometer distances within a few percent', () => {
    const d = haversineMeters(33.6500, -117.7400, 33.6518, -117.7400);
    expect(d).toBeGreaterThan(180);
    expect(d).toBeLessThan(220);
  });

  it('returns null for non-numeric inputs', () => {
    expect(haversineMeters('a', -117.74, 33.65, -117.74)).toBe(null);
    expect(haversineMeters(33.65, null, 33.65, -117.74)).toBe(null);
    expect(haversineMeters(33.65, -117.74, undefined, -117.74)).toBe(null);
    expect(haversineMeters(NaN, -117.74, 33.65, -117.74)).toBe(null);
  });
});

describe('findNearestAccount', () => {
  const me = { lat: 33.6500, lng: -117.7400 };
  const accounts = [
    { id: 'a', name: 'Far Away',    lat: 34.0000, lng: -117.7400 }, // ~111km
    { id: 'b', name: 'Two Blocks',  lat: 33.6518, lng: -117.7400 }, // ~200m
    { id: 'c', name: 'Right Here',  lat: 33.6501, lng: -117.7401 }, // ~13m
    { id: 'd', name: 'No Geo',      lat: null,    lng: null },
  ];

  it('returns the closest account within radius', () => {
    const res = findNearestAccount(accounts, me, { radiusMeters: 200 });
    expect(res?.account.id).toBe('c');
    expect(res?.distance_meters).toBeLessThan(30);
  });

  it('returns null if nothing falls within radius', () => {
    // A 5-meter radius excludes all of our fixtures.
    expect(findNearestAccount(accounts, me, { radiusMeters: 5 })).toBe(null);
  });

  it('returns null on empty or non-array accounts input', () => {
    expect(findNearestAccount([], me)).toBe(null);
    expect(findNearestAccount(null, me)).toBe(null);
    expect(findNearestAccount(undefined, me)).toBe(null);
  });

  it('returns null when position is missing or malformed', () => {
    expect(findNearestAccount(accounts, null)).toBe(null);
    expect(findNearestAccount(accounts, { lat: 'a', lng: 'b' })).toBe(null);
    expect(findNearestAccount(accounts, {})).toBe(null);
  });

  it('skips accounts without coordinates (no-op path)', () => {
    const onlyMissing = [{ id: 'x', lat: null, lng: null }];
    expect(findNearestAccount(onlyMissing, me)).toBe(null);
  });

  it('uses the default radius when none is given', () => {
    // 'c' is ~13m away, well inside the default 200m.
    const res = findNearestAccount(accounts, me);
    expect(res?.account.id).toBe('c');
  });
});

describe('formatStopAddress', () => {
  it('joins street + city/state + zip into a single line', () => {
    expect(formatStopAddress({
      address: '24451 Health Center Dr',
      city: 'Laguna Hills',
      state: 'CA',
      zip: '92653',
    })).toBe('24451 Health Center Dr, Laguna Hills, CA, 92653');
  });

  it('omits missing segments without leaving stray punctuation', () => {
    expect(formatStopAddress({ address: '123 Main St', city: 'Irvine' }))
      .toBe('123 Main St, Irvine');
    expect(formatStopAddress({ address: '123 Main St' })).toBe('123 Main St');
  });

  it('falls back to name + city when there is no street address', () => {
    expect(formatStopAddress({ name: 'Riverside Hospital', city: 'Anaheim' }))
      .toBe('Riverside Hospital, Anaheim');
  });

  it('returns null when no usable fields are present', () => {
    expect(formatStopAddress({})).toBe(null);
    expect(formatStopAddress(null)).toBe(null);
    expect(formatStopAddress({ name: '' })).toBe(null);
  });
});

describe('buildAppleMapsRouteUrl', () => {
  const stops = [
    { name: 'A', address: '100 First St', city: 'Irvine',       state: 'CA' },
    { name: 'B', address: '200 Second St', city: 'Laguna Hills', state: 'CA' },
  ];

  it('builds a multi-stop Apple Maps URL', () => {
    const url = buildAppleMapsRouteUrl(stops);
    expect(url).toBeTruthy();
    expect(url.startsWith('https://maps.apple.com/?')).toBe(true);
    expect(url).toContain('saddr=Current+Location');
    expect(url).toContain('dirflg=d');
    // Apple Maps' multi-stop separator is a *literal* '+to:' — only
    // the address strings themselves are URL-encoded.
    expect(url).toMatch(/100%20First%20St[^&]*\+to:[^&]*200%20Second%20St/);
  });

  it('omits the current-location saddr when asked', () => {
    const url = buildAppleMapsRouteUrl(stops, { fromCurrentLocation: false });
    expect(url).not.toContain('saddr=');
  });

  it('returns null when no stops have addresses', () => {
    expect(buildAppleMapsRouteUrl([])).toBe(null);
    expect(buildAppleMapsRouteUrl(null)).toBe(null);
    expect(buildAppleMapsRouteUrl([{ name: '' }])).toBe(null);
  });

  it('falls back to name+city for stops missing a street address', () => {
    const mixed = [
      { name: 'Hoag Hospital', city: 'Newport Beach' },
      { name: 'B', address: '200 Second St', city: 'Laguna Hills' },
    ];
    const url = buildAppleMapsRouteUrl(mixed);
    expect(url).toContain('Hoag%20Hospital');
    expect(url).toContain('200%20Second%20St');
  });
});

describe('hasRoutableAddress', () => {
  it('accepts an explicit street address', () => {
    expect(hasRoutableAddress({ address: '100 Main St' })).toBe(true);
  });

  it('accepts name + city as a fallback', () => {
    expect(hasRoutableAddress({ name: 'Riverside', city: 'Anaheim' })).toBe(true);
  });

  it('rejects accounts with only one of name/city', () => {
    expect(hasRoutableAddress({ name: 'Riverside' })).toBe(false);
    expect(hasRoutableAddress({ city: 'Anaheim' })).toBe(false);
  });

  it('rejects null/empty input', () => {
    expect(hasRoutableAddress(null)).toBe(false);
    expect(hasRoutableAddress({})).toBe(false);
  });
});

describe('hasPreciseCoordinate', () => {
  it('returns true for finite numeric lat/lng pairs', () => {
    expect(hasPreciseCoordinate({ lat: 33.65, lng: -117.74 })).toBe(true);
    expect(hasPreciseCoordinate({ lat: 0, lng: 0 })).toBe(true);
  });

  it('returns false for missing or non-numeric values', () => {
    expect(hasPreciseCoordinate({ lat: null, lng: null })).toBe(false);
    expect(hasPreciseCoordinate({ lat: '33', lng: -117.74 })).toBe(false);
    expect(hasPreciseCoordinate({ lat: NaN, lng: -117.74 })).toBe(false);
    expect(hasPreciseCoordinate({ lat: 33.65 })).toBe(false);
    expect(hasPreciseCoordinate(null)).toBe(false);
  });
});

// ─── Territory filtering ──────────────────────────────────────────

describe('normalizeCityForMatch', () => {
  it('lowercases and trims', () => {
    expect(normalizeCityForMatch('  Mission Viejo  ')).toBe('mission viejo');
    expect(normalizeCityForMatch('NEWPORT BEACH')).toBe('newport beach');
  });
  it('returns empty string for null/undefined/empty', () => {
    expect(normalizeCityForMatch(null)).toBe('');
    expect(normalizeCityForMatch(undefined)).toBe('');
    expect(normalizeCityForMatch('')).toBe('');
  });
  it('coerces non-strings without crashing', () => {
    expect(normalizeCityForMatch(42)).toBe('42');
  });
});

describe('filterToTerritory', () => {
  const SOUTH_OC = ['Mission Viejo', 'Newport Beach', 'Aliso Viejo', 'RMV', 'Rancho Mission Viejo'];

  it('returns every account when the territory city list is empty', () => {
    const accounts = [
      { id: 'a', city: 'Huntington Beach' },
      { id: 'b', city: 'Orange' },
    ];
    expect(filterToTerritory(accounts, [])).toEqual(accounts);
  });

  it('returns every account when the territory city list is null', () => {
    const accounts = [{ id: 'a', city: 'Huntington Beach' }];
    expect(filterToTerritory(accounts, null)).toEqual(accounts);
  });

  it('keeps accounts whose city is in the territory (case-insensitive)', () => {
    const accounts = [
      { id: 'a', city: 'Mission Viejo' },
      { id: 'b', city: 'newport beach' },
      { id: 'c', city: 'NEWPORT BEACH' },
      { id: 'd', city: 'Huntington Beach' },
    ];
    const out = filterToTerritory(accounts, SOUTH_OC).map((a) => a.id);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('matches both formal and shorthand city variants when both are in the territory list', () => {
    const accounts = [
      { id: 'rmv', city: 'RMV' },
      { id: 'rmv_long', city: 'Rancho Mission Viejo' },
    ];
    const out = filterToTerritory(accounts, SOUTH_OC).map((a) => a.id);
    expect(out).toEqual(['rmv', 'rmv_long']);
  });

  it('always keeps strategic-shared accounts regardless of city', () => {
    const accounts = [
      { id: 'hoag', city: 'Newport Beach', is_strategic_shared: true },
      { id: 'uci', city: 'Orange', is_strategic_shared: true },
      { id: 'random_orange', city: 'Orange', is_strategic_shared: false },
    ];
    const out = filterToTerritory(accounts, SOUTH_OC).map((a) => a.id);
    expect(out).toContain('hoag');
    expect(out).toContain('uci'); // Out of territory but flagged strategic
    expect(out).not.toContain('random_orange');
  });

  it('excludes accounts with no city when not strategic', () => {
    const accounts = [
      { id: 'nocity', city: null, is_strategic_shared: false },
      { id: 'nocity_strategic', city: null, is_strategic_shared: true },
    ];
    const out = filterToTerritory(accounts, SOUTH_OC).map((a) => a.id);
    expect(out).toEqual(['nocity_strategic']);
  });

  it('returns empty array (not crash) for null or non-array accounts input', () => {
    expect(filterToTerritory(null, SOUTH_OC)).toEqual([]);
    expect(filterToTerritory(undefined, SOUTH_OC)).toEqual([]);
  });
});

describe('fetchCurrentUserTerritoryCities', () => {
  it('returns the RPC payload as an array of cities', async () => {
    const supabase = { rpc: async () => ({ data: ['Mission Viejo', 'Newport Beach'], error: null }) };
    const res = await fetchCurrentUserTerritoryCities(supabase);
    expect(res.error).toBe(null);
    expect(res.data).toEqual(['Mission Viejo', 'Newport Beach']);
  });

  it('returns empty array when the RPC payload is null', async () => {
    const supabase = { rpc: async () => ({ data: null, error: null }) };
    const res = await fetchCurrentUserTerritoryCities(supabase);
    expect(res.data).toEqual([]);
  });

  it('returns empty array (not throw) when supabase is not provided', async () => {
    const res = await fetchCurrentUserTerritoryCities(null);
    expect(res.data).toEqual([]);
    expect(res.error).toBe(null);
  });

  it('surfaces an error from the RPC without exploding', async () => {
    const supabase = { rpc: async () => ({ data: null, error: { message: 'rpc failed' } }) };
    const res = await fetchCurrentUserTerritoryCities(supabase);
    expect(res.error).toEqual({ message: 'rpc failed' });
    expect(res.data).toEqual([]);
  });

  it('calls the named RPC bd_current_user_territory_cities', async () => {
    let calledWith = null;
    const supabase = { rpc: async (name) => { calledWith = name; return { data: [], error: null }; } };
    await fetchCurrentUserTerritoryCities(supabase);
    expect(calledWith).toBe('bd_current_user_territory_cities');
  });
});

describe('fetchTerritoryCitiesForUser', () => {
  it('calls the parameterized RPC with p_user_id when a user id is given', async () => {
    let calledWith = null;
    let calledArgs = null;
    const supabase = {
      rpc: async (name, args) => {
        calledWith = name;
        calledArgs = args;
        return { data: ['Irvine'], error: null };
      },
    };
    const res = await fetchTerritoryCitiesForUser(supabase, 'rep-123');
    expect(calledWith).toBe('bd_territory_cities_for_user');
    expect(calledArgs).toEqual({ p_user_id: 'rep-123' });
    expect(res.data).toEqual(['Irvine']);
  });

  it('falls back to the self-scoped RPC when no user id is given', async () => {
    let calledWith = null;
    const supabase = { rpc: async (name) => { calledWith = name; return { data: [], error: null }; } };
    await fetchTerritoryCitiesForUser(supabase, null);
    expect(calledWith).toBe('bd_current_user_territory_cities');
  });

  it('returns [] (not throw) when supabase is missing', async () => {
    const res = await fetchTerritoryCitiesForUser(null, 'rep-123');
    expect(res.data).toEqual([]);
    expect(res.error).toBe(null);
  });

  it('surfaces an RPC error and degrades to []', async () => {
    const supabase = { rpc: async () => ({ data: null, error: { message: 'denied' } }) };
    const res = await fetchTerritoryCitiesForUser(supabase, 'rep-123');
    expect(res.error).toEqual({ message: 'denied' });
    expect(res.data).toEqual([]);
  });
});

describe('fetchStarredAccountIdsForUser', () => {
  // Minimal chainable stub: from().select().eq() resolves to { data, error }.
  function makeStarsClient(result) {
    let eqArgs = null;
    const client = {
      _table: null,
      from(table) { client._table = table; return client; },
      select() { return client; },
      eq(col, val) { eqArgs = { col, val }; return Promise.resolve(result); },
      get eqArgs() { return eqArgs; },
    };
    return client;
  }

  it('filters by the explicit user_id and returns a Set of account ids', async () => {
    const client = makeStarsClient({ data: [{ account_id: 'a1' }, { account_id: 'a2' }], error: null });
    const res = await fetchStarredAccountIdsForUser(client, 'rep-123');
    expect(res.error).toBe(null);
    expect(res.data).toBeInstanceOf(Set);
    expect([...res.data].sort()).toEqual(['a1', 'a2']);
    expect(client.eqArgs).toEqual({ col: 'user_id', val: 'rep-123' });
    expect(client._table).toBe('bd_account_stars');
  });

  it('returns an empty Set without querying when no user id is given', async () => {
    let queried = false;
    const client = { from() { queried = true; return client; } };
    const res = await fetchStarredAccountIdsForUser(client, null);
    expect(res.data).toBeInstanceOf(Set);
    expect(res.data.size).toBe(0);
    expect(queried).toBe(false);
  });

  it('returns an empty Set (not throw) when supabase is missing', async () => {
    const res = await fetchStarredAccountIdsForUser(null, 'rep-123');
    expect(res.data.size).toBe(0);
    expect(res.error).toBe(null);
  });

  it('degrades to an empty Set on query error', async () => {
    const client = makeStarsClient({ data: null, error: { message: 'rls' } });
    const res = await fetchStarredAccountIdsForUser(client, 'rep-123');
    expect(res.error).toEqual({ message: 'rls' });
    expect(res.data.size).toBe(0);
  });
});

describe('fetchAuditableReps', () => {
  it('calls the owner-gated RPC and returns the rep rows', async () => {
    let calledWith = null;
    const rows = [{ user_id: 'amy', email: 'amy@x.com', full_name: 'Amy Dutton' }];
    const supabase = { rpc: async (name) => { calledWith = name; return { data: rows, error: null }; } };
    const res = await fetchAuditableReps(supabase);
    expect(calledWith).toBe('bd_list_auditable_reps');
    expect(res.data).toEqual(rows);
  });

  it('returns [] for a non-owner (RPC yields no rows)', async () => {
    const supabase = { rpc: async () => ({ data: [], error: null }) };
    const res = await fetchAuditableReps(supabase);
    expect(res.data).toEqual([]);
  });

  it('degrades to [] on error or missing client', async () => {
    const errClient = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
    expect((await fetchAuditableReps(errClient)).data).toEqual([]);
    expect((await fetchAuditableReps(null)).data).toEqual([]);
  });
});
