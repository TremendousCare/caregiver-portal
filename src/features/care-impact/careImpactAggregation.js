// ─── Care Impact — pure aggregation ────────────────────────────
//
// Pure functions that turn raw care_signals + client_health_events rows
// into the metrics the Impact dashboard renders. No I/O, no React —
// fully unit-testable. Mirrors the agentMetrics/metricsAggregation.js
// pattern.
//
// HONESTY CONTRACT (see docs/CARE_COORDINATOR_AGENT.md §11.4): this
// module reports OBSERVED agency rates + trends and a clearly-labeled
// "estimated avoided escalations" LEADING INDICATOR. It does NOT compute
// any causal "the AI reduced readmissions by X%" claim — there is no
// such function here on purpose.

export const TIME_RANGES = [
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '6mo', label: '6 months', days: 182 },
  { id: '12mo', label: '12 months', days: 365 },
];

export function getTimeRange(id) {
  return TIME_RANGES.find((r) => r.id === id) || TIME_RANGES[1];
}

const DAY_MS = 86_400_000;

// Hospitalization-class events for the readmission/ACH math.
const HOSPITAL_EVENTS = new Set(['hospitalization']);
const ED_EVENTS = new Set(['ed_visit']);

function inRange(iso, startMs, endMs) {
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t >= startMs && t <= endMs;
}

// Month bucket key (YYYY-MM) in UTC for trend series.
function monthKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Signal funnel: how many signals were surfaced, and what staff did with
 * them, over the window. Disposition comes from care_signals.status.
 */
export function signalFunnel(signals, { startMs, endMs }) {
  const out = { total: 0, open: 0, acknowledged: 0, actioned: 0, dismissed: 0, bySeverity: { urgent: 0, watch: 0, info: 0 } };
  for (const s of signals || []) {
    if (!inRange(s.created_at, startMs, endMs)) continue;
    out.total += 1;
    if (s.status in out) out[s.status] += 1;
    if (s.severity in out.bySeverity) out.bySeverity[s.severity] += 1;
  }
  // "Acted on" = acknowledged + actioned (staff engaged), vs dismissed.
  out.actedOn = out.acknowledged + out.actioned;
  out.actionRate = out.total > 0 ? out.actedOn / out.total : null;
  return out;
}

/**
 * Median minutes from signal creation → first disposition. A
 * responsiveness measure partners care about. Uses dispositioned_at.
 */
export function signalResponseLatency(signals, { startMs, endMs }) {
  const mins = [];
  for (const s of signals || []) {
    if (!inRange(s.created_at, startMs, endMs)) continue;
    if (!s.dispositioned_at) continue;
    const dt = new Date(s.dispositioned_at).getTime() - new Date(s.created_at).getTime();
    if (dt >= 0) mins.push(dt / 60000);
  }
  if (mins.length === 0) return { medianMinutes: null, n: 0 };
  mins.sort((a, b) => a - b);
  const mid = Math.floor(mins.length / 2);
  const median = mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
  return { medianMinutes: Math.round(median), n: mins.length };
}

/**
 * Outcome counts over the window: hospitalizations, ED visits, falls,
 * and 30-day readmissions (a hospitalization with related_discharge_id
 * set, OR computed within 30d of a discharge as a fallback).
 */
export function outcomeCounts(events, { startMs, endMs }) {
  const evs = (events || []).filter((e) => inRange(e.occurred_at, startMs, endMs));
  let hospitalizations = 0;
  let edVisits = 0;
  let falls = 0;
  let readmissions = 0;
  let discharges = 0;

  // Index discharges for the fallback readmission computation.
  const dischargesByClient = new Map();
  for (const e of events || []) {
    if (e.event_type === 'hospital_discharge') {
      if (!dischargesByClient.has(e.client_id)) dischargesByClient.set(e.client_id, []);
      dischargesByClient.get(e.client_id).push(new Date(e.occurred_at).getTime());
    }
  }

  for (const e of evs) {
    if (HOSPITAL_EVENTS.has(e.event_type)) {
      hospitalizations += 1;
      const isReadmit =
        !!e.related_discharge_id ||
        (dischargesByClient.get(e.client_id) || []).some((dt) => {
          const t = new Date(e.occurred_at).getTime();
          return dt < t && dt >= t - 30 * DAY_MS;
        });
      if (isReadmit) readmissions += 1;
    } else if (ED_EVENTS.has(e.event_type)) {
      edVisits += 1;
    } else if (e.event_type === 'fall') {
      falls += 1;
    } else if (e.event_type === 'hospital_discharge') {
      discharges += 1;
    }
  }

  return { hospitalizations, edVisits, falls, readmissions, discharges };
}

