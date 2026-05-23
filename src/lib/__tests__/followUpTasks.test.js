// Unit tests for src/lib/followUpTasks.js — mapper, bucketing, badge
// count, and mutation routing.

import { describe, it, expect } from 'vitest';
import {
  dbToFollowUpTask,
  bucketFollowUps,
  countNavBadge,
  markFollowUpDone,
  snoozeFollowUp,
  cancelFollowUp,
  reassignFollowUp,
} from '../followUpTasks';

// ─── Fake Supabase client (records UPDATE calls) ─────────

function createFakeClient({ data = {}, error = null } = {}) {
  const calls = [];
  return {
    from(table) {
      return {
        update(patch) {
          return {
            eq(col, val) {
              return {
                select(cols) {
                  return {
                    single() {
                      calls.push({ table, patch, where: { [col]: val }, cols });
                      return Promise.resolve({ data, error });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    _calls: calls,
  };
}

// ─── dbToFollowUpTask ────────────────────────────────────────

describe('dbToFollowUpTask', () => {
  it('maps every field from snake_case to camelCase', () => {
    const out = dbToFollowUpTask({
      id: 't-1', org_id: 'org-1', template_id: 'tmpl-1',
      caregiver_id: 'cg-1', client_id: 'cl-1',
      anchor_shift_id: 'sh-1', due_at: '2026-05-30T17:00:00Z',
      status: 'pending', urgency: 'critical',
      assigned_to: 'jess@tc', snoozed_until: null,
      completed_at: null, completed_by: null, completion_note: null,
      cancellation_reason: null, generated_at: 'g', created_at: 'c', updated_at: 'u',
      follow_up_templates: {
        slug: 'first_day_checkin', name: 'First-day check-in',
        guidance: 'Call them.', target_type: 'both',
        recurring_interval_days: null,
      },
    });
    expect(out.id).toBe('t-1');
    expect(out.dueAt).toBe('2026-05-30T17:00:00Z');
    expect(out.urgency).toBe('critical');
    expect(out.assignedTo).toBe('jess@tc');
    expect(out.template).toEqual({
      slug: 'first_day_checkin',
      name: 'First-day check-in',
      guidance: 'Call them.',
      targetType: 'both',
      recurringIntervalDays: null,
    });
  });

  it('returns null for null input', () => {
    expect(dbToFollowUpTask(null)).toBeNull();
  });

  it('defaults missing template join to null', () => {
    const out = dbToFollowUpTask({ id: 't-1', status: 'pending', due_at: 'x' });
    expect(out.template).toBeNull();
  });
});

// ─── bucketFollowUps ─────────────────────────────────────────

describe('bucketFollowUps', () => {
  // Pin "now" to a known moment so day math is deterministic across
  // timezones. 2026-06-15 noon UTC.
  const now = new Date('2026-06-15T12:00:00Z').getTime();
  const startOfToday = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const DAY = 24 * 60 * 60 * 1000;

  function task(id, msFromTodayStart) {
    return { id, status: 'pending', dueAt: new Date(startOfToday + msFromTodayStart).toISOString() };
  }

  it('splits tasks into overdue / today / tomorrow / thisWeek / later', () => {
    const list = [
      task('overdue1', -2 * DAY),
      task('overdue2', -1),
      task('today1', 3 * 60 * 60 * 1000),
      task('today2', 23 * 60 * 60 * 1000),
      task('tomorrow', DAY + 10 * 60 * 60 * 1000),
      task('thisweek', 4 * DAY),
      task('later', 14 * DAY),
    ];
    const out = bucketFollowUps(list, { now });
    expect(out.overdue.map((t) => t.id)).toEqual(['overdue1', 'overdue2']);
    expect(out.today.map((t) => t.id)).toEqual(['today1', 'today2']);
    expect(out.tomorrow.map((t) => t.id)).toEqual(['tomorrow']);
    expect(out.thisWeek.map((t) => t.id)).toEqual(['thisweek']);
    expect(out.later.map((t) => t.id)).toEqual(['later']);
  });

  it('sorts each bucket by dueAt ascending', () => {
    const list = [
      task('later', 2 * 60 * 60 * 1000),
      task('earlier', 1 * 60 * 60 * 1000),
    ];
    const out = bucketFollowUps(list, { now });
    expect(out.today.map((t) => t.id)).toEqual(['earlier', 'later']);
  });

  it('drops rows with missing dueAt', () => {
    const out = bucketFollowUps([{ id: 'broken', dueAt: null }, task('ok', 0)], { now });
    expect(out.today.map((t) => t.id)).toEqual(['ok']);
  });

  it('drops rows with unparseable dueAt', () => {
    const out = bucketFollowUps([{ id: 'broken', dueAt: 'not-a-date' }, task('ok', 0)], { now });
    expect(out.today.map((t) => t.id)).toEqual(['ok']);
  });

  it('returns empty buckets for empty/null input', () => {
    expect(bucketFollowUps([])).toEqual({ overdue: [], today: [], tomorrow: [], thisWeek: [], later: [] });
    expect(bucketFollowUps(null)).toEqual({ overdue: [], today: [], tomorrow: [], thisWeek: [], later: [] });
  });
});

// ─── countNavBadge ───────────────────────────────────────────

describe('countNavBadge', () => {
  const now = new Date('2026-06-15T12:00:00Z').getTime();
  const startOfToday = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const DAY = 24 * 60 * 60 * 1000;

  it('counts pending overdue + pending due-today only', () => {
    const list = [
      { id: 'a', status: 'pending', dueAt: new Date(startOfToday - DAY).toISOString() }, // overdue
      { id: 'b', status: 'pending', dueAt: new Date(startOfToday + 6 * 60 * 60 * 1000).toISOString() }, // today
      { id: 'c', status: 'pending', dueAt: new Date(startOfToday + DAY).toISOString() }, // tomorrow — NOT counted
      { id: 'd', status: 'pending', dueAt: new Date(startOfToday + 2 * DAY).toISOString() }, // later
      { id: 'e', status: 'snoozed', dueAt: new Date(startOfToday).toISOString() }, // snoozed today — NOT counted
      { id: 'f', status: 'done', dueAt: new Date(startOfToday).toISOString() }, // done — NOT counted
    ];
    expect(countNavBadge(list, { now })).toBe(2);
  });

  it('returns 0 for empty/null', () => {
    expect(countNavBadge([])).toBe(0);
    expect(countNavBadge(null)).toBe(0);
  });
});

// ─── Mutations ──────────────────────────────────────────────

describe('markFollowUpDone', () => {
  it('writes status=done + completed_at + completed_by + trimmed note', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'done', due_at: 'x' } });
    const out = await markFollowUpDone('t-1', { completedBy: 'jess@tc', note: '  ok done  ' }, client);
    expect(out.error).toBeNull();
    expect(client._calls[0].patch.status).toBe('done');
    expect(client._calls[0].patch.completed_by).toBe('jess@tc');
    expect(client._calls[0].patch.completion_note).toBe('ok done');
    expect(client._calls[0].patch.completed_at).toBeTruthy();
  });

  it('coerces empty/whitespace note to null', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'done', due_at: 'x' } });
    await markFollowUpDone('t-1', { completedBy: 'jess@tc', note: '   ' }, client);
    expect(client._calls[0].patch.completion_note).toBeNull();
  });

  it('returns the supabase error and skips mapping when DB rejects', async () => {
    const client = createFakeClient({ data: null, error: new Error('rls-denied') });
    const out = await markFollowUpDone('t-1', { completedBy: 'jess@tc' }, client);
    expect(out.task).toBeNull();
    expect(out.error.message).toBe('rls-denied');
  });

  it('returns an error when taskId is missing', async () => {
    const out = await markFollowUpDone(null, { completedBy: 'jess@tc' }, createFakeClient());
    expect(out.error).toBeTruthy();
    expect(out.task).toBeNull();
  });
});

describe('snoozeFollowUp', () => {
  it('accepts a Date and serializes to ISO', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'snoozed', due_at: 'x' } });
    const until = new Date('2026-06-16T09:00:00Z');
    await snoozeFollowUp('t-1', until, client);
    expect(client._calls[0].patch).toEqual({
      status: 'snoozed',
      snoozed_until: '2026-06-16T09:00:00.000Z',
    });
  });

  it('accepts an ISO string and passes it through', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'snoozed', due_at: 'x' } });
    await snoozeFollowUp('t-1', '2026-06-16T09:00:00Z', client);
    expect(client._calls[0].patch.snoozed_until).toBe('2026-06-16T09:00:00Z');
  });
});

describe('cancelFollowUp', () => {
  it('writes status=cancelled and trimmed reason', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'cancelled', due_at: 'x' } });
    await cancelFollowUp('t-1', '  not needed  ', client);
    expect(client._calls[0].patch).toEqual({
      status: 'cancelled',
      cancellation_reason: 'not needed',
    });
  });

  it('coerces empty reason to null', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'cancelled', due_at: 'x' } });
    await cancelFollowUp('t-1', '   ', client);
    expect(client._calls[0].patch.cancellation_reason).toBeNull();
  });
});

describe('reassignFollowUp', () => {
  it('writes assigned_to as the trimmed value', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'pending', due_at: 'x' } });
    await reassignFollowUp('t-1', '  laura@tc  ', client);
    expect(client._calls[0].patch).toEqual({ assigned_to: 'laura@tc' });
  });

  it('coerces empty assignee to null (unassign)', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'pending', due_at: 'x' } });
    await reassignFollowUp('t-1', '   ', client);
    expect(client._calls[0].patch.assigned_to).toBeNull();
  });
});
