// ─── RingCentral Auth & API Helpers ───
// Reads credentials directly from Deno.env so this module has no dependency
// on ai-chat's config.ts and can be imported by any Edge Function.

export const RC_API_URL = "https://platform.ringcentral.com";

// Legacy helper: uses the global RINGCENTRAL_JWT_TOKEN env var.
// Still used by helpers that don't participate in category routing
// (fetchRCMessages, fetchRCCallLog) — those read call logs which have
// always been account-level and don't depend on sender identity.
export async function getRingCentralAccessToken(): Promise<string> {
  const jwtToken = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
  if (!jwtToken) {
    throw new Error("RingCentral JWT not configured (RINGCENTRAL_JWT_TOKEN env var missing)");
  }
  return getRingCentralAccessTokenWithJwt(jwtToken);
}

// Module-level cache of access tokens keyed by JWT. RingCentral's OAuth
// endpoint throttles aggressively (CMN-301 "Request rate exceeded") and a
// batched send loop — e.g. automation-cron firing 30+ "Send Screening Survey
// Reminder" SMS in 30s — will burn through the quota and fail mid-batch
// without this. Tokens are valid ~1 hour; we expire SAFETY_MS before the
// stated lifetime to avoid race-with-clock-skew failures.
type RcTokenCacheEntry = { token: string; expiresAt: number };
const rcTokenCache = new Map<string, RcTokenCacheEntry>();
const rcTokenInFlight = new Map<string, Promise<string>>();
const RC_TOKEN_SAFETY_MS = 60_000;

// Negative cache: when RC's /oauth/token returns 429 (CMN-301 "Request rate
// exceeded"), the extension's auth bucket is in a 60s penalty interval and
// every additional request DURING THAT INTERVAL also fails AND extends the
// penalty further. Without negative caching, a serial loop of N callers
// (e.g. post-call-processor batching 25 transcription calls via
// call-transcription) each fires a fresh /oauth/token, each gets 429, the
// failure is never cached, and the bucket stays pinned in penalty
// indefinitely. With this cache, the first 429 short-circuits subsequent
// callers for `RC_TOKEN_429_BACKOFF_MS` so we stop poking the bucket and
// let it clear. Cache window matches RC's documented 60s penalty.
//
// We ONLY negative-cache 429s. Other failure modes (401 bad creds, 5xx,
// network blips) are transient or permanent in different ways and we want
// the next caller to surface the underlying error rather than swallow it
// behind a cached error message.
type RcTokenFailureCacheEntry = { error: Error; expiresAt: number };
const rcTokenFailureCache = new Map<string, RcTokenFailureCacheEntry>();
const RC_TOKEN_429_BACKOFF_MS = 60_000;

// Test-only: reset the cache between cases. Not part of the public API.
export function _resetRcTokenCacheForTests() {
  rcTokenCache.clear();
  rcTokenInFlight.clear();
  rcTokenFailureCache.clear();
}

