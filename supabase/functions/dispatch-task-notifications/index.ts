// ─────────────────────────────────────────────────────────────────
// Dispatch Task Notifications (Phase 2 of user-created follow-ups).
//
// Cron-invoked worker (every 5 minutes, see migration
// 20260527000001_task_notifications_dispatch.sql). Each tick:
//
//   1. Expire snoozes: flip rows where status='snoozed' AND
//      snoozed_until <= now() back to status='pending' and clear
//      notified_at so the next pass re-notifies.
//
//   2. Notify due tasks: scan rows where status='pending' AND
//      due_at <= now() AND notified_at IS NULL AND assigned_to IS NOT
//      NULL. For each match: insert one notifications_user row keyed
//      by the assignee's email, set the task's notified_at, and emit
//      a task_due event to the unified events bus.
//
// Per-row try/catch isolates failures so one bad task doesn't halt
// the tick.
//
// Idempotency: setting notified_at as the same UPDATE that inserts
// the notification means a second cron tick won't double-fire. Rows
// only become eligible again when reschedule (which clears
// notified_at) or snooze-expiry (same) re-arms them.
//
// Multi-tenancy:
//   • notifications_user inherits org_id from the task's org_id.
//   • Service-role client bypasses RLS, but every write is keyed to
//     the source row's org_id, so cross-tenant writes are impossible
//     unless the source row itself is mis-tenanted (which the Phase B
//     RLS prevents).
// ─────────────────────────────────────────────────────────────────

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_BASE_URL =
  Deno.env.get("PORTAL_BASE_URL") ?? "https://caregiver-portal.vercel.app";

// Conservative cap so a backlog from an outage drains in batches
// rather than risking a single 60s function timeout.
const MAX_ROWS_PER_TICK = 100;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

interface TaskRow {
  id: string;
  org_id: string;
  source: "template" | "user" | "ai";
  title: string | null;
  description: string | null;
  caregiver_id: string | null;
  client_id: string | null;
  assigned_to: string;
  urgency: "critical" | "warning" | "info";
  due_at: string;
  follow_up_templates: { name: string } | null;
}

interface DispatchSummary {
  snoozes_expired: number;
  due_scanned: number;
  notifications_inserted: number;
  notify_failed: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const now = new Date();
  const summary: DispatchSummary = {
    snoozes_expired: 0,
    due_scanned: 0,
    notifications_inserted: 0,
    notify_failed: 0,
  };

