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


// ─── Event logging (fire-and-forget) ───────────────────────────
// Mutations below emit rows into the `events` table so the AI context
// layer can ask "what changed this week for Kevin?" without another
// data pipeline. Intentionally fire-and-forget: event-log failures
// never block the main write or propagate to the user. We `await` only
// the main write; events are scheduled on the microtask queue via
// `.then()`.

const logEvent = (eventType, entityType, entityId, actor, payload) => {
  if (!isSupabaseConfigured()) return;
  supabase
    .from('events')
    .insert({
      event_type: eventType,
      entity_type: entityType,
      entity_id: entityId,
      actor: actor || null,
      payload: payload || {},
    })
    .then(({ error }) => {
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[care-plans] event log failed:', eventType, error.message);
      }
    });
};

const actorFor = (userId) => (userId ? `user:${userId}` : 'user:unknown');


// ─── saveDraft ─────────────────────────────────────────────────
/**
 * Merge `fieldPatch` into `data[sectionId]` on a draft version and
 * emit one `care_plan_field_changed` event per changed field.
 *
 * `fieldPatch` shape: `{ [fieldId]: value, ... }`. Only supplied keys
 * are modified — other fields on the section are preserved. Values
 * that match the existing stored value are treated as no-ops (no
 * write, no event).
 *
 * Rejects if the target version is not a draft. Callers should route
 * "edit a published version" through `createNewDraftVersion` first.
 */
export const saveDraft = async (versionId, sectionId, fieldPatch, { userId } = {}) => {
  if (!isSupabaseConfigured()) return null;
  if (!versionId) throw new Error('versionId is required');
  if (!sectionId) throw new Error('sectionId is required');
  if (!fieldPatch || typeof fieldPatch !== 'object') {
    throw new Error('fieldPatch must be an object');
  }

  // Load current version (need status + data to compute the patch)
  const { data: current, error: readErr } = await supabase
    .from('care_plan_versions')
    .select('id, care_plan_id, status, data')
    .eq('id', versionId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!current) throw new Error('version not found');
  if (current.status !== 'draft') {
    throw new Error('cannot edit a published or archived version — start a new draft first');
  }

  const existingSection = (current.data && current.data[sectionId]) || {};
  const merged = { ...existingSection };
  const changes = []; // [{field, oldValue, newValue}]

  for (const [fieldId, newValue] of Object.entries(fieldPatch)) {
    const oldValue = existingSection[fieldId];
    if (sameValue(oldValue, newValue)) continue;
    merged[fieldId] = newValue;
    changes.push({ field: fieldId, oldValue, newValue });
  }

  if (changes.length === 0) {
    // No-op write — return current row unchanged.
    return dbToCarePlanVersion(current);
  }

  const newData = { ...(current.data || {}), [sectionId]: merged };

  const { data: updated, error: updateErr } = await supabase
    .from('care_plan_versions')
    .update({ data: newData })
    .eq('id', versionId)
    .select()
    .single();
  if (updateErr) throw updateErr;

  // Emit one event per changed field.
  for (const change of changes) {
    logEvent(
      'care_plan_field_changed',
      'care_plan',
      current.care_plan_id,
      actorFor(userId),
      {
        versionId,
        section: sectionId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
      },
    );
  }

  return dbToCarePlanVersion(updated);
};


// ─── publishVersion ────────────────────────────────────────────
/**
 * Publish a draft version: stamp status, signatures, timestamps.
 * Once published, `saveDraft` on this version will be rejected.
 */
