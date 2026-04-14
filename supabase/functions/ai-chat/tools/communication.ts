// ─── Communication Tools (SMS & Call) ───
// send_sms (confirm), get_sms_history (auto), get_call_log (auto), get_call_recording (auto), get_call_transcription (auto)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { RC_API_URL } from "../config.ts";
import { normalizePhoneNumber } from "../helpers/phone.ts";
import { requireCaregiver, withResolve } from "../helpers/resolve.ts";
import {
  getRingCentralAccessToken,
  fetchRCMessages,
  fetchRCCallLog,
} from "../helpers/ringcentral.ts";
import { sendSMS } from "../../_shared/operations/sms.ts";

/**
 * Resolve a smart-default category for an AI-initiated SMS send based on
 * the caregiver's employment status. Mirrors the SMSComposeBar frontend
 * logic so AI sends feel consistent with manual sends:
 *   - Onboarding or no employmentStatus → 'onboarding' (if the route is
 *     configured and has a JWT)
 *   - Otherwise → the is_default route
 *   - If no routes exist or none are configured → null (fall through to
 *     legacy env-var path)
 *
 * Returns { category, routeLabel, phone } for inclusion in the confirmation
 * summary so the user can see which number the AI plans to send from.
 */
async function resolveSmartRoute(
  supabase: any,
  caregiver: any,
): Promise<{ category: string | null; routeLabel: string; phone: string | null }> {
  try {
    const { data: routes, error } = await supabase
      .from("communication_routes")
      .select("category, label, is_default, sms_from_number, sms_vault_secret_name")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (error) throw error;

    const list = routes || [];
    const isConfigured = (r: any) => !!(r?.sms_vault_secret_name && r?.sms_from_number);
    const configured = list.filter(isConfigured);

    // Zero or one configured routes → no decision, use legacy path
    if (configured.length < 2) return { category: null, routeLabel: "(default)", phone: null };

    const isOnboarding = !caregiver.employment_status || caregiver.employment_status === "onboarding";
    if (isOnboarding) {
      const onboarding = list.find(
        (r: any) => r.category === "onboarding" && isConfigured(r),
      );
      if (onboarding) {
        return {
          category: onboarding.category,
          routeLabel: onboarding.label,
          phone: onboarding.sms_from_number,
        };
      }
    }
    const def = list.find((r: any) => r.is_default && isConfigured(r));
    if (def) {
      return { category: def.category, routeLabel: def.label, phone: def.sms_from_number };
    }
    const first = configured[0];
    return { category: first.category, routeLabel: first.label, phone: first.sms_from_number };
  } catch (err) {
    console.warn("[send_sms] route lookup failed, falling back to legacy:", (err as Error).message);
    return { category: null, routeLabel: "(default)", phone: null };
  }
}

// ── send_sms (confirm) ──

registerTool(
  {
    name: "send_sms",
    description:
      "Send a real SMS text message to a caregiver via RingCentral. REQUIRES USER CONFIRMATION. The message will actually be sent to their phone. The sending number is selected automatically based on the caregiver's onboarding status (Onboarding route for caregivers in the pipeline, General otherwise), so the AI does not need to pick one. After sending, the message is auto-logged as a note on the caregiver record.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        message: { type: "string", description: "The SMS message text to send (max 1000 characters). Be professional and clear." },
      },
      required: ["message"],
    },
    riskLevel: "confirm",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    if (!input.message || input.message.trim().length === 0) return { error: "Message text is required." };
    if (input.message.length > 1000) return { error: "Message too long (max 1000 characters)." };
    if (!cg.phone) return { error: `Cannot send SMS: no phone number on file for ${cg.first_name} ${cg.last_name}. Please update their phone number first.` };
    const normalized = normalizePhoneNumber(cg.phone);
    if (!normalized) return { error: `Cannot send SMS: invalid phone number format "${cg.phone}" for ${cg.first_name} ${cg.last_name}. Expected a 10-digit US number.` };

    const route = await resolveSmartRoute(ctx.supabase, cg);
    const fromDisplay = route.phone
      ? `${route.phone} (${route.routeLabel})`
      : "(default)";

    return {
      requires_confirmation: true,
      action: "send_sms",
      summary: `**Send SMS to ${cg.first_name} ${cg.last_name}**\n\n**To:** ${normalized}\n**From:** ${fromDisplay}\n\n**Message:**\n${input.message}`,
      caregiver_id: cg.id,
      params: {
        message: input.message,
        normalized_phone: normalized,
        category: route.category,
      },
    };
  }),
  // Confirmed handler — delegates to shared operation
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const result = await sendSMS(
      supabase,
      caregiverId,
      params.message,
      params.normalized_phone,
      currentUser,
      params.category || null,
    );
    return result.success ? { success: true, message: result.message } : { error: result.error };
  },
);

