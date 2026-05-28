// Staff directory — Supabase data layer.
//
// staff_members is org-scoped; RLS lets any staff member SELECT
// (so the office can see the team list) but only owners can
// INSERT/UPDATE/DELETE (HR-grade data, deliberate edits). The
// frontend gates the affordances; the DB enforces the boundary.

const STAFF_COLUMNS = `
  id, org_id, email, first_name, last_name, role_title,
  manager_email, hire_date, end_date, active, notes,
  created_at, updated_at
`;

// ─── Validation ──────────────────────────────────────────────

export function validateStaffDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing staff data.' };
  }
  if (!draft.first_name || !draft.first_name.trim()) {
    return { ok: false, error: 'First name is required.' };
  }
  if (!draft.email || !draft.email.includes('@')) {
    return { ok: false, error: 'A valid email is required.' };
  }
  if (!draft.hire_date) {
    return { ok: false, error: 'Hire date is required.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.hire_date)) {
    return { ok: false, error: 'Hire date must be a valid YYYY-MM-DD.' };
  }
  if (draft.end_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.end_date)) {
      return { ok: false, error: 'End date must be a valid YYYY-MM-DD.' };
    }
    if (draft.end_date < draft.hire_date) {
      return { ok: false, error: 'End date must be on or after hire date.' };
    }
  }
  if (draft.manager_email && !draft.manager_email.includes('@')) {
    return { ok: false, error: 'Manager email must be valid (or left blank).' };
  }
  return { ok: true };
}

// ─── Fetch ────────────────────────────────────────────────────

export async function fetchStaff(supabase, { includeInactive = true } = {}) {
  if (!supabase) return { data: [], error: null };
  let q = supabase
    .from('staff_members')
    .select(STAFF_COLUMNS)
    .order('active', { ascending: false })  // active first
    .order('hire_date', { ascending: true });
  if (!includeInactive) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return { data: [], error };
  return { data: data ?? [], error: null };
}

// ─── Mutations ────────────────────────────────────────────────

function normalizeDraft(draft) {
  return {
    email:         draft.email.trim().toLowerCase(),
    first_name:    draft.first_name.trim(),
    last_name:     draft.last_name?.trim() || null,
    role_title:    draft.role_title?.trim() || null,
    manager_email: draft.manager_email?.trim().toLowerCase() || null,
    hire_date:     draft.hire_date,
    end_date:      draft.end_date || null,
    active:        draft.active !== false,
    notes:         draft.notes?.trim() || null,
  };
}

export async function createStaff(supabase, { orgId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!orgId) return { data: null, error: new Error('Missing org_id.') };
  const v = validateStaffDraft(draft);
  if (!v.ok) return { data: null, error: new Error(v.error) };
  const row = { org_id: orgId, ...normalizeDraft(draft) };
  const { data, error } = await supabase
    .from('staff_members')
    .insert(row)
    .select()
    .single();
  return { data, error };
}

const UPDATABLE_COLUMNS = [
  'email', 'first_name', 'last_name', 'role_title',
  'manager_email', 'hire_date', 'end_date', 'active', 'notes',
];

export async function updateStaff(supabase, { id, patch }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing staff id.') };
  if (!patch || typeof patch !== 'object') {
    return { data: null, error: new Error('Missing patch.') };
  }
  // Apply the same validation rules to the merged shape so end_date <
  // hire_date is caught even when only one of the two is in the patch.
  // The caller passes the existing row in `currentRow` for this purpose.
  const update = {};
  for (const k of UPDATABLE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      update[k] = patch[k];
    }
  }
  if (Object.keys(update).length === 0) {
    return { data: null, error: new Error('No fields to update.') };
  }
  // Defensive normalization for the columns the form touches.
  if (update.email !== undefined) {
    if (!update.email || !update.email.includes('@')) {
      return { data: null, error: new Error('A valid email is required.') };
    }
    update.email = update.email.trim().toLowerCase();
  }
  if (update.first_name !== undefined && !update.first_name?.trim()) {
    return { data: null, error: new Error('First name cannot be blank.') };
  }
  if (update.first_name !== undefined) update.first_name = update.first_name.trim();
  if (update.last_name !== undefined)  update.last_name  = update.last_name?.trim() || null;
  if (update.role_title !== undefined) update.role_title = update.role_title?.trim() || null;
  if (update.manager_email !== undefined) {
    if (update.manager_email && !update.manager_email.includes('@')) {
      return { data: null, error: new Error('Manager email must be valid (or blank).') };
    }
    update.manager_email = update.manager_email?.trim().toLowerCase() || null;
  }
  if (update.notes !== undefined) update.notes = update.notes?.trim() || null;
  if (update.hire_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(update.hire_date)) {
    return { data: null, error: new Error('Hire date must be YYYY-MM-DD.') };
  }
  if (update.end_date !== undefined && update.end_date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(update.end_date)) {
      return { data: null, error: new Error('End date must be YYYY-MM-DD.') };
    }
  }

  const { data, error } = await supabase
    .from('staff_members')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}

export async function deactivateStaff(supabase, { id, endDate }) {
  // Convenience over a generic update: flips active=false and (optionally)
  // sets end_date in the same call. Used when someone leaves the company.
  return updateStaff(supabase, {
    id,
    patch: { active: false, end_date: endDate || null },
  });
}

export async function deleteStaff(supabase, id) {
  // Hard delete. Used rarely — for typos / accidental adds. For real
  // separations, prefer deactivateStaff so the historical record (and
  // any past exec_tasks anchored to anchor_staff_email) stays intact.
  if (!supabase) return { error: new Error('Supabase not configured.') };
  if (!id) return { error: new Error('Missing staff id.') };
  const { error } = await supabase.from('staff_members').delete().eq('id', id);
  return { error };
}
