import { useEffect, useState } from 'react';
import { useApp } from '../../../shared/context/AppContext';
import { updateOrgSettings } from '../storage';
import s from './PayrollSettingsView.module.css';

const PAY_COMPONENT_KEYS = [
  { key: 'regular', label: 'Regular hours', placeholder: 'Hourly' },
  { key: 'overtime', label: 'Overtime hours', placeholder: 'Overtime' },
  { key: 'double_time', label: 'Double-time hours', placeholder: 'Doubletime (leave blank if not configured)' },
  { key: 'mileage', label: 'Mileage reimbursement', placeholder: 'Mileage' },
];

/**
 * Phase 4 PR #3 — Payroll Settings view.
 *
 * Read/write controls for the org's payroll-relevant
 * `organizations.settings`. v1 surfaces:
 *   - Pay Component editor (4 keys; the SPI CSV uses these as
 *     case-sensitive Earning names)
 *   - Default mileage rate (numeric, $/mi)
 *   - Production / Dry-run flag (org-level; the per-call modal toggle
 *     in This Week is independent)
 *   - Connection status (read-only display of Paychex worker /
 *     payroll API entitlement state)
 *   - Pay period config (read-only — Phase 4 owner kept these
 *     fixed; PR #3 surfaces them so the back office can confirm)
 *
 * All writes go via the `org-settings-update` edge function which
 * gates on admin role and validates the patch shape.
 *
 * Plan reference:
 *   docs/plans/2026-04-25-paychex-integration-plan.md
 *   docs/handoff-paychex-phase-4.md  ("PR #3 — Payroll Runs view + Mark as Paid + Settings")
 */
