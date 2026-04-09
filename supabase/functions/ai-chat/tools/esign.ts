// ─── eSignature Tools ───
// get_esign_envelopes (auto), send_esign_envelope (confirm)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { requireCaregiver, withResolve } from "../helpers/resolve.ts";
import { sendESignEnvelope } from "../../_shared/operations/esign.ts";

// ── get_esign_envelopes (auto) ──

registerTool(
  {
    name: "get_esign_envelopes",
    description:
      "Get eSignature envelope status for a caregiver. Shows all sent envelopes, their signing status, and timeline. Use when asked about signing status, eSign progress, or document signing history.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name to search for" },
      },
    },
    riskLevel: "auto",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);

    try {
      const { data: envelopes, error } = await ctx.supabase
        .from("esign_envelopes")
        .select("*")
        .eq("caregiver_id", cg.id)
        .order("sent_at", { ascending: false });

      if (error) throw error;
      if (!envelopes || envelopes.length === 0) {
        return { result: `No eSign envelopes found for ${cg.first_name} ${cg.last_name}. No documents have been sent for signature yet.` };
      }

      const statusLabels: Record<string, string> = {
        sent: "Sent (awaiting)",
        viewed: "Viewed (not yet signed)",
        signed: "Signed",
        declined: "Declined",
        expired: "Expired",
        voided: "Voided/Cancelled",
      };
      const lines = envelopes.map((e: any) => {
        const names = e.template_names?.length > 1
          ? `Full Packet (${e.template_names.length} docs)`
          : (e.template_names?.[0] || "eSign Envelope");
        const status = statusLabels[e.status] || e.status;
        const sentDate = e.sent_at ? new Date(e.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "N/A";
        const signedDate = e.signed_at ? new Date(e.signed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
        const sentBy = e.sent_by ? ` by ${e.sent_by.split("@")[0]}` : "";
        return `- ${names}: ${status} (sent ${sentDate}${sentBy}${signedDate ? `, signed ${signedDate}` : ""})`;
      });

      return { result: `eSign envelopes for ${cg.first_name} ${cg.last_name}:\n${lines.join("\n")}` };
    } catch (err) {
      console.error("get_esign_envelopes error:", err);
      return { error: "Failed to fetch eSign envelopes." };
    }
  }),
);

// ── send_esign_envelope (confirm) ──

registerTool(
  {
    name: "send_esign_envelope",
    description:
      "Send documents for electronic signature to a caregiver via SMS/email link. Can send a full onboarding packet (all configured templates) or specific individual templates. REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name to search for" },
        send_all: { type: "boolean", description: "If true, sends full onboarding packet with all templates. If false, send specific template(s)." },
        template_name: { type: "string", description: "Name of a specific template to send (when send_all is false). Must match a configured template name." },
        send_via: { type: "string", enum: ["sms", "email", "both"], description: "How to deliver the signing link. Default: sms" },
      },
    },
    riskLevel: "confirm",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    if (!cg.phone && !cg.email) return { error: `${cg.first_name} ${cg.last_name} has no phone or email configured. Please add contact info first.` };

    // Fetch active templates
    const { data: templates, error: tplErr } = await ctx.supabase
      .from("esign_templates")
      .select("*")
      .eq("active", true)
      .order("sort_order");

    if (tplErr || !templates?.length) return { error: "No eSign templates configured. Please configure templates in Settings > eSignatures." };

    const sendAll = input.send_all !== false;
    let selectedTemplates = templates;
    let isPacket = true;

    if (!sendAll && input.template_name) {
      const q = input.template_name.toLowerCase();
      selectedTemplates = templates.filter((t: any) => t.name.toLowerCase().includes(q));
      if (selectedTemplates.length === 0) {
        return { error: `No template found matching "${input.template_name}". Available templates: ${templates.map((t: any) => t.name).join(", ")}` };
      }
      isPacket = false;
    }

    const templateList = selectedTemplates.map((t: any) => t.name).join(", ");
    const sendVia = input.send_via || "sms";
    const summary = sendAll
      ? `**Send eSign Full Packet**\n\n**To:** ${cg.first_name} ${cg.last_name} (${cg.phone || cg.email})\n**Documents:** ${templates.length} templates (${templateList})\n**Via:** ${sendVia}`
      : `**Send eSign Envelope**\n\n**To:** ${cg.first_name} ${cg.last_name} (${cg.phone || cg.email})\n**Document:** ${templateList}\n**Via:** ${sendVia}`;

    return {
      requires_confirmation: true,
      action: "send_esign_envelope",
      summary,
      caregiver_id: cg.id,
      params: {
        caregiver_email: cg.email || "",
        caregiver_phone: cg.phone || "",
        caregiver_name: `${cg.first_name} ${cg.last_name}`.trim(),
        template_ids: selectedTemplates.map((t: any) => t.id),
        template_names: selectedTemplates.map((t: any) => t.name),
        is_packet: isPacket,
        send_via: sendVia,
      },
    };
  }),
  // Confirmed handler
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const result = await sendESignEnvelope(supabase, caregiverId, params, currentUser);
    return result.success ? { success: true, message: result.message } : { error: result.error };
  },
);
