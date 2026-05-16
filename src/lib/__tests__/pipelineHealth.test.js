/**
 * Pipeline Health UI — pure logic helpers (Phase 1.5 follow-up).
 *
 * The data layer for /pipeline-health: row construction, phase
 * grouping, sort order, stall severity classification, AI
 * suggestion indexing, and filtering.
 *
 * Spec: docs/AGENT_PLATFORM_PIPELINE_HEALTH_SPEC.md
 */

import { describe, it, expect } from 'vitest';

import {
  STALL_AMBER_DAYS,
  STALL_RED_DAYS,
  stallSeverity,
  buildPipelineRow,
  groupCaregiversByPhase,
  medianDaysInPhase,
  indexSuggestionsByEntity,
  filterPipelineGroups,
} from '../pipelineHealth';

// `getDaysInPhase` reads `caregiver.phaseTimestamps[currentPhase]`
// and computes against `Date.now()` directly — so the fixture has
// to anchor on the real current time, not an injected constant.
// `Math.floor((now - phaseStart) / 86400000)` floors to whole days,
// so `daysAgo(N) → now - N*86400000 - 1ms` keeps the daysInPhase
// result exactly at N (one tick into the Nth day).
const NOW = Date.now();

function daysAgo(n) {
  // Subtract one extra millisecond so the floor lands at N, not N-1.
  return NOW - n * 86_400_000 - 1;
}

function makeCaregiver(overrides = {}) {
  return {
    id:        overrides.id || 'cg-1',
    first_name: overrides.first_name || 'Maria',
    last_name:  overrides.last_name || 'Garcia',
    archived:   false,
    employmentStatus: 'onboarding',
    phaseTimestamps: {
      intake:    daysAgo(overrides.daysInIntake ?? 2),
    },
    notes: overrides.notes || [],
    created_at: overrides.created_at || new Date(NOW - 30 * 86_400_000).toISOString(),
    ...overrides,
  };
}

describe('stallSeverity', () => {
  it('returns none below the amber threshold', () => {
    expect(stallSeverity(0)).toBe('none');
    expect(stallSeverity(STALL_AMBER_DAYS - 1)).toBe('none');
  });
  it('returns amber at the amber threshold up to but excluding red', () => {
    expect(stallSeverity(STALL_AMBER_DAYS)).toBe('amber');
    expect(stallSeverity(STALL_RED_DAYS - 1)).toBe('amber');
  });
  it('returns red at the red threshold and above', () => {
    expect(stallSeverity(STALL_RED_DAYS)).toBe('red');
    expect(stallSeverity(STALL_RED_DAYS + 30)).toBe('red');
  });
  it('returns none for non-numeric inputs', () => {
    expect(stallSeverity(null)).toBe('none');
    expect(stallSeverity(undefined)).toBe('none');
    expect(stallSeverity('seven')).toBe('none');
  });
  it('locks the spec thresholds at 5 / 14 days', () => {
    expect(STALL_AMBER_DAYS).toBe(5);
    expect(STALL_RED_DAYS).toBe(14);
  });
});

describe('buildPipelineRow — exclusions', () => {
  it('excludes archived caregivers', () => {
    expect(buildPipelineRow(makeCaregiver({ archived: true }), NOW)).toBeNull();
  });
  it('excludes deployed and reserve board statuses', () => {
    expect(buildPipelineRow(makeCaregiver({ board_status: 'deployed' }), NOW)).toBeNull();
    expect(buildPipelineRow(makeCaregiver({ board_status: 'reserve' }), NOW)).toBeNull();
  });
  it('excludes caregivers off the onboarding employment status', () => {
    expect(buildPipelineRow(makeCaregiver({ employmentStatus: 'active' }), NOW)).toBeNull();
    expect(buildPipelineRow(makeCaregiver({ employmentStatus: 'separated' }), NOW)).toBeNull();
  });
  it('excludes nameless records (likely test / incomplete data)', () => {
    expect(buildPipelineRow(makeCaregiver({ first_name: null, last_name: null }), NOW)).toBeNull();
  });
});

describe('buildPipelineRow — happy path', () => {
  it('returns the row shape with severity', () => {
    const row = buildPipelineRow(makeCaregiver({ daysInIntake: 7 }), NOW);
    expect(row).toMatchObject({
      currentPhase: 'intake',
      daysInPhase:  7,
      severity:     'amber',
    });
    expect(row.caregiver?.id).toBe('cg-1');
  });

  it('computes daysSinceActivity from the latest note timestamp', () => {
    const cg = makeCaregiver({
      daysInIntake: 2,
      notes: [
        { text: 'recent', timestamp: NOW - 3 * 86_400_000 },
        { text: 'older',  timestamp: NOW - 10 * 86_400_000 },
      ],
    });
    const row = buildPipelineRow(cg, NOW);
    expect(row.daysSinceActivity).toBe(3);
  });
});

