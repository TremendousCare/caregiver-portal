// Load helpers for system_default_tasks (migration 20260524000000).
//
// System defaults are universal recurring tasks (caregiver break,
// caregiver lunch, hand hygiene) that appear on every shift's checklist
// regardless of the client. They live in their own org-scoped table and
// are merged into the per-shift task list at load time.
//
// This module is the read-only counterpart. Editing (admin settings UI)
// is intentionally out of scope for the first PR — see SAAS retrofit
// guidance: an admin settings panel will come in a focused follow-up.

import { supabase } from './supabase';

// Sentinel that lets the runtime union code (and the click handler
// in CarePlanChecklist) distinguish system-default rows from real
// care_plan_tasks rows once they're sitting side-by-side in the same
// array. Kept as a constant rather than a magic string so a typo
// elsewhere fails noisily.
export const SYSTEM_DEFAULT_SOURCE = 'system_default';

// ─── Mapper ───────────────────────────────────────────────────
// Match dbToCarePlanTask shape so the existing shift-task filter,
// grouper, and renderer all consume system defaults without special
// casing. The two extra fields (__source, isActive) are additive.

export function dbToSystemDefaultTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    versionId: null,                // system defaults aren't tied to a version
    category: row.category,
    taskName: row.task_name,
    description: row.description ?? null,
    shifts: Array.isArray(row.shifts) ? row.shifts : ['all'],
    daysOfWeek: Array.isArray(row.days_of_week) ? row.days_of_week : [],
    priority: row.priority || 'standard',
    safetyNotes: row.safety_notes ?? null,
    sortOrder: row.sort_order ?? 0,
    isActive: row.is_active !== false,
    __source: SYSTEM_DEFAULT_SOURCE,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Read ─────────────────────────────────────────────────────

/**
 * Load every active system default for the caller's org. RLS scopes
 * the result to the JWT org_id automatically, so the caller does not
 * need to pass an org id.
 *
 * Returns [] when Supabase is not configured (dev/test) or on any
 * error — system defaults are a nice-to-have on the checklist, not a
 * blocker, so a failure here should never cause the checklist to fail
 * to render.
 */
export async function loadActiveSystemDefaults(client = supabase) {
  // No client = "Supabase not configured" — return empty rather than
  // throw so the checklist still renders in dev/test.
  if (!client) return [];
  const { data, error } = await client
    .from('system_default_tasks')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) {
    console.warn('loadActiveSystemDefaults failed:', error.message);
    return [];
  }
  return (data ?? []).map(dbToSystemDefaultTask);
}

/**
 * True if the given task object came from system_default_tasks.
 * Pure — exported so CarePlanChecklist can decide which observation
 * column to write without re-implementing the source check inline.
 */
export function isSystemDefaultTask(task) {
  return !!task && task.__source === SYSTEM_DEFAULT_SOURCE;
}
