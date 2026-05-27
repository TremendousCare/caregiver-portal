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
  followUpDisplayTitle,
  buildUserTaskRow,
  createUserTask,
  updateUserTask,
  logTaskEvent,
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

// ─── User-source mapper & display title (migration 20260527000000) ───

describe('dbToFollowUpTask user-source fields', () => {
  it('maps the new columns onto the camelCase shape', () => {
    const out = dbToFollowUpTask({
      id: 't-2', org_id: 'org-1',
      source: 'user', title: 'Call Maria',
      description: 'About the I-9', created_by: 'jess@tc',
      notified_at: '2026-06-15T17:05:00Z',
      template_id: null, caregiver_id: 'cg-1', client_id: null,
      due_at: '2026-06-16T09:00:00Z', status: 'pending',
      urgency: 'warning', assigned_to: 'jess@tc',
    });
    expect(out.source).toBe('user');
    expect(out.title).toBe('Call Maria');
    expect(out.description).toBe('About the I-9');
    expect(out.createdBy).toBe('jess@tc');
    expect(out.notifiedAt).toBe('2026-06-15T17:05:00Z');
    expect(out.caregiverId).toBe('cg-1');
    expect(out.clientId).toBeNull();
    expect(out.templateId).toBeNull();
    expect(out.template).toBeNull();
  });

  it('defaults source to "template" when absent (back-compat)', () => {
    const out = dbToFollowUpTask({ id: 't-3', status: 'pending', due_at: 'x' });
    expect(out.source).toBe('template');
    expect(out.title).toBeNull();
    expect(out.notifiedAt).toBeNull();
  });
});

describe('followUpDisplayTitle', () => {
  it('prefers the joined template name for template tasks', () => {
    const out = followUpDisplayTitle({
      title: 'should-not-appear',
      template: { name: 'First-day check-in' },
    });
    expect(out).toBe('First-day check-in');
  });

  it('falls back to the user-entered title for source=user', () => {
    expect(followUpDisplayTitle({ title: 'Call Maria', template: null }))
      .toBe('Call Maria');
  });

  it('falls back to a generic label when nothing is set', () => {
    expect(followUpDisplayTitle({ template: null })).toBe('Follow-up');
    expect(followUpDisplayTitle(null)).toBe('Follow-up');
  });
});

// ─── buildUserTaskRow ────────────────────────────────────────

