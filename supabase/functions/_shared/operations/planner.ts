// ─── Proactive Planner Helpers ───
// Pure functions + DB queries used by the ai-planner Edge Function.
// Pipeline summary building, dedup, rule loading, response parsing,
// and single-entity context formatting for event-driven triggers.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { EntityContext } from "./routing.ts";

// ─── Types ───

export interface PipelineEntity {
  id: string;
  name: string;
  entity_type: "caregiver" | "client";
  phase: string;
  days_in_phase: number;
  days_since_contact: number;
  last_contact_channel: string | null;
  incomplete_tasks: string[];
  total_tasks: number;
  completed_tasks: number;
  has_phone: boolean;
  has_email: boolean;
  active_alerts: string[];
  recent_outcomes: string[];
  board_status: string | null;
}

export interface PlannerSuggestion {
  entity_id: string;
  entity_type: "caregiver" | "client";
  entity_name: string;
  action_type: string;
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  drafted_content: string | null;
  action_params: Record<string, any>;
}

// ─── Pipeline Summary Builder ───

export function buildPipelineSummary(
  caregivers: any[],
  clients: any[],
  actionItemRules: any[],
  automationRules: any[],
  recentOutcomes: any[],
): { entities: PipelineEntity[]; rules_context: string; automation_context: string } {
  const now = Date.now();
  const entities: PipelineEntity[] = [];

  // Process caregivers
  for (const cg of caregivers) {
    if (cg.archived) continue;

    const phase = cg.phase_override || inferPhase(cg.phase_timestamps) || "Unknown";
    const daysInPhase = calculateDaysInPhase(cg.phase_timestamps, phase, now);
    const { daysSince, channel } = getLastContact(cg.notes, cg.created_at, now);
    const { incomplete, total, completed } = getTaskProgress(cg.tasks);
    const alerts = evaluateAlerts(cg, actionItemRules, "caregiver", now);
    const outcomes = getRecentOutcomes(cg.id, recentOutcomes);

    entities.push({
      id: cg.id,
      name: `${cg.first_name || ""} ${cg.last_name || ""}`.trim() || "Unknown",
      entity_type: "caregiver",
      phase,
      days_in_phase: daysInPhase,
      days_since_contact: daysSince,
      last_contact_channel: channel,
      incomplete_tasks: incomplete,
      total_tasks: total,
      completed_tasks: completed,
      has_phone: !!cg.phone,
      has_email: !!cg.email,
      active_alerts: alerts,
      recent_outcomes: outcomes,
      board_status: cg.board_status || null,
    });
  }

  // Process clients
  for (const cl of clients) {
    if (cl.archived) continue;

    const phase = cl.phase || "Unknown";
    const daysInPhase = calculateDaysInPhase(cl.phase_timestamps, phase, now);
    const { daysSince, channel } = getLastContact(cl.notes, cl.created_at, now);
    const { incomplete, total, completed } = getTaskProgress(cl.tasks);
    const alerts = evaluateAlerts(cl, actionItemRules, "client", now);
    const outcomes = getRecentOutcomes(cl.id, recentOutcomes);

    entities.push({
      id: cl.id,
      name: `${cl.first_name || ""} ${cl.last_name || ""}`.trim() || "Unknown",
      entity_type: "client",
      phase,
      days_in_phase: daysInPhase,
      days_since_contact: daysSince,
      last_contact_channel: channel,
      incomplete_tasks: incomplete,
      total_tasks: total,
      completed_tasks: completed,
      has_phone: !!cl.phone,
      has_email: !!cl.email,
      active_alerts: alerts,
      recent_outcomes: outcomes,
      board_status: null,
    });
  }

  // Sort: most stale first, then by alert count
  entities.sort((a, b) => {
    if (b.active_alerts.length !== a.active_alerts.length) {
      return b.active_alerts.length - a.active_alerts.length;
    }
    return b.days_since_contact - a.days_since_contact;
  });

  // Cap at 100 entities for token budget
  const capped = entities.slice(0, 100);

  // Build rules context string
  const rules_context = actionItemRules
    .filter((r: any) => r.enabled)
    .map((r: any) => `- ${r.name}: ${r.detail_template || r.title_template} (${r.urgency})`)
    .join("\n");

  // Build automation context string
  const automation_context = automationRules
    .filter((r: any) => r.enabled)
    .map((r: any) => `- ${r.name}: trigger=${r.trigger_type}, action=${r.action_type}`)
    .join("\n");

  return { entities: capped, rules_context, automation_context };
}

