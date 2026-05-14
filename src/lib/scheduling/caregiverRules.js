// ═══════════════════════════════════════════════════════════════
// Scheduling — Regular caregiver rule resolution
//
// Pure helpers (no I/O) that the cron and the frontend both call.
// Given a set of rules for a service plan, decide which caregiver
// covers a specific (day_of_week, date) — i.e. which rule wins.
//
// A rule looks like (matching service_plan_caregiver_rules):
//   {
//     id: uuid,
//     service_plan_id: uuid,
//     day_of_week: 0..6,           // 0 = Sunday … 6 = Saturday
//     caregiver_id: string,
//     effective_from: 'YYYY-MM-DD',
//     effective_to:   'YYYY-MM-DD' | null,
//   }
//
// Wins-the-day logic:
//   1. day_of_week must match the target.
//   2. effective_from ≤ target_date ≤ effective_to (or effective_to is null).
//   3. Among candidates, the rule with the latest effective_from wins.
//      This is the "successor rule" pattern — open a new rule for
//      Maria with effective_from=2026-07-02, the prior rule for Ciara
//      is closed with effective_to=2026-07-01, and any one-off
//      successor rule between them naturally wins for its window.
//
// See docs/SCHEDULING_CAREGIVER_RULES.md for the full design.
// ═══════════════════════════════════════════════════════════════

/**
 * Pick the active rule for a (day_of_week, date) tuple. Returns the
 * rule object or null if no rule covers it.
 *
 * @param {Array<object>} rules    All rules for the relevant plan.
 * @param {number}        dayOfWeek 0..6 (Sun..Sat).
 * @param {string}        dateOnly  'YYYY-MM-DD' in the plan's timezone.
 * @returns {object|null}
 */
export function pickActiveRule(rules, dayOfWeek, dateOnly) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  if (typeof dayOfWeek !== 'number' || dayOfWeek < 0 || dayOfWeek > 6) return null;
  if (typeof dateOnly !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;

  let best = null;
  for (const rule of rules) {
    if (!rule || rule.day_of_week !== dayOfWeek) continue;
    if (!rule.effective_from) continue;
    if (rule.effective_from > dateOnly) continue;
    if (rule.effective_to && rule.effective_to < dateOnly) continue;
    // Most recent effective_from wins. Ties broken by rule.id to keep
    // the resolution deterministic across runtimes.
    if (
      !best ||
      rule.effective_from > best.effective_from ||
      (rule.effective_from === best.effective_from &&
        String(rule.id || '') > String(best.id || ''))
    ) {
      best = rule;
    }
  }
  return best;
}

/**
 * Resolve the caregiver id for a (day_of_week, date) tuple. Convenience
 * wrapper around `pickActiveRule` that returns just the id, or null
 * when no rule applies.
 *
 * @param {Array<object>} rules
 * @param {number}        dayOfWeek
 * @param {string}        dateOnly
 * @returns {string|null}
 */
export function resolveCaregiverForDate(rules, dayOfWeek, dateOnly) {
  return pickActiveRule(rules, dayOfWeek, dateOnly)?.caregiver_id ?? null;
}

/**
 * For a single recurrence instance — emitted by `expandRecurrence` as
 * `{ date: 'YYYY-MM-DD', start_time: iso, end_time: iso }` — resolve
 * the caregiver via the rule set and the plan's timezone.
 *
 * Uses `utcMsToWallClockParts` so the day-of-week computation matches
 * the recurrence expander's own definition of "what day is this shift
 * on" in the org's wall clock. Without this, an overnight shift that
 * starts Saturday 10pm could be mis-classified as Saturday vs Sunday
 * depending on UTC offset.
 *
 * @param {{date: string, start_time: string}} instance
 * @param {Array<object>} rules
 * @param {(iso:string) => number} dayOfWeekFn  Function returning 0..6
 *   for the instance's start time, in the appropriate timezone. We
 *   inject this so this module stays dependency-free of the timezone
 *   helpers (the cron and frontend each pass their own resolver).
 * @returns {string|null}
 */
export function resolveCaregiverForInstance(instance, rules, dayOfWeekFn) {
  if (!instance || typeof instance.date !== 'string') return null;
  if (typeof dayOfWeekFn !== 'function') return null;
  const dow = dayOfWeekFn(instance.start_time || instance.date);
  if (typeof dow !== 'number') return null;
  return resolveCaregiverForDate(rules, dow, instance.date);
}

/**
 * Group a set of rules by day-of-week, returning an object keyed
 * 0..6 with the active rule on `asOfDate` for each day (or null
 * when no rule covers that day on that date). Used by the service
 * plan grid to render "who's the regular caregiver for each day
 * right now."
 *
 * @param {Array<object>} rules
 * @param {string}        asOfDate 'YYYY-MM-DD'
 * @returns {Object<number, object|null>}
 */
