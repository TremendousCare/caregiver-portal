// ─────────────────────────────────────────────────────────────────
// Dispatch Executive Task Notifications.
//
// Cron-invoked worker (every 15 minutes, see migration
// 20260530000100_exec_task_notifications_dispatch_cron.sql).
// Each tick:
//
//   1. Expire snoozes: flip exec_tasks where status='snoozed' AND
//      snoozed_until <= now() back to 'pending' and clear
//      notified_at so the next pass re-notifies.
//
//   2. Notify due tasks: scan rows where due_at <= now() AND
//      notified_at IS NULL AND status IN ('pending','in_progress').
//      For each match:
//        - Resolve recipients (assigned_to if set; else fan-out to
//          every owner email from get_owner_emails).
//        - Insert one notifications_user row per recipient
//          (bell + toast surfaces via realtime).
//        - If the parent template has send_email_on_notify=true,
//          POST to outlook-integration once per recipient.
//        - Set the task's notified_at so the next tick skips it.
//
// Per-row try/catch isolates failures so one bad task doesn't halt
// the tick.
//
// Idempotency: setting notified_at as the final write means a second
// tick won't double-fire. Rows only become eligible again when the
// owner snoozes (snooze-expiry clears notified_at) or reopens.
//
// Multi-tenancy:
//   • Each task carries org_id; recipient resolution honors the
//     get_owner_emails(p_org_id) contract (today the function
//     returns global owners — multi-tenant phase will tighten).
//   • Service-role client bypasses RLS, but every write keys to the
//     source row's org_id, so cross-tenant writes are impossible
//     unless the source row itself is mis-tenanted.
// ─────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  resolveRecipients,
  shouldSendEmail,
  buildToastTitle,
  buildToastMessage,
  buildEmailSubject,
  buildEmailBody,
} from "../../../src/lib/exec/execNotificationRecipients.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_BASE_URL =
  Deno.env.get("PORTAL_BASE_URL") ?? "https://caregiver-portal.vercel.app";

// Cap per tick so a backlog from an outage drains in batches.
const MAX_ROWS_PER_TICK = 100;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ExecTaskRow {
  id: string;
  org_id: string;
  template_id: string | null;
  title: string;
  description: string | null;
  category: "lifecycle" | "recurring" | "ad_hoc";
  visibility: string;
  assigned_to: string | null;
  due_at: string;
  status: string;
  urgency: "critical" | "warning" | "info";
  anchor_staff_email: string | null;
  anchor_date: string | null;
  recurrence_period: string | null;
  exec_task_templates: {
    name: string;
    guidance: string | null;
    send_email_on_notify: boolean;
  } | null;
}

interface DispatchSummary {
  snoozes_expired: number;
  due_scanned: number;
  notifications_inserted: number;
  emails_sent: number;
  email_failed: number;
  notify_failed: number;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();
  const summary: DispatchSummary = {
    snoozes_expired: 0,
    due_scanned: 0,
    notifications_inserted: 0,
    emails_sent: 0,
    email_failed: 0,
    notify_failed: 0,
  };

  // ── 1. Expire snoozes ───────────────────────────────────────────
  const { data: expiredRows, error: expireErr } = await supabase
    .from("exec_tasks")
    .update({
      status: "pending",
      notified_at: null,
      updated_at: now.toISOString(),
    })
    .eq("status", "snoozed")
    .lte("snoozed_until", now.toISOString())
    .select("id");
  if (expireErr) {
    console.error(
      "[dispatch-exec-task-notifications] snooze expiry failed:",
      expireErr.message,
    );
  } else {
    summary.snoozes_expired = expiredRows?.length ?? 0;
  }

  // ── 2. Claim due tasks ──────────────────────────────────────────
  const { data: dueTasks, error: claimErr } = await supabase
    .from("exec_tasks")
    .select(`
      id, org_id, template_id, title, description, category, visibility,
      assigned_to, due_at, status, urgency,
      anchor_staff_email, anchor_date, recurrence_period,
      exec_task_templates ( name, guidance, send_email_on_notify )
    `)
    .in("status", ["pending", "in_progress"])
    .is("notified_at", null)
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(MAX_ROWS_PER_TICK);

  if (claimErr) {
    return jsonResponse(500, { ok: false, error: claimErr.message, summary });
  }
  summary.due_scanned = dueTasks?.length ?? 0;

  if (!dueTasks || dueTasks.length === 0) {
    return jsonResponse(200, { ok: true, summary });
  }

