// Executive Tasks — Supabase data layer.
//
// Owner-only at the RLS layer. The instance list is paginated by
// status filter on the client (small dataset). Completion writes the
// structured_responses + outcome + completion metadata and bumps
// status='done' in a single UPDATE.

const TASK_COLUMNS = `
  id, org_id, template_id, title, description, category, visibility,
  assigned_to, due_at, status, urgency,
  anchor_staff_email, anchor_date, recurrence_period,
  completed_at, completed_by, completion_notes, structured_responses, outcome,
  snoozed_until, cancellation_reason,
  generated_at, created_at, updated_at,
  exec_task_templates ( id, slug, name, structured_questions )
`;

export async function fetchTasks(supabase, { status, limit = 100 } = {}) {
  if (!supabase) return { data: [], error: null };
  let q = supabase
    .from('exec_tasks')
    .select(TASK_COLUMNS)
    .order('due_at', { ascending: true })
    .limit(limit);
  if (status && status !== 'all') {
    if (status === 'open') {
      q = q.in('status', ['pending', 'in_progress', 'snoozed']);
    } else {
      q = q.eq('status', status);
    }
  }
  const { data, error } = await q;
  if (error) return { data: [], error };
  return { data: data ?? [], error: null };
}

// ─── Validation ──────────────────────────────────────────────

export function validateAdHocDraft(draft) {
  if (!draft || typeof draft !== 'object') return { ok: false, error: 'Missing task data.' };
  if (!draft.title || !draft.title.trim()) return { ok: false, error: 'Title is required.' };
  if (!draft.due_at) return { ok: false, error: 'Due date is required.' };
  return { ok: true };
}

// Required-question check: structured_questions can mark items as
// required:true. The completion form refuses to submit unless every
// required item has a non-empty response.
export function validateStructuredResponses(questions, responses) {
  if (!Array.isArray(questions)) return { ok: true };
  for (const q of questions) {
    if (!q?.required) continue;
    const v = responses?.[q.id];
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      return { ok: false, error: `"${q.label ?? q.id}" is required.` };
    }
  }
  return { ok: true };
}

// ─── Mutations ───────────────────────────────────────────────

export async function createAdHocTask(supabase, { orgId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!orgId) return { data: null, error: new Error('Missing org_id.') };
  const v = validateAdHocDraft(draft);
  if (!v.ok) return { data: null, error: new Error(v.error) };

  const row = {
    org_id:      orgId,
    template_id: null,
    title:       draft.title.trim(),
    description: draft.description?.trim() || null,
    category:    'ad_hoc',
    visibility:  draft.visibility ?? 'owner',
    assigned_to: draft.assigned_to?.trim().toLowerCase() || null,
    due_at:      draft.due_at,
    urgency:     draft.urgency ?? 'warning',
  };
  const { data, error } = await supabase
    .from('exec_tasks')
    .insert(row)
    .select()
    .single();
  return { data, error };
}

export async function completeTask(supabase, { id, completedBy, structuredResponses, completionNotes, outcome, questions }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing task id.') };
  const v = validateStructuredResponses(questions, structuredResponses);
  if (!v.ok) return { data: null, error: new Error(v.error) };
  const validOutcomes = [null, undefined, 'on_track', 'needs_support', 'concern'];
  if (!validOutcomes.includes(outcome)) {
    return { data: null, error: new Error('Invalid outcome value.') };
  }

  const update = {
    status: 'done',
    completed_at: new Date().toISOString(),
    completed_by: completedBy ?? null,
    structured_responses: structuredResponses ?? {},
    completion_notes: completionNotes?.trim() || null,
    outcome: outcome ?? null,
  };
  const { data, error } = await supabase
    .from('exec_tasks')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}

export async function snoozeTask(supabase, { id, snoozedUntil }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing task id.') };
  if (!snoozedUntil) return { data: null, error: new Error('Snooze date required.') };
  const { data, error } = await supabase
    .from('exec_tasks')
    .update({ status: 'snoozed', snoozed_until: snoozedUntil })
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}

export async function cancelTask(supabase, { id, reason }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing task id.') };
  const { data, error } = await supabase
    .from('exec_tasks')
    .update({
      status: 'cancelled',
      cancellation_reason: reason?.trim() || null,
    })
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}

// Reopen a completed task — clears the completion fields and flips
// status back to 'pending'. Useful when an owner realizes they
// answered the structured form for the wrong instance.
export async function reopenTask(supabase, { id }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing task id.') };
  const { data, error } = await supabase
    .from('exec_tasks')
    .update({
      status: 'pending',
      completed_at: null,
      completed_by: null,
      completion_notes: null,
      outcome: null,
    })
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}