export function PayrollSettingsView() {
  const { currentOrgSettings, refreshOrgSettings, showToast } = useApp();
  const [busy, setBusy] = useState(false);

  const payroll = currentOrgSettings?.payroll || {};
  const paychex = currentOrgSettings?.paychex || {};
  const payComponents = payroll.pay_components || {};

  // Local form state — initialized from the loaded settings; updated
  // by user input; written back via Save buttons per section.
  const [draftPayComponents, setDraftPayComponents] = useState({
    regular: payComponents.regular ?? '',
    overtime: payComponents.overtime ?? '',
    double_time: payComponents.double_time ?? '',
    mileage: payComponents.mileage ?? '',
  });
  const [draftMileageRate, setDraftMileageRate] = useState(
    payroll.mileage_rate != null ? String(payroll.mileage_rate) : '',
  );
  const [draftDryRun, setDraftDryRun] = useState(payroll.dry_run === true);

  // Re-sync drafts when settings reload (e.g. after a successful
  // patch). Without this, the form stays at the old values until the
  // user navigates away and back.
  useEffect(() => {
    setDraftPayComponents({
      regular: payComponents.regular ?? '',
      overtime: payComponents.overtime ?? '',
      double_time: payComponents.double_time ?? '',
      mileage: payComponents.mileage ?? '',
    });
    setDraftMileageRate(payroll.mileage_rate != null ? String(payroll.mileage_rate) : '');
    setDraftDryRun(payroll.dry_run === true);
    // currentOrgSettings is the only meaningful dep — payroll/payComponents
    // are derived from it via destructuring above.
  }, [currentOrgSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  async function savePayComponents() {
    setBusy(true);
    try {
      // Convert empty strings to null so the migration's "double_time
      // not configured" semantics are preserved. The validator on the
      // edge function accepts string-or-null per key.
      const patch = {};
      for (const key of Object.keys(draftPayComponents)) {
        const v = draftPayComponents[key];
        patch[key] = (typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
      }
      await updateOrgSettings({
        section: 'payroll',
        patch: { pay_components: patch },
      });
      await refreshOrgSettings?.();
      showToast?.('Pay components saved.');
    } catch (err) {
      showToast?.(`Save failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveMileageRate() {
    setBusy(true);
    try {
      const n = Number(draftMileageRate);
      if (!Number.isFinite(n) || n <= 0) {
        showToast?.('Mileage rate must be a positive number (e.g. 0.725).');
        setBusy(false);
        return;
      }
      await updateOrgSettings({
        section: 'payroll',
        patch: { mileage_rate: n },
      });
      await refreshOrgSettings?.();
      showToast?.('Mileage rate saved.');
    } catch (err) {
      showToast?.(`Save failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveDryRun() {
    setBusy(true);
    try {
      await updateOrgSettings({
        section: 'payroll',
        patch: { dry_run: draftDryRun },
      });
      await refreshOrgSettings?.();
      showToast?.(
        draftDryRun
          ? 'Dry-run mode ON. Generate Run will not produce real payroll until this is turned off.'
          : 'Dry-run mode OFF. Generate Run will produce real payroll runs.',
      );
    } catch (err) {
      showToast?.(`Save failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.view}>
      {/* ─── Pay Components ─── */}
      <section className={s.section}>
        <h3 className={s.sectionTitle}>Pay Components</h3>
        <p className={s.sectionLede}>
          The CSV export uses these names in the &ldquo;Pay Component&rdquo; column.
          They must match an Earning configured in Paychex Flex Settings &rarr; Earnings <strong>exactly</strong> (case-sensitive).
        </p>
        <div className={s.fieldsGrid}>
          {PAY_COMPONENT_KEYS.map((entry) => (
            <label key={entry.key} className={s.field}>
              {entry.label}
              <input
                type="text"
                className={s.input}
                value={draftPayComponents[entry.key] ?? ''}
                onChange={(e) => setDraftPayComponents((p) => ({
                  ...p,
                  [entry.key]: e.target.value,
                }))}
                placeholder={entry.placeholder}
                disabled={busy}
              />
            </label>
          ))}
        </div>
        <div className={s.sectionFooter}>
          <button
            type="button"
            className={`${s.btn} ${s.btnPrimary}`}
            onClick={savePayComponents}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save Pay Components'}
          </button>
        </div>
      </section>

      {/* ─── Mileage rate ─── */}
      <section className={s.section}>
        <h3 className={s.sectionTitle}>Mileage Rate</h3>
        <p className={s.sectionLede}>
          $/mile multiplier used by both the timesheet builder and the CSV export.
          IRS standard rate as of 2026 is $0.725/mi.
        </p>
        <label className={s.field}>
          Mileage rate ($/mi)
          <input
            type="number"
            step="0.0001"
            min="0"
            className={s.input}
            value={draftMileageRate}
            onChange={(e) => setDraftMileageRate(e.target.value)}
            placeholder="0.725"
            disabled={busy}
          />
        </label>
        <div className={s.sectionFooter}>
          <button
            type="button"
            className={`${s.btn} ${s.btnPrimary}`}
            onClick={saveMileageRate}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save Mileage Rate'}
          </button>
        </div>
      </section>

      {/* ─── Dry-run mode ─── */}
      <section className={s.section}>
        <h3 className={s.sectionTitle}>Production / Dry-run Mode</h3>
        <p className={s.sectionLede}>
          When ON, the Generate Payroll Run flow forces dry-run for every export — CSVs are generated for preview but no payroll_runs row is created and no timesheets flip to <code>exported</code>.
          Use this for the first 1–2 cycles to verify the CSV against existing Paychex paystubs.
        </p>
        <label className={s.toggleField}>
          <input
            type="checkbox"
            checked={draftDryRun}
            onChange={(e) => setDraftDryRun(e.target.checked)}
            disabled={busy}
          />
          <span>
            Dry-run mode is <strong>{draftDryRun ? 'ON' : 'OFF'}</strong>
          </span>
        </label>
        <div className={s.sectionFooter}>
          <button
            type="button"
            className={`${s.btn} ${s.btnPrimary}`}
            onClick={saveDryRun}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save Mode'}
          </button>
        </div>
      </section>

      {/* ─── Connection Status (read-only) ─── */}
      <section className={s.section}>
        <h3 className={s.sectionTitle}>Connection Status</h3>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>Paychex Company ID</span>
          <span className={s.statusValue}>
            {paychex.display_id ? <code>{paychex.display_id}</code> : <em className={s.subtle}>not configured</em>}
          </span>
        </div>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>Paychex internal company_id</span>
          <span className={s.statusValue}>
            {paychex.company_id ? <code>{paychex.company_id}</code> : <em className={s.subtle}>not configured</em>}
          </span>
        </div>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>Worker API</span>
          <span className={s.statusValue}>
            {paychex.company_id
              ? <span className={s.statusOk}>Connected</span>
              : <span className={s.statusGap}>Not connected</span>}
          </span>
        </div>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>Payroll &amp; Check API (Phase 5)</span>
          <span className={s.statusValue}>
            <span className={s.statusGap}>Pending — request the scope from your Paychex rep</span>
          </span>
        </div>
      </section>

      {/* ─── Pay period (read-only in v1) ─── */}
      <section className={s.section}>
        <h3 className={s.sectionTitle}>Pay Period (read-only in v1)</h3>
        <p className={s.sectionLede}>
          Hard-coded for v1 to match Tremendous Care&rsquo;s schedule. Editing these is a future PR.
        </p>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>Frequency</span>
          <span className={s.statusValue}>
            <code>{payroll.pay_period?.frequency ?? 'weekly'}</code>
          </span>
        </div>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>End day</span>
          <span className={s.statusValue}>
            <code>{payroll.pay_period?.end_day ?? 'sunday'}</code>
          </span>
        </div>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>Pay day</span>
          <span className={s.statusValue}>
            <code>{payroll.pay_period?.pay_day ?? 'wednesday'}</code>
          </span>
        </div>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>OT jurisdiction</span>
          <span className={s.statusValue}>
            <code>{payroll.ot_jurisdiction ?? 'CA'}</code>
          </span>
        </div>
        <div className={s.statusRow}>
          <span className={s.statusLabel}>Timezone</span>
          <span className={s.statusValue}>
            <code>{payroll.timezone ?? 'America/Los_Angeles'}</code>
          </span>
        </div>
      </section>
    </div>
  );
}
