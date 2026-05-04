// ═══════════════════════════════════════════════════════════════
// Shift Offer Response Matching
//
// Called by message-router when an inbound SMS from a caregiver is
// pulled from the message_routing_queue. This module:
//
//   1. Finds candidate caregiver records that share the inbound
//      phone number (so duplicate caregiver records sharing a phone
//      don't break matching when the inbound got tagged to one
//      record but the offer was sent to another).
//   2. Looks up the most recent matching shift_offer for any of
//      those caregivers, where the offer is still actionable
//      (offer is in 'sent' status, the shift hasn't started yet,
//      and the offer was sent within the safety window).
//   3. Classifies the message text as yes/no/maybe.
//   4. Updates the offer with the response and transitions status
//      to accepted / declined (or leaves it as 'sent' for 'maybe').
//   5. If the shift is flagged `auto_assign_on_first_yes` and the
//      response is 'yes' (and nobody else has been assigned yet),
//      auto-assigns the caregiver, expires the peer offers, and
//      sends a confirmation SMS.
// ═══════════════════════════════════════════════════════════════

import {
  parseYesNoResponse,
  type YesNoResponse,
} from "../helpers/yesNoKeywords.ts";
import { normalizePhoneNumber } from "../helpers/phone.ts";

// Safety cap on offer age. Even if the shift hasn't started yet,
// we won't auto-match replies older than this — anything that
// stale is better handled manually.
export const OFFER_MATCH_MAX_AGE_HOURS = 48;

// Confirmation SMS template for auto-assign. Mirrors
// DEFAULT_CONFIRMATION_TEMPLATE in src/features/scheduling/broadcastHelpers.js.
// Kept in sync manually until template rendering is consolidated into
// _shared (see follow-up).
const AUTO_ASSIGN_CONFIRMATION_TEMPLATE =
  "You're confirmed for {{dayOfWeek}} {{dateLabel}}, {{timeRange}} with {{clientName}} at {{location}}. Thanks {{firstName}}!";

export { parseYesNoResponse };
export type { YesNoResponse };

export type MatchInput = {
  caregiverId?: string | null;
  senderPhone?: string | null;
  messageText?: string | null;
  messageReceivedAt?: string | null;
  // Optional — used as the actor on automated assignments / SMS.
  actor?: string | null;
};

export type MatchResult = {
  matched: boolean;
  offerId: string | null;
  shiftId: string | null;
  newStatus: string | null;
  response: YesNoResponse | null;
  autoAssigned?: boolean;
  reason?: string;
};

/**
 * Build the candidate caregiver-id set for matching.
 *
 * If we have a phone, find every (non-archived) caregiver with that
 * phone and add them to the set. This handles the duplicate-record
 * case where the inbound got tagged to one caregiver row but the
 * shift_offer was created against another row with the same phone.
 *
 * The original `caregiverId` (from the routing queue) is always
 * included so callers without a phone still get the legacy lookup.
 */
async function findCandidateCaregiverIds(
  supabase: any,
  caregiverId: string | null | undefined,
  senderPhone: string | null | undefined,
): Promise<string[]> {
  const ids = new Set<string>();
  if (caregiverId) ids.add(caregiverId);

  if (senderPhone) {
    const normalized = normalizePhoneNumber(senderPhone);
    // Match either the +1XXXXXXXXXX form or the bare 10-digit form,
    // since the caregivers table is inconsistent about which it stores.
    const digits = (senderPhone || "").replace(/\D/g, "").replace(/^1/, "");
    const phoneFilters: string[] = [];
    if (normalized) phoneFilters.push(normalized);
    if (digits.length === 10) phoneFilters.push(digits);
    if (phoneFilters.length > 0) {
      const { data: matches, error } = await supabase
        .from("caregivers")
        .select("id")
        .in("phone", phoneFilters)
        .eq("archived", false);
      if (error) {
        console.warn("[shift-offer-match] phone lookup failed:", error);
      } else if (matches) {
        for (const row of matches) ids.add(row.id);
      }
    }
  }

  return Array.from(ids);
}

/**
 * Attempt to match an inbound SMS to a recent shift_offer.
 *
 * Backward compat: if the second argument is a string, fall back to the
 * old positional signature `(supabase, caregiverId, messageText, messageReceivedAt)`.
 */
