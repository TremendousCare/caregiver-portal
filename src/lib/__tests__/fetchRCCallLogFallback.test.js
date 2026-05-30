/**
 * Tests for the `exhaustiveFallback` gate on fetchRCCallLog in
 * supabase/functions/_shared/helpers/ringcentral.ts.
 *
 * The fallback fires a SECOND RingCentral "Heavy" API call (a 250-record
 * unfiltered call-log sweep, filtered client-side) whenever the
 * phoneNumber-filtered query returns nothing. On the interactive
 * get-communications path that doubled Heavy-bucket usage for every
 * zero-history contact and contributed to the rate-limit exhaustion that
 * blanked the Messages tab. These tests pin down that:
 *
 *   - exhaustiveFallback=false makes exactly ONE call-log request and returns
 *     [] when the filtered query is empty (interactive path).
 *   - the default (true) still performs the sweep (ai-chat / explicit path).
 *   - a non-empty filtered result never triggers the sweep regardless.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  globalThis.Deno = {
    env: { get: () => undefined },
  };
  vi.restoreAllMocks();
});

async function loadHelper() {
  return await import('../../../supabase/functions/_shared/helpers/ringcentral.ts');
}

function jsonResponse(records) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ records }),
    json: async () => ({ records }),
  };
}

const TOKEN = 'access-token';
const PHONE = '+19495551234';

describe('fetchRCCallLog exhaustiveFallback gate', () => {
  it('does NOT fire the 250-record sweep when fallback is disabled and filtered result is empty', async () => {
    const { fetchRCCallLog } = await loadHelper();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse([]));

    const result = await fetchRCCallLog(TOKEN, PHONE, 90, false);

    expect(result).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the phoneNumber-filtered query
    expect(fetchSpy.mock.calls[0][0]).toContain('phoneNumber=');
    expect(fetchSpy.mock.calls[0][0]).toContain('perPage=100');
  });

  it('DOES fire the sweep by default (ai-chat path) when filtered result is empty', async () => {
    const { fetchRCCallLog } = await loadHelper();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([])) // filtered → empty
      .mockResolvedValueOnce(jsonResponse([])); // sweep

    await fetchRCCallLog(TOKEN, PHONE, 90); // default exhaustiveFallback=true

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain('perPage=250');
    expect(fetchSpy.mock.calls[1][0]).not.toContain('phoneNumber=');
  });

  it('never sweeps when the filtered query already returns records', async () => {
    const { fetchRCCallLog } = await loadHelper();
    const record = {
      id: 'c1',
      from: { phoneNumber: PHONE },
      to: { phoneNumber: '+19490000000' },
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse([record]));

    const result = await fetchRCCallLog(TOKEN, PHONE, 90, false);

    expect(result).toEqual([record]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
