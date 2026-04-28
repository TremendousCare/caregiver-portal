// Payroll — type-level vocabulary shared across the payroll modules.
//
// This file is deliberately small. It contains ONLY the labels and
// defaults the rest of the payroll code needs to refer to by name —
// the things you'd otherwise be tempted to inline as string literals
// scattered across overtimeRules.js, timesheetBuilder.js, and the
// edge function.
//
// What does NOT live here:
//   - Org-specific values (timezone, mileage rate, OT jurisdiction).
//     Those live in `organizations.settings.payroll` per the plan's
//     directive #5 ("no new hardcoded TC branding/config"). The
//     consts below name the keys we read OUT of that jsonb, but the
//     values themselves come from the database at runtime.
//   - Pay period day-of-week boundaries. Those are read per-org from
//     `organizations.settings.paychex.pay_period`.
//
// See: docs/plans/2026-04-25-paychex-integration-plan.md
//      ("Decisions locked", "Cross-cutting reliability practices").

/**
 * Hour-classification labels used as `timesheet_shifts.hour_classification`
 * values and as the keys on the OT engine's per-shift breakdown. These
 * MUST match the CHECK constraint in
 * `supabase/migrations/20260425170002_create_timesheet_shifts.sql`.
 */
export const HOUR_CLASSIFICATION = Object.freeze({
  REGULAR: 'regular',
  OVERTIME: 'overtime',
  DOUBLE_TIME: 'double_time',
});

/**
 * The set of jurisdictions the OT engine is wired to handle. The engine
 * takes a jurisdiction parameter from day one even though only `CA` is
 * implemented in v1, so the day a second state needs OT rules we add a
 * branch in `overtimeRules.js` and add the code here without touching
 * any caller. Other values throw a clear error in v1.
 */
export const SUPPORTED_OT_JURISDICTIONS = Object.freeze(['CA']);

/**
 * Jurisdiction the OT engine assumes when a caller omits one. The
 * Phase 3 cron always passes a jurisdiction explicitly (read from
 * `organizations.settings.payroll.ot_jurisdiction`); this constant is
 * used in tests and as a defensive default for callers that aren't
 * yet org-aware.
 */
export const DEFAULT_OT_JURISDICTION = 'CA';

/**
 * IANA timezone the engine uses to determine workday boundaries when
 * a caller omits one. The Phase 3 cron always passes the org's
 * configured timezone explicitly. Per the plan, day boundaries for OT
 * classification are evaluated in this zone.
 */
export const DEFAULT_PAYROLL_TIMEZONE = 'America/Los_Angeles';

/**
 * CA daily OT thresholds. Codified here so tests, the engine, and the
 * exception code all reference the same numbers. Changing these is a
 * legal change, not a refactor — touch with care.
 */
export const CA_DAILY_REGULAR_HOURS = 8;
export const CA_DAILY_DOUBLE_TIME_THRESHOLD_HOURS = 12;
export const CA_WEEKLY_REGULAR_HOURS = 40;

/**
 * Plan-defined exception codes. Kept as a separate enum so the
 * exceptions module and the UI label table evolve in lockstep.
 */
export const EXCEPTION_CODE = Object.freeze({
  MISSING_CLOCK_OUT: 'missing_clock_out',
  OUT_OF_GEOFENCE: 'out_of_geofence',
  RATE_MISMATCH: 'rate_mismatch',
  BLOCKED_CAREGIVER: 'blocked_caregiver',
  SHIFT_TOO_LONG: 'shift_too_long',
  CAREGIVER_NOT_IN_PAYCHEX: 'caregiver_not_in_paychex',
  // Phase 4 PR #1 — surfaces gaps that block CSV export to Paychex Flex.
  // `dt_pay_component_missing`: timesheet has DT hours but the org has
  //   not configured the Paychex Earning name for double-time. Hard
  //   block until the owner either adds the Earning in Paychex Flex
  //   Settings → Earnings (and updates organizations.settings.payroll.
  //   pay_components.double_time with its name) or zeroes out the DT
  //   hours via inline edit.
  // `caregiver_missing_paychex_employee_id`: caregiver has a timesheet
  //   but no `paychex_employee_id` (the SHORT integer that goes in the
  //   SPI CSV's Worker ID column). Until the backfill function
  //   populates it, we cannot generate a CSV row for this caregiver.
  DT_PAY_COMPONENT_MISSING: 'dt_pay_component_missing',
  CAREGIVER_MISSING_PAYCHEX_EMPLOYEE_ID: 'caregiver_missing_paychex_employee_id',
});

/**
 * Severity of an exception. `block` prevents the timesheet from being
 * approved in Phase 4; `warn` surfaces the issue but doesn't gate.
 *
 * Per the plan, "caregiver not in Paychex" is a warn so the
 * entitlement-blocked Phase 2 caregivers don't gate the whole
 * pipeline.
 */
export const EXCEPTION_SEVERITY = Object.freeze({
  BLOCK: 'block',
  WARN: 'warn',
});

/**
 * Long-shift threshold (hours). A single shift longer than this raises
 * a `shift_too_long` warning. 16h is the plan's number; in practice TC
 * caregivers occasionally work up-to-12h shifts, so 16h captures
 * "almost certainly a missing clock-out or data entry error" without
 * false-flagging legitimate live-in or split shifts.
 */
export const LONG_SHIFT_WARNING_HOURS = 16;
