import { supabase, isSupabaseConfigured } from '../../lib/supabase';

// ═══════════════════════════════════════════════════════════════
// Snapshot client
//
// Thin wrapper around the `care-plan-snapshot` edge function.
// Phase 2b ships the contract + stub; Phase 3 swaps the server-side
// generator for a real Claude call without any frontend changes.
//
// Feature flag: VITE_FEATURE_CARE_PLAN_SNAPSHOT_AI (string 'true').
// When off, the CarePlanPanel hides the "Regenerate snapshot" button.
// ═══════════════════════════════════════════════════════════════

export const SNAPSHOT_FEATURE_FLAG =
  import.meta.env?.VITE_FEATURE_CARE_PLAN_SNAPSHOT_AI === 'true';


/**
 * Regenerate (or lazily fetch) the AI snapshot for a care plan version.
 *
 * @param {string} versionId
 * @param {{ regenerate?: boolean }} options
 * @returns {Promise<{ narrative: string, cached: boolean, model: string, generatedAt: string|null }>}
 */
export async function regenerateSnapshot(versionId, { regenerate = false } = {}) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }
  if (!versionId) throw new Error('versionId is required');

  const { data, error } = await supabase.functions.invoke('care-plan-snapshot', {
    body: { versionId, regenerate },
  });

  if (error) {
    throw new Error(error.message || 'Snapshot function call failed');
  }
  if (!data) {
    throw new Error('Snapshot function returned no data');
  }
  return data;
}
