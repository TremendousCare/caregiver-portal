// Phase 0.5 PR B — useRevertAgent hook.
//
// Wraps the revert_agent_to_version_v1 RPC for the
// RevertConfirmationDialog. Returns:
//   { reverting, error, revert({ agentId, targetVersion, changeSummary })
//     → { success, newVersion?, error? } }

import { useCallback, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { revertAgentToVersion } from './queries';

export function useRevertAgent() {
  const [reverting, setReverting] = useState(false);
  const [error, setError]         = useState(null);

  const revert = useCallback(async ({ agentId, targetVersion, changeSummary }) => {
    setReverting(true);
    setError(null);
    try {
      const newVersion = await revertAgentToVersion(supabase, {
        agentId, targetVersion, changeSummary,
      });
      return { success: true, newVersion };
    } catch (err) {
      setError(err);
      return { success: false, error: err };
    } finally {
      setReverting(false);
    }
  }, []);

  return { reverting, error, revert };
}
