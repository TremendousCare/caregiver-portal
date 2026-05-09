import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../shared/context/AppContext';
import { PayrollTab } from './payroll/PayrollTab';
import { InvoicingTab } from './invoicing/InvoicingTab';
import s from './AccountingPage.module.css';

/**
 * Top-level Accounting page. Hosts independent sub-tabs:
 *   - Payroll (gated by features_enabled.payroll)
 *   - Invoicing (gated by features_enabled.invoicing) — Phase 1 read-only
 *
 * The page is gated by AppShell's sidebar entry on staff role + at
 * least one Accounting feature flag. If a user navigates directly to
 * /accounting without those, we still render a polite empty state
 * rather than throwing.
 *
 * Future tabs (out of scope today): Expenses, Reports, Tax Documents.
 */
export function AccountingPage() {
  const { isAdmin, currentOrgRole, currentOrgSettings } = useApp();
  // PR #288 (RBAC 3 of 3) restricted payroll & invoicing tables to
  // admins only at the RLS layer. Match that here so members get a
  // polite empty state rather than RLS-blocked SELECTs producing an
  // unexplained empty UI.
  const isStaff = isAdmin || currentOrgRole === 'admin';
  const payrollEnabled = currentOrgSettings?.features_enabled?.payroll === true;
  const invoicingEnabled = currentOrgSettings?.features_enabled?.invoicing === true;

  const tabs = useMemo(() => {
    const out = [];
    if (payrollEnabled) out.push({ id: 'payroll', label: 'Payroll' });
    if (invoicingEnabled) out.push({ id: 'invoicing', label: 'Invoicing' });
    return out;
  }, [payrollEnabled, invoicingEnabled]);

  // Default to the first enabled tab. The `?tab=` query param can deep-
  // link directly to a sub-tab (e.g., from a future briefing card or
  // email link); falls back to the first enabled tab if invalid.
  const [searchParams] = useSearchParams();
  const queryTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(
    () => (tabs.some((t) => t.id === queryTab) ? queryTab : tabs[0]?.id) ?? null,
  );
  const effectiveActiveTab = tabs.some((t) => t.id === activeTab)
    ? activeTab
    : (tabs[0]?.id ?? null);

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

  if (tabs.length === 0) {
    return (
      <div className={s.page}>
        <h1 className={s.title}>Accounting</h1>
        <div className={s.notice}>
          No Accounting features are enabled for this organization.
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
            {payrollEnabled && invoicingEnabled
              ? 'Payroll review, exports, and client invoicing.'
              : payrollEnabled
                ? 'Payroll review and export.'
                : 'Client invoicing.'}
          </p>
        </div>
      </div>

      <div className={s.tabs} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={effectiveActiveTab === t.id}
            className={`${s.tabBtn} ${effectiveActiveTab === t.id ? s.tabBtnActive : ''}`}
            onClick={() => setActiveTab(t.id)}
            disabled={tabs.length === 1}
          >
            {t.label}
          </button>
        ))}
      </div>

      {effectiveActiveTab === 'payroll' && <PayrollTab />}
      {effectiveActiveTab === 'invoicing' && <InvoicingTab />}
    </div>
  );
}
