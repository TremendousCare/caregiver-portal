import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { getClientPhase } from './utils';
import { resolveClientMergeFields, normalizeSequenceAction, shouldAutoEnroll, buildEnrollmentRecord } from './sequenceHelpers';

// ═══════════════════════════════════════════════════════════════
// Client Automation Event Triggers & Sequence Runner
//
// 1) fireClientEventTriggers — fires matching automation rules
//    when client events occur (e.g. new_client, phase_change).
//
// 2) fireClientSequences — immediately executes zero-delay
//    sequence steps and enqueues delayed steps for the cron.
//
// Both are fire-and-forget — they never block the UI.
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate whether a rule's conditions match the current client + trigger context.
 * Returns true if the rule should fire, false if it should be skipped.
 */
function evaluateConditions(rule, client, triggerContext) {
  const conds = rule.conditions || {};

  // Phase filter: only fire if client is currently in a specific phase
  if (conds.phase && getClientPhase(client) !== conds.phase) return false;

  // For phase_change trigger: match target phase
  if (conds.to_phase && triggerContext.to_phase !== conds.to_phase) return false;

  // For task_completed trigger: match specific task ID
  if (conds.task_id && triggerContext.task_id !== conds.task_id) return false;

  // For inbound_sms trigger: match keyword in message text (case-insensitive)
  if (conds.keyword) {
    const messageText = (triggerContext.message_text || '').toLowerCase();
    if (!messageText.includes(conds.keyword.toLowerCase())) return false;
  }

  return true;
}

/**
 * Fire all enabled automation rules matching a trigger type for clients.
 *
 * @param {string} triggerType - The trigger to match (e.g. 'new_client', 'client_phase_change')
 * @param {Object} client - Client data (camelCase from the app)
 * @param {Object} [triggerContext={}] - Event-specific context data (e.g. { task_id, to_phase })
 */
