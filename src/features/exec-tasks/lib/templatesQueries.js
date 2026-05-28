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

// ─── Create ──────────────────────────────────────────────────
//
// The create form exposes one "template type" selector rather than
// two separate category / anchor_type dropdowns, because the two are
// coupled by the DB CHECK constraint (hire_date needs offset_days,
// fixed_date needs recurrence_interval_days). This map is the single
// source of truth for that coupling on the write path.
const CREATE_TYPE_MAP = {
  lifecycle: { category: 'lifecycle', anchor_type: 'hire_date' },
  recurring: { category: 'recurring', anchor_type: 'fixed_date' },
  ad_hoc:    { category: 'ad_hoc',    anchor_type: 'manual' },
};

// Slug is an internal stable key (never shown in the UI) that must be
// UNIQUE per org. We derive it from the name and append a short random
// suffix so the non-technical owner never hits a "slug already taken"
// wall for re-using a name. Exported for testing the name→base path.
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function randomSlugSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

// Pure validation for the create form. Mirrors the DB CHECK constraint:
// a hire_date template must carry offset_days, a fixed_date template
// must carry recurrence_interval_days. next_fire_at is NOT required at
// create time — new templates land inactive, and activation (which
// does require it) is gated separately by validateActivation.
export function validateNewTemplateDraft(draft) {
  if (!draft || typeof draft !== 'object') return { ok: false, error: 'Missing template data.' };
  if (!draft.name || !draft.name.trim()) return { ok: false, error: 'Name is required.' };
  const map = CREATE_TYPE_MAP[draft.templateType];
  if (!map) return { ok: false, error: 'Choose a template type.' };
  if (map.anchor_type === 'hire_date') {
    const n = Number(draft.offset_days);
    if (draft.offset_days === '' || draft.offset_days == null || Number.isNaN(n) || n < 0) {
      return { ok: false, error: 'Lifecycle templates need a "days after hire date" value (0 or more).' };
    }
  }
  if (map.anchor_type === 'fixed_date') {
    const n = Number(draft.recurrence_interval_days);
    if (draft.recurrence_interval_days === '' || draft.recurrence_interval_days == null || Number.isNaN(n) || n < 1) {
      return { ok: false, error: 'Recurring templates need a recurrence interval of at least 1 day.' };
    }
  }
  return { ok: true };
}

export async function createTemplate(supabase, { orgId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!orgId) return { data: null, error: new Error('Missing org_id — sign out and back in.') };
  const v = validateNewTemplateDraft(draft);
  if (!v.ok) return { data: null, error: new Error(v.error) };

  const { category, anchor_type } = CREATE_TYPE_MAP[draft.templateType];
  const sq = draft.structured_questions ?? [];
  if (!Array.isArray(sq)) {
    return { data: null, error: new Error('structured_questions must be an array.') };
  }

  const base = slugify(draft.name) || 'template';
  // New templates are always created inactive: the owner reviews the
  // wording and timing, then flips the toggle. This matches the seed
  // safety convention (all 25 seeded templates ship active=false) and
  // means we don't have to gate next_fire_at on the create path.
  const row = {
    org_id: orgId,
    slug: `${base}_${randomSlugSuffix()}`,
    name: draft.name.trim(),
    description: draft.description?.trim() || null,
    guidance: draft.guidance?.trim() || null,
    category,
    anchor_type,
    offset_days: anchor_type === 'hire_date' ? Number(draft.offset_days) : null,
    recurrence_interval_days: anchor_type === 'fixed_date' ? Number(draft.recurrence_interval_days) : null,
    next_fire_at: anchor_type === 'fixed_date' && draft.next_fire_at ? draft.next_fire_at : null,
    structured_questions: sq,
    default_assignee_email: draft.default_assignee_email?.trim().toLowerCase() || null,
    default_urgency: draft.default_urgency ?? 'warning',
    visibility: 'owner',
    active: false,
  };

  const { data, error } = await supabase
    .from('exec_task_templates')
    .insert(row)
    .select()
    .single();
  // 23505 = unique_violation. The random suffix makes this near-impossible,
  // but surface a friendly message rather than a Postgres error if it hits.
  if (error && error.code === '23505') {
    return { data: null, error: new Error('A template with that name already exists — try a slightly different name.') };
  }
  return { data, error };
}
