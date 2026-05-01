/**
 * Phase 0.4 — `app_settings.agent_runtime_cutover` flag reader.
 *
 * The reader is the gate that flips each edge function from legacy code
 * to the runtime shell *without redeploy*. Because every shell calls it
 * at the top of every invocation, its failure modes are part of the
 * production safety contract.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  readCutoverFlag,
  __resolveCutoverValue,
} from '../../../supabase/functions/_shared/operations/cutoverFlag.ts';

function makeFlagSupabase(value, error = null) {
  const builder = {
    select: vi.fn(function () { return this; }),
    eq: vi.fn(function () { return this; }),
    maybeSingle: vi.fn(async () => ({ data: value === undefined ? null : { value }, error })),
  };
  return { from: vi.fn(() => builder) };
}

describe('cutoverFlag — flag-resolution semantics', () => {
  it('returns false when value is undefined (row absent)', () => {
    expect(__resolveCutoverValue(undefined, 'ai_chat')).toBe(false);
    expect(__resolveCutoverValue(null, 'ai_chat')).toBe(false);
  });

  it('returns false when value is non-object', () => {
    expect(__resolveCutoverValue('true', 'ai_chat')).toBe(false);
    expect(__resolveCutoverValue(true, 'ai_chat')).toBe(false);
    expect(__resolveCutoverValue(123, 'ai_chat')).toBe(false);
  });

  it('returns false when shell key is absent from value', () => {
    expect(__resolveCutoverValue({ ai_planner: true }, 'ai_chat')).toBe(false);
  });

  it('returns false when shell key is anything other than literal true', () => {
    expect(__resolveCutoverValue({ ai_chat: 'true' }, 'ai_chat')).toBe(false);
    expect(__resolveCutoverValue({ ai_chat: 1 }, 'ai_chat')).toBe(false);
    expect(__resolveCutoverValue({ ai_chat: false }, 'ai_chat')).toBe(false);
  });

  it('returns true when shell key is literal true', () => {
    expect(__resolveCutoverValue({ ai_chat: true }, 'ai_chat')).toBe(true);
    expect(__resolveCutoverValue({ ai_chat: true, ai_planner: false }, 'ai_chat')).toBe(true);
  });

  it('isolates flags per shell — flipping one does not enable another', () => {
    const v = { ai_chat: true, ai_planner: false, message_router: false };
    expect(__resolveCutoverValue(v, 'ai_chat')).toBe(true);
    expect(__resolveCutoverValue(v, 'ai_planner')).toBe(false);
    expect(__resolveCutoverValue(v, 'message_router')).toBe(false);
  });
});

describe('cutoverFlag — readCutoverFlag failure modes', () => {
  it('returns false when row is missing', async () => {
    const sb = makeFlagSupabase(undefined);
    expect(await readCutoverFlag(sb, 'ai_chat')).toBe(false);
  });

  it('returns false when supabase returns an error', async () => {
    const sb = makeFlagSupabase(null, { message: 'boom' });
    expect(await readCutoverFlag(sb, 'ai_chat')).toBe(false);
  });

  it('returns true when seeded jsonb has the shell flag set', async () => {
    const sb = makeFlagSupabase({ ai_chat: true, ai_planner: false, message_router: false });
    expect(await readCutoverFlag(sb, 'ai_chat')).toBe(true);
    expect(await readCutoverFlag(sb, 'ai_planner')).toBe(false);
  });

  it('returns false when supabase chain throws synchronously', async () => {
    const sb = { from: () => { throw new Error('chain blew up'); } };
    expect(await readCutoverFlag(sb, 'ai_chat')).toBe(false);
  });
});
