// ─── Inbound Message Routing Operations ───
// Shared logic for message classification, autonomy level management,
// and suggestion execution. Used by message-router cron and ai-chat tools.

import type { OperationResult } from "./types.ts";

// ─── Types ───

export interface ClassificationResult {
  intent: string;
  confidence: number;
  suggested_action: string;
  suggested_params: Record<string, any>;
  drafted_response: string;
  reasoning: string;
}

export interface AutonomyConfig {
  id: string;
  action_type: string;
  entity_type: string;
  context: string;
  autonomy_level: string;
  consecutive_approvals: number;
  total_approvals: number;
  total_rejections: number;
  auto_promote_threshold: number;
  auto_demote_on_reject: boolean;
  max_autonomy_level: string;
}

export interface EntityContext {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  entity_type: string;
  phase: string;
  recent_notes: Array<{ text: string; type: string; timestamp: number; author: string; direction?: string }>;
  incomplete_tasks: string[];
  // Enrichment fields (all optional — failures silently skipped)
  business_context?: string;
  conversation_history?: Array<{ direction: string; text: string; timestamp: number }>;
  calendar_summary?: string;
  task_labels?: Record<string, string>;
  recent_events?: Array<{ event_type: string; created_at: string }>;
}

// ─── Outcome Recording Constants ───

/** Maps suggestion action_type → action_outcomes.action_type + expiry window */
const OUTCOME_ACTION_MAP: Record<string, { outcomeType: string; expiryDays: number | null }> = {
  send_sms: { outcomeType: "sms_sent", expiryDays: 7 },
  send_email: { outcomeType: "email_sent", expiryDays: 7 },
  send_docusign_envelope: { outcomeType: "docusign_sent", expiryDays: 14 },
  send_esign_envelope: { outcomeType: "esign_sent", expiryDays: 14 },
  create_calendar_event: { outcomeType: "calendar_event_created", expiryDays: 21 },
  update_phase: { outcomeType: "phase_changed", expiryDays: null },
  update_client_phase: { outcomeType: "phase_changed", expiryDays: null },
  complete_task: { outcomeType: "task_completed", expiryDays: null },
  complete_client_task: { outcomeType: "task_completed", expiryDays: null },
};

/** Derive action_outcomes.source from executedBy identifier */
function deriveOutcomeSource(executedBy: string): string {
  if (executedBy.startsWith("system:")) return "automation";
  if (executedBy.startsWith("user:")) return "manual";
  return "ai_chat";
}

// ─── Constants ───

const VALID_INTENTS = [
  "question",
  "document_submission",
  "scheduling_request",
  "general_response",
  "confirmation",
  "opt_out",
  "unknown",
] as const;

const LEVEL_ORDER: Record<string, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

const PROMOTION_MAP: Record<string, string> = {
  L1: "L2",
  L2: "L3",
  L3: "L4",
};

const DEMOTION_MAP: Record<string, string> = {
  L4: "L3",
  L3: "L2",
  L2: "L1",
};

// Valid actions the classifier can suggest (matches executeSuggestion switch cases)
const VALID_ACTIONS = [
  "send_sms",
  "send_email",
  "add_note",
  "add_client_note",
  "update_phase",
  "update_client_phase",
  "complete_task",
  "complete_client_task",
  "update_caregiver_field",
  "update_client_field",
  "update_board_status",
  "create_calendar_event",
  "send_docusign_envelope",
  "send_esign_envelope",
  "none",
] as const;

// Max batch size per invocation (cost control)
export const MAX_BATCH_SIZE = 10;

// ─── Classifier ───

