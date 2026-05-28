// Executive Goals — pure helpers.
//
// Everything in this file is side-effect free: quarter math, progress
// math, week normalization, validation. Imported by the page, the
// queries module, and the test suite. No supabase client here — keeps
// the tests pure.

// ─── Quarter math ──────────────────────────────────────────────
// Quarters are represented as strings: '2026-Q2'. The display layer
// formats them; the DB and helpers always traffic in this canonical
// form so sorting is lexical and joins are stable.

export function quarterFromDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const month = d.getMonth(); // 0-11
  const q = Math.floor(month / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

export function quarterRange(quarter) {
  // Returns { start, end } as YYYY-MM-DD inclusive. Uses local time
  // so a quarter "starts April 1" lands on April 1 in the user's
  // calendar rather than midnight UTC.
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter ?? '');
  if (!m) return { start: null, end: null };
  const year = Number(m[1]);
  const qNum = Number(m[2]);
  const startMonth = (qNum - 1) * 3; // 0, 3, 6, 9
  const endMonth = startMonth + 2;   // 2, 5, 8, 11
  const start = new Date(year, startMonth, 1);
  // Last day of the end month: day 0 of the next month
  const end = new Date(year, endMonth + 1, 0);
  return { start: isoDate(start), end: isoDate(end) };
}

export function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Available quarters for the picker: every quarter that has at least
// one goal + the current quarter + the next quarter. Sorted descending
// so the most recent (often "now") is first.
export function buildQuarterOptions(goals, today = new Date()) {
  const set = new Set();
  for (const g of goals ?? []) {
    if (g?.quarter) set.add(g.quarter);
  }
  const current = quarterFromDate(today);
  if (current) {
    set.add(current);
    // Also surface the next quarter so owners can draft early.
    const m = /^(\d{4})-Q([1-4])$/.exec(current);
    if (m) {
      const y = Number(m[1]);
      const q = Number(m[2]);
      const nextQ = q === 4 ? 1 : q + 1;
      const nextY = q === 4 ? y + 1 : y;
      set.add(`${nextY}-Q${nextQ}`);
    }
  }
  return Array.from(set).sort((a, b) => b.localeCompare(a));
}

export function formatQuarterLabel(quarter) {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter ?? '');
  if (!m) return quarter ?? '';
  const months = {
    1: 'Jan–Mar',
    2: 'Apr–Jun',
    3: 'Jul–Sep',
    4: 'Oct–Dec',
  };
  return `${m[1]} Q${m[2]} (${months[Number(m[2])]})`;
}

// ─── Week normalization (for KR check-ins) ─────────────────────
// week_of is stored as the Monday of the ISO week. Owners check in
// once per week; the UNIQUE (key_result_id, week_of) constraint
// dedupes if they click twice on the same Monday.

export function mondayOf(date) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  // getDay(): 0 (Sun) .. 6 (Sat). Adjust so Monday is the start.
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  d.setHours(0, 0, 0, 0);
  return isoDate(d);
}

// ─── KR progress math ──────────────────────────────────────────
// Returns a structured descriptor the UI renders without further
// arithmetic. pct can exceed 1 (stretch achieved); UI is responsible
// for clamping the progress bar visually.

export function krProgress(kr) {
  if (!kr) return { pct: null, label: '—', achieved: false };
  const start = Number(kr.start_value ?? 0);
  const current = Number(kr.current_value ?? 0);
  const target = Number(kr.target_value);
  const direction = kr.direction ?? 'increase';
  if (!Number.isFinite(target)) return { pct: null, label: '—', achieved: false };

  let pct;
  if (direction === 'decrease') {
    // We want current to be lower than start. Achievement = how far
    // we've moved from start toward target.
    const denom = start - target;
    if (denom === 0) return { pct: current <= target ? 1 : 0, label: current <= target ? 'achieved' : 'not started', achieved: current <= target };
    pct = (start - current) / denom;
  } else {
    const denom = target - start;
    if (denom === 0) return { pct: current >= target ? 1 : 0, label: current >= target ? 'achieved' : 'not started', achieved: current >= target };
    pct = (current - start) / denom;
  }

  const clampedForLabel = Number.isFinite(pct) ? pct : 0;
  let label;
  if (clampedForLabel >= 1) label = 'achieved';
  else if (clampedForLabel >= 0.7) label = 'on track';
  else if (clampedForLabel >= 0.4) label = 'behind';
  else if (clampedForLabel > 0) label = 'early';
  else label = 'not started';

  return {
    pct,
    label,
    achieved: clampedForLabel >= 1,
  };
}

