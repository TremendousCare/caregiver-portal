import { supabase, isSupabaseConfigured } from './supabase';

// ═══════════════════════════════════════════════════════════════
// Automation Event Triggers
//
// Fires matching automation rules when events occur (e.g. new
// caregiver added). This is fire-and-forget — it never blocks
// the UI or shows errors to the user. All failures are logged
// in the automation_log table.
// ═══════════════════════════════════════════════════════════════

/**
 * Fire all enabled automation rules matching a trigger type.
 *
 * @param {string} triggerType - The trigger to match (e.g. 'new_caregiver')
 * @param {Object} caregiver - Caregiver data (camelCase from the app)
 */
export async function fireEventTriggers(triggerType, caregiver) {
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
      phase: caregiver.phase || 'intake',
    };

    // Fire each rule (fire-and-forget, never blocks UI)
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
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch((err) => console.warn('Automation fire error:', err));
    }
  } catch (err) {
    // Never block the main flow — automations are best-effort
    console.warn('fireEventTriggers error:', err);
  }
}
