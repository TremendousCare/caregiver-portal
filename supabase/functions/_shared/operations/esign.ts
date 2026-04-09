// ─── E-Signature Operations ───
// Shared eSign envelope logic for both ai-chat and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";

/** Send eSign envelope and log a note to the caregiver record */
export async function sendESignEnvelope(
  supabase: any,
  caregiverId: string,
  params: {
    caregiver_email: string;
    caregiver_phone: string;
    caregiver_name: string;
    template_ids: string[];
    template_names: string[];
    is_packet: boolean;
    send_via?: string;
  },
  actor: string,
): Promise<OperationResult> {
  const { data: cg } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", caregiverId)
    .single();
  const {
    caregiver_email,
    caregiver_phone,
    caregiver_name,
    template_ids,
    template_names,
    is_packet,
    send_via = "sms",
  } = params;

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    const body: any = {
      action: "create_envelope",
      caregiver_id: caregiverId,
      caregiver_email,
      caregiver_phone,
      caregiver_name,
      sent_by: actor || "AI Assistant",
      send_via,
      is_packet,
    };
    if (!is_packet) {
      body.template_ids = template_ids;
    }

    const response = await fetch(
      `${supabaseUrl}/functions/v1/esign`,
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
      const esignNote = createNote(
        {
          text: `eSign request sent \u2014 ${docNames} via ${send_via}`,
          type: "esign",
          direction: "outbound",
          outcome: "signing request sent",
        },
        actor,
      );
      await supabase
        .from("caregivers")
        .update({ notes: [...(cg.notes || []), esignNote] })
        .eq("id", caregiverId);
    }

    const docDesc = is_packet
      ? `full onboarding packet (${template_names?.length || "all"} documents)`
      : (template_names?.join(", ") || "document");
    const viaDesc = send_via === "both" ? "SMS and email" : send_via;
    return {
      success: true,
      message: `eSign request sent to ${caregiver_name} via ${viaDesc} \u2014 ${docDesc}. The caregiver will receive a link to review and sign.${cg ? ` Logged to ${cg.first_name} ${cg.last_name}'s record.` : ""}`,
    };
  } catch (err) {
    console.error("send_esign_envelope error:", err);
    return {
      success: false,
      message: "",
      error: `Failed to send eSign request: ${(err as Error).message}`,
    };
  }
}
