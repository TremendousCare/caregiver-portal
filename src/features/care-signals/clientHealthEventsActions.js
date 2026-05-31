// ─── Client health event data actions ─────────────────────────
//
// Supabase I/O for client_health_events — the outcome-measurement
// substrate. Office staff log events here; the attribution cron later
// fills preceding_signal_id / related_discharge_id.

import { supabase } from '../../lib/supabase';
import { actorFromUser } from './careSignalHelpers';
import { buildHealthEventRow, mapHealthEventRow } from './healthEventHelpers';

const EVENT_COLUMNS =
  'id, client_id, event_type, occurred_at, related_discharge_id, avoidable, ' +
  'preceding_signal_id, source, note, recorded_by, created_at';

// Recent health events for a client, newest first.
export async function fetchHealthEvents(clientId, client = supabase) {
  const { data, error } = await client
    .from('client_health_events')
    .select(EVENT_COLUMNS)
    .eq('client_id', clientId)
    .order('occurred_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapHealthEventRow);
}

// Log a new health event. Returns the mapped row. `currentUser` is the
// app's { displayName, email } object.
export async function logHealthEvent(input, { currentUser } = {}, client = supabase) {
  const recordedBy = actorFromUser(currentUser);
  const { row, error: validationError } = buildHealthEventRow(input, { recordedBy });
  if (validationError) throw validationError;
  const { data, error } = await client
    .from('client_health_events')
    .insert(row)
    .select(EVENT_COLUMNS)
    .single();
  if (error) throw error;
  return mapHealthEventRow(data);
}
