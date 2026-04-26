import { describe, it, expect } from 'vitest';
import {
  shiftPeriodFromHour,
  shiftPeriodFromStartTime,
  dayOfWeekFromStartTime,
  taskAppliesToShift,
  filterTasksForShift,
  groupTasksByCategory,
  categoryLabel,
} from '../shiftTaskFilter';

describe('shiftPeriodFromHour', () => {
  it('maps each bucket boundary correctly', () => {
    expect(shiftPeriodFromHour(5)).toBe('morning');
    expect(shiftPeriodFromHour(11)).toBe('morning');
    expect(shiftPeriodFromHour(12)).toBe('afternoon');
    expect(shiftPeriodFromHour(16)).toBe('afternoon');
    expect(shiftPeriodFromHour(17)).toBe('evening');
    expect(shiftPeriodFromHour(20)).toBe('evening');
    expect(shiftPeriodFromHour(21)).toBe('overnight');
    expect(shiftPeriodFromHour(0)).toBe('overnight');
    expect(shiftPeriodFromHour(4)).toBe('overnight');
  });

  it('returns null for out-of-range or invalid input', () => {
    expect(shiftPeriodFromHour(-1)).toBeNull();
    expect(shiftPeriodFromHour(24)).toBeNull();
    expect(shiftPeriodFromHour(1.5)).toBeNull();
    expect(shiftPeriodFromHour(null)).toBeNull();
    expect(shiftPeriodFromHour(undefined)).toBeNull();
    expect(shiftPeriodFromHour('morning')).toBeNull();
  });
});

describe('shiftPeriodFromStartTime', () => {
  // Note: tests run in the host's local tz. We pin the start times using
  // explicit local-time strings so the bucket assertion is stable.
  it('accepts an ISO string with local time', () => {
    expect(shiftPeriodFromStartTime('2026-04-26T08:00:00')).toBe('morning');
    expect(shiftPeriodFromStartTime('2026-04-26T15:30:00')).toBe('afternoon');
    expect(shiftPeriodFromStartTime('2026-04-26T19:00:00')).toBe('evening');
    expect(shiftPeriodFromStartTime('2026-04-26T22:00:00')).toBe('overnight');
  });

  it('accepts a Date instance', () => {
    const d = new Date(2026, 3, 26, 9, 0); // Apr 26, 9 AM local
    expect(shiftPeriodFromStartTime(d)).toBe('morning');
  });

  it('returns null for null/undefined/garbage', () => {
    expect(shiftPeriodFromStartTime(null)).toBeNull();
    expect(shiftPeriodFromStartTime(undefined)).toBeNull();
    expect(shiftPeriodFromStartTime('not-a-date')).toBeNull();
  });
});

describe('dayOfWeekFromStartTime', () => {
  it('returns 0..6 with Sunday=0', () => {
    // 2026-04-26 is a Sunday.
    expect(dayOfWeekFromStartTime('2026-04-26T10:00:00')).toBe(0);
    // 2026-04-27 is Monday.
    expect(dayOfWeekFromStartTime('2026-04-27T10:00:00')).toBe(1);
    // 2026-05-02 is Saturday.
    expect(dayOfWeekFromStartTime('2026-05-02T10:00:00')).toBe(6);
  });

  it('returns null on bad input', () => {
    expect(dayOfWeekFromStartTime(null)).toBeNull();
    expect(dayOfWeekFromStartTime('xx')).toBeNull();
  });
});

describe('taskAppliesToShift', () => {
  it('returns true when the task is tagged "all"', () => {
    const task = { shifts: ['all'], days_of_week: [] };
    expect(taskAppliesToShift(task, 'morning', 1)).toBe(true);
    expect(taskAppliesToShift(task, 'evening', 6)).toBe(true);
  });

  it('returns true when the bucket matches and dow is unrestricted', () => {
    const task = { shifts: ['morning'], days_of_week: [] };
    expect(taskAppliesToShift(task, 'morning', 1)).toBe(true);
  });

  it('returns false when the bucket does not match', () => {
    const task = { shifts: ['morning'], days_of_week: [] };
    expect(taskAppliesToShift(task, 'evening', 1)).toBe(false);
  });

  it('returns true when a multi-bucket task includes the period', () => {
    const task = { shifts: ['morning', 'afternoon'], days_of_week: [] };
    expect(taskAppliesToShift(task, 'morning', 1)).toBe(true);
    expect(taskAppliesToShift(task, 'afternoon', 1)).toBe(true);
    expect(taskAppliesToShift(task, 'evening', 1)).toBe(false);
  });

  it('honors days_of_week when populated', () => {
    // Mon, Wed, Fri only
    const task = { shifts: ['all'], days_of_week: [1, 3, 5] };
    expect(taskAppliesToShift(task, 'morning', 1)).toBe(true); // Mon
    expect(taskAppliesToShift(task, 'morning', 2)).toBe(false); // Tue
    expect(taskAppliesToShift(task, 'morning', 3)).toBe(true); // Wed
    expect(taskAppliesToShift(task, 'morning', 6)).toBe(false); // Sat
  });

  it('treats empty shifts metadata as applicable everywhere', () => {
    // Defensive: admin authored a task without picking shifts. Don't hide it.
    const task = { shifts: [], days_of_week: [] };
    expect(taskAppliesToShift(task, 'morning', 0)).toBe(true);
    expect(taskAppliesToShift(task, 'overnight', 6)).toBe(true);
  });

  it('falls through to true when dow cannot be resolved but the bucket matches', () => {
    // shiftPeriod resolved but dow null (e.g. shift had no valid time)
    const task = { shifts: ['morning'], days_of_week: [1, 3] };
    expect(taskAppliesToShift(task, 'morning', null)).toBe(true);
  });

  it('handles camelCase daysOfWeek (mappers may emit either)', () => {
    const task = { shifts: ['all'], daysOfWeek: [2] }; // Tuesday only
    expect(taskAppliesToShift(task, 'morning', 2)).toBe(true);
    expect(taskAppliesToShift(task, 'morning', 3)).toBe(false);
  });

  it('returns false defensively for null task', () => {
    expect(taskAppliesToShift(null, 'morning', 1)).toBe(false);
  });
});

