/**
 * Tests for supabase/functions/_shared/operations/rateLimit.ts
 *
 * Pure TypeScript (no Deno-only imports) so Vitest loads it directly via the
 * vitest.config.js `.ts` resolver. This guards the circuit-breaker that stops
 * post-call-processor from hammering RingCentral's per-extension bucket once
 * it enters its CMN-301 / 429 penalty interval (the May 2026 Messages-tab
 * outage).
 */

import { describe, it, expect } from 'vitest';
import { isRateLimitError } from '../../../supabase/functions/_shared/operations/rateLimit.ts';

describe('isRateLimitError', () => {
  it('matches the RC recording-download 429 shape our helper throws', () => {
    const err = new Error(
      'RC recording download failed (429): {"errorCode":"CMN-301","message":"Request rate exceeded"}',
    );
    expect(isRateLimitError(err)).toBe(true);
  });

  it('matches the RingSense insights 429 shape', () => {
    const err = new Error('RingSense insights fetch failed (429): rate exceeded');
    expect(isRateLimitError(err)).toBe(true);
  });

  it('matches a bare CMN-301 code regardless of HTTP status framing', () => {
    expect(isRateLimitError(new Error('Upstream said CMN-301'))).toBe(true);
  });

  it('matches the human-readable "Request rate exceeded" message', () => {
    expect(isRateLimitError(new Error('Request rate exceeded, try later'))).toBe(true);
  });

  it('matches generic "Too Many Requests" phrasing', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('accepts a plain string, not just an Error', () => {
    expect(isRateLimitError('RC Message Store API error (429): ...')).toBe(true);
  });

  it('does NOT match unrelated failures (auth, 5xx, network)', () => {
    expect(isRateLimitError(new Error('RingCentral auth failed (401): invalid_grant'))).toBe(false);
    expect(isRateLimitError(new Error('RC recording download failed (500): server error'))).toBe(false);
    expect(isRateLimitError(new Error('Whisper API failed (400): bad audio'))).toBe(false);
    expect(isRateLimitError(new Error('network timeout'))).toBe(false);
  });

  it('does not false-positive on a 429 embedded in an unrelated id', () => {
    // "4290" should not trip the bare-429 word-boundary matcher.
    expect(isRateLimitError(new Error('recording id 4290000 not found (404)'))).toBe(false);
  });

  it('is null/empty safe', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('')).toBe(false);
  });
});
