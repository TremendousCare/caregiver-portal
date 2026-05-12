// Pure aggregation helpers for the agent metrics dashboard.
//
// All inputs are arrays of `agent_actions` rows (with payload._cost) and
// `action_outcomes` rows. All outputs are plain JSON safe for Recharts
// consumption. Pure functions — no I/O, no React, fully testable.

import { computeCostUsd } from './modelPricing';

/**
 * Time windows the dashboard supports. Each entry is a label plus the
 * number of days back to include. The `bucket` field controls how rows
 * are grouped on the x-axis.
 */
export const TIME_WINDOWS = [
  { id: 'day',   label: 'Day',  days: 1,  bucket: 'hour' },
  { id: 'week',  label: 'Week', days: 7,  bucket: 'day'  },
  { id: 'month', label: '30d',  days: 30, bucket: 'day'  },
];

export function getTimeWindow(id) {
  return TIME_WINDOWS.find((w) => w.id === id) || TIME_WINDOWS[1];
}

/**
 * The set of phases the suggestion volume chart breaks down by, in the
 * order the chart should stack them. Comes from the
 * `agent_actions.phase` enum.
 */
export const PHASE_ORDER = [
  'suggested',
  'auto_executed',
  'executed',
  'confirmed',
  'rejected',
  'expired',
  'shadow',
];

/** Friendlier display labels for each phase. */
export const PHASE_LABEL = {
  suggested:     'Pending',
  auto_executed: 'Auto-executed',
  executed:      'Executed',
  confirmed:     'Confirmed',
  rejected:      'Rejected',
  expired:       'Expired',
  shadow:        'Shadow',
};

/**
 * Bucket a timestamp into the YYYY-MM-DD (or YYYY-MM-DDTHH) key the
 * series uses. UTC throughout — the dashboard is internal-ops, no need
 * to localize labels.
 */
function bucketKey(iso, bucket) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (bucket === 'hour') {
    return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  }
  return d.toISOString().slice(0, 10);   // YYYY-MM-DD
}

/** Sum input/output tokens (and dollar cost) by date bucket. */
export function aggregateTokenSpend(actions, { bucket = 'day' } = {}) {
  const map = new Map();
  for (const row of actions) {
    const ts = row?.created_at;
    const cost = row?.payload?._cost;
    if (!ts || !cost) continue;
    const key = bucketKey(ts, bucket);
    if (!key) continue;
    const input = Number(cost.input_tokens) || 0;
    const output = Number(cost.output_tokens) || 0;
    const dollars = computeCostUsd(input, output, cost.model);
    const acc = map.get(key) || { bucket: key, input_tokens: 0, output_tokens: 0, dollars: 0 };
    acc.input_tokens += input;
    acc.output_tokens += output;
    acc.dollars += dollars;
    map.set(key, acc);
  }
  return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Average latency (duration_ms) per bucket. */
export function aggregateLatency(actions, { bucket = 'day' } = {}) {
  const map = new Map();
  for (const row of actions) {
    const ts = row?.created_at;
    const dur = Number(row?.payload?._cost?.duration_ms);
    if (!ts || !Number.isFinite(dur)) continue;
    const key = bucketKey(ts, bucket);
    if (!key) continue;
    const acc = map.get(key) || { bucket: key, total: 0, count: 0 };
    acc.total += dur;
    acc.count += 1;
    map.set(key, acc);
  }
  return Array.from(map.values())
    .map((a) => ({ bucket: a.bucket, avg_ms: Math.round(a.total / Math.max(1, a.count)) }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Count rows per phase. Returns one row per phase in PHASE_ORDER. */
export function aggregateSuggestionVolume(actions) {
  const counts = Object.fromEntries(PHASE_ORDER.map((p) => [p, 0]));
  for (const row of actions) {
    const ph = row?.phase;
    if (ph && Object.prototype.hasOwnProperty.call(counts, ph)) counts[ph] += 1;
  }
  return PHASE_ORDER.map((phase) => ({
    phase,
    label: PHASE_LABEL[phase] || phase,
    count: counts[phase],
  }));
}

/**
 * For each action_type, compute the verified-outcome success rate.
 *
 * Reads `action_outcomes` directly — that table is the source of truth
 * for "did the side-effect work?". The shells write outcomes from the
 * execution path independently of `agent_actions`, and the audit log's
 * `outcome_id` column is intentionally left NULL today (the action is
 * recorded BEFORE the outcome lands and the hash chain is immutable
 * after write). Joining on `outcome_id` would always be empty.
 *
 * An outcome is "verified" when its `outcome_type` is non-NULL.
 * Successes: `response_received`, `completed`, `advanced`.
 * Misses:    `no_response`, `declined`, `expired`.
 *
 * Note: `agent_actions.action_type` ("send_sms") differs from
 * `action_outcomes.action_type` ("sms_sent") by convention — the
 * verbs-vs-past-tense split is intentional, so this chart reports
 * outcome-side names. Phase 1.5 will reconcile both surfaces.
 */
const SUCCESS_OUTCOMES = new Set(['response_received', 'completed', 'advanced']);

export function aggregateVerifiedOutcomeRate(outcomes) {
  const byType = new Map();
  for (const row of outcomes || []) {
    const at = row?.action_type;
    if (!at) continue;
    const acc = byType.get(at) || { action_type: at, verified: 0, success: 0, pending: 0, total: 0 };
    acc.total += 1;
    if (row.outcome_type) {
      acc.verified += 1;
      if (SUCCESS_OUTCOMES.has(row.outcome_type)) acc.success += 1;
    } else {
      acc.pending += 1;
    }
    byType.set(at, acc);
  }

  return Array.from(byType.values())
    .map((a) => ({
      ...a,
      success_rate: a.verified > 0 ? a.success / a.verified : null,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Cost per verified outcome (USD).
 *   total_dollars / total_verified_outcomes
 *
 * Dollars come from `agent_actions.payload._cost`; verified count
 * comes from `action_outcomes.outcome_type IS NOT NULL`. We don't try
 * to attribute dollars to a specific outcome — the audit row is
 * written before the outcome resolves, and there's no clean FK link.
 * For "is this agent earning its keep?" the headline ratio is the
 * right granularity.
 *
 * Returns null `cost_per` when nothing has been verified yet so the
 * UI can show a dash rather than divide by zero.
 */
export function costPerVerifiedOutcome(actions, outcomes) {
  let dollars = 0;
  for (const row of actions) {
    const cost = row?.payload?._cost;
    if (!cost) continue;
    dollars += computeCostUsd(cost.input_tokens, cost.output_tokens, cost.model);
  }
  let verified = 0;
  for (const row of outcomes || []) {
    if (row?.outcome_type) verified += 1;
  }
  if (verified === 0) return { dollars, verified: 0, cost_per: null };
  return { dollars, verified, cost_per: dollars / verified };
}

/** Headline totals (token spend + dollar cost) for the time window. */
export function totals(actions) {
  let input = 0;
  let output = 0;
  let dollars = 0;
  let count = 0;
  for (const row of actions) {
    const c = row?.payload?._cost;
    if (!c) continue;
    input += Number(c.input_tokens) || 0;
    output += Number(c.output_tokens) || 0;
    dollars += computeCostUsd(c.input_tokens, c.output_tokens, c.model);
    count += 1;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    dollars,
    invocations_with_cost: count,
    invocations_total: actions.length,
  };
}