const CLASSIFIER_SYSTEM_PROMPT = `You are a message classifier for a home care staffing agency called Tremendous Care.
Given an inbound message from a caregiver or client, classify the intent and suggest the best action.

## Intent Classification
- "confirmation" — simple yes, ok, sure, got it
- "document_submission" — mentions documents, forms, uploads, signatures
- "scheduling_request" — asks about schedule, availability, times, interviews
- "general_response" — thanks, acknowledgements, casual replies
- "question" — needs an answer or information
- "opt_out" — stop, unsubscribe, opt out
- "unknown" — cannot determine intent

## Available Actions
Choose the BEST action for the situation. Use "none" if no action is appropriate.

| Action | When to Use | Required Params |
|--------|------------|-----------------|
| send_sms | Reply to SMS message | message (the reply text) |
| send_email | Reply via email or follow up formally | to_email, subject, body |
| add_note | Log important info from the message | text |
| complete_task | Message confirms a task is done (e.g., "I got my TB test") | task_id (from pending tasks list) |
| update_phase | Message indicates readiness for next phase | new_phase, reason |
| create_calendar_event | Message requests scheduling | title, date, start_time, end_time |
| update_board_status | Message indicates board column change needed | new_status |
| none | No action needed, or just observe | (none) |

## Rules
- Be warm and professional in drafted responses. Use first names.
- Use business context and calendar info to give specific, actionable answers.
- NEVER use [DATE/TIME] or [PLACEHOLDER] brackets — if info is missing, say you'll check and get back to them.
- If intent is "opt_out", do NOT suggest any action — set action to "none".
- For SMS channels, keep drafted_response under 160 chars.
- For email channels, drafted_response can be longer and more formal.
- Only suggest complete_task if the message clearly confirms task completion AND the task_id matches a pending task.
- Only suggest update_phase if the message strongly indicates phase advancement.
- Only suggest create_calendar_event if there's enough info to create a real event (or you can infer from calendar context).
- Prefer send_sms for quick replies, send_email for formal follow-ups.
- You can suggest add_note as a secondary action alongside a reply — use suggested_params to pass the note text.
- When in doubt, default to send_sms with a helpful reply, or "none" if no response is needed.

Respond with JSON only, no other text.`;

/**
 * Classify an inbound message using Claude Haiku.
 * Returns structured classification or null on failure.
 */
export async function classifyMessage(
  entityContext: EntityContext,
  messageText: string,
  channel: string,
): Promise<ClassificationResult | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set for classifier");
    return null;
  }

  // Build entity context summary (token-efficient)
  const recentNotesSummary = entityContext.recent_notes
    .slice(0, 5)
    .map((n) => `[${n.type}] ${n.text.slice(0, 120)}`)
    .join("\n");

  // Build tasks with human-readable labels if available
  let tasksSummary: string;
  if (entityContext.incomplete_tasks.length === 0) {
    tasksSummary = "none";
  } else if (entityContext.task_labels && Object.keys(entityContext.task_labels).length > 0) {
    tasksSummary = entityContext.incomplete_tasks
      .slice(0, 5)
      .map((id) => entityContext.task_labels![id] || id)
      .join(", ");
  } else {
    tasksSummary = entityContext.incomplete_tasks.slice(0, 5).join(", ");
  }

  // Build enrichment sections (each conditional, capped)
  const sections: string[] = [];

  // Business context
  if (entityContext.business_context) {
    sections.push(`Business context:\n${entityContext.business_context.slice(0, 1600)}`);
  }

  // Conversation history (SMS thread)
  if (entityContext.conversation_history && entityContext.conversation_history.length > 0) {
    const convoLines = entityContext.conversation_history
      .map((m) => `${m.direction === "inbound" ? "Them" : "Us"}: ${m.text}`)
      .join("\n");
    sections.push(`Recent conversation:\n${convoLines}`);
  }

  // Calendar summary
  if (entityContext.calendar_summary) {
    sections.push(`Upcoming calendar (next 7 days):\n${entityContext.calendar_summary.slice(0, 800)}`);
  }

  // Recent events
  if (entityContext.recent_events && entityContext.recent_events.length > 0) {
    const eventLines = entityContext.recent_events
      .map((e) => `${e.event_type} at ${e.created_at}`)
      .join(", ");
    sections.push(`Recent events: ${eventLines}`);
  }

  const enrichmentBlock = sections.length > 0 ? "\n" + sections.join("\n\n") + "\n" : "";

  const userMessage = `Entity: ${entityContext.first_name} ${entityContext.last_name} (${entityContext.phase}) — ${entityContext.entity_type}
Channel: ${channel}
Phone: ${entityContext.phone || "none"}
Email: ${entityContext.email || "none"}
Recent activity:
${recentNotesSummary || "No recent notes"}
Pending tasks: ${tasksSummary}
${enrichmentBlock}
Inbound message: "${messageText}"

Respond with JSON:
{"intent": "question|document_submission|scheduling_request|general_response|confirmation|opt_out|unknown", "confidence": 0.0-1.0, "suggested_action": "send_sms|send_email|add_note|complete_task|update_phase|create_calendar_event|update_board_status|none", "suggested_params": {"key": "value"}, "drafted_response": "the response text or empty string", "reasoning": "brief explanation"}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Classifier API error (${response.status}):`, errText);
      return null;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // Parse JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Classifier returned non-JSON:", text);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and normalize
    const validAction = VALID_ACTIONS.includes(parsed.suggested_action)
      ? parsed.suggested_action
      : "none";

    return {
      intent: VALID_INTENTS.includes(parsed.intent) ? parsed.intent : "unknown",
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      suggested_action: validAction,
      suggested_params: (parsed.suggested_params && typeof parsed.suggested_params === "object")
        ? parsed.suggested_params
        : {},
      drafted_response: String(parsed.drafted_response || ""),
      reasoning: String(parsed.reasoning || ""),
    };
  } catch (err) {
    console.error("Classifier error:", err);
    return null;
  }
}

