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

// ── Cross-isolate token store ─────────────────────────────────────────
// The in-memory Map above only survives within a single Edge Function
// isolate. Under concurrent load each cold-start isolate would mint its
// own token and trip RingCentral's CMN-301 auth throttle (~5 mints/60s per
// app). This store persists minted tokens in Postgres so every isolate
// reuses one token for its full ~1h lifetime. Keyed by a SHA-256 hash of
// the JWT so the raw secret is never written. See migration
// 20260601020000_ringcentral_token_cache.sql.
export type RcTokenStore = {
  read: (jwtHash: string) => Promise<RcTokenCacheEntry | null>;
  write: (jwtHash: string, entry: RcTokenCacheEntry) => Promise<void>;
};

// Tests inject a fake store via _setRcTokenStoreForTests; production builds
// the Supabase-backed store lazily. The dynamic import + Deno.env reads live
// inside the store methods so the jsr: specifier and the Deno global stay
// out of Node/Vitest's static module graph.
let injectedTokenStore: RcTokenStore | null = null;
export function _setRcTokenStoreForTests(store: RcTokenStore | null) {
  injectedTokenStore = store;
}

// Test-only: reset the caches between cases. Not part of the public API.
export function _resetRcTokenCacheForTests() {
  rcTokenCache.clear();
  rcTokenInFlight.clear();
  injectedTokenStore = null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Lazily-built, isolate-scoped service-role client. Only constructed when a
// real DB read/write is needed (i.e. on an in-memory cache miss), and never
// in tests because they inject a store instead.
let lazyServiceClient: Promise<unknown | null> | null = null;
function getServiceClient(): Promise<unknown | null> {
  if (lazyServiceClient) return lazyServiceClient;
  lazyServiceClient = (async () => {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return null;
    // Specifier is held in a variable + @vite-ignore so the bundler used by
    // the Node/Vitest test runner doesn't try to resolve this Deno-only
    // module. This path only executes under Deno (where the jsr: import is
    // native); in tests a fake store is injected and this is never reached.
    const specifier = "jsr:@supabase/supabase-js@2";
    const { createClient } = await import(/* @vite-ignore */ specifier);
    return createClient(url, key);
  })();
  return lazyServiceClient;
}

function supabaseTokenStore(): RcTokenStore {
  return {
    // Best-effort: any failure (no env, table missing, network) returns null
    // so the caller falls back to minting. The cache must never be the reason
    // a token can't be obtained.
    async read(jwtHash) {
      try {
        // deno-lint-ignore no-explicit-any
        const supabase = (await getServiceClient()) as any;
        if (!supabase) return null;
        const { data, error } = await supabase
          .from("ringcentral_token_cache")
          .select("access_token, expires_at")
          .eq("jwt_hash", jwtHash)
          .maybeSingle();
        if (error || !data) return null;
        return {
          token: data.access_token,
          expiresAt: new Date(data.expires_at).getTime(),
        };
      } catch {
        return null;
      }
    },
    async write(jwtHash, entry) {
      try {
        // deno-lint-ignore no-explicit-any
        const supabase = (await getServiceClient()) as any;
        if (!supabase) return;
        await supabase.from("ringcentral_token_cache").upsert(
          {
            jwt_hash: jwtHash,
            access_token: entry.token,
            expires_at: new Date(entry.expiresAt).toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "jwt_hash" },
        );
      } catch {
        // A failed write just means the next cold isolate mints once more.
      }
    },
  };
}

function getTokenStore(): RcTokenStore {
  return injectedTokenStore ?? supabaseTokenStore();
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

  // ── 1. In-memory cache (fastest; lives only within this isolate) ──
  const cached = rcTokenCache.get(jwt);
  if (cached && Date.now() < cached.expiresAt - RC_TOKEN_SAFETY_MS) {
    return cached.token;
  }

  // ── 2. In-flight de-dupe ──
  // Wrap the whole "check shared store, then maybe mint" sequence in one
  // promise so concurrent callers in this isolate share a single mint
  // rather than racing past the cache checks and each hitting RC.
  const inFlight = rcTokenInFlight.get(jwt);
  if (inFlight) return inFlight;

  const work = (async (): Promise<string> => {
    try {
      const store = getTokenStore();
      const jwtHash = await sha256Hex(jwt);

      // ── 3. Cross-isolate cache (Postgres) ──
      // A cold isolate has an empty in-memory map but a sibling isolate may
      // have already minted a still-valid token. Reusing it here is what
      // keeps us under RingCentral's CMN-301 auth throttle.
      const persisted = await store.read(jwtHash);
      if (persisted && Date.now() < persisted.expiresAt - RC_TOKEN_SAFETY_MS) {
        rcTokenCache.set(jwt, persisted);
        return persisted.token;
      }

      // ── 4. Mint a fresh token ──
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
        const error = await response.text();
        // 429 / CMN-301: the auth bucket is exhausted. A sibling isolate may
        // have minted a token in the meantime — re-check the shared store
        // before giving up so a thundering herd at token expiry doesn't turn
        // into a wall of failures (the exact lockout that took transcription
        // and get-communications down together on 2026-05-29).
        if (response.status === 429) {
          const recovered = await store.read(jwtHash);
          if (
            recovered &&
            Date.now() < recovered.expiresAt - RC_TOKEN_SAFETY_MS
          ) {
            rcTokenCache.set(jwt, recovered);
            return recovered.token;
          }
        }
        throw new Error(`RingCentral auth failed (${response.status}): ${error}`);
      }

      const data = await response.json();
      const expiresInSec =
        typeof data.expires_in === "number" && data.expires_in > 0
          ? data.expires_in
          : 3600;
      const entry: RcTokenCacheEntry = {
        token: data.access_token,
        expiresAt: Date.now() + expiresInSec * 1000,
      };
      rcTokenCache.set(jwt, entry);
      // Publish to the shared store so sibling isolates skip minting.
      await store.write(jwtHash, entry);
      return data.access_token;
    } finally {
      rcTokenInFlight.delete(jwt);
    }
  })();

  rcTokenInFlight.set(jwt, work);
  return work;
}

