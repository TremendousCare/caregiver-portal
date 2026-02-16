// ─── DocuSign Tools ───
// get_docusign_envelopes (auto), send_docusign_envelope (confirm)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config.ts";
import { resolveCaregiver } from "../helpers/caregiver.ts";

// ── get_docusign_envelopes (auto) ──

registerTool(
  {
    name: "get_docusign_envelopes",
    description:
      "Get DocuSign envelope status for a caregiver. Shows all sent envelopes, their signing status, and timeline. Use when asked about DocuSign status, signing progress, or envelope history.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name to search for" },
      },
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please provide a name or ID." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };

    try {
      const { data: envelopes, error } = await ctx.supabase
        .from("docusign_envelopes")
        .select("*")
        .eq("caregiver_id", cg.id)
        .order("sent_at", { ascending: false });

      if (error) throw error;
      if (!envelopes || envelopes.length === 0) {
        return { result: `No DocuSign envelopes found for ${cg.first_name} ${cg.last_name}. No documents have been sent for signature yet.` };
      }

      const statusLabels: Record<string, string> = {
        sent: "Sent",
        delivered: "Delivered",
        viewed: "Viewed",
        completed: "Completed/Signed",
        declined: "Declined",
        voided: "Voided",
      };
      const lines = envelopes.map((e: any) => {
        const names = e.template_names?.length > 1
          ? `Full Packet (${e.template_names.length} docs)`
          : (e.template_names?.[0] || "DocuSign Envelope");
        const status = statusLabels[e.status] || e.status;
        const sentDate = e.sent_at ? new Date(e.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "N/A";
        const completedDate = e.completed_at ? new Date(e.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
        const sentBy = e.sent_by ? ` by ${e.sent_by.split("@")[0]}` : "";
        return `- ${names}: ${status} (sent ${sentDate}${sentBy}${completedDate ? `, signed ${completedDate}` : ""})`;
      });

      return { result: `DocuSign envelopes for ${cg.first_name} ${cg.last_name}:\n${lines.join("\n")}` };
    } catch (err) {
      console.error("get_docusign_envelopes error:", err);
      return { error: "Failed to fetch DocuSign envelopes. The DocuSign integration may not be configured." };
    }
  },
);

// ── send_docusign_envelope (confirm) ──

registerTool(
  {
    name: "send_docusign_envelope",
    description:
      "Send a DocuSign envelope to a caregiver for electronic signature. Can send a full onboarding packet (all configured templates) or specific individual templates. REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name to search for" },
        send_all: { type: "boolean", description: "If true, sends full onboarding packet with all templates. If false, send specific template(s)." },
        template_name: { type: "string", description: "Name of a specific template to send (when send_all is false). Must match a configured template name." },
      },
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please provide a name or ID." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
    if (!cg.email) return { error: `${cg.first_name} ${cg.last_name} has no email address configured. Please add an email first.` };

    // Fetch configured templates
    const { data: templateSetting } = await ctx.supabase
      .from("app_settings")
      .select("value")
      .eq("key", "docusign_templates")
      .single();
    const templates = templateSetting?.value || [];
    if (templates.length === 0) return { error: "No DocuSign templates configured. Please configure templates in Settings > DocuSign eSignature." };

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
    const summary = sendAll
      ? `**Send DocuSign Full Packet**\n\n**To:** ${cg.first_name} ${cg.last_name} (${cg.email})\n**Documents:** ${templates.length} templates (${templateList})`
      : `**Send DocuSign Envelope**\n\n**To:** ${cg.first_name} ${cg.last_name} (${cg.email})\n**Document:** ${templateList}`;

    return {
      requires_confirmation: true,
      action: "send_docusign_envelope",
      summary,
      caregiver_id: cg.id,
      params: {
        caregiver_email: cg.email,
        caregiver_name: `${cg.first_name} ${cg.last_name}`.trim(),
        template_ids: selectedTemplates.map((t: any) => t.templateId),
        template_names: selectedTemplates.map((t: any) => t.name),
        is_packet: isPacket,
      },
    };
  },
  // Confirmed handler
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const { data: cg } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
    const { caregiver_email, caregiver_name, template_ids, template_names, is_packet } = params;

    try {
      const body: any = {
        action: is_packet ? "send_packet" : "send_envelope",
        caregiver_id: caregiverId,
        caregiver_email,
        caregiver_name,
        sent_by: currentUser || "AI Assistant",
      };
      if (!is_packet) {
        body.template_ids = template_ids;
        body.template_names = template_names;
      }

      const response = await fetch(`${SUPABASE_URL}/functions/v1/docusign-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      let result;
      try { result = JSON.parse(responseText); } catch { result = { error: responseText }; }
      if (result.error) return { error: result.error };

      if (cg) {
        const docNames = is_packet ? `Full Onboarding Packet (${template_names?.length || "all"} docs)` : (template_names?.join(", ") || "document");
        const dsNote = {
          text: `DocuSign envelope sent \u2014 ${docNames} to ${caregiver_email}`,
          type: "docusign",
          direction: "outbound",
          outcome: "envelope sent",
          timestamp: Date.now(),
          author: currentUser || "AI Assistant",
        };
        await supabase.from("caregivers").update({ notes: [...(cg.notes || []), dsNote] }).eq("id", caregiverId);
      }

      const docDesc = is_packet ? `full onboarding packet (${template_names?.length || "all"} documents)` : (template_names?.join(", ") || "document");
      return {
        success: true,
        message: `DocuSign envelope sent to ${caregiver_name} (${caregiver_email}) \u2014 ${docDesc}. The caregiver will receive an email with a link to sign.${cg ? ` Logged to ${cg.first_name} ${cg.last_name}'s record.` : ""}`,
      };
    } catch (err) {
      console.error("send_docusign_envelope error:", err);
      return { error: `Failed to send DocuSign envelope: ${(err as Error).message}` };
    }
  },
);