// ── get_sms_history (auto) ──

registerTool(
  {
    name: "get_sms_history",
    description:
      "Get the SMS text message history between the company and a caregiver from RingCentral. Shows the full conversation thread with dates, direction, and message text.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        days_back: { type: "number", description: "Number of days to look back (default 30, max 90)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    if (!cg.phone) return { error: `No phone number on file for ${cg.first_name} ${cg.last_name}. Cannot retrieve SMS history.` };
    const normalized = normalizePhoneNumber(cg.phone);
    if (!normalized) return { error: `Invalid phone number format "${cg.phone}" for ${cg.first_name} ${cg.last_name}.` };
    const daysBack = Math.min(input.days_back || 30, 90);
    try {
      const accessToken = await getRingCentralAccessToken();
      const records = await fetchRCMessages(accessToken, normalized, daysBack);

      // Build unified timeline: RC API messages + webhook-logged inbound notes
      const cutoff = Date.now() - daysBack * 86400000;
      const unified: { timestamp: number; direction: string; text: string; source: string }[] = [];

      // Add RC API messages
      for (const msg of records) {
        unified.push({
          timestamp: new Date(msg.creationTime).getTime(),
          direction: msg.direction === "Inbound" ? "inbound" : "outbound",
          text: msg.subject || "(no text)",
          source: "rc_api",
        });
      }

      // Add webhook-logged inbound SMS from caregiver notes
      const notes = cg.notes || [];
      for (const note of notes) {
        if (typeof note === "string") continue;
        if (note.source !== "ringcentral" || note.type !== "text") continue;
        const noteTime = typeof note.timestamp === "number" ? note.timestamp : new Date(note.timestamp).getTime();
        if (noteTime < cutoff) continue;
        // Dedup: skip if an RC API message exists within 2 minutes with same direction
        const isDup = unified.some(
          (m) => m.direction === (note.direction || "inbound") && Math.abs(m.timestamp - noteTime) < 120000,
        );
        if (!isDup) {
          unified.push({
            timestamp: noteTime,
            direction: note.direction || "inbound",
            text: note.text || "(no text)",
            source: "webhook",
          });
        }
      }

      // Sort chronologically and format
      unified.sort((a, b) => a.timestamp - b.timestamp);
      const messages = unified.slice(-50).map((m) => {
        const date = new Date(m.timestamp).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
        const direction = m.direction === "inbound" ? "\u2190 INBOUND" : "\u2192 OUTBOUND";
        return `[${date}] ${direction}: ${m.text}`;
      });

      return {
        caregiver: `${cg.first_name} ${cg.last_name}`,
        phone: normalized,
        days_searched: daysBack,
        total_messages: messages.length,
        conversation: messages.length > 0 ? messages : ["No SMS messages found in the last " + daysBack + " days."],
      };
    } catch (err) {
      console.error("get_sms_history error:", err);
      return { error: `Failed to retrieve SMS history: ${(err as Error).message}` };
    }
  }),
);

// ── get_call_log (auto) ──

