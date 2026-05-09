// Phase 0.5 — agent-version-history hook.
//
// Loads `agent_versions` for one agent_id, ordered newest first.
// Re-fetches when agentId OR refreshKey changes. The refreshKey
// argument lets parents force a re-fetch after a save / revert that
// keeps the same agentId but moves the agent forward to a new
// version (Codex P2 on PR #300: previously the history would show
// stale data until the row was collapsed and re-expanded). The
// current version number is the natural refresh signal.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { loadAgentVersions } from './queries';

export function useAgentVersions(agentId, refreshKey = null) {
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

  // Fetch on mount, on agentId change, and any time refreshKey moves
  // (used by AgentVersionHistory to re-fetch after a save bumps the
  // current version even though the agentId is unchanged).
  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  return { versions, loading, error, refresh };
}
