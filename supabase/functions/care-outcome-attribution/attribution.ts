// ─── Outcome attribution (pure logic) ──────────────────────────
//
// Correlates client_health_events with the care_signals that preceded
// them, and links hospital readmissions to their prior discharge. No
// I/O — the cron orchestrator (index.ts) fetches rows, calls these, and
// writes the results back. Kept pure so it's unit-testable under vitest.
//
// Two relationships are computed:
//   1. signal -> event attribution: did a care signal fire in the
//      `signalLookbackDays` window BEFORE this event? If so the event
//      links to the most recent such signal (preceding_signal_id) and
//      that signal links back (outcome_event_id). This is the core of
//      "did our early warning precede the outcome?"
//   2. readmission linkage: a hospitalization within
//      `readmissionWindowDays` AFTER a hospital_discharge is a
//      readmission; it links to that discharge (related_discharge_id).
//
// Design: docs/CARE_COORDINATOR_AGENT.md §11.3

export interface HealthEventLite {
  id: string;
  clientId: string;
  eventType: string;
  occurredAt: string; // ISO
  precedingSignalId: string | null;
  relatedDischargeId: string | null;
}

export interface SignalLite {
  id: string;
  clientId: string;
  createdAt: string; // ISO
  outcomeEventId: string | null;
}

export interface AttributionOptions {
  signalLookbackDays?: number; // default 14
  readmissionWindowDays?: number; // default 30
}

export interface EventUpdate {
  eventId: string;
  precedingSignalId?: string;
  relatedDischargeId?: string;
}

export interface SignalUpdate {
  signalId: string;
  outcomeEventId: string;
}

export interface AttributionResult {
  eventUpdates: EventUpdate[];
  signalUpdates: SignalUpdate[];
}

const DAY_MS = 86_400_000;

/**
 * For one event, find the most recent signal for the same client that
 * was created within [occurred - lookback, occurred]. Returns null if
 * none. (A signal created AFTER the event cannot have "preceded" it.)
 */
export function findPrecedingSignal(
  event: HealthEventLite,
  signals: SignalLite[],
  lookbackDays: number,
): SignalLite | null {
  const occurred = new Date(event.occurredAt).getTime();
  const windowStart = occurred - lookbackDays * DAY_MS;
  let best: SignalLite | null = null;
  let bestTime = -Infinity;
  for (const s of signals) {
    if (s.clientId !== event.clientId) continue;
    const t = new Date(s.createdAt).getTime();
    if (t > occurred || t < windowStart) continue; // must be within the pre-window
    if (t > bestTime) {
      best = s;
      bestTime = t;
    }
  }
  return best;
}

/**
 * For a hospitalization, find a hospital_discharge for the same client
 * within [occurred - window, occurred). The most recent qualifying
 * discharge wins. Returns null if none (i.e. not a readmission).
 */
export function findRelatedDischarge(
  event: HealthEventLite,
  events: HealthEventLite[],
  windowDays: number,
): HealthEventLite | null {
  if (event.eventType !== 'hospitalization') return null;
  const occurred = new Date(event.occurredAt).getTime();
  const windowStart = occurred - windowDays * DAY_MS;
  let best: HealthEventLite | null = null;
  let bestTime = -Infinity;
  for (const e of events) {
    if (e.id === event.id) continue;
    if (e.clientId !== event.clientId) continue;
    if (e.eventType !== 'hospital_discharge') continue;
    const t = new Date(e.occurredAt).getTime();
    if (t >= occurred || t < windowStart) continue; // strictly before the admission
    if (t > bestTime) {
      best = e;
      bestTime = t;
    }
  }
  return best;
}

/**
 * Compute all attribution updates for a batch of events. Only events
 * that don't already have the relevant link set are touched (idempotent
 * — re-running produces no new writes once everything is attributed).
 */
export function computeAttribution(
  events: HealthEventLite[],
  signals: SignalLite[],
  options: AttributionOptions = {},
): AttributionResult {
  const lookback = options.signalLookbackDays ?? 14;
  const readmitWindow = options.readmissionWindowDays ?? 30;

  const eventUpdates: EventUpdate[] = [];
  const signalUpdates: SignalUpdate[] = [];
  // Guard against double-linking a signal to multiple events in one run.
  const claimedSignals = new Set(
    signals.filter((s) => s.outcomeEventId).map((s) => s.id),
  );

  for (const event of events) {
    const update: EventUpdate = { eventId: event.id };
    let changed = false;

    if (!event.precedingSignalId) {
      const signal = findPrecedingSignal(event, signals, lookback);
      if (signal && !claimedSignals.has(signal.id)) {
        update.precedingSignalId = signal.id;
        signalUpdates.push({ signalId: signal.id, outcomeEventId: event.id });
        claimedSignals.add(signal.id);
        changed = true;
      }
    }

    if (!event.relatedDischargeId) {
      const discharge = findRelatedDischarge(event, events, readmitWindow);
      if (discharge) {
        update.relatedDischargeId = discharge.id;
        changed = true;
      }
    }

    if (changed) eventUpdates.push(update);
  }

  return { eventUpdates, signalUpdates };
}
