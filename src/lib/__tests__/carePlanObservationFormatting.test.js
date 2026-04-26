import { describe, it, expect } from 'vitest';
import {
  formatObservation,
  groupObservationsByTask,
  groupObservationsByShift,
  indexLatestRatings,
  pickLatestShiftNote,
} from '../carePlanObservationFormatting';

const taskMap = new Map([
  ['t1', { id: 't1', taskName: 'Bathing' }],
  ['t2', { id: 't2', taskName: 'Medication AM' }],
]);

describe('formatObservation — task_completion', () => {
  it('formats a Done rating with task name and success tone', () => {
    const out = formatObservation(
      { observationType: 'task_completion', taskId: 't1', rating: 'done', note: null },
      taskMap,
    );
    expect(out.label).toBe('Bathing — Done');
    expect(out.tone).toBe('success');
    expect(out.icon).toBe('✓');
    expect(out.detail).toBeNull();
  });

  it('uses warning tone for partial', () => {
    const out = formatObservation(
      { observationType: 'task_completion', taskId: 't1', rating: 'partial' },
      taskMap,
    );
    expect(out.label).toBe('Bathing — Partial');
    expect(out.tone).toBe('warning');
  });

  it('uses danger tone for not_done', () => {
    const out = formatObservation(
      { observationType: 'task_completion', taskId: 't1', rating: 'not_done' },
      taskMap,
    );
    expect(out.label).toBe('Bathing — Not done');
    expect(out.tone).toBe('danger');
  });

  it('falls back to "(deleted task)" when taskId no longer exists', () => {
    const out = formatObservation(
      { observationType: 'task_completion', taskId: 't_gone', rating: 'done' },
      taskMap,
    );
    expect(out.label).toBe('(deleted task) — Done');
    expect(out.tone).toBe('success');
  });

  it('passes a note through as detail', () => {
    const out = formatObservation(
      { observationType: 'task_completion', taskId: 't1', rating: 'partial', note: 'with help' },
      taskMap,
    );
    expect(out.detail).toBe('with help');
  });
});

describe('formatObservation — refusal', () => {
  it('formats with the task name in the label and danger tone', () => {
    const out = formatObservation(
      { observationType: 'refusal', taskId: 't2', note: 'felt nauseous' },
      taskMap,
    );
    expect(out.label).toBe('Refused: Medication AM');
    expect(out.detail).toBe('felt nauseous');
    expect(out.tone).toBe('danger');
  });

  it('handles a refusal with no taskId', () => {
    const out = formatObservation(
      { observationType: 'refusal', taskId: null, note: 'refused breakfast' },
      taskMap,
    );
    expect(out.label).toBe('Refused');
    expect(out.detail).toBe('refused breakfast');
  });
});

describe('formatObservation — shift_note', () => {
  it('formats with note tone and the note as detail', () => {
    const out = formatObservation(
      { observationType: 'shift_note', note: 'Calm afternoon, ate well.' },
      taskMap,
    );
    expect(out.label).toBe('Shift note');
    expect(out.detail).toBe('Calm afternoon, ate well.');
    expect(out.tone).toBe('note');
  });
});

describe('formatObservation — other types', () => {
  it('formats mood with the rating string', () => {
    const out = formatObservation(
      { observationType: 'mood', rating: 'good', note: 'smiling' },
      taskMap,
    );
    expect(out.label).toBe('Mood: good');
    expect(out.detail).toBe('smiling');
  });

  it('formats concern with warning tone', () => {
    const out = formatObservation(
      { observationType: 'concern', note: 'noticed swelling in left ankle' },
      taskMap,
    );
    expect(out.tone).toBe('warning');
    expect(out.label).toBe('Concern');
  });

  it('formats positive with success tone', () => {
    const out = formatObservation(
      { observationType: 'positive', note: 'family came over for tea' },
      taskMap,
    );
    expect(out.tone).toBe('success');
    expect(out.label).toBe('Positive moment');
  });

  it('formats vital with the reading', () => {
    const out = formatObservation(
      { observationType: 'vital', rating: '128/82' },
      taskMap,
    );
    expect(out.label).toBe('Vitals: 128/82');
  });

  it('formats general / unknown types defensively', () => {
    const out = formatObservation(
      { observationType: 'general', note: 'misc' },
      taskMap,
    );
    expect(out.label).toBe('Observation');
    expect(out.tone).toBe('neutral');
  });

  it('returns null on null input', () => {
    expect(formatObservation(null, taskMap)).toBeNull();
  });

  it('does not crash without a taskMap', () => {
    const out = formatObservation(
      { observationType: 'task_completion', taskId: 't1', rating: 'done' },
      undefined,
    );
    // taskMap absent → "(deleted task) — Done"
    expect(out.label).toBe('(deleted task) — Done');
  });
});

