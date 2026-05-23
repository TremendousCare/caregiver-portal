// ─── Lead Notification Helpers ───
// Pure functions for the dispatch-lead-notifications edge function.
// Isolated here so they can be unit-tested without Deno / Supabase.
//
// Used by supabase/functions/dispatch-lead-notifications/index.ts.

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface LeadNotificationSettings {
  enabled: boolean;
  sms_recipient_emails: string[];
  teams_webhook_url: string;
  toast_recipient_emails: string[];
  quiet_hours_start_hour: number;
  quiet_hours_end_hour: number;
  quiet_hours_timezone: string;
}

export interface LeadRecord {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  care_needs?: string | null;
  referral_source?: string | null;
  referral_detail?: string | null;
  hours_needed?: string | null;
  budget_range?: string | null;
  start_date_preference?: string | null;
  contact_name?: string | null;
  care_recipient_name?: string | null;
}

export interface QueueRowSnapshot {
  id: string;
  org_id: string;
  lead_id: string;
  scheduled_for: string;
  created_at: string;
}

// ────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_LEAD_NOTIFICATION_SETTINGS: LeadNotificationSettings = {
  enabled: false,
  sms_recipient_emails: [],
  teams_webhook_url: "",
  toast_recipient_emails: [],
  quiet_hours_start_hour: 21,
  quiet_hours_end_hour: 7,
  quiet_hours_timezone: "America/Los_Angeles",
};

// Coerce a raw settings JSONB into a fully-defaulted shape. Anything
// missing or the wrong type is replaced with the default for that key.
// This is the source of truth for what the dispatcher actually reads
// at send time — if the Settings UI saves a partial value, the seed
// migration already pre-fills the rest, but defensive coercion here
// guarantees the dispatcher can never crash on missing keys.
export function coerceLeadNotificationSettings(
  raw: unknown,
): LeadNotificationSettings {
  const d = DEFAULT_LEAD_NOTIFICATION_SETTINGS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    sms_recipient_emails: Array.isArray(r.sms_recipient_emails)
      ? r.sms_recipient_emails.filter((x): x is string => typeof x === "string")
      : d.sms_recipient_emails,
    teams_webhook_url: typeof r.teams_webhook_url === "string"
      ? r.teams_webhook_url
      : d.teams_webhook_url,
    toast_recipient_emails: Array.isArray(r.toast_recipient_emails)
      ? r.toast_recipient_emails.filter((x): x is string => typeof x === "string")
      : d.toast_recipient_emails,
    quiet_hours_start_hour: Number.isInteger(r.quiet_hours_start_hour)
      && (r.quiet_hours_start_hour as number) >= 0
      && (r.quiet_hours_start_hour as number) <= 23
      ? (r.quiet_hours_start_hour as number)
      : d.quiet_hours_start_hour,
    quiet_hours_end_hour: Number.isInteger(r.quiet_hours_end_hour)
      && (r.quiet_hours_end_hour as number) >= 0
      && (r.quiet_hours_end_hour as number) <= 23
      ? (r.quiet_hours_end_hour as number)
      : d.quiet_hours_end_hour,
    quiet_hours_timezone: typeof r.quiet_hours_timezone === "string"
      && r.quiet_hours_timezone.length > 0
      ? r.quiet_hours_timezone
      : d.quiet_hours_timezone,
  };
}

// ────────────────────────────────────────────────────────────────────
// Quiet-hours math
// ────────────────────────────────────────────────────────────────────

