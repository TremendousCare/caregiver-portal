// Executive Goals — Supabase data layer.
//
// All queries are org-scoped at the RLS layer (policies match
// auth.jwt() ->> 'org_id' = exec_*.org_id), so callers do not pass
// orgId on SELECT — the policy filters automatically. For INSERTs we
// explicitly set org_id from the JWT claim so the default_org_id()
// column default never silently leaks one org's data into another's.
//
// Functions return { data, error } so callers don't have to do double
// try/catch. The hook layer wraps these and surfaces error.message
// to the UI.

import { validateGoalDraft, validateKrDraft, validateCheckinDraft, mondayOf } from './goalsHelpers';

// ─── Fetch ────────────────────────────────────────────────────

// Single round-trip: goals for a quarter, KRs nested, latest 12 weeks
// of check-ins per KR nested under that. Latest 12 = enough for a
// quarter at one-checkin-per-week.
export async function fetchGoalsForQuarter(supabase, quarter) {
  if (!supabase) return { data: [], error: null };
  if (!quarter) return { data: [], error: null };
  const { data, error } = await supabase
    .from('exec_goals')
    .select(`
      id, org_id, title, description, owner_email, quarter,
      start_date, end_date, status, parent_goal_id, sort_order,
      created_at, updated_at,
      exec_key_results (
        id, org_id, goal_id, title, description, owner_email,
        metric_unit, start_value, current_value, target_value,
        direction, confidence, last_checked_in_at, data_source,
        sort_order, created_at, updated_at,
        exec_goal_checkins (
          id, key_result_id, week_of, value, confidence, note, author, created_at
        )
      )
    `)
    .eq('quarter', quarter)
    .order('sort_order', { ascending: true });
  if (error) return { data: [], error };
  return { data: data ?? [], error: null };
}

// Just the distinct quarters that have goals — fuels the quarter
// picker on first load.
export async function fetchKnownQuarters(supabase) {
  if (!supabase) return { data: [], error: null };
  const { data, error } = await supabase
    .from('exec_goals')
    .select('quarter');
  if (error) return { data: [], error };
  // Dedupe in JS — Postgres would need DISTINCT which Supabase JS
  // does not surface ergonomically on the .select() builder.
  const set = new Set();
  for (const row of data ?? []) {
    if (row?.quarter) set.add(row.quarter);
  }
  return { data: Array.from(set), error: null };
}

// ─── Mutations: goals ─────────────────────────────────────────

export async function createGoal(supabase, { orgId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!orgId) return { data: null, error: new Error('Missing org_id — sign out and back in.') };
  const v = validateGoalDraft(draft);
  if (!v.ok) return { data: null, error: new Error(v.error) };

  const row = {
    org_id:        orgId,
    title:         draft.title.trim(),
    description:   draft.description?.trim() || null,
    owner_email:   draft.owner_email.trim().toLowerCase(),
    quarter:       draft.quarter,
    start_date:    draft.start_date,
    end_date:      draft.end_date,
    status:        draft.status ?? 'draft',
    parent_goal_id: draft.parent_goal_id ?? null,
    sort_order:    draft.sort_order ?? 0,
  };
  const { data, error } = await supabase
    .from('exec_goals')
    .insert(row)
    .select()
    .single();
  return { data, error };
}

export async function updateGoal(supabase, { id, patch }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing goal id.') };
  // Only forward allowed columns; never touch org_id or id.
  const allowed = ['title', 'description', 'owner_email', 'quarter',
                   'start_date', 'end_date', 'status', 'parent_goal_id',
                   'sort_order'];
  const update = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch ?? {}, k)) {
      update[k] = patch[k];
    }
  }
  if (Object.keys(update).length === 0) {
    return { data: null, error: new Error('No fields to update.') };
  }
  if (update.title !== undefined && !update.title?.trim()) {
    return { data: null, error: new Error('Title cannot be blank.') };
  }
  if (update.owner_email !== undefined) {
    update.owner_email = update.owner_email.trim().toLowerCase();
  }
  const { data, error } = await supabase
    .from('exec_goals')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}

export async function deleteGoal(supabase, id) {
  if (!supabase) return { error: new Error('Supabase not configured.') };
  if (!id) return { error: new Error('Missing goal id.') };
  const { error } = await supabase.from('exec_goals').delete().eq('id', id);
  return { error };
}

// ─── Mutations: key results ───────────────────────────────────

