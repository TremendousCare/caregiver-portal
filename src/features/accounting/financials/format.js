// Display formatters for the Financials sub-tab. Mirrors the
// Intl.NumberFormat conventions used in agentMetrics / care-impact.

export const DOLLAR = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const DOLLAR_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

export const NUMBER = new Intl.NumberFormat('en-US');

export function formatMoney(n) {
  return DOLLAR.format(Number(n) || 0);
}

export function formatMoneyCents(n) {
  return DOLLAR_CENTS.format(Number(n) || 0);
}

export function formatHours(n) {
  const v = Number(n) || 0;
  return `${NUMBER.format(Math.round(v * 10) / 10)} hrs`;
}

export function formatPercent(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${(Math.round(Number(n) * 10) / 10).toFixed(1)}%`;
}

export function formatCount(n) {
  return NUMBER.format(Number(n) || 0);
}

// "MMM 'YY" label for a YYYY-MM month key (e.g. "2026-05" → "May '26").
export function formatMonthLabel(month) {
  const [y, m] = (month ?? '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month ?? '';
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} '${String(y).slice(2)}`;
}
