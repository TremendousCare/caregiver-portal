// ─── Scheduling: ongoing-plan extension cron ───
//
// Runs weekly (registered in
// supabase/migrations/20260507000001_service_plan_extend_ongoing_cron.sql).
// For every service_plan flagged `is_ongoing = true` with
// `status = 'active'`, materializes any missing shifts so the rolling
// window stays at ~12 weeks of runway from `now`. The Generate Shifts
// dialog primes the window when the user first turns on Ongoing; this
// cron just keeps it topped up.
//
// What this function does NOT do:
//   - Create new service plans, change patterns, or alter assignments.
//   - Send any messages or notifications.
//   - Materialize shifts past `last_generated_through` for plans that
//     already have plenty of runway (>4 weeks). Skipping work is the
//     point — the cron is a no-op for most plans on most weeks.
//
// Idempotency:
//   - The decision logic (computeOngoingExtensionWindow) trims the
//     window to "from last_generated_through forward to target", so
//     re-running the cron the same day produces near-empty windows.
//   - Within the window, `filterOutExistingInstances` strips any
//     instance whose start_time matches an existing shift for the
//     same service plan, so a duplicate run never inserts twice.
//   - `last_generated_through` is only advanced after a successful
//     batch insert; a partial failure leaves the column unchanged
//     and the next run resumes from the same point.
//
// Multi-tenancy:
//   - Each plan row carries `org_id` (Phase B1). The cron uses the
//     service-role client and reads + writes `service_plans` and
//     `shifts` directly; org_id is preserved end-to-end via the
//     row, so no cross-tenant contamination is possible.
//   - Org timezone is read from `organizations.settings.scheduling.timezone`
//     (falling back to `payroll.timezone` then DEFAULT_APP_TIMEZONE)
//     so wall-clock times in the recurrence pattern resolve in the
//     org's own zone.
//
// Manual triggering: a service-role caller can POST a body with
// `{ org_id?: string, service_plan_id?: string, dry_run?: boolean }`
// to limit the run or preview without persisting. The cron itself
// POSTs `{ triggered_at: <iso> }`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Cross-tree imports — canonical implementations live under src/ so
// vitest can exercise them. Supabase's deploy bundler resolves the
// relative paths at build time (same pattern as payroll-generate-timesheets).
import { expandRecurrence } from "../../../src/lib/scheduling/recurrence.js";
import { DEFAULT_APP_TIMEZONE } from "../../../src/lib/scheduling/timezone.js";
import {
  computeOngoingExtensionWindow,
  dayFloorUtc,
  latestEndTime,
} from "../../../src/lib/scheduling/ongoingExtension.js";
import {
  filterOutExistingInstances,
  ONGOING_TARGET_DAYS,
  ONGOING_BUFFER_DAYS,
} from "../../../src/features/scheduling/recurrenceHelpers.js";
import { resolveAssignmentForInstance } from "../../../src/lib/scheduling/caregiverRules.js";

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

interface ServicePlanRow {
  id: string;
  org_id: string;
  client_id: string;
  recurrence_pattern: Record<string, unknown> | null;
  last_generated_through: string | null;
  status: string;
}

interface ExistingShiftRow {
  start_time: string;
  end_time: string;
}

interface CaregiverRuleRow {
  id: string;
  day_of_week: number;
  caregiver_id: string;
  effective_from: string;
  effective_to: string | null;
}

interface OrgRow {
  id: string;
  settings: Record<string, unknown> | null;
}

interface PlanResult {
  service_plan_id: string;
  org_id: string;
  reason: string;
  shifts_inserted: number;
  shifts_skipped_existing: number;
  shifts_pre_assigned: number;
  last_generated_through: string | null;
  error?: string;
}

/**
 * Load every caregiver rule for a service plan. Returns [] if the
 * table doesn't exist yet (migration not applied) so the cron stays
 * correct during the migration→deploy window.
 */
async function loadRulesForPlan(
  supabase: ReturnType<typeof createClient>,
  servicePlanId: string,
): Promise<CaregiverRuleRow[]> {
  const { data, error } = await supabase
    .from("service_plan_caregiver_rules")
    .select("id, day_of_week, caregiver_id, effective_from, effective_to")
    .eq("service_plan_id", servicePlanId);
  if (error) {
    const code = (error as { code?: string }).code;
    const msg = String((error as { message?: string }).message || "");
    if (
      code === "42P01" ||
      code === "PGRST205" ||
      msg.includes("service_plan_caregiver_rules") &&
        msg.includes("does not exist")
    ) {
      return [];
    }
    throw error;
  }
  return (data ?? []) as CaregiverRuleRow[];
}

