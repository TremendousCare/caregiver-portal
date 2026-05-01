// Bookings integration helpers — pure functions, no DB calls, no side
// effects. Imported by execute-automation, bookings-integration, and
// bookings-webhook (all Deno) and by Vitest tests (Node) to lock the
// shape of inbound Microsoft Graph payloads and the per-org config.

// ─── Per-org config path ──────────────────────────────────────────────────
// JSON path inside organizations.settings where the per-org bookings
// config lives. Keep in sync with the migration that seeds it
// (supabase/migrations/20260504000000_bookings_step2_org_config_and_seed_rule.sql).
export const BOOKINGS_SETTINGS_KEY = "bookings";
export const BOOKINGS_PUBLIC_URL_KEY = "public_url";
export const BOOKINGS_BUSINESS_ID_KEY = "business_id";

// Returns the public-facing Microsoft Bookings URL for an org, or empty
// string if not configured. Intentionally permissive on shape — accepts
// null/undefined settings and missing nested keys without throwing.
export function getBookingUrlFromOrgSettings(
  settings: Record<string, any> | null | undefined,
): string {
  if (!settings || typeof settings !== "object") return "";
  const bookings = settings[BOOKINGS_SETTINGS_KEY];
  if (!bookings || typeof bookings !== "object") return "";
  const url = bookings[BOOKINGS_PUBLIC_URL_KEY];
  return typeof url === "string" ? url : "";
}

// Returns the Microsoft Graph bookingBusiness ID for an org, or empty
// string if not configured. Same permissive shape contract.
export function getBookingsBusinessIdFromOrgSettings(
  settings: Record<string, any> | null | undefined,
): string {
  if (!settings || typeof settings !== "object") return "";
  const bookings = settings[BOOKINGS_SETTINGS_KEY];
  if (!bookings || typeof bookings !== "object") return "";
  const id = bookings[BOOKINGS_BUSINESS_ID_KEY];
  return typeof id === "string" ? id : "";
}

// ─── Phone helpers ────────────────────────────────────────────────────────
// Microsoft Bookings does not normalize phone numbers — the customer
// types them by hand into the booking page, so we get every variation
// imaginable: "(555) 867-5309", "555.867.5309", "+1 555 867 5309", etc.
// We strip to the last 10 digits to match against caregivers.phone the
// same way ringcentral-webhook does (see phoneDigits there).

