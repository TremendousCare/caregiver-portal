/**
 * Tests for the in-memory access-token cache in
 * supabase/functions/_shared/helpers/ringcentral.ts.
 *
 * Why this exists: a cron-driven batch (e.g. "Send Screening Survey Reminder")
 * fans out into 30+ sequential SMS sends in a single isolate. Without
 * caching, each send triggers a fresh POST to /restapi/oauth/token, which
 * RingCentral throttles aggressively (CMN-301 "Request rate exceeded").
 * The cache must serve every call after the first one from memory until
 * the token is near expiry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shim the Deno globals that the helper module reads at call time.
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
  const mod = await import(
    '../../../supabase/functions/_shared/helpers/ringcentral.ts'
  );
  mod._resetRcTokenCacheForTests();
  return mod;
}

function mockTokenResponse({ token = 'access-token-1', expires_in = 3600 } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in, token_type: 'bearer' }),
    text: async () => '',
  };
}

describe('getRingCentralAccessTokenWithJwt — caching', () => {
  it('fetches a token on first call and caches it for subsequent calls with the same JWT', async () => {
    const { getRingCentralAccessTokenWithJwt } = await loadHelper();
    const fetchSpy = vi.fn().mockResolvedValue(mockTokenResponse({ token: 'tok-A' }));
    globalThis.fetch = fetchSpy;

    const a = await getRingCentralAccessTokenWithJwt('jwt-A');
    const b = await getRingCentralAccessTokenWithJwt('jwt-A');
    const c = await getRingCentralAccessTokenWithJwt('jwt-A');

    expect(a).toBe('tok-A');
    expect(b).toBe('tok-A');
    expect(c).toBe('tok-A');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries per JWT', async () => {
    const { getRingCentralAccessTokenWithJwt } = await loadHelper();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockTokenResponse({ token: 'tok-A' }))
      .mockResolvedValueOnce(mockTokenResponse({ token: 'tok-B' }));
    globalThis.fetch = fetchSpy;

    const a = await getRingCentralAccessTokenWithJwt('jwt-A');
    const b = await getRingCentralAccessTokenWithJwt('jwt-B');
    const aAgain = await getRingCentralAccessTokenWithJwt('jwt-A');
    const bAgain = await getRingCentralAccessTokenWithJwt('jwt-B');

    expect(a).toBe('tok-A');
    expect(b).toBe('tok-B');
    expect(aAgain).toBe('tok-A');
    expect(bAgain).toBe('tok-B');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('refreshes the token after it nears expiry (safety margin)', async () => {
    vi.useFakeTimers();
    try {
      const { getRingCentralAccessTokenWithJwt } = await loadHelper();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(mockTokenResponse({ token: 'tok-old', expires_in: 3600 }))
        .mockResolvedValueOnce(mockTokenResponse({ token: 'tok-new', expires_in: 3600 }));
      globalThis.fetch = fetchSpy;

      const first = await getRingCentralAccessTokenWithJwt('jwt-A');
      expect(first).toBe('tok-old');

      // Advance past the 60s safety margin (3600s - 60s = 3540s = 3,540,000ms)
      vi.advanceTimersByTime(3_541_000);

      const second = await getRingCentralAccessTokenWithJwt('jwt-A');
      expect(second).toBe('tok-new');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still serves the cached token while well within its lifetime', async () => {
    vi.useFakeTimers();
    try {
      const { getRingCentralAccessTokenWithJwt } = await loadHelper();
      const fetchSpy = vi.fn().mockResolvedValue(mockTokenResponse({ token: 'tok-A', expires_in: 3600 }));
      globalThis.fetch = fetchSpy;

      await getRingCentralAccessTokenWithJwt('jwt-A');
      // Advance 30 minutes — well within the 1h lifetime.
      vi.advanceTimersByTime(30 * 60 * 1000);
      const second = await getRingCentralAccessTokenWithJwt('jwt-A');

      expect(second).toBe('tok-A');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent in-flight token requests for the same JWT', async () => {
    const { getRingCentralAccessTokenWithJwt } = await loadHelper();
    let resolveFetch;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi.fn().mockReturnValue(fetchPromise);
    globalThis.fetch = fetchSpy;

    // Kick off 5 concurrent requests before any can resolve.
    const p1 = getRingCentralAccessTokenWithJwt('jwt-A');
    const p2 = getRingCentralAccessTokenWithJwt('jwt-A');
    const p3 = getRingCentralAccessTokenWithJwt('jwt-A');
    const p4 = getRingCentralAccessTokenWithJwt('jwt-A');
    const p5 = getRingCentralAccessTokenWithJwt('jwt-A');

    resolveFetch(mockTokenResponse({ token: 'tok-A' }));
    const results = await Promise.all([p1, p2, p3, p4, p5]);

    expect(results).toEqual(['tok-A', 'tok-A', 'tok-A', 'tok-A', 'tok-A']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('negatively caches a 429 failure for the RC penalty window, then recovers', async () => {
    // Why this matters: post-call-processor batches 25 sequential
    // call-transcription invocations. If the first /oauth/token POST 429s
    // and we DON'T cache that failure, each of the remaining 24 callers
    // also fires a fresh POST against an extension whose bucket is in
    // penalty — and every additional request during the penalty extends
    // it further. Caching the 429 for ~60s short-circuits the rest of the
    // batch without poking the bucket, lets the penalty expire, and the
    // next caller after the window gets a clean attempt.
    vi.useFakeTimers();
    try {
      const { getRingCentralAccessTokenWithJwt } = await loadHelper();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => '{"errorCode":"CMN-301","message":"Request rate exceeded"}',
          json: async () => ({}),
        })
        .mockResolvedValueOnce(mockTokenResponse({ token: 'tok-recovered' }));
      globalThis.fetch = fetchSpy;

      // First call hits RC and gets 429.
      await expect(getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(/429/);

      // Within the 60s backoff window, subsequent calls short-circuit on
      // the negative cache — fetch is NOT called again, and the same error
      // surface is preserved so callers see the underlying CMN-301.
      await expect(getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(/429/);
      await expect(getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(/429/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Once the 60s window passes, a fresh attempt is allowed and can succeed.
      vi.advanceTimersByTime(60_001);
      const recovered = await getRingCentralAccessTokenWithJwt('jwt-A');
      expect(recovered).toBe('tok-recovered');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT negatively cache non-429 failures (e.g. 401 bad credentials)', async () => {
    // Other failure modes (401 invalid JWT, 5xx, network blips) don't
    // signal a rate-limit penalty, so callers should see fresh attempts
    // rather than have a stale error swallowed for 60s.
    const { getRingCentralAccessTokenWithJwt } = await loadHelper();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"errorCode":"OAU-149","message":"Invalid assertion"}',
        json: async () => ({}),
      })
      .mockResolvedValueOnce(mockTokenResponse({ token: 'tok-recovered' }));
    globalThis.fetch = fetchSpy;

    await expect(getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(/401/);
    const recovered = await getRingCentralAccessTokenWithJwt('jwt-A');

    expect(recovered).toBe('tok-recovered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('clears a stale negative-cache entry on a successful auth', async () => {
    // If a 429 was cached and then somehow a later call succeeds (e.g.
    // because the cache expired right as the call started), we must drop
    // the negative entry so the cached SUCCESS is what callers see —
    // otherwise the next caller within the original 60s window would
    // still get the stale error.
    vi.useFakeTimers();
    try {
      const { getRingCentralAccessTokenWithJwt } = await loadHelper();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: async () => 'CMN-301',
          json: async () => ({}),
        })
        .mockResolvedValueOnce(mockTokenResponse({ token: 'tok-good' }));
      globalThis.fetch = fetchSpy;

      await expect(getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(/429/);
      vi.advanceTimersByTime(60_001);
      const ok = await getRingCentralAccessTokenWithJwt('jwt-A');
      expect(ok).toBe('tok-good');

      // Subsequent calls hit the SUCCESS cache, NOT the negative cache.
      const again = await getRingCentralAccessTokenWithJwt('jwt-A');
      expect(again).toBe('tok-good');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when client credentials are missing', async () => {
    globalThis.Deno = { env: { get: () => undefined } };
    const { getRingCentralAccessTokenWithJwt } = await loadHelper();
    globalThis.fetch = vi.fn();

    await expect(getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(
      /client credentials not configured/i,
    );
  });

  it('throws when the JWT is empty', async () => {
    const { getRingCentralAccessTokenWithJwt } = await loadHelper();
    globalThis.fetch = vi.fn();

    await expect(getRingCentralAccessTokenWithJwt('')).rejects.toThrow(
      /JWT not provided/i,
    );
  });
});