describe('groupObservationsByTask', () => {
  it('buckets observations by taskId, preserving chronological order', () => {
    const groups = groupObservationsByTask([
      { id: 'a', taskId: 't1', observationType: 'task_completion', loggedAt: '2026-04-26T11:00:00Z' },
      { id: 'b', taskId: 't1', observationType: 'task_completion', loggedAt: '2026-04-26T10:00:00Z' },
      { id: 'c', taskId: 't2', observationType: 'task_completion', loggedAt: '2026-04-26T10:30:00Z' },
      { id: 'd', taskId: null, observationType: 'shift_note', loggedAt: '2026-04-26T11:30:00Z' },
    ]);
    expect(groups.get('t1').map((o) => o.id)).toEqual(['b', 'a']);
    expect(groups.get('t2')).toHaveLength(1);
    expect(groups.get('__none__')).toHaveLength(1);
  });

  it('returns an empty map for empty / null input', () => {
    expect(groupObservationsByTask([]).size).toBe(0);
    expect(groupObservationsByTask(null).size).toBe(0);
  });
});

describe('groupObservationsByShift', () => {
  it('groups by shift and sorts groups newest-first', () => {
    const groups = groupObservationsByShift([
      { id: 'a', shiftId: 's1', loggedAt: '2026-04-26T08:00:00Z' },
      { id: 'b', shiftId: 's1', loggedAt: '2026-04-26T11:00:00Z' },
      { id: 'c', shiftId: 's2', loggedAt: '2026-04-25T15:00:00Z' },
    ]);
    expect(groups).toHaveLength(2);
    // Newest-shift first (s1's newest at 11:00 vs s2's at 15:00 yesterday)
    expect(groups[0].shiftId).toBe('s1');
    expect(groups[1].shiftId).toBe('s2');
    // Within s1 the observations are chronological
    expect(groups[0].observations.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('emits a null-shift bucket for shift-less observations', () => {
    const groups = groupObservationsByShift([
      { id: 'a', shiftId: null, loggedAt: '2026-04-26T10:00:00Z' },
    ]);
    expect(groups[0].shiftId).toBeNull();
  });

  it('returns an empty array for empty / null input', () => {
    expect(groupObservationsByShift([])).toEqual([]);
    expect(groupObservationsByShift(null)).toEqual([]);
  });
});

describe('indexLatestRatings', () => {
  it('keeps only the latest task_completion per taskId', () => {
    const idx = indexLatestRatings([
      { observationType: 'task_completion', taskId: 't1', rating: 'partial', loggedAt: '2026-04-26T10:00:00Z' },
      { observationType: 'task_completion', taskId: 't1', rating: 'done', loggedAt: '2026-04-26T11:00:00Z' },
      { observationType: 'task_completion', taskId: 't2', rating: 'not_done', loggedAt: '2026-04-26T10:30:00Z' },
      { observationType: 'shift_note', taskId: null, loggedAt: '2026-04-26T11:30:00Z' },
    ]);
    expect(idx.get('t1').rating).toBe('done');
    expect(idx.get('t2').rating).toBe('not_done');
    expect(idx.size).toBe(2);
  });

  it('returns empty for empty / null', () => {
    expect(indexLatestRatings([]).size).toBe(0);
    expect(indexLatestRatings(null).size).toBe(0);
  });
});

describe('pickLatestShiftNote', () => {
  it('picks the most recent shift_note', () => {
    const out = pickLatestShiftNote([
      { id: 'a', observationType: 'shift_note', note: 'first', loggedAt: '2026-04-26T10:00:00Z' },
      { id: 'b', observationType: 'shift_note', note: 'second', loggedAt: '2026-04-26T11:00:00Z' },
      { id: 'c', observationType: 'task_completion', loggedAt: '2026-04-26T11:30:00Z' },
    ]);
    expect(out.id).toBe('b');
  });

  it('returns null when no shift_note', () => {
    expect(pickLatestShiftNote([{ observationType: 'task_completion', loggedAt: 'x' }])).toBeNull();
    expect(pickLatestShiftNote([])).toBeNull();
    expect(pickLatestShiftNote(null)).toBeNull();
  });
});
