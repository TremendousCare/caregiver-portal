import { useState } from 'react';
import { useApp } from '../../shared/context/AppContext';
import { PayrollTab } from './payroll/PayrollTab';
import s from './AccountingPage.module.css';

const TABS = [
  { id: 'payroll', label: 'Payroll' },
  // Future tabs (out of scope for Phase 4): Invoicing, Expenses,
  // Reports, Tax Documents.
];

/**
 * Top-level Accounting page. Phase 4 PR #1 exposes only the Payroll
 * sub-tab and that sub-tab only includes a read-only This Week view.
 *
 * The page is gated by AppShell's sidebar entry on:
 *   - user role: admin or member
 *   - org features_enabled.payroll === true
 * If a user navigates directly to /accounting without those, we still
 * render a polite empty state rather than throwing.
 */
export function AccountingPage() {
  const { isAdmin, currentOrgRole, currentOrgSettings } = useApp();
  const [activeTab] = useState('payroll');

  const isStaff = isAdmin || currentOrgRole === 'admin' || currentOrgRole === 'member';
  const payrollEnabled = currentOrgSettings?.features_enabled?.payroll === true;

  if (!isStaff) {
    return (
      <div className={s.page}>
        <h1 className={s.title}>Accounting</h1>
        <div className={s.notice}>
          You need staff access to view the Accounting section.
        </div>
      </div>
    );
  }

  if (!payrollEnabled) {
    return (
      <div className={s.page}>
        <h1 className={s.title}>Accounting</h1>
        <div className={s.notice}>
          Payroll is not enabled for this organization.
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Accounting</h1>
          <p className={s.subtitle}>
            Payroll review and export. Phase 4 PR #1 — read-only.
          </p>
        </div>
      </div>

      <div className={s.tabs} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`${s.tabBtn} ${activeTab === t.id ? s.tabBtnActive : ''}`}
            disabled
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'payroll' && <PayrollTab />}
    </div>
  );
}
