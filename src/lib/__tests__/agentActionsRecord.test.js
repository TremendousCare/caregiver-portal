// Phase 1.1.A — recordAgentAction wrapper tests.
//
// Verifies the chain-write helper:
//   1. Reads the latest prev_hash for the org (genesis = '' if no rows)
//   2. Computes a hash + signs it
//   3. Calls the record_agent_action_v1 RPC with all 13 params
//   4. On chain-conflict (P0001), retries up to 3 times
//   5. On non-conflict error, returns the error to the caller
//
// All supabase calls are mocked. Crypto runs for real to exercise
// the full code path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordAgentAction,
  __resetSigningKeyCache,
  KEY_ENV_VAR_NAME,
} from '../../../supabase/functions/_shared/operations/agentActions.ts';
import {
  importSigningKey,
  hexToBytes,
} from '../../../supabase/functions/_shared/operations/agentActionsCrypto.ts';

const TEST_SEED_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Build a mocked supabase client. The chain helper only uses two
// calls: `.from('agent_actions').select('row_hash').eq(...).order(...).order(...).limit(1).maybeSingle()`
// for the prev_hash read, and `.rpc('record_agent_action_v1', ...)` for
// the write.
function makeSupabase({
  prevHash = null,           // null = no rows yet (genesis)
  prevHashSequence,          // for retry tests: array of values to return on successive reads
  rpcResults,                // array of {data, error} for successive RPC calls
  selectError,
} = {}) {
  let readCount = 0;
  let rpcCount = 0;
  const rpcCalls = [];

  const baseChain = (terminator) => {
    const chain = {
      select: vi.fn(() => chain),
      eq:     vi.fn(() => chain),
      order:  vi.fn(() => chain),
      limit:  vi.fn(() => chain),
      maybeSingle: vi.fn(async () => terminator()),
    };
    return chain;
  };

  return {
    from: vi.fn((tbl) => {
      if (tbl !== 'agent_actions') {
        throw new Error(`unexpected from(${tbl})`);
      }
      return baseChain(() => {
        const idx = readCount++;
        if (selectError) return { data: null, error: selectError };
        if (Array.isArray(prevHashSequence)) {
          const v = prevHashSequence[idx];
          return { data: v ? { row_hash: v } : null, error: null };
        }
        return {
          data: prevHash ? { row_hash: prevHash } : null,
          error: null,
        };
      });
    }),
    rpc: vi.fn(async (fnName, args) => {
      rpcCalls.push({ fnName, args });
      if (Array.isArray(rpcResults)) {
        const r = rpcResults[rpcCount++];
        return r;
      }
      return { data: 'inserted-uuid', error: null };
    }),
    __readCount: () => readCount,
    __rpcCalls: () => rpcCalls,
  };
}

const baseInput = {
  orgId:        '11111111-1111-1111-1111-111111111111',
  agentId:      '22222222-2222-2222-2222-222222222222',
  agentVersion: 3,
  actionType:   'agent_flag_toggled',
  phase:        'executed',
  entityType:   null,
  entityId:     null,
  actor:        'user:test@example.com',
  payload:      { flag: 'kill_switch', new_value: true },
  outcomeId:    null,
};

let injectedSigningKey;

beforeEach(async () => {
  __resetSigningKeyCache();
  injectedSigningKey = await importSigningKey(hexToBytes(TEST_SEED_HEX));
});

describe('recordAgentAction — happy path', () => {
  it('genesis row: reads no prev_hash, calls RPC with claimed_prev_hash=""', async () => {
    const sb = makeSupabase({ prevHash: null });
    const result = await recordAgentAction(sb, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('inserted-uuid');
    expect(result.retries).toBe(0);

    const calls = sb.__rpcCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].fnName).toBe('record_agent_action_v1');
    expect(calls[0].args.p_claimed_prev_hash).toBe('');
    expect(calls[0].args.p_org_id).toBe(baseInput.orgId);
    expect(calls[0].args.p_agent_id).toBe(baseInput.agentId);
    expect(calls[0].args.p_agent_version).toBe(3);
    expect(calls[0].args.p_phase).toBe('executed');
    // p_created_at must equal the same nowIso the hash was computed
    // against — Codex P1 #1: anything else and the verifier fails.
    expect(calls[0].args.p_created_at).toBe('2026-05-09T21:00:00Z');
    // row_hash is 64 hex chars (SHA-256)
    expect(calls[0].args.p_row_hash).toMatch(/^[0-9a-f]{64}$/);
    // signature is 128 hex chars (Ed25519, 64 bytes)
    expect(calls[0].args.p_signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it('subsequent row: reads prev_hash from latest existing row', async () => {
    const PRIOR = 'aa'.repeat(32);
    const sb = makeSupabase({ prevHash: PRIOR });
    const result = await recordAgentAction(sb, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });

    expect(result.success).toBe(true);
    const calls = sb.__rpcCalls();
    expect(calls[0].args.p_claimed_prev_hash).toBe(PRIOR);
  });

  it('passes payload through unchanged (RPC handles canonicalization for storage)', async () => {
    const sb = makeSupabase();
    const input = { ...baseInput, payload: { z: 1, a: 2, nested: { y: 3, x: 4 } } };
    const result = await recordAgentAction(sb, input, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });
    expect(result.success).toBe(true);
    const calls = sb.__rpcCalls();
    expect(calls[0].args.p_payload).toEqual({ z: 1, a: 2, nested: { y: 3, x: 4 } });
  });

  it('hash differs across runs with different timestamps (created_at_ns is in the chain)', async () => {
    const sb1 = makeSupabase();
    const sb2 = makeSupabase();
    await recordAgentAction(sb1, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00.000001Z',
    });
    await recordAgentAction(sb2, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00.000002Z',
    });
    const a = sb1.__rpcCalls()[0].args.p_row_hash;
    const b = sb2.__rpcCalls()[0].args.p_row_hash;
    expect(a).not.toBe(b);
  });
});