// ─── Autonomy Level Lookup ───

/**
 * Look up the autonomy level for a given action type + entity type.
 * Returns the config row or a default L2 config.
 */
export async function lookupAutonomyLevel(
  supabase: any,
  actionType: string,
  entityType: string,
  context: string = "inbound_routing",
): Promise<AutonomyConfig> {
  const { data } = await supabase
    .from("autonomy_config")
    .select("*")
    .eq("action_type", actionType)
    .eq("entity_type", entityType)
    .eq("context", context)
    .single();

  if (data) return data as AutonomyConfig;

  // Default: L2 confirm if no config exists
  return {
    id: "",
    action_type: actionType,
    entity_type: entityType,
    context,
    autonomy_level: "L2",
    consecutive_approvals: 0,
    total_approvals: 0,
    total_rejections: 0,
    auto_promote_threshold: 10,
    auto_demote_on_reject: true,
    max_autonomy_level: "L3",
  };
}

// ─── Autonomy Outcome Recording ───

/**
 * Record an approval or rejection, handle auto-promotion/demotion.
 * Returns the new autonomy level after any changes.
 */
export async function recordAutonomyOutcome(
  supabase: any,
  actionType: string,
  entityType: string,
  context: string,
  approved: boolean,
): Promise<{ newLevel: string; promoted: boolean; demoted: boolean }> {
  const config = await lookupAutonomyLevel(supabase, actionType, entityType, context);

  if (!config.id) {
    // No config row exists — nothing to track
    return { newLevel: config.autonomy_level, promoted: false, demoted: false };
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  let promoted = false;
  let demoted = false;

  if (approved) {
    updates.consecutive_approvals = config.consecutive_approvals + 1;
    updates.total_approvals = config.total_approvals + 1;

    // Check for auto-promotion
    if (
      config.auto_promote_threshold > 0 &&
      updates.consecutive_approvals >= config.auto_promote_threshold
    ) {
      const nextLevel = PROMOTION_MAP[config.autonomy_level];
      const maxLevel = config.max_autonomy_level || "L3";

      if (nextLevel && LEVEL_ORDER[nextLevel] <= LEVEL_ORDER[maxLevel]) {
        updates.autonomy_level = nextLevel;
        updates.consecutive_approvals = 0; // Reset counter after promotion
        promoted = true;
      }
    }
  } else {
    // Rejection: reset consecutive approvals
    updates.consecutive_approvals = 0;
    updates.total_rejections = config.total_rejections + 1;

    // Check for demotion (optional, based on config)
    if (config.auto_demote_on_reject && config.total_rejections > 0) {
      // Demote after 3+ total rejections when current level > L1
      const totalRejections = updates.total_rejections;
      if (totalRejections >= 3 && totalRejections % 3 === 0) {
        const prevLevel = DEMOTION_MAP[config.autonomy_level];
        if (prevLevel) {
          updates.autonomy_level = prevLevel;
          demoted = true;
        }
      }
    }
  }

  await supabase
    .from("autonomy_config")
    .update(updates)
    .eq("id", config.id);

  return {
    newLevel: updates.autonomy_level || config.autonomy_level,
    promoted,
    demoted,
  };
}

// ─── Context Enrichment Helpers ───

/**
 * Fetch business context from app_settings (ai_business_context key).
 * Returns the stored text or empty string on failure.
 */
export async function fetchBusinessContext(supabase: any): Promise<string> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ai_business_context")
      .single();
    if (data?.value && typeof data.value === "string") {
      return data.value;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Extract SMS conversation history from notes array.
 * Returns last N SMS messages in chronological order with direction labels.
 * Pure function — no API call.
 */
export function extractConversationHistory(
  notes: Array<{ text: string; type: string; timestamp: number; direction?: string }>,
  limit: number = 5,
): Array<{ direction: string; text: string; timestamp: number }> {
  return notes
    .filter((n) => n.type === "sms" || n.type === "sms_received" || n.type === "sms_sent")
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)) // chronological
    .slice(-limit)
    .map((n) => ({
      direction: n.direction === "inbound" || n.type === "sms_received" ? "inbound" : "outbound",
      text: (n.text || "").slice(0, 200),
      timestamp: n.timestamp || 0,
    }));
}

