// ─── Executive task generation cron ───
//
// Runs daily (registered in
// supabase/migrations/20260529000000_exec_tasks_generate_cron.sql).
// For every active executive task template, produces concrete
// exec_tasks instances:
//
//   * Lifecycle templates (anchor_type='hire_date'): one row per active
//     staff_member whose (hire_date + offset_days) lands inside the
//     generation window. Idempotent via the partial unique index
//     uq_exec_tasks_lifecycle.
//
//   * Recurring templates (anchor_type='fixed_date'): one row when
//     next_fire_at is within the lookahead, then next_fire_at is
//     bumped by recurrence_interval_days. Idempotent via
//     uq_exec_tasks_recurring (template_id, recurrence_period).
//
// What this function does NOT do:
//   - Send notifications. Owners see new tasks the next time they
//     open the Tasks dashboard. (Notifications are a Phase 4 concern.)
//   - Modify or delete completed/snoozed/cancelled instances.
//   - Touch goals, KRs, or check-ins.
//   - Create templates or staff members. Owners do that through the UI.
//
// Multi-tenancy:
//   - Every query filters by org_id; the function walks orgs one at a
//     time so a slow org never blocks another.
//   - Inserts always carry org_id from the template/staff row, so
//     cross-tenant contamination is impossible.
//
// Manual triggering: a service-role caller can POST a body with
// `{ org_id?: string, dry_run?: boolean }` to limit or preview a run.
// The cron itself POSTs `{ triggered_at: <iso> }`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_LOOKAHEAD_DAYS,
  emptyRunResult,
  planLifecycleBatch,
  planRecurringInstance,
} from "../../../src/lib/exec/execTaskGeneration.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface TemplateRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  anchor_type: string;
  offset_days: number | null;
  recurrence_interval_days: number | null;
  next_fire_at: string | null;
  default_assignee_email: string | null;
  default_urgency: string;
  visibility: string;
  active: boolean;
}

interface StaffRow {
  email: string;
  hire_date: string;
  manager_email: string | null;
  active: boolean;
}

interface RunOpts {
  dryRun: boolean;
  lookbackDays: number;
  lookaheadDays: number;
}

