import { supabase, isSupabaseConfigured } from '../../lib/supabase';

// ═══════════════════════════════════════════════════════════════
// Care Plan Storage Layer
//
// Thin wrappers around Supabase for the clinical care plan tables:
//   care_plans            one per client
//   care_plan_versions    immutable-once-published snapshots
//   care_plan_tasks       per-version ADL / IADL task list
//
// Phase 2a (this module) is read-only plus "create an empty plan".
// Editing and publishing come in Phase 2b; they'll extend this file
// with createVersion / saveDraft / publishVersion functions.
//
// Mapper pattern matches src/features/scheduling/storage.js:
//   dbTo<X>   snake_case row → camelCase JS object
//   <x>ToDb   the reverse
// Partial-update builders are explicit about which keys they emit
// so a status-only patch doesn't clobber unrelated columns.
// ═══════════════════════════════════════════════════════════════


// ─── care_plans mappers ─────────────────────────────────────────

export const dbToCarePlan = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    status: row.status || 'active',
    currentVersionId: row.current_version_id ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const carePlanToDb = (plan) => ({
  id: plan.id,
  client_id: plan.clientId,
  status: plan.status ?? 'active',
  current_version_id: plan.currentVersionId ?? null,
  created_by: plan.createdBy ?? null,
});


// ─── care_plan_versions mappers ────────────────────────────────

export const dbToCarePlanVersion = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    carePlanId: row.care_plan_id,
    versionNumber: row.version_number,
    status: row.status || 'draft',
    versionReason: row.version_reason ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at ?? null,
    publishedBy: row.published_by ?? null,
    clientSignedName: row.client_signed_name ?? null,
    clientSignedAt: row.client_signed_at ?? null,
    agencySignedName: row.agency_signed_name ?? null,
    agencySignedAt: row.agency_signed_at ?? null,
    data: row.data || {},
    generatedSummary: row.generated_summary ?? null,
  };
};

export const carePlanVersionToDb = (version) => ({
  id: version.id,
  care_plan_id: version.carePlanId,
  version_number: version.versionNumber,
  status: version.status ?? 'draft',
  version_reason: version.versionReason ?? null,
  created_by: version.createdBy ?? null,
  data: version.data ?? {},
  generated_summary: version.generatedSummary ?? null,
});


// ─── care_plan_tasks mappers ───────────────────────────────────

export const dbToCarePlanTask = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    versionId: row.version_id,
    category: row.category,
    taskName: row.task_name,
    description: row.description ?? null,
    shifts: Array.isArray(row.shifts) ? row.shifts : ['all'],
    daysOfWeek: Array.isArray(row.days_of_week) ? row.days_of_week : [],
    priority: row.priority || 'standard',
    safetyNotes: row.safety_notes ?? null,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const carePlanTaskToDb = (task) => ({
  id: task.id,
  version_id: task.versionId,
  category: task.category,
  task_name: task.taskName,
  description: task.description ?? null,
  shifts: Array.isArray(task.shifts) && task.shifts.length > 0 ? task.shifts : ['all'],
  days_of_week: Array.isArray(task.daysOfWeek) ? task.daysOfWeek : [],
  priority: task.priority ?? 'standard',
  safety_notes: task.safetyNotes ?? null,
  sort_order: task.sortOrder ?? 0,
});


// ─── Queries ────────────────────────────────────────────────────

/**
 * Fetch the active care plan for a client along with its current
 * version. Returns { plan, currentVersion } or `null` if no plan
 * exists yet. Callers should treat `null` as the empty state.
 */
export const getCarePlanForClient = async (clientId) => {
  if (!isSupabaseConfigured()) return null;
  if (!clientId) return null;

  const { data: planRows, error: planErr } = await supabase
    .from('care_plans')
    .select('*')
    .eq('client_id', clientId)
    .eq('status', 'active')
    .limit(1);
  if (planErr) throw planErr;
  if (!planRows || planRows.length === 0) return null;

  const plan = dbToCarePlan(planRows[0]);
  const currentVersion = plan.currentVersionId
    ? await getVersion(plan.currentVersionId)
    : null;
  return { plan, currentVersion };
};


/**
 * List all versions for a care plan, newest first. Used for the
 * version history UI.
 */
export const listVersions = async (carePlanId) => {
  if (!isSupabaseConfigured()) return [];
  if (!carePlanId) return [];
  const { data, error } = await supabase
    .from('care_plan_versions')
    .select('*')
    .eq('care_plan_id', carePlanId)
    .order('version_number', { ascending: false });
  if (error) throw error;
  return (data || []).map(dbToCarePlanVersion);
};


/**
 * Fetch a single version by id. Returns null if not found so
 * callers can detect stale links gracefully.
 */
export const getVersion = async (versionId) => {
  if (!isSupabaseConfigured()) return null;
  if (!versionId) return null;
  const { data, error } = await supabase
    .from('care_plan_versions')
    .select('*')
    .eq('id', versionId)
    .maybeSingle();
  if (error) throw error;
  return dbToCarePlanVersion(data);
};


/**
 * Fetch all tasks for a version, sorted by category then sort_order.
 * Used by the read-only panel's ADL / IADL sections and (Phase 2d)
 * the caregiver app's per-shift task list.
 */
export const getTasksForVersion = async (versionId) => {
  if (!isSupabaseConfigured()) return [];
  if (!versionId) return [];
  const { data, error } = await supabase
    .from('care_plan_tasks')
    .select('*')
    .eq('version_id', versionId)
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data || []).map(dbToCarePlanTask);
};


// ─── Mutations ──────────────────────────────────────────────────

/**
 * Create a new care plan for a client plus an initial empty draft
 * version (v1). Returns the same `{ plan, currentVersion }` shape
 * as getCarePlanForClient.
 *
 * Two-step write (no server-side transaction available from the
 * JS SDK): insert the care_plans row, then the version row, then
 * patch current_version_id. If either step fails mid-way, callers
 * will see either no plan or a plan with current_version_id = NULL —
 * the UI tolerates both and the follow-up create attempt is a no-op
 * because the unique-active-plan-per-client index prevents duplicates.
 */
export const createCarePlan = async (clientId, { createdBy } = {}) => {
  if (!isSupabaseConfigured()) return null;
  if (!clientId) throw new Error('clientId is required');

  // 1. Insert the care_plans row
  const { data: planRow, error: planErr } = await supabase
    .from('care_plans')
    .insert({ client_id: clientId, status: 'active', created_by: createdBy ?? null })
    .select()
    .single();
  if (planErr) throw planErr;

  // 2. Insert the initial draft version (v1)
  const { data: versionRow, error: versionErr } = await supabase
    .from('care_plan_versions')
    .insert({
      care_plan_id: planRow.id,
      version_number: 1,
      status: 'draft',
      version_reason: 'initial intake',
      created_by: createdBy ?? null,
      data: {},
    })
    .select()
    .single();
  if (versionErr) throw versionErr;

  // 3. Point the care plan at the new version
  const { data: patched, error: patchErr } = await supabase
    .from('care_plans')
    .update({ current_version_id: versionRow.id })
    .eq('id', planRow.id)
    .select()
    .single();
  if (patchErr) throw patchErr;

  return {
    plan: dbToCarePlan(patched),
    currentVersion: dbToCarePlanVersion(versionRow),
  };
};
