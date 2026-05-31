import { describe, it, expect } from 'vitest';
import {
  CATEGORY_LABELS,
  categoryLabel,
  severityMeta,
  severityRank,
  severityToTaskUrgency,
  actorFromUser,
  assigneeFromUser,
  mapSignalRow,
  sortSignals,
  sbarToText,
  buildTaskInputFromSignal,
  describeEvidence,
} from '../../features/care-signals/careSignalHelpers';

// The taxonomy here must mirror the detector's Stop-and-Watch list.
const DETECTOR_CATEGORY_IDS = [
  'seems_different',
  'talks_less',
  'overall_needs_more_help',
  'pain',
  'ate_less',
  'no_bowel_movement',
  'drank_less',
  'weight_change',
  'agitated',
  'tired_drowsy',
  'skin_change',
  'help_walking',
  'medication_concern',
];

describe('category labels stay in sync with the detector taxonomy', () => {
  it('has a label for every detector category id', () => {
    for (const id of DETECTOR_CATEGORY_IDS) {
      expect(CATEGORY_LABELS[id]).toBeTruthy();
    }
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...DETECTOR_CATEGORY_IDS].sort());
  });

  it('falls back to the raw id for unknown categories', () => {
    expect(categoryLabel('made_up')).toBe('made_up');
    expect(categoryLabel('pain')).toBe('Pain');
  });
});

describe('severity helpers', () => {
  it('ranks urgent > watch > info', () => {
    expect(severityRank('urgent')).toBeGreaterThan(severityRank('watch'));
    expect(severityRank('watch')).toBeGreaterThan(severityRank('info'));
  });

  it('exposes lucide icon names (no emoji)', () => {
    expect(severityMeta('urgent').icon).toBe('AlertOctagon');
    expect(severityMeta('watch').icon).toBe('AlertTriangle');
    expect(severityMeta('info').icon).toBe('Info');
  });

  it('maps severity to the follow_up_tasks urgency enum', () => {
    expect(severityToTaskUrgency('urgent')).toBe('critical');
    expect(severityToTaskUrgency('watch')).toBe('warning');
    expect(severityToTaskUrgency('info')).toBe('info');
  });
});

describe('actorFromUser', () => {
  it('prefers displayName, falls back to email, then null (display label)', () => {
    expect(actorFromUser({ displayName: 'Jessica', email: 'j@x.com' })).toBe('Jessica');
    expect(actorFromUser({ email: 'j@x.com' })).toBe('j@x.com');
    expect(actorFromUser(null)).toBeNull();
  });
});

describe('assigneeFromUser', () => {
  it('prefers EMAIL (so email-keyed task flows pick it up), then name, then null', () => {
    // The crux of the Codex finding: assignment must be email-first.
    expect(assigneeFromUser({ displayName: 'Jessica', email: 'j@x.com' })).toBe('j@x.com');
    expect(assigneeFromUser({ displayName: 'Jessica' })).toBe('Jessica');
    expect(assigneeFromUser(null)).toBeNull();
  });
});

describe('mapSignalRow', () => {
  it('maps snake_case to camelCase with safe defaults', () => {
    const vm = mapSignalRow({
      id: 's1',
      client_id: 'c1',
      severity: 'urgent',
      categories: ['pain', 'ate_less'],
      summary: 'Possible acute change',
      evidence: [{ observation_id: 'o1' }],
      status: 'open',
    });
    expect(vm.clientId).toBe('c1');
    expect(vm.categories).toEqual(['pain', 'ate_less']);
    expect(vm.evidence).toHaveLength(1);
    expect(vm.followUpTaskId).toBeNull();
  });

  it('coerces missing arrays to empty', () => {
    const vm = mapSignalRow({ id: 's', client_id: 'c', severity: 'info' });
    expect(vm.categories).toEqual([]);
    expect(vm.evidence).toEqual([]);
    expect(vm.summary).toBe('');
  });
});

describe('sortSignals', () => {
  it('orders by severity then recency', () => {
    const sorted = sortSignals([
      { id: 'a', severity: 'watch', createdAt: '2026-05-30T10:00:00Z' },
      { id: 'b', severity: 'urgent', createdAt: '2026-05-29T10:00:00Z' },
      { id: 'c', severity: 'watch', createdAt: '2026-05-31T10:00:00Z' },
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('sbarToText', () => {
  it('renders the four sections and the not-a-diagnosis disclaimer', () => {
    const txt = sbarToText(
      { situation: 'S', background: 'B', assessment: 'A', recommendation: 'R' },
      { clientName: 'Blerta' },
    );
    expect(txt).toContain('SBAR — Blerta');
    expect(txt).toContain('Situation: S');
    expect(txt).toContain('Recommendation: R');
    expect(txt).toContain('not a diagnosis');
  });

  it('returns empty string for a null sbar', () => {
    expect(sbarToText(null)).toBe('');
  });
});

describe('buildTaskInputFromSignal', () => {
  const signal = {
    clientId: 'c1',
    severity: 'urgent',
    summary: 'Possible acute change',
    categories: ['pain', 'ate_less'],
    sbar: { recommendation: 'Nurse check-in today' },
  };

  it('produces a valid createUserTask input', () => {
    const input = buildTaskInputFromSignal(signal, {
      clientName: 'Blerta Nash',
      createdBy: 'Jessica',
      now: new Date('2026-05-31T12:00:00Z'),
    });
    expect(input.title).toContain('Blerta Nash');
    expect(input.title).toContain('Urgent');
    expect(input.urgency).toBe('critical'); // valid follow_up_tasks enum
    expect(input.dueAt).toBe('2026-05-31T12:00:00.000Z'); // required by createUserTask
    expect(input.clientId).toBe('c1');
    expect(input.createdBy).toBe('Jessica');
    expect(input.description).toContain('Pain, Ate less');
    expect(input.description).toContain('Nurse check-in today');
  });
});

describe('describeEvidence', () => {
  it('renders task + type + rating + note', () => {
    expect(
      describeEvidence({ task_name: 'Prepare meals', type: 'refusal', note: 'not hungry' }),
    ).toBe('Prepare meals — refusal — "not hungry"');
  });

  it('handles non-task observations', () => {
    expect(describeEvidence({ type: 'shift_note', note: 'stomach hurts' })).toBe(
      'shift_note — "stomach hurts"',
    );
  });
});
