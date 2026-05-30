/**
 * Tests for the access-token cache in
 * supabase/functions/_shared/helpers/ringcentral.ts.
 *
 * Why this exists: a cron-driven batch (e.g. "Send Screening Survey Reminder")
 * fans out into 30+ sequential SMS sends in a single isolate. Without
 * caching, each send triggers a fresh POST to /restapi/oauth/token, which
 * RingCentral throttles aggressively (CMN-301 "Request rate exceeded").
 * The cache must serve every call after the first one from memory until
 * the token is near expiry.
 *
 * Two layers are exercised here:
 *   1. The per-isolate in-memory Map (the original behavior).
 *   2. The cross-isolate Postgres store (ringcentral_token_cache), added
 *      after transcription + get-communications both froze on 2026-05-29
 *      when each cold Edge Function isolate minted its own token and tripped
 *      CMN-301. A cold isolate must reuse a sibling's still-valid token
 *      instead of minting, and must recover from a 429 by re-reading the
 *      shared store.
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

  it('does not cache a failed token request, and a retry can succeed', async () => {
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

    await expect(getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(/429/);
    const recovered = await getRingCentralAccessTokenWithJwt('jwt-A');

    expect(recovered).toBe('tok-recovered');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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

describe('getRingCentralAccessTokenWithJwt — cross-isolate store', () => {
  const futureMs = () => Date.now() + 3600_000; // ~1h out: comfortably valid

  it('reuses a valid token from the shared store without minting (cold isolate)', async () => {
    const mod = await loadHelper();
    // Fresh isolate: in-memory map is empty, but a sibling already minted.
    const store = {
      read: vi.fn().mockResolvedValue({ token: 'shared-tok', expiresAt: futureMs() }),
      write: vi.fn().mockResolvedValue(undefined),
    };
    mod._setRcTokenStoreForTests(store);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const token = await mod.getRingCentralAccessTokenWithJwt('jwt-A');

    expect(token).toBe('shared-tok');
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // never hit RC's auth endpoint
  });

  it('writes a freshly minted token to the shared store for siblings to reuse', async () => {
    const mod = await loadHelper();
    const store = {
      read: vi.fn().mockResolvedValue(null), // nothing cached yet
      write: vi.fn().mockResolvedValue(undefined),
    };
    mod._setRcTokenStoreForTests(store);
    globalThis.fetch = vi.fn().mockResolvedValue(mockTokenResponse({ token: 'minted-tok' }));

    const token = await mod.getRingCentralAccessTokenWithJwt('jwt-A');

    expect(token).toBe('minted-tok');
    expect(store.write).toHaveBeenCalledTimes(1);
    const [, entry] = store.write.mock.calls[0];
    expect(entry.token).toBe('minted-tok');
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it('mints a new token when the shared store entry has expired', async () => {
    const mod = await loadHelper();
    const store = {
      // Within the 60s safety margin → treated as expired.
      read: vi.fn().mockResolvedValue({ token: 'stale-tok', expiresAt: Date.now() + 30_000 }),
      write: vi.fn().mockResolvedValue(undefined),
    };
    mod._setRcTokenStoreForTests(store);
    const fetchSpy = vi.fn().mockResolvedValue(mockTokenResponse({ token: 'fresh-tok' }));
    globalThis.fetch = fetchSpy;

    const token = await mod.getRingCentralAccessTokenWithJwt('jwt-A');

    expect(token).toBe('fresh-tok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it('recovers from CMN-301 (429) by re-reading a token a sibling just wrote', async () => {
    const mod = await loadHelper();
    const store = {
      read: vi
        .fn()
        .mockResolvedValueOnce(null) // first check: nothing cached → we mint
        .mockResolvedValueOnce({ token: 'sibling-tok', expiresAt: futureMs() }), // after 429: sibling won the race
      write: vi.fn().mockResolvedValue(undefined),
    };
    mod._setRcTokenStoreForTests(store);
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"errorCode":"CMN-301","message":"Request rate exceeded"}',
      json: async () => ({}),
    });
    globalThis.fetch = fetchSpy;

    const token = await mod.getRingCentralAccessTokenWithJwt('jwt-A');

    expect(token).toBe('sibling-tok'); // recovered instead of throwing
    expect(fetchSpy).toHaveBeenCalledTimes(1); // did not retry the mint itself
    expect(store.read).toHaveBeenCalledTimes(2);
  });

  it('still throws on 429 when no sibling token is available to recover', async () => {
    const mod = await loadHelper();
    const store = {
      read: vi.fn().mockResolvedValue(null), // nothing cached, before or after
      write: vi.fn().mockResolvedValue(undefined),
    };
    mod._setRcTokenStoreForTests(store);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"errorCode":"CMN-301"}',
      json: async () => ({}),
    });

    await expect(mod.getRingCentralAccessTokenWithJwt('jwt-A')).rejects.toThrow(/429/);
  });
});