// Detect whether an error (or error message) is a RingCentral rate-limit
// rejection — HTTP 429, error code CMN-301 ("Request rate exceeded"), or a
// "rate limit/exceeded" phrase. Callers driving batched RC API calls (the
// post-call-processor cron, the transcript-backfill tool) use this to STOP
// hammering the moment they're throttled: every further request inside the
// penalty window just re-arms RingCentral's 60s penalty, which is exactly
// the loop that kept recording/content pinned at a ~88% error rate and
// blocked transcription from draining.
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    /\b429\b/.test(msg) ||
    /CMN-301/i.test(msg) ||
    /rate.{0,3}(limit|exceed)/i.test(msg)
  );
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

// ─── RingSense Insights (native transcription) ───────────────────────────────
//
// Pulls the AI-generated transcript + metadata for a recorded call from
// RingSense, RingCentral's first-party conversation intelligence service.
// This is the cheap, license-included alternative to sending the raw audio
// to OpenAI Whisper. The org's per-org transcription_provider column in
// communication_voice_config picks which path call-transcription /
// post-call-processor use.
//
// Endpoint shape (RingSense API, currently beta):
//   GET /ai/ringsense/v1/public/accounts/~/domains/pbx/records/{recordingId}/insights
// Requires the `RingSense` OAuth scope on the calling app PLUS a
// "RingSense for Sales - Access Insights" user permission on the JWT's
// extension. The org's RC plan must include RingSense (license-based).
//
// Timing: RingSense processes recordings asynchronously after the call
// ends. There's no published SLA — typically minutes, occasionally longer
// for long calls. Until processing finishes, the endpoint returns either
// 404 or 200-with-empty-insights. Callers should treat both as
// "not ready yet, retry later" rather than a hard failure. The
// post-call-processor cron's existing soft-failure path (transcript_
// fetched_at stays NULL, retries each tick, gives up after 24h) handles
// this naturally.
//
// Returns null on any "transcript not available" condition (404, empty
// insights, no transcript field on the response). Throws on hard
// failures (403 missing scope, 5xx, network) so callers can distinguish
// "wait and retry" from "configuration is broken".
export type RingSenseInsights = {
  transcript: string;
  duration_seconds: number | null;
  language: string | null;
};