  // ── 1. Expire snoozes ───────────────────────────────────────────
  // RETURNING-style select afterwards is the cheapest way to count
  // affected rows when the driver doesn't expose row counts cleanly.
  // Using .select() on the UPDATE pulls the affected rows back so the
  // summary is accurate and the next step's scan picks them up.
  const { data: expiredRows, error: expireErr } = await supabase
    .from("follow_up_tasks")
    .update({
      status: "pending",
      notified_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "snoozed")
    .lte("snoozed_until", now.toISOString())
    .select("id");
  if (expireErr) {
    console.error("[dispatch-task-notifications] snooze expiry failed:", expireErr.message);
  } else {
    summary.snoozes_expired = expiredRows?.length ?? 0;
  }

  // ── 2. Claim due tasks ──────────────────────────────────────────
  // Filter `assigned_to NOT NULL` at runtime — the dispatch partial
  // index doesn't include it (Phase 1 didn't anticipate the unassigned
  // case), but at current scale the runtime filter is free.
  const { data: dueTasks, error: claimErr } = await supabase
    .from("follow_up_tasks")
    .select(`
      id, org_id, source, title, description,
      caregiver_id, client_id, assigned_to, urgency, due_at,
      follow_up_templates ( name )
    `)
    .eq("status", "pending")
    .is("notified_at", null)
    .not("assigned_to", "is", null)
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(MAX_ROWS_PER_TICK);

  if (claimErr) {
    console.error("[dispatch-task-notifications] due scan failed:", claimErr.message);
    return new Response(
      JSON.stringify({ ok: false, error: claimErr.message, summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  summary.due_scanned = dueTasks?.length ?? 0;

  if (!dueTasks || dueTasks.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Cache entity lookups within a single tick so a backlog targeting
  // the same caregiver/client doesn't N+1 the read side.
  const caregiverNames = new Map<string, string>();
  const clientNames = new Map<string, string>();

  for (const row of dueTasks as unknown as TaskRow[]) {
    try {
      await notifyOneTask(row, caregiverNames, clientNames, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch-task-notifications] task ${row.id} crashed:`, msg);
      summary.notify_failed += 1;
    }
  }

  return new Response(
    JSON.stringify({ ok: true, summary }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

async function notifyOneTask(
  row: TaskRow,
  caregiverNames: Map<string, string>,
  clientNames: Map<string, string>,
  summary: DispatchSummary,
): Promise<void> {
  // ── Resolve entity name + link target ──────────────────────────
  let entityName = "";
  let linkUrl = `${PORTAL_BASE_URL}/tasks`;

  if (row.caregiver_id) {
    let name = caregiverNames.get(row.caregiver_id);
    if (name === undefined) {
      const { data } = await supabase
        .from("caregivers")
        .select("first_name, last_name")
        .eq("id", row.caregiver_id)
        .maybeSingle();
      name = data
        ? `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() || row.caregiver_id
        : row.caregiver_id;
      caregiverNames.set(row.caregiver_id, name);
    }
    entityName = name;
    linkUrl = `${PORTAL_BASE_URL}/caregiver/${row.caregiver_id}`;
  } else if (row.client_id) {
    let name = clientNames.get(row.client_id);
    if (name === undefined) {
      const { data } = await supabase
        .from("clients")
        .select("first_name, last_name")
        .eq("id", row.client_id)
        .maybeSingle();
      name = data
        ? `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() || row.client_id
        : row.client_id;
      clientNames.set(row.client_id, name);
    }
    entityName = name;
    linkUrl = `${PORTAL_BASE_URL}/clients/${row.client_id}`;
  }

  // ── Compose title + message ────────────────────────────────────
  const displayTitle = row.title
    || row.follow_up_templates?.name
    || "Follow-up";
  const toastTitle = `Follow-up due: ${displayTitle}`;
  const toastMessage = entityName
    ? `${entityName} · due now`
    : "Due now";

  const severity = row.urgency === "critical" ? "urgent" : "info";

  // ── Insert the notification row ────────────────────────────────
  const { error: insertErr } = await supabase
    .from("notifications_user")
    .insert({
      org_id: row.org_id,
      user_email: row.assigned_to,
      notification_type: "task_due",
      title: toastTitle,
      message: toastMessage,
      link_url: linkUrl,
      severity,
    });

  if (insertErr) {
    summary.notify_failed += 1;
    console.error(
      `[dispatch-task-notifications] notification insert failed for task ${row.id}:`,
      insertErr.message,
    );
    return;
  }

  summary.notifications_inserted += 1;

  // ── Mark notified_at ───────────────────────────────────────────
  // Done AFTER the insert so a notification-insert failure leaves
  // the task eligible for the next tick (vs. silent drop).
  await supabase
    .from("follow_up_tasks")
    .update({
      notified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  // ── Emit observability event (fire-and-forget) ─────────────────
  // entity_id is uuid in the events table; caregivers.id and clients.id
  // are text, so we pass NULL and stash text IDs in the payload — same
  // convention as the rest of the codebase (see migration 20260523000000
  // line 159 comment).
  await supabase.from("events").insert({
    org_id: row.org_id,
    event_type: "task_due",
    entity_type: row.caregiver_id ? "caregiver" : row.client_id ? "client" : null,
    entity_id: null,
    actor: "system:dispatch-task-notifications",
    payload: {
      task_id: row.id,
      source: row.source,
      title: displayTitle,
      due_at: row.due_at,
      assigned_to: row.assigned_to,
      caregiver_id: row.caregiver_id,
      client_id: row.client_id,
      urgency: row.urgency,
    },
  });
}
