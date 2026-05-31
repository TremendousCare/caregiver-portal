import { describe, it, expect } from 'vitest';
import {
  RESOURCE_MODES,
  UNASSIGNED_ROW_ID,
  DEFAULT_DAY_START_HOUR,
  DEFAULT_DAY_END_HOUR,
  caregiverRowLabel,
  clientRowLabel,
  computeDayWindowMs,
  computeDisplayBand,
  computeBarGeometry,
  assignLanes,
  buildResourceRows,
  buildHourTicks,
} from '../../features/scheduling/resourceLaneHelpers';
import {
  DEFAULT_APP_TIMEZONE,
  wallClockToUtcMs,
  utcMsToWallClockParts,
} from '../../lib/scheduling/timezone';

// Timezone-sensitive fixtures are built *through* wallClockToUtcMs in the
// app's default zone so they map to a known agency-local wall-clock time
// regardless of the host's own local zone (the CI box runs in UTC, a dev
// laptop may not). We always pass DEFAULT_APP_TIMEZONE explicitly — both
// when building fixtures and when reading them back — so the production
// offset is used on both sides and assertions describe what the office
// actually sees, not hardcoded UTC strings.
const TZ = DEFAULT_APP_TIMEZONE;

// An anchor instant that is unambiguously local-noon on 2026-06-01.
const ANCHOR_MS = wallClockToUtcMs({ year: 2026, month: 6, day: 1, hour: 12, minute: 0, second: 0 }, TZ);
const ANCHOR_ISO = new Date(ANCHOR_MS).toISOString();

// Build an ISO timestamp for a given agency-local wall-clock time.
function localIso(hour, minute = 0, day = 1) {
  return new Date(
    wallClockToUtcMs({ year: 2026, month: 6, day, hour, minute, second: 0 }, TZ),
  ).toISOString();
}

// ─── constants ─────────────────────────────────────────────────

describe('resource-lane constants', () => {
  it('exposes caregiver and client as the row modes', () => {
    expect(RESOURCE_MODES).toEqual(['caregiver', 'client']);
  });

  it('has a sane default daytime band', () => {
    expect(DEFAULT_DAY_START_HOUR).toBe(6);
    expect(DEFAULT_DAY_END_HOUR).toBe(22);
  });
});

// ─── label helpers ─────────────────────────────────────────────

describe('caregiverRowLabel', () => {
  it('joins first and last name', () => {
    expect(caregiverRowLabel({ firstName: 'Hazel', lastName: 'Zigner' })).toBe('Hazel Zigner');
  });
  it('trims when one name is missing', () => {
    expect(caregiverRowLabel({ firstName: 'Hazel' })).toBe('Hazel');
  });
  it('falls back for empty / null', () => {
    expect(caregiverRowLabel({})).toBe('Unnamed caregiver');
    expect(caregiverRowLabel(null)).toBe('Unknown caregiver');
  });
});

describe('clientRowLabel', () => {
  it('joins first and last name', () => {
    expect(clientRowLabel({ firstName: 'Robert', lastName: 'Greenfield' })).toBe('Robert Greenfield');
  });
  it('falls back for empty / null', () => {
    expect(clientRowLabel({})).toBe('Unnamed client');
    expect(clientRowLabel(null)).toBe('Unknown client');
  });
});

// ─── computeDayWindowMs ────────────────────────────────────────

describe('computeDayWindowMs', () => {
  it('maps the band edges back to the requested local hours', () => {
    const { startMs, endMs } = computeDayWindowMs({ date: ANCHOR_ISO, startHour: 6, endHour: 22 });
    const s = utcMsToWallClockParts(startMs, TZ);
    const e = utcMsToWallClockParts(endMs, TZ);
    expect(s.hour).toBe(6);
    expect(s.minute).toBe(0);
    expect(e.hour).toBe(22);
  });

  it('treats endHour 24 as local midnight of the next day', () => {
    const { startMs, endMs } = computeDayWindowMs({ date: ANCHOR_ISO, startHour: 0, endHour: 24 });
    expect(utcMsToWallClockParts(startMs, TZ).hour).toBe(0);
    const e = utcMsToWallClockParts(endMs, TZ);
    expect(e.hour).toBe(0);
    // The end rolled over to the following local day.
    expect(e.day).not.toBe(utcMsToWallClockParts(startMs, TZ).day);
  });

  it('produces a positive span', () => {
    const { startMs, endMs } = computeDayWindowMs({ date: ANCHOR_ISO });
    expect(endMs).toBeGreaterThan(startMs);
  });
});

// ─── computeBarGeometry ────────────────────────────────────────