// ─── Pure Helper Functions ───

export function inferPhase(timestamps: any): string | null {
  if (!timestamps || typeof timestamps !== "object") return null;
  const phases = ["Intake", "Interview", "Onboarding", "Verification", "Orientation", "Active Roster"];
  for (let i = phases.length - 1; i >= 0; i--) {
    const key = phases[i].toLowerCase().replace(/\s+/g, "_");
    if (timestamps[key]) return phases[i];
  }
  return null;
}

export function calculateDaysInPhase(timestamps: any, currentPhase: string, now: number): number {
  if (!timestamps || typeof timestamps !== "object") return 0;
  const key = currentPhase.toLowerCase().replace(/\s+/g, "_");
  const entered = timestamps[key];
  if (!entered) return 0;
  return Math.floor((now - new Date(entered).getTime()) / 86400000);
}

export function getLastContact(
  notes: any[],
  createdAt: string,
  now: number,
): { daysSince: number; channel: string | null } {
  let lastTs = new Date(createdAt || 0).getTime();
  let channel: string | null = null;

  for (const n of notes || []) {
    if (typeof n === "string") continue;
    const ts = n.timestamp ? new Date(n.timestamp).getTime() : 0;
    if (ts > lastTs) {
      lastTs = ts;
      channel = n.type || n.direction || null;
    }
  }

  return {
    daysSince: Math.floor((now - lastTs) / 86400000),
    channel,
  };
}

export function getTaskProgress(tasks: any): {
  incomplete: string[];
  total: number;
  completed: number;
} {
  if (!tasks || typeof tasks !== "object") {
    return { incomplete: [], total: 0, completed: 0 };
  }

  const incomplete: string[] = [];
  let total = 0;
  let completed = 0;

  for (const [taskId, taskData] of Object.entries(tasks)) {
    total++;
    if ((taskData as any)?.completed) {
      completed++;
    } else {
      // Convert task ID to readable label
      incomplete.push(taskId.replace(/^task_/, "").replace(/_/g, " "));
    }
  }

  return { incomplete, total, completed };
}

export function evaluateAlerts(
  entity: any,
  rules: any[],
  entityType: string,
  now: number,
): string[] {
  const alerts: string[] = [];
  const applicableRules = rules.filter(
    (r: any) => r.enabled && r.entity_type === entityType,
  );

  for (const rule of applicableRules) {
    // Simple evaluation — check condition_type
    switch (rule.condition_type) {
      case "task_missing": {
        const taskId = rule.condition_config?.task_id;
        if (taskId && entity.tasks && !entity.tasks[taskId]?.completed) {
          alerts.push(rule.name);
        }
        break;
      }
      case "stale_task": {
        const taskId = rule.condition_config?.task_id;
        const days = rule.condition_config?.days || 3;
        if (taskId && entity.tasks && !entity.tasks[taskId]?.completed) {
          const phase = entity.phase_override || entity.phase;
          const phaseKey = (phase || "").toLowerCase().replace(/\s+/g, "_");
          const entered = entity.phase_timestamps?.[phaseKey];
          if (entered) {
            const daysIn = Math.floor((now - new Date(entered).getTime()) / 86400000);
            if (daysIn >= days) alerts.push(rule.name);
          }
        }
        break;
      }
      case "phase_time": {
        const days = rule.condition_config?.days || 7;
        const phase = entity.phase_override || entity.phase;
        const phaseKey = (phase || "").toLowerCase().replace(/\s+/g, "_");
        const entered = entity.phase_timestamps?.[phaseKey];
        if (entered) {
          const daysIn = Math.floor((now - new Date(entered).getTime()) / 86400000);
          if (daysIn >= days) alerts.push(rule.name);
        }
        break;
      }
      case "date_expiry": {
        const field = rule.condition_config?.date_field;
        const warnDays = rule.condition_config?.warn_days || 30;
        if (field && entity[field]) {
          const expiry = new Date(entity[field]).getTime();
          const daysUntil = Math.floor((expiry - now) / 86400000);
          if (daysUntil <= warnDays) alerts.push(rule.name);
        }
        break;
      }
      // sprint and other types can be added as needed
    }
  }

  return alerts;
}

