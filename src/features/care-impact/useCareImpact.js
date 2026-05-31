// ─── Care Impact — data hook ───────────────────────────────────
//
// Loads care_signals + client_health_events for the selected range and
// returns the aggregated metrics. Mirrors useAgentMetrics: the hook owns
// fetching + loading/error state; all math is in the pure aggregation
// module so it stays testable.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchCareImpactData } from './careImpactQueries';
import { getTimeRange, impactSummary, monthlyOutcomeTrend } from './careImpactAggregation';

export function useCareImpact(rangeId) {
  const range = getTimeRange(rangeId);
  const [raw, setRaw] = useState({ signals: [], events: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [available, setAvailable] = useState(true);

  const sinceIso = useMemo(
    () => new Date(Date.now() - range.days * 86_400_000).toISOString(),
    [range.days],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCareImpactData(sinceIso);
      setRaw(data);
      setAvailable(true);
    } catch (err) {
      // Tables not deployed yet / RLS denies — surface gracefully.
      console.warn('[useCareImpact] load failed', err);
      setError(err);
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [sinceIso]);

  useEffect(() => {
    load();
  }, [load]);

  const window = useMemo(
    () => ({ startMs: new Date(sinceIso).getTime(), endMs: Date.now() }),
    [sinceIso],
  );

  const summary = useMemo(
    () => impactSummary(raw.signals, raw.events, window),
    [raw, window],
  );
  const trend = useMemo(
    () => monthlyOutcomeTrend(raw.events, window),
    [raw.events, window],
  );

  return { range, loading, error, available, summary, trend, raw, reload: load };
}