function pickOrgTimezone(org: OrgRow | undefined): string {
  if (!org || !org.settings || typeof org.settings !== "object") {
    return DEFAULT_APP_TIMEZONE;
  }
  const settings = org.settings as Record<string, unknown>;
  const scheduling = (settings.scheduling ?? {}) as Record<string, unknown>;
  if (typeof scheduling.timezone === "string" && scheduling.timezone.length > 0) {
    return scheduling.timezone;
  }
  const payroll = (settings.payroll ?? {}) as Record<string, unknown>;
  if (typeof payroll.timezone === "string" && payroll.timezone.length > 0) {
    return payroll.timezone;
  }
  return DEFAULT_APP_TIMEZONE;
}

async function extendPlan(
  supabase: ReturnType<typeof createClient>,
  plan: ServicePlanRow,
  timezone: string,
  now: Date,
  options: { dryRun: boolean },
): Promise<PlanResult> {
  const result: PlanResult = {
    service_plan_id: plan.id,
    org_id: plan.org_id,
    reason: "skipped",
    shifts_inserted: 0,
    shifts_skipped_existing: 0,
    shifts_pre_assigned: 0,
    last_generated_through: plan.last_generated_through,
  };

  const decision = computeOngoingExtensionWindow(plan, now, {
    targetDays: ONGOING_TARGET_DAYS,
    bufferDays: ONGOING_BUFFER_DAYS,
  });
  result.reason = decision.reason;

  if (!decision.shouldExtend || !decision.windowStart || !decision.windowEnd) {
    return result;
  }

  if (!plan.recurrence_pattern) {
    result.reason = "missing-pattern";
    return result;
  }

  const candidates = expandRecurrence(
    plan.recurrence_pattern,
    decision.windowStart,
    decision.windowEnd,
    { timezone },
  );

  if (candidates.length === 0) {
    return result;
  }

  // Idempotency guard: read existing shifts in the candidate window
  // and strip any instance that already has a matching start_time.
  // The dialog also dedupes; doing it here too means the cron is safe
  // even if a scheduler manually inserted a one-off shift in the
  // window between runs.
  //
  // The lower bound is floored to the start of the UTC day because
  // `expandRecurrence` floors `windowStart` the same way and may emit
  // shifts earlier on the boundary day (e.g. resuming at 12:00:00.001
  // Z still produces an 08:00 shift if the pattern matches that day).
  // Using the un-floored windowStart as the SQL lower bound let those
  // boundary-day duplicates slip through to the insert.
  const dedupeLowerBound = (dayFloorUtc(decision.windowStart) ?? decision.windowStart)
    .toISOString();
  const { data: existingData, error: existingErr } = await supabase
    .from("shifts")
    .select("start_time, end_time")
    .eq("service_plan_id", plan.id)
    .gte("start_time", dedupeLowerBound)
    .lte("start_time", decision.windowEnd.toISOString());

  if (existingErr) {
    result.error = `shifts pre-check failed: ${existingErr.message}`;
    return result;
  }

  const existing = (existingData ?? []) as ExistingShiftRow[];
  // filterOutExistingInstances expects camelCase startTime; map shape.
  const newInstances = filterOutExistingInstances(
    candidates,
    existing.map((row) => ({ startTime: row.start_time, endTime: row.end_time })),
  );

  result.shifts_skipped_existing = candidates.length - newInstances.length;

  if (newInstances.length === 0) {
    // Still update the bookkeeping marker — we proved there's nothing
    // to do up to the target, so the next run can skip on "sufficient
    // runway" instead of re-expanding the same pattern. Use the
    // existing rows' max end_time as the new boundary.
    const newMarker = latestEndTime([
      ...existing.map((row) => ({ end_time: row.end_time })),
      ...(plan.last_generated_through
        ? [{ end_time: plan.last_generated_through }]
        : []),
    ]);
    if (newMarker && newMarker !== plan.last_generated_through && !options.dryRun) {
      const { error: markerErr } = await supabase
        .from("service_plans")
        .update({ last_generated_through: newMarker })
        .eq("id", plan.id);
      if (markerErr) {
        result.error = `marker update failed: ${markerErr.message}`;
        return result;
      }
      result.last_generated_through = newMarker;
    }
    return result;
  }

  if (options.dryRun) {
    result.shifts_inserted = newInstances.length;
    return result;
  }

  // Load this plan's caregiver rules so we can pre-assign the right
  // caregiver to each materialized instance. When no rules exist, the
  // resolver returns null and we fall back to `status: 'open'`, which
  // is identical to the cron's pre-rule behavior — making this change
  // bit-for-bit backward compatible for plans without rules.
  let rules: CaregiverRuleRow[] = [];
  try {
    rules = await loadRulesForPlan(supabase, plan.id);
  } catch (rulesErr) {
    result.error = `rules load failed: ${
      rulesErr instanceof Error ? rulesErr.message : String(rulesErr)
    }`;
    return result;
  }

  // Build shift rows. The recurrence_group_id mirrors the dialog's
  // convention (plan.id) so future series-level edits can find every
  // shift this plan has produced.
  const rows = newInstances.map((inst) => {
    const { caregiverId, status } = resolveAssignmentForInstance(inst, rules);
    return {
      org_id: plan.org_id,
      service_plan_id: plan.id,
      client_id: plan.client_id,
      start_time: inst.start_time,
      end_time: inst.end_time,
      assigned_caregiver_id: caregiverId,
      status,
      recurrence_group_id: plan.id,
      recurrence_rule: plan.recurrence_pattern,
      created_by: "system:service-plan-extend-ongoing",
    };
  });

  result.shifts_pre_assigned = rows.filter((r) => r.assigned_caregiver_id).length;

  const { error: insertErr } = await supabase.from("shifts").insert(rows);
  if (insertErr) {
    result.error = `shifts insert failed: ${insertErr.message}`;
    return result;
  }

  result.shifts_inserted = newInstances.length;

  const newMarker = latestEndTime([
    ...newInstances,
    ...existing.map((row) => ({ end_time: row.end_time })),
    ...(plan.last_generated_through
      ? [{ end_time: plan.last_generated_through }]
      : []),
  ]);

  if (newMarker) {
    const { error: markerErr } = await supabase
      .from("service_plans")
      .update({ last_generated_through: newMarker })
      .eq("id", plan.id);
    if (markerErr) {
      // Shifts were inserted; mark the run as partially-failed but do
      // not roll back. Next run will see the existing shifts and
      // either advance the marker on a no-op or re-attempt the
      // update.
      result.error = `marker update failed after insert: ${markerErr.message}`;
      return result;
    }
    result.last_generated_through = newMarker;
  }

  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let body: { org_id?: string; service_plan_id?: string; dry_run?: boolean } = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }

  // Fetch every active ongoing plan, optionally narrowed.
  let planQuery = supabase
    .from("service_plans")
    .select("id, org_id, client_id, recurrence_pattern, last_generated_through, status")
    .eq("is_ongoing", true)
    .eq("status", "active");
  if (body.org_id) planQuery = planQuery.eq("org_id", body.org_id);
  if (body.service_plan_id) planQuery = planQuery.eq("id", body.service_plan_id);

  const { data: plansData, error: plansErr } = await planQuery;
  if (plansErr) {
    return jsonResponse(500, { error: `service_plans query failed: ${plansErr.message}` });
  }

  const plans = (plansData ?? []) as ServicePlanRow[];
  if (plans.length === 0) {
    return jsonResponse(200, {
      ok: true,
      message: "No ongoing service plans to extend.",
      plans: [],
    });
  }

  // Batch-load org settings for timezone resolution. Most weeks the
  // set is tiny (one org), so a single IN query is cheap.
  const orgIds = Array.from(new Set(plans.map((p) => p.org_id)));
  const { data: orgsData, error: orgsErr } = await supabase
    .from("organizations")
    .select("id, settings")
    .in("id", orgIds);
  if (orgsErr) {
    return jsonResponse(500, { error: `organizations query failed: ${orgsErr.message}` });
  }
  const orgsById = new Map<string, OrgRow>(
    ((orgsData ?? []) as OrgRow[]).map((o) => [o.id, o]),
  );

  const now = new Date();
  const results: PlanResult[] = [];
  for (const plan of plans) {
    const timezone = pickOrgTimezone(orgsById.get(plan.org_id));
    try {
      const r = await extendPlan(supabase, plan, timezone, now, {
        dryRun: body.dry_run === true,
      });
      results.push(r);
    } catch (err) {
      results.push({
        service_plan_id: plan.id,
        org_id: plan.org_id,
        reason: "exception",
        shifts_inserted: 0,
        shifts_skipped_existing: 0,
        last_generated_through: plan.last_generated_through,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const errored = results.filter((r) => r.error).length;
  return jsonResponse(errored > 0 ? 207 : 200, {
    ok: errored === 0,
    dry_run: body.dry_run === true,
    triggered_at: now.toISOString(),
    plans: results,
  });
});
