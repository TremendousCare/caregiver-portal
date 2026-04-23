import { describe, it, expect, vi } from 'vitest';
import { callCaregiverClock } from '../callCaregiverClock';

function makeSupabaseClient(session, { getSessionDelayMs = 0 } = {}) {
  return {
    auth: {
      getSession: vi.fn(async () => {
        if (getSessionDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, getSessionDelayMs));
        }
        return { data: { session } };
      }),
    },
  };
}

const goodSession = { access_token: 'tok_abc' };

describe('callCaregiverClock', () => {
  it('returns response body on success', async () => {
    const supabaseClient = makeSupabaseClient(goodSession);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, clock_event_id: 'ce_1' }),
    }));

    const data = await callCaregiverClock({
      supabaseClient,
      supabaseUrl: 'https://project.supabase.co',
      anonKey: 'anon',
      body: { shift_id: 's1', event_type: 'in' },
      fetchImpl,
    });

    expect(data).toEqual({ success: true, clock_event_id: 'ce_1' });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://project.supabase.co/functions/v1/caregiver-clock');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok_abc');
    expect(opts.headers.apikey).toBe('anon');
    expect(JSON.parse(opts.body)).toEqual({ shift_id: 's1', event_type: 'in' });
  });

  it('throws a friendly error when the session read times out', async () => {
    const supabaseClient = makeSupabaseClient(goodSession, { getSessionDelayMs: 200 });
    const fetchImpl = vi.fn();

    await expect(
      callCaregiverClock({
        supabaseClient,
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon',
        body: {},
        fetchImpl,
        sessionTimeoutMs: 20,
      }),
    ).rejects.toThrow(/sign out and back in/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws signed-out error when session has no access token', async () => {
    const supabaseClient = makeSupabaseClient(null);
    const fetchImpl = vi.fn();

    await expect(
      callCaregiverClock({
        supabaseClient,
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon',
        body: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/signed out/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates AbortError into a timeout message', async () => {
    const supabaseClient = makeSupabaseClient(goodSession);
    const fetchImpl = vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    await expect(
      callCaregiverClock({
        supabaseClient,
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon',
        body: {},
        fetchImpl,
        requestTimeoutMs: 10,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('surfaces the server error message on non-2xx responses', async () => {
    const supabaseClient = makeSupabaseClient(goodSession);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "You're outside the client's geofence." }),
    }));

    await expect(
      callCaregiverClock({
        supabaseClient,
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon',
        body: {},
        fetchImpl,
      }),
    ).rejects.toThrow("You're outside the client's geofence.");
  });

  it('falls back to a status-code message when the error body is missing', async () => {
    const supabaseClient = makeSupabaseClient(goodSession);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('no body');
      },
    }));

    await expect(
      callCaregiverClock({
        supabaseClient,
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon',
        body: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/status 502/);
  });

  it('converts generic network errors into a friendly message', async () => {
    const supabaseClient = makeSupabaseClient(goodSession);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(
      callCaregiverClock({
        supabaseClient,
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon',
        body: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/Failed to fetch|Network error/);
  });

  it('throws up front when supabase client is missing', async () => {
    await expect(
      callCaregiverClock({
        supabaseClient: null,
        supabaseUrl: 'https://project.supabase.co',
        anonKey: 'anon',
        body: {},
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/not configured/i);
  });

  it('strips a trailing slash from supabaseUrl', async () => {
    const supabaseClient = makeSupabaseClient(goodSession);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }));

    await callCaregiverClock({
      supabaseClient,
      supabaseUrl: 'https://project.supabase.co/',
      anonKey: 'anon',
      body: {},
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe('https://project.supabase.co/functions/v1/caregiver-clock');
  });
});
