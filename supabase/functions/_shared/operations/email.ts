// ─── Email Operations ───
// Shared email send logic for both ai-chat and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";

/** Send email via Outlook Edge Function and log a note to the caregiver record (if linked) */
export async function sendEmail(
  supabase: any,
  caregiverId: string | null,
  toEmail: string,
  toName: string | null,
  subject: string,
  body: string,
  cc: string | null,
  actor: string,
  adminEmail: string | null = null,
): Promise<OperationResult> {
  // Optionally fetch caregiver for note logging
  let cg: any = null;
  if (caregiverId && caregiverId !== "__no_caregiver__") {
    const { data } = await supabase
      .from("caregivers")
      .select("*")
      .eq("id", caregiverId)
      .single();
    cg = data;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/outlook-integration`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          action: "send_email",
          admin_email: adminEmail || null,
          to_email: toEmail,
          to_name: toName,
          subject,
          body,
          cc: cc || null,
        }),
      },
    );
    const result = await response.json();
    if (result.error)
      return { success: false, message: "", error: result.error };

    // Log note to caregiver record
    if (cg) {
      const emailNote = createNote(
        {
          text: `Email sent \u2014 Subject: ${subject}\n\n${body.length > 300 ? body.substring(0, 300) + "..." : body}`,
          type: "email",
          direction: "outbound",
          outcome: `sent via Outlook to ${toEmail}`,
        },
        actor,
      );
      // Store full email data for the Messaging Center thread view
      (emailNote as any).fullBody = body;
      (emailNote as any).subject = subject;
      (emailNote as any).toEmail = toEmail;
      (emailNote as any).ccEmail = cc || null;
      await supabase
        .from("caregivers")
        .update({ notes: [...(cg.notes || []), emailNote] })
        .eq("id", caregiverId);
      return {
        success: true,
        message: `Email sent to ${toName || toEmail} (${toEmail}). Subject: "${subject}". Logged to ${cg.first_name} ${cg.last_name}'s record.`,
      };
    }

    return {
      success: true,
      message: `Email sent to ${toName || toEmail} (${toEmail}). Subject: "${subject}".`,
    };
  } catch (err) {
    console.error("send_email error:", err);
    return {
      success: false,
      message: "",
      error: `Failed to send email: ${(err as Error).message}`,
    };
  }
}
