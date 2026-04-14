// ─── SMS Operations ───
// Shared SMS send logic for both ai-chat and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";
import {
  getRingCentralAccessTokenWithJwt,
  getSendingCredentials,
  RC_API_URL,
} from "../helpers/ringcentral.ts";

/**
 * Send SMS via RingCentral and log a note to the caregiver record.
 *
 * The optional `category` argument routes the send through a specific
 * communication_routes entry (phone number + vault-stored JWT). When
 * omitted, falls back to the legacy env-var path — byte-identical to
 * pre-routing behavior.
 */
export async function sendSMS(
  supabase: any,
  caregiverId: string,
  message: string,
  normalizedPhone: string,
  actor: string,
  category?: string | null,
): Promise<OperationResult> {
  // Fetch caregiver for note appending
  const { data: cg, error: fetchErr } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", caregiverId)
    .single();
  if (fetchErr || !cg)
    return { success: false, message: "", error: "Caregiver not found." };

  // Resolve phone number + JWT based on whether a category was specified.
  // When category is omitted, this falls through to the legacy env-var
  // path and the behavior is byte-identical to the pre-routing code.
  let fromNumber: string;
  let jwt: string;
  try {
    const creds = await getSendingCredentials(supabase, category);
    fromNumber = creds.fromNumber;
    jwt = creds.jwt;
  } catch (err) {
    return {
      success: false,
      message: "",
      error: (err as Error).message,
    };
  }

  // Authenticate with RingCentral using the resolved JWT
  let accessToken: string;
  try {
    accessToken = await getRingCentralAccessTokenWithJwt(jwt);
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

    // Log note. Include the route in the outcome when one was used, so the
    // audit trail can distinguish routed vs. legacy sends.
    const smsNote = createNote(
      {
        text: message,
        type: "text",
        direction: "outbound",
        outcome: category
          ? `sent via RingCentral (route: ${category})`
          : "sent via RingCentral",
      },
      actor,
    );
    await supabase
      .from("caregivers")
      .update({ notes: [...(cg.notes || []), smsNote] })
      .eq("id", caregiverId);

    return {
      success: true,
      message: `SMS sent to ${cg.first_name} ${cg.last_name} at ${normalizedPhone} (from ${fromNumber}${category ? `, route: ${category}` : ""}). Message logged to their record.`,
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
