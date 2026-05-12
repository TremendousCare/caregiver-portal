/**
 * Phase 1.5 — grading queries contract.
 *
 * Locks the RPC name + parameter shape the SECURITY DEFINER write
 * path expects. If a future refactor breaks the contract, this test
 * catches it before deploy.
 */

import { describe, it, expect, vi } from 'vitest';

import { upsertGrade } from '../../components/agentGrading/queries';

describe('upsertGrade', () => {
  it('calls upsert_ai_suggestion_grade_v1 with p_suggestion_id / p_verdict / p_rationale', async () => {
    const rpc = vi.fn(async () => ({ data: 'grade-uuid', error: null }));
    const supabase = { rpc };
    const id = await upsertGrade(supabase, {
      suggestionId: 'sug-1',
      verdict: 'good',
      rationale: 'Looks right',
    });
    expect(id).toBe('grade-uuid');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('upsert_ai_suggestion_grade_v1', {
      p_suggestion_id: 'sug-1',
      p_verdict: 'good',
      p_rationale: 'Looks right',
    });
  });

  it('passes null when rationale is an empty string', async () => {
    const rpc = vi.fn(async () => ({ data: 'g', error: null }));
    await upsertGrade({ rpc }, { suggestionId: 's', verdict: 'bad', rationale: '' });
    expect(rpc.mock.calls[0][1].p_rationale).toBeNull();
  });

  it('rethrows on RPC error', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'denied' } }));
    await expect(
      upsertGrade({ rpc }, { suggestionId: 's', verdict: 'good' })
    ).rejects.toMatchObject({ message: 'denied' });
  });
});
