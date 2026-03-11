import { supabase, isSupabaseConfigured } from './supabase';
import { getCurrentPhase } from './utils';
import { evaluateAutomationConditions } from '../../supabase/functions/_shared/helpers/automations.ts';

// ═══════════════════════════════════════════════════════════════
// Automation Event Triggers
//
// Fires matching automation rules when events occur (e.g. new
// caregiver added, phase changed, task completed). This is
// fire-and-forget — it never blocks the UI or shows errors to
// the user. All failures are logged in the automation_log table.
//
// Condition evaluation extracted to _shared/helpers/automations.ts
// (Phase 4). This file wraps it for caregiver-specific usage.
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate whether a rule's conditions match the current caregiver + trigger context.
 * Returns true if the rule should fire, false if it should be skipped.
 * Delegates to shared evaluateAutomationConditions with caregiver phase.
 */
function evaluateConditions(rule, caregiver, triggerContext) {
  return evaluateAutomationConditions(
    rule.conditions || {},
    getCurrentPhase(caregiver),
    triggerContext,
  );
}

/**
 * Fire all enabled automation rules matching a trigger type.
 *
 * @param {string} triggerType - The trigger to match (e.g. 'new_caregiver', 'phase_change')
 * @param {Object} caregiver - Caregiver data (camelCase from the app)
 * @param {Object} [triggerContext={}] - Event-specific context data (e.g. { task_id, to_phase })
 */
export async function fireEventTriggers(triggerType, caregiver, triggerContext = {}) {
  if (!isSupabaseConfigured()) return;

  try {
    // Fetch enabled rules matching this trigger type
    const { data: rules, error } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('trigger_type', triggerType)
      .eq('enabled', true);

    if (error || !rules || rules.length === 0) return;

    // Get auth session for Edge Function call
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    // Map camelCase app fields to snake_case for the Edge Function
    const cgPayload = {
      id: caregiver.id,
      first_name: caregiver.firstName || '',
      last_name: caregiver.lastName || '',
      phone: caregiver.phone || '',
      email: caregiver.email || '',
      phase: getCurrentPhase(caregiver) || 'intake',
    };

    // Fire each rule (fire-and-forget, never blocks UI)
    for (const rule of rules) {
      // Client-side condition check before firing
      if (!evaluateConditions(rule, caregiver, triggerContext)) continue;

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
      }).catch((err) => console.warn('Automation fire error:', err));
    }
  } catch (err) {
    // Never block the main flow — automations are best-effort
    console.warn('fireEventTriggers error:', err);
  }
}
