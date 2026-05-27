import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  fetchRCCallLog,
  fetchRCMessages,
  getRingCentralAccessToken,
} from "../_shared/helpers/ringcentral.ts";

// ─── Configuration ─────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    const accessToken = await getRingCentralAccessToken();
    const [smsRecords, callRecords] = await Promise.all([
      fetchRCMessages(accessToken, contact.phone, Math.min(days_back, 90)),
      fetchRCCallLog(accessToken, contact.phone, Math.min(days_back, 90)),
    ]);

    return new Response(
      JSON.stringify({
        sms: transformSMS(smsRecords),
        calls: transformCalls(callRecords),
        caregiver_name: contact.name, // backward compat
        contact_name: contact.name,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("get-communications error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || "Internal error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
