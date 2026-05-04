// ═══════════════════════════════════════════════════════════════
// Scheduling — Ongoing service plan extension math
//
// Pure helpers used by the `service-plan-extend-ongoing` edge function
// (registered as a weekly pg_cron job) to decide whether a service plan
// flagged `is_ongoing = true` needs to have its rolling shift window
// topped up, and over what date range.
//
// Live in src/lib/ so vitest can exercise the math without spinning up
// Deno; the edge function imports them via the same cross-tree path as
// the payroll cron does for the timesheet builders.
//
// Scenario reminder: an "ongoing" plan does NOT have all of its shifts
// pre-generated forever — that would explode the shifts table and make
// pattern edits unworkable. Instead the dialog generates the first
// 12 weeks at save time, and this cron keeps the materialized window
// at ~12 weeks of runway from `now`, every week, until the plan is
// flipped off `is_ongoing` or its `status` leaves 'active'.
// ═══════════════════════════════════════════════════════════════

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decide whether and how much to extend an ongoing service plan.
 *
 * @param {object} plan
 *   Required fields: `id`, `last_generated_through` (ISO string or null).
 *   Anything else is ignored — the cron passes the row straight through.
 * @param {Date|number} now
 *   The "current time" anchor. Pass `new Date()` in production; tests
 *   pass a fixed Date for determinism.
 * @param {object} [options]
 * @param {number} [options.targetDays=84]  Materialize up through
 *   `now + targetDays` whenever we top up.
 * @param {number} [options.bufferDays=28]  Skip plans whose existing
 *   runway is already further out than `now + bufferDays`. Keeps the
 *   cron a no-op for plans that don't need attention this week.
 *
 * @returns {{
 *   shouldExtend: boolean,
 *   reason: string,
 *   windowStart: Date | null,
 *   windowEnd: Date | null,
 * }}
 *   When `shouldExtend` is true, callers should expand the plan's
 *   recurrence pattern across [windowStart, windowEnd] (inclusive of
 *   windowStart, the same convention as `expandRecurrence`).
 */
export function computeOngoingExtensionWindow(plan, now, options = {}) {
  const targetDays = options.targetDays ?? 84;
  const bufferDays = options.bufferDays ?? 28;

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) {
    return { shouldExtend: false, reason: 'invalid-now', windowStart: null, windowEnd: null };
  }

  // Where the rolling window should end after this run.
  const targetEndMs = nowMs + targetDays * MS_PER_DAY;
  const targetEnd = new Date(targetEndMs);

  // Threshold below which we still bother running the extension. If
  // the plan already has more runway than this, leave it alone.
  const bufferEndMs = nowMs + bufferDays * MS_PER_DAY;

  const lastGenerated = plan?.last_generated_through
    ? new Date(plan.last_generated_through)
    : null;

  // Plan has never been generated (e.g. is_ongoing toggled but the
  // dialog save failed mid-flight, or the column was backfilled
  // manually). Generate from `now` forward to the target.
  if (!lastGenerated || Number.isNaN(lastGenerated.getTime())) {
    return {
      shouldExtend: true,
      reason: 'no-prior-generation',
      windowStart: new Date(nowMs),
      windowEnd: targetEnd,
    };
  }

  // Already has plenty of runway — skip until next week.
  if (lastGenerated.getTime() >= bufferEndMs) {
    return {
      shouldExtend: false,
      reason: 'sufficient-runway',
      windowStart: null,
      windowEnd: null,
    };
  }

  // Defensive: if last_generated_through is somehow further out than
  // the new target (target shrunk, clock skew), there's nothing to do.
  if (lastGenerated.getTime() >= targetEndMs) {
    return {
      shouldExtend: false,
      reason: 'already-past-target',
      windowStart: null,
      windowEnd: null,
    };
  }

  // Resume from one millisecond after the last generated end-time.
  // expandRecurrence is inclusive on the start boundary and operates
  // at day granularity, so the +1ms just guarantees we don't re-emit
  // a shift whose end_time is exactly `last_generated_through`.
  const windowStart = new Date(lastGenerated.getTime() + 1);

  return {
    shouldExtend: true,
    reason: 'topping-up',
    windowStart,
    windowEnd: targetEnd,
  };
}

/**
 * Pick the latest end_time across an array of just-inserted shift
 * instances. Returns an ISO string or null. The cron stores this back
 * to `service_plans.last_generated_through` so the next run knows
 * where to resume.
 */
export function latestEndTime(instances) {
  if (!Array.isArray(instances) || instances.length === 0) return null;
  let maxMs = -Infinity;
  for (const inst of instances) {
    if (!inst || !inst.end_time) continue;
    const ms = new Date(inst.end_time).getTime();
    if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
  }
  return Number.isFinite(maxMs) ? new Date(maxMs).toISOString() : null;
}
