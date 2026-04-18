// ═══════════════════════════════════════════════════════════════
// Shift Offer Response Matching (Phase 5b)
//
// Called by message-router when an inbound SMS from a caregiver
// is pulled from the message_routing_queue. This module:
//
//   1. Looks up the most recent unexpired shift_offer for that
//      caregiver (within OFFER_MATCH_WINDOW_HOURS of the message).
//   2. If one exists, classifies the message text as yes/no/maybe
//      using the simple first-word rules.
//   3. Updates the shift_offer row with the response, sets
//      responded_at, and transitions status to accepted / declined
//      (or leaves it as 'sent' with a note for 'maybe' replies).
//
// The shift stays at 'offered' — the scheduler is responsible for
// picking a respondent and assigning manually. Auto-assignment is
// a future enhancement (Phase 8 AI).
//
// This module is deliberately separate from the main router flow.
// If matching fails or the caregiver has no recent offers, the
// router continues with its normal AI classification path so the
// message still gets logged and suggested-as-normal.
// ═══════════════════════════════════════════════════════════════

import {
  parseYesNoResponse,
  type YesNoResponse,
} from "../helpers/yesNoKeywords.ts";

// How far back to look for a matching shift_offer. Per user decision:
// 6 hours is the default. A caregiver replying outside this window
// won't be auto-matched — the scheduler handles it manually.
export const OFFER_MATCH_WINDOW_HOURS = 6;

// Re-exported so existing callers (e.g. message-router) keep working
// without having to chase the import to the helpers layer.
export { parseYesNoResponse };
export type { YesNoResponse };

/**
 * Attempt to match an inbound SMS to a recent shift_offer. Returns
 * a summary of what happened (or null if no match).
 *
 * @param supabase - authenticated Supabase client (service role)
 * @param caregiverId - id of the caregiver who sent the SMS
 * @param messageText - the inbound SMS body
 * @param messageReceivedAt - timestamp the SMS arrived (ISO string)
 */
export async function matchInboundShiftOfferResponse(
  supabase: any,
  caregiverId: string | null | undefined,
  messageText: string | null | undefined,
  messageReceivedAt: string | null | undefined,
): Promise<{
  matched: boolean;
  offerId: string | null;
  shiftId: string | null;
  newStatus: string | null;
  response: YesNoResponse | null;
  reason?: string;
}> {
  if (!caregiverId) {
    return { matched: false, offerId: null, shiftId: null, newStatus: null, response: null };
  }

  const receivedAtMs = messageReceivedAt
    ? new Date(messageReceivedAt).getTime()
    : Date.now();
  const windowStartMs = receivedAtMs - OFFER_MATCH_WINDOW_HOURS * 60 * 60 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();

  // Find the most recent unexpired offer in status 'sent' for this caregiver.
  const { data: offers, error } = await supabase
    .from("shift_offers")
    .select("*")
    .eq("caregiver_id", caregiverId)
    .eq("status", "sent")
    .gte("sent_at", windowStartIso)
    .order("sent_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[shift-offer-match] lookup failed:", error);
    return {
      matched: false,
      offerId: null,
      shiftId: null,
      newStatus: null,
      response: null,
      reason: error.message,
    };
  }

  if (!offers || offers.length === 0) {
    return { matched: false, offerId: null, shiftId: null, newStatus: null, response: null };
  }

  const offer = offers[0];
  const response = parseYesNoResponse(messageText);

  // 'maybe' responses are still recorded (so the scheduler can see
  // the reply) but keep the offer in 'sent' so it stays actionable.
  const newStatus = response === "yes"
    ? "accepted"
    : response === "no"
      ? "declined"
      : "sent";

  const patch: Record<string, unknown> = {
    responded_at: messageReceivedAt || new Date().toISOString(),
    response_text: messageText || null,
    updated_at: new Date().toISOString(),
  };
  if (newStatus !== offer.status) {
    patch.status = newStatus;
  }

  const { error: updateError } = await supabase
    .from("shift_offers")
    .update(patch)
    .eq("id", offer.id);

  if (updateError) {
    console.error("[shift-offer-match] update failed:", updateError);
    return {
      matched: false,
      offerId: offer.id,
      shiftId: offer.shift_id,
      newStatus: null,
      response,
      reason: updateError.message,
    };
  }

  return {
    matched: true,
    offerId: offer.id,
    shiftId: offer.shift_id,
    newStatus,
    response,
  };
}
