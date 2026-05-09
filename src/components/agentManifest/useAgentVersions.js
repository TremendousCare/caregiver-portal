// Phase 0.5 PR A — agent-version-history hook.
//
// Loads `agent_versions` for one agent_id, ordered newest first.
// Re-fetches when agentId changes (e.g. when the user expands a
// different row in the list).

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { loadAgentVersions } from './queries';

export function useAgentVersions(agentId) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setVersions([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await loadAgentVersions(supabase, agentId);
      setVersions(rows);
    } catch (err) {
      console.error('Failed to load agent versions:', err);
      setError(err);
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { versions, loading, error, refresh };
}
