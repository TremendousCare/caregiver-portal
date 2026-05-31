// Phase 1.5 — Data hook for the retrospective grading page.
//
// Loads the agent list once, then re-fetches (suggestions + grades)
// whenever any filter changes. `gradeOne` and `gradeMany` call the
// SECURITY DEFINER RPC and optimistically merge the result into the
// in-memory grade map so the UI reflects the change instantly
// (without a re-fetch round-trip).
//
// `ungradedOnly` pagination (Codex P2 #r3226254388 fix): a flat
// LIMIT-based fetch hides older ungraded rows behind already-graded
// newer rows. When `ungradedOnly` is true `fetchSuggestionsAndGrades`
// pages backward through `created_at` until it has at least `limit`
// ungraded suggestions or it has scanned `MAX_UNGRADED_PAGES * limit`
// rows. The summary breakdown reflects everything scanned, so the
// operator can see how much grading work remains in the window.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import {
  loadAgentsForGrading,
  loadSuggestions,
  loadGrades,
  loadEntityRecords,
  upsertGrade,
  sinceIsoForDays,
} from './queries';
import {
  latestGradeBySuggestion,
  collectEntityIds,
  buildEntityNameMap,
  attachEntityNames,
} from './gradingHelpers';

export const MAX_UNGRADED_PAGES = 5;

/**
 * Pure-ish async fetcher: handles the single-page (ungradedOnly=false)
 * path AND the cursor-paginated path. Dependency-injected so unit
 * tests can stub the queries module without renderHook.
 */
export async function fetchSuggestionsAndGrades({
  agentId, sourceType, actionType, sinceIso, limit, ungradedOnly,
  loaders,
  maxPages = MAX_UNGRADED_PAGES,
}) {
  const accumulated = [];
  const accumulatedGrades = [];
  let beforeIso = null;
  const pageCap = ungradedOnly ? maxPages : 1;

  for (let page = 0; page < pageCap; page++) {
    const sugs = await loaders.loadSuggestions({
      agentId,
      sourceType: sourceType || null,
      actionType: actionType || null,
      sinceIso,
      beforeIso,
      limit,
    });
    if (!sugs || sugs.length === 0) break;
    accumulated.push(...sugs);

    if (ungradedOnly) {
      const ids = sugs.map((s) => s.id);
      const pageGrades = await loaders.loadGrades({ suggestionIds: ids });
      accumulatedGrades.push(...pageGrades);
      const latest = latestGradeBySuggestion(accumulatedGrades);
      const ungradedSoFar = accumulated.reduce(
        (n, s) => (latest.has(s.id) ? n : n + 1),
        0,
      );
      if (ungradedSoFar >= limit) break;
      beforeIso = sugs[sugs.length - 1].created_at;
    } else {
      break;
    }
  }

  // For the non-paginated path we still need to load grades so the
  // per-row badges and summary breakdown are accurate.
  const grades = ungradedOnly
    ? accumulatedGrades
    : (accumulated.length > 0
      ? await loaders.loadGrades({ suggestionIds: accumulated.map((s) => s.id) })
      : []);

  return { suggestions: accumulated, grades };
}

export function useAgentGrading({
  agentId,
  sourceType,
  actionType,
  windowDays,
  limit,
  ungradedOnly = false,
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
        const { suggestions: sugs, grades: grds } = await fetchSuggestionsAndGrades({
          agentId, sourceType, actionType, sinceIso, limit, ungradedOnly,
          loaders: {
            loadSuggestions: (params) => loadSuggestions(supabase, params),
            loadGrades: (params) => loadGrades(supabase, params),
          },
        });

        // Resolve display names for rows the writer left unnamed
        // (call_analyst always leaves entity_name NULL). Best-effort:
        // a lookup failure falls back to the raw rows so the page still
        // renders and stays gradeable.
        let named = sugs;
        try {
          const { caregiverIds, clientIds } = collectEntityIds(sugs);
          if (caregiverIds.length > 0 || clientIds.length > 0) {
            const records = await loadEntityRecords(supabase, { caregiverIds, clientIds });
            named = attachEntityNames(sugs, buildEntityNameMap(records));
          }
        } catch {
          named = sugs;
        }

        if (!cancelled) {
          setSuggestions(named);
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
  }, [agentId, sourceType, actionType, windowDays, limit, ungradedOnly, tick]);

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