describe('buildUserTaskRow', () => {
  const baseValid = {
    title: 'Call Maria re: I-9',
    dueAt: new Date('2026-06-16T09:00:00Z'),
    urgency: 'warning',
  };

  it('rejects missing input', () => {
    expect(buildUserTaskRow(null).error).toBeTruthy();
    expect(buildUserTaskRow(undefined).error).toBeTruthy();
    expect(buildUserTaskRow('not-an-object').error).toBeTruthy();
  });

  it('requires a non-empty title', () => {
    expect(buildUserTaskRow({ ...baseValid, title: '' }).error?.message).toMatch(/title/i);
    expect(buildUserTaskRow({ ...baseValid, title: '   ' }).error?.message).toMatch(/title/i);
  });

  it('trims the title', () => {
    const { row, error } = buildUserTaskRow({ ...baseValid, title: '  hello  ' });
    expect(error).toBeNull();
    expect(row.title).toBe('hello');
  });

  it('requires a dueAt and accepts both Date and ISO string', () => {
    expect(buildUserTaskRow({ ...baseValid, dueAt: null }).error?.message).toMatch(/due/i);
    const fromDate = buildUserTaskRow(baseValid).row;
    expect(fromDate.due_at).toBe('2026-06-16T09:00:00.000Z');
    const fromIso = buildUserTaskRow({ ...baseValid, dueAt: '2026-06-16T09:00:00Z' }).row;
    expect(fromIso.due_at).toBe('2026-06-16T09:00:00Z');
  });

  it('rejects unknown urgency values', () => {
    expect(buildUserTaskRow({ ...baseValid, urgency: 'high' }).error?.message).toMatch(/urgency/i);
  });

  it('rejects linking both caregiver and client (single-entity rule)', () => {
    const { error } = buildUserTaskRow({
      ...baseValid, caregiverId: 'cg-1', clientId: 'cl-1',
    });
    expect(error?.message).toMatch(/caregiver or a client/);
  });

  it('defaults assignedTo to createdBy (creator-is-assignee rule)', () => {
    const { row } = buildUserTaskRow({ ...baseValid, createdBy: 'jess@tc' });
    expect(row.created_by).toBe('jess@tc');
    expect(row.assigned_to).toBe('jess@tc');
  });

  it('allows assignedTo override', () => {
    const { row } = buildUserTaskRow({
      ...baseValid, createdBy: 'jess@tc', assignedTo: 'laura@tc',
    });
    expect(row.assigned_to).toBe('laura@tc');
  });

  it('sets source=user by default and source=ai when requested', () => {
    expect(buildUserTaskRow(baseValid).row.source).toBe('user');
    expect(buildUserTaskRow({ ...baseValid, source: 'ai' }).row.source).toBe('ai');
    // Anything other than 'ai' falls back to 'user' (validation here
    // is loose; the DB CHECK is the source of truth).
    expect(buildUserTaskRow({ ...baseValid, source: 'template' }).row.source).toBe('user');
  });

  it('coerces empty description to null', () => {
    expect(buildUserTaskRow({ ...baseValid, description: '   ' }).row.description).toBeNull();
    expect(buildUserTaskRow({ ...baseValid, description: '  hi  ' }).row.description).toBe('hi');
  });
});

// ─── createUserTask ──────────────────────────────────────────

