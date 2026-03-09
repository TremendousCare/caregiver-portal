// ─── SMS Operations ───
// Shared SMS send logic for both ai-chat and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";
import {
  getRingCentralAccessToken,
  getRCFromNumber,
  RC_API_URL,
} from "../helpers/ringcentral.ts";

/** Send SMS via RingCentral and log a note to the caregiver record */
export async function sendSMS(
  supabase: any,
  caregiverId: string,
  message: string,
  normalizedPhone: string,
  actor: string,
): Promise<OperationResult> {
  // Fetch caregiver for note appending
  const { data: cg, error: fetchErr } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", caregiverId)
    .single();
  if (fetchErr || !cg)
    return { success: false, message: "", error: "Caregiver not found." };

  // Get from number
  const fromNumber = await getRCFromNumber(supabase);
  if (!fromNumber)
    return {
      success: false,
      message: "",
      error:
        "RingCentral from number not configured. Set it in Settings > RingCentral.",
    };

  // Authenticate with RingCentral
  let accessToken: string;
  try {
    accessToken = await getRingCentralAccessToken();
  } catch (err) {
    return {
      success: false,
      message: "",
      error: `Failed to connect to SMS service: ${(err as Error).message}`,
    };
  }

  // Send SMS
  try {
    const smsResponse = await fetch(
      `${RC_API_URL}/restapi/v1.0/account/~/extension/~/sms`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          from: { phoneNumber: fromNumber },
          to: [{ phoneNumber: normalizedPhone }],
          text: message,
        }),
      },
    );

    if (!smsResponse.ok) {
      const errorText = await smsResponse.text();
      if (smsResponse.status === 429)
        return {
          success: false,
          message: "",
          error:
            "SMS rate limit reached. Please try again in a few minutes.",
        };
      throw new Error(
        `RingCentral API error (${smsResponse.status}): ${errorText}`,
      );
    }

    // Log note
    const smsNote = createNote(
      {
        text: message,
        type: "text",
        direction: "outbound",
        outcome: "sent via RingCentral",
      },
      actor,
    );
    await supabase
      .from("caregivers")
      .update({ notes: [...(cg.notes || []), smsNote] })
      .eq("id", caregiverId);

    return {
      success: true,
      message: `SMS sent to ${cg.first_name} ${cg.last_name} at ${normalizedPhone}. Message logged to their record.`,
    };
  } catch (err) {
    console.error("RC SMS error:", err);
    return {
      success: false,
      message: "",
      error: `Failed to send SMS: ${(err as Error).message}`,
    };
  }
}
