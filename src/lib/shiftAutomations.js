// ═══════════════════════════════════════════════════════════════
// Shift Automation Dispatch
//
// When a shift is created or mutated, decide which scheduling
// automation rules to fire and dispatch them via execute-automation.
//
// Three event types are sourced from shift mutations:
//   - shift_assigned  (assigned_caregiver_id null → set, or A → B)
//   - shift_changed   (start_time/end_time/client_id changed on an
//                      already-assigned shift)
//   - shift_canceled  (status → 'cancelled', or assigned caregiver
//                      removed/replaced)
//
// The fourth shift trigger (shift_reminder_24h) is recurring and
// fires from automation-cron, not here.
//
// Mirrors the pattern in src/lib/automations.js (caregiver triggers)
// and src/features/clients/automations.js (client triggers): pure
// diff + fire-and-forget execute-automation invocation. Never blocks
// the calling mutation; all errors are warned, never thrown.
// ═══════════════════════════════════════════════════════════════

import { supabase, isSupabaseConfigured } from './supabase';

// ─── Pure diff: shift state change → events ───────────────────────
//
// Returns an array of { type, caregiverId } events to dispatch.
// Exported for unit testing — has no side effects.
//
// Decisions:
//   - Creation (oldShift = null) with assigned_caregiver_id set and
//     status assigned/confirmed → shift_assigned for that caregiver.
//   - assigned_caregiver_id null → set → shift_assigned for the new id.
//   - assigned_caregiver_id A → B (different) → shift_canceled for A
//     AND shift_assigned for B. Treating reassignment as cancel-then-
//     assign keeps each caregiver's notification accurate and lets
//     the admin tune the two templates independently.
//   - assigned_caregiver_id A → null → shift_canceled for A.
//   - status 'open'/'offered'/'assigned'/'confirmed'/'in_progress'
//     → 'cancelled' AND a caregiver was assigned → shift_canceled.
//     If no caregiver was assigned, no notification fires.
//   - For an already-assigned, still-active shift: start_time / end_time
//     / client_id changed → shift_changed for the assigned caregiver.
//   - Status transitions to 'completed', 'no_show', 'in_progress' do
//     NOT fire shift_changed — these are caregiver-driven or admin
//     bookkeeping actions that don't need a shift_changed SMS.

const ACTIVE_STATUSES = new Set(['assigned', 'confirmed', 'in_progress']);
const NOTIFIABLE_PRIOR_STATUSES = new Set([
  'open', 'offered', 'assigned', 'confirmed', 'in_progress',
]);

export function diffShiftForEvents(oldShift, newShift) {
  if (!newShift) return [];
  const events = [];

  // ── Cancellation paths ──
  // Status transitioned to 'cancelled' on a shift that had a caregiver.
  if (
    newShift.status === 'cancelled'
    && (!oldShift || oldShift.status !== 'cancelled')
    && oldShift
    && oldShift.assignedCaregiverId
    && NOTIFIABLE_PRIOR_STATUSES.has(oldShift.status)
  ) {
    events.push({ type: 'shift_canceled', caregiverId: oldShift.assignedCaregiverId });
    return events;
  }

  // ── Assignment paths ──
  const oldCgId = oldShift?.assignedCaregiverId || null;
  const newCgId = newShift.assignedCaregiverId || null;

  if (oldCgId !== newCgId) {
    // Caregiver removed (A → null) on an active shift
    if (oldCgId && !newCgId && oldShift && NOTIFIABLE_PRIOR_STATUSES.has(oldShift.status)) {
      events.push({ type: 'shift_canceled', caregiverId: oldCgId });
    }
    // New assignment (null → A or A → B)
    if (newCgId && ACTIVE_STATUSES.has(newShift.status)) {
      // Reassignment: also notify the previous caregiver they're off this shift
      if (oldCgId && oldShift && NOTIFIABLE_PRIOR_STATUSES.has(oldShift.status)) {
        events.push({ type: 'shift_canceled', caregiverId: oldCgId });
      }
      events.push({ type: 'shift_assigned', caregiverId: newCgId });
    }
    // Treat creation specially: oldShift is null, new has caregiver and active status
    // (already covered by the newCgId branch above when oldShift is null).
    return events;
  }

  // ── Same caregiver, same active status — check for change events ──
  if (
    newCgId
    && ACTIVE_STATUSES.has(newShift.status)
    && oldShift
    && (
      oldShift.startTime !== newShift.startTime
      || oldShift.endTime !== newShift.endTime
      || oldShift.clientId !== newShift.clientId
    )
  ) {
    events.push({ type: 'shift_changed', caregiverId: newCgId });
  }

  return events;
}

