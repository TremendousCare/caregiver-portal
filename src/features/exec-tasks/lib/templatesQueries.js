// Executive Templates — Supabase data layer.
//
// Templates are owner-only at the RLS layer (exec_task_templates_owner_*),
// so this module is only exercised when the caller is signed in as
// an owner. The hook layer captures org_id from the JWT and forwards
// it on inserts; updates and deletes don't need org_id because the
// row's existing org_id stays in place and the RLS policy enforces
// org-scoping on every UPDATE.

const TEMPLATE_COLUMNS = `
  id, org_id, slug, name, description, guidance, category,
  anchor_type, offset_days, recurrence_interval_days, next_fire_at,
  structured_questions, default_assignee_email, default_urgency,
  visibility, active, sort_order, created_at, updated_at
`;

export async function fetchTemplates(supabase) {
  if (!supabase) return { data: [], error: null };
  const { data, error } = await supabase
    .from('exec_task_templates')
    .select(TEMPLATE_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) return { data: [], error };
  return { data: data ?? [], error: null };
}

// Activating a recurring template requires a next_fire_at — without
// one the generator has no anchor and skips silently. We refuse the
// activate transition at this layer rather than letting the UI ship
// an inactive-feeling template.
export function validateActivation(template, patch) {
  const wantsActive = patch?.active === true;
  if (!wantsActive) return { ok: true };
  if (template.anchor_type === 'fixed_date') {
    const candidateNextFire = patch.next_fire_at ?? template.next_fire_at;
    if (!candidateNextFire) {
      return {
        ok: false,
        error: 'Set "next fire date" on a recurring template before activating it.',
      };
    }
  }
  return { ok: true };
}

const UPDATABLE_COLUMNS = [
  'name', 'description', 'guidance',
  'offset_days', 'recurrence_interval_days', 'next_fire_at',
  'structured_questions', 'default_assignee_email', 'default_urgency',
  'visibility', 'active', 'sort_order',
];

export async function updateTemplate(supabase, { id, template, patch }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!id) return { data: null, error: new Error('Missing template id.') };
  const v = validateActivation(template ?? {}, patch ?? {});
  if (!v.ok) return { data: null, error: new Error(v.error) };

  const update = {};
  for (const k of UPDATABLE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch ?? {}, k)) {
      update[k] = patch[k];
    }
  }
  if (Object.keys(update).length === 0) {
    return { data: null, error: new Error('No fields to update.') };
  }
  if (update.default_assignee_email !== undefined && update.default_assignee_email) {
    update.default_assignee_email = update.default_assignee_email.trim().toLowerCase() || null;
  }
  // Defensive: structured_questions must be an array. The UI builder
  // produces an array, but if a raw editor returns {} we reject so the
  // CHECK CONSTRAINTs and the JSON shape contract are preserved.
  if (update.structured_questions !== undefined && !Array.isArray(update.structured_questions)) {
    return { data: null, error: new Error('structured_questions must be an array.') };
  }
  const { data, error } = await supabase
    .from('exec_task_templates')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  return { data, error };
}

// Returns true when the template's UI shows a "set next fire date"
// hint. Pure helper used by the templates list.
export function needsNextFireDate(template) {
  if (!template) return false;
  if (template.anchor_type !== 'fixed_date') return false;
  return !template.next_fire_at;
}
