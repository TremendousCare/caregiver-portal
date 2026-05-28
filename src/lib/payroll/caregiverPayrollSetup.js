// ─── Caregiver-level Paychex setup status ───
//
// To export a caregiver's timesheet to Paychex, the caregiver needs the
// SHORT per-company Paychex employee ID (e.g. "54") stored in
// `caregivers.paychex_employee_id`. Without it the payroll engine raises a
// `caregiver_missing_paychex_employee_id` block and the timesheet cannot
// be approved or exported (see src/lib/payroll/exceptions.js).
//
// This module centralizes the normalization + readiness check so the
// caregiver profile UI — and any future onboarding gate — agree on what
// "payroll-ready" means. It is intentionally caregiver-scoped: pay-rate
// completeness lives per-shift, not on the caregiver, so the only
// per-caregiver payroll-setup item is the Paychex employee ID.

/**
 * Normalize a raw employee-ID input to a trimmed string, or null when it
 * is empty/whitespace/nullish. Form inputs return strings; importers may
 * pass numbers — both converge here so we never persist an empty string
 * to the column (an empty string would not satisfy the NOT-NULL-ish
 * "is set" check while still looking present).
 */
export function normalizePaychexEmployeeId(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Payroll-setup readiness for a single caregiver (camelCase shape from
 * dbToCaregiver). Returns { ready, code, employeeId, label }.
 *   - ready=true  when a non-empty Paychex employee ID is present
 *   - ready=false (code 'missing_employee_id') otherwise
 */
export function getPaychexSetupStatus(caregiver) {
  const employeeId = normalizePaychexEmployeeId(caregiver?.paychexEmployeeId);
  if (employeeId) {
    return {
      ready: true,
      code: 'linked',
      employeeId,
      label: `Linked — Paychex employee ID ${employeeId}`,
    };
  }
  return {
    ready: false,
    code: 'missing_employee_id',
    employeeId: null,
    label: 'Needs Paychex employee ID',
  };
}