export function activeRulesByDayOfWeek(rules, asOfDate) {
  const out = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
  for (let dow = 0; dow <= 6; dow++) {
    out[dow] = pickActiveRule(rules, dow, asOfDate);
  }
  return out;
}

/**
 * Given the current set of rules for (plan, day_of_week), compute the
 * write plan to install a NEW caregiver as the regular caregiver
 * starting on `effectiveFrom`. Returns:
 *   {
 *     toExpire:  [{ id, effective_to }],   // existing rules to close
 *     toInsert?: { ...new rule fields... } // null if same caregiver
 *   }
 *
 * Logic:
 *   - If the active rule on `effectiveFrom` already points to this
 *     caregiver, return { toExpire: [], toInsert: null } (no-op).
 *   - Otherwise, expire (set effective_to = effectiveFrom - 1) every
 *     rule whose current effective range covers `effectiveFrom` for
 *     this (plan, dow). Then insert a new open-ended rule for the
 *     new caregiver starting `effectiveFrom`.
 *
 * Future-dated rules (effective_from > effectiveFrom) are left alone
 * — those represent a deliberate hand-off and shouldn't be clobbered
 * by an "as of today" change. Callers that want to override the
 * future too can do so explicitly.
 *
 * Pure: returns instructions, performs no writes. The storage layer
 * applies them.
 */
export function planRuleUpsert({
  rules,
  servicePlanId,
  orgId,
  dayOfWeek,
  caregiverId,
  effectiveFrom,
  createdBy,
  notes,
}) {
  if (!servicePlanId || !orgId || !caregiverId) {
    throw new Error('planRuleUpsert: servicePlanId, orgId, and caregiverId are required');
  }
  if (typeof dayOfWeek !== 'number' || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error('planRuleUpsert: dayOfWeek must be 0..6');
  }
  if (typeof effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error('planRuleUpsert: effectiveFrom must be YYYY-MM-DD');
  }

  const active = pickActiveRule(rules, dayOfWeek, effectiveFrom);
  if (active && active.caregiver_id === caregiverId) {
    return { toExpire: [], toInsert: null, noop: true };
  }

  const dayBefore = previousDayString(effectiveFrom);

  // Expire any rule whose live window covers `effectiveFrom` for this
  // (plan, dow). Strictly future-dated rules (effective_from >
  // effectiveFrom) are preserved.
  const toExpire = [];
  for (const rule of rules || []) {
    if (!rule || rule.day_of_week !== dayOfWeek) continue;
    if (!rule.effective_from || rule.effective_from > effectiveFrom) continue;
    if (rule.effective_to && rule.effective_to < effectiveFrom) continue;
    toExpire.push({ id: rule.id, effective_to: dayBefore });
  }

  const toInsert = {
    service_plan_id: servicePlanId,
    org_id: orgId,
    day_of_week: dayOfWeek,
    caregiver_id: caregiverId,
    effective_from: effectiveFrom,
    effective_to: null,
    notes: notes ?? null,
    created_by: createdBy ?? null,
  };

  return { toExpire, toInsert, noop: false };
}

/**
 * Plan for clearing the regular caregiver on (plan, dow) as of
 * `effectiveFrom`. Expires every active rule for that pair; future-
 * dated rules are left alone. Returns the same shape as
 * `planRuleUpsert` minus `toInsert`.
 */
export function planRuleClear({ rules, dayOfWeek, effectiveFrom }) {
  if (typeof dayOfWeek !== 'number' || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error('planRuleClear: dayOfWeek must be 0..6');
  }
  if (typeof effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new Error('planRuleClear: effectiveFrom must be YYYY-MM-DD');
  }
  const dayBefore = previousDayString(effectiveFrom);
  const toExpire = [];
  for (const rule of rules || []) {
    if (!rule || rule.day_of_week !== dayOfWeek) continue;
    if (!rule.effective_from || rule.effective_from > effectiveFrom) continue;
    if (rule.effective_to && rule.effective_to < effectiveFrom) continue;
    toExpire.push({ id: rule.id, effective_to: dayBefore });
  }
  return { toExpire, toInsert: null, noop: toExpire.length === 0 };
}

/**
 * 'YYYY-MM-DD' - 1 day. Pure date math, no Date object semantics
 * (which would tempt timezone bugs). Handles month/year rollover.
 */
export function previousDayString(dateOnly) {
  if (typeof dateOnly !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    throw new Error('previousDayString: expected YYYY-MM-DD');
  }
  const [y, m, d] = dateOnly.split('-').map(Number);
  // Date.UTC handles the underflow (Jan 1 → Dec 31 prior year).
  const ms = Date.UTC(y, m - 1, d) - 86400000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
