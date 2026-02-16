// ─── Outlook Email Tools ───
// search_emails (auto), get_email_thread (auto), send_email (confirm)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config.ts";
import { resolveCaregiver } from "../helpers/caregiver.ts";

// ── search_emails (auto) ──

registerTool(
  {
    name: "search_emails",
    description:
      "Search the company Outlook mailbox for emails. Can be called with no parameters to get recent emails, with a caregiver name/ID to find emails to/from that person, or with a keyword to search by topic. All parameters are optional.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID (will use their email to search)" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        keyword: { type: "string", description: "Search keyword (e.g., 'TB test', 'orientation', 'offer letter')" },
        days_back: { type: "number", description: "Number of days to look back (default 30, max 90)" },
        limit: { type: "number", description: "Max number of emails to return (default 10, max 25)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    let emailAddress = null;
    let caregiverName = null;

    if (input.caregiver_id || input.name) {
      const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
      if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
      if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
      caregiverName = `${cg.first_name} ${cg.last_name}`;
      emailAddress = cg.email || null;
      if (!emailAddress) return { error: `No email address on file for ${caregiverName}. Cannot search email history.` };
    }

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({
          action: "search_emails",
          email_address: emailAddress,
          keyword: input.keyword || null,
          days_back: input.days_back || 30,
          limit: input.limit || 10,
        }),
      });
      const result = await response.json();
      if (result.error) return { error: result.error };
      return {
        caregiver: caregiverName || "(all emails)",
        email_address: emailAddress,
        keyword: input.keyword || null,
        mailbox: result.mailbox,
        days_searched: result.days_searched,
        total_results: result.total_results,
        emails: result.emails.map((e: any) => {
          const date = new Date(e.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
          const attachFlag = e.has_attachments ? " [Attachments]" : "";
          return `[${date}] From: ${e.from_name || e.from} | Subject: ${e.subject}${attachFlag}\n  Preview: ${e.preview}\n  (email_id: ${e.id}, conversation_id: ${e.conversation_id})`;
        }),
      };
    } catch (err) {
      console.error("search_emails error:", err);
      return { error: `Failed to search emails: ${(err as Error).message}` };
    }
  },
);

// ── get_email_thread (auto) ──

registerTool(
  {
    name: "get_email_thread",
    description:
      "Get the full content of a specific email or email conversation thread. Use search_emails first to find the email, then this tool to read the full content.",
    input_schema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "The specific email ID (from search_emails results)" },
        conversation_id: { type: "string", description: "The conversation ID to get the full thread (from search_emails results)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, _ctx: ToolContext): Promise<ToolResult> => {
    if (!input.email_id && !input.conversation_id) return { error: "Please provide an email_id or conversation_id. Use search_emails first to find emails." };
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ action: "get_email_thread", email_id: input.email_id || null, conversation_id: input.conversation_id || null }),
      });
      const result = await response.json();
      if (result.error) return { error: result.error };
      return {
        total_messages: result.total_messages || result.emails.length,
        thread: result.emails.map((e: any) => {
          const date = new Date(e.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
          const attachFlag = e.has_attachments ? " [Attachments]" : "";
          const body = e.body && e.body.length > 1500 ? e.body.substring(0, 1500) + "\n... (truncated)" : e.body;
          return `--- Email ---\nDate: ${date}\nFrom: ${e.from_name || e.from}\nTo: ${e.to}${e.cc ? `\nCC: ${e.cc}` : ""}\nSubject: ${e.subject}${attachFlag}\n\n${body}`;
        }),
      };
    } catch (err) {
      console.error("get_email_thread error:", err);
      return { error: `Failed to get email thread: ${(err as Error).message}` };
    }
  },
);

// ── send_email (confirm) ──

registerTool(
  {
    name: "send_email",
    description:
      "Send a real email from the company Outlook mailbox to a caregiver or any recipient. REQUIRES USER CONFIRMATION. The email will actually be sent. After sending, the email is auto-logged as a note on the caregiver record (if linked to a caregiver).",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID (will use their email as the recipient)" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        to_email: { type: "string", description: "Recipient email address (used if not sending to a caregiver)" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text. Be professional and clear." },
        cc: { type: "string", description: "CC email address (optional)" },
      },
      required: ["subject", "body"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    let recipientEmail = input.to_email || null;
    let recipientName = input.to_email || null;
    let caregiverIdForLog: string | null = null;

    if (input.caregiver_id || input.name) {
      const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
      if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
      if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
      if (!cg.email) return { error: `Cannot send email: no email address on file for ${cg.first_name} ${cg.last_name}. Please update their email first.` };
      recipientEmail = cg.email;
      recipientName = `${cg.first_name} ${cg.last_name}`;
      caregiverIdForLog = cg.id;
    }

    if (!recipientEmail) return { error: "No recipient specified. Provide a caregiver name/ID or a to_email address." };
    if (!input.subject || input.subject.trim().length === 0) return { error: "Email subject is required." };
    if (!input.body || input.body.trim().length === 0) return { error: "Email body is required." };

    const ccLine = input.cc ? `\n**CC:** ${input.cc}` : "";
    return {
      requires_confirmation: true,
      action: "send_email",
      summary: `**Send Email to ${recipientName}**\n\n**To:** ${recipientEmail}${ccLine}\n**Subject:** ${input.subject}\n\n**Body:**\n${input.body}`,
      caregiver_id: caregiverIdForLog || "__no_caregiver__",
      params: {
        to_email: recipientEmail,
        to_name: recipientName,
        subject: input.subject,
        body: input.body,
        cc: input.cc || null,
      },
    };
  },
  // Confirmed handler
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    let cg: any = null;
    if (caregiverId && caregiverId !== "__no_caregiver__") {
      const { data } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
      cg = data;
    }

    const { to_email, to_name, subject, body, cc } = params;
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ action: "send_email", to_email, to_name, subject, body, cc: cc || null }),
      });
      const result = await response.json();
      if (result.error) return { error: result.error };

      if (cg) {
        const emailNote = {
          text: `Email sent \u2014 Subject: ${subject}\n\n${body.length > 300 ? body.substring(0, 300) + "..." : body}`,
          type: "email",
          direction: "outbound",
          outcome: `sent via Outlook to ${to_email}`,
          timestamp: Date.now(),
          author: currentUser || "AI Assistant",
        };
        await supabase.from("caregivers").update({ notes: [...(cg.notes || []), emailNote] }).eq("id", caregiverId);
        return { success: true, message: `Email sent to ${to_name || to_email} (${to_email}). Subject: "${subject}". Logged to ${cg.first_name} ${cg.last_name}'s record.` };
      }

      return { success: true, message: `Email sent to ${to_name || to_email} (${to_email}). Subject: "${subject}".` };
    } catch (err) {
      console.error("send_email error:", err);
      return { error: `Failed to send email: ${(err as Error).message}` };
    }
  },
);
