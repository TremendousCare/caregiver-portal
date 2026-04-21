import { supabase, isSupabaseConfigured } from './supabase';
import { getCurrentPhase } from './utils';
import { evaluateAutomationConditions } from '../../supabase/functions/_shared/helpers/automations.ts';
import { generateSurveyToken, buildSurveyUrl } from './surveyUtils';

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

    // Check if any matching rule uses {{survey_link}} and pre-create a survey
    // response with a unique token. Works for any trigger type.
    let surveyLink = '';
    const needsSurvey = rules.some(
      (r) => evaluateConditions(r, caregiver, triggerContext) &&
        r.message_template && r.message_template.includes('{{survey_link}}')
    );
    if (needsSurvey) {
      surveyLink = await createSurveyForCaregiver(caregiver.id);
    }

    // Fire each rule (fire-and-forget, never blocks UI)
    for (const rule of rules) {
      // Client-side condition check before firing
      if (!evaluateConditions(rule, caregiver, triggerContext)) continue;

      // Inject survey_link into trigger context so Edge Function can resolve it
      const ctx = { ...triggerContext };
      if (surveyLink) ctx.survey_link = surveyLink;

      supabase.functions.invoke('execute-automation', {
        body: {
          rule_id: rule.id,
          caregiver_id: caregiver.id,
          action_type: rule.action_type,
          message_template: rule.message_template,
          action_config: rule.action_config,
          rule_name: rule.name,
          caregiver: cgPayload,
          trigger_context: ctx,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch((err) => console.warn('Automation fire error:', err));
    }
  } catch (err) {
    // Never block the main flow — automations are best-effort
    console.warn('fireEventTriggers error:', err);
  }
}

/**
 * Create a survey response for a new caregiver.
 * Finds the first enabled survey template and creates a pending response with a unique token.
 * Returns the full survey URL or empty string if no survey template exists.
 */
async function createSurveyForCaregiver(caregiverId) {
  try {
    // Get the first enabled public survey template. Internal-only
    // templates (e.g. Interview Evaluation) are filled by staff and
    // must never be sent to applicants.
    const { data: templates, error: tErr } = await supabase
      .from('survey_templates')
      .select('id, expires_hours')
      .eq('enabled', true)
      .or('internal_only.is.null,internal_only.eq.false')
      .order('created_at', { ascending: true })
      .limit(1);

    if (tErr || !templates || templates.length === 0) return '';

    const template = templates[0];
    const token = generateSurveyToken();
    const expiresAt = new Date(Date.now() + (template.expires_hours || 48) * 60 * 60 * 1000).toISOString();

    const { error: insertErr } = await supabase
      .from('survey_responses')
      .insert({
        survey_template_id: template.id,
        caregiver_id: caregiverId,
        token,
        status: 'pending',
        sent_via: 'sms',
        expires_at: expiresAt,
      });

    if (insertErr) {
      console.warn('Failed to create survey response:', insertErr);
      return '';
    }

    return buildSurveyUrl(token);
  } catch (err) {
    console.warn('createSurveyForCaregiver error:', err);
    return '';
  }
}