function createInsertingClient({ data = null, error = null } = {}) {
  const calls = [];
  return {
    from(table) {
      return {
        insert(row) {
          return {
            select(cols) {
              return {
                single() {
                  calls.push({ table, row, cols });
                  return Promise.resolve({ data, error });
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

describe('createUserTask', () => {
  const valid = {
    title: 'Call Maria',
    dueAt: new Date('2026-06-16T09:00:00Z'),
    urgency: 'warning',
    createdBy: 'jess@tc',
  };

  it('validates before round-tripping (returns error, no DB call)', async () => {
    const client = createInsertingClient();
    const { task, error } = await createUserTask({ ...valid, title: '' }, client);
    expect(task).toBeNull();
    expect(error?.message).toMatch(/title/i);
    expect(client._calls).toHaveLength(0);
  });

  it('inserts the normalized row and maps the response', async () => {
    const client = createInsertingClient({
      data: {
        id: 't-1', source: 'user', title: 'Call Maria',
        due_at: '2026-06-16T09:00:00.000Z', urgency: 'warning',
        assigned_to: 'jess@tc', created_by: 'jess@tc', status: 'pending',
      },
    });
    const { task, error } = await createUserTask(valid, client);
    expect(error).toBeNull();
    expect(task.id).toBe('t-1');
    expect(task.source).toBe('user');
    expect(task.title).toBe('Call Maria');
    expect(client._calls[0].row.source).toBe('user');
    expect(client._calls[0].row.assigned_to).toBe('jess@tc');
  });

  it('propagates supabase errors verbatim', async () => {
    const client = createInsertingClient({ error: new Error('rls-denied') });
    const { task, error } = await createUserTask(valid, client);
    expect(task).toBeNull();
    expect(error.message).toBe('rls-denied');
  });
});

// ─── updateUserTask ──────────────────────────────────────────

describe('updateUserTask', () => {
  it('rejects empty title', async () => {
    const client = createFakeClient({ data: null });
    const { error } = await updateUserTask('t-1', { title: '   ' }, client);
    expect(error?.message).toMatch(/title/i);
    expect(client._calls).toHaveLength(0);
  });

  it('resets notified_at when dueAt changes (re-arms dispatcher)', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'pending', due_at: 'x' } });
    await updateUserTask('t-1', { dueAt: new Date('2026-06-20T10:00:00Z') }, client);
    expect(client._calls[0].patch.due_at).toBe('2026-06-20T10:00:00.000Z');
    expect(client._calls[0].patch.notified_at).toBeNull();
  });

  it('rejects linking caregiver+client simultaneously', async () => {
    const client = createFakeClient({ data: null });
    const { error } = await updateUserTask('t-1', { caregiverId: 'cg', clientId: 'cl' }, client);
    expect(error?.message).toMatch(/caregiver or a client/);
    expect(client._calls).toHaveLength(0);
  });

  it('rejects unknown urgency', async () => {
    const client = createFakeClient({ data: null });
    const { error } = await updateUserTask('t-1', { urgency: 'high' }, client);
    expect(error?.message).toMatch(/urgency/i);
  });

  it('refuses to send an empty patch', async () => {
    const client = createFakeClient({ data: null });
    const { error } = await updateUserTask('t-1', {}, client);
    expect(error?.message).toMatch(/Nothing to update/);
    expect(client._calls).toHaveLength(0);
  });

  it('trims and writes title; nulls empty description', async () => {
    const client = createFakeClient({ data: { id: 't-1', status: 'pending', due_at: 'x' } });
    await updateUserTask('t-1', { title: '  new  ', description: '   ' }, client);
    expect(client._calls[0].patch.title).toBe('new');
    expect(client._calls[0].patch.description).toBeNull();
  });
});

// ─── logTaskEvent ────────────────────────────────────────────

describe('logTaskEvent', () => {
  function createEventClient() {
    const calls = [];
    return {
      from(table) {
        return {
          insert(row) {
            calls.push({ table, row });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      _calls: calls,
    };
  }

  it('writes an events row with entity_type derived from the link', async () => {
    const client = createEventClient();
    await logTaskEvent('task_created',
      { id: 't-1', source: 'user', title: 'Call Maria', dueAt: '2026-06-16T09:00:00Z',
        caregiverId: 'cg-1', clientId: null, assignedTo: 'jess@tc' },
      'user:jess@tc', client);
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].table).toBe('events');
    expect(client._calls[0].row.event_type).toBe('task_created');
    expect(client._calls[0].row.entity_type).toBe('caregiver');
    expect(client._calls[0].row.entity_id).toBeNull(); // caregivers.id is text, events.entity_id is uuid
    expect(client._calls[0].row.payload.task_id).toBe('t-1');
    expect(client._calls[0].row.actor).toBe('user:jess@tc');
  });

  it('uses entity_type=client when only client is linked', async () => {
    const client = createEventClient();
    await logTaskEvent('task_completed',
      { id: 't-2', clientId: 'cl-1', caregiverId: null },
      'user:laura@tc', client);
    expect(client._calls[0].row.entity_type).toBe('client');
  });

  it('uses entity_type=null when no entity link exists', async () => {
    const client = createEventClient();
    await logTaskEvent('task_created',
      { id: 't-3', caregiverId: null, clientId: null },
      'user:jess@tc', client);
    expect(client._calls[0].row.entity_type).toBeNull();
  });

  it('refuses to write unknown event types (typo guard)', async () => {
    const client = createEventClient();
    await logTaskEvent('task_not_a_real_event', { id: 't-4' }, 'user:x', client);
    expect(client._calls).toHaveLength(0);
  });

  it('swallows DB errors silently (fire-and-forget)', async () => {
    const bad = {
      from() {
        return {
          insert() { throw new Error('boom'); },
        };
      },
    };
    // Should not throw.
    await expect(logTaskEvent('task_created', { id: 't-5' }, 'user:x', bad))
      .resolves.toBeUndefined();
  });
});
