// ─── Care Signal data actions ──────────────────────────────────
//
// Supabase I/O for the care-signals triage worklist. The detector
// (edge function) writes signals; staff disposition them here. All
// writes go to care_signals; disposition also emits a best-effort
// `events` row for analytics (events RLS allows authenticated inserts).

import { supabase } from '../../lib/supabase';
import { createUserTask } from '../../lib/followUpTasks';
import { mapSignalRow, buildTaskInputFromSignal, actorFromUser } from './careSignalHelpers';

const SIGNAL_COLUMNS =
  'id, client_id, care_plan_id, severity, categories, summary, sbar, evidence, ' +
  'window_start, window_end, status, disposition_note, dispositioned_by, ' +
  'dispositioned_at, follow_up_task_id, created_at, model';

// Open signals for a client, newest first (caller sorts for display).
export async function fetchOpenSignals(clientId, client = supabase) {
  const { data, error } = await client
    .from('care_signals')
    .select(SIGNAL_COLUMNS)
    .eq('client_id', clientId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapSignalRow);
}

// Fire-and-forget analytics. Never blocks the disposition.
async function logSignalEvent(signal, eventType, actor, extra, client) {
  try {
    await client.from('events').insert({
      event_type: eventType,
      entity_type: 'client',
      entity_id: signal.clientId,
      actor: actor ? `user:${actor}` : 'user:unknown',
      payload: { care_signal_id: signal.id, severity: signal.severity, ...extra },
    });
  } catch (err) {
    console.warn('[careSignals] event log failed (non-blocking)', err);
  }
}

// Apply a disposition (acknowledged | dismissed | actioned) to a signal.
export async function dispositionSignal(signal, { status, note, currentUser }, client = supabase) {
  const actor = actorFromUser(currentUser);
  const { data, error } = await client
    .from('care_signals')
    .update({
      status,
      disposition_note: note || null,
      dispositioned_by: actor,
      dispositioned_at: new Date().toISOString(),
    })
    .eq('id', signal.id)
    .select(SIGNAL_COLUMNS)
    .single();
  if (error) throw error;
  await logSignalEvent(signal, 'care_signal_dispositioned', actor, { disposition: status }, client);
  return mapSignalRow(data);
}

// Spin a follow-up task off a signal, mark the signal actioned, and link
// the two. Human-initiated only.
export async function createFollowUpFromSignal(signal, { clientName, currentUser }, client = supabase) {
  const actor = actorFromUser(currentUser);
  const input = buildTaskInputFromSignal(signal, { clientName, createdBy: actor });
  const { task, error: taskError } = await createUserTask(input, client);
  if (taskError) throw taskError;

  const { data, error } = await client
    .from('care_signals')
    .update({
      status: 'actioned',
      follow_up_task_id: task.id,
      disposition_note: 'Follow-up task created',
      dispositioned_by: actor,
      dispositioned_at: new Date().toISOString(),
    })
    .eq('id', signal.id)
    .select(SIGNAL_COLUMNS)
    .single();
  if (error) throw error;
  await logSignalEvent(
    signal,
    'care_signal_dispositioned',
    actor,
    { disposition: 'actioned', follow_up_task_id: task.id },
    client,
  );
  return { signal: mapSignalRow(data), task };
}
