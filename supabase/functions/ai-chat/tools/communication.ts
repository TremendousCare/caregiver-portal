// ─── Communication Tools (SMS & Call) ───
// send_sms (confirm), get_sms_history (auto), get_call_log (auto)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { RC_API_URL } from "../config.ts";
import { resolveCaregiver } from "../helpers/caregiver.ts";
import { normalizePhoneNumber } from "../helpers/phone.ts";
import {
  getRingCentralAccessToken,
  getRCFromNumber,
  fetchRCMessages,
  fetchRCCallLog,
} from "../helpers/ringcentral.ts";

// ── send_sms (confirm) ──

registerTool(
  {
    name: "send_sms",
    description:
      "Send a real SMS text message to a caregiver via RingCentral. REQUIRES USER CONFIRMATION. The message will actually be sent to their phone. After sending, the message is auto-logged as a note on the caregiver record.",
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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
    if (!input.message || input.message.trim().length === 0) return { error: "Message text is required." };
    if (input.message.length > 1000) return { error: "Message too long (max 1000 characters)." };
    if (!cg.phone) return { error: `Cannot send SMS: no phone number on file for ${cg.first_name} ${cg.last_name}. Please update their phone number first.` };
    const normalized = normalizePhoneNumber(cg.phone);
    if (!normalized) return { error: `Cannot send SMS: invalid phone number format "${cg.phone}" for ${cg.first_name} ${cg.last_name}. Expected a 10-digit US number.` };
    const fromNumber = await getRCFromNumber(ctx.supabase);
    return {
      requires_confirmation: true,
      action: "send_sms",
      summary: `**Send SMS to ${cg.first_name} ${cg.last_name}**\n\n**To:** ${normalized}\n**From:** ${fromNumber || "(not configured)"}\n\n**Message:**\n${input.message}`,
      caregiver_id: cg.id,
      params: { message: input.message, normalized_phone: normalized },
    };
  },
  // Confirmed handler
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const { data: cg, error: fetchErr } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
    if (fetchErr || !cg) return { error: "Caregiver not found." };
    const { message, normalized_phone } = params;
    const fromNumber = await getRCFromNumber(supabase);
    if (!fromNumber) return { error: "RingCentral from number not configured. Set it in Settings > RingCentral." };
    let accessToken: string;
    try {
      accessToken = await getRingCentralAccessToken();
    } catch (err) {
      return { error: `Failed to connect to SMS service: ${(err as Error).message}` };
    }
    try {
      const smsResponse = await fetch(`${RC_API_URL}/restapi/v1.0/account/~/extension/~/sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ from: { phoneNumber: fromNumber }, to: [{ phoneNumber: normalized_phone }], text: message }),
      });
      if (!smsResponse.ok) {
        const errorText = await smsResponse.text();
        if (smsResponse.status === 429) return { error: "SMS rate limit reached. Please try again in a few minutes." };
        throw new Error(`RingCentral API error (${smsResponse.status}): ${errorText}`);
      }
      const smsNote = { text: message, type: "text", direction: "outbound", outcome: "sent via RingCentral", timestamp: Date.now(), author: currentUser || "AI Assistant" };
      await supabase.from("caregivers").update({ notes: [...(cg.notes || []), smsNote] }).eq("id", caregiverId);
      return { success: true, message: `SMS sent to ${cg.first_name} ${cg.last_name} at ${normalized_phone}. Message logged to their record.` };
    } catch (err) {
      console.error("RC SMS error:", err);
      return { error: `Failed to send SMS: ${(err as Error).message}` };
    }
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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
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
  },
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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
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
          const hasRecording = call.recording ? " [Recorded]" : "";
          return `[${date}] ${direction} | ${result} | Duration: ${durStr}${hasRecording}`;
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
  },
);