async function runForOrg(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  now: Date,
  opts: RunOpts,
) {
  const result = emptyRunResult(orgId);

  // ─── Load active templates for this org ───
  const { data: templates, error: tErr } = await supabase
    .from("exec_task_templates")
    .select(
      "id, org_id, name, description, anchor_type, offset_days, recurrence_interval_days, next_fire_at, default_assignee_email, default_urgency, visibility, active",
    )
    .eq("org_id", orgId)
    .eq("active", true);
  if (tErr) {
    result.errors.push(`exec_task_templates query failed: ${tErr.message}`);
    return result;
  }
  result.templates_processed = (templates ?? []).length;

  // Lifecycle templates need staff; load once up front.
  const lifecycleTemplates = (templates ?? []).filter(
    (t: TemplateRow) => t.anchor_type === "hire_date",
  );
  const recurringTemplates = (templates ?? []).filter(
    (t: TemplateRow) => t.anchor_type === "fixed_date",
  );

  let staff: StaffRow[] = [];
  if (lifecycleTemplates.length > 0) {
    const { data: staffData, error: sErr } = await supabase
      .from("staff_members")
      .select("email, hire_date, manager_email, active")
      .eq("org_id", orgId)
      .eq("active", true);
    if (sErr) {
      result.errors.push(`staff_members query failed: ${sErr.message}`);
    } else {
      staff = (staffData ?? []) as StaffRow[];
      result.staff_processed = staff.length;
    }
  }

  // ─── Lifecycle batch: insert with ON CONFLICT DO NOTHING ───
  for (const tpl of lifecycleTemplates as TemplateRow[]) {
    const rows = planLifecycleBatch({
      template: tpl,
      staff,
      now,
      lookbackDays: opts.lookbackDays,
      lookaheadDays: opts.lookaheadDays,
    });
    if (rows.length === 0) continue;

    if (opts.dryRun) {
      result.lifecycle_inserted += rows.length; // would-have-been
      continue;
    }

    // Per-row insert so a single bad row (FK mismatch on a deleted
    // template, e.g.) doesn't abort the batch. We rely on the
    // partial unique index to dedupe — Postgres returns the row on
    // success and 23505 on conflict; we count both as "handled."
    for (const row of rows) {
      const { error: insErr } = await supabase
        .from("exec_tasks")
        .insert(row);
      if (!insErr) {
        result.lifecycle_inserted += 1;
      } else if (insErr.code === "23505") {
        // Unique violation = idempotent skip.
        result.lifecycle_skipped_existing += 1;
      } else {
        result.errors.push(
          `lifecycle insert failed (template=${tpl.id}, staff=${row.anchor_staff_email}): ${insErr.message}`,
        );
      }
    }
  }

  // ─── Recurring batch ───
  for (const tpl of recurringTemplates as TemplateRow[]) {
    const plan = planRecurringInstance({
      template: tpl,
      now,
      lookaheadDays: opts.lookaheadDays,
    });
    if (!plan) continue;

    if (opts.dryRun) {
      result.recurring_inserted += 1;
      continue;
    }

    const { error: insErr } = await supabase
      .from("exec_tasks")
      .insert(plan.row);
    if (insErr && insErr.code !== "23505") {
      result.errors.push(
        `recurring insert failed (template=${tpl.id}, period=${plan.row.recurrence_period}): ${insErr.message}`,
      );
      continue;
    }
    if (insErr?.code === "23505") {
      result.recurring_skipped_existing += 1;
    } else {
      result.recurring_inserted += 1;
    }

    // Advance the template's next_fire_at regardless of insert
    // result. If we hit a conflict, the prior fire was already
    // recorded and the bump catches us up; if we inserted cleanly,
    // we still need to advance so tomorrow's run doesn't re-fire.
    const { error: bumpErr } = await supabase
      .from("exec_task_templates")
      .update({ next_fire_at: plan.next_fire_at })
      .eq("id", tpl.id);
    if (bumpErr) {
      result.errors.push(
        `next_fire_at bump failed (template=${tpl.id}): ${bumpErr.message}`,
      );
    }
  }

  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let body: {
    org_id?: string;
    dry_run?: boolean;
    lookback_days?: number;
    lookahead_days?: number;
  } = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }

  // List target orgs. Default: every org that has at least one
  // active exec_task_template. This naturally skips tenants that
  // haven't opted into the Executive module.
  let orgIds: string[];
  if (body.org_id) {
    orgIds = [body.org_id];
  } else {
    const { data, error } = await supabase
      .from("exec_task_templates")
      .select("org_id")
      .eq("active", true);
    if (error) {
      return jsonResponse(500, {
        error: `exec_task_templates org scan failed: ${error.message}`,
      });
    }
    orgIds = Array.from(new Set((data ?? []).map((r) => r.org_id)));
  }

  if (orgIds.length === 0) {
    return jsonResponse(200, {
      ok: true,
      message: "No orgs with active executive task templates.",
      results: [],
    });
  }

  const opts: RunOpts = {
    dryRun: body.dry_run === true,
    lookbackDays: typeof body.lookback_days === "number" ? body.lookback_days : DEFAULT_LOOKBACK_DAYS,
    lookaheadDays: typeof body.lookahead_days === "number" ? body.lookahead_days : DEFAULT_LOOKAHEAD_DAYS,
  };

  const now = new Date();
  const results = [];
  for (const orgId of orgIds) {
    try {
      const r = await runForOrg(supabase, orgId, now, opts);
      results.push(r);
    } catch (err) {
      results.push({
        ...emptyRunResult(orgId),
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return jsonResponse(200, {
    ok: true,
    dry_run: opts.dryRun,
    triggered_at: now.toISOString(),
    results,
  });
});