// Category-aware helper: takes a JWT as a parameter so the caller can
// decide which RingCentral extension to authenticate as. Used by the
// sendSMS shared operation after a route lookup via
// getSendingCredentials() below.
export async function getRingCentralAccessTokenWithJwt(
  jwt: string,
): Promise<string> {
  const clientId = Deno.env.get("RINGCENTRAL_CLIENT_ID");
  const clientSecret = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("RingCentral client credentials not configured");
  }
  if (!jwt) {
    throw new Error("RingCentral JWT not provided");
  }

  const cached = rcTokenCache.get(jwt);
  if (cached && Date.now() < cached.expiresAt - RC_TOKEN_SAFETY_MS) {
    return cached.token;
  }

  // Negative cache hit → don't hit RC, the bucket is in penalty.
  // Replay the original error so callers see the underlying CMN-301.
  const failure = rcTokenFailureCache.get(jwt);
  if (failure && Date.now() < failure.expiresAt) {
    throw failure.error;
  }
  if (failure) {
    // Stale entry — drop it so we try fresh below.
    rcTokenFailureCache.delete(jwt);
  }

  const inFlight = rcTokenInFlight.get(jwt);
  if (inFlight) return inFlight;

  const fetchPromise = (async (): Promise<string> => {
    try {
      const response = await fetch(`${RC_API_URL}/restapi/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(
          `RingCentral auth failed (${response.status}): ${errorText}`,
        );
        // Park 429s in the negative cache so the next N callers within the
        // RC penalty window short-circuit instead of poking the bucket.
        if (response.status === 429) {
          rcTokenFailureCache.set(jwt, {
            error: err,
            expiresAt: Date.now() + RC_TOKEN_429_BACKOFF_MS,
          });
        }
        throw err;
      }

      const data = await response.json();
      const expiresInSec =
        typeof data.expires_in === "number" && data.expires_in > 0
          ? data.expires_in
          : 3600;
      rcTokenCache.set(jwt, {
        token: data.access_token,
        expiresAt: Date.now() + expiresInSec * 1000,
      });
      // On success, evict any stale negative-cache entry so we don't keep
      // throwing the old error even though auth is healthy again.
      rcTokenFailureCache.delete(jwt);
      return data.access_token;
    } finally {
      rcTokenInFlight.delete(jwt);
    }
  })();

  rcTokenInFlight.set(jwt, fetchPromise);
  return fetchPromise;
}

/**
 * Resolve the sending phone number + JWT pair for an SMS send based on an
 * optional `category`. This mirrors the logic in bulk-sms/index.ts so all
 * edge functions that send SMS can share a single source of truth.
 *
 * - When `category` is provided → calls the service-role-only
 *   get_route_ringcentral_jwt RPC to look up the route's phone and
 *   decrypted JWT from Supabase Vault. Throws with a descriptive error
 *   if the route is missing, inactive, or incomplete.
 *
 * - When `category` is null/undefined → falls back to the legacy env-var
 *   path (app_settings.ringcentral_from_number + RINGCENTRAL_JWT_TOKEN).
 *   Byte-identical to pre-routing behavior.
 */
export async function getSendingCredentials(
  supabase: any,
  category: string | null | undefined,
): Promise<{ fromNumber: string; jwt: string }> {
  // ── Path A: category specified → route-based lookup ──
  if (category) {
    const { data, error } = await supabase.rpc("get_route_ringcentral_jwt", {
      p_category: category,
    });
    if (error) {
      throw new Error(
        `Route lookup failed for "${category}": ${error.message}`,
      );
    }
    if (!data || data.length === 0) {
      throw new Error(
        `Communication route "${category}" not found or inactive.`,
      );
    }
    const route = data[0];
    if (!route.sms_from_number) {
      throw new Error(
        `Route "${category}" has no phone number configured. Set one in Admin Settings → Communication Routes.`,
      );
    }
    if (!route.jwt) {
      throw new Error(
        `Route "${category}" has no JWT configured. Set one in Admin Settings → Communication Routes.`,
      );
    }
    // Normalize the phone number to E.164
    const digits = String(route.sms_from_number).replace(/\D/g, "");
    let normalized: string | null = null;
    if (digits.length === 10) normalized = `+1${digits}`;
    else if (digits.length === 11 && digits.startsWith("1")) normalized = `+${digits}`;
    if (!normalized) {
      throw new Error(
        `Route "${category}" has an invalid phone number: ${route.sms_from_number}`,
      );
    }
    return { fromNumber: normalized, jwt: route.jwt };
  }

  // ── Path B: no category → legacy env-var path ──
  const fromNumber = await getRCFromNumber(supabase);
  if (!fromNumber) {
    throw new Error("RingCentral from number not configured");
  }
  const jwt = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
  if (!jwt) {
    throw new Error(
      "RingCentral JWT not configured (RINGCENTRAL_JWT_TOKEN env var missing)",
    );
  }
  return { fromNumber, jwt };
}

export async function getRCFromNumber(
  supabase: any,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ringcentral_from_number")
      .single();

    if (data?.value) {
      const val =
        typeof data.value === "string" ? data.value : String(data.value);
      const digits = val.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      if (val.startsWith("+")) return val;
      return val;
    }
  } catch (err) {
    console.warn(
      "[getRCFromNumber] Failed to read from app_settings, using env fallback:",
      (err as Error).message,
    );
  }
  return Deno.env.get("RINGCENTRAL_FROM_NUMBER") || null;
}

// ─── SMS Send with Idempotent Single Retry on 429 ────────────────────────────
//
// RingCentral's SMS group is throttled at 40 requests / 60s (per extension)
// with a 30s penalty interval. Even with the call sites paced to stay under
// that limit, transient bursts (e.g. another process sharing the same
// extension, or a cron that overlaps an interactive bulk send) can briefly
// push us over and trigger a 429. When that happens we want to wait out the
// penalty and try once more, instead of dropping the send.
//
// Idempotency reasoning — read carefully before changing:
//
//   We ONLY retry on an explicit HTTP 429 response from RingCentral. A 429
//   means RC's rate limiter rejected the request before the message reached
//   their delivery pipeline — the SMS was NOT accepted, NOT queued, and NOT
//   delivered. RingCentral does not maintain a "deferred queue" for 429'd
//   sends; a rejected request is simply gone, which is why we have to retry
//   ourselves.
//
//   We deliberately do NOT retry on:
//     • Network errors / fetch rejections / timeouts — the request may have
//       reached RC and been accepted before the connection dropped; retrying
//       could deliver the SMS twice.
//     • 5xx server errors — RC may have processed the message before failing
//       to respond; retrying could double-send.
//     • Non-429 4xx (400, 401, 403, …) — these indicate a permanent problem
//       (bad credentials, bad payload, invalid number) that a retry can't fix.
//
//   In short: the only condition under which we are CERTAIN no message was
//   transmitted is a 429 response. Retrying is safe exactly there, and
//   nowhere else.
//
// Bounded loop: exactly ONE retry, hardcoded. There is no parameter to crank
// it up to "retry forever". After the second attempt the function returns
// whatever Response RC sent (could be 200, 429, anything) and the caller
// decides what to do with the failure. Combined with the existing cron-level
// "did we already bump last_reminder_sent_at?" gate in automation-cron, this
// means a permanently-throttled caregiver gets at most two SMS attempts per
// cron tick, then waits the configured interval_hours before being eligible
// again — capped by the rule's max_reminders.
const RC_SMS_RETRY_WAIT_MS = 35_000; // RC's 30s penalty interval + 5s margin

export async function sendSmsToRingCentralWithRetry(
  accessToken: string,
  fromNumber: string,
  toNumber: string,
  text: string,
): Promise<Response> {
  const doSend = (): Promise<Response> =>
    fetch(`${RC_API_URL}/restapi/v1.0/account/~/extension/~/sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        from: { phoneNumber: fromNumber },
        to: [{ phoneNumber: toNumber }],
        text,
      }),
    });

  const first = await doSend();
  if (first.status !== 429) return first;

  console.warn(
    `[RC SMS] 429 on first attempt to ${toNumber}; waiting ${RC_SMS_RETRY_WAIT_MS}ms before single retry`,
  );
  await new Promise((r) => setTimeout(r, RC_SMS_RETRY_WAIT_MS));
  return doSend();
}