export async function createKr(supabase, { orgId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!orgId) return { data: null, error: new Error('Missing org_id.') };
  const v = validateKrDraft(draft);
  if (!v.ok) return { data: null, error: new Error(v.error) };

  const startValue = draft.start_value === null
    || draft.start_value === undefined
    || draft.start_value === ''
      ? 0
      : Number(draft.start_value);
  const currentValue = draft.current_value === null
    || draft.current_value === undefined
    || draft.current_value === ''
      ? startValue
      : Number(draft.current_value);

  const row = {
    org_id:        orgId,
    goal_id:       draft.goal_id,
    title:         draft.title.trim(),
    description:   draft.description?.trim() || null,
    owner_email:   draft.owner_email.trim().toLowerCase(),
    metric_unit:   draft.metric_unit,
    start_value:   startValue,
    current_value: currentValue,
    target_value:  Number(draft.target_value),
    direction:     draft.direction ?? 'increase',
    confidence:    draft.confidence ?? 'green',
    data_source:   draft.data_source ?? 'manual',
    sort_order:    draft.sort_order ?? 0,
  };
  const { data, error } = await supabase
    .from('exec_key_results')
    .insert(row)
    .select()
    .single();
  return { data, error };
}

export async function updateKr(supabase, { id, patch }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing key result id.') };
  const allowed = ['title', 'description', 'owner_email', 'metric_unit',
                   'start_value', 'current_value', 'target_value',
                   'direction', 'confidence', 'data_source', 'sort_order',
                   'last_checked_in_at'];
  const update = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch ?? {}, k)) {
      update[k] = patch[k];
    }
  }
  if (Object.keys(update).length === 0) {
    return { data: null, error: new Error('No fields to update.') };
  }
  if (update.title !== undefined && !update.title?.trim()) {
    return { data: null, error: new Error('Title cannot be blank.') };
  }
  if (update.owner_email !== undefined) {
    update.owner_email = update.owner_email.trim().toLowerCase();
  }
  for (const numKey of ['start_value', 'current_value', 'target_value']) {
    if (update[numKey] !== undefined) {
      const n = Number(update[numKey]);
      if (!Number.isFinite(n)) {
        return { data: null, error: new Error(`${numKey} must be a number.`) };
      }
      update[numKey] = n;
    }
  }
  const { data, error } = await supabase
    .from('exec_key_results')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}

export async function deleteKr(supabase, id) {
  if (!supabase) return { error: new Error('Supabase not configured.') };
  if (!id) return { error: new Error('Missing key result id.') };
  const { error } = await supabase.from('exec_key_results').delete().eq('id', id);
  return { error };
}

// ─── Mutations: weekly check-ins ──────────────────────────────
// Upsert on (key_result_id, week_of) so a Friday-then-Saturday
// double-check just overwrites. Also bumps last_checked_in_at +
// current_value + confidence on the parent KR so the dashboard
// shows the latest state without a second join.

export async function upsertCheckin(supabase, { orgId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!orgId) return { data: null, error: new Error('Missing org_id.') };
  const normalized = {
    ...draft,
    week_of: /^\d{4}-\d{2}-\d{2}$/.test(draft.week_of ?? '')
      ? draft.week_of
      : mondayOf(draft.week_of || new Date()),
    value: draft.value === '' ? null : Number(draft.value),
  };
  const v = validateCheckinDraft(normalized);
  if (!v.ok) return { data: null, error: new Error(v.error) };

  const row = {
    org_id:        orgId,
    key_result_id: normalized.key_result_id,
    week_of:       normalized.week_of,
    value:         normalized.value,
    confidence:    normalized.confidence,
    note:          normalized.note?.trim() || null,
    author:        normalized.author,
  };
  const { data, error } = await supabase
    .from('exec_goal_checkins')
    .upsert(row, { onConflict: 'key_result_id,week_of' })
    .select()
    .single();
  if (error) return { data: null, error };

  // Side effect: bump the parent KR. Best-effort — if this fails the
  // check-in still recorded and the UI just reads slightly stale KR
  // state until next refresh.
  try {
    await supabase
      .from('exec_key_results')
      .update({
        current_value: row.value,
        confidence:    row.confidence,
        last_checked_in_at: new Date().toISOString(),
      })
      .eq('id', row.key_result_id);
  } catch (e) {
    console.warn('exec_key_results bump after check-in failed:', e);
  }

  return { data, error: null };
}
