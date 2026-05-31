// ═══════════════════════════════════════════════════════════════
// Care Coordinator — Outcome Attribution (cron)
//
// Runs daily. Correlates client_health_events (hospitalizations, ED
// visits, falls, discharges) with the care_signals that preceded them,
// and links readmissions to their prior discharge. Writes:
//   - client_health_events.preceding_signal_id
//   - client_health_events.related_discharge_id
//   - care_signals.outcome_event_id
//
// This is what turns "we flagged a change" + "they were hospitalized"
// into the signal -> outcome record the impact dashboard (M5) reports.
//
// Read-only with respect to client care. Idempotent: only fills links
// that are still null, so re-running is a no-op once attributed.
//
// Design: docs/CARE_COORDINATOR_AGENT.md §11.3
// ═══════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { computeAttribution, HealthEventLite, SignalLite } from './attribution.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// How far back to consider events/signals each run. Bounds the working
// set; events older than this are already attributed from prior runs.
const LOOKBACK_DAYS = 45;
const DAY_MS = 86_400_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  // Gateway-auth model (same as the other cron jobs): a present
  // Authorization header is required; Supabase verifies the JWT.
  if (!req.headers.get('Authorization')) return jsonResponse({ error: 'Missing Authorization.' }, 401);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString();

  // Recent health events (the working set).
  const { data: eventRows, error: evErr } = await supabase
    .from('client_health_events')
    .select('id, client_id, event_type, occurred_at, preceding_signal_id, related_discharge_id')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: true });
  if (evErr) return jsonResponse({ error: evErr.message }, 500);

  const events: HealthEventLite[] = (eventRows ?? []).map((e) => ({
    id: e.id,
    clientId: e.client_id,
    eventType: e.event_type,
    occurredAt: e.occurred_at,
    precedingSignalId: e.preceding_signal_id ?? null,
    relatedDischargeId: e.related_discharge_id ?? null,
  }));

  if (events.length === 0) {
    return jsonResponse({ ok: true, events: 0, eventLinks: 0, signalLinks: 0 });
  }

  // Signals for those clients in the same window (+ a small buffer so a
  // signal just before the window edge can still attach to an event).
  const clientIds = Array.from(new Set(events.map((e) => e.clientId)));
  const signalSince = new Date(Date.now() - (LOOKBACK_DAYS + 30) * DAY_MS).toISOString();
  const { data: signalRows, error: sigErr } = await supabase
    .from('care_signals')
    .select('id, client_id, created_at, outcome_event_id')
    .in('client_id', clientIds)
    .gte('created_at', signalSince);
  if (sigErr) return jsonResponse({ error: sigErr.message }, 500);

  const signals: SignalLite[] = (signalRows ?? []).map((s) => ({
    id: s.id,
    clientId: s.client_id,
    createdAt: s.created_at,
    outcomeEventId: s.outcome_event_id ?? null,
  }));

  const { eventUpdates, signalUpdates } = computeAttribution(events, signals);

  // Apply. Small batches, sequential — cheap daily job, clarity over
  // throughput. Each write is independent; one failure doesn't block.
  let eventLinks = 0;
  for (const u of eventUpdates) {
    const patch: Record<string, string> = {};
    if (u.precedingSignalId) patch.preceding_signal_id = u.precedingSignalId;
    if (u.relatedDischargeId) patch.related_discharge_id = u.relatedDischargeId;
    if (Object.keys(patch).length === 0) continue;
    const { error } = await supabase.from('client_health_events').update(patch).eq('id', u.eventId);
    if (error) console.error('attribution: event update failed', u.eventId, error.message);
    else eventLinks += 1;
  }

  let signalLinks = 0;
  for (const u of signalUpdates) {
    const { error } = await supabase
      .from('care_signals')
      .update({ outcome_event_id: u.outcomeEventId })
      .eq('id', u.signalId);
    if (error) console.error('attribution: signal update failed', u.signalId, error.message);
    else signalLinks += 1;
  }

  return jsonResponse({ ok: true, events: events.length, eventLinks, signalLinks });
});
