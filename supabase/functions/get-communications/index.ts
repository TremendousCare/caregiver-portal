import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  fetchRCCallLog,
  fetchRCMessages,
  getRingCentralAccessToken,
} from "../_shared/helpers/ringcentral.ts";
import { isRateLimitError } from "../_shared/operations/rateLimit.ts";

// ─── Configuration ─────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Result cache + in-flight dedup ────────────────
// This function reads from RingCentral's "Heavy" API group (message-store +
// call-log), capped at 10 requests / 60s per extension with a 60s penalty,
// shared with every other consumer on the same extension. It is called on
// EVERY client/caregiver/lead page open — and React re-renders, multiple
// staff viewing the same record, and rapid tab switches multiply that into
// bursts of identical reads against a tiny ceiling. That is what helped park
// the bucket in penalty and blank the Messages tab.
//
// Two guards, both keyed by normalized phone + days_back:
//   1. A short-TTL response cache. A contact's recent comm history doesn't
//      change second-to-second; serving repeat opens from cache for 60s
//      removes the vast majority of redundant Heavy calls. Inbound SMS still
//      lands live via the webhook (which writes to entity notes), so the
//      cache TTL only delays when *externally-originated* history surfaces in
//      this live pane, never whether it arrives.
//   2. In-flight dedup: concurrent requests for the same key share one
//      upstream fetch instead of each firing their own pair of Heavy calls.
//
// Module-level maps persist for the lifetime of the warm isolate — the same
// pattern the shared RC token cache uses.
const COMMS_CACHE_TTL_MS = 60_000;
type CommsPayload = { sms: any[]; calls: any[] };
type CommsCacheEntry = { payload: CommsPayload; expiresAt: number };
const commsCache = new Map<string, CommsCacheEntry>();
const commsInFlight = new Map<string, Promise<CommsPayload>>();

// Test-only: reset module caches between cases. Not part of the public API.
export function _resetCommsCacheForTests() {
  commsCache.clear();
  commsInFlight.clear();
}

