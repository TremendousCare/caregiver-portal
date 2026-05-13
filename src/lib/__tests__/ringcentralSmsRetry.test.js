/**
 * Tests for sendSmsToRingCentralWithRetry in
 * supabase/functions/_shared/helpers/ringcentral.ts.
 *
 * Idempotency-critical: this helper exists because RingCentral's SMS group
 * is rate-limited (40 req/60s with a 30s penalty). When a 429 hits, we want
 * to wait out the penalty and retry — but only on 429, because any other
 * failure mode (network errors, 5xx) could mean the message reached RC but
 * the response was lost, in which case retrying would deliver the SMS twice.
 *
 * These tests pin down exactly which response/error conditions trigger the
 * retry and which don't. Don't loosen them without re-reading the helper's
 * docstring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  globalThis.Deno = {
    env: {
      get: (key) => {
        if (key === 'RINGCENTRAL_CLIENT_ID') return 'test-client-id';
        if (key === 'RINGCENTRAL_CLIENT_SECRET') return 'test-client-secret';
        return undefined;
      },
    },
  };
});

async function loadHelper() {
  return await import(
    '../../../supabase/functions/_shared/helpers/ringcentral.ts'
  );
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => '{"id":"msg-1"}',
    json: async () => ({ id: 'msg-1' }),
  };
}

function rateLimitResponse() {
  return {
    ok: false,
    status: 429,
    text: async () => '{"errorCode":"CMN-301","message":"Request rate exceeded"}',
    json: async () => ({ errorCode: 'CMN-301' }),
  };
}

function serverErrorResponse(status = 500) {
  return {
    ok: false,
    status,
    text: async () => `{"message":"server error ${status}"}`,
    json: async () => ({ message: `server error ${status}` }),
  };
}

function clientErrorResponse(status = 400) {
  return {
    ok: false,
    status,
    text: async () => `{"message":"bad request ${status}"}`,
    json: async () => ({ message: `bad request ${status}` }),
  };
}

describe('sendSmsToRingCentralWithRetry', () => {
  it('returns immediately on a successful first attempt (no retry)', async () => {
    const { sendSmsToRingCentralWithRetry } = await loadHelper();
    const fetchSpy = vi.fn().mockResolvedValueOnce(okResponse());
    globalThis.fetch = fetchSpy;

    const res = await sendSmsToRingCentralWithRetry(
      'access-token',
      '+15551234567',
      '+15557654321',
      'hello',
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once on 429 and returns the second response on success', async () => {
    vi.useFakeTimers();
    try {
      const { sendSmsToRingCentralWithRetry } = await loadHelper();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(rateLimitResponse())
        .mockResolvedValueOnce(okResponse());
      globalThis.fetch = fetchSpy;

      const promise = sendSmsToRingCentralWithRetry(
        'access-token',
        '+15551234567',
        '+15557654321',
        'hello',
      );

      // Helper waits 35s before retrying — advance through it.
      await vi.advanceTimersByTimeAsync(35_000);
      const res = await promise;

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry a third time when the retry attempt also 429s', async () => {
    vi.useFakeTimers();
    try {
      const { sendSmsToRingCentralWithRetry } = await loadHelper();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(rateLimitResponse())
        .mockResolvedValueOnce(rateLimitResponse());
      globalThis.fetch = fetchSpy;

      const promise = sendSmsToRingCentralWithRetry(
        'access-token',
        '+15551234567',
        '+15557654321',
        'hello',
      );
      await vi.advanceTimersByTimeAsync(35_000);
      const res = await promise;

      expect(res.status).toBe(429);
      // Hard cap: original + 1 retry. No third attempt under any condition.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry on 5xx server errors (message may have been accepted before failure)', async () => {
    const { sendSmsToRingCentralWithRetry } = await loadHelper();
    const fetchSpy = vi.fn().mockResolvedValueOnce(serverErrorResponse(500));
    globalThis.fetch = fetchSpy;

    const res = await sendSmsToRingCentralWithRetry(
      'access-token',
      '+15551234567',
      '+15557654321',
      'hello',
    );

    expect(res.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 503 (treated like other 5xx — could mean accepted-then-failed)', async () => {
    const { sendSmsToRingCentralWithRetry } = await loadHelper();
    const fetchSpy = vi.fn().mockResolvedValueOnce(serverErrorResponse(503));
    globalThis.fetch = fetchSpy;

    const res = await sendSmsToRingCentralWithRetry(
      'access-token',
      '+15551234567',
      '+15557654321',
      'hello',
    );

    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 422])(
    'does NOT retry on non-429 4xx (%s) — permanent failure, retry would not succeed',
    async (status) => {
      const { sendSmsToRingCentralWithRetry } = await loadHelper();
      const fetchSpy = vi.fn().mockResolvedValueOnce(clientErrorResponse(status));
      globalThis.fetch = fetchSpy;

      const res = await sendSmsToRingCentralWithRetry(
        'access-token',
        '+15551234567',
        '+15557654321',
        'hello',
      );

      expect(res.status).toBe(status);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('does NOT retry on network/fetch errors — the request may have reached RC before the connection dropped, and retrying could double-send', async () => {
    const { sendSmsToRingCentralWithRetry } = await loadHelper();
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('network down'));
    globalThis.fetch = fetchSpy;

    await expect(
      sendSmsToRingCentralWithRetry(
        'access-token',
        '+15551234567',
        '+15557654321',
        'hello',
      ),
    ).rejects.toThrow(/network down/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('posts to the correct RingCentral SMS endpoint with the access token and message body', async () => {
    const { sendSmsToRingCentralWithRetry } = await loadHelper();
    const fetchSpy = vi.fn().mockResolvedValueOnce(okResponse());
    globalThis.fetch = fetchSpy;

    await sendSmsToRingCentralWithRetry(
      'access-token-xyz',
      '+15551234567',
      '+15557654321',
      'hello from test',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer access-token-xyz');
    const body = JSON.parse(init.body);
    expect(body.from.phoneNumber).toBe('+15551234567');
    expect(body.to).toEqual([{ phoneNumber: '+15557654321' }]);
    expect(body.text).toBe('hello from test');
  });
});
