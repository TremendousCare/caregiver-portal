import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PHASE_TASKS } from '../constants';

// Tests can override phase tasks by assigning to mockedPhaseTasks.value
const mockedPhaseTasks = vi.hoisted(() => ({ value: null }));

vi.mock('../storage', () => ({
  getPhaseTasks: () => mockedPhaseTasks.value,
}));

// Default to the real defaults; individual describe blocks reassign as needed
mockedPhaseTasks.value = DEFAULT_PHASE_TASKS;

// Import after mocks are set up
const {
  isTaskDone,
  getPhaseProgress,
  getCalculatedPhase,
  getCurrentPhase,
  getOverallProgress,
  getDaysInPhase,
  getDaysSinceApplication,
  sortCaregiversForDashboard,
  isGreenLight,
  formatDate,
  isAwaitingInterviewResponse,
  getInterviewLinkSentAt,
  getDaysSinceInterviewLinkSent,
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

// ─── sortCaregiversForDashboard ─────────────────────────────────

describe('sortCaregiversForDashboard', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

  it('returns an empty array when given an empty array', () => {
    expect(sortCaregiversForDashboard([], {})).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const caregivers = [
      { id: 'a', applicationDate: daysAgo(1) },
      { id: 'b', applicationDate: daysAgo(3) },
    ];
    const snapshot = [...caregivers];
    sortCaregiversForDashboard(caregivers, {});
    expect(caregivers).toEqual(snapshot);
  });

  it('orders survey responders above non-responders', () => {
    const caregivers = [
      { id: 'no-survey-old', applicationDate: daysAgo(30) },
      { id: 'survey-new', applicationDate: daysAgo(1) },
    ];
    const surveyStatuses = { 'survey-new': 'qualified' };
    const sorted = sortCaregiversForDashboard(caregivers, surveyStatuses);
    expect(sorted.map((c) => c.id)).toEqual(['survey-new', 'no-survey-old']);
  });

  it('treats any survey status (qualified, flagged, disqualified) as a responder', () => {
    const caregivers = [
      { id: 'none', applicationDate: daysAgo(100) },
      { id: 'flagged', applicationDate: daysAgo(2) },
      { id: 'disqualified', applicationDate: daysAgo(1) },
      { id: 'qualified', applicationDate: daysAgo(3) },
    ];
    const surveyStatuses = {
      flagged: 'flagged',
      disqualified: 'disqualified',
      qualified: 'qualified',
    };
    const sorted = sortCaregiversForDashboard(caregivers, surveyStatuses);
    expect(sorted[sorted.length - 1].id).toBe('none');
    expect(sorted.slice(0, 3).map((c) => c.id).sort()).toEqual(
      ['disqualified', 'flagged', 'qualified']
    );
  });

  it('within each group, orders older applications before newer ones', () => {
    const caregivers = [
      { id: 'new', applicationDate: daysAgo(2) },
      { id: 'oldest', applicationDate: daysAgo(20) },
      { id: 'middle', applicationDate: daysAgo(10) },
    ];
    const sorted = sortCaregiversForDashboard(caregivers, {});
    expect(sorted.map((c) => c.id)).toEqual(['oldest', 'middle', 'new']);
  });

  it('orders survey responders by application age among themselves', () => {
    const caregivers = [
      { id: 'survey-new', applicationDate: daysAgo(1) },
      { id: 'survey-old', applicationDate: daysAgo(14) },
      { id: 'no-survey', applicationDate: daysAgo(30) },
    ];
    const surveyStatuses = {
      'survey-new': 'qualified',
      'survey-old': 'flagged',
    };
    const sorted = sortCaregiversForDashboard(caregivers, surveyStatuses);
    expect(sorted.map((c) => c.id)).toEqual(['survey-old', 'survey-new', 'no-survey']);
  });

  it('treats missing applicationDate as 0 days and places those last within their group', () => {
    const caregivers = [
      { id: 'no-date' },
      { id: 'old', applicationDate: daysAgo(5) },
    ];
    const sorted = sortCaregiversForDashboard(caregivers, {});
    expect(sorted.map((c) => c.id)).toEqual(['old', 'no-date']);
  });

  it('defaults to empty surveyStatuses when none provided', () => {
    const caregivers = [
      { id: 'new', applicationDate: daysAgo(1) },
      { id: 'old', applicationDate: daysAgo(10) },
    ];
    const sorted = sortCaregiversForDashboard(caregivers);
    expect(sorted.map((c) => c.id)).toEqual(['old', 'new']);
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

// ─── Pending Interview (link sent, awaiting response) ─────────
//
// Real agencies (e.g., Daniela's) customize the intake checklist,
// so these helpers match tasks by label keywords. The fixture below
// mirrors Daniela's actual intake checklist from the portal UI.

describe('isAwaitingInterviewResponse', () => {
  const INTAKE_CUSTOM = [
    { id: 'survey_reviewed', label: 'Survey Reviewed' },
    { id: 'send_interview_link', label: 'Send Link to schedule Interview' },
    { id: 'interview_scheduled', label: 'Interview Scheduled', critical: true },
    { id: 'send_survey', label: 'Send Survey' },
  ];

  beforeEach(() => {
    mockedPhaseTasks.value = { ...DEFAULT_PHASE_TASKS, intake: INTAKE_CUSTOM };
  });

  it('returns false when link-sent task is not completed', () => {
    const cg = { tasks: {} };
    expect(isAwaitingInterviewResponse(cg)).toBe(false);
  });

  it('returns true when link is sent but interview not yet scheduled', () => {
    const cg = {
      tasks: {
        send_interview_link: { completed: true, completedAt: Date.now() },
      },
    };
    expect(isAwaitingInterviewResponse(cg)).toBe(true);
  });

  it('returns false once interview is scheduled', () => {
    const cg = {
      tasks: {
        send_interview_link: { completed: true, completedAt: Date.now() },
        interview_scheduled: { completed: true, completedAt: Date.now() },
      },
    };
    expect(isAwaitingInterviewResponse(cg)).toBe(false);
  });

  it('returns false when caregiver has advanced past intake', () => {
    const cg = {
      phaseOverride: 'interview',
      tasks: {
        send_interview_link: { completed: true, completedAt: Date.now() },
      },
    };
    expect(isAwaitingInterviewResponse(cg)).toBe(false);
  });

  it('accepts legacy boolean task values', () => {
    const cg = { tasks: { send_interview_link: true } };
    expect(isAwaitingInterviewResponse(cg)).toBe(true);
  });

  it('returns false when checklist has no matching link task', () => {
    mockedPhaseTasks.value = DEFAULT_PHASE_TASKS; // defaults have no "send link"
    const cg = { tasks: {} };
    expect(isAwaitingInterviewResponse(cg)).toBe(false);
  });

  it('returns false for null/undefined caregiver', () => {
    expect(isAwaitingInterviewResponse(null)).toBe(false);
    expect(isAwaitingInterviewResponse(undefined)).toBe(false);
  });
});

describe('getInterviewLinkSentAt', () => {
  const INTAKE_CUSTOM = [
    { id: 'send_interview_link', label: 'Send Link to schedule Interview' },
    { id: 'interview_scheduled', label: 'Interview Scheduled' },
  ];

  beforeEach(() => {
    mockedPhaseTasks.value = { ...DEFAULT_PHASE_TASKS, intake: INTAKE_CUSTOM };
  });

  it('returns the timestamp when link was sent', () => {
    const ts = Date.now() - 2 * 86400000;
    const cg = { tasks: { send_interview_link: { completed: true, completedAt: ts } } };
    expect(getInterviewLinkSentAt(cg)).toBe(ts);
  });

  it('returns null when task is incomplete', () => {
    expect(getInterviewLinkSentAt({ tasks: {} })).toBeNull();
  });

  it('returns null when task is a bare boolean (no timestamp)', () => {
    const cg = { tasks: { send_interview_link: true } };
    expect(getInterviewLinkSentAt(cg)).toBeNull();
  });

  it('parses ISO date strings', () => {
    const cg = { tasks: { send_interview_link: { completed: true, completedAt: '2026-04-01T12:00:00Z' } } };
    expect(getInterviewLinkSentAt(cg)).toBe(new Date('2026-04-01T12:00:00Z').getTime());
  });
});

describe('getDaysSinceInterviewLinkSent', () => {
  const INTAKE_CUSTOM = [
    { id: 'send_interview_link', label: 'Send Link to schedule Interview' },
    { id: 'interview_scheduled', label: 'Interview Scheduled' },
  ];

  beforeEach(() => {
    mockedPhaseTasks.value = { ...DEFAULT_PHASE_TASKS, intake: INTAKE_CUSTOM };
  });

  it('returns the whole number of days since the link was sent', () => {
    const ts = Date.now() - 3 * 86400000 - 60 * 1000; // ~3 days ago
    const cg = { tasks: { send_interview_link: { completed: true, completedAt: ts } } };
    expect(getDaysSinceInterviewLinkSent(cg)).toBe(3);
  });

  it('returns 0 when link was sent earlier today', () => {
    const cg = { tasks: { send_interview_link: { completed: true, completedAt: Date.now() - 60 * 1000 } } };
    expect(getDaysSinceInterviewLinkSent(cg)).toBe(0);
  });

  it('returns null when link was not sent', () => {
    expect(getDaysSinceInterviewLinkSent({ tasks: {} })).toBeNull();
  });
});