export function getRecentOutcomes(entityId: string, outcomes: any[]): string[] {
  return outcomes
    .filter((o: any) => o.entity_id === entityId)
    .slice(0, 3)
    .map((o: any) => {
      const action = (o.action_type || "").replace(/_/g, " ");
      const outcome = o.outcome_type || "pending";
      return `${action}: ${outcome}`;
    });
}

// ─── Dedup Check ───

export async function checkDuplicateSuggestion(
  supabase: SupabaseClient,
  entityId: string,
  actionType: string,
  windowHours: number = 24,
): Promise<boolean> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("ai_suggestions")
    .select("id")
    .eq("entity_id", entityId)
    .eq("action_type", actionType)
    // Check ALL sources (proactive + inbound_sms + inbound_email) to prevent cross-source duplicates
    .in("status", ["pending", "executed", "auto_executed"])
    .gte("created_at", since)
    .limit(1);

  return (data?.length || 0) > 0;
}

// ─── Response Parser ───

// UUID v4 pattern — reject suggestions with non-UUID entity_id
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ACTION_TYPES = new Set([
  "send_sms", "send_email", "add_note", "add_client_note",
  "update_phase", "update_client_phase",
  "complete_task", "complete_client_task",
  "update_caregiver_field", "update_client_field",
  "update_board_status", "create_calendar_event",
  "send_docusign_envelope",
]);

const VALID_PRIORITIES = new Set(["high", "medium", "low"]);

export function parsePlannerResponse(responseText: string): PlannerSuggestion[] {
  // Extract JSON array from response (may have markdown wrapping)
  let jsonStr = responseText.trim();
  const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  jsonStr = jsonMatch[0];

  let parsed: any[];
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const suggestions: PlannerSuggestion[] = [];
  for (const item of parsed) {
    // Validate required fields
    if (!item.entity_id || !item.action_type || !item.title) continue;
    if (!VALID_ACTION_TYPES.has(item.action_type)) continue;
    // Reject non-UUID entity_id (LLM sometimes generates slug-style IDs)
    if (!UUID_PATTERN.test(String(item.entity_id))) {
      console.warn(`[ai-planner] Rejecting suggestion with non-UUID entity_id: ${item.entity_id}`);
      continue;
    }

    suggestions.push({
      entity_id: String(item.entity_id),
      entity_type: item.entity_type === "client" ? "client" : "caregiver",
      entity_name: String(item.entity_name || "Unknown"),
      action_type: item.action_type,
      priority: VALID_PRIORITIES.has(item.priority) ? item.priority : "medium",
      title: String(item.title).slice(0, 200),
      detail: String(item.detail || "").slice(0, 500),
      drafted_content: item.drafted_content ? String(item.drafted_content) : null,
      action_params: item.action_params || {},
    });
  }

  return suggestions;
}

// ─── Single-Entity Context Formatter (for event-driven triggers) ───

