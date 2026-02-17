import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { getClientPhase } from './utils';

// ═══════════════════════════════════════════════════════════════
// Client Automation Event Triggers
//
// Fires matching automation rules when client events occur (e.g.
// new client added, phase changed, task completed). This is
// fire-and-forget — it never blocks the UI or shows errors to
// the user. All failures are logged in the automation_log table.
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
