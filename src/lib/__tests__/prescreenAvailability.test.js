import { describe, it, expect } from 'vitest';
import {
  convertAvailabilityAnswerToRows,
  hasAvailabilitySlots,
  extractAvailabilityAnswer,
  formatAvailabilityAnswer,
} from '../scheduling/prescreenAvailability';

describe('convertAvailabilityAnswerToRows', () => {
  const caregiverId = 'cg_123';

  it('returns [] for empty / null / missing answers', () => {
    expect(convertAvailabilityAnswerToRows(null, { caregiverId })).toEqual([]);
    expect(convertAvailabilityAnswerToRows(undefined, { caregiverId })).toEqual([]);
    expect(convertAvailabilityAnswerToRows({}, { caregiverId })).toEqual([]);
    expect(convertAvailabilityAnswerToRows({ slots: [] }, { caregiverId })).toEqual([]);
  });

  it('requires caregiverId when slots are present', () => {
    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: 1, startTime: '09:00', endTime: '17:00' }] },
        {},
      ),
    ).toThrow(/caregiverId is required/);
  });

  it('converts a single slot into one row with correct shape', () => {
    const rows = convertAvailabilityAnswerToRows(
      { slots: [{ day: 1, startTime: '09:00', endTime: '17:00' }] },
      { caregiverId, sourceResponseId: 'resp_1', createdBy: 'Maria' },
    );
    expect(rows).toEqual([
      {
        caregiverId: 'cg_123',
        type: 'available',
        dayOfWeek: 1,
        startTime: '09:00',
        endTime: '17:00',
        source: 'survey',
        sourceResponseId: 'resp_1',
        pinned: false,
        createdBy: 'Maria',
      },
    ]);
  });

  it('emits one row per day when slots span multiple days', () => {
    const rows = convertAvailabilityAnswerToRows(
      {
        slots: [
          { day: 1, startTime: '09:00', endTime: '17:00' },
          { day: 3, startTime: '09:00', endTime: '17:00' },
          { day: 5, startTime: '09:00', endTime: '17:00' },
        ],
      },
      { caregiverId },
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.dayOfWeek)).toEqual([1, 3, 5]);
  });

  it('merges overlapping intervals on the same day', () => {
    const rows = convertAvailabilityAnswerToRows(
      {
        slots: [
          { day: 2, startTime: '09:00', endTime: '12:00' },
          { day: 2, startTime: '11:00', endTime: '14:00' },
        ],
      },
      { caregiverId },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        dayOfWeek: 2,
        startTime: '09:00',
        endTime: '14:00',
      }),
    ]);
  });

  it('merges adjacent (touching) intervals on the same day', () => {
    const rows = convertAvailabilityAnswerToRows(
      {
        slots: [
          { day: 4, startTime: '09:00', endTime: '12:00' },
          { day: 4, startTime: '12:00', endTime: '15:00' },
        ],
      },
      { caregiverId },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dayOfWeek: 4,
      startTime: '09:00',
      endTime: '15:00',
    });
  });

  it('keeps disjoint intervals separate on the same day', () => {
    const rows = convertAvailabilityAnswerToRows(
      {
        slots: [
          { day: 0, startTime: '08:00', endTime: '10:00' },
          { day: 0, startTime: '14:00', endTime: '18:00' },
        ],
      },
      { caregiverId },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ startTime: '08:00', endTime: '10:00' });
    expect(rows[1]).toMatchObject({ startTime: '14:00', endTime: '18:00' });
  });

  it('sorts output by day then start time', () => {
    const rows = convertAvailabilityAnswerToRows(
      {
        slots: [
          { day: 5, startTime: '09:00', endTime: '17:00' },
          { day: 1, startTime: '13:00', endTime: '15:00' },
          { day: 1, startTime: '09:00', endTime: '11:00' },
          { day: 3, startTime: '09:00', endTime: '17:00' },
        ],
      },
      { caregiverId },
    );
    expect(rows.map((r) => [r.dayOfWeek, r.startTime])).toEqual([
      [1, '09:00'],
      [1, '13:00'],
      [3, '09:00'],
      [5, '09:00'],
    ]);
  });

  it('throws when startTime is not valid HH:MM', () => {
    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: 1, startTime: '9am', endTime: '17:00' }] },
        { caregiverId },
      ),
    ).toThrow(/Invalid startTime/);
  });

  it('throws when endTime is not valid HH:MM', () => {
    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: 1, startTime: '09:00', endTime: '25:00' }] },
        { caregiverId },
      ),
    ).toThrow(/Invalid endTime/);
  });

  it('throws when start >= end (rejects overnight wrap)', () => {
    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: 1, startTime: '22:00', endTime: '06:00' }] },
        { caregiverId },
      ),
    ).toThrow(/start must be before end/);

    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: 1, startTime: '09:00', endTime: '09:00' }] },
        { caregiverId },
      ),
    ).toThrow(/start must be before end/);
  });

  it('throws when day is out of range', () => {
    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: 7, startTime: '09:00', endTime: '17:00' }] },
        { caregiverId },
      ),
    ).toThrow(/Invalid day/);

    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: -1, startTime: '09:00', endTime: '17:00' }] },
        { caregiverId },
      ),
    ).toThrow(/Invalid day/);
  });

  it('throws when day is not an integer', () => {
    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: '1', startTime: '09:00', endTime: '17:00' }] },
        { caregiverId },
      ),
    ).not.toThrow(); // numeric string is coerced

    expect(() =>
      convertAvailabilityAnswerToRows(
        { slots: [{ day: 1.5, startTime: '09:00', endTime: '17:00' }] },
        { caregiverId },
      ),
    ).toThrow(/Invalid day/);
  });

  it('every output row is tagged source="survey" and pinned=false', () => {
    const rows = convertAvailabilityAnswerToRows(
      {
        slots: [
          { day: 1, startTime: '09:00', endTime: '17:00' },
          { day: 2, startTime: '09:00', endTime: '17:00' },
        ],
      },
      { caregiverId },
    );
    for (const row of rows) {
      expect(row.source).toBe('survey');
      expect(row.pinned).toBe(false);
    }
  });
});