  // Per-org cache of owner emails. Most ticks touch one org so the
  // batched RPC is one call per tick in practice.
  const ownerEmailCache = new Map<string, string[]>();
  async function getOwnersFor(orgId: string): Promise<string[]> {
    if (ownerEmailCache.has(orgId)) return ownerEmailCache.get(orgId)!;
    const { data, error } = await supabase
      .rpc("get_owner_emails", { p_org_id: orgId });
    if (error) {
      console.error(
        `[dispatch-exec-task-notifications] get_owner_emails failed for org ${orgId}:`,
        error.message,
      );
      ownerEmailCache.set(orgId, []);
      return [];
    }
    const list = Array.isArray(data) ? data : [];
    ownerEmailCache.set(orgId, list);
    return list;
  }

  for (const row of dueTasks as unknown as ExecTaskRow[]) {
    try {
      await notifyOneTask(supabase, row, summary, getOwnersFor);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[dispatch-exec-task-notifications] task ${row.id} crashed:`,
        msg,
      );
      summary.notify_failed += 1;
    }
  }

  return jsonResponse(200, { ok: true, summary });
});

async function notifyOneTask(
  supabase: SupabaseClient,
  row: ExecTaskRow,
  summary: DispatchSummary,
  getOwnersFor: (orgId: string) => Promise<string[]>,
): Promise<void> {
  // ── Resolve recipients ─────────────────────────────────────────
  const ownerEmails = row.assigned_to ? [] : await getOwnersFor(row.org_id);
  const recipients = resolveRecipients({
    assignedTo: row.assigned_to,
    ownerEmails,
  });

  if (recipients.length === 0) {
    // Nobody to notify (no assignee + no owners exist). Still set
    // notified_at so we don't keep scanning this row every tick;
    // log so a missing-owner config is visible in the function logs.
    console.warn(
      `[dispatch-exec-task-notifications] task ${row.id}: no recipients (assigned_to=null, owners=0). Marking notified to avoid scan-loop.`,
    );
    await markNotified(supabase, row.id);
    return;
  }

  // ── Compose payload (pure helpers — easy to unit test) ─────────
  const toastTitle = buildToastTitle(row);
  const toastMessage = buildToastMessage(row);
  const linkUrl = `${PORTAL_BASE_URL.replace(/\/$/, "")}/exec/tasks`;
  const severity = row.urgency === "critical" ? "urgent" : "info";

  // ── Insert notifications_user rows (one per recipient) ─────────
  // Done as a single batch insert; if it fails we surface and skip
  // the email send so a partial state isn't created.
  const notificationRows = recipients.map((email) => ({
    org_id: row.org_id,
    user_email: email,
    notification_type: "exec_task_due",
    title: toastTitle,
    message: toastMessage,
    link_url: linkUrl,
    severity,
  }));

  const { error: insertErr } = await supabase
    .from("notifications_user")
    .insert(notificationRows);

  if (insertErr) {
    summary.notify_failed += 1;
    console.error(
      `[dispatch-exec-task-notifications] notification insert failed for task ${row.id}:`,
      insertErr.message,
    );
    return;
  }
  summary.notifications_inserted += notificationRows.length;

  // ── Optional email send (best-effort, isolated per recipient) ──
  if (shouldSendEmail(row)) {
    const subject = buildEmailSubject(row);
    const body = buildEmailBody(row, PORTAL_BASE_URL);
    for (const to of recipients) {
      try {
        await sendOutlookEmail(to, subject, body);
        summary.emails_sent += 1;
      } catch (err) {
        summary.email_failed += 1;
        console.error(
          `[dispatch-exec-task-notifications] email to ${to} failed for task ${row.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // ── Mark notified_at ───────────────────────────────────────────
  // Done last so a notification-insert failure earlier leaves the
  // task eligible for retry next tick.
  await markNotified(supabase, row.id);

  // ── Observability event ───────────────────────────────────────
  await supabase.from("events").insert({
    org_id: row.org_id,
    event_type: "exec_task_due",
    entity_type: null,
    entity_id: null,
    actor: "system:dispatch-exec-task-notifications",
    payload: {
      task_id: row.id,
      title: row.title,
      due_at: row.due_at,
      category: row.category,
      urgency: row.urgency,
      recipients,
      email_sent: shouldSendEmail(row),
    },
  });
}

async function markNotified(supabase: SupabaseClient, taskId: string) {
  const ts = new Date().toISOString();
  await supabase
    .from("exec_tasks")
    .update({ notified_at: ts, updated_at: ts })
    .eq("id", taskId);
}

// Direct POST to outlook-integration — avoids the caregiver-note
// logging baggage of the shared sendEmail helper, which is not
// relevant for exec tasks. Throws on non-2xx so the caller's
// try/catch increments email_failed.
async function sendOutlookEmail(to: string, subject: string, body: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      action: "send_email",
      admin_email: null,
      to_email: to,
      to_name: null,
      subject,
      body,
      cc: null,
    }),
  });
  if (!res.ok) {
    throw new Error(`outlook-integration returned ${res.status}`);
  }
  const result = await res.json();
  if (result?.error) throw new Error(result.error);
}
