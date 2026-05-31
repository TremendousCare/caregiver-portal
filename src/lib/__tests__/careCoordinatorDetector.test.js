import { describe, it, expect } from 'vitest';

import {
  gradeSeverity,
  severityRank,
  DEFAULT_THRESHOLDS,
} from '../../../supabase/functions/care-coordinator-sweep/severity.ts';
import {
  summarizeObservations,
  normalizeDetectorOutput,
} from '../../../supabase/functions/care-coordinator-sweep/analysis.ts';
import { decideDisposition } from '../../../supabase/functions/care-coordinator-sweep/dedup.ts';
import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../../../supabase/functions/care-coordinator-sweep/prompt.ts';
import {
  STOP_AND_WATCH_IDS,
  isValidCategory,
} from '../../../supabase/functions/care-coordinator-sweep/stopAndWatch.ts';

describe('gradeSeverity (clusters, not points)', () => {
  it('stays silent below the watch threshold', () => {
    expect(gradeSeverity([], DEFAULT_THRESHOLDS)).toBeNull();
    expect(gradeSeverity(['pain'], DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('grades watch at >=2 and urgent at >=3 distinct categories', () => {
    expect(gradeSeverity(['pain', 'ate_less'], DEFAULT_THRESHOLDS)).toBe('watch');
    expect(gradeSeverity(['pain', 'ate_less', 'help_walking'], DEFAULT_THRESHOLDS)).toBe('urgent');
  });

  it('dedupes categories before counting', () => {
    expect(gradeSeverity(['pain', 'pain'], DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('acute flag promotes a 2-category watch to urgent but never creates from below threshold', () => {
    expect(gradeSeverity(['pain', 'ate_less'], DEFAULT_THRESHOLDS, { acute: true })).toBe('urgent');
    expect(gradeSeverity(['pain'], DEFAULT_THRESHOLDS, { acute: true })).toBeNull();
  });

  it('ranks severities for escalation comparisons', () => {
    expect(severityRank('urgent')).toBeGreaterThan(severityRank('watch'));
    expect(severityRank('watch')).toBeGreaterThan(severityRank('info'));
  });
});

describe('normalizeDetectorOutput (gate + validation)', () => {
  const opts = { thresholds: DEFAULT_THRESHOLDS };

  it('returns null when the model declines to signal', () => {
    expect(normalizeDetectorOutput({ signal: false }, opts)).toBeNull();
    expect(normalizeDetectorOutput(null, opts)).toBeNull();
    expect(normalizeDetectorOutput('nope', opts)).toBeNull();
  });

  it('drops unknown categories and re-gates on what remains', () => {
    const out = normalizeDetectorOutput(
      { signal: true, categories: ['pain', 'made_up_category'], summary: 'x' },
      opts,
    );
    // only 'pain' survives -> below watch threshold -> silent
    expect(out).toBeNull();
  });

  it('requires a non-empty summary even when categories clear the threshold', () => {
    const out = normalizeDetectorOutput(
      { signal: true, categories: ['pain', 'ate_less'], summary: '   ' },
      opts,
    );
    expect(out).toBeNull();
  });

  it('produces a normalized signal for a valid cluster', () => {
    const out = normalizeDetectorOutput(
      {
        signal: true,
        categories: ['pain', 'ate_less', 'help_walking'],
        acute: true,
        summary: 'Possible acute change',
        sbar: { situation: 'S', background: 'B', assessment: 'A', recommendation: 'R', junk: 1 },
        evidence_observation_ids: ['o1', 'o2', 7],
      },
      opts,
    );
    expect(out).not.toBeNull();
    expect(out.severity).toBe('urgent');
    expect(out.categories).toEqual(['pain', 'ate_less', 'help_walking']);
    expect(out.summary).toBe('Possible acute change');
    expect(out.sbar.recommendation).toBe('R');
    expect(out.evidenceObservationIds).toEqual(['o1', 'o2']); // non-strings dropped
  });
});

describe('summarizeObservations (baseline-relative)', () => {
  // Blerta-style fixture: meals + transfers reliably done across the
  // baseline window, then a sharp acute decline + pain on the latest shift.
  const acuteWindowStart = '2026-05-30T00:00:00Z';
  const tasks = [
    { id: 't_meal', taskName: 'Prepare meals', category: 'iadl.meal_prep' },
    { id: 't_transfer', taskName: 'Transfer bed to chair', category: 'adl.transfers' },
  ];
  const observations = [
    // baseline: done, done, done for both tasks
    { id: 'b1', observationType: 'task_completion', rating: 'done', note: null, taskId: 't_meal', shiftId: 's1', loggedAt: '2026-05-20T16:00:00Z' },
    { id: 'b2', observationType: 'task_completion', rating: 'done', note: null, taskId: 't_meal', shiftId: 's2', loggedAt: '2026-05-22T16:00:00Z' },
    { id: 'b3', observationType: 'task_completion', rating: 'done', note: null, taskId: 't_transfer', shiftId: 's1', loggedAt: '2026-05-20T16:05:00Z' },
    { id: 'b4', observationType: 'task_completion', rating: 'done', note: null, taskId: 't_transfer', shiftId: 's2', loggedAt: '2026-05-22T16:05:00Z' },
    { id: 'bm', observationType: 'mood', rating: 'good', note: null, taskId: null, shiftId: 's2', loggedAt: '2026-05-22T16:10:00Z' },
    // acute: meal refused, transfer not done, pain note
    { id: 'a1', observationType: 'refusal', rating: null, note: 'not hungry, feels unwell', taskId: 't_meal', shiftId: 's9', loggedAt: '2026-05-31T11:48:00Z' },
    { id: 'a2', observationType: 'task_completion', rating: 'not_done', note: 'client refused assistance', taskId: 't_transfer', shiftId: 's9', loggedAt: '2026-05-31T11:48:30Z' },
    { id: 'a3', observationType: 'shift_note', rating: null, note: 'feeling unwell today, says her stomach hurts', taskId: null, shiftId: 's9', loggedAt: '2026-05-31T11:50:00Z' },
  ];

  it('splits acute vs baseline correctly', () => {
    const s = summarizeObservations(observations, tasks, { acuteWindowStart });
    expect(s.acuteCount).toBe(3);
    expect(s.baselineCount).toBe(5);
  });

  it('flags the declining transfer task', () => {
    const s = summarizeObservations(observations, tasks, { acuteWindowStart });
    const transfer = s.taskTrends.find((t) => t.taskName === 'Transfer bed to chair');
    expect(transfer.declined).toBe(true);
    expect(transfer.baseline.done).toBe(2);
    expect(transfer.acute.not_done).toBe(1);
  });

  it('counts acute refusals and carries observation ids for evidence', () => {
    const s = summarizeObservations(observations, tasks, { acuteWindowStart });
    expect(s.acuteRefusals).toBe(1);
    expect(s.acute.map((o) => o.id)).toContain('a3');
    expect(s.baselineMood).toEqual({ good: 1 });
  });
});

describe('decideDisposition (dedup)', () => {
  it('inserts when nothing open overlaps', () => {
    expect(decideDisposition([], { severity: 'watch', evidenceObservationIds: ['o1'] })).toEqual({ action: 'insert' });
  });

  it('skips when an open signal already covers the same evidence at >= severity', () => {
    const existing = [{ id: 'sig1', severity: 'urgent', evidenceObservationIds: ['o1', 'o2'] }];
    expect(decideDisposition(existing, { severity: 'watch', evidenceObservationIds: ['o2'] })).toEqual({
      action: 'skip',
      targetId: 'sig1',
    });
  });

  it('escalates (update) when the new cluster is more severe', () => {
    const existing = [{ id: 'sig1', severity: 'watch', evidenceObservationIds: ['o1'] }];
    expect(decideDisposition(existing, { severity: 'urgent', evidenceObservationIds: ['o1'] })).toEqual({
      action: 'update',
      targetId: 'sig1',
    });
  });
});

describe('prompt construction', () => {
  it('system prompt encodes the hard rules and the JSON contract', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/Clusters, not points/i);
    expect(sys).toMatch(/Default to silence/i);
    expect(sys).toMatch(/decision support/i);
    expect(sys).toContain('"signal": boolean');
    // every taxonomy id should appear in the rubric
    for (const id of STOP_AND_WATCH_IDS) expect(sys).toContain(id);
  });

  it('user prompt includes baseline, trends, and id-tagged acute observations', () => {
    const summary = summarizeObservations(
      [
        { id: 'a3', observationType: 'shift_note', rating: null, note: 'stomach hurts', taskId: null, shiftId: 's9', loggedAt: '2026-05-31T11:50:00Z' },
      ],
      [],
      { acuteWindowStart: '2026-05-30T00:00:00Z' },
    );
    const user = buildUserPrompt({ preferredName: 'Blerta', ageOrDob: '1960-05-03', baselineNarrative: 'Independent, fall risk noted.' }, summary);
    expect(user).toContain('Blerta');
    expect(user).toContain('Independent, fall risk noted.');
    expect(user).toContain('id=a3');
    expect(user).toContain('stomach hurts');
  });
});

describe('taxonomy', () => {
  it('validates known and rejects unknown categories', () => {
    expect(isValidCategory('pain')).toBe(true);
    expect(isValidCategory('not_a_category')).toBe(false);
    expect(isValidCategory(42)).toBe(false);
  });
});