describe('hasAvailabilitySlots', () => {
  it('returns false for empty / invalid answers', () => {
    expect(hasAvailabilitySlots(null)).toBe(false);
    expect(hasAvailabilitySlots(undefined)).toBe(false);
    expect(hasAvailabilitySlots({})).toBe(false);
    expect(hasAvailabilitySlots({ slots: [] })).toBe(false);
    expect(hasAvailabilitySlots({ slots: 'not array' })).toBe(false);
  });

  it('returns true when slots array has at least one entry', () => {
    expect(
      hasAvailabilitySlots({ slots: [{ day: 1, startTime: '09:00', endTime: '17:00' }] }),
    ).toBe(true);
  });
});

describe('extractAvailabilityAnswer', () => {
  it('returns null when no availability_schedule question exists', () => {
    const questions = [
      { id: 'q1', type: 'yes_no' },
      { id: 'q2', type: 'free_text' },
    ];
    const answers = { q1: 'Yes', q2: 'hi' };
    expect(extractAvailabilityAnswer(questions, answers)).toBeNull();
  });

  it('returns null when the question exists but the answer is empty', () => {
    const questions = [
      { id: 'q1', type: 'yes_no' },
      { id: 'qA', type: 'availability_schedule' },
    ];
    const answers = { q1: 'Yes', qA: { slots: [] } };
    expect(extractAvailabilityAnswer(questions, answers)).toBeNull();
  });

  it('returns the answer when populated', () => {
    const questions = [
      { id: 'qA', type: 'availability_schedule' },
    ];
    const answer = { slots: [{ day: 1, startTime: '09:00', endTime: '17:00' }] };
    expect(extractAvailabilityAnswer(questions, { qA: answer })).toEqual(answer);
  });

  it('is resilient to missing/invalid inputs', () => {
    expect(extractAvailabilityAnswer(null, {})).toBeNull();
    expect(extractAvailabilityAnswer([], null)).toBeNull();
  });
});

describe('formatAvailabilityAnswer', () => {
  it('returns an em-dash placeholder for empty answers', () => {
    expect(formatAvailabilityAnswer(null)).toBe('—');
    expect(formatAvailabilityAnswer({ slots: [] })).toBe('—');
  });

  it('formats a single slot with 12-hour clock labels', () => {
    expect(
      formatAvailabilityAnswer({
        slots: [{ day: 1, startTime: '09:00', endTime: '17:00' }],
      }),
    ).toBe('Mon 9a–5p');
  });

  it('joins multiple slots, sorted by day then start', () => {
    expect(
      formatAvailabilityAnswer({
        slots: [
          { day: 5, startTime: '09:00', endTime: '13:00' },
          { day: 1, startTime: '09:00', endTime: '17:00' },
          { day: 3, startTime: '09:00', endTime: '17:00' },
        ],
      }),
    ).toBe('Mon 9a–5p, Wed 9a–5p, Fri 9a–1p');
  });

  it('shows non-zero minutes and midnight/noon correctly', () => {
    expect(
      formatAvailabilityAnswer({
        slots: [
          { day: 0, startTime: '00:00', endTime: '12:00' },
          { day: 2, startTime: '13:30', endTime: '18:45' },
        ],
      }),
    ).toBe('Sun 12a–12p, Tue 1:30p–6:45p');
  });
});