// Returns the local hour [0..23] of `now` in the given IANA timezone.
// Falls back to UTC hour on any Intl failure.
function getLocalHour(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const parsed = parseInt(fmt.format(now), 10);
    return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

// Returns true if `now` falls inside the org's quiet-hours window for
// the configured timezone. Supports midnight-wrapping windows where
// startHour > endHour (e.g. 21 → 7 means "9pm through 6:59am the next
// morning"). Returns false for degenerate windows (start === end) so
// admins can't lock themselves out by mis-configuring.
export function isInQuietHours(
  now: Date,
  tz: string,
  startHour: number,
  endHour: number,
): boolean {
  if (startHour === endHour) return false;
  const h = getLocalHour(now, tz);
  if (startHour < endHour) {
    // Non-wrapping: quiet zone is [start, end).
    return h >= startHour && h < endHour;
  }
  // Wrapping (the common case for overnight quiet): quiet zone is
  // [start, 24) ∪ [0, end).
  return h >= startHour || h < endHour;
}

// Compute the next timestamp at which a deferred notification should
// be retried. If we're not in quiet hours, returns `now` (caller sends
// immediately). If we are in quiet hours, returns the first moment
// where local hour === endHour. Cron precision is 5 min so the exact
// minute past the hour does not matter; the dispatcher will re-check
// when this row resurfaces.
export function nextSendTime(
  now: Date,
  tz: string,
  startHour: number,
  endHour: number,
): Date {
  if (!isInQuietHours(now, tz, startHour, endHour)) return now;
  // Walk forward up to 48 hours looking for the first hour-of-day that
  // matches endHour in the org's timezone. Bounded to defend against
  // a wedged Intl implementation; 48 covers the worst case (any tz on
  // any DST day).
  let candidate = new Date(now.getTime());
  for (let i = 0; i < 48; i++) {
    candidate = new Date(candidate.getTime() + 60 * 60 * 1000);
    if (getLocalHour(candidate, tz) === endHour) {
      return candidate;
    }
  }
  return candidate;
}

// ────────────────────────────────────────────────────────────────────
// Phone / display helpers
// ────────────────────────────────────────────────────────────────────

// Format a phone number for human display. Accepts +19498732367 and
// 9498732367 and returns "+1 (949) 873-2367". Unparseable input falls
// through unchanged so we never silently drop a value.
export function formatPhoneForDisplay(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

// Normalize a phone number to E.164 for outbound SMS. Returns null if
// the input does not have at least 10 digits — defensive: an SMS send
// without a valid normalized number would be rejected by RingCentral
// anyway, but bailing earlier surfaces a cleaner error in the queue
// row's last_error.
export function normalizePhoneE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Profile URL
// ────────────────────────────────────────────────────────────────────

// Build the absolute URL to a lead's profile page. The portal hosts
// per-org under a single Vercel domain today; once Phase D ships
// per-org subdomains we'll resolve from organizations.settings.
export function leadProfileUrl(
  portalBaseUrl: string,
  leadId: string,
): string {
  const base = portalBaseUrl.replace(/\/+$/, "");
  return `${base}/clients/${encodeURIComponent(leadId)}`;
}

// ────────────────────────────────────────────────────────────────────
// SMS body
// ────────────────────────────────────────────────────────────────────

// How long after a queue row's `created_at` we consider a notification
// "overnight queued". A value of 30 min catches deferred sends from
// the quiet-hour window without surfacing the tag on routine sub-tick
// delays. Visible only when the user opted into the tag (which we do
// by default per the Q&A in the planning thread).
const OVERNIGHT_QUEUED_THRESHOLD_MS = 30 * 60 * 1000;

// Format a relative "received Xpm last night" tag for SMS. Returns
// the empty string when the notification is fresh (sent within
// OVERNIGHT_QUEUED_THRESHOLD_MS of being enqueued). Always uses the
// org's quiet-hours timezone for the displayed clock time.
export function buildOvernightTag(
  queueRow: QueueRowSnapshot,
  now: Date,
  tz: string,
): string {
  const createdAt = new Date(queueRow.created_at);
  if (!Number.isFinite(createdAt.getTime())) return "";
  if (now.getTime() - createdAt.getTime() < OVERNIGHT_QUEUED_THRESHOLD_MS) {
    return "";
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `(received ${fmt.format(createdAt)} last night)`;
  } catch {
    return "";
  }
}

// Best-effort display name. Falls back through several fields so the
// SMS never says "New Lead: undefined".
function leadDisplayName(lead: LeadRecord): string {
  const first = (lead.first_name || "").trim();
  const last = (lead.last_name || "").trim();
  if (first || last) return `${first} ${last}`.trim();
  const contact = (lead.contact_name || "").trim();
  if (contact) return contact;
  const recipient = (lead.care_recipient_name || "").trim();
  if (recipient) return recipient;
  return "(unnamed lead)";
}

// Compose the SMS body the dispatcher sends to each configured
// recipient. Caps the result at ~320 chars (2 SMS segments) by
// truncating care_needs if necessary — RingCentral will accept longer
// but multi-segment messages cost more and most carriers split awkwardly
// at message-end markers.
export function buildSmsBody(
  lead: LeadRecord,
  queueRow: QueueRowSnapshot,
  now: Date,
  tz: string,
  profileUrl: string,
): string {
  const name = leadDisplayName(lead);

  const cityState = [lead.city, lead.state].filter((x) => x && (x as string).trim()).join(", ");
  const careNeeds = (lead.care_needs || "").trim();
  const cityCareLine = [cityState, careNeeds].filter((x) => x).join(" · ");

  const sourceLine = lead.referral_source ? `Source: ${lead.referral_source}` : "";

  const overnight = buildOvernightTag(queueRow, now, tz);

  const phoneDisplay = formatPhoneForDisplay(lead.phone || "");
  const callLine = phoneDisplay ? `Call: ${phoneDisplay}` : "";

  const profileLine = `Profile: ${profileUrl}`;

  const lines = [
    `New Lead: ${name}`,
    cityCareLine,
    sourceLine,
    overnight,
    callLine,
    profileLine,
  ].filter((line) => line && line.length > 0);

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Teams Adaptive Card
// ────────────────────────────────────────────────────────────────────

interface TeamsFact { title: string; value: string; }

// Build the Adaptive Card payload Power Automate's "Post message in
// chat or channel" connector consumes when the HTTP request arrives
// from this dispatcher. Schema reference: https://adaptivecards.io
//
// Two top-level "actions" — Open Profile + Call Now — render as buttons
// on the message. The tel: URL works on Teams mobile + desktop with
// the dialer integration; Teams web silently no-ops.
export function buildTeamsAdaptiveCard(
  lead: LeadRecord,
  queueRow: QueueRowSnapshot,
  now: Date,
  tz: string,
  profileUrl: string,
): Record<string, unknown> {
  const name = leadDisplayName(lead);
  const phoneE164 = normalizePhoneE164(lead.phone);
  const phoneDisplay = formatPhoneForDisplay(lead.phone);

  const facts: TeamsFact[] = [];
  if (phoneDisplay) facts.push({ title: "Phone", value: phoneDisplay });
  if (lead.email) facts.push({ title: "Email", value: lead.email });
  const cityState = [lead.city, lead.state].filter((x) => x && (x as string).trim()).join(", ");
  if (cityState) facts.push({ title: "Location", value: cityState });
  if (lead.care_needs) facts.push({ title: "Care Needs", value: lead.care_needs });
  if (lead.hours_needed) facts.push({ title: "Hours", value: lead.hours_needed });
  if (lead.budget_range) facts.push({ title: "Budget", value: lead.budget_range });
  if (lead.start_date_preference) {
    facts.push({ title: "Start Date", value: lead.start_date_preference });
  }
  if (lead.referral_source) facts.push({ title: "Source", value: lead.referral_source });
  if (lead.referral_detail) facts.push({ title: "Source Detail", value: lead.referral_detail });

  const overnight = buildOvernightTag(queueRow, now, tz);
  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: "New Lead", weight: "Bolder", size: "Medium", color: "Accent" },
    { type: "TextBlock", text: name, weight: "Bolder", size: "ExtraLarge", spacing: "None" },
  ];
  if (overnight) {
    body.push({ type: "TextBlock", text: overnight, isSubtle: true, spacing: "None" });
  }
  body.push({ type: "FactSet", facts });

  const actions: Record<string, unknown>[] = [
    { type: "Action.OpenUrl", title: "Open Profile", url: profileUrl },
  ];
  if (phoneE164) {
    actions.push({ type: "Action.OpenUrl", title: "Call Now", url: `tel:${phoneE164}` });
  }

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body,
        actions,
      },
    }],
  };
}

// ────────────────────────────────────────────────────────────────────
// Toast row builder
// ────────────────────────────────────────────────────────────────────

// Build the notifications_user row payload for a single toast
// recipient. Returned as a plain object the dispatcher inserts via
// supabase.from('notifications_user').insert(...).
export function buildToastRow(
  recipientEmail: string,
  lead: LeadRecord,
  queueRow: QueueRowSnapshot,
  profileUrl: string,
): Record<string, unknown> {
  const name = leadDisplayName(lead);
  return {
    org_id: queueRow.org_id,
    user_email: recipientEmail,
    notification_type: "new_lead",
    lead_id: queueRow.lead_id,
    title: "New lead in pipeline",
    message: name,
    link_url: profileUrl,
    severity: "info",
  };
}
