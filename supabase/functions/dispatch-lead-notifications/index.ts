// ─────────────────────────────────────────────────────────────────
// Dispatch Lead Notifications (PR 3 of the lead-notification feature)
//
// Cron-invoked worker (every 5 minutes, see migration
// 20260523000200_dispatch_lead_notifications_cron.sql) that drains
// the lead_notification_queue table created in PR 1.
//
// Per pending row:
//   1. Load the org's lead_notifications settings (PR 2 shape).
//   2. If `enabled` is false → mark `skipped_disabled` and move on.
//   3. If we're in the org's quiet-hours window → push scheduled_for
//      forward to the next end-of-quiet-hours and leave the row
//      pending. The next cron tick will resurface it.
//   4. Otherwise: build the SMS body + Teams Adaptive Card, send
//      SMS to every configured recipient (10s spaced to respect
//      RingCentral's 40-per-60s limit), POST to the Teams webhook,
//      and insert one notifications_user row per toast recipient.
//   5. Update the queue row with sent_at, status, channels JSON, and
//      log a lead_notification_sent event.
//
// Idempotency: only rows with status='pending' AND scheduled_for<=now
// are claimed each tick. The first action on a row is to UPDATE it to
// status='processing' before sending so a parallel cron tick can't
// double-send. (pg_cron runs each job on a single backend so the
// risk is low, but defensive.)
//
// Production safety:
//   • Feature flag (`enabled = false`) is checked per row, per tick.
//   • Quiet hours respected for both SMS and Teams; toast still fires.
//   • Each channel's success/failure is recorded independently in
//     `channels` JSON — a Teams webhook outage doesn't block SMS.
//   • Per-row try/catch isolates failures so one bad lead doesn't
//     halt the cron tick for everyone.
// ─────────────────────────────────────────────────────────────────

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildSmsBody,
  buildTeamsAdaptiveCard,
  buildToastRow,
  coerceLeadNotificationSettings,
  isInQuietHours,
  leadProfileUrl,
  nextSendTime,
  normalizePhoneE164,
  type LeadNotificationSettings,
  type LeadRecord,
  type QueueRowSnapshot,
} from "../_shared/helpers/leadNotifications.ts";
import {
  getRingCentralAccessTokenWithJwt,
  getSendingCredentials,
  sendSmsToRingCentralWithRetry,
} from "../_shared/helpers/ringcentral.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PORTAL_BASE_URL = Deno.env.get("PORTAL_BASE_URL") ?? "https://caregiver-portal.vercel.app";

// 10-second spacing between RC sends matches the existing automation-
// cron pacing — well under the 40-per-60s SMS limit, with headroom
// for staff manual sends overlapping the cron tick.
const SMS_SEND_DELAY_MS = 10_000;

// Maximum rows claimed per cron tick. Conservative cap so a backlog
// from a long Teams outage drains in batches rather than risking a
// single 60s function timeout.
const MAX_ROWS_PER_TICK = 50;

// Teams webhook HTTP timeout. Power Automate workflows typically
// respond in under a second; a long timeout means a stalled flow
// could block the dispatcher loop and starve SMS sends.
const TEAMS_FETCH_TIMEOUT_MS = 8_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface QueueRow {
  id: string;
  org_id: string;
  lead_id: string;
  scheduled_for: string;
  status: string;
  attempts: number;
  channels: Record<string, unknown>;
  created_at: string;
}

interface ChannelResults {
  sms: {
    attempted: number;
    sent: number;
    failed: number;
    errors: string[];
  };
  teams: {
    attempted: boolean;
    sent: boolean;
    error: string | null;
  };
  toast: {
    attempted: number;
    inserted: number;
    error: string | null;
  };
}

interface ProcessSummary {
  rows_claimed: number;
  sent: number;
  skipped_disabled: number;
  deferred_quiet_hours: number;
  failed: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const now = new Date();
  const summary: ProcessSummary = {
    rows_claimed: 0,
    sent: 0,
    skipped_disabled: 0,
    deferred_quiet_hours: 0,
    failed: 0,
  };

  // ── 1. Claim pending rows ────────────────────────────────────────
  // Read-only first; we mark each row status='processing' as we pick
  // it up below to prevent a double-send if two cron ticks overlap.
  const { data: rows, error: claimErr } = await supabase
    .from("lead_notification_queue")
    .select("id, org_id, lead_id, scheduled_for, status, attempts, channels, created_at")
    .eq("status", "pending")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(MAX_ROWS_PER_TICK);