export async function matchInboundShiftOfferResponse(
  supabase: any,
  inputOrCaregiverId: MatchInput | string | null | undefined,
  legacyMessageText?: string | null,
  legacyReceivedAt?: string | null,
): Promise<MatchResult> {
  const input: MatchInput = typeof inputOrCaregiverId === "object" && inputOrCaregiverId !== null
    ? inputOrCaregiverId
    : {
        caregiverId: (inputOrCaregiverId as string | null | undefined) ?? null,
        messageText: legacyMessageText ?? null,
        messageReceivedAt: legacyReceivedAt ?? null,
      };

  const { caregiverId, senderPhone, messageText, messageReceivedAt, actor } = input;

  if (!caregiverId && !senderPhone) {
    return { matched: false, offerId: null, shiftId: null, newStatus: null, response: null };
  }

  const candidateIds = await findCandidateCaregiverIds(supabase, caregiverId, senderPhone);
  if (candidateIds.length === 0) {
    return { matched: false, offerId: null, shiftId: null, newStatus: null, response: null };
  }

  const receivedAtIso = messageReceivedAt || new Date().toISOString();
  const receivedAtMs = new Date(receivedAtIso).getTime();
  const windowStartIso = new Date(
    receivedAtMs - OFFER_MATCH_MAX_AGE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Pull recent open offers for any candidate caregiver, joined to
  // the parent shift so we can filter by shift start time and read
  // the auto-assign flag in a single round-trip.
  const { data: offers, error } = await supabase
    .from("shift_offers")
    .select(
      "id, shift_id, caregiver_id, status, sent_at, shift:shifts(id, start_time, status, assigned_caregiver_id, client_id, auto_assign_on_first_yes)",
    )
    .in("caregiver_id", candidateIds)
    .eq("status", "sent")
    .gte("sent_at", windowStartIso)
    .order("sent_at", { ascending: false });

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

  // Pick the most recent offer whose shift hasn't started yet. Offers
  // without shift data (e.g. legacy rows where the join is unavailable)
  // are kept — better to match an unparseable offer than to drop a
  // legitimate "yes". Offers with a parseable past start time are
  // excluded outright: the shift is over and matching at this point
  // would be misleading.
  const stillActionable = (offers || []).filter((o: any) => {
    if (!o.shift) return true;
    const startMs = new Date(o.shift.start_time).getTime();
    if (Number.isNaN(startMs)) return true;
    return startMs > receivedAtMs;
  });

  const offer = stillActionable[0] as
    | {
        id: string;
        shift_id: string;
        caregiver_id: string;
        status: string;
        sent_at: string;
        shift?: {
          id: string;
          start_time: string;
          status: string;
          assigned_caregiver_id: string | null;
          client_id: string;
          auto_assign_on_first_yes: boolean;
        } | null;
      }
    | undefined;

  if (!offer) {
    return { matched: false, offerId: null, shiftId: null, newStatus: null, response: null };
  }

  const response = parseYesNoResponse(messageText);

  // 'maybe' → record reply but keep offer actionable.
  const newStatus =
    response === "yes" ? "accepted" : response === "no" ? "declined" : "sent";

  const patch: Record<string, unknown> = {
    responded_at: receivedAtIso,
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

  // Auto-assign: only if shift opted in, response is yes, and nobody
  // else has been assigned yet (race protection — another reply may
  // have beaten this one through the queue).
  let autoAssigned = false;
  if (
    response === "yes" &&
    offer.shift?.auto_assign_on_first_yes === true &&
    !offer.shift?.assigned_caregiver_id
  ) {
    try {
      autoAssigned = await runAutoAssign(supabase, offer, actor || null);
    } catch (err) {
      console.error("[shift-offer-match] auto-assign failed:", err);
      // Don't fail the whole match — the offer is still recorded as
      // accepted, and the scheduler can complete the assignment manually.
    }
  }

  return {
    matched: true,
    offerId: offer.id,
    shiftId: offer.shift_id,
    newStatus,
    response,
    autoAssigned,
  };
}

/**
 * Perform the auto-assignment side effects when a shift is opted in
 * to first-yes-wins and the matcher just saw an accepted offer.
 *
 * Returns true if the assignment was performed, false if it was
 * skipped (race lost, missing data, etc.).
 */
async function runAutoAssign(
  supabase: any,
  acceptedOffer: {
    id: string;
    shift_id: string;
    caregiver_id: string;
    shift?: {
      id: string;
      start_time: string;
      status: string;
      assigned_caregiver_id: string | null;
      client_id: string;
      auto_assign_on_first_yes: boolean;
    } | null;
  },
  actor: string | null,
): Promise<boolean> {
  // Race-safe assignment: only flip the shift if it's still open or
  // offered AND no caregiver has been assigned. PostgREST will return
  // zero rows if the WHERE clause doesn't match.
  const { data: claimed, error: claimError } = await supabase
    .from("shifts")
    .update({
      assigned_caregiver_id: acceptedOffer.caregiver_id,
      status: "assigned",
      updated_at: new Date().toISOString(),
    })
    .eq("id", acceptedOffer.shift_id)
    .is("assigned_caregiver_id", null)
    .in("status", ["open", "offered"])
    .select("id, client_id, start_time, end_time")
    .maybeSingle();

  if (claimError) {
    console.error("[shift-offer-match] claim failed:", claimError);
    return false;
  }
  if (!claimed) {
    // Another reply already won the race. Leave this offer at 'accepted'
    // so the scheduler can see it, but don't expire peers or send conf.
    return false;
  }

  // Mark the winning offer as 'assigned'
  await supabase
    .from("shift_offers")
    .update({ status: "assigned", updated_at: new Date().toISOString() })
    .eq("id", acceptedOffer.id);

  // Expire any other still-open offers for this shift (but not this one)
  await supabase
    .from("shift_offers")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("shift_id", acceptedOffer.shift_id)
    .neq("id", acceptedOffer.id)
    .in("status", ["sent", "accepted"]);

  // Best-effort confirmation SMS. Failures don't roll back the
  // assignment — the scheduler will see the assigned shift in realtime
  // and can resend a confirmation manually if the SMS hop failed.
  try {
    await sendAutoAssignConfirmation(supabase, claimed, acceptedOffer.caregiver_id, actor);
  } catch (err) {
    console.warn("[shift-offer-match] confirmation SMS failed:", err);
  }

  return true;
}

async function sendAutoAssignConfirmation(
  supabase: any,
  shift: { id: string; client_id: string; start_time: string; end_time: string },
  caregiverId: string,
  actor: string | null,
): Promise<void> {
  const [{ data: caregiver }, { data: client }] = await Promise.all([
    supabase
      .from("caregivers")
      .select("id, first_name, last_name, phone")
      .eq("id", caregiverId)
      .maybeSingle(),
    supabase
      .from("clients")
      .select("id, first_name, last_name, address, city, state, zip")
      .eq("id", shift.client_id)
      .maybeSingle(),
  ]);

  if (!caregiver?.phone) return;

  const message = renderAutoAssignConfirmation({ shift, caregiver, client });
  if (!message) return;

  const { error } = await supabase.functions.invoke("bulk-sms", {
    body: {
      caregiver_ids: [caregiverId],
      message,
      current_user: actor || "system:auto_assign",
      category: "scheduling",
    },
  });
  if (error) throw error;
}

/**
 * Render the confirmation SMS inline. Kept simple and dependency-free
 * so the edge function bundle stays small.
 */
function renderAutoAssignConfirmation(args: {
  shift: { start_time: string; end_time: string };
  caregiver: { first_name?: string | null } | null;
  client:
    | {
        first_name?: string | null;
        last_name?: string | null;
        address?: string | null;
        city?: string | null;
        state?: string | null;
      }
    | null;
}): string | null {
  const start = new Date(args.shift.start_time);
  const end = new Date(args.shift.end_time);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const dayOfWeek = start.toLocaleDateString("en-US", { weekday: "short" });
  const dateLabel = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const timeRange = `${formatTime12h(start)}-${formatTime12h(end)}`;
  const firstName = args.caregiver?.first_name || "";
  const clientName = [args.client?.first_name, args.client?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim() || "your client";
  const location = [args.client?.address, args.client?.city, args.client?.state]
    .filter(Boolean)
    .join(", ") || "their home";

  return AUTO_ASSIGN_CONFIRMATION_TEMPLATE
    .replace("{{dayOfWeek}}", dayOfWeek)
    .replace("{{dateLabel}}", dateLabel)
    .replace("{{timeRange}}", timeRange)
    .replace("{{clientName}}", clientName)
    .replace("{{location}}", location)
    .replace("{{firstName}}", firstName);
}

function formatTime12h(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "a" : "p";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}:00${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}