describe('computeBarGeometry', () => {
  const w0 = 0;
  const w100 = 100;

  it('places a fully-contained interval', () => {
    const g = computeBarGeometry(25, 75, w0, w100);
    expect(g.leftPct).toBe(25);
    expect(g.widthPct).toBe(50);
    expect(g.startsBeforeWindow).toBe(false);
    expect(g.endsAfterWindow).toBe(false);
  });

  it('clips an interval that starts before the window', () => {
    const g = computeBarGeometry(-50, 40, w0, w100);
    expect(g.leftPct).toBe(0);
    expect(g.widthPct).toBe(40);
    expect(g.startsBeforeWindow).toBe(true);
  });

  it('clips an interval that ends after the window', () => {
    const g = computeBarGeometry(60, 200, w0, w100);
    expect(g.leftPct).toBe(60);
    expect(g.widthPct).toBe(40);
    expect(g.endsAfterWindow).toBe(true);
  });

  it('returns null when the interval is entirely outside the window', () => {
    expect(computeBarGeometry(200, 300, w0, w100)).toBeNull();
    expect(computeBarGeometry(-100, -10, w0, w100)).toBeNull();
  });

  it('returns null for a zero-or-negative window span', () => {
    expect(computeBarGeometry(10, 20, 100, 100)).toBeNull();
    expect(computeBarGeometry(10, 20, 100, 50)).toBeNull();
  });

  it('returns null for a zero-length interval', () => {
    expect(computeBarGeometry(50, 50, w0, w100)).toBeNull();
  });
});

// ─── assignLanes ───────────────────────────────────────────────

describe('assignLanes', () => {
  it('keeps non-overlapping intervals in a single lane', () => {
    const { intervals, laneCount } = assignLanes([
      { startMs: 0, endMs: 10 },
      { startMs: 10, endMs: 20 }, // touches but does not overlap
      { startMs: 20, endMs: 30 },
    ]);
    expect(laneCount).toBe(1);
    expect(intervals.every((iv) => iv.lane === 0)).toBe(true);
  });

  it('stacks two overlapping intervals into two lanes', () => {
    const { intervals, laneCount } = assignLanes([
      { startMs: 0, endMs: 30 },
      { startMs: 10, endMs: 40 },
    ]);
    expect(laneCount).toBe(2);
    expect(intervals[0].lane).toBe(0);
    expect(intervals[1].lane).toBe(1);
  });

  it('reuses a freed lane once an interval has ended', () => {
    const { intervals, laneCount } = assignLanes([
      { startMs: 0, endMs: 10 },
      { startMs: 5, endMs: 15 }, // overlaps first -> lane 1
      { startMs: 12, endMs: 20 }, // first lane free again -> lane 0
    ]);
    expect(laneCount).toBe(2);
    expect(intervals.find((i) => i.startMs === 12).lane).toBe(0);
  });

  it('sorts by start then end and ignores malformed intervals', () => {
    const { intervals } = assignLanes([
      { startMs: 30, endMs: 40 },
      { startMs: 10, endMs: 20 },
      null,
      { startMs: NaN, endMs: 5 },
    ]);
    expect(intervals.map((i) => i.startMs)).toEqual([10, 30]);
  });

  it('handles an empty / nullish list', () => {
    expect(assignLanes([]).laneCount).toBe(1);
    expect(assignLanes(undefined).intervals).toEqual([]);
  });
});

// ─── buildResourceRows ─────────────────────────────────────────

const CG = [
  { id: 'cg1', firstName: 'Bianca', lastName: 'Adams' },
  { id: 'cg2', firstName: 'Aaron', lastName: 'Zane' },
  { id: 'cg3', firstName: 'Carl', lastName: 'Idle' }, // no shifts
];
const CL = [
  { id: 'cl1', firstName: 'Hazel', lastName: 'Zigner' },
  { id: 'cl2', firstName: 'Robert', lastName: 'Greenfield' },
];

function shift(over = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    clientId: 'cl1',
    assignedCaregiverId: 'cg1',
    startTime: '2026-06-01T16:00:00Z',
    endTime: '2026-06-01T20:00:00Z',
    status: 'assigned',
    ...over,
  };
}