  if (claimErr) {
    console.error("[dispatch-lead-notifications] queue claim failed:", claimErr);
    return new Response(
      JSON.stringify({ ok: false, error: claimErr.message, summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!rows || rows.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  summary.rows_claimed = rows.length;

  // Cache org settings + team_member lookups so we don't re-fetch
  // per row when a single tick has multiple leads for the same org
  // (rare today, common once multi-tenant scale arrives).
  const orgSettingsCache = new Map<string, LeadNotificationSettings>();
  const teamMembersCache = new Map<string, Map<string, { display_name: string; phone: string }>>();

  for (const row of rows as QueueRow[]) {
    try {
      await processQueueRow(row, now, orgSettingsCache, teamMembersCache, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch-lead-notifications] row ${row.id} crashed:`, msg);
      summary.failed += 1;
      await supabase
        .from("lead_notification_queue")
        .update({
          status: "failed",
          attempts: (row.attempts || 0) + 1,
          last_error: msg.slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, summary }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

async function processQueueRow(
  row: QueueRow,
  now: Date,
  orgSettingsCache: Map<string, LeadNotificationSettings>,
  teamMembersCache: Map<string, Map<string, { display_name: string; phone: string }>>,
  summary: ProcessSummary,
): Promise<void> {
  // ── Load org settings (cached per tick) ────────────────────────
  let settings = orgSettingsCache.get(row.org_id);
  if (!settings) {
    const { data: orgRow, error: orgErr } = await supabase
      .from("organizations")
      .select("settings")
      .eq("id", row.org_id)
      .maybeSingle();
    if (orgErr || !orgRow) {
      throw new Error(`org settings lookup failed: ${orgErr?.message ?? "no row"}`);
    }
    const raw = (orgRow as { settings: Record<string, unknown> }).settings?.lead_notifications;
    settings = coerceLeadNotificationSettings(raw);
    orgSettingsCache.set(row.org_id, settings);
  }

  // ── Feature flag ──────────────────────────────────────────────
  if (!settings.enabled) {
    await supabase
      .from("lead_notification_queue")
      .update({
        status: "skipped_disabled",
        attempts: (row.attempts || 0) + 1,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    summary.skipped_disabled += 1;
    return;
  }

  // ── Quiet hours: defer SMS+Teams (toast still fires) ──────────
  const inQuietHours = isInQuietHours(
    now,
    settings.quiet_hours_timezone,
    settings.quiet_hours_start_hour,
    settings.quiet_hours_end_hour,
  );
  if (inQuietHours) {
    const nextAttempt = nextSendTime(
      now,
      settings.quiet_hours_timezone,
      settings.quiet_hours_start_hour,
      settings.quiet_hours_end_hour,
    );
    await supabase
      .from("lead_notification_queue")
      .update({
        scheduled_for: nextAttempt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    summary.deferred_quiet_hours += 1;
    return;
  }

  // ── Load the lead ─────────────────────────────────────────────
  const { data: lead, error: leadErr } = await supabase
    .from("clients")
    .select(
      "id, first_name, last_name, phone, email, city, state, care_needs, referral_source, referral_detail, hours_needed, budget_range, start_date_preference, contact_name, care_recipient_name",
    )
    .eq("id", row.lead_id)
    .maybeSingle();
  if (leadErr || !lead) {
    throw new Error(`lead lookup failed: ${leadErr?.message ?? "not found"}`);
  }

  // ── Load team member directory for the org (cached) ───────────
  // team_members carries org_id since Phase B; scope the query so a
  // future multi-tenant deploy can't accidentally see another org's
  // directory when resolving SMS recipient phones.
  let memberMap = teamMembersCache.get(row.org_id);
  if (!memberMap) {
    const { data: members } = await supabase
      .from("team_members")
      .select("email, display_name, personal_phone, is_active, org_id")
      .eq("is_active", true)
      .eq("org_id", row.org_id);
    memberMap = new Map();
    for (const m of (members ?? []) as { email: string; display_name: string; personal_phone: string }[]) {
      if (m.email) {
        memberMap.set(m.email.toLowerCase(), {
          display_name: m.display_name ?? m.email,
          phone: m.personal_phone ?? "",
        });
      }
    }
    teamMembersCache.set(row.org_id, memberMap);
  }

  const queueSnapshot: QueueRowSnapshot = {
    id: row.id,
    org_id: row.org_id,
    lead_id: row.lead_id,
    scheduled_for: row.scheduled_for,
    created_at: row.created_at,
  };
  const profileUrl = leadProfileUrl(PORTAL_BASE_URL, row.lead_id);
  const smsBody = buildSmsBody(
    lead as LeadRecord,
    queueSnapshot,
    now,
    settings.quiet_hours_timezone,
    profileUrl,
  );
  const teamsCard = buildTeamsAdaptiveCard(
    lead as LeadRecord,
    queueSnapshot,
    now,
    settings.quiet_hours_timezone,
    profileUrl,
  );

  const channels: ChannelResults = {
    sms: { attempted: 0, sent: 0, failed: 0, errors: [] },
    teams: { attempted: false, sent: false, error: null },
    toast: { attempted: 0, inserted: 0, error: null },
  };

  // ── Mark as processing so a parallel tick can't double-send ───
  await supabase
    .from("lead_notification_queue")
    .update({
      attempts: (row.attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  // ── SMS fan-out ───────────────────────────────────────────────
  await sendSmsFanOut(settings, memberMap, smsBody, channels);

  // ── Teams webhook ─────────────────────────────────────────────
  if (settings.teams_webhook_url) {
    channels.teams.attempted = true;
    try {
      await postToTeamsWebhook(settings.teams_webhook_url, teamsCard);
      channels.teams.sent = true;
    } catch (err) {
      channels.teams.error = err instanceof Error ? err.message : String(err);
      console.error(
        `[dispatch-lead-notifications] Teams post failed for queue ${row.id}:`,
        channels.teams.error,
      );
    }
  }

  // ── Toast inserts ─────────────────────────────────────────────
  if (settings.toast_recipient_emails.length > 0) {
    channels.toast.attempted = settings.toast_recipient_emails.length;
    const toastRows = settings.toast_recipient_emails.map((email) =>
      buildToastRow(email, lead as LeadRecord, queueSnapshot, profileUrl)
    );
    const { error: toastErr, count } = await supabase
      .from("notifications_user")
      .insert(toastRows, { count: "exact" });
    if (toastErr) {
      channels.toast.error = toastErr.message;
      console.error(
        `[dispatch-lead-notifications] Toast insert failed for queue ${row.id}:`,
        toastErr.message,
      );
    } else {
      channels.toast.inserted = count ?? toastRows.length;
    }
  }

  // ── Finalize queue row ────────────────────────────────────────
  const overallSent = channels.sms.sent > 0
    || channels.teams.sent
    || channels.toast.inserted > 0;
  await supabase
    .from("lead_notification_queue")
    .update({
      sent_at: new Date().toISOString(),
      status: overallSent ? "sent" : "failed",
      channels: channels as unknown as Record<string, unknown>,
      last_error: overallSent ? null : "no channel succeeded",
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  // ── Observability ─────────────────────────────────────────────
  await supabase.from("events").insert({
    org_id: row.org_id,
    event_type: overallSent ? "lead_notification_sent" : "lead_notification_failed",
    entity_type: "client",
    entity_id: null,
    actor: "system:dispatch-lead-notifications",
    payload: {
      lead_id: row.lead_id,
      queue_id: row.id,
      channels,
    },
  });

  if (overallSent) summary.sent += 1;
  else summary.failed += 1;
}

async function sendSmsFanOut(
  settings: LeadNotificationSettings,
  memberMap: Map<string, { display_name: string; phone: string }>,
  body: string,
  channels: ChannelResults,
): Promise<void> {
  if (settings.sms_recipient_emails.length === 0) return;

  // RingCentral credentials. PR 3 ships without a per-route category
  // so we use the legacy env-var path (the org's default RC line) —
  // the same path bulk-sms uses when no category is selected. Future
  // work can introduce a dedicated 'lead_notifications' route in
  // communication_routes if a separate sender number is desired.
  let creds: { fromNumber: string; jwt: string };
  try {
    creds = await getSendingCredentials(supabase, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channels.sms.errors.push(`credentials: ${msg}`);
    channels.sms.attempted = settings.sms_recipient_emails.length;
    channels.sms.failed = settings.sms_recipient_emails.length;
    return;
  }

  let accessToken: string;
  try {
    accessToken = await getRingCentralAccessTokenWithJwt(creds.jwt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channels.sms.errors.push(`auth: ${msg}`);
    channels.sms.attempted = settings.sms_recipient_emails.length;
    channels.sms.failed = settings.sms_recipient_emails.length;
    return;
  }

  let first = true;
  for (const recipientEmail of settings.sms_recipient_emails) {
    if (!first) await sleep(SMS_SEND_DELAY_MS);
    first = false;

    channels.sms.attempted += 1;
    const member = memberMap.get(recipientEmail.toLowerCase());
    if (!member || !member.phone) {
      channels.sms.failed += 1;
      channels.sms.errors.push(`${recipientEmail}: no phone on file`);
      continue;
    }
    const toNumber = normalizePhoneE164(member.phone);
    if (!toNumber) {
      channels.sms.failed += 1;
      channels.sms.errors.push(`${recipientEmail}: phone "${member.phone}" not parseable`);
      continue;
    }

    try {
      const resp = await sendSmsToRingCentralWithRetry(
        accessToken,
        creds.fromNumber,
        toNumber,
        body,
      );
      if (resp.ok) {
        channels.sms.sent += 1;
      } else {
        const text = await resp.text().catch(() => "");
        channels.sms.failed += 1;
        channels.sms.errors.push(
          `${recipientEmail}: RC ${resp.status} ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      channels.sms.failed += 1;
      channels.sms.errors.push(`${recipientEmail}: ${msg}`);
    }
  }
}

async function postToTeamsWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEAMS_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok && resp.status >= 500 && resp.status < 600) {
      // One retry on 5xx — same idempotency reasoning as the RC SMS
      // helper: Power Automate's HTTP trigger does not deliver on a
      // 5xx, so a retry can't double-post.
      const second = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!second.ok) {
        const text = await second.text().catch(() => "");
        throw new Error(`Teams webhook ${second.status} ${text.slice(0, 200)}`);
      }
      return;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Teams webhook ${resp.status} ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
