// Phase 1.4 — Data hook for the agent metrics dashboard.
//
// Single source of truth for what the page renders. Each invocation
// returns:
//   { loading, error, agents, agent, actions, outcomes, refresh }
//
// Re-fetches whenever `agentId` or `windowId` change.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import {
  loadAgentsForMetrics,
  loadAgentActions,
  loadActionOutcomes,
  windowStartIso,
} from './queries';
import { getTimeWindow } from './metricsAggregation';

export function useAgentMetrics({ agentId, windowId }) {
  const [agents, setAgents] = useState([]);
  const [actions, setActions] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  const window = useMemo(() => getTimeWindow(windowId), [windowId]);

  // Load agents once (stable across window/agent changes).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadAgentsForMetrics(supabase);
        if (!cancelled) setAgents(rows);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load actions + outcomes whenever agent or window changes, or refresh
  // is called.
  useEffect(() => {
    if (!agentId) {
      setActions([]);
      setOutcomes([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const sinceIso = windowStartIso(window.days);
    Promise.all([
      loadAgentActions(supabase, { agentId, sinceIso }),
      loadActionOutcomes(supabase, { agentId, sinceIso }),
    ])
      .then(([a, o]) => {
        if (!cancelled) {
          setActions(a);
          setOutcomes(o);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [agentId, window.days, tick]);

  const agent = useMemo(
    () => agents.find((a) => a.id === agentId) || null,
    [agents, agentId],
  );

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { loading, error, agents, agent, actions, outcomes, refresh, window };
}