// ─── Phone helpers ─────────────────────────────────
function normalizePhoneNumber(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ─── Transform helpers ─────────────────────────────
function transformSMS(records: any[]): any[] {
  return records.map((msg) => ({
    id: `rc-sms-${msg.id}`,
    type: "text",
    source: "ringcentral",
    direction: msg.direction === "Inbound" ? "inbound" : "outbound",
    timestamp: msg.creationTime || msg.lastModifiedTime,
    text: msg.subject || "",
    status: msg.messageStatus || msg.readStatus || "",
  }));
}

function transformCalls(records: any[]): any[] {
  return records.map((call) => {
    const duration = call.duration || 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = duration > 0 ? `${mins}m ${secs}s` : "0s";
    return {
      id: `rc-call-${call.id}`,
      type: "call",
      source: "ringcentral",
      direction: call.direction === "Inbound" ? "inbound" : "outbound",
      timestamp: call.startTime,
      text: `Phone Call - ${call.result || "Unknown"} (${durationStr})`,
      result: call.result || "Unknown",
      duration,
      durationStr,
      hasRecording: !!(call.recording && call.recording.id),
      recordingId: call.recording?.id || null,
    };
  });
}

// ─── Resolve phone number from any entity ──────────
// Supports three lookup modes:
//   1. phone         — use directly (client/caregiver detail page passes phone)
//   2. caregiver_id  — look up from caregivers table (with client fallback)
//   3. client_id     — look up from clients table
async function resolveContact(
  supabase: any,
  params: { caregiver_id?: string; client_id?: string; phone?: string },
): Promise<{ phone: string | null; name: string }> {
  if (params.phone) {
    return { phone: normalizePhoneNumber(params.phone), name: "Contact" };
  }

  if (params.caregiver_id) {
    const { data: caregiver } = await supabase
      .from("caregivers")
      .select("phone, first_name, last_name")
      .eq("id", params.caregiver_id)
      .single();
    if (caregiver) {
      return {
        phone: normalizePhoneNumber(caregiver.phone),
        name:
          `${caregiver.first_name || ""} ${caregiver.last_name || ""}`.trim() ||
          "Caregiver",
      };
    }
    // Fallback: maybe it's actually a client id passed as caregiver_id
    const { data: client } = await supabase
      .from("clients")
      .select("phone, first_name, last_name")
      .eq("id", params.caregiver_id)
      .single();
    if (client) {
      return {
        phone: normalizePhoneNumber(client.phone),
        name:
          `${client.first_name || ""} ${client.last_name || ""}`.trim() ||
          "Client",
      };
    }
    return { phone: null, name: "Unknown" };
  }

  if (params.client_id) {
    const { data: client } = await supabase
      .from("clients")
      .select("phone, first_name, last_name")
      .eq("id", params.client_id)
      .single();
    if (client) {
      return {
        phone: normalizePhoneNumber(client.phone),
        name:
          `${client.first_name || ""} ${client.last_name || ""}`.trim() ||
          "Client",
      };
    }
    return { phone: null, name: "Unknown" };
  }

  return { phone: null, name: "Unknown" };
}

// ─── Main handler ──────────────────────────────────
//
// Reads SMS + call history from RingCentral for a single contact phone.
// Auth flows through the shared `getRingCentralAccessToken` which keeps
// a per-JWT cache (~1h TTL with in-flight dedupe). Before this was wired
// up, each invocation issued a fresh /oauth/token POST, which under load
// drained RingCentral's per-extension 5-req/60s auth bucket and surfaced
// as CMN-301 "Request rate exceeded" — both here (the client message tab
// went blank with a "Could not load external communication data" banner)
// and on the webhook subscribe-retry button, which shares the same
// extension bucket as the main-line route.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { caregiver_id, client_id, phone: directPhone, days_back = 90 } =
      body;

    if (!caregiver_id && !client_id && !directPhone) {
      return new Response(
        JSON.stringify({
          error: "One of caregiver_id, client_id, or phone is required",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const contact = await resolveContact(supabase, {
      caregiver_id,
      client_id,
      phone: directPhone,
    });

    if (!contact.phone) {
      return new Response(
        JSON.stringify({
          sms: [],
          calls: [],
          caregiver_name: contact.name,
          contact_name: contact.name,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const daysBack = Math.min(days_back, 90);
    const cacheKey = `${contact.phone}:${daysBack}`;

    // 1. Serve from the short-TTL cache when warm.
    const cached = commsCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return jsonResponse({ ...cached.payload, ...nameFields(contact.name) });
    }

    // 2. Coalesce concurrent identical requests onto one upstream fetch.
    let fetchPromise = commsInFlight.get(cacheKey);
    if (!fetchPromise) {
      fetchPromise = (async (): Promise<CommsPayload> => {
        // Clean up the in-flight entry inside this async fn's own
        // try/finally rather than chaining `.finally()` on the returned
        // promise. A chained `.finally()` produces a SECOND promise that
        // rejects in lock-step on the upstream-failure path (e.g. the 429
        // we now surface); nothing observes it, so it fires an
        // unhandled-rejection. Cleaning up here keeps exactly one promise
        // (the one the handler awaits) and never leaks a floating reject.
        try {
          const accessToken = await getRingCentralAccessToken();
          // `false` skips the exhaustive 250-record call-log sweep — the
          // phoneNumber filter is RC's correct behavior and the sweep is a
          // second Heavy call per zero-history contact (see fetchRCCallLog).
          const [smsRecords, callRecords] = await Promise.all([
            fetchRCMessages(accessToken, contact.phone!, daysBack),
            fetchRCCallLog(accessToken, contact.phone!, daysBack, false),
          ]);
          const payload: CommsPayload = {
            sms: transformSMS(smsRecords),
            calls: transformCalls(callRecords),
          };
          commsCache.set(cacheKey, {
            payload,
            expiresAt: Date.now() + COMMS_CACHE_TTL_MS,
          });
          return payload;
        } finally {
          commsInFlight.delete(cacheKey);
        }
      })();
      commsInFlight.set(cacheKey, fetchPromise);
    }

    const payload = await fetchPromise;
    return jsonResponse({ ...payload, ...nameFields(contact.name) });
  } catch (err) {
    console.error("get-communications error:", err);
    // Distinguish RingCentral rate-limiting (CMN-301 / 429) from a true
    // server fault. The frontend renders the 429 path as "communication
    // history temporarily unavailable (rate limited)" instead of the
    // misleading "No text entries found", and can choose to back off rather
    // than retry into a bucket that's already in penalty.
    const rateLimited = isRateLimitError(err);
    return new Response(
      JSON.stringify({
        error: (err as Error).message || "Internal error",
        rate_limited: rateLimited,
      }),
      {
        status: rateLimited ? 429 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

// ─── Response helpers ──────────────────────────────
function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function nameFields(name: string): Record<string, string> {
  return { caregiver_name: name /* backward compat */, contact_name: name };
}
