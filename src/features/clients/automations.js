import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { getClientPhase } from './utils';

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
// Sequence Runner — Immediate Execution
//
// When a client enters a phase, fetch matching sequences and:
//   • Steps with delay_hours === 0 → execute immediately
//   • Steps with delay_hours > 0  → enqueue for cron pickup
//
// This gives instant first-touch (SMS/email on form submit)
// while preserving drip-campaign functionality for later steps.
// ═══════════════════════════════════════════════════════════════

/**
 * Simple merge field substitution for client templates.
 */
function resolveClientMergeFields(template, client) {
  return template
    .replace(/\{\{first_name\}\}/g, client.firstName || '')
    .replace(/\{\{last_name\}\}/g, client.lastName || '')
    .replace(/\{\{phone\}\}/g, client.phone || '')
    .replace(/\{\{email\}\}/g, client.email || '');
}

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

    // Map camelCase → snake_case for execute-automation
    const clientPayload = {
      id: client.id,
      first_name: client.firstName || '',
      last_name: client.lastName || '',
      phone: client.phone || '',
      email: client.email || '',
      phase,
    };

    const nowMs = Date.now();

    for (const sequence of sequences) {
      const steps = sequence.steps || [];
      if (steps.length === 0) continue;

      // Check if this client is already enrolled in this sequence
      const { data: existingLogs } = await supabase
        .from('client_sequence_log')
        .select('id')
        .eq('sequence_id', sequence.id)
        .eq('client_id', client.id)
        .limit(1);

      if (existingLogs && existingLogs.length > 0) continue; // Already enrolled

      // Process each step
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const delayHours = step.delay_hours || 0;

        if (delayHours === 0) {
          // ── Immediate execution ──
          const actionType = normalizeSequenceAction(step.action_type);
          const resolvedTemplate = resolveClientMergeFields(step.template || '', client);

          if (actionType === 'send_sms' || actionType === 'send_email') {
            // Fire via execute-automation (handles SMS/email sending + auto-notes)
            const body = {
              rule_id: `seq_${sequence.id}_step_${i}`,
              caregiver_id: client.id,
              entity_type: 'client',
              action_type: actionType,
              message_template: resolvedTemplate,
              action_config: actionType === 'send_email'
                ? { subject: resolveClientMergeFields(step.subject || 'Message from Tremendous Care', client) }
                : {},
              rule_name: `${sequence.name} - Step ${i + 1}`,
              caregiver: clientPayload,
            };

            supabase.functions.invoke('execute-automation', {
              body,
              headers: { Authorization: `Bearer ${session.access_token}` },
            }).catch((err) => console.warn(`Sequence step ${i} fire error:`, err));
          } else if (actionType === 'create_task') {
            // Add task note directly to client
            const currentNotes = Array.isArray(client.notes) ? client.notes : [];
            const taskNote = {
              text: resolvedTemplate,
              type: 'task',
              timestamp: nowMs,
              author: 'Automation',
              outcome: `Sequence: ${sequence.name}, Step ${i + 1}`,
            };
            supabase
              .from('clients')
              .update({ notes: [...currentNotes, taskNote] })
              .eq('id', client.id)
              .then(() => {})
              .catch((err) => console.warn(`Sequence task note error:`, err));
          }

          // Log as executed
          supabase
            .from('client_sequence_log')
            .insert({
              sequence_id: sequence.id,
              client_id: client.id,
              step_index: i,
              action_type: actionType,
              status: 'executed',
              scheduled_at: nowMs,
              executed_at: nowMs,
            })
            .then(() => {})
            .catch((err) => console.warn('Sequence log insert error:', err));

        } else {
          // ── Delayed step → enqueue for cron ──
          const scheduledAt = nowMs + (delayHours * 60 * 60 * 1000);
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
    }
  } catch (err) {
    console.warn('fireClientSequences error:', err);
  }
}

/** Normalize action_type from sequence steps */
function normalizeSequenceAction(actionType) {
  switch (actionType) {
    case 'send_sms': case 'sms': return 'send_sms';
    case 'send_email': case 'email': return 'send_email';
    case 'create_task': case 'task': return 'create_task';
    default: return actionType;
  }
}