describe('recordAgentAction — chain conflict retry', () => {
  it('retries on P0001 with fresh prev_hash and succeeds on second attempt', async () => {
    const sb = makeSupabase({
      // First read: PRIOR_A. After conflict, second read returns PRIOR_B (someone else inserted).
      prevHashSequence: ['aa'.repeat(32), 'bb'.repeat(32)],
      rpcResults: [
        { data: null, error: { code: 'P0001', message: 'agent_actions_chain_conflict: ...' } },
        { data: 'second-inserted-uuid', error: null },
      ],
    });
    const result = await recordAgentAction(sb, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('second-inserted-uuid');
    expect(result.retries).toBe(1);

    const calls = sb.__rpcCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].args.p_claimed_prev_hash).toBe('aa'.repeat(32));
    expect(calls[1].args.p_claimed_prev_hash).toBe('bb'.repeat(32));
    // Hashes differ because prev_hash is part of the input.
    expect(calls[0].args.p_row_hash).not.toBe(calls[1].args.p_row_hash);
  });

  it('detects conflict by message substring even if code is missing', async () => {
    const sb = makeSupabase({
      prevHashSequence: ['aa'.repeat(32), 'bb'.repeat(32)],
      rpcResults: [
        { data: null, error: { message: 'agent_actions_chain_conflict happened' } },
        { data: 'ok', error: null },
      ],
    });
    const result = await recordAgentAction(sb, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });
    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
  });

  it('gives up after MAX_RETRIES (3) chain conflicts', async () => {
    const conflict = { code: 'P0001', message: 'agent_actions_chain_conflict' };
    const sb = makeSupabase({
      prevHashSequence: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
      rpcResults: [
        { data: null, error: conflict },
        { data: null, error: conflict },
        { data: null, error: conflict },
        { data: null, error: conflict },
      ],
    });
    const result = await recordAgentAction(sb, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });
    expect(result.success).toBe(false);
    expect(result.error.message).toMatch(/chain conflict|chain_conflict/);
    expect(result.retries).toBe(4); // 0..3 attempts = MAX_RETRIES + 1
  });
});

describe('recordAgentAction — non-retryable errors', () => {
  it('returns immediately on permission denied (42501)', async () => {
    const sb = makeSupabase({
      rpcResults: [
        { data: null, error: { code: '42501', message: 'permission denied' } },
      ],
    });
    const result = await recordAgentAction(sb, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });
    expect(result.success).toBe(false);
    expect(result.error.message).toMatch(/permission denied/);
    expect(result.retries).toBe(0);
    expect(sb.__rpcCalls()).toHaveLength(1);
  });

  it('returns error if prev_hash read fails', async () => {
    const sb = makeSupabase({ selectError: { message: 'rls denied' } });
    const result = await recordAgentAction(sb, baseInput, {
      signingKeyOverride: injectedSigningKey,
      nowIso: '2026-05-09T21:00:00Z',
    });
    expect(result.success).toBe(false);
    expect(result.error.message).toMatch(/prev_hash read failed/);
    // No RPC call attempted.
    expect(sb.__rpcCalls()).toHaveLength(0);
  });
});

describe('recordAgentAction — env var key handling', () => {
  it('exports the env var name as a sentinel for SaaS Phase C grep', () => {
    expect(KEY_ENV_VAR_NAME).toBe('AGENT_ACTIONS_ED25519_SEED');
  });

  it('uses envOverride when provided (no real env touched)', async () => {
    __resetSigningKeyCache();
    const sb = makeSupabase();
    const result = await recordAgentAction(sb, baseInput, {
      envOverride: TEST_SEED_HEX,
      nowIso: '2026-05-09T21:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('throws when env var is missing and no override given', async () => {
    __resetSigningKeyCache();
    // Ensure env is empty for this case.
    const prior = process.env[KEY_ENV_VAR_NAME];
    delete process.env[KEY_ENV_VAR_NAME];
    try {
      const sb = makeSupabase();
      const result = await recordAgentAction(sb, baseInput, {
        nowIso: '2026-05-09T21:00:00Z',
      });
      expect(result.success).toBe(false);
      expect(result.error.message).toMatch(/AGENT_ACTIONS_ED25519_SEED/);
    } finally {
      if (prior !== undefined) process.env[KEY_ENV_VAR_NAME] = prior;
    }
  });
});