export function formatSingleEntityPrompt(
  entityContext: EntityContext,
  triggerReason: string,
  recentOutcomes: any[],
  actionItemRules: any[],
  entityData: any,
): string {
  const now = Date.now();
  const lines: string[] = [];

  // ── Trigger reason (prominent) ──
  lines.push(`## Trigger Event`);
  lines.push(triggerReason);

  // ── Entity basics ──
  const phase = entityContext.phase || "Unknown";
  const daysInPhase = entityData?.phase_timestamps
    ? calculateDaysInPhase(entityData.phase_timestamps, phase, now)
    : 0;

  lines.push("");
  lines.push(`## Entity Profile`);
  lines.push(`ID: ${entityContext.id}`);
  lines.push(`Name: ${entityContext.first_name} ${entityContext.last_name} (${entityContext.entity_type})`);
  lines.push(`Phase: ${phase} (${daysInPhase}d in phase)`);
  lines.push(`Phone: ${entityContext.phone || "NONE"}`);
  lines.push(`Email: ${entityContext.email || "NONE"}`);

  // ── Incomplete tasks ──
  if (entityContext.incomplete_tasks.length > 0) {
    lines.push("");
    lines.push(`## Pending Tasks (${entityContext.incomplete_tasks.length})`);
    for (const task of entityContext.incomplete_tasks) {
      const label = entityContext.task_labels?.[task] || task.replace(/^task_/, "").replace(/_/g, " ");
      lines.push(`- ${label}`);
    }
  }

  // ── Active alerts ──
  const alerts = evaluateAlerts(entityData, actionItemRules, entityContext.entity_type, now);
  if (alerts.length > 0) {
    lines.push("");
    lines.push(`## Active Alerts`);
    for (const alert of alerts) {
      lines.push(`- ${alert}`);
    }
  }

  // ── Recent outcomes ──
  const outcomes = getRecentOutcomes(entityContext.id, recentOutcomes);
  if (outcomes.length > 0) {
    lines.push("");
    lines.push(`## Recent Outcomes`);
    for (const o of outcomes) {
      lines.push(`- ${o}`);
    }
  }

  // ── Conversation history ──
  if (entityContext.conversation_history && entityContext.conversation_history.length > 0) {
    lines.push("");
    lines.push(`## Conversation History (most recent first)`);
    for (const msg of entityContext.conversation_history.slice(0, 10)) {
      const dir = msg.direction === "inbound" ? "THEM" : "US";
      const age = Math.floor((now - msg.timestamp) / 86400000);
      lines.push(`[${dir}] (${age}d ago) ${msg.text.slice(0, 200)}`);
    }
  }

  // ── Recent notes ──
  if (entityContext.recent_notes.length > 0) {
    lines.push("");
    lines.push(`## Recent Notes`);
    for (const note of entityContext.recent_notes.slice(0, 5)) {
      const age = note.timestamp ? Math.floor((now - new Date(note.timestamp).getTime()) / 86400000) : 0;
      lines.push(`- (${age}d ago) [${note.type}] ${note.text.slice(0, 150)}`);
    }
  }

  // ── Calendar context ──
  if (entityContext.calendar_summary) {
    lines.push("");
    lines.push(`## Upcoming Calendar`);
    lines.push(entityContext.calendar_summary);
  }

  // ── Recent events ──
  if (entityContext.recent_events && entityContext.recent_events.length > 0) {
    lines.push("");
    lines.push(`## Recent Events`);
    for (const evt of entityContext.recent_events.slice(0, 5)) {
      lines.push(`- ${evt.event_type} (${evt.created_at})`);
    }
  }

  return lines.join("\n");
}

// ─── Compact Summary Formatter ───

export function formatPipelineSummaryForPrompt(entities: PipelineEntity[]): string {
  if (entities.length === 0) return "No active entities in pipeline.";

  const lines: string[] = [];
  for (const e of entities) {
    const parts = [
      `${e.name} (${e.entity_type}, ${e.phase})`,
      `${e.days_in_phase}d in phase`,
      `last contact: ${e.days_since_contact}d ago${e.last_contact_channel ? ` via ${e.last_contact_channel}` : ""}`,
      `tasks: ${e.completed_tasks}/${e.total_tasks}`,
    ];
    if (e.incomplete_tasks.length > 0) {
      parts.push(`pending: ${e.incomplete_tasks.slice(0, 3).join(", ")}`);
    }
    if (e.active_alerts.length > 0) {
      parts.push(`ALERTS: ${e.active_alerts.join(", ")}`);
    }
    if (e.recent_outcomes.length > 0) {
      parts.push(`outcomes: ${e.recent_outcomes.join("; ")}`);
    }
    if (!e.has_phone) parts.push("NO PHONE");
    lines.push(`- [${e.id}] ${parts.join(" | ")}`);
  }

  return lines.join("\n");
}