// ─── Pre-format ISO timestamps for SMS-friendly display ─────────────
//
// Formats a timestamp in 'America/New_York' (Eastern Time) as
// "Mon, Apr 25, 2:00 PM ET". This is a pragmatic v1 default — Phase D
// of the SaaS retrofit will move the timezone into organizations.settings
// so each agency formats messages in their own region. Caregivers and
// admins on the current Tremendous Care deployment are all Eastern.
//
// Exported so the cron section uses the same formatter for shift_reminder_24h.
const SHIFT_DISPLAY_TZ = 'America/New_York';

export function formatShiftDateTime(iso, tz = SHIFT_DISPLAY_TZ) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
      timeZoneName: 'short',
    });
    return formatter.format(d);
  } catch {
    // Fall back to ISO if Intl rejects the timezone (very old runtime).
    return d.toISOString();
  }
}

// ─── Build the trigger context payload from shift + client ─────────
//
// Resolved into the message via resolveAutomationMergeFields in the
// edge function. Extracted so the cron section can construct the same
// shape from its server-side query results.
export function buildShiftTriggerContext(shift, client) {
  const fullName = client
    ? `${client.first_name || client.firstName || ''} ${client.last_name || client.lastName || ''}`.trim()
    : '';
  const addressParts = client
    ? [
        client.address ?? null,
        client.city ?? null,
        client.state ?? null,
        client.zip ?? null,
      ].filter(Boolean)
    : [];
  return {
    shift_id: shift.id,
    shift_start: shift.startTime || shift.start_time || null,
    shift_end: shift.endTime || shift.end_time || null,
    shift_start_text: formatShiftDateTime(shift.startTime || shift.start_time),
    shift_end_text: formatShiftDateTime(shift.endTime || shift.end_time),
    shift_address: addressParts.join(', '),
    client_id: client?.id || shift.clientId || shift.client_id || null,
    client_first_name: client?.first_name || client?.firstName || '',
    client_last_name: client?.last_name || client?.lastName || '',
    client_full_name: fullName,
  };
}

// ─── Dispatch a single shift event to execute-automation ───────────
//
// Fire-and-forget. Looks up enabled rules for the trigger type, loads
// caregiver + client data once, then invokes execute-automation per
// matching rule. Respects caregiver SMS opt-out at the dispatch level
// so opted-out caregivers are skipped before the rule even fires.
async function fireShiftEventTrigger(triggerType, shift, caregiverId) {
  // Fetch enabled rules first; bail early if none — saves a DB hit on
  // caregiver/client lookups when Scheduling tab has no rules enabled.
  const { data: rules, error: rulesErr } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('trigger_type', triggerType)
    .eq('enabled', true);
  if (rulesErr || !rules || rules.length === 0) return;

  const { data: caregiver, error: cgErr } = await supabase
    .from('caregivers')
    .select('id, first_name, last_name, phone, email, sms_opted_out, archived')
    .eq('id', caregiverId)
    .maybeSingle();
  if (cgErr || !caregiver) return;
  if (caregiver.sms_opted_out || caregiver.archived) return;

  const { data: client } = shift.clientId
    ? await supabase
      .from('clients')
      .select('id, first_name, last_name, address, city, state, zip')
      .eq('id', shift.clientId)
      .maybeSingle()
    : { data: null };

  const triggerContext = buildShiftTriggerContext(shift, client);
  const cgPayload = {
    id: caregiver.id,
    first_name: caregiver.first_name || '',
    last_name: caregiver.last_name || '',
    phone: caregiver.phone || '',
    email: caregiver.email || '',
  };

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  for (const rule of rules) {
    supabase.functions.invoke('execute-automation', {
      body: {
        rule_id: rule.id,
        caregiver_id: caregiver.id,
        action_type: rule.action_type,
        message_template: rule.message_template,
        action_config: rule.action_config,
        rule_name: rule.name,
        caregiver: cgPayload,
        trigger_context: triggerContext,
      },
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch((err) => console.warn('Shift automation fire error:', err));
  }
}

// ─── Public entry point ──────────────────────────────────────────
//
// Call from updateShift / insertShift after the mutation succeeds.
// Diffs old vs new, decides which events apply, dispatches each.
export async function dispatchShiftAutomations(oldShift, newShift) {
  if (!isSupabaseConfigured()) return;

  try {
    const events = diffShiftForEvents(oldShift, newShift);
    if (events.length === 0) return;

    for (const event of events) {
      // For shift_canceled the relevant caregiver is the OLD assignee;
      // for shift_assigned and shift_changed it's the new one. The diff
      // helper already provides the correct caregiverId per event.
      if (!event.caregiverId) continue;
      // We pass newShift as the shape (it carries clientId / startTime)
      // for context. For shift_canceled where caregiver was removed,
      // newShift still has clientId/startTime so the message renders.
      await fireShiftEventTrigger(event.type, newShift, event.caregiverId);
    }
  } catch (err) {
    // Never block the calling mutation.
    console.warn('dispatchShiftAutomations error:', err);
  }
}
