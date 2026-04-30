import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../../shared/context/AppContext';
import { buildInvoice } from '../../../lib/invoicing/invoiceBuilder.js';
import { getPeriodPreviewData, priorWorkweek } from './storage.js';
import s from './ThisWeekView.module.css';

function formatCurrency(n) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatHours(n) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toFixed(2);
}

function clientDisplayName(client) {
  const first = client?.first_name?.trim() || '';
  const last = client?.last_name?.trim() || '';
  const full = `${first} ${last}`.trim();
  return full || client?.id || 'Unknown client';
}

function rateLabel(client, regularRate) {
  if (regularRate != null) return formatCurrency(regularRate);
  if (Number.isFinite(client?.default_billable_rate)) {
    return formatCurrency(client.default_billable_rate);
  }
  return <span className={s.rateMixed}>Mixed / unset</span>;
}

/**
 * Phase 1 read-only "This Week" view.
 *
 * Renders a per-client preview of what an invoice run for the prior
 * workweek would total. Pulls completed shifts + their payroll
 * hour-classification, runs the in-memory invoice builder, and
 * displays the rollup. Nothing is persisted.
 *
 * The view is scoped by the org's payroll timezone (same as the
 * payroll This Week view) so the period header always agrees with the
 * Payroll tab. Once the Phase 2 cron lands, this view will be backed
 * by the persisted invoices table instead of an in-memory rebuild.
 */