/**
 * Fetch calendar events for the next 7 days via outlook-integration Edge Function.
 * Uses a 3-second AbortController timeout to avoid blocking the pipeline.
 * Returns formatted calendar summary or empty string on failure/timeout.
 */
export async function fetchCalendarContext(): Promise<string> {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        action: "get_calendar_events",
        start_date: now.toISOString().split("T")[0],
        end_date: weekFromNow.toISOString().split("T")[0],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return "";
    const data = await response.json();

    if (!data.events || !Array.isArray(data.events) || data.events.length === 0) {
      return "No upcoming calendar events in the next 7 days.";
    }

    // Format events concisely
    const formatted = data.events
      .slice(0, 10) // cap at 10 events
      .map((e: any) => {
        const start = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : "TBD";
        return `${start}: ${(e.subject || "Untitled").slice(0, 60)}`;
      })
      .join("\n");

    return formatted.slice(0, 800);
  } catch {
    return "";
  }
}

/**
 * Resolve task IDs to human-readable labels using phase_tasks from app_data.
 * Returns a map of taskId → label string.
 */
export async function resolveTaskLabels(
  supabase: any,
  taskIds: string[],
): Promise<Record<string, string>> {
  if (taskIds.length === 0) return {};

  try {
    const { data } = await supabase
      .from("app_data")
      .select("value")
      .eq("key", "phase_tasks")
      .single();

    if (!data?.value) return {};

    const phaseTasks = data.value as Record<string, Array<{ id: string; label: string }>>;
    const labelMap: Record<string, string> = {};

    // Build lookup from all phases
    for (const tasks of Object.values(phaseTasks)) {
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) {
        if (task.id && task.label) {
          labelMap[task.id] = task.label;
        }
      }
    }

    // Map requested taskIds to labels
    const result: Record<string, string> = {};
    for (const id of taskIds) {
      result[id] = labelMap[id] || id; // fallback to raw ID
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Fetch recent events from the events table for the entity.
 * Returns last N events in reverse chronological order.
 */
export async function fetchRecentEvents(
  supabase: any,
  entityId: string,
  limit: number = 5,
): Promise<Array<{ event_type: string; created_at: string }>> {
  try {
    const { data } = await supabase
      .from("events")
      .select("event_type, created_at")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(limit);

    return (data || []).map((e: any) => ({
      event_type: e.event_type || "",
      created_at: e.created_at || "",
    }));
  } catch {
    return [];
  }
}

// ─── Entity Context Fetcher ───

/**
 * Fetch entity context for the classifier.
 * Pulls recent notes, current phase, incomplete tasks, and enrichment context.
 */
export async function fetchEntityContext(
  supabase: any,
  entityType: string,
  entityId: string,
): Promise<EntityContext | null> {
  const tableName = entityType === "client" ? "clients" : "caregivers";

  // Caregivers use phase_override + phase_timestamps; clients use phase column
  const selectCols = entityType === "client"
    ? "id, first_name, last_name, phone, email, notes, tasks, phase, phase_timestamps"
    : "id, first_name, last_name, phone, email, notes, tasks, phase_override, phase_timestamps";

  const { data: entity, error } = await supabase
    .from(tableName)
    .select(selectCols)
    .eq("id", entityId)
    .single();

  if (error || !entity) return null;

  // Determine phase
  let phase: string;
  if (entityType === "client") {
    phase = entity.phase || "new_lead";
  } else {
    if (entity.phase_override) {
      phase = entity.phase_override;
    } else {
      const timestamps = (entity.phase_timestamps || {}) as Record<string, number>;
      const phases = ["intake", "interview", "onboarding", "verification", "orientation"];
      phase = "intake";
      let latestTime = 0;
      for (const p of phases) {
        if (timestamps[p] && timestamps[p] > latestTime) {
          phase = p;
          latestTime = timestamps[p];
        }
      }
    }
  }

  // Get recent notes (last 5)
  const allNotes = Array.isArray(entity.notes) ? entity.notes : [];
  const recentNotes = allNotes
    .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 5);

  // Get incomplete tasks
  const tasks = (entity.tasks || {}) as Record<string, any>;
  const incompleteTasks = Object.keys(tasks).filter(
    (k) => !tasks[k]?.completed,
  );

  const context: EntityContext = {
    id: entity.id,
    first_name: entity.first_name || "",
    last_name: entity.last_name || "",
    phone: entity.phone || "",
    email: entity.email || "",
    entity_type: entityType,
    phase,
    recent_notes: recentNotes,
    incomplete_tasks: incompleteTasks,
  };

  // ─── Enrichment (parallel, all optional) ───
  // Pure function — no await needed
  context.conversation_history = extractConversationHistory(allNotes);

  // Async enrichments via Promise.allSettled (failures silently skipped)
  const [bizCtx, calCtx, taskLabels, recentEvts] = await Promise.allSettled([
    fetchBusinessContext(supabase),
    fetchCalendarContext(),
    resolveTaskLabels(supabase, incompleteTasks),
    fetchRecentEvents(supabase, entity.id),
  ]);

  if (bizCtx.status === "fulfilled" && bizCtx.value) {
    context.business_context = bizCtx.value;
  }
  if (calCtx.status === "fulfilled" && calCtx.value) {
    context.calendar_summary = calCtx.value;
  }
  if (taskLabels.status === "fulfilled" && Object.keys(taskLabels.value).length > 0) {
    context.task_labels = taskLabels.value;
  }
  if (recentEvts.status === "fulfilled" && recentEvts.value.length > 0) {
    context.recent_events = recentEvts.value;
  }

  return context;
}

// ─── Suggestion Creation ───

/**
 * Create an ai_suggestions row based on classification results.
 */
export async function createSuggestion(
  supabase: any,
  params: {
    sourceType: string;
    sourceId: string;
    entityType: string;
    entityId: string;
    entityName: string;
    classification: ClassificationResult;
    autonomyLevel: string;
    channel: string;
    tokens?: { input: number; output: number };
  },
): Promise<OperationResult> {
  const { classification } = params;

  // Determine suggestion type
  let suggestionType: string;
  const isReply = (classification.suggested_action === "send_sms" || classification.suggested_action === "send_email")
    && classification.drafted_response;
  if (isReply) {
    suggestionType = "reply";
  } else if (classification.intent === "opt_out") {
    suggestionType = "alert";
  } else if (classification.intent === "unknown") {
    suggestionType = "alert";
  } else {
    suggestionType = classification.suggested_action !== "none" ? "action" : "follow_up";
  }

  // Build title
  const intentLabels: Record<string, string> = {
    question: "asked a question",
    document_submission: "mentioned documents",
    scheduling_request: "asked about scheduling",
    general_response: "replied",
    confirmation: "confirmed",
    opt_out: "requested opt-out",
    unknown: "sent a message",
  };
  const intentLabel = intentLabels[classification.intent] || "sent a message";
  const title = `${params.entityName} ${intentLabel}`;

  // Build action_params from classifier's suggested_params + standard fields
  const actionParams: Record<string, any> = {
    ...classification.suggested_params,
    entity_id: params.entityId,
    entity_type: params.entityType,
  };
  // For communication actions, ensure message/body content is populated
  if (classification.suggested_action === "send_sms" && !actionParams.message) {
    actionParams.message = classification.drafted_response;
  }
  if (classification.suggested_action === "send_email") {
    if (!actionParams.body) actionParams.body = classification.drafted_response;
    if (!actionParams.to_email) actionParams.to_email = params.entityType === "client" ? "" : "";
    // to_email will be resolved from entity record by executeSuggestion if empty
  }
  if ((classification.suggested_action === "add_note" || classification.suggested_action === "add_client_note") && !actionParams.text) {
    actionParams.text = classification.drafted_response || classification.reasoning;
  }

  const { error } = await supabase.from("ai_suggestions").insert({
    source_type: params.sourceType,
    source_id: params.sourceId,
    entity_type: params.entityType,
    entity_id: params.entityId,
    entity_name: params.entityName,
    suggestion_type: suggestionType,
    action_type: classification.suggested_action !== "none" ? classification.suggested_action : null,
    title,
    detail: classification.reasoning,
    drafted_content: classification.drafted_response || null,
    action_params: Object.keys(actionParams).length > 0 ? actionParams : null,
    intent: classification.intent,
    intent_confidence: classification.confidence,
    autonomy_level: params.autonomyLevel,
    status: params.autonomyLevel === "L4" ? "auto_executed"
      : params.autonomyLevel === "L3" ? "auto_executed"
      : "pending",
    input_tokens: params.tokens?.input || null,
    output_tokens: params.tokens?.output || null,
  });

  if (error) {
    console.error("Failed to create suggestion:", error);
    return { success: false, message: "", error: error.message };
  }

  return { success: true, message: `Suggestion created: ${title}` };
}

// ─── Suggestion Execution ───

/**
 * Execute an approved suggestion by dispatching to the appropriate shared operation.
 * This is the universal action executor — used by both inbound message routing
 * and future proactive OODA workflows.
 */
export async function executeSuggestion(
  supabase: any,
  suggestionId: string,
  executedBy: string,
): Promise<OperationResult> {
  // Fetch the suggestion
  const { data: suggestion, error: fetchErr } = await supabase
    .from("ai_suggestions")
    .select("*")
    .eq("id", suggestionId)
    .single();

  if (fetchErr || !suggestion) {
    return { success: false, message: "", error: "Suggestion not found." };
  }

  if (suggestion.status !== "pending" && suggestion.status !== "auto_executed") {
    return { success: false, message: "", error: `Suggestion already ${suggestion.status}.` };
  }

  const params = suggestion.action_params || {};
  const entityId = params.entity_id || suggestion.entity_id;
  const entityType = params.entity_type || suggestion.entity_type || "caregiver";

  let result: OperationResult;

  switch (suggestion.action_type) {
    // ─── SMS ───
    case "send_sms": {
      const { sendSMS } = await import("./sms.ts");
      const { normalizePhoneNumber } = await import("../helpers/phone.ts");

      const tableName = entityType === "client" ? "clients" : "caregivers";
      const { data: entity } = await supabase
        .from(tableName)
        .select("phone")
        .eq("id", entityId)
        .single();

      if (!entity?.phone) {
        result = { success: false, message: "", error: "Entity has no phone number." };
        break;
      }

      const normalized = normalizePhoneNumber(entity.phone);
      if (!normalized) {
        result = { success: false, message: "", error: "Invalid phone number." };
        break;
      }

      result = await sendSMS(
        supabase,
        entityId,
        params.message || suggestion.drafted_content,
        normalized,
        executedBy,
      );
      break;
    }

    // ─── Email ───
    case "send_email": {
      const { sendEmail } = await import("./email.ts");

      if (!params.to_email) {
        // Resolve email from entity if not provided
        const tableName = entityType === "client" ? "clients" : "caregivers";
        const { data: entity } = await supabase
          .from(tableName)
          .select("email, first_name, last_name")
          .eq("id", entityId)
          .single();

        if (!entity?.email) {
          result = { success: false, message: "", error: "Entity has no email address." };
          break;
        }

        result = await sendEmail(
          supabase,
          entityId,
          entity.email,
          `${entity.first_name} ${entity.last_name}`.trim() || null,
          params.subject || "Follow-up from Tremendous Care",
          params.body || suggestion.drafted_content || "",
          params.cc || null,
          executedBy,
        );
      } else {
        result = await sendEmail(
          supabase,
          entityId || null,
          params.to_email,
          params.to_name || null,
          params.subject || "Follow-up from Tremendous Care",
          params.body || suggestion.drafted_content || "",
          params.cc || null,
          executedBy,
        );
      }
      break;
    }

    // ─── Notes ───
    case "add_note": {
      const { appendCaregiverNote } = await import("./notes.ts");
      result = await appendCaregiverNote(
        supabase,
        entityId,
        { text: params.text || suggestion.drafted_content || "", type: params.note_type || "note" },
        executedBy,
      );
      break;
    }

    case "add_client_note": {
      const { appendClientNote } = await import("./notes.ts");
      result = await appendClientNote(
        supabase,
        entityId,
        { text: params.text || suggestion.drafted_content || "", type: params.note_type || "note" },
        executedBy,
      );
      break;
    }

    // ─── Phase Changes ───
    case "update_phase": {
      const { updateCaregiverPhase } = await import("./caregiver.ts");
      if (!params.new_phase) {
        result = { success: false, message: "", error: "Missing new_phase parameter." };
        break;
      }
      result = await updateCaregiverPhase(
        supabase,
        entityId,
        params.new_phase,
        params.reason,
        executedBy,
      );
      break;
    }

    case "update_client_phase": {
      const { updateClientPhase } = await import("./client.ts");
      if (!params.new_phase) {
        result = { success: false, message: "", error: "Missing new_phase parameter." };
        break;
      }
      result = await updateClientPhase(
        supabase,
        entityId,
        params.new_phase,
        params.reason,
        executedBy,
      );
      break;
    }

    // ─── Task Completion ───
    case "complete_task": {
      const { completeCaregiverTask } = await import("./caregiver.ts");
      if (!params.task_id) {
        result = { success: false, message: "", error: "Missing task_id parameter." };
        break;
      }
      result = await completeCaregiverTask(
        supabase,
        entityId,
        params.task_id,
        executedBy,
      );
      break;
    }

    case "complete_client_task": {
      const { completeClientTask } = await import("./client.ts");
      if (!params.task_id) {
        result = { success: false, message: "", error: "Missing task_id parameter." };
        break;
      }
      result = await completeClientTask(
        supabase,
        entityId,
        params.task_id,
        executedBy,
      );
      break;
    }

    // ─── Field Updates ───
    case "update_caregiver_field": {
      const { updateCaregiverField } = await import("./caregiver.ts");
      if (!params.field || params.value === undefined) {
        result = { success: false, message: "", error: "Missing field or value parameter." };
        break;
      }
      result = await updateCaregiverField(
        supabase,
        entityId,
        params.field,
        params.value,
      );
      break;
    }

    case "update_client_field": {
      const { updateClientField } = await import("./client.ts");
      if (!params.field || params.value === undefined) {
        result = { success: false, message: "", error: "Missing field or value parameter." };
        break;
      }
      result = await updateClientField(
        supabase,
        entityId,
        params.field,
        params.value,
      );
      break;
    }

    // ─── Board Status ───
    case "update_board_status": {
      const { updateBoardStatus } = await import("./caregiver.ts");
      if (!params.new_status) {
        result = { success: false, message: "", error: "Missing new_status parameter." };
        break;
      }
      result = await updateBoardStatus(
        supabase,
        entityId,
        params.new_status,
        params.note,
      );
      break;
    }

    // ─── Calendar ───
    case "create_calendar_event": {
      const { createCalendarEvent } = await import("./calendar.ts");
      if (!params.title || !params.date || !params.start_time || !params.end_time) {
        result = { success: false, message: "", error: "Missing required calendar params (title, date, start_time, end_time)." };
        break;
      }
      result = await createCalendarEvent(
        supabase,
        entityId || null,
        {
          title: params.title,
          date: params.date,
          start_time: params.start_time,
          end_time: params.end_time,
          caregiver_email: params.caregiver_email || null,
          additional_attendees: params.additional_attendees || null,
          location: params.location || null,
          description: params.description || null,
          is_online: params.is_online || false,
        },
        executedBy,
      );
      break;
    }

    // ─── DocuSign ───
    case "send_docusign_envelope": {
      const { sendDocuSignEnvelope } = await import("./docusign.ts");
      if (!params.caregiver_email || !params.caregiver_name) {
        result = { success: false, message: "", error: "Missing caregiver_email or caregiver_name for DocuSign." };
        break;
      }
      result = await sendDocuSignEnvelope(
        supabase,
        entityId,
        {
          caregiver_email: params.caregiver_email,
          caregiver_name: params.caregiver_name,
          template_ids: params.template_ids || [],
          template_names: params.template_names || [],
          is_packet: params.is_packet || false,
        },
        executedBy,
      );
      break;
    }

    // ─── eSign ───
    case "send_esign_envelope": {
      const { sendESignEnvelope } = await import("./esign.ts");
      if (!params.caregiver_name) {
        result = { success: false, message: "", error: "Missing caregiver_name for eSign." };
        break;
      }
      result = await sendESignEnvelope(
        supabase,
        entityId,
        {
          caregiver_email: params.caregiver_email || "",
          caregiver_phone: params.caregiver_phone || "",
          caregiver_name: params.caregiver_name,
          template_ids: params.template_ids || [],
          template_names: params.template_names || [],
          is_packet: params.is_packet || false,
          send_via: params.send_via || "sms",
        },
        executedBy,
      );
      break;
    }

    // ─── Unknown ───
    default:
      result = {
        success: false,
        message: "",
        error: `Action type "${suggestion.action_type}" is not supported for autonomous execution.`,
      };
  }

  // ─── Record outcome for trackable actions (fire-and-forget) ───
  const outcomeMapping = OUTCOME_ACTION_MAP[suggestion.action_type];
  if (result.success && outcomeMapping) {
    const expiresAt = outcomeMapping.expiryDays
      ? new Date(Date.now() + outcomeMapping.expiryDays * 86400000).toISOString()
      : null;

    supabase.from("action_outcomes").insert({
      action_type: outcomeMapping.outcomeType,
      entity_type: entityType,
      entity_id: entityId,
      source: deriveOutcomeSource(executedBy),
      metadata: {
        suggestion_id: suggestionId,
        source_type: suggestion.source_type,
        action_params: suggestion.action_params,
      },
      expires_at: expiresAt,
    }).then(() => {}).catch((err: Error) =>
      console.error(`[routing] Failed to record outcome for ${suggestionId}:`, err)
    );
  }

  // ─── Record autonomy outcome (fire-and-forget) ───
  // Tracks trust signals for auto-promotion/demotion of autonomy levels.
  // Human approvals and auto-executions both count as successful outcomes.
  if (result.success && suggestion.action_type) {
    const autonomyContext = suggestion.source_type === "proactive" ? "proactive" : "inbound_routing";
    recordAutonomyOutcome(
      supabase,
      suggestion.action_type,
      entityType,
      autonomyContext,
      true,
    ).catch((err: Error) =>
      console.error(`[routing] Failed to record autonomy outcome:`, err)
    );
  }

  // Update suggestion status
  await supabase
    .from("ai_suggestions")
    .update({
      status: result.success ? "executed" : "failed",
      resolved_at: new Date().toISOString(),
      resolved_by: executedBy,
      ...(result.error ? { error_detail: result.error } : {}),
    })
    .eq("id", suggestionId);

  return result;
}