describe('buildResourceRows — caregiver mode', () => {
  it('creates one row per caregiver with shifts, sorted by name', () => {
    const rows = buildResourceRows({
      mode: 'caregiver',
      caregivers: CG,
      shifts: [shift({ assignedCaregiverId: 'cg1' }), shift({ assignedCaregiverId: 'cg2' })],
    });
    expect(rows.map((r) => r.label)).toEqual(['Aaron Zane', 'Bianca Adams']);
  });

  it('omits caregivers with no shifts by default', () => {
    const rows = buildResourceRows({
      mode: 'caregiver',
      caregivers: CG,
      shifts: [shift({ assignedCaregiverId: 'cg1' })],
    });
    expect(rows.map((r) => r.id)).toEqual(['cg1']);
  });

  it('includes empty caregiver rows when asked', () => {
    const rows = buildResourceRows({
      mode: 'caregiver',
      caregivers: CG,
      shifts: [shift({ assignedCaregiverId: 'cg1' })],
      includeEmptyRows: true,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['cg1', 'cg2', 'cg3']);
  });

  it('pins an Unassigned row to the top for open shifts', () => {
    const rows = buildResourceRows({
      mode: 'caregiver',
      caregivers: CG,
      shifts: [
        shift({ assignedCaregiverId: 'cg1' }),
        shift({ assignedCaregiverId: null, status: 'open' }),
      ],
    });
    expect(rows[0].id).toBe(UNASSIGNED_ROW_ID);
    expect(rows[0].type).toBe('unassigned');
    expect(rows[0].shifts).toHaveLength(1);
  });

  it('drops cancelled shifts (consistent with the rest of the calendar)', () => {
    const rows = buildResourceRows({
      mode: 'caregiver',
      caregivers: CG,
      shifts: [shift({ assignedCaregiverId: 'cg1', status: 'cancelled' })],
    });
    expect(rows).toHaveLength(0);
  });

  it('still rows a shift whose caregiver is not in the provided list', () => {
    const rows = buildResourceRows({
      mode: 'caregiver',
      caregivers: [],
      shifts: [shift({ assignedCaregiverId: 'ghost' })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Unknown caregiver');
  });
});

describe('buildResourceRows — client mode', () => {
  it('creates one row per client with shifts', () => {
    const rows = buildResourceRows({
      mode: 'client',
      clients: CL,
      shifts: [shift({ clientId: 'cl1' }), shift({ clientId: 'cl2' })],
    });
    expect(rows.map((r) => r.label)).toEqual(['Hazel Zigner', 'Robert Greenfield']);
  });

  it('never creates an Unassigned row in client mode', () => {
    const rows = buildResourceRows({
      mode: 'client',
      clients: CL,
      shifts: [shift({ clientId: 'cl1', assignedCaregiverId: null, status: 'open' })],
    });
    expect(rows.every((r) => r.id !== UNASSIGNED_ROW_ID)).toBe(true);
    expect(rows).toHaveLength(1);
  });
});

// ─── buildHourTicks ────────────────────────────────────────────

describe('buildHourTicks', () => {
  it('emits inclusive ticks across the band', () => {
    const ticks = buildHourTicks(6, 9);
    expect(ticks.map((t) => t.hour)).toEqual([6, 7, 8, 9]);
    expect(ticks[0].leftPct).toBe(0);
    expect(ticks[ticks.length - 1].leftPct).toBe(100);
  });

  it('wraps hours past midnight to 0–23', () => {
    const ticks = buildHourTicks(22, 24);
    expect(ticks.map((t) => t.hour)).toEqual([22, 23, 0]);
  });

  it('returns nothing for a non-positive span', () => {
    expect(buildHourTicks(10, 10)).toEqual([]);
    expect(buildHourTicks(10, 5)).toEqual([]);
  });
});

// ─── computeDisplayBand ────────────────────────────────────────

describe('computeDisplayBand', () => {
  it('returns the default band (with padding) when no shifts', () => {
    const band = computeDisplayBand([], { date: ANCHOR_ISO });
    expect(band.startHour).toBe(DEFAULT_DAY_START_HOUR - 1);
    expect(band.endHour).toBe(DEFAULT_DAY_END_HOUR + 1);
  });

  it('expands earlier for an early-morning shift', () => {
    const band = computeDisplayBand(
      [shift({ startTime: localIso(3), endTime: localIso(7) })], // 03:00–07:00 local
      { date: ANCHOR_ISO, padHours: 1 },
    );
    expect(band.startHour).toBe(2); // 3am shift, minus 1h padding
  });

  it('expands later for a late-night shift', () => {
    const band = computeDisplayBand(
      [shift({ startTime: localIso(21), endTime: localIso(23, 30) })], // 21:00–23:30 local
      { date: ANCHOR_ISO, padHours: 1 },
    );
    expect(band.endHour).toBe(24); // 23:30 rounds to 24, capped at 24
  });

  it('never narrows beyond the default band', () => {
    const band = computeDisplayBand(
      [shift({ startTime: localIso(12), endTime: localIso(13) })], // midday local
      { date: ANCHOR_ISO, padHours: 0 },
    );
    expect(band.startHour).toBeLessThanOrEqual(DEFAULT_DAY_START_HOUR);
    expect(band.endHour).toBeGreaterThanOrEqual(DEFAULT_DAY_END_HOUR);
  });
});
