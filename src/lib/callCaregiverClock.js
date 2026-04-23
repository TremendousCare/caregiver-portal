// ─── callCaregiverClock ───
// Direct-fetch wrapper for the caregiver-clock edge function. Bypasses
// supabase.functions.invoke() so we control the exact timing of:
//   1. reading the session (guarded by SESSION_READ_TIMEOUT_MS), and
//   2. the outbound POST (guarded by CLOCK_REQUEST_TIMEOUT_MS via
//      AbortController).
//
// Why not invoke(): supabase-js v2 invoke() calls getSession()
// internally, and in the caregiver PWA it has been observed to wedge
// indefinitely after a fresh login, leaving the UI stuck on
// "Submitting…" with no network request ever firing. This helper
// forces both phases to be bounded and to surface a real error.

export const SESSION_READ_TIMEOUT_MS = 5_000;
export const CLOCK_REQUEST_TIMEOUT_MS = 20_000;

function raceWithTimeout(promise, ms, timeoutError) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(timeoutError), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export async function callCaregiverClock({
  supabaseClient,
  supabaseUrl,
  anonKey,
  body,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  sessionTimeoutMs = SESSION_READ_TIMEOUT_MS,
  requestTimeoutMs = CLOCK_REQUEST_TIMEOUT_MS,
}) {
  if (!supabaseClient) {
    throw new Error('Supabase is not configured on this device.');
  }
  if (!supabaseUrl || !anonKey) {
    throw new Error('Supabase URL or anon key is missing.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this environment.');
  }

  const sessionResult = await raceWithTimeout(
    supabaseClient.auth.getSession(),
    sessionTimeoutMs,
    new Error('Could not read your sign-in session. Sign out and back in to try again.'),
  );
  const accessToken = sessionResult?.data?.session?.access_token;
  if (!accessToken) {
    throw new Error('You’re signed out. Please sign back in and try again.');
  }

  const url = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/caregiver-clock`;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), requestTimeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    if (err?.name === 'AbortError') {
      throw new Error(
        `Clock-in request timed out after ${Math.round(requestTimeoutMs / 1000)} seconds. Check your connection and try again.`,
      );
    }
    throw new Error(err?.message || 'Network error. Check your connection and try again.');
  }
  clearTimeout(abortTimer);

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // Empty or non-JSON body — leave data as null.
  }

  if (!response.ok) {
    throw new Error(data?.error || `Clock-in failed with status ${response.status}.`);
  }
  return data;
}
