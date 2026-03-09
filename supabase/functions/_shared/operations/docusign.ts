// ─── DocuSign Operations ───
// Shared DocuSign envelope logic for both ai-chat and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";

/** Send DocuSign envelope and log a note to the caregiver record */
export async function sendDocuSignEnvelope(
  supabase: any,
  caregiverId: string,
  params: {
    caregiver_email: string;
    caregiver_name: string;
    template_ids: string[];
    template_names: string[];
    is_packet: boolean;
  },
  actor: string,
): Promise<OperationResult> {
  const { data: cg } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", caregiverId)
    .single();
  const { caregiver_email, caregiver_name, template_ids, template_names, is_packet } =
    params;

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    const body: any = {
      action: is_packet ? "send_packet" : "send_envelope",
      caregiver_id: caregiverId,
      caregiver_email,
      caregiver_name,
      sent_by: actor || "AI Assistant",
    };
    if (!is_packet) {
      body.template_ids = template_ids;
      body.template_names = template_names;
    }

    const response = await fetch(
      `${supabaseUrl}/functions/v1/docusign-integration`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(body),
      },
    );

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      result = { error: responseText };
    }
    if (result.error)
      return { success: false, message: "", error: result.error };

    if (cg) {
      const docNames = is_packet
        ? `Full Onboarding Packet (${template_names?.length || "all"} docs)`
        : (template_names?.join(", ") || "document");
      const dsNote = createNote(
        {
          text: `DocuSign envelope sent \u2014 ${docNames} to ${caregiver_email}`,
          type: "docusign",
          direction: "outbound",
          outcome: "envelope sent",
        },
        actor,
      );
      await supabase
        .from("caregivers")
        .update({ notes: [...(cg.notes || []), dsNote] })
        .eq("id", caregiverId);
    }

    const docDesc = is_packet
      ? `full onboarding packet (${template_names?.length || "all"} documents)`
      : (template_names?.join(", ") || "document");
    return {
      success: true,
      message: `DocuSign envelope sent to ${caregiver_name} (${caregiver_email}) \u2014 ${docDesc}. The caregiver will receive an email with a link to sign.${cg ? ` Logged to ${cg.first_name} ${cg.last_name}'s record.` : ""}`,
    };
  } catch (err) {
    console.error("send_docusign_envelope error:", err);
    return {
      success: false,
      message: "",
      error: `Failed to send DocuSign envelope: ${(err as Error).message}`,
    };
  }
}
