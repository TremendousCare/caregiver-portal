import s from './ExceptionBadge.module.css';

// Human labels for the exception codes the cron writes into
// timesheets.notes. The codes are stable strings defined in
// src/lib/payroll/constants.js. Keeping the label table here (rather
// than re-importing the constants module) so the UI string layer is
// editable without touching the engine.
const LABELS = {
  missing_clock_out: 'Missing clock-out',
  out_of_geofence: 'Geofence',
  rate_mismatch: 'Multiple rates',
  blocked_caregiver: 'Caregiver blocked',
  shift_too_long: 'Shift > 16h',
  caregiver_not_in_paychex: 'Not synced to Paychex',
  dt_pay_component_missing: 'DT pay component missing',
  caregiver_missing_paychex_employee_id: 'Missing Paychex employee ID',
};

export function ExceptionBadge({ exception }) {
  if (!exception) return null;
  const label = LABELS[exception.code] || exception.code;
  const className =
    exception.severity === 'block' ? `${s.badge} ${s.block}` : `${s.badge} ${s.warn}`;
  return (
    <span className={className} title={exception.message}>
      {label}
    </span>
  );
}
