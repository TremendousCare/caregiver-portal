// ─── SMS Operations ───
// Shared SMS send logic for both ai-chat and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";
import {
  getRingCentralAccessTokenWithJwt,
  getSendingCredentials,
  sendSmsToRingCentralWithRetry,
} from "../helpers/ringcentral.ts";

export type SmsEntityType = "caregiver" | "client";

/**
 * Send SMS via RingCentral and log a note to the matched entity record.
 *
 * `entityType` selects which table to read/write (caregivers or clients).
 * Defaults to "caregiver" so existing call sites stay byte-identical.
 *
 * The optional `category` argument routes the send through a specific
 * communication_routes entry (phone number + vault-stored JWT). When
 * omitted, falls back to the legacy env-var path — byte-identical to
 * pre-routing behavior.
 */
export async function sendSMS(
  supabase: any,
  entityId: string,
  message: string,
  normalizedPhone: string,
  actor: string,
  category?: string | null,
  entityType: SmsEntityType = "caregiver",
): Promise<OperationResult> {
  const tableName = entityType === "client" ? "clients" : "caregivers";
  const entityLabel = entityType === "client" ? "Client" : "Caregiver";

  // Fetch the entity record so we can append a note after sending.
  const { data: entity, error: fetchErr } = await supabase
    .from(tableName)
    .select("*")
    .eq("id", entityId)
    .single();
  if (fetchErr || !entity)
    return { success: false, message: "", error: `${entityLabel} not found.` };

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

  // Send SMS. The helper retries exactly once on a confirmed 429 (RC's rate
  // limiter rejected us before the message reached delivery) — safe because
  // RC does not queue 429'd sends. See sendSmsToRingCentralWithRetry for the
  // full idempotency reasoning.
  try {
    const smsResponse = await sendSmsToRingCentralWithRetry(
      accessToken,
      fromNumber,
      normalizedPhone,
      message,
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
      .from(tableName)
      .update({ notes: [...(entity.notes || []), smsNote] })
      .eq("id", entityId);

    return {
      success: true,
      message: `SMS sent to ${entity.first_name} ${entity.last_name} at ${normalizedPhone} (from ${fromNumber}${category ? `, route: ${category}` : ""}). Message logged to their record.`,
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