export const publishVersion = async (versionId, options = {}) => {
  if (!isSupabaseConfigured()) return null;
  if (!versionId) throw new Error('versionId is required');

  const {
    reason,
    agencySignedName,
    clientSignedName,
    clientSignedMethod,
    userId,
  } = options;

  if (!agencySignedName) {
    throw new Error('agencySignedName is required');
  }

  // Read to confirm it's a draft.
  const { data: current, error: readErr } = await supabase
    .from('care_plan_versions')
    .select('id, care_plan_id, status, version_number')
    .eq('id', versionId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!current) throw new Error('version not found');
  if (current.status !== 'draft') {
    throw new Error(`cannot publish: version is already ${current.status}`);
  }

  const now = new Date().toISOString();
  const patch = {
    status: 'published',
    published_at: now,
    published_by: userId ?? null,
    version_reason: reason ?? null,
    agency_signed_name: agencySignedName,
    agency_signed_at: now,
    client_signed_name: clientSignedName || null,
    client_signed_at: clientSignedName ? now : null,
  };

  const { data: updated, error: updateErr } = await supabase
    .from('care_plan_versions')
    .update(patch)
    .eq('id', versionId)
    .select()
    .single();
  if (updateErr) throw updateErr;

  logEvent(
    'care_plan_version_published',
    'care_plan',
    current.care_plan_id,
    actorFor(userId),
    {
      versionId,
      versionNumber: current.version_number,
      reason: reason ?? null,
      agencySignedName,
      clientSignedName: clientSignedName || null,
      clientSignedMethod: clientSignedMethod || null,
    },
  );

  return dbToCarePlanVersion(updated);
};


// ─── createNewDraftVersion ─────────────────────────────────────
/**
 * Clone a published version into a new draft (next version number)
 * and repoint `care_plans.current_version_id` to it. Tasks are cloned
 * forward too so editors have a starting point rather than an empty
 * task list.
 */
export const createNewDraftVersion = async (carePlanId, options = {}) => {
  if (!isSupabaseConfigured()) return null;
  if (!carePlanId) throw new Error('carePlanId is required');
  const { fromVersionId, reason, userId } = options;
  if (!fromVersionId) throw new Error('fromVersionId is required');

  // 1. Read the source version (must be published; creating a draft
  // from a draft is meaningless — just edit the existing draft).
  const { data: source, error: srcErr } = await supabase
    .from('care_plan_versions')
    .select('*')
    .eq('id', fromVersionId)
    .maybeSingle();
  if (srcErr) throw srcErr;
  if (!source) throw new Error('source version not found');
  if (source.care_plan_id !== carePlanId) {
    throw new Error('source version belongs to a different care plan');
  }

  // 2. Compute next version_number (max + 1).
  const { data: versions, error: listErr } = await supabase
    .from('care_plan_versions')
    .select('version_number')
    .eq('care_plan_id', carePlanId)
    .order('version_number', { ascending: false })
    .limit(1);
  if (listErr) throw listErr;
  const nextNumber = (versions?.[0]?.version_number || 0) + 1;

  // 3. Insert the new draft with cloned data + freshly-minted row id.
  const { data: draft, error: insertErr } = await supabase
    .from('care_plan_versions')
    .insert({
      care_plan_id: carePlanId,
      version_number: nextNumber,
      status: 'draft',
      version_reason: reason ?? null,
      created_by: userId ?? null,
      data: source.data ?? {},
    })
    .select()
    .single();
  if (insertErr) throw insertErr;

  // 4. Clone tasks from the source version to the new draft.
  const { data: sourceTasks, error: tasksErr } = await supabase
    .from('care_plan_tasks')
    .select('*')
    .eq('version_id', fromVersionId);
  if (tasksErr) throw tasksErr;

  if (sourceTasks && sourceTasks.length > 0) {
    const toInsert = sourceTasks.map((t) => ({
      version_id: draft.id,
      category: t.category,
      task_name: t.task_name,
      description: t.description,
      shifts: t.shifts,
      days_of_week: t.days_of_week,
      priority: t.priority,
      safety_notes: t.safety_notes,
      sort_order: t.sort_order,
    }));
    const { error: cloneErr } = await supabase
      .from('care_plan_tasks')
      .insert(toInsert);
    if (cloneErr) throw cloneErr;
  }

  // 5. Point the care plan at the new draft.
  const { error: pointErr } = await supabase
    .from('care_plans')
    .update({ current_version_id: draft.id })
    .eq('id', carePlanId);
  if (pointErr) throw pointErr;

  logEvent(
    'care_plan_version_created',
    'care_plan',
    carePlanId,
    actorFor(userId),
    {
      versionId: draft.id,
      versionNumber: nextNumber,
      fromVersionId,
      reason: reason ?? null,
    },
  );

  return dbToCarePlanVersion(draft);
};