export async function fetchRCMessages(
  accessToken: string,
  phoneNumber: string,
  daysBack: number,
): Promise<any[]> {
  const dateFrom = new Date(Date.now() - daysBack * 86400000).toISOString();
  const url = `${RC_API_URL}/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&phoneNumber=${encodeURIComponent(phoneNumber)}&dateFrom=${dateFrom}&perPage=100`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(
      `RC Message Store API error (${response.status}): ${err}`,
    );
  }

  const data = await response.json();
  return data.records || [];
}

export async function fetchRCCallLog(
  accessToken: string,
  phoneNumber: string,
  daysBack: number,
): Promise<any[]> {
  const dateFrom = new Date(Date.now() - daysBack * 86400000).toISOString();
  const url = `${RC_API_URL}/restapi/v1.0/account/~/extension/~/call-log?phoneNumber=${encodeURIComponent(phoneNumber)}&dateFrom=${dateFrom}&type=Voice&perPage=100&view=Detailed`;

  console.log(
    `[get_call_log] Fetching calls for ${phoneNumber}, daysBack=${daysBack}`,
  );

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`RC Call Log API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  console.log(
    `[get_call_log] Found ${data.records?.length || 0} records with phoneNumber filter`,
  );

  if (!data.records || data.records.length === 0) {
    console.log(
      `[get_call_log] No results with filter, trying client-side filtering...`,
    );
    const allUrl = `${RC_API_URL}/restapi/v1.0/account/~/extension/~/call-log?dateFrom=${dateFrom}&type=Voice&perPage=250&view=Detailed`;

    const allResponse = await fetch(allUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!allResponse.ok) {
      const err = await allResponse.text();
      throw new Error(`RC Call Log API error (${allResponse.status}): ${err}`);
    }

    const allData = await allResponse.json();
    const allRecords = allData.records || [];
    console.log(`[get_call_log] Total calls in period: ${allRecords.length}`);

    const targetDigits = phoneNumber.replace(/\D/g, "");
    const targetLast10 = targetDigits.slice(-10);

    const filtered = allRecords.filter((record: any) => {
      const legs = record.legs || [];
      for (const leg of legs) {
        const fromNum = leg.from?.phoneNumber?.replace(/\D/g, "") || "";
        const toNum = leg.to?.phoneNumber?.replace(/\D/g, "") || "";
        if (
          fromNum.slice(-10) === targetLast10 ||
          toNum.slice(-10) === targetLast10
        ) {
          return true;
        }
      }
      const fromNum = record.from?.phoneNumber?.replace(/\D/g, "") || "";
      const toNum = record.to?.phoneNumber?.replace(/\D/g, "") || "";
      return (
        fromNum.slice(-10) === targetLast10 ||
        toNum.slice(-10) === targetLast10
      );
    });

    console.log(
      `[get_call_log] Client-side filtered: ${filtered.length} matching calls`,
    );
    return filtered;
  }

  return data.records;
}