describe('groupCaregiversByPhase', () => {
  it('returns an empty bucket for every PHASES entry, even when no caregivers match', () => {
    const grouped = groupCaregiversByPhase([], NOW);
    expect(Object.keys(grouped).sort()).toEqual(
      ['interview', 'intake', 'onboarding', 'orientation', 'verification'].sort(),
    );
    for (const phaseId of Object.keys(grouped)) {
      expect(grouped[phaseId]).toEqual([]);
    }
  });

  it('sorts each phase by daysInPhase DESC (most stalled first)', () => {
    const list = [
      makeCaregiver({ id: 'cg-a', daysInIntake: 3 }),
      makeCaregiver({ id: 'cg-b', daysInIntake: 12 }),
      makeCaregiver({ id: 'cg-c', daysInIntake: 7 }),
    ];
    const grouped = groupCaregiversByPhase(list, NOW);
    expect(grouped.intake.map((r) => r.caregiver.id)).toEqual(['cg-b', 'cg-c', 'cg-a']);
  });

  it('breaks daysInPhase ties by caregiver id (deterministic)', () => {
    const list = [
      makeCaregiver({ id: 'cg-z', daysInIntake: 5 }),
      makeCaregiver({ id: 'cg-a', daysInIntake: 5 }),
    ];
    const grouped = groupCaregiversByPhase(list, NOW);
    expect(grouped.intake.map((r) => r.caregiver.id)).toEqual(['cg-a', 'cg-z']);
  });

  it('drops caregivers with a current phase not in the canonical PHASES set', () => {
    const list = [
      makeCaregiver({
        id: 'cg-bad',
        phaseTimestamps: { phantom_phase: NOW - 86400000 },
        phaseOverride:   'phantom_phase',
      }),
    ];
    const grouped = groupCaregiversByPhase(list, NOW);
    // Should not crash, and the phantom row is gone.
    for (const phaseId of Object.keys(grouped)) {
      expect(grouped[phaseId].find((r) => r.caregiver.id === 'cg-bad')).toBeFalsy();
    }
  });

  it('tolerates non-array input', () => {
    const grouped = groupCaregiversByPhase(null, NOW);
    expect(grouped.intake).toEqual([]);
  });
});

describe('medianDaysInPhase', () => {
  it('returns 0 for empty rows', () => {
    expect(medianDaysInPhase([])).toBe(0);
    expect(medianDaysInPhase(null)).toBe(0);
  });
  it('returns the single value for one row', () => {
    expect(medianDaysInPhase([{ daysInPhase: 7 }])).toBe(7);
  });
  it('returns the middle value for an odd-length list', () => {
    expect(medianDaysInPhase([{ daysInPhase: 1 }, { daysInPhase: 4 }, { daysInPhase: 9 }])).toBe(4);
  });
  it('returns the floor of the two-middle average for an even-length list', () => {
    expect(medianDaysInPhase([{ daysInPhase: 1 }, { daysInPhase: 2 }, { daysInPhase: 5 }, { daysInPhase: 8 }])).toBe(3);
  });
});

describe('indexSuggestionsByEntity', () => {
  it('returns an empty Map for missing input', () => {
    expect(indexSuggestionsByEntity(null).size).toBe(0);
    expect(indexSuggestionsByEntity([]).size).toBe(0);
  });
  it('collapses multiple suggestions per entity, keeping the freshest', () => {
    const out = indexSuggestionsByEntity([
      { id: 's-old', entity_id: 'cg-1', created_at: '2026-05-15T01:00:00Z', detail: 'old' },
      { id: 's-new', entity_id: 'cg-1', created_at: '2026-05-16T01:00:00Z', detail: 'new' },
    ]);
    expect(out.size).toBe(1);
    expect(out.get('cg-1').id).toBe('s-new');
  });
  it('skips suggestions with no entity_id', () => {
    const out = indexSuggestionsByEntity([
      { id: 's-orphan', entity_id: null },
      { id: 's-good',   entity_id: 'cg-2' },
    ]);
    expect(out.size).toBe(1);
    expect(out.has('cg-2')).toBe(true);
  });
});

describe('filterPipelineGroups — phase filter', () => {
  const grouped = {
    intake:    [{ caregiver: { id: 'a' }, severity: 'none', daysInPhase: 1 }],
    interview: [{ caregiver: { id: 'b' }, severity: 'red',  daysInPhase: 30 }],
  };

  it('keeps every phase when no phase filter is supplied', () => {
    const out = filterPipelineGroups(grouped, {});
    expect(Object.keys(out).sort()).toEqual(['intake', 'interview']);
  });

  it('keeps only the phases in the supplied Set', () => {
    const out = filterPipelineGroups(grouped, { phaseFilter: new Set(['interview']) });
    expect(Object.keys(out)).toEqual(['interview']);
    expect(out.interview).toHaveLength(1);
  });
});

describe('filterPipelineGroups — stalled-only filter', () => {
  const grouped = {
    intake: [
      { caregiver: { id: 'a' }, severity: 'none',  daysInPhase: 1 },
      { caregiver: { id: 'b' }, severity: 'amber', daysInPhase: 7 },
      { caregiver: { id: 'c' }, severity: 'red',   daysInPhase: 30 },
    ],
  };
  it('keeps every row when off', () => {
    expect(filterPipelineGroups(grouped, {}).intake).toHaveLength(3);
  });
  it('filters to severity !== none when on', () => {
    const out = filterPipelineGroups(grouped, { stalledOnly: true });
    expect(out.intake.map((r) => r.caregiver.id)).toEqual(['b', 'c']);
  });
});

describe('filterPipelineGroups — has-AI-suggestion filter', () => {
  const grouped = {
    intake: [
      { caregiver: { id: 'a' }, severity: 'none', daysInPhase: 1 },
      { caregiver: { id: 'b' }, severity: 'none', daysInPhase: 1 },
    ],
  };
  it('keeps every row when off', () => {
    expect(filterPipelineGroups(grouped, {}).intake).toHaveLength(2);
  });
  it('filters to entities present in the suggestionByEntity Map when on', () => {
    const suggestionByEntity = new Map([['b', { id: 'sug-1', entity_id: 'b' }]]);
    const out = filterPipelineGroups(grouped, { hasAiSuggestion: true, suggestionByEntity });
    expect(out.intake.map((r) => r.caregiver.id)).toEqual(['b']);
  });
  it('keeps every row when the toggle is on but no map is supplied (graceful fallback)', () => {
    const out = filterPipelineGroups(grouped, { hasAiSuggestion: true });
    expect(out.intake).toHaveLength(2);
  });
});
