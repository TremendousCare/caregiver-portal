/**
 * Phase 1.5 — fetchSuggestionsAndGrades pagination loop.
 *
 * Codex P2 #r3226254388: when an operator turns on "Ungraded only"
 * and every row in the first 200-row page is already graded, the
 * page should NOT show "no ungraded suggestions" — older ungraded
 * rows still exist beyond the LIMIT. The fetcher walks `created_at`
 * backward via the `beforeIso` cursor until it has at least `limit`
 * ungraded rows or it has scanned `MAX_UNGRADED_PAGES * limit` rows.
 *
 * The hook calls this pure-ish async function with dependency-
 * injected loaders, so we test it without React.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  fetchSuggestionsAndGrades,
  MAX_UNGRADED_PAGES,
} from '../../components/agentGrading/useAgentGrading';

const AGENT_ID = 'agent-1';

function makeSuggestion(id, createdAt) {
  return {
    id,
    agent_id: AGENT_ID,
    source_type: 'proactive',
    action_type: 'send_sms',
    title: `Suggestion ${id}`,
    autonomy_level: 'L1',
    status: 'pending',
    created_at: createdAt,
  };
}

function makeGrade(suggestionId, gradedAt = '2026-05-12T10:00:00Z') {
  return {
    id: `g-${suggestionId}`,
    suggestion_id: suggestionId,
    verdict: 'good',
    graded_at: gradedAt,
  };
}

function makeLoaders({ pages, gradesByPage }) {
  let pageIdx = 0;
  const loadSuggestions = vi.fn(async ({ beforeIso }) => {
    if (pageIdx === 0) {
      // First call: beforeIso must be null.
      expect(beforeIso).toBeNull();
    }
    const page = pages[pageIdx] || [];
    pageIdx++;
    return page;
  });
  let gradeIdx = 0;
  const loadGrades = vi.fn(async () => {
    const g = gradesByPage[gradeIdx] || [];
    gradeIdx++;
    return g;
  });
  return { loadSuggestions, loadGrades };
}

describe('fetchSuggestionsAndGrades — single-page when ungradedOnly is false', () => {
  it('makes exactly one loadSuggestions call and one loadGrades call', async () => {
    const sugs = Array.from({ length: 10 }, (_, i) =>
      makeSuggestion(`s${i}`, `2026-05-12T10:00:0${i}Z`),
    );
    const loaders = {
      loadSuggestions: vi.fn(async () => sugs),
      loadGrades: vi.fn(async () => []),
    };

    const out = await fetchSuggestionsAndGrades({
      agentId: AGENT_ID, sourceType: '', actionType: '', sinceIso: null,
      limit: 200, ungradedOnly: false, loaders,
    });

    expect(loaders.loadSuggestions).toHaveBeenCalledTimes(1);
    expect(loaders.loadSuggestions.mock.calls[0][0].beforeIso).toBeNull();
    expect(loaders.loadGrades).toHaveBeenCalledTimes(1);
    expect(out.suggestions).toHaveLength(10);
  });

  it('returns empty suggestions and skips loadGrades when no rows', async () => {
    const loaders = {
      loadSuggestions: vi.fn(async () => []),
      loadGrades: vi.fn(),
    };
    const out = await fetchSuggestionsAndGrades({
      agentId: AGENT_ID, sourceType: '', actionType: '', sinceIso: null,
      limit: 50, ungradedOnly: false, loaders,
    });
    expect(out.suggestions).toEqual([]);
    expect(out.grades).toEqual([]);
    expect(loaders.loadGrades).not.toHaveBeenCalled();
  });
});

describe('fetchSuggestionsAndGrades — paginates when ungradedOnly is true', () => {
  it('walks beforeIso backward when first page is fully graded', async () => {
    const page1 = Array.from({ length: 5 }, (_, i) =>
      makeSuggestion(`p1-${i}`, `2026-05-12T1${i}:00:00Z`),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeSuggestion(`p2-${i}`, `2026-05-11T1${i}:00:00Z`),
    );
    const loaders = makeLoaders({
      pages: [page1, page2],
      gradesByPage: [page1.map((s) => makeGrade(s.id)), []],
    });

    const out = await fetchSuggestionsAndGrades({
      agentId: AGENT_ID, sourceType: '', actionType: '', sinceIso: null,
      limit: 5, ungradedOnly: true, loaders,
    });

    expect(loaders.loadSuggestions).toHaveBeenCalledTimes(2);
    // Second call uses oldest created_at from page 1 as cursor.
    expect(loaders.loadSuggestions.mock.calls[1][0].beforeIso)
      .toBe(page1[page1.length - 1].created_at);
    // Both pages accumulated so the summary breakdown reflects both.
    expect(out.suggestions).toHaveLength(10);
    // 5 grades from page 1, 0 from page 2.
    expect(out.grades).toHaveLength(5);
  });

  it('stops once enough ungraded rows are found', async () => {
    const page1 = Array.from({ length: 5 }, (_, i) =>
      makeSuggestion(`p1-${i}`, `2026-05-12T1${i}:00:00Z`),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeSuggestion(`p2-${i}`, `2026-05-11T1${i}:00:00Z`),
    );
    const loaders = makeLoaders({
      pages: [page1, page2],
      // Page 1: 3 ungraded (under limit=5, keep going).
      // Page 2: 5 ungraded (cumulative 8 ≥ 5, stop).
      gradesByPage: [[makeGrade('p1-0'), makeGrade('p1-1')], []],
    });

    await fetchSuggestionsAndGrades({
      agentId: AGENT_ID, sourceType: '', actionType: '', sinceIso: null,
      limit: 5, ungradedOnly: true, loaders,
    });

    expect(loaders.loadSuggestions).toHaveBeenCalledTimes(2);
  });

  it('caps scanning at MAX_UNGRADED_PAGES even if no ungraded ever found', async () => {
    let cursor = Date.parse('2026-05-12T10:00:00Z');
    const loaders = {
      loadSuggestions: vi.fn(async () => {
        cursor -= 60_000;
        return Array.from({ length: 5 }, (_, i) =>
          makeSuggestion(`s-${cursor}-${i}`, new Date(cursor - i * 1000).toISOString()),
        );
      }),
      loadGrades: vi.fn(async ({ suggestionIds }) =>
        suggestionIds.map((id) => makeGrade(id)),
      ),
    };

    await fetchSuggestionsAndGrades({
      agentId: AGENT_ID, sourceType: '', actionType: '', sinceIso: null,
      limit: 5, ungradedOnly: true, loaders,
    });

    expect(loaders.loadSuggestions).toHaveBeenCalledTimes(MAX_UNGRADED_PAGES);
    expect(loaders.loadGrades).toHaveBeenCalledTimes(MAX_UNGRADED_PAGES);
  });

  it('stops early when a page returns zero rows (end of data)', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) =>
      makeSuggestion(`p1-${i}`, `2026-05-12T1${i}:00:00Z`),
    );
    const loaders = makeLoaders({
      pages: [page1, []],
      gradesByPage: [page1.map((s) => makeGrade(s.id))],
    });

    await fetchSuggestionsAndGrades({
      agentId: AGENT_ID, sourceType: '', actionType: '', sinceIso: null,
      limit: 50, ungradedOnly: true, loaders,
    });

    // Page 1 then page 2 (empty) — loop exits without a third call.
    expect(loaders.loadSuggestions).toHaveBeenCalledTimes(2);
  });

  it('respects maxPages override (for tighter test budgets)', async () => {
    let cursor = Date.parse('2026-05-12T10:00:00Z');
    const loaders = {
      loadSuggestions: vi.fn(async () => {
        cursor -= 60_000;
        return Array.from({ length: 5 }, (_, i) =>
          makeSuggestion(`s-${cursor}-${i}`, new Date(cursor - i * 1000).toISOString()),
        );
      }),
      loadGrades: vi.fn(async ({ suggestionIds }) =>
        suggestionIds.map((id) => makeGrade(id)),
      ),
    };

    await fetchSuggestionsAndGrades({
      agentId: AGENT_ID, sourceType: '', actionType: '', sinceIso: null,
      limit: 5, ungradedOnly: true, loaders, maxPages: 2,
    });

    expect(loaders.loadSuggestions).toHaveBeenCalledTimes(2);
  });
});
