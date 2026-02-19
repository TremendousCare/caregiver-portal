import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PHASE_TASKS } from '../constants';

// Mock storage module so getPhaseTasks returns the defaults
vi.mock('../storage', () => ({
  getPhaseTasks: () => DEFAULT_PHASE_TASKS,
}));

// Import after mocks are set up
const {
  isTaskDone,
  getPhaseProgress,
  getCalculatedPhase,
  getCurrentPhase,
  getOverallProgress,
  getDaysInPhase,
  getDaysSinceApplication,
  isGreenLight,
  formatDate,
} = await import('../utils');

// ─── isTaskDone ─────────────────────────────────────────────────

describe('isTaskDone', () => {
  it('returns true for boolean true', () => {
    expect(isTaskDone(true)).toBe(true);
  });

  it('returns false for boolean false', () => {
    expect(isTaskDone(false)).toBe(false);
  });

  it('returns true for enriched format { completed: true }', () => {
    expect(isTaskDone({ completed: true, completedAt: '2025-01-01' })).toBe(true);
  });

  it('returns false for enriched format { completed: false }', () => {
    expect(isTaskDone({ completed: false })).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTaskDone(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTaskDone(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTaskDone('')).toBe(false);
  });

  it('returns false for number 0', () => {
    expect(isTaskDone(0)).toBe(false);
  });

  it('returns true for object with truthy completed (1)', () => {
    expect(isTaskDone({ completed: 1 })).toBe(true);
  });
});

// ─── getPhaseProgress ──────────────────────────────────────────

describe('getPhaseProgress', () => {
  it('returns 0% for caregiver with no tasks', () => {
    const cg = {};
    const result = getPhaseProgress(cg, 'intake');
    expect(result.done).toBe(0);
    expect(result.total).toBe(DEFAULT_PHASE_TASKS.intake.length);
    expect(result.pct).toBe(0);
  });

  it('returns 100% when all phase tasks are done', () => {
    const tasks = {};
    DEFAULT_PHASE_TASKS.intake.forEach((t) => {
      tasks[t.id] = true;
    });
    const cg = { tasks };
    const result = getPhaseProgress(cg, 'intake');
    expect(result.done).toBe(result.total);
    expect(result.pct).toBe(100);
  });

  it('handles mixed legacy and enriched task formats', () => {
    const tasks = {
      app_reviewed: true,
      initial_contact: { completed: true, completedAt: '2025-01-01' },
      phone_screen: false,
    };
    const cg = { tasks };
    const result = getPhaseProgress(cg, 'intake');
    expect(result.done).toBe(2);
  });

  it('returns zeros for an unknown phase', () => {
    const result = getPhaseProgress({}, 'nonexistent_phase');
    expect(result).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

// ─── getCalculatedPhase ─────────────────────────────────────────

describe('getCalculatedPhase', () => {
  it('returns intake for caregiver with no tasks', () => {
    expect(getCalculatedPhase({})).toBe('intake');
  });

  it('returns orientation when all phases are 100% complete', () => {
    const tasks = {};
    Object.values(DEFAULT_PHASE_TASKS)
      .flat()
      .forEach((t) => {
        tasks[t.id] = true;
      });
    expect(getCalculatedPhase({ tasks })).toBe('orientation');
  });

  it('returns interview when only intake tasks are done', () => {
    const tasks = {};
    DEFAULT_PHASE_TASKS.intake.forEach((t) => {
      tasks[t.id] = true;
    });
    expect(getCalculatedPhase({ tasks })).toBe('interview');
  });
});

// ─── getCurrentPhase ────────────────────────────────────────────

describe('getCurrentPhase', () => {
  it('returns calculated phase when no override', () => {
    expect(getCurrentPhase({})).toBe('intake');
  });

  it('returns phaseOverride when set', () => {
    expect(getCurrentPhase({ phaseOverride: 'verification' })).toBe('verification');
  });

  it('override takes priority over task completion', () => {
    const tasks = {};
    DEFAULT_PHASE_TASKS.intake.forEach((t) => {
      tasks[t.id] = true;
    });
    const cg = { tasks, phaseOverride: 'intake' };
    expect(getCurrentPhase(cg)).toBe('intake');
  });
});

// ─── getOverallProgress ─────────────────────────────────────────

describe('getOverallProgress', () => {
  it('returns 0 for caregiver with no tasks', () => {
    expect(getOverallProgress({})).toBe(0);
  });

  it('returns 100 when all tasks done', () => {
    const tasks = {};
    Object.values(DEFAULT_PHASE_TASKS)
      .flat()
      .forEach((t) => {
        tasks[t.id] = true;
      });
    expect(getOverallProgress({ tasks })).toBe(100);
  });

  it('returns correct percentage for partial completion', () => {
    const allTasks = Object.values(DEFAULT_PHASE_TASKS).flat();
    const tasks = {};
    // Complete first half
    allTasks.slice(0, Math.floor(allTasks.length / 2)).forEach((t) => {
      tasks[t.id] = true;
    });
    const result = getOverallProgress({ tasks });
    const expected = Math.round((Math.floor(allTasks.length / 2) / allTasks.length) * 100);
    expect(result).toBe(expected);
  });
});

// ─── getDaysInPhase ─────────────────────────────────────────────

describe('getDaysInPhase', () => {
  it('returns 0 when no phase timestamps', () => {
    expect(getDaysInPhase({})).toBe(0);
  });

  it('returns correct days for a timestamp in the past', () => {
    const threeDaysAgo = Date.now() - 3 * 86400000;
    const cg = { phaseTimestamps: { intake: threeDaysAgo } };
    expect(getDaysInPhase(cg)).toBe(3);
  });

  it('uses the correct phase based on override', () => {
    const twoDaysAgo = Date.now() - 2 * 86400000;
    const cg = {
      phaseOverride: 'onboarding',
      phaseTimestamps: { onboarding: twoDaysAgo, intake: Date.now() - 10 * 86400000 },
    };
    expect(getDaysInPhase(cg)).toBe(2);
  });
});

// ─── getDaysSinceApplication ────────────────────────────────────

describe('getDaysSinceApplication', () => {
  it('returns 0 when no application date', () => {
    expect(getDaysSinceApplication({})).toBe(0);
  });

  it('returns correct days for a past application date', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
    const cg = { applicationDate: fiveDaysAgo };
    const result = getDaysSinceApplication(cg);
    // Allow +-1 day tolerance for timezone edge cases
    expect(result).toBeGreaterThanOrEqual(4);
    expect(result).toBeLessThanOrEqual(6);
  });
});

// ─── isGreenLight ───────────────────────────────────────────────

describe('isGreenLight', () => {
  it('returns false when no tasks are done', () => {
    expect(isGreenLight({})).toBe(false);
  });

  it('returns false when only some required tasks are done', () => {
    const cg = {
      tasks: {
        offer_signed: true,
        i9_form: true,
        w4_form: true,
      },
    };
    expect(isGreenLight(cg)).toBe(false);
  });

  it('returns true when all 6 required tasks are done', () => {
    const cg = {
      tasks: {
        offer_signed: true,
        i9_form: true,
        w4_form: true,
        hca_cleared: true,
        tb_test: true,
        training_assigned: true,
      },
    };
    expect(isGreenLight(cg)).toBe(true);
  });

  it('works with enriched task format', () => {
    const cg = {
      tasks: {
        offer_signed: { completed: true, completedAt: '2025-01-01' },
        i9_form: { completed: true },
        w4_form: { completed: true },
        hca_cleared: { completed: true },
        tb_test: { completed: true },
        training_assigned: { completed: true },
      },
    };
    expect(isGreenLight(cg)).toBe(true);
  });

  it('returns false if one required task is enriched but incomplete', () => {
    const cg = {
      tasks: {
        offer_signed: true,
        i9_form: true,
        w4_form: true,
        hca_cleared: true,
        tb_test: true,
        training_assigned: { completed: false },
      },
    };
    expect(isGreenLight(cg)).toBe(false);
  });
});

// ─── formatDate ─────────────────────────────────────────────────

describe('formatDate', () => {
  it('returns dash for null', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('returns dash for undefined', () => {
    expect(formatDate(undefined)).toBe('—');
  });

  it('returns dash for empty string', () => {
    expect(formatDate('')).toBe('—');
  });

  it('formats a timestamp correctly', () => {
    // Jan 15, 2025
    const ts = new Date(2025, 0, 15).getTime();
    const result = formatDate(ts);
    expect(result).toContain('Jan');
    expect(result).toContain('15');
  });

  it('formats an ISO date string', () => {
    // Use noon UTC to avoid timezone rollover issues
    const result = formatDate('2025-06-20T12:00:00Z');
    expect(result).toContain('Jun');
    expect(result).toContain('20');
  });
});
