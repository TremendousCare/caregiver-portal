// ─── Outcome Tracking: Action Logging & Outcome Detection ───
// Logs side-effect actions and correlates inbound events to detect outcomes.
// Errors are logged but never thrown to avoid blocking the main response path.

// Default expiry windows per action type (days)
const EXPIRY_DAYS: Record<string, number> = {
  sms_sent: 7,
  email_sent: 7,
  docusign_sent: 14,
  phase_changed: 14,
  calendar_event_created: 21,
  task_completed: 7,
};

// Side-effect tools that should be tracked
const TRACKABLE_ACTIONS = new Set([
  "sms_sent",
  "email_sent",
  "docusign_sent",
  "phase_changed",
  "calendar_event_created",
  "task_completed",
]);

/**
 * Log a side-effect action for outcome tracking.
 * Called after tool execution in the post-conversation phase.
 */
export async function logAction(
  supabase: any,
  actionType: string,
  entityType: "caregiver" | "client",
  entityId: string,
  actor: string,
  actionContext: Record<string, any> = {},
  source: "ai_chat" | "automation" | "manual" = "ai_chat",
): Promise<void> {
  if (!TRACKABLE_ACTIONS.has(actionType)) return;

  try {
    const expiryDays = EXPIRY_DAYS[actionType] || 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    const { error } = await supabase.from("action_outcomes").insert({
      action_type: actionType,
      entity_type: entityType,
      entity_id: entityId,
      actor,
      action_context: actionContext,
      source,
      expires_at: expiresAt.toISOString(),
    });
    if (error) {
      console.error(`[outcomes] Failed to log action ${actionType}:`, error);
    }
  } catch (err) {
    console.error(`[outcomes] Failed to log action ${actionType}:`, err);
  }
}

/**
 * Try to detect an outcome for a pending action based on an inbound event.
 * Called when inbound events arrive (SMS received, DocuSign completed, etc.).
 * Matches the most recent pending action for the same entity.
 */
export async function detectOutcome(
  supabase: any,
  triggerEventType: string,
  entityType: "caregiver" | "client",
  entityId: string,
  eventPayload: Record<string, any> = {},
): Promise<void> {
  try {
    // Only map genuinely inbound/external events to prior outbound actions
    const actionType = eventToActionMap(triggerEventType);
    if (!actionType) return;

    // Find the most recent pending action for this entity
    const { data: pendingAction, error } = await supabase
      .from("action_outcomes")
      .select("*")
      .eq("action_type", actionType)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .is("outcome_type", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !pendingAction) return;

    // Calculate time delta
    const actionTime = new Date(pendingAction.created_at).getTime();
    const now = Date.now();
    const hoursElapsed =
      Math.round(((now - actionTime) / (1000 * 60 * 60)) * 10) / 10;

    // Determine outcome type and detail
    const { outcomeType, outcomeDetail } = buildOutcome(
      triggerEventType,
      eventPayload,
      pendingAction.action_context,
    );

    // Update the action with the detected outcome
    const { error: updateErr } = await supabase
      .from("action_outcomes")
      .update({
        outcome_type: outcomeType,
        outcome_detail: {
          ...outcomeDetail,
          hours_to_outcome: hoursElapsed,
          trigger_event: triggerEventType,
        },
        outcome_detected_at: new Date().toISOString(),
      })
      .eq("id", pendingAction.id);

    if (updateErr) {
      console.error(`[outcomes] Failed to update outcome for ${triggerEventType}:`, updateErr);
    }
  } catch (err) {
    console.error(
      `[outcomes] Failed to detect outcome for ${triggerEventType}:`,
      err,
    );
  }
}

/**
 * Map inbound event types to the action types they could be outcomes for.
 * Only genuinely inbound/external events are mapped here.
 */
function eventToActionMap(eventType: string): string | null {
  const map: Record<string, string> = {
    sms_received: "sms_sent",
    email_received: "email_sent",
    docusign_completed: "docusign_sent",
  };
  return map[eventType] || null;
}

/**
 * Build the outcome type and detail from the trigger event.
 * Only handles event types that eventToActionMap actually produces.
 */
function buildOutcome(
  triggerEventType: string,
  eventPayload: Record<string, any>,
  actionContext: Record<string, any>,
): { outcomeType: string; outcomeDetail: Record<string, any> } {
  switch (triggerEventType) {
    case "sms_received":
      return {
        outcomeType: "response_received",
        outcomeDetail: {
          channel: "sms",
          response_preview: eventPayload.message_text
            ? String(eventPayload.message_text).slice(0, 200)
            : null,
        },
      };

    case "email_received":
      return {
        outcomeType: "response_received",
        outcomeDetail: {
          channel: "email",
          subject: eventPayload.subject || null,
        },
      };

    case "docusign_completed":
      return {
        outcomeType: "completed",
        outcomeDetail: {
          envelope_id:
            eventPayload.envelope_id || actionContext.envelope_id,
        },
      };

    default:
      return {
        outcomeType: "completed",
        outcomeDetail: {},
      };
  }
}