export function ThisWeekView() {
  const { currentOrgId, currentOrgSettings } = useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewData, setPreviewData] = useState({ clients: [] });

  // Use the same timezone setting payroll uses so the two tabs stay in
  // lockstep. If invoicing later wants its own timezone setting, this
  // is the place to swap in `currentOrgSettings?.invoicing?.timezone`.
  const period = useMemo(() => {
    const tz = currentOrgSettings?.payroll?.timezone || 'America/Los_Angeles';
    return priorWorkweek(new Date(), tz);
  }, [currentOrgSettings]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!currentOrgId) {
        setLoading(false);
        setPreviewData({ clients: [] });
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await getPeriodPreviewData({
          orgId: currentOrgId,
          periodStart: period.start,
          periodEnd: period.end,
        });
        if (!cancelled) setPreviewData(data);
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [currentOrgId, period.start, period.end]);

  // Run the pure builder on each client's line items. Nothing is
  // persisted — this is the live preview rollup.
  const invoiceRows = useMemo(() => {
    if (!currentOrgId) return [];
    const rows = [];
    for (const { client, lineItems } of previewData.clients) {
      const built = buildInvoice({
        orgId: currentOrgId,
        client,
        billingPeriodStart: period.start,
        billingPeriodEnd: period.end,
        shiftLineItems: lineItems,
      });
      if (!built) continue;
      rows.push({ client, built });
    }
    return rows;
  }, [previewData, currentOrgId, period.start, period.end]);

  const totals = useMemo(() => {
    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    let amount = 0;
    let blocked = 0;
    let warned = 0;
    for (const { built } of invoiceRows) {
      regular += Number(built.invoice.regular_hours) || 0;
      overtime += Number(built.invoice.overtime_hours) || 0;
      doubleTime += Number(built.invoice.double_time_hours) || 0;
      amount += Number(built.invoice.total) || 0;
      const hasBlock = built.exceptions.some((e) => e.severity === 'block');
      const hasWarn = built.exceptions.some((e) => e.severity === 'warn');
      if (hasBlock) blocked += 1;
      if (hasWarn && !hasBlock) warned += 1;
    }
    return {
      count: invoiceRows.length,
      regular,
      overtime,
      doubleTime,
      amount,
      blocked,
      warned,
    };
  }, [invoiceRows]);

  return (
    <div className={s.view}>
      <div className={s.header}>
        <div>
          <div className={s.periodLine}>
            Billing period: <strong>{period.start}</strong> &rarr; <strong>{period.end}</strong>
          </div>
          <div className={s.subtle}>
            Phase 1 preview &middot; live rollup, nothing persisted yet.
            {totals.count > 0 && ` ${totals.count} client${totals.count === 1 ? '' : 's'} would be invoiced.`}
            {totals.blocked > 0 && (
              <span className={s.blockedText}> {totals.blocked} blocked.</span>
            )}
            {totals.warned > 0 && (
              <span className={s.warnText}> {totals.warned} with warnings.</span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className={s.errorBanner}>
          Failed to load invoicing preview: {error}
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading invoicing preview&hellip;</div>
      ) : invoiceRows.length === 0 ? (
        <div className={s.empty}>
          No billable shifts for {period.start} &rarr; {period.end} yet.
          <div className={s.subtle}>
            Shifts must be marked <code>completed</code> to appear here.
            The payroll cron runs Monday morning PT &mdash; if you don&rsquo;t
            see hour-classification numbers (regular vs OT) yet, give it a
            day and check back Wednesday.
          </div>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th className={s.thLeft}>Client</th>
                <th className={s.thRight}>Reg</th>
                <th className={s.thRight}>OT</th>
                <th className={s.thRight}>DT</th>
                <th className={s.thRight}>Rate</th>
                <th className={s.thRight}>OT Rate</th>
                <th className={s.thRight}>Total</th>
                <th className={s.thLeft}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {invoiceRows.map(({ client, built }) => {
                const blockExceptions = built.exceptions.filter(
                  (e) => e.severity === 'block',
                );
                const warnExceptions = built.exceptions.filter(
                  (e) => e.severity === 'warn',
                );
                const rowClass = blockExceptions.length > 0
                  ? s.rowBlocked
                  : warnExceptions.length > 0
                    ? s.rowWarn
                    : '';
                return (
                  <tr key={client.id} className={rowClass}>
                    <td className={s.tdLeft}>
                      <div className={s.clientName}>{clientDisplayName(client)}</div>
                      {client.payer_type && (
                        <div className={s.payerTag}>{client.payer_type}</div>
                      )}
                    </td>
                    <td className={s.numCell}>{formatHours(built.invoice.regular_hours)}</td>
                    <td className={s.numCell}>{formatHours(built.invoice.overtime_hours)}</td>
                    <td className={s.numCell}>{formatHours(built.invoice.double_time_hours)}</td>
                    <td className={s.numCell}>{rateLabel(client, built.invoice.regular_rate)}</td>
                    <td className={s.numCell}>
                      {built.invoice.ot_rate != null
                        ? formatCurrency(built.invoice.ot_rate)
                        : <span className={s.rateMixed}>&mdash;</span>}
                    </td>
                    <td className={s.numCell}>
                      <strong>{formatCurrency(built.invoice.total)}</strong>
                    </td>
                    <td className={s.tdLeft}>
                      {blockExceptions.length === 0 && warnExceptions.length === 0 ? (
                        <span className={s.subtle}>&mdash;</span>
                      ) : (
                        <ul className={s.exceptionList}>
                          {blockExceptions.map((e, i) => (
                            <li key={`b-${i}`} className={s.exceptionBlock}>
                              {e.message}
                            </li>
                          ))}
                          {warnExceptions.map((e, i) => (
                            <li key={`w-${i}`} className={s.exceptionWarn}>
                              {e.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className={s.tfoot}>
              <tr>
                <td className={s.totalLabel}>
                  {totals.count} client{totals.count === 1 ? '' : 's'}
                  {totals.blocked > 0 && (
                    <span className={s.blockedCount}> &middot; {totals.blocked} blocked</span>
                  )}
                </td>
                <td className={s.numCell}>{formatHours(totals.regular)}</td>
                <td className={s.numCell}>{formatHours(totals.overtime)}</td>
                <td className={s.numCell}>{formatHours(totals.doubleTime)}</td>
                <td colSpan={2} />
                <td className={s.numCell}>
                  <strong>{formatCurrency(totals.amount)}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
