// Phase 1.5 follow-up — operator-action-to-agent-action loop closure.
//
// Frontend caller for the `close-pending-suggestion` edge function.
// When an operator performs an action through a regular UI surface
// (SMS compose, email compose, scheduling, phase change, task
// complete, note add), call this helper immediately after the
// underlying action lands so any matching `ai_suggestion` row gets
// closed and an `agent_actions` row with `phase='executed'` lands in
// the audit chain. That row is the positive signal the autonomy v2
// algorithm reads when evaluating per-(agent × action) promotion.
//
// Contract: this helper NEVER throws. A failed close write does not
// affect the operator's primary action — the SMS / email / etc has
// already shipped. The autonomy algorithm simply misses one positive
// signal; the next operator action closes the next suggestion.
//
// Callers should still `.catch()` if they want to log; the helper
// resolves to `{ closed: false, error: ... }` on failure rather than
// rejecting, so a missing `.catch()` won't surface unhandled
// rejections.

import { supabase } from './supabase';

const CLOSEABLE_ACTION_TYPES = new Set([
  'send_sms',
  'send_email',
  'add_note',
  'complete_task',
  'update_phase',
  'create_calendar_event',
  'send_docusign_envelope',
]);

/**
 * Close any pending ai_suggestions row matching (entity_type,
 * entity_id, action_type) and write the corresponding agent_actions
 * audit row. Returns the edge function's status object, or a benign
 * `{ closed: false, error }` shape if the call itself fails.
 *
 * @param {{
 *   entityType: 'caregiver' | 'client',
 *   entityId:   string,
 *   actionType: string,
 *   params?:    Record<string, unknown>,
 * }} input
 */
export async function closePendingSuggestionForAction({
  entityType,
  entityId,
  actionType,
  params = {},
}) {
  if (entityType !== 'caregiver' && entityType !== 'client') {
    return { closed: false, error: 'invalid entityType', skipped: true };
  }
  if (!entityId || typeof entityId !== 'string') {
    return { closed: false, error: 'invalid entityId', skipped: true };
  }
  if (!CLOSEABLE_ACTION_TYPES.has(actionType)) {
    return { closed: false, error: 'actionType not in closeable allowlist', skipped: true };
  }

  try {
    const { data, error } = await supabase.functions.invoke('close-pending-suggestion', {
      body: {
        entity_type: entityType,
        entity_id:   entityId,
        action_type: actionType,
        params,
      },
    });
    if (error) {
      return { closed: false, error: error.message || String(error) };
    }
    return data || { closed: false, error: 'empty edge response' };
  } catch (err) {
    return { closed: false, error: err?.message || String(err) };
  }
}
