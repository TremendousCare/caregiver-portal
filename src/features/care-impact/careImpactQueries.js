// ─── Care Impact — Supabase queries (read-only) ────────────────
//
// Fetches the care_signals + client_health_events rows the Impact
// dashboard aggregates. Staff-only RLS already scopes these to the
// caller's org. We fetch a single bounded window (the widest range the
// UI offers) and aggregate client-side, matching the agentMetrics
// pattern — the data volumes here are small (events are rare).

import { supabase } from '../../lib/supabase';

const SIGNAL_COLUMNS =
  'id, client_id, severity, status, created_at, dispositioned_at, outcome_event_id';
const EVENT_COLUMNS =
  'id, client_id, event_type, occurred_at, related_discharge_id, preceding_signal_id';

// Fetch both datasets since `sinceIso`. Returns { signals, events }.
export async function fetchCareImpactData(sinceIso, client = supabase) {
  const [signalsRes, eventsRes] = await Promise.all([
    client
      .from('care_signals')
      .select(SIGNAL_COLUMNS)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true }),
    client
      .from('client_health_events')
      .select(EVENT_COLUMNS)
      // Pull a wider event history than the signal window so the
      // readmission/discharge lookbacks have the prior discharge.
      .order('occurred_at', { ascending: true }),
  ]);
  if (signalsRes.error) throw signalsRes.error;
  if (eventsRes.error) throw eventsRes.error;
  return { signals: signalsRes.data || [], events: eventsRes.data || [] };
}
