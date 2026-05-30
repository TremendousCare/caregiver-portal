/**
 * Tests for isRateLimitError in
 * supabase/functions/_shared/helpers/ringcentral.ts.
 *
 * Why this exists: the post-call-processor cron and the transcript-backfill
 * tool both drive batches of RingCentral "Heavy" group calls
 * (recording/content, 10/60s). When RingCentral throttles us it returns 429
 * / CMN-301; the callers must detect that and STOP the batch immediately,
 * because every further request inside the 60s penalty window just re-arms
 * the penalty. That loop kept recording/content at a ~88% error rate during
 * the 2026-05-29 incident and blocked transcription from draining. This
 * predicate is the single detection point both callers share.
 */

import { describe, it, expect } from 'vitest';
import { isRateLimitError } from '../../../supabase/functions/_shared/helpers/ringcentral.ts';

describe('isRateLimitError', () => {
  it('detects an HTTP 429 in a thrown RC error message', () => {
    expect(
      isRateLimitError(new Error('RC recording download failed (429): rate exceeded')),
    ).toBe(true);
  });

  it('detects the CMN-301 error code regardless of status wording', () => {
    expect(
      isRateLimitError('{"errorCode":"CMN-301","message":"Request rate exceeded"}'),
    ).toBe(true);
  });

  it('detects a "rate exceeded" phrase', () => {
    expect(isRateLimitError(new Error('Request rate exceeded'))).toBe(true);
  });

  it('detects a "rate limit" phrase', () => {
    expect(isRateLimitError('hit the rate limit')).toBe(true);
  });

  it('detects 429 surfaced via the auth endpoint', () => {
    expect(isRateLimitError(new Error('RingCentral auth failed (429): CMN-301'))).toBe(true);
  });

  it('does NOT flag a 404 (recording not found / RingSense not ready)', () => {
    expect(isRateLimitError(new Error('RC recording download failed (404)'))).toBe(false);
  });

  it('does NOT flag a generic 500 / other failure', () => {
    expect(isRateLimitError(new Error('Whisper API failed (500): server error'))).toBe(false);
  });

  it('does NOT flag a number that merely contains 429 as a substring', () => {
    // 4290 / 1429 should not match the \b429\b word-boundary check
    expect(isRateLimitError(new Error('failed (4290): nope'))).toBe(false);
    expect(isRateLimitError(new Error('id 11429 not found'))).toBe(false);
  });

  it('handles null / undefined / empty without throwing', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('')).toBe(false);
  });
});