// ─── Task CRUD ─────────────────────────────────────────────────
/**
 * Insert a new task on a draft version. Rejects if the version is
 * published or archived.
 */
export const createTask = async (versionId, task, { userId } = {}) => {
  if (!isSupabaseConfigured()) return null;
  if (!versionId) throw new Error('versionId is required');
  if (!task?.category) throw new Error('task.category is required');
  if (!task?.taskName) throw new Error('task.taskName is required');

  await assertVersionIsDraft(versionId);

  const { data: inserted, error } = await supabase
    .from('care_plan_tasks')
    .insert(carePlanTaskToDb({ ...task, versionId }))
    .select()
    .single();
  if (error) throw error;

  const { data: versionRow } = await supabase
    .from('care_plan_versions')
    .select('care_plan_id')
    .eq('id', versionId)
    .maybeSingle();

  logEvent(
    'care_plan_task_created',
    'care_plan',
    versionRow?.care_plan_id ?? null,
    actorFor(userId),
    { versionId, taskId: inserted.id, category: task.category, taskName: task.taskName },
  );

  return dbToCarePlanTask(inserted);
};


/**
 * Partial update on a task. Only the keys present in `patch` are
 * written — everything else is preserved. Rejects if the task belongs
 * to a non-draft version.
 */
export const updateTask = async (taskId, patch, { userId } = {}) => {
  if (!isSupabaseConfigured()) return null;
  if (!taskId) throw new Error('taskId is required');
  if (!patch || typeof patch !== 'object') throw new Error('patch must be an object');

  // Fetch for guard + event payload.
  const { data: task, error: readErr } = await supabase
    .from('care_plan_tasks')
    .select('id, version_id, category, task_name')
    .eq('id', taskId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!task) throw new Error('task not found');

  await assertVersionIsDraft(task.version_id);

  // Build a snake_case patch from the camelCase input, emitting only
  // supplied keys — mirrors the buildServicePlanPatchRow pattern.
  const dbPatch = {};
  if ('category' in patch)    dbPatch.category     = patch.category;
  if ('taskName' in patch)    dbPatch.task_name    = patch.taskName;
  if ('description' in patch) dbPatch.description  = patch.description;
  if ('shifts' in patch) {
    dbPatch.shifts = Array.isArray(patch.shifts) && patch.shifts.length > 0
      ? patch.shifts
      : ['all'];
  }
  if ('daysOfWeek' in patch) {
    dbPatch.days_of_week = Array.isArray(patch.daysOfWeek) ? patch.daysOfWeek : [];
  }
  if ('priority' in patch)    dbPatch.priority     = patch.priority;
  if ('safetyNotes' in patch) dbPatch.safety_notes = patch.safetyNotes;
  if ('sortOrder' in patch)   dbPatch.sort_order   = patch.sortOrder;

  if (Object.keys(dbPatch).length === 0) {
    // No-op patch. Return current row.
    return dbToCarePlanTask({ ...task });
  }

  const { data: updated, error: updateErr } = await supabase
    .from('care_plan_tasks')
    .update(dbPatch)
    .eq('id', taskId)
    .select()
    .single();
  if (updateErr) throw updateErr;

  const { data: versionRow } = await supabase
    .from('care_plan_versions')
    .select('care_plan_id')
    .eq('id', task.version_id)
    .maybeSingle();

  logEvent(
    'care_plan_task_updated',
    'care_plan',
    versionRow?.care_plan_id ?? null,
    actorFor(userId),
    { versionId: task.version_id, taskId, changedKeys: Object.keys(dbPatch) },
  );

  return dbToCarePlanTask(updated);
};


