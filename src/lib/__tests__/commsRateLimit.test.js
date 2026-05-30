/**
 * Tests for src/lib/messaging/commsRateLimit.js — the frontend classifier
 * that decides whether a failed get-communications fetch should render as
 * "rate limited (temporarily unavailable)" vs a generic load failure.
 *
 * The distinction matters: an empty Messages tab during a RingCentral 429
 * must NOT read as "this contact has no messages." These tests pin the
 * detection so the two surfaces (ClientActivityLog + useCommsTimeline) stay
 * in agreement.
 */

import { describe, it, expect } from 'vitest';
import {
  isCommsRateLimitError,
  commsErrorMessage,
  COMMS_RATE_LIMITED_MESSAGE,
  COMMS_LOAD_FAILED_MESSAGE,
} from '../messaging/commsRateLimit';

describe('isCommsRateLimitError', () => {
  it('detects the Supabase FunctionsHttpError 429 via context.status', () => {
    expect(isCommsRateLimitError({ message: 'Edge Function returned a non-2xx status code', context: { status: 429 } })).toBe(true);
  });

  it('detects a 429 in the message string', () => {
    expect(isCommsRateLimitError(new Error('request failed with 429'))).toBe(true);
  });

  it('detects CMN-301 in the message', () => {
    expect(isCommsRateLimitError(new Error('RingCentral CMN-301 Request rate exceeded'))).toBe(true);
  });

  it('detects the "rate limit" / "too many requests" phrasings', () => {
    expect(isCommsRateLimitError(new Error('rate limit hit'))).toBe(true);
    expect(isCommsRateLimitError(new Error('Too Many Requests'))).toBe(true);
  });

  it('accepts a plain string', () => {
    expect(isCommsRateLimitError('429 Too Many Requests')).toBe(true);
  });

  it('returns false for a generic 500 / non-rate-limit failure', () => {
    expect(isCommsRateLimitError({ message: 'Internal error', context: { status: 500 } })).toBe(false);
    expect(isCommsRateLimitError(new Error('network down'))).toBe(false);
  });

  it('does not false-positive on a 429 embedded in a larger number', () => {
    expect(isCommsRateLimitError(new Error('id 4290 not found'))).toBe(false);
  });

  it('is null/undefined safe', () => {
    expect(isCommsRateLimitError(null)).toBe(false);
    expect(isCommsRateLimitError(undefined)).toBe(false);
  });
});

describe('commsErrorMessage', () => {
  it('returns the rate-limited copy for a 429', () => {
    expect(commsErrorMessage({ context: { status: 429 } })).toBe(COMMS_RATE_LIMITED_MESSAGE);
  });

  it('returns the generic copy otherwise', () => {
    expect(commsErrorMessage(new Error('boom'))).toBe(COMMS_LOAD_FAILED_MESSAGE);
  });
});
