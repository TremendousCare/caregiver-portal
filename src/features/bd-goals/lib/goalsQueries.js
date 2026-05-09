// BD goals — data layer.
//
// Goals are versioned per (assignee_email, period). One goal is
// "active" at any moment: the row whose effective_from is on or
// before today AND whose effective_to is either null or in the
// future. Setting a new goal closes out the prior one
// (effective_to = day before new effective_from) so we never have
// two active goals overlapping.

export const PERIODS = ['weekly', 'monthly'];
export const PERIOD_LABELS = { weekly: 'Weekly', monthly: 'Monthly' };

// ─── Date helpers (work in YYYY-MM-DD strings to dodge TZ drift) ───

export function toIsoDate(input) {
  if (!input) return null;
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) {
    return input.slice(0, 10);
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  // Use local date components so a goal "starts today" matches the
  // user's calendar today rather than UTC's.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function todayIso(now = new Date()) {
  return toIsoDate(now);
}

export function addDaysIso(iso, days) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return toIsoDate(dt);
}

// ─── Active-goal selection ──────────────────────────────────────

export function isGoalActive(goal, today = todayIso()) {
  if (!goal) return false;
  if (goal.effective_from > today) return false;
  if (goal.effective_to && goal.effective_to < today) return false;
  return true;
}

export function findActiveGoal(goals, { period, assigneeEmail }, today = todayIso()) {
  const list = goals ?? [];
  return list.find((g) =>
    g.period === period
    && g.assignee_email === assigneeEmail
    && isGoalActive(g, today),
  ) ?? null;
}

// ─── Validation ─────────────────────────────────────────────────

export function validateGoalDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing form data.' };
  }
  if (!draft.assignee_email || !draft.assignee_email.includes('@')) {
    return { ok: false, error: 'Enter a valid email address for the assignee.' };
  }
  if (!PERIODS.includes(draft.period)) {
    return { ok: false, error: 'Pick a period (weekly or monthly).' };
  }
  if (!draft.effective_from) {
    return { ok: false, error: 'Set a start date.' };
  }
  const ints = ['visits_target', 'referrals_target', 'soc_target'];
  for (const k of ints) {
    if (draft[k] === null || draft[k] === undefined) continue;
    const n = Number(draft[k]);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'Targets must be whole numbers ≥ 0.' };
    }
  }
  // Require at least one target so the row is meaningful.
  const allEmpty = ints.every((k) => {
    const v = draft[k];
    return v === null || v === undefined || v === '';
  });
  if (allEmpty) {
    return { ok: false, error: 'Set at least one target (visits, referrals, or SOCs).' };
  }
  return { ok: true };
}

// ─── Progress overlay ───────────────────────────────────────────
//
// Pure formatter consumed by the Today screen + Funnel cards. Given
// an actual count and a target (possibly null), returns a structured
// progress descriptor the view can render without further math.

export function progressVsTarget(actual, target) {
  if (target === null || target === undefined || target === 0) {
    return { actual, target: null, pct: null, on_track: null, label: null };
  }
  const pct = actual / target;
  let label;
  if (pct >= 1)        label = 'goal reached';
  else if (pct >= 0.7) label = 'on track';
  else if (pct >= 0.4) label = 'behind';
  else                  label = 'early';
  return {
    actual,
    target,
    pct,
    on_track: pct >= 0.7,
    label,
  };
}

// ─── Supabase fetcher ───────────────────────────────────────────

export async function fetchBdGoals(supabase) {
  if (!supabase) return { data: [], error: null };
  const { data, error } = await supabase
    .from('bd_goals')
    .select('id, org_id, assignee_email, period, visits_target, referrals_target, soc_target, effective_from, effective_to, notes, created_by, created_at')
    .order('effective_from', { ascending: false });
  if (error) return { data: [], error };
  return { data: data ?? [], error: null };
}

// Inserts a new goal AND closes out the previous active one for the
// same (assignee_email, period) by setting its effective_to to the
// day before the new goal starts. Both writes happen sequentially —
// if the insert fails, the close-out is skipped.
export async function saveGoal(supabase, { orgId, draft, createdBy, existingGoals }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  const validation = validateGoalDraft(draft);
  if (!validation.ok) return { data: null, error: new Error(validation.error) };
  if (!orgId) return { data: null, error: new Error('Missing org_id from session — sign out and back in.') };

  const row = {
    org_id:           orgId,
    assignee_email:   draft.assignee_email.trim().toLowerCase(),
    period:           draft.period,
    visits_target:    draft.visits_target    ?? null,
    referrals_target: draft.referrals_target ?? null,
    soc_target:       draft.soc_target       ?? null,
    effective_from:   draft.effective_from,
    effective_to:     draft.effective_to ?? null,
    notes:            draft.notes?.trim() || null,
    created_by:       createdBy ?? null,
  };

  const insertRes = await supabase
    .from('bd_goals')
    .insert(row)
    .select('id, assignee_email, period, visits_target, referrals_target, soc_target, effective_from, effective_to')
    .single();
  if (insertRes.error) return { data: null, error: insertRes.error };

  // Close out the previous active goal for this (assignee, period).
  const prior = (existingGoals ?? []).find((g) =>
    g.id !== insertRes.data.id
    && g.assignee_email === row.assignee_email
    && g.period === row.period
    && (g.effective_to === null || g.effective_to >= row.effective_from)
    && g.effective_from < row.effective_from,
  );
  if (prior) {
    const closeAt = addDaysIso(row.effective_from, -1);
    try {
      await supabase
        .from('bd_goals')
        .update({ effective_to: closeAt })
        .eq('id', prior.id);
    } catch (e) {
      console.warn('prior goal close-out failed:', e);
    }
  }

  return { data: insertRes.data, error: null };
}