// ─── Validation ────────────────────────────────────────────────

export function validateGoalDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing goal data.' };
  }
  if (!draft.title || !draft.title.trim()) {
    return { ok: false, error: 'Objective title is required.' };
  }
  if (!draft.owner_email || !draft.owner_email.includes('@')) {
    return { ok: false, error: 'Owner email is required.' };
  }
  if (!draft.quarter || !/^\d{4}-Q[1-4]$/.test(draft.quarter)) {
    return { ok: false, error: 'Quarter must be in the form YYYY-Q[1-4].' };
  }
  if (!draft.start_date || !draft.end_date) {
    return { ok: false, error: 'Start and end dates are required.' };
  }
  if (draft.end_date < draft.start_date) {
    return { ok: false, error: 'End date must be on or after the start date.' };
  }
  const validStatuses = ['draft', 'active', 'achieved', 'missed', 'cancelled'];
  if (draft.status && !validStatuses.includes(draft.status)) {
    return { ok: false, error: 'Invalid status.' };
  }
  return { ok: true };
}

export function validateKrDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing key result data.' };
  }
  if (!draft.goal_id) {
    return { ok: false, error: 'Key result must belong to an objective.' };
  }
  if (!draft.title || !draft.title.trim()) {
    return { ok: false, error: 'Key result title is required.' };
  }
  if (!draft.owner_email || !draft.owner_email.includes('@')) {
    return { ok: false, error: 'Owner email is required.' };
  }
  const validUnits = ['count', 'percent', 'dollars', 'rating', 'other'];
  if (!validUnits.includes(draft.metric_unit)) {
    return { ok: false, error: 'Pick a valid metric unit.' };
  }
  if (!['increase', 'decrease'].includes(draft.direction ?? 'increase')) {
    return { ok: false, error: 'Direction must be increase or decrease.' };
  }
  const target = Number(draft.target_value);
  if (!Number.isFinite(target)) {
    return { ok: false, error: 'Target value must be a number.' };
  }
  const start = draft.start_value === null || draft.start_value === undefined || draft.start_value === ''
    ? 0
    : Number(draft.start_value);
  if (!Number.isFinite(start)) {
    return { ok: false, error: 'Start value must be a number.' };
  }
  return { ok: true };
}

export function validateCheckinDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing check-in data.' };
  }
  if (!draft.key_result_id) {
    return { ok: false, error: 'Check-in must belong to a key result.' };
  }
  if (!draft.week_of || !/^\d{4}-\d{2}-\d{2}$/.test(draft.week_of)) {
    return { ok: false, error: 'Week-of date is required (YYYY-MM-DD).' };
  }
  if (draft.value === null || draft.value === undefined || draft.value === '') {
    return { ok: false, error: 'Current value is required.' };
  }
  if (!Number.isFinite(Number(draft.value))) {
    return { ok: false, error: 'Current value must be a number.' };
  }
  if (!['green', 'yellow', 'red'].includes(draft.confidence)) {
    return { ok: false, error: 'Pick a confidence (green / yellow / red).' };
  }
  if (!draft.author) {
    return { ok: false, error: 'Author is required.' };
  }
  return { ok: true };
}

// ─── Sort helpers ──────────────────────────────────────────────

export function sortGoals(goals) {
  return [...(goals ?? [])].sort((a, b) => {
    if ((a.sort_order ?? 0) !== (b.sort_order ?? 0)) {
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    }
    return (a.created_at ?? '').localeCompare(b.created_at ?? '');
  });
}

export function sortKrs(krs) {
  return [...(krs ?? [])].sort((a, b) => {
    if ((a.sort_order ?? 0) !== (b.sort_order ?? 0)) {
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    }
    return (a.created_at ?? '').localeCompare(b.created_at ?? '');
  });
}

// Days since an ISO timestamp. Used by the "stale check-in" badge.
export function daysSince(timestamp, now = new Date()) {
  if (!timestamp) return null;
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return null;
  const ms = now.getTime() - t.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
