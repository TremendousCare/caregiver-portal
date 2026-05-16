/**
 * Phase 1.6.2 — callContext read helpers.
 *
 * Five small functions in `_shared/operations/agentRuntime/callContext.ts`:
 *   * loadCallSessionContext      — load row + matched-entity metadata
 *   * fetchCallTranscriptContext  — transcript text formatted as a prompt block
 *   * fetchCallTaxonomyContext    — call_taxonomy rows grouped by axis
 *   * fetchEntityMemoriesForCall  — context_memory rows for the matched entity
 *   * fetchCallEntityIdentity     — one-line entity identification block
 *
 * The helpers are designed to be reusable by future agents
 * (intake_analyst, scheduling_analyst, the chat assembler's
 * callContext layer in Phase 1.6.4). They tolerate failure by
 * returning an empty string and never throw — these tests pin both
 * the happy path and the silent-failure contract.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  loadCallSessionContext,
  fetchCallTranscriptContext,
  fetchCallTaxonomyContext,
  fetchEntityMemoriesForCall,
  fetchCallEntityIdentity,
} from '../../../supabase/functions/_shared/operations/agentRuntime/callContext.ts';

// ─── Generic chainable supabase mock ───
function makeMaybeSingleMock(result) {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(function () { return this; }),
      maybeSingle: vi.fn(async () => result),
    })),
  };
}

function makeOrderableSelectMock(result) {
  const orderChain = vi.fn(function () { return this; });
  const limitChain = vi.fn(async () => result);
  const isChain = vi.fn(function () { return this; });
  return {
    select: vi.fn(() => ({
      eq: vi.fn(function () { return this; }),
      is: isChain,
      order: orderChain,
      limit: limitChain,
      // Thenable so a chain that ends without explicit limit() still resolves.
      then: (resolve) => resolve(result),
    })),
    _orderChain: orderChain,
  };
}

// ═══════════════════════════════════════════════════════════════
// loadCallSessionContext
// ═══════════════════════════════════════════════════════════════

describe('loadCallSessionContext', () => {
  it('returns null when callSessionId is empty', async () => {
    const out = await loadCallSessionContext({}, '');
    expect(out).toBeNull();
  });

  it('returns null when supabase returns no row', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({ data: null, error: null })),
    };
    const out = await loadCallSessionContext(supabase, 'cs-1');
    expect(out).toBeNull();
  });

  it('returns the row on the happy path', async () => {
    const row = {
      id: 'cs-1',
      org_id: 'org-1',
      matched_entity_type: 'caregiver',
      matched_entity_id:   'cg-1',
      recording_id:        'rec-1',
      direction:           'inbound',
      from_e164:           '+15551234567',
      to_e164:             '+15559876543',
      ended_at:            '2026-05-16T01:00:00Z',
      duration_seconds:    300,
    };
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({ data: row, error: null })),
    };
    const out = await loadCallSessionContext(supabase, 'cs-1');
    expect(out).toEqual(row);
    expect(supabase.from).toHaveBeenCalledWith('call_sessions');
  });

  it('returns null when supabase returns an error', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({ data: null, error: { message: 'boom' } })),
    };
    const out = await loadCallSessionContext(supabase, 'cs-1');
    expect(out).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// fetchCallTranscriptContext
// ═══════════════════════════════════════════════════════════════

describe('fetchCallTranscriptContext', () => {
  it('returns empty string when recordingId is null', async () => {
    const out = await fetchCallTranscriptContext({}, null);
    expect(out).toBe('');
  });

  it('returns empty string when no transcript row exists', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({ data: null, error: null })),
    };
    const out = await fetchCallTranscriptContext(supabase, 'rec-1');
    expect(out).toBe('');
  });

  it('formats the transcript block with duration and recording id', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({
        data: { transcript: 'Hello, this is Maria.', duration_seconds: 125 },
        error: null,
      })),
    };
    const out = await fetchCallTranscriptContext(supabase, 'rec-1');
    expect(out).toContain('## Transcript');
    expect(out).toContain('rec-1');
    expect(out).toContain('2m 5s');
    expect(out).toContain('Hello, this is Maria.');
  });

  it('uses "unknown length" when duration_seconds is null', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({
        data: { transcript: 'short call', duration_seconds: null },
        error: null,
      })),
    };
    const out = await fetchCallTranscriptContext(supabase, 'rec-1');
    expect(out).toContain('unknown length');
  });

  it('returns empty string when transcript text is blank', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({
        data: { transcript: '   ', duration_seconds: 100 },
        error: null,
      })),
    };
    const out = await fetchCallTranscriptContext(supabase, 'rec-1');
    expect(out).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// fetchCallTaxonomyContext
// ═══════════════════════════════════════════════════════════════

describe('fetchCallTaxonomyContext', () => {
  it('returns empty string when orgId is missing', async () => {
    const out = await fetchCallTaxonomyContext({}, '');
    expect(out).toBe('');
  });

  it('groups rows by axis and emits a prompt block', async () => {
    const rows = [
      { axis: 'call_type', slug: 'recruiting',   label: 'Recruiting',  description: 'Outreach', sort_order: 10 },
      { axis: 'call_type', slug: 'payroll',      label: 'Payroll',     description: null,       sort_order: 20 },
      { axis: 'red_flag',  slug: 'safety_issue', label: 'Safety issue', description: 'Risk',    sort_order: 10 },
    ];
    const supabase = {
      from: vi.fn(() => makeOrderableSelectMock({ data: rows, error: null })),
    };
    const out = await fetchCallTaxonomyContext(supabase, 'org-1');
    expect(out).toContain('## Taxonomy');
    expect(out).toContain('Call types');
    expect(out).toContain('- recruiting: Recruiting — Outreach');
    expect(out).toContain('- payroll: Payroll');
    expect(out).toContain('Red flag categories');
    expect(out).toContain('- safety_issue: Safety issue — Risk');
  });

  it('shows "(none configured)" when one axis has zero rows', async () => {
    const rows = [
      { axis: 'call_type', slug: 'recruiting', label: 'Recruiting', description: null, sort_order: 10 },
    ];
    const supabase = {
      from: vi.fn(() => makeOrderableSelectMock({ data: rows, error: null })),
    };
    const out = await fetchCallTaxonomyContext(supabase, 'org-1');
    expect(out).toContain('Red flag categories');
    expect(out).toContain('(none configured)');
  });

  it('returns empty string when supabase errors', async () => {
    const supabase = {
      from: vi.fn(() => makeOrderableSelectMock({ data: null, error: { message: 'boom' } })),
    };
    const out = await fetchCallTaxonomyContext(supabase, 'org-1');
    expect(out).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// fetchEntityMemoriesForCall
// ═══════════════════════════════════════════════════════════════

describe('fetchEntityMemoriesForCall', () => {
  it('returns empty string when entityType or entityId is null', async () => {
    expect(await fetchEntityMemoriesForCall({}, null, 'x')).toBe('');
    expect(await fetchEntityMemoriesForCall({}, 'caregiver', null)).toBe('');
  });

  it('returns empty string when no memories exist', async () => {
    const supabase = {
      from: vi.fn(() => makeOrderableSelectMock({ data: [], error: null })),
    };
    const out = await fetchEntityMemoriesForCall(supabase, 'caregiver', 'cg-1');
    expect(out).toBe('');
  });

  it('formats memories with confidence + source + tags', async () => {
    const rows = [
      {
        memory_type: 'semantic',
        content:     'Prefers morning shifts.',
        confidence:  0.85,
        source:      'ai_observation',
        tags:        ['preference', 'scheduling'],
        created_at:  '2026-05-15T01:00:00Z',
      },
    ];
    const supabase = {
      from: vi.fn(() => makeOrderableSelectMock({ data: rows, error: null })),
    };
    const out = await fetchEntityMemoriesForCall(supabase, 'caregiver', 'cg-1');
    expect(out).toContain('## Recent memories');
    expect(out).toContain('Prefers morning shifts.');
    expect(out).toContain('(conf 0.85)');
    expect(out).toContain('[ai_observation]');
    expect(out).toContain('#preference #scheduling');
  });
});

// ═══════════════════════════════════════════════════════════════
// fetchCallEntityIdentity
// ═══════════════════════════════════════════════════════════════

describe('fetchCallEntityIdentity', () => {
  it('returns empty string when entity is null', async () => {
    expect(await fetchCallEntityIdentity({}, null, 'x')).toBe('');
    expect(await fetchCallEntityIdentity({}, 'caregiver', null)).toBe('');
  });

  it('queries the right table for the entity type', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({
        data: { first_name: 'Maria', last_name: 'Garcia' },
        error: null,
      })),
    };
    const out = await fetchCallEntityIdentity(supabase, 'caregiver', 'cg-1');
    expect(supabase.from).toHaveBeenCalledWith('caregivers');
    expect(out).toContain('Type: caregiver');
    expect(out).toContain('Id:   cg-1');
    expect(out).toContain('Name: Maria Garcia');
  });

  it('queries clients table for client entity', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({
        data: { first_name: 'John', last_name: 'Smith' },
        error: null,
      })),
    };
    await fetchCallEntityIdentity(supabase, 'client', 'cl-1');
    expect(supabase.from).toHaveBeenCalledWith('clients');
  });

  it('handles missing names gracefully', async () => {
    const supabase = {
      from: vi.fn(() => makeMaybeSingleMock({
        data: { first_name: null, last_name: null },
        error: null,
      })),
    };
    const out = await fetchCallEntityIdentity(supabase, 'caregiver', 'cg-1');
    expect(out).toContain('(unnamed)');
  });
});