describe('filterTasksForShift', () => {
  const tasks = [
    { id: 't1', shifts: ['morning'], days_of_week: [], task_name: 'Bathing' },
    { id: 't2', shifts: ['afternoon'], days_of_week: [], task_name: 'Lunch' },
    { id: 't3', shifts: ['evening'], days_of_week: [], task_name: 'Dinner meds' },
    { id: 't4', shifts: ['all'], days_of_week: [1, 3, 5], task_name: 'PT' },
    { id: 't5', shifts: ['all'], days_of_week: [], task_name: 'Companion check-in' },
  ];

  it('filters to morning + every-day tasks for an 8 AM Sunday shift', () => {
    const result = filterTasksForShift(tasks, { start_time: '2026-04-26T08:00:00' });
    const ids = result.map((t) => t.id);
    // Morning bucket → t1, t5; t4 is Mon/Wed/Fri only so excluded on Sunday
    expect(ids).toEqual(expect.arrayContaining(['t1', 't5']));
    expect(ids).not.toContain('t2');
    expect(ids).not.toContain('t3');
    expect(ids).not.toContain('t4');
  });

  it('includes the Mon/Wed/Fri task on Monday afternoon', () => {
    const result = filterTasksForShift(tasks, { start_time: '2026-04-27T13:30:00' });
    const ids = result.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['t2', 't4', 't5']));
    expect(ids).not.toContain('t1');
    expect(ids).not.toContain('t3');
  });

  it('returns every task when start_time is missing or unparseable', () => {
    expect(filterTasksForShift(tasks, {}).length).toBe(tasks.length);
    expect(filterTasksForShift(tasks, { start_time: 'not-a-date' }).length).toBe(tasks.length);
  });

  it('returns an empty array when given no tasks', () => {
    expect(filterTasksForShift([], { start_time: '2026-04-26T10:00:00' })).toEqual([]);
    expect(filterTasksForShift(null, {})).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const local = tasks.slice();
    filterTasksForShift(local, { start_time: '2026-04-26T08:00:00' });
    expect(local).toEqual(tasks);
  });
});

describe('groupTasksByCategory', () => {
  it('groups tasks by category and sorts within each group', () => {
    const result = groupTasksByCategory([
      { id: 't1', category: 'adl.bathing', sort_order: 2, task_name: 'Shower' },
      { id: 't2', category: 'iadl.medication', sort_order: 0, task_name: 'AM meds' },
      { id: 't3', category: 'adl.bathing', sort_order: 1, task_name: 'Wash hands' },
      { id: 't4', category: 'iadl.medication', sort_order: 1, task_name: 'PM meds' },
    ]);

    expect(result).toHaveLength(2);
    const bathing = result.find((g) => g.category === 'adl.bathing');
    expect(bathing.tasks.map((t) => t.id)).toEqual(['t3', 't1']);
    const meds = result.find((g) => g.category === 'iadl.medication');
    expect(meds.tasks.map((t) => t.id)).toEqual(['t2', 't4']);
  });

  it('falls back to alphabetic by task_name when sort_order ties', () => {
    const result = groupTasksByCategory([
      { id: 't1', category: 'adl.bathing', sort_order: 0, task_name: 'Brush teeth' },
      { id: 't2', category: 'adl.bathing', sort_order: 0, task_name: 'Apply lotion' },
    ]);
    expect(result[0].tasks.map((t) => t.task_name)).toEqual(['Apply lotion', 'Brush teeth']);
  });

  it('uses "other" for tasks with no category', () => {
    const result = groupTasksByCategory([{ id: 't1', task_name: 'X', sort_order: 0 }]);
    expect(result[0].category).toBe('other');
  });

  it('returns an empty array for empty input', () => {
    expect(groupTasksByCategory([])).toEqual([]);
    expect(groupTasksByCategory(null)).toEqual([]);
  });
});

describe('categoryLabel', () => {
  it('returns friendly names for known categories', () => {
    expect(categoryLabel('adl.bathing')).toBe('Bathing & Personal Care');
    expect(categoryLabel('iadl.medication')).toBe('Medications');
    expect(categoryLabel('iadl.observation')).toBe('Health Observations');
  });

  it('humanises unknown categories', () => {
    expect(categoryLabel('adl.brushing_teeth')).toBe('Brushing Teeth');
    expect(categoryLabel('iadl.pet-care')).toBe('Pet Care');
    expect(categoryLabel('custom_thing')).toBe('Custom Thing');
  });

  it('returns "Other" for empty / null', () => {
    expect(categoryLabel(null)).toBe('Other');
    expect(categoryLabel('')).toBe('Other');
  });
});