export async function fetchRingSenseInsights(
  accessToken: string,
  recordingId: string,
): Promise<RingSenseInsights | null> {
  const url =
    `${RC_API_URL}/ai/ringsense/v1/public/accounts/~/domains/pbx/records/` +
    `${encodeURIComponent(recordingId)}/insights`;

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // 404 → recording not yet processed by RingSense (or RingSense has no
  // record of it). Treat as "not ready", let the caller retry later.
  if (response.status === 404) return null;

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `RingSense insights fetch failed (${response.status}): ${errText}`,
    );
  }

  const data = await response.json().catch(() => null);
  if (!data) return null;

  // Insights payload layout (per RC API docs): the call body lives at the
  // top level, and `insights` is an array of typed objects — at least one
  // per category (Transcript, Summary, Highlight, etc.). The transcript
  // object carries a `transcript` field that's an array of segments:
  //   { speakerId, startTime, endTime, text }
  // Speakers are identified by id; `speakerInfo` at the body level maps
  // ids to names. We flatten to a single text string here because the
  // call_transcriptions table stores `transcript text` and downstream
  // consumers (post-call-processor note append, ai_summary extractor)
  // operate on plain text.
  const insights: any[] = Array.isArray(data.insights) ? data.insights : [];
  const transcriptInsight = insights.find(
    (ins) =>
      Array.isArray(ins?.transcript) ||
      (ins?.type === "Transcript" && Array.isArray(ins?.transcript)),
  );
  const segments: any[] = Array.isArray(transcriptInsight?.transcript)
    ? transcriptInsight.transcript
    : [];

  if (segments.length === 0) return null;

  const speakerInfo: any[] = Array.isArray(data.speakerInfo)
    ? data.speakerInfo
    : [];
  const speakerLabel = (speakerId: unknown): string => {
    if (speakerId == null) return "";
    const found = speakerInfo.find(
      (s: any) =>
        s?.speakerId === speakerId ||
        s?.id === speakerId ||
        String(s?.speakerId) === String(speakerId),
    );
    const name = found?.name || found?.displayName;
    return name ? String(name) : `Speaker ${speakerId}`;
  };

  const lines: string[] = [];
  let lastSpeakerKey: string | null = null;
  for (const seg of segments) {
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!text) continue;
    const label = speakerLabel(seg?.speakerId);
    if (label !== lastSpeakerKey) {
      lines.push(`${label}: ${text}`);
      lastSpeakerKey = label;
    } else {
      // Same speaker continuing — append without re-printing the label.
      lines[lines.length - 1] += " " + text;
    }
  }

  const transcript = lines.join("\n").trim();
  if (!transcript) return null;

  // duration_seconds: RC publishes recordingDurationMs at the body root.
  const durationMs =
    typeof data.recordingDurationMs === "number"
      ? data.recordingDurationMs
      : null;
  const duration_seconds =
    durationMs != null ? Math.round(durationMs / 1000) : null;

  // language: RingSense doesn't always emit one; fall back to null and
  // let the column accept it. call-transcription's prior Whisper code
  // defaulted to 'en' — we deliberately do NOT default here so we don't
  // silently mislabel non-English calls. If callers need a default, they
  // can apply one at the write site.
  const language =
    typeof data.language === "string" && data.language ? data.language : null;

  return { transcript, duration_seconds, language };
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