/**
 * Delete a task from a draft version. Rejects if the task's version
 * is published or archived — historical versions must stay intact.
 */
export const deleteTask = async (taskId, { userId } = {}) => {
  if (!isSupabaseConfigured()) return null;
  if (!taskId) throw new Error('taskId is required');

  const { data: task, error: readErr } = await supabase
    .from('care_plan_tasks')
    .select('id, version_id, category, task_name')
    .eq('id', taskId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!task) throw new Error('task not found');

  await assertVersionIsDraft(task.version_id);

  const { error: deleteErr } = await supabase
    .from('care_plan_tasks')
    .delete()
    .eq('id', taskId);
  if (deleteErr) throw deleteErr;

  const { data: versionRow } = await supabase
    .from('care_plan_versions')
    .select('care_plan_id')
    .eq('id', task.version_id)
    .maybeSingle();

  logEvent(
    'care_plan_task_deleted',
    'care_plan',
    versionRow?.care_plan_id ?? null,
    actorFor(userId),
    { versionId: task.version_id, taskId, category: task.category, taskName: task.task_name },
  );

  return true;
};


// ─── Observations (admin-side reads) ───────────────────────────
//
// Caregivers write to care_plan_observations from the PWA. Admin
// surfaces (ShiftDrawer per-shift log, CarePlanPanel timeline) read
// them back here. The mapper mirrors src/lib/carePlanShift.js so both
// sides agree on shape.

export const dbToObservation = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    carePlanId: row.care_plan_id,
    versionId: row.version_id,
    taskId: row.task_id ?? null,
    shiftId: row.shift_id ?? null,
    caregiverId: row.caregiver_id ?? null,
    observationType: row.observation_type,
    rating: row.rating ?? null,
    note: row.note ?? null,
    loggedAt: row.logged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/**
 * Fetch every observation for a single shift, oldest-first. Used by
 * the admin ShiftCarePlanLog view to show what the caregiver did
 * during this specific visit.
 */
export const getObservationsForShift = async (shiftId) => {
  if (!isSupabaseConfigured()) return [];
  if (!shiftId) return [];
  const { data, error } = await supabase
    .from('care_plan_observations')
    .select('*')
    .eq('shift_id', shiftId)
    .order('logged_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(dbToObservation);
};

/**
 * Fetch the most recent N observations for a care plan (across every
 * shift). Used by the per-client timeline in CarePlanPanel.
 *
 * Default limit is 50 — enough to span ~a week of typical activity
 * without paying for a long scan. Caller can bump it for a deeper
 * history view; pagination can come later if it's ever needed.
 */
export const getObservationsForCarePlan = async (carePlanId, { limit = 50 } = {}) => {
  if (!isSupabaseConfigured()) return [];
  if (!carePlanId) return [];
  const { data, error } = await supabase
    .from('care_plan_observations')
    .select('*')
    .eq('care_plan_id', carePlanId)
    .order('logged_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(dbToObservation);
};


// ─── Internal helpers ──────────────────────────────────────────

/**
 * Throws if the given version is not a draft. Used to guard
 * mutations that shouldn't touch published or archived versions.
 */
async function assertVersionIsDraft(versionId) {
  const { data, error } = await supabase
    .from('care_plan_versions')
    .select('id, status')
    .eq('id', versionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('version not found');
  if (data.status !== 'draft') {
    throw new Error(`cannot modify tasks on a ${data.status} version`);
  }
}


/**
 * Deep-equal-ish comparison for primitives, arrays, and plain objects.
 * Good enough for our field-patch change detection (we don't store
 * Dates, functions, or class instances in section data).
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameValue(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!sameValue(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// Exported for testing.
export const __testables__ = { sameValue };