export async function fireClientEventTriggers(triggerType, client, triggerContext = {}) {
  if (!isSupabaseConfigured()) return;

  try {
    // Fetch enabled rules matching this trigger type for client entity
    const { data: rules, error } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('trigger_type', triggerType)
      .eq('entity_type', 'client')
      .eq('enabled', true);

    if (error || !rules || rules.length === 0) return;

    // Get auth session for Edge Function call
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    // Map camelCase app fields to snake_case for the Edge Function
    const clientPayload = {
      id: client.id,
      first_name: client.firstName || '',
      last_name: client.lastName || '',
      phone: client.phone || '',
      email: client.email || '',
      phase: getClientPhase(client) || 'new_lead',
    };

    // Fire each rule (fire-and-forget, never blocks UI)
    for (const rule of rules) {
      // Client-side condition check before firing
      if (!evaluateConditions(rule, client, triggerContext)) continue;

      supabase.functions.invoke('execute-automation', {
        body: {
          rule_id: rule.id,
          caregiver_id: client.id,
          entity_type: 'client',
          action_type: rule.action_type,
          message_template: rule.message_template,
          action_config: rule.action_config,
          rule_name: rule.name,
          caregiver: clientPayload,
          trigger_context: triggerContext,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch((err) => console.warn('Client automation fire error:', err));
    }
  } catch (err) {
    // Never block the main flow — automations are best-effort
    console.warn('fireClientEventTriggers error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// Sequence Runner — Enrollment-Based
//
// When a client enters a phase, fetch matching sequences and:
//   • Create an enrollment record in client_sequence_enrollments
//   • Steps with delay_hours === 0 → execute immediately (first-touch)
//   • Steps with delay_hours > 0  → enqueue for cron pickup
//
// The enrollment record tracks progress. The cron checks for
// client responses before executing each delayed step.
// ═══════════════════════════════════════════════════════════════

/**
 * Fire matching client sequences when a client enters a phase.
 * Called from addClient (phase = new_lead) and updatePhase.
 *
 * @param {Object} client - Client data (camelCase from the app)
 */
export async function fireClientSequences(client) {
  if (!isSupabaseConfigured()) return;

  try {
    const phase = getClientPhase(client) || 'new_lead';

    // Fetch enabled sequences that trigger on this phase
    const { data: sequences, error: seqError } = await supabase
      .from('client_sequences')
      .select('*')
      .eq('trigger_phase', phase)
      .eq('enabled', true);

    if (seqError || !sequences || sequences.length === 0) return;

    // Get auth session for Edge Function calls
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const clientPayload = {
      id: client.id,
      first_name: client.firstName || '',
      last_name: client.lastName || '',
      phone: client.phone || '',
      email: client.email || '',
      phase,
    };

    for (const sequence of sequences) {
      const steps = sequence.steps || [];
      if (steps.length === 0) continue;

      // Check for existing active enrollment in the NEW enrollments table
      const { data: existing } = await supabase
        .from('client_sequence_enrollments')
        .select('id, status')
        .eq('sequence_id', sequence.id)
        .eq('client_id', client.id)
        .eq('status', 'active')
        .limit(1);

      if (!shouldAutoEnroll(existing || [])) {
        // Already enrolled — add note and skip
        const currentNotes = Array.isArray(client.notes) ? client.notes : [];
        supabase
          .from('clients')
          .update({
            notes: [...currentNotes, {
              text: `Client re-entered ${phase} but is already active in "${sequence.name}" — skipping auto-enrollment.`,
              type: 'auto',
              timestamp: Date.now(),
              author: 'System',
            }],
          })
          .eq('id', client.id)
          .then(() => {})
          .catch(() => {});
        continue;
      }

      // Create enrollment record
      const enrollmentRecord = buildEnrollmentRecord(client.id, sequence.id, 'system');

      const { data: enrollment, error: enrollError } = await supabase
        .from('client_sequence_enrollments')
        .insert(enrollmentRecord)
        .select('id')
        .single();

      if (enrollError) {
        console.warn('Enrollment insert error:', enrollError);
        continue;
      }

      // Execute step 0 immediately if delay_hours === 0 (instant first-touch)
      const firstStep = steps[0];
      if ((firstStep.delay_hours || 0) === 0) {
        const actionType = normalizeSequenceAction(firstStep.action_type);
        const resolvedTemplate = resolveClientMergeFields(firstStep.template || '', client);

        if (actionType === 'send_sms' || actionType === 'send_email') {
          supabase.functions.invoke('execute-automation', {
            body: {
              rule_id: `seq_${sequence.id}_step_0`,
              caregiver_id: client.id,
              entity_type: 'client',
              action_type: actionType,
              message_template: resolvedTemplate,
              action_config: actionType === 'send_email'
                ? { subject: resolveClientMergeFields(firstStep.subject || 'Message from Tremendous Care', client) }
                : {},
              rule_name: `${sequence.name} - Step 1`,
              caregiver: clientPayload,
            },
            headers: { Authorization: `Bearer ${session.access_token}` },
          }).catch((err) => console.warn('Sequence step 0 fire error:', err));
        } else if (actionType === 'create_task') {
          const currentNotes = Array.isArray(client.notes) ? client.notes : [];
          supabase
            .from('clients')
            .update({
              notes: [...currentNotes, {
                text: resolvedTemplate,
                type: 'task',
                timestamp: Date.now(),
                author: 'Automation',
                outcome: `Sequence: ${sequence.name}, Step 1`,
              }],
            })
            .eq('id', client.id)
            .then(() => {})
            .catch((err) => console.warn('Sequence task note error:', err));
        }

        // Log step 0 as executed
        const nowMs = Date.now();
        supabase
          .from('client_sequence_log')
          .insert({
            sequence_id: sequence.id,
            client_id: client.id,
            step_index: 0,
            action_type: actionType,
            status: 'executed',
            scheduled_at: nowMs,
            executed_at: nowMs,
          })
          .then(() => {})
          .catch((err) => console.warn('Sequence log insert error:', err));

        // Advance enrollment to step 1
        supabase
          .from('client_sequence_enrollments')
          .update({
            current_step: 1,
            last_step_executed_at: new Date().toISOString(),
          })
          .eq('id', enrollment.id)
          .then(() => {})
          .catch(() => {});

        // If sequence only has 1 step, mark completed
        if (steps.length === 1) {
          supabase
            .from('client_sequence_enrollments')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', enrollment.id)
            .then(() => {})
            .catch(() => {});
        }
      }

      // Enqueue remaining delayed steps to client_sequence_log
      const startIdx = (firstStep.delay_hours || 0) === 0 ? 1 : 0;
      const baseTime = Date.now();
      for (let i = startIdx; i < steps.length; i++) {
        const step = steps[i];
        const scheduledAt = baseTime + ((step.delay_hours || 0) * 60 * 60 * 1000);
        supabase
          .from('client_sequence_log')
          .insert({
            sequence_id: sequence.id,
            client_id: client.id,
            step_index: i,
            action_type: normalizeSequenceAction(step.action_type),
            status: 'pending',
            scheduled_at: scheduledAt,
          })
          .then(() => {})
          .catch((err) => console.warn('Sequence log enqueue error:', err));
      }
    }
  } catch (err) {
    console.warn('fireClientSequences error:', err);
  }
}

