/**
 * Tests for decideReconcileAction in
 * supabase/functions/_shared/operations/assessmentTranscription.ts —
 * the pure state machine the reconcile cron uses to recover stuck
 * assessment transcriptions. No DB / network here; we assert the
 * decision for each lifecycle state and age/attempt combination.
 */

import { describe, it, expect } from 'vitest';
import {
  decideReconcileAction,
  RECONCILE,
} from '../../../supabase/functions/_shared/operations/assessmentTranscription.ts';

const NOW = Date.parse('2026-06-03T12:00:00Z');
const minutesAgo = (n) => new Date(NOW - n * 60000).toISOString();

function decide(row) {
  return decideReconcileAction(
    { transcribe_attempts: 0, hasTranscription: false, ...row },
    NOW,
    RECONCILE,
  );
}

describe('decideReconcileAction — transcript already present', () => {
  it('heals a row whose status never flipped to transcribed', () => {
    expect(decide({ status: 'transcribing', updated_at: minutesAgo(1), hasTranscription: true })).toBe('resolve');
  });
  it('skips a row that is already transcribed', () => {
    expect(decide({ status: 'transcribed', updated_at: minutesAgo(1), hasTranscription: true })).toBe('skip');
  });
});

describe('decideReconcileAction — uploaded (initial submit lost?)', () => {
  it('waits inside the grace window', () => {
    expect(decide({ status: 'uploaded', updated_at: minutesAgo(1) })).toBe('wait');
  });
  it('submits once past the grace window', () => {
    expect(decide({ status: 'uploaded', updated_at: minutesAgo(3) })).toBe('submit');
  });
  it('fails out after maxAttempts and the stuck window', () => {
    expect(decide({ status: 'uploaded', updated_at: minutesAgo(20), transcribe_attempts: RECONCILE.maxAttempts }))
      .toBe('fail');
  });
});

describe('decideReconcileAction — transcribing (callback lost?)', () => {
  it('waits while inside the stuck window', () => {
    expect(decide({ status: 'transcribing', updated_at: minutesAgo(5), transcribe_attempts: 1 })).toBe('wait');
  });
  it('re-submits once stuck and under the attempt cap', () => {
    expect(decide({ status: 'transcribing', updated_at: minutesAgo(20), transcribe_attempts: 1 })).toBe('resubmit');
  });
  it('gives up at the attempt cap', () => {
    expect(decide({ status: 'transcribing', updated_at: minutesAgo(20), transcribe_attempts: RECONCILE.maxAttempts }))
      .toBe('fail');
  });
});

describe('decideReconcileAction — non-actionable states', () => {
  it('skips recording (still capturing)', () => {
    expect(decide({ status: 'recording', updated_at: minutesAgo(60) })).toBe('skip');
  });
  it('skips already-failed rows', () => {
    expect(decide({ status: 'failed', updated_at: minutesAgo(60) })).toBe('skip');
  });
});
