// --- Shared Automation Utilities ---
// Pure functions for automation condition evaluation, merge field
// resolution, and action type normalization.
// No DB calls, no side effects.
//
// Ported from src/lib/automations.js, src/features/clients/automations.js,
// and supabase/functions/automation-cron/index.ts (Phase 4 extraction).

// --- Automation Condition Evaluation ---
// Unified version handling all condition types from both caregiver and client
// automation files. The caller provides the current phase via entityPhase param.

export function evaluateAutomationConditions(
  conditions: Record<string, any>,
  entityPhase: string,
  triggerContext: Record<string, any>,
): boolean {
  const conds = conditions || {};

  // Phase filter: only fire if entity is currently in a specific phase
  if (conds.phase && entityPhase !== conds.phase) return false;

  // For phase_change trigger: match target phase
  if (conds.to_phase && triggerContext.to_phase !== conds.to_phase) return false;

  // For task_completed trigger: match specific task ID
  if (conds.task_id && triggerContext.task_id !== conds.task_id) return false;

  // For document_uploaded trigger: match specific document type
  if (conds.document_type && triggerContext.document_type !== conds.document_type) return false;

  // For document_signed trigger: match template name (case-insensitive partial match)
  if (conds.template_name) {
    const templateNames: string[] = triggerContext.template_names || [];
    const filter = conds.template_name.toLowerCase();
    const hasMatch = templateNames.some((n: string) => n && n.toLowerCase().includes(filter));
    if (!hasMatch) return false;
  }

  // For inbound_sms trigger: match keyword in message text (case-insensitive)
  if (conds.keyword) {
    const messageText = (triggerContext.message_text || "").toLowerCase();
    if (!messageText.includes(conds.keyword.toLowerCase())) return false;
  }

  // For survey_completed trigger: match survey result status
  if (conds.survey_status && triggerContext.survey_status !== conds.survey_status) return false;

  // days_inactive is evaluated server-side by automation-cron, skip here

  return true;
}

// --- Automation Merge Field Resolution ---
// Replaces {{first_name}}, {{last_name}}, {{phone}}, {{email}} in templates
// from the entity (caregiver/client). Replaces shift-context fields
// ({{shift_start_text}}, {{client_full_name}}, etc.) and {{survey_link}}
// from the trigger context. Entity should have snake_case fields
// (first_name, last_name, phone, email).
//
// Shift merge fields are pre-formatted in the dispatcher so the resolver
// stays a pure string-replace. The dispatcher (frontend or cron) is
// responsible for converting ISO timestamps into a human-readable form
// and assembling client_full_name / shift_address.

export function resolveAutomationMergeFields(
  template: string,
  entity: Record<string, any>,
  triggerContext?: Record<string, any>,
): string {
  let result = template
    .replace(/\{\{first_name\}\}/g, entity.first_name || "")
    .replace(/\{\{last_name\}\}/g, entity.last_name || "")
    .replace(/\{\{phone\}\}/g, entity.phone || "")
    .replace(/\{\{email\}\}/g, entity.email || "");

  // Resolve trigger-context merge fields.
  if (triggerContext) {
    const tc = triggerContext;
    result = result
      .replace(/\{\{survey_link\}\}/g, tc.survey_link || "")
      // Shift context — pre-formatted by the dispatcher.
      .replace(/\{\{shift_start_text\}\}/g, tc.shift_start_text || "")
      .replace(/\{\{shift_end_text\}\}/g, tc.shift_end_text || "")
      .replace(/\{\{shift_address\}\}/g, tc.shift_address || "")
      .replace(/\{\{client_first_name\}\}/g, tc.client_first_name || "")
      .replace(/\{\{client_last_name\}\}/g, tc.client_last_name || "")
      .replace(/\{\{client_full_name\}\}/g, tc.client_full_name || "");
  }

  return result;
}

// --- Action Type Normalization ---
// Maps shorthand aliases to canonical action types.

export function normalizeActionType(actionType: string): string {
  switch (actionType) {
    case "send_sms":    return "send_sms";
    case "sms":         return "send_sms";
    case "send_email":  return "send_email";
    case "email":       return "send_email";
    case "create_task": return "create_task";
    case "task":        return "create_task";
    default:            return actionType;
  }
}
