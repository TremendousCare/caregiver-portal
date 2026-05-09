// Phase 0.5 PR B — useUpdateAgent hook.
//
// Wraps the update_agent_manifest_v1 RPC for the SaveConfirmationDialog.
// Returns:
//   { saving, error, save({ agentId, expectedVersion, updates,
//     changeSummary }) → { success, newVersion?, error?, conflict? } }
//
// Conflict (P0001) is surfaced as conflict=true so the caller can
// render the reload-and-retry dialog without first inspecting the error
// shape.

import { useCallback, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { updateAgentManifest, isVersionConflict } from './queries';

export function useUpdateAgent() {
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const save = useCallback(async ({ agentId, expectedVersion, updates, changeSummary }) => {
    setSaving(true);
    setError(null);
    try {
      const newVersion = await updateAgentManifest(supabase, {
        agentId, expectedVersion, updates, changeSummary,
      });
      return { success: true, newVersion };
    } catch (err) {
      setError(err);
      const conflict = isVersionConflict(err);
      return { success: false, error: err, conflict };
    } finally {
      setSaving(false);
    }
  }, []);

  return { saving, error, save };
}