registerTool(
  {
    name: "get_call_log",
    description:
      "Get the call history between the company and a caregiver from RingCentral. Shows calls with date, direction, duration, and result (Connected, Missed, Voicemail, etc.).",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        days_back: { type: "number", description: "Number of days to look back (default 30, max 90)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    if (!cg.phone) return { error: `No phone number on file for ${cg.first_name} ${cg.last_name}. Cannot retrieve call log.` };
    const normalized = normalizePhoneNumber(cg.phone);
    if (!normalized) return { error: `Invalid phone number format "${cg.phone}" for ${cg.first_name} ${cg.last_name}.` };
    const daysBack = Math.min(input.days_back || 30, 90);
    try {
      const accessToken = await getRingCentralAccessToken();
      const records = await fetchRCCallLog(accessToken, normalized, daysBack);
      const calls = records
        .sort((a: any, b: any) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
        .slice(-50)
        .map((call: any) => {
          const date = new Date(call.startTime).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
          const direction = call.direction === "Inbound" ? "\u2190 INBOUND" : "\u2192 OUTBOUND";
          const result = call.result || "Unknown";
          const dur = call.duration || 0;
          const durStr = dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`;
          const recordingInfo = call.recording ? ` [Recorded - ID: ${call.recording.id}]` : "";
          return `[${date}] ${direction} | ${result} | Duration: ${durStr}${recordingInfo}`;
        });
      return {
        caregiver: `${cg.first_name} ${cg.last_name}`,
        phone: normalized,
        days_searched: daysBack,
        summary: {
          total_calls: records.length,
          inbound: records.filter((c: any) => c.direction === "Inbound").length,
          outbound: records.filter((c: any) => c.direction === "Outbound").length,
          connected: records.filter((c: any) => c.result === "Call connected" || c.result === "Accepted").length,
          missed: records.filter((c: any) => c.result === "Missed").length,
          voicemail: records.filter((c: any) => c.result === "Voicemail").length,
        },
        calls: calls.length > 0 ? calls : ["No calls found in the last " + daysBack + " days."],
      };
    } catch (err) {
      console.error("get_call_log error:", err);
      return { error: `Failed to retrieve call log: ${(err as Error).message}` };
    }
  }),
);

// ── get_call_recording (auto) ──

registerTool(
  {
    name: "get_call_recording",
    description:
      "Get a playable recording URL for a specific call recording from RingCentral. Use this when a user asks to hear or play a call recording. The recording ID can be found in the get_call_log output (shown as [Recorded - ID: 123456]).",
    input_schema: {
      type: "object",
      properties: {
        recording_id: {
          type: "string",
          description: "The RingCentral recording ID (numeric string from get_call_log output)",
        },
      },
      required: ["recording_id"],
    },
    riskLevel: "auto",
  },
  async (input: any, _ctx: ToolContext): Promise<ToolResult> => {
    const recordingId = input.recording_id;
    if (!recordingId) return { error: "recording_id is required." };

    // Validate format (numeric only)
    if (!/^\d+$/.test(recordingId)) {
      return { error: "Invalid recording ID format. Must be numeric." };
    }

    try {
      const accessToken = await getRingCentralAccessToken();

      // Verify the recording exists by fetching its metadata
      const rcUrl = `${RC_API_URL}/restapi/v1.0/account/~/recording/${recordingId}`;
      const response = await fetch(rcUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        return { error: `Recording ${recordingId} not found or unavailable.` };
      }

      const recordingData = await response.json();
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";

      return {
        recording_id: recordingId,
        recording_url: `${supabaseUrl}/functions/v1/call-recording?recordingId=${recordingId}`,
        duration_seconds: recordingData.duration || null,
        type: recordingData.type || "Unknown",
        note: "The user can play this recording from the Activity Log in the caregiver or client profile. The recording is also available at the URL above (requires portal authentication).",
      };
    } catch (err) {
      console.error("get_call_recording error:", err);
      return { error: `Failed to retrieve recording: ${(err as Error).message}` };
    }
  },
);

// ── get_call_transcription (auto) ──

registerTool(
  {
    name: "get_call_transcription",
    description:
      "Get the text transcript of a recorded call using AI speech-to-text. The recording ID can be found in the get_call_log output (shown as [Recorded - ID: 123456]). First-time transcription may take a few seconds; subsequent requests return instantly from cache.",
    input_schema: {
      type: "object",
      properties: {
        recording_id: {
          type: "string",
          description: "The RingCentral recording ID (numeric string from get_call_log output)",
        },
      },
      required: ["recording_id"],
    },
    riskLevel: "auto",
  },
  async (input: any, _ctx: ToolContext): Promise<ToolResult> => {
    const recordingId = input.recording_id;
    if (!recordingId) return { error: "recording_id is required." };

    if (!/^\d+$/.test(recordingId)) {
      return { error: "Invalid recording ID format. Must be numeric." };
    }

    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

      // Call the call-transcription Edge Function internally
      const url = `${supabaseUrl}/functions/v1/call-transcription?recordingId=${recordingId}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${serviceKey}` },
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: "Transcription failed" }));
        return { error: errData.error || `Transcription failed (HTTP ${response.status})` };
      }

      const data = await response.json();
      return {
        recording_id: recordingId,
        transcript: data.transcript || "(No speech detected)",
        duration_seconds: data.duration_seconds,
        language: data.language,
        cached: data.cached,
        note: "This is an AI-generated transcript. It may contain minor inaccuracies.",
      };
    } catch (err) {
      console.error("get_call_transcription error:", err);
      return { error: `Failed to transcribe recording: ${(err as Error).message}` };
    }
  },
);
