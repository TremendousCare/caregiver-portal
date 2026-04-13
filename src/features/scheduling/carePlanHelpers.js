// ═══════════════════════════════════════════════════════════════
// Care Plans — display helpers
//
// Small pure functions used by CarePlansPanel. Extracted so they
// can be unit-tested without rendering React components.
// ═══════════════════════════════════════════════════════════════

/**
 * Human-readable label for a care plan status value.
 */
export function formatStatusLabel(status) {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'ended':
      return 'Ended';
    default:
      return status || 'Unknown';
  }
}

/**
 * Color scheme for a care plan status pill.
 */
export function statusColors(status) {
  switch (status) {
    case 'draft':
      return { bg: '#F5F8FC', fg: '#5A6B80', border: '#E1E7EF' };
    case 'active':
      return { bg: '#DCFCE7', fg: '#166534', border: '#86EFAC' };
    case 'paused':
      return { bg: '#FEF3C7', fg: '#92400E', border: '#FCD34D' };
    case 'ended':
      return { bg: '#F5F5F5', fg: '#737373', border: '#D4D4D4' };
    default:
      return { bg: '#F5F8FC', fg: '#5A6B80', border: '#E1E7EF' };
  }
}

/**
 * Format a date string (YYYY-MM-DD) to a short display label.
 * Returns "—" for missing values.
 */
export function formatDateShort(date) {
  if (!date) return '—';
  try {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return date;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return date;
  }
}

/**
 * Summary line for a care plan card: dates and hours.
 * Example: "May 1, 2026 – ongoing · 20 hrs/week"
 */
export function summarizeCarePlan(plan) {
  const parts = [];
  const startLabel = plan.startDate ? formatDateShort(plan.startDate) : '—';
  const endLabel = plan.endDate ? formatDateShort(plan.endDate) : 'ongoing';
  parts.push(`${startLabel} – ${endLabel}`);
  if (plan.hoursPerWeek != null && plan.hoursPerWeek !== '') {
    parts.push(`${plan.hoursPerWeek} hrs/week`);
  }
  return parts.join(' · ');
}

/**
 * Sort care plans so active plans come first, then draft/paused,
 * then ended, with newest creation date first within each group.
 */
export function sortCarePlans(plans) {
  if (!Array.isArray(plans)) return [];
  const order = { active: 0, draft: 1, paused: 2, ended: 3 };
  return [...plans].sort((a, b) => {
    const byStatus = (order[a.status] ?? 99) - (order[b.status] ?? 99);
    if (byStatus !== 0) return byStatus;
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });
}

/**
 * Validate a care plan draft. Returns an error string (first problem
 * found) or null if the draft is valid enough to save.
 *
 * Rules:
 *   - title must be non-empty
 *   - if both dates are set, end_date must not be before start_date
 *   - hours_per_week, if set, must be a positive number
 */
export function validateCarePlanDraft(draft) {
  if (!draft) return 'Missing care plan data.';
  if (!draft.title || !String(draft.title).trim()) {
    return 'Title is required.';
  }
  if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
    return 'End date cannot be before start date.';
  }
  if (draft.hoursPerWeek != null && draft.hoursPerWeek !== '') {
    const num = Number(draft.hoursPerWeek);
    if (Number.isNaN(num) || num <= 0) {
      return 'Hours per week must be a positive number.';
    }
    if (num > 168) {
      return 'Hours per week cannot exceed 168.';
    }
  }
  return null;
}
