import { supabase, isSupabaseConfigured } from './supabase';
import { getCurrentPhase } from './utils';

// ═══════════════════════════════════════════════════════════════
// Automation Event Triggers
//
// Fires matching automation rules when events occur (e.g. new
// caregiver added, phase changed, task completed). This is
// fire-and-forget — it never blocks the UI or shows errors to
// the user. All failures are logged in the automation_log table.
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate whether a rule's conditions match the current caregiver + trigger context.
 * Returns true if the rule should fire, false if it should be skipped.
 */
function evaluateConditions(rule, caregiver, triggerContext) {
  const conds = rule.conditions || {};

  // Phase filter: only fire if caregiver is currently in a specific phase
  if (conds.phase && getCurrentPhase(caregiver) !== conds.phase) return false;

  // For phase_change trigger: match target phase
  if (conds.to_phase && triggerContext.to_phase !== conds.to_phase) return false;

  // For task_completed trigger: match specific task ID
  if (conds.task_id && triggerContext.task_id !== conds.task_id) return false;

  // For document_uploaded trigger: match specific document type
  if (conds.document_type && triggerContext.document_type !== conds.document_type) return false;

  // For document_signed trigger: match template name (case-insensitive partial match)
  if (conds.template_name) {
    const templateNames = triggerContext.template_names || [];
    const filter = conds.template_name.toLowerCase();
    const hasMatch = templateNames.some(n => n && n.toLowerCase().includes(filter));
    if (!hasMatch) return false;
  }

  // For inbound_sms trigger: match keyword in message text (case-insensitive)
  if (conds.keyword) {
    const messageText = (triggerContext.message_text || '').toLowerCase();
    if (!messageText.includes(conds.keyword.toLowerCase())) return false;
  }

  // For days_inactive: condition is evaluated server-side by automation-cron, skip here
  // (days_inactive rules are triggered by cron, not by client events)

  return true;
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
