// Phase 1.5 — Data hook for the retrospective grading page.
//
// Loads the agent list once, then re-fetches (suggestions + grades)
// whenever any filter changes. `gradeOne` and `gradeMany` call the
// SECURITY DEFINER RPC and optimistically merge the result into the
// in-memory grade map so the UI reflects the change instantly
// (without a re-fetch round-trip).

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import {
  loadAgentsForGrading,
  loadSuggestions,
  loadGrades,
  upsertGrade,
  sinceIsoForDays,
} from './queries';

export function useAgentGrading({
  agentId,
  sourceType,
  actionType,
  windowDays,
  limit,
}) {
  const [agents, setAgents] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [grades, setGrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  // Load agents once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadAgentsForGrading(supabase);
        if (!cancelled) setAgents(rows);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load suggestions + grades whenever filters change or refresh fires.
  useEffect(() => {
    if (!agentId) {
      setSuggestions([]);
      setGrades([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const sinceIso = sinceIsoForDays(windowDays);
    (async () => {
      try {
        const sugs = await loadSuggestions(supabase, {
          agentId,
          sourceType: sourceType || null,
          actionType: actionType || null,
          sinceIso,
          limit,
        });
        const ids = sugs.map((s) => s.id);
        const grds = ids.length > 0 ? await loadGrades(supabase, { suggestionIds: ids }) : [];
        if (!cancelled) {
          setSuggestions(sugs);
          setGrades(grds);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [agentId, sourceType, actionType, windowDays, limit, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const gradeOne = useCallback(async ({ suggestionId, verdict, rationale, gradedBy }) => {
    const newId = await upsertGrade(supabase, { suggestionId, verdict, rationale });
    // Optimistically merge the new grade in. The next refresh will
    // resync with the server (e.g. pick up the canonical graded_at).
    setGrades((prev) => [
      {
        id: newId,
        suggestion_id: suggestionId,
        verdict,
        rationale: rationale || null,
        graded_by: gradedBy || 'user',
        graded_at: new Date().toISOString(),
      },
      ...prev,
    ]);
    return newId;
  }, []);

  const gradeMany = useCallback(async ({ suggestionIds, verdict, rationale, gradedBy }) => {
    // Sequential to keep the RPC error path simple and surface the
    // first failure clearly. The set sizes here are small (operator
    // is grading a screen of suggestions, not millions).
    const results = [];
    for (const sid of suggestionIds) {
      // eslint-disable-next-line no-await-in-loop
      const id = await upsertGrade(supabase, {
        suggestionId: sid,
        verdict,
        rationale,
      });
      results.push({ suggestionId: sid, id });
    }
    const nowIso = new Date().toISOString();
    setGrades((prev) => [
      ...results.map((r) => ({
        id: r.id,
        suggestion_id: r.suggestionId,
        verdict,
        rationale: rationale || null,
        graded_by: gradedBy || 'user',
        graded_at: nowIso,
      })),
      ...prev,
    ]);
    return results;
  }, []);

  const agent = useMemo(
    () => agents.find((a) => a.id === agentId) || null,
    [agents, agentId],
  );

  return {
    loading, error,
    agents, agent,
    suggestions, grades,
    refresh, gradeOne, gradeMany,
  };
}