export function phoneDigits(phone: string | null | undefined): string {
  if (!phone || typeof phone !== "string") return "";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

// ─── Email helpers ────────────────────────────────────────────────────────
// Booking customers can include an email or skip it depending on
// Microsoft's optional-field config. We normalize for case-insensitive
// equality match on caregivers.email — no fancy address parsing, just
// trim + lowercase.

export function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

// ─── Caregiver matching ───────────────────────────────────────────────────
// Match an inbound appointment to a caregiver by phone (primary) or
// email (fallback). Returns the caregiver row + the match method, or
// `{ caregiver: null, matchMethod: "unmatched" }`.
//
// Caller passes a pre-fetched, org-scoped caregivers array. We do not
// call the DB here — keeps the helper pure and unit-testable.

export interface CaregiverMatchInput {
  id: string;
  phone?: string | null;
  email?: string | null;
}

export interface CaregiverMatchResult<T> {
  caregiver: T | null;
  matchMethod: "phone" | "email" | "unmatched";
}

export function matchCustomerToCaregiver<T extends CaregiverMatchInput>(
  customer: { phone?: string | null; email?: string | null },
  caregivers: T[],
): CaregiverMatchResult<T> {
  const targetPhone = phoneDigits(customer?.phone || "");
  const targetEmail = normalizeEmail(customer?.email || "");

  if (targetPhone) {
    const byPhone = caregivers.find(
      (c) => phoneDigits(c.phone || "") === targetPhone,
    );
    if (byPhone) {
      return { caregiver: byPhone, matchMethod: "phone" };
    }
  }

  if (targetEmail) {
    const byEmail = caregivers.find(
      (c) => normalizeEmail(c.email || "") === targetEmail,
    );
    if (byEmail) {
      return { caregiver: byEmail, matchMethod: "email" };
    }
  }

  return { caregiver: null, matchMethod: "unmatched" };
}

// ─── Microsoft Graph appointment normalization ───────────────────────────
// Graph's bookingAppointment object nests dateTime values under
// dateTimeTimeZone wrappers, customers under an array, and the
// cancellation marker under a separate `cancellationReason` field.
// `normalizeGraphAppointment` produces a flat row matching the
// `caregiver_interviews` table contract — it does NOT include
// caregiver_id or match_method, which the caller fills in after
// running matchCustomerToCaregiver against the org's caregivers.

export interface GraphCustomer {
  customerId?: string | null;
  name?: string | null;
  emailAddress?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface GraphAppointment {
  id?: string;
  serviceId?: string | null;
  serviceName?: string | null;
  staffMemberIds?: string[] | null;
  startDateTime?: { dateTime?: string | null; timeZone?: string | null } | null;
  endDateTime?: { dateTime?: string | null; timeZone?: string | null } | null;
  isLocationOnline?: boolean;
  joinWebUrl?: string | null;
  customers?: GraphCustomer[] | null;
  // Cancellation: Graph returns a non-empty string when an appointment
  // has been cancelled. Our local `status` field collapses to a single
  // enum: 'cancelled' if cancellationReason is set, otherwise 'booked'.
  cancellationReason?: string | null;
}

export interface NormalizedAppointment {
  graph_appointment_id: string;
  service_id: string | null;
  service_name: string | null;
  staff_member_ids: string[];
  start_at: string | null;
  end_at: string | null;
  status: "booked" | "cancelled";
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_notes: string | null;
  join_web_url: string | null;
}

// Convert a Graph dateTimeTimeZone wrapper to a UTC ISO string. Graph
// returns naive local times like "2026-05-12T14:30:00.0000000" plus a
// tz string. We render in the tz when displaying, but for storage we
// keep the raw ISO and let Postgres timestamptz parse it. Returns null
// on missing/invalid input rather than throwing — bad data should
// flow through, not crash the webhook.
export function graphDateTimeToIso(
  dt: { dateTime?: string | null; timeZone?: string | null } | null | undefined,
): string | null {
  if (!dt || typeof dt !== "object") return null;
  const raw = dt.dateTime;
  if (!raw || typeof raw !== "string") return null;
  // Postgres timestamptz can parse "2026-05-12T14:30:00" without offset
  // (treating as UTC) but to be explicit and survive future PG
  // configuration drift, append Z when no offset is present. Graph's
  // values are already expressed in UTC for app-only auth callers.
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  return hasOffset ? raw : `${raw}Z`;
}

export function normalizeGraphAppointment(
  appt: GraphAppointment,
): NormalizedAppointment {
  const customers = Array.isArray(appt.customers) ? appt.customers : [];
  const primary: GraphCustomer = customers[0] || {};
  const cancellationReason =
    typeof appt.cancellationReason === "string" ? appt.cancellationReason : "";

  return {
    graph_appointment_id: typeof appt.id === "string" ? appt.id : "",
    service_id: appt.serviceId || null,
    service_name: appt.serviceName || null,
    staff_member_ids: Array.isArray(appt.staffMemberIds)
      ? appt.staffMemberIds.filter((s): s is string => typeof s === "string")
      : [],
    start_at: graphDateTimeToIso(appt.startDateTime),
    end_at: graphDateTimeToIso(appt.endDateTime),
    status: cancellationReason ? "cancelled" : "booked",
    customer_name: primary.name || null,
    customer_email: primary.emailAddress || null,
    customer_phone: primary.phone || null,
    customer_notes: primary.notes || null,
    join_web_url: appt.joinWebUrl || null,
  };
}

