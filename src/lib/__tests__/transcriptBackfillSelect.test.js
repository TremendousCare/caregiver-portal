/**
 * Tests for supabase/functions/_shared/operations/transcriptBackfillSelect.ts —
 * the pure drain helper that lets the one-time transcript-backfill function
 * make progress across repeated invocations instead of re-returning the same
 * already-transcribed rows at the top of the candidate window.
 */

import { describe, it, expect } from 'vitest';

async function loadModule() {
  return await import(
    '../../../supabase/functions/_shared/operations/transcriptBackfillSelect.ts'
  );
}

describe('filterUncached', () => {
  it('drops candidates whose recording is already cached', async () => {
    const { filterUncached } = await loadModule();
    const candidates = [
      { recording_id: 'a', id: '1' },
      { recording_id: 'b', id: '2' },
      { recording_id: 'c', id: '3' },
    ];
    const out = filterUncached(candidates, ['b']);
    expect(out.map((r) => r.recording_id)).toEqual(['a', 'c']);
  });

  it('preserves input order', async () => {
    const { filterUncached } = await loadModule();
    const candidates = [
      { recording_id: 'z' },
      { recording_id: 'y' },
      { recording_id: 'x' },
    ];
    expect(filterUncached(candidates, []).map((r) => r.recording_id)).toEqual(['z', 'y', 'x']);
  });

  it('returns empty when every candidate is cached (pool drained)', async () => {
    const { filterUncached } = await loadModule();
    const candidates = [{ recording_id: 'a' }, { recording_id: 'b' }];
    expect(filterUncached(candidates, ['a', 'b'])).toEqual([]);
  });

  it('returns all candidates when nothing is cached', async () => {
    const { filterUncached } = await loadModule();
    const candidates = [{ recording_id: 'a' }, { recording_id: 'b' }];
    expect(filterUncached(candidates, [])).toHaveLength(2);
  });

  it('accepts any iterable of cached ids (e.g. a Set)', async () => {
    const { filterUncached } = await loadModule();
    const candidates = [{ recording_id: 'a' }, { recording_id: 'b' }, { recording_id: 'c' }];
    const out = filterUncached(candidates, new Set(['a', 'c']));
    expect(out.map((r) => r.recording_id)).toEqual(['b']);
  });

  it('handles an empty candidate list', async () => {
    const { filterUncached } = await loadModule();
    expect(filterUncached([], ['a'])).toEqual([]);
  });
});
