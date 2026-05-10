// Phase 0.5 PR A — agents-list hook.
//
// Loads every agent for the current org and exposes a toggle handler
// for kill_switch / shadow_mode. The hook owns the optimistic update:
// the toggle flips the local state immediately, calls the RPC, and
// reverts on error. This matches the locked spec §3.1: toggles are
// "saved immediately, no confirmation dialog" with toast on failure.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { loadAgents, toggleAgentFlag } from './queries';

export function useAgents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await loadAgents(supabase);
      setAgents(rows);
    } catch (err) {
      console.error('Failed to load agents:', err);
      setError(err);
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Optimistic toggle: update local state, call RPC, revert on failure.
  // savingId tracks which agent is mid-flight so the row's spinner
  // shows while the network call runs.
  const handleToggle = useCallback(async (agentId, flag, nextValue) => {
    // Phase 1.3 added 'read_only_mode' alongside the original two flags.
    if (
      flag !== 'kill_switch' &&
      flag !== 'shadow_mode' &&
      flag !== 'read_only_mode'
    ) {
      throw new Error(`useAgents.handleToggle: invalid flag "${flag}"`);
    }
    setSavingId(`${agentId}:${flag}`);

    // Snapshot prior state for rollback on failure.
    let priorValue;
    setAgents(prev => prev.map(a => {
      if (a.id !== agentId) return a;
      priorValue = a[flag];
      return { ...a, [flag]: nextValue };
    }));

    try {
      const { newValue, auditFailed } = await toggleAgentFlag(supabase, {
        agentId,
        flag,
        value: nextValue,
      });
      // Reconcile against the server's authoritative answer.
      setAgents(prev => prev.map(a => (
        a.id === agentId ? { ...a, [flag]: newValue } : a
      )));
      // Phase 1.1.B: surface audit-write failures but don't fail
      // the toggle — the toggle itself landed. Hook caller logs
      // a console warning so we notice gaps in the audit chain.
      if (auditFailed) {
        console.warn(`[useAgents] toggle_agent_flag_v1 succeeded but audit row write failed (chain gap on ${agentId})`);
      }
      return { success: true, auditFailed };
    } catch (err) {
      console.error(`Failed to toggle ${flag} on agent ${agentId}:`, err);
      // Revert local state.
      setAgents(prev => prev.map(a => (
        a.id === agentId ? { ...a, [flag]: priorValue } : a
      )));
      return { success: false, error: err };
    } finally {
      setSavingId(null);
    }
  }, []);

  return {
    agents,
    loading,
    error,
    savingId,
    refresh,
    handleToggle,
  };
}