/**
 * Monthly trend series for charting. Each point: { month, hospitalizations,
 * edVisits, readmissions }. Sorted ascending. Only months within range.
 */
export function monthlyOutcomeTrend(events, { startMs, endMs }) {
  const buckets = new Map();
  const ensure = (k) => {
    if (!buckets.has(k)) buckets.set(k, { month: k, hospitalizations: 0, edVisits: 0, readmissions: 0 });
    return buckets.get(k);
  };
  const dischargesByClient = new Map();
  for (const e of events || []) {
    if (e.event_type === 'hospital_discharge') {
      if (!dischargesByClient.has(e.client_id)) dischargesByClient.set(e.client_id, []);
      dischargesByClient.get(e.client_id).push(new Date(e.occurred_at).getTime());
    }
  }
  for (const e of events || []) {
    if (!inRange(e.occurred_at, startMs, endMs)) continue;
    const k = monthKey(e.occurred_at);
    if (!k) continue;
    if (HOSPITAL_EVENTS.has(e.event_type)) {
      const b = ensure(k);
      b.hospitalizations += 1;
      const isReadmit =
        !!e.related_discharge_id ||
        (dischargesByClient.get(e.client_id) || []).some((dt) => {
          const t = new Date(e.occurred_at).getTime();
          return dt < t && dt >= t - 30 * DAY_MS;
        });
      if (isReadmit) b.readmissions += 1;
    } else if (ED_EVENTS.has(e.event_type)) {
      ensure(k).edVisits += 1;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Signal → outcome attribution 2×2, the core "did our early warning
 * work?" view. For each hospitalization/ED event in range:
 *   - caughtEarly: a signal preceded it (preceding_signal_id set)
 *   - missed:      no signal preceded it
 * And for signals:
 *   - trueWarning: signal whose outcome_event_id is set (an event followed)
 *   - estimatedAvoided: actioned signal with NO event in the lookahead
 *     window — a LEADING INDICATOR (candidate avoided escalation), NOT a
 *     proven causal save. Labeled as such in the UI.
 */
export function attributionMatrix(signals, events, { startMs, endMs, avoidedLookaheadDays = 14 } = {}) {
  const rangeEvents = (events || []).filter(
    (e) => inRange(e.occurred_at, startMs, endMs) && (HOSPITAL_EVENTS.has(e.event_type) || ED_EVENTS.has(e.event_type)),
  );
  let caughtEarly = 0;
  let missed = 0;
  for (const e of rangeEvents) {
    if (e.preceding_signal_id) caughtEarly += 1;
    else missed += 1;
  }

  // Build a per-client list of serious event times for the avoided check.
  const seriousByClient = new Map();
  for (const e of events || []) {
    if (HOSPITAL_EVENTS.has(e.event_type) || ED_EVENTS.has(e.event_type)) {
      if (!seriousByClient.has(e.client_id)) seriousByClient.set(e.client_id, []);
      seriousByClient.get(e.client_id).push(new Date(e.occurred_at).getTime());
    }
  }

  let trueWarning = 0;
  let estimatedAvoided = 0;
  for (const s of signals || []) {
    if (!inRange(s.created_at, startMs, endMs)) continue;
    if (s.outcome_event_id) {
      trueWarning += 1;
      continue;
    }
    // Estimated-avoided: the signal was ACTIONED (staff intervened) and
    // no serious event for that client followed within the lookahead.
    if (s.status === 'actioned') {
      const created = new Date(s.created_at).getTime();
      const lookEnd = created + avoidedLookaheadDays * DAY_MS;
      const hadEvent = (seriousByClient.get(s.client_id) || []).some((t) => t >= created && t <= lookEnd);
      if (!hadEvent) estimatedAvoided += 1;
    }
  }

  return { caughtEarly, missed, trueWarning, estimatedAvoided };
}

/**
 * Top-line summary object the dashboard header renders. Bundles the
 * pieces above plus derived rates. Every field is observed/leading —
 * none is a causal claim.
 */
export function impactSummary(signals, events, range) {
  const funnel = signalFunnel(signals, range);
  const latency = signalResponseLatency(signals, range);
  const outcomes = outcomeCounts(events, range);
  const attribution = attributionMatrix(signals, events, range);
  return { funnel, latency, outcomes, attribution };
}
