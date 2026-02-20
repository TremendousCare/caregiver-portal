// ─── Awareness Tools ───
// Read-only tools that give the AI situational context:
// get_caregiver_documents, get_automation_summary, get_inbound_messages, get_action_items

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { resolveCaregiver, getPhase } from "../helpers/caregiver.ts";
import { getClientPhase } from "../helpers/client.ts";

// ═══════════════════════════════════════════════════════════════
// Tool 1: get_caregiver_documents
// ═══════════════════════════════════════════════════════════════

registerTool(
  {
    name: "get_caregiver_documents",
    description:
      "List all uploaded documents for a caregiver and identify missing required document types. Use when asked about documents, compliance, or what's missing from a caregiver's file.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name to search for" },
      },
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please provide a name or ID." };
    if (cg._ambiguous)
      return {
        error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.`,
      };

    try {
      // Fetch uploaded documents
      const { data: docs, error: docErr } = await ctx.supabase
        .from("caregiver_documents")
        .select("id, document_type, file_name, uploaded_at, uploaded_by")
        .eq("caregiver_id", cg.id)
        .order("uploaded_at", { ascending: false });

      if (docErr) throw docErr;

      // Fetch required document types from settings
      const { data: dtSetting } = await ctx.supabase
        .from("app_settings")
        .select("value")
        .eq("key", "document_types")
        .single();

      const requiredTypes: Array<{ id: string; label: string }> = dtSetting?.value || [];
      const uploadedTypeIds = new Set((docs || []).map((d: any) => d.document_type));

      const missingTypes = requiredTypes.filter((t) => !uploadedTypeIds.has(t.id));

      const documentList = (docs || []).map((d: any) => {
        const typeLabel = requiredTypes.find((t) => t.id === d.document_type)?.label || d.document_type;
        const date = new Date(d.uploaded_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return `  ✓ ${typeLabel} — ${d.file_name} (uploaded ${date} by ${d.uploaded_by || "unknown"})`;
      });

      const missingList = missingTypes.map((t) => `  ✗ ${t.label}`);

      return {
        caregiver: `${cg.first_name} ${cg.last_name}`,
        total_documents: (docs || []).length,
        total_required: requiredTypes.length,
        missing_count: missingTypes.length,
        compliance_complete: missingTypes.length === 0,
        documents: documentList.length > 0 ? documentList : ["No documents uploaded yet."],
        missing_types: missingList.length > 0 ? missingList : ["All required documents are uploaded!"],
      };
    } catch (err) {
      return { error: `Failed to retrieve documents: ${(err as Error).message}` };
    }
  },
);

// ═══════════════════════════════════════════════════════════════
// Tool 2: get_automation_summary
// ═══════════════════════════════════════════════════════════════

registerTool(
  {
    name: "get_automation_summary",
    description:
      "View automation rules and their recent execution history. Shows active rules, recent successes/failures, and execution stats. Use when asked about automations, what rules are set up, or if any automations failed.",
    input_schema: {
      type: "object",
      properties: {
        rule_id: { type: "string", description: "Specific rule ID to get details for (optional)" },
        status_filter: {
          type: "string",
          enum: ["all", "failed", "success"],
          description: "Filter execution log by status (default: all)",
        },
        days_back: {
          type: "number",
          description: "How many days of execution history (default: 7, max: 30)",
        },
        entity_type: {
          type: "string",
          enum: ["caregiver", "client"],
          description: "Filter rules by entity type (optional)",
        },
      },
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const daysBack = Math.min(input.days_back || 7, 30);
      const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
      const last24h = new Date(Date.now() - 86400000).toISOString();

      // Fetch all rules
      let rulesQuery = ctx.supabase
        .from("automation_rules")
        .select("id, name, trigger_type, entity_type, conditions, action_type, action_config, message_template, enabled")
        .order("enabled", { ascending: false })
        .order("name", { ascending: true });

      if (input.entity_type) {
        rulesQuery = rulesQuery.eq("entity_type", input.entity_type);
      }
      if (input.rule_id) {
        rulesQuery = rulesQuery.eq("id", input.rule_id);
      }

      const { data: rules, error: rulesErr } = await rulesQuery;
      if (rulesErr) throw rulesErr;

      // Fetch execution log
      let logQuery = ctx.supabase
        .from("automation_log")
        .select("id, rule_id, caregiver_id, action_type, status, message_sent, error_detail, executed_at, trigger_context")
        .gte("executed_at", cutoff)
        .order("executed_at", { ascending: false });

      if (input.rule_id) {
        logQuery = logQuery.eq("rule_id", input.rule_id);
      }
      if (input.status_filter && input.status_filter !== "all") {
        logQuery = logQuery.eq("status", input.status_filter);
      }

      logQuery = logQuery.limit(input.rule_id ? 20 : 50);

      const { data: logs, error: logErr } = await logQuery;
      if (logErr) throw logErr;

      // Compute stats
      const allLogs = logs || [];
      const successes = allLogs.filter((l: any) => l.status === "success").length;
      const failures = allLogs.filter((l: any) => l.status === "failed").length;
      const skipped = allLogs.filter((l: any) => l.status === "skipped").length;
      const last24hLogs = allLogs.filter((l: any) => l.executed_at >= last24h).length;

      // Format rules
      const enabledRules = (rules || []).filter((r: any) => r.enabled);
      const ruleLines = (rules || []).map((r: any) => {
        const status = r.enabled ? "✅" : "⏸️";
        const condSummary = r.conditions
          ? Object.entries(r.conditions)
              .filter(([_, v]) => v)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : "none";
        return `${status} ${r.name} | Trigger: ${r.trigger_type} | Action: ${r.action_type} | Entity: ${r.entity_type || "caregiver"} | Conditions: ${condSummary || "none"}`;
      });

      // Format log entries (show caregiver/client name if available)
      const logLines = allLogs.slice(0, 20).map((l: any) => {
        const date = new Date(l.executed_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        const statusIcon = l.status === "success" ? "✓" : l.status === "failed" ? "✗" : "↷";
        const ruleName = (rules || []).find((r: any) => r.id === l.rule_id)?.name || l.rule_id;

        // Try to find entity name
        let entityName = l.caregiver_id;
        const cg = ctx.caregivers.find((c: any) => c.id === l.caregiver_id);
        if (cg) entityName = `${cg.first_name} ${cg.last_name}`;
        else {
          const cl = (ctx.clients || []).find((c: any) => c.id === l.caregiver_id);
          if (cl) entityName = `${cl.first_name} ${cl.last_name}`;
        }

        const errorSnippet = l.error_detail ? ` — ${l.error_detail.substring(0, 80)}` : "";
        return `[${date}] ${statusIcon} ${ruleName} → ${entityName} (${l.action_type})${errorSnippet}`;
      });

      return {
        total_rules: (rules || []).length,
        enabled_rules: enabledRules.length,
        rules: ruleLines.length > 0 ? ruleLines : ["No automation rules configured."],
        execution_stats: {
          period: `Last ${daysBack} days`,
          total: allLogs.length,
          successes,
          failures,
          skipped,
          last_24h: last24hLogs,
        },
        recent_log: logLines.length > 0 ? logLines : [`No executions in the last ${daysBack} days.`],
      };
    } catch (err) {
      return { error: `Failed to retrieve automation data: ${(err as Error).message}` };
    }
  },
);

// ═══════════════════════════════════════════════════════════════
// Tool 3: get_inbound_messages
// ═══════════════════════════════════════════════════════════════

registerTool(
  {
    name: "get_inbound_messages",
    description:
      "View recent inbound SMS messages received from caregivers and clients. Shows who texted, what they said, and whether they matched to a known record. Use when asked about incoming texts, replies, or inbound communications.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "Filter to messages from a specific caregiver" },
        name: { type: "string", description: "Caregiver/client name to filter by" },
        days_back: {
          type: "number",
          description: "How many days to look back (default: 7, max: 30)",
        },
        unmatched_only: {
          type: "boolean",
          description: "Only show messages from unknown numbers (default: false)",
        },
      },
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const daysBack = Math.min(input.days_back || 7, 30);
      const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();

      // Resolve caregiver if filtering by name
      let entityId: string | null = null;
      let entityName: string | null = null;
      if (input.caregiver_id || input.name) {
        const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
        if (cg && !cg._ambiguous) {
          entityId = cg.id;
          entityName = `${cg.first_name} ${cg.last_name}`;
        } else if (cg?._ambiguous) {
          return {
            error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.`,
          };
        }
        // If not found in caregivers, try clients
        if (!entityId && input.name) {
          const q = input.name.toLowerCase();
          const clientMatches = (ctx.clients || []).filter((c: any) => {
            const full = `${c.first_name} ${c.last_name}`.toLowerCase();
            return full.includes(q) || c.first_name?.toLowerCase().includes(q) || c.last_name?.toLowerCase().includes(q);
          });
          if (clientMatches.length === 1) {
            entityId = clientMatches[0].id;
            entityName = `${clientMatches[0].first_name} ${clientMatches[0].last_name}`;
          } else if (clientMatches.length > 1) {
            return {
              error: `Multiple client matches: ${clientMatches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.`,
            };
          }
        }
        if (!entityId) {
          return { error: "No caregiver or client found with that name." };
        }
      }

      // Query inbound_sms_log
      let query = ctx.supabase
        .from("inbound_sms_log")
        .select("*")
        .gte("processed_at", cutoff)
        .order("processed_at", { ascending: false })
        .limit(50);

      if (entityId) {
        query = query.eq("matched_entity_id", entityId);
      }
      if (input.unmatched_only) {
        query = query.is("matched_entity_id", null);
      }

      const { data: messages, error: msgErr } = await query;
      if (msgErr) throw msgErr;

      const allMsgs = messages || [];
      const matched = allMsgs.filter((m: any) => m.matched_entity_id).length;
      const unmatched = allMsgs.filter((m: any) => !m.matched_entity_id).length;

      // Format messages with entity names
      const msgLines = allMsgs.map((m: any) => {
        const date = new Date(m.processed_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        let fromLabel = m.from_phone;
        if (m.matched_entity_id) {
          // Try to find name
          const cg = ctx.caregivers.find((c: any) => c.id === m.matched_entity_id);
          if (cg) {
            fromLabel = `${cg.first_name} ${cg.last_name} (${m.from_phone})`;
          } else {
            const cl = (ctx.clients || []).find((c: any) => c.id === m.matched_entity_id);
            if (cl) {
              fromLabel = `${cl.first_name} ${cl.last_name} (${m.from_phone})`;
            }
          }
        } else {
          fromLabel = `Unknown (${m.from_phone})`;
        }

        const entityType = m.matched_entity_type ? ` [${m.matched_entity_type}]` : " [unmatched]";
        const text = m.message_text || "(empty message)";
        return `[${date}] ← ${fromLabel}${entityType}: ${text}`;
      });

      return {
        total_messages: allMsgs.length,
        matched,
        unmatched,
        period: `Last ${daysBack} days`,
        ...(entityName ? { filtered_by: entityName } : {}),
        messages: msgLines.length > 0 ? msgLines : [`No inbound SMS in the last ${daysBack} days.`],
      };
    } catch (err) {
      return { error: `Failed to retrieve inbound messages: ${(err as Error).message}` };
    }
  },
);

// ═══════════════════════════════════════════════════════════════
// Tool 4: get_action_items
// ═══════════════════════════════════════════════════════════════

// ─── Server-side Action Item Evaluators ────────────────────
// Reimplemented from src/lib/actionItemEngine.js for Edge Function context.
// Uses snake_case DB field names (not camelCase frontend names).

function serverGetPhase(entity: any, entityType: string): string {
  if (entityType === "client") return entity.phase || "new_lead";
  return entity.phase_override || getPhase(entity);
}

function serverGetDaysInPhase(entity: any, entityType: string): number {
  const phase = serverGetPhase(entity, entityType);
  const timestamps = entity.phase_timestamps || {};
  const phaseStart = timestamps[phase];
  if (!phaseStart) return 0;
  return Math.floor((Date.now() - phaseStart) / 86400000);
}

function serverGetDaysSinceCreation(entity: any): number {
  const created = entity.created_at || entity.application_date;
  if (!created) return 0;
  const ts = typeof created === "number" ? created : new Date(created).getTime();
  return Math.floor((Date.now() - ts) / 86400000);
}

function serverGetMinutesSinceCreation(entity: any): number {
  const created = entity.created_at || entity.application_date;
  if (!created) return 0;
  const ts = typeof created === "number" ? created : new Date(created).getTime();
  return (Date.now() - ts) / 60000;
}

function serverIsTaskDone(entity: any, taskId: string): boolean {
  const val = entity.tasks?.[taskId];
  return val === true || val?.completed === true;
}

function serverGetLastNoteDate(entity: any): number | null {
  const notes = entity.notes || [];
  if (notes.length === 0) return null;
  let max = 0;
  for (const n of notes) {
    if (typeof n === "string") continue;
    const ts = n.timestamp || n.date || 0;
    const t = typeof ts === "number" ? ts : new Date(ts).getTime();
    if (t > max) max = t;
  }
  return max > 0 ? max : null;
}

function serverGetPhaseTimestamp(entity: any, phase: string): number | null {
  return entity.phase_timestamps?.[phase] || null;
}

function serverIsTerminalPhase(entity: any, entityType: string): boolean {
  if (entityType !== "client") return false;
  const phase = serverGetPhase(entity, entityType);
  return phase === "won" || phase === "lost";
}

// ─── Condition Evaluators ─────────────────────────────────

type EvalResult = { matches: boolean; context: Record<string, any> };

function evalPhaseTime(entity: any, config: any, entityType: string): EvalResult {
  const phase = serverGetPhase(entity, entityType);
  const targetPhase = config.phase;

  if (targetPhase === "_any_active") {
    const excludePhases = config.exclude_phases || [];
    if (excludePhases.includes(phase)) return { matches: false, context: {} };
  } else if (targetPhase && phase !== targetPhase) {
    return { matches: false, context: {} };
  }

  const daysInPhase = serverGetDaysInPhase(entity, entityType);
  if (daysInPhase < (config.min_days || 0)) return { matches: false, context: {} };

  return { matches: true, context: { days_in_phase: daysInPhase, phase_name: phase } };
}

function evalTaskIncomplete(entity: any, config: any, entityType: string): EvalResult {
  const phase = serverGetPhase(entity, entityType);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };
  if (serverIsTaskDone(entity, config.task_id)) return { matches: false, context: {} };

  const daysInPhase = serverGetDaysInPhase(entity, entityType);
  const daysSinceCreation = serverGetDaysSinceCreation(entity);
  const relevantDays = config.phase ? daysInPhase : daysSinceCreation;
  if (relevantDays < (config.min_days || 0)) return { matches: false, context: {} };

  return {
    matches: true,
    context: { days_in_phase: daysInPhase, days_since_created: daysSinceCreation, phase_name: phase },
  };
}

function evalTaskStale(entity: any, config: any, entityType: string): EvalResult {
  const phase = serverGetPhase(entity, entityType);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };
  if (!serverIsTaskDone(entity, config.done_task_id)) return { matches: false, context: {} };
  if (serverIsTaskDone(entity, config.pending_task_id)) return { matches: false, context: {} };

  const phaseStart = serverGetPhaseTimestamp(entity, config.phase);
  if (!phaseStart) return { matches: false, context: {} };
  const daysSince = Math.floor((Date.now() - phaseStart) / 86400000);
  if (daysSince < (config.min_days || 0)) return { matches: false, context: {} };

  return { matches: true, context: { days_in_phase: daysSince, phase_name: phase } };
}

function evalDateExpiring(entity: any, config: any): EvalResult {
  const dateValue = entity[config.field];
  if (!dateValue) return { matches: false, context: {} };

  const exp = new Date(dateValue + (String(dateValue).includes("T") ? "" : "T00:00:00"));
  const daysUntil = Math.ceil((exp.getTime() - Date.now()) / 86400000);

  if (config.days_until !== undefined && config.days_until < 0) {
    if (daysUntil >= 0) return { matches: false, context: {} };
    return {
      matches: true,
      context: {
        days_until_expiry: Math.abs(daysUntil),
        expiry_date: exp.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      },
    };
  }

  const daysWarning = config.days_warning || 30;
  const excludeUnder = config.days_exclude_under || 0;
  if (daysUntil < 0) return { matches: false, context: {} };
  if (daysUntil > daysWarning) return { matches: false, context: {} };
  if (excludeUnder > 0 && daysUntil <= excludeUnder) return { matches: false, context: {} };

  return {
    matches: true,
    context: {
      days_until_expiry: daysUntil,
      expiry_date: exp.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    },
  };
}

function evalTimeSinceCreation(entity: any, config: any, entityType: string): EvalResult {
  const phase = serverGetPhase(entity, entityType);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };
  if (config.task_not_done && serverIsTaskDone(entity, config.task_not_done))
    return { matches: false, context: {} };

  if (config.min_minutes) {
    const minutesSince = serverGetMinutesSinceCreation(entity);
    if (minutesSince < config.min_minutes) return { matches: false, context: {} };
    return {
      matches: true,
      context: {
        minutes_since_created: Math.round(minutesSince),
        days_since_created: serverGetDaysSinceCreation(entity),
        phase_name: phase,
      },
    };
  }

  if (config.min_days) {
    const daysSince = serverGetDaysSinceCreation(entity);
    if (daysSince < config.min_days) return { matches: false, context: {} };
    return { matches: true, context: { days_since_created: daysSince, phase_name: phase } };
  }

  return { matches: false, context: {} };
}

function evalLastNoteStale(entity: any, config: any, entityType: string): EvalResult {
  const phase = serverGetPhase(entity, entityType);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };

  const lastNoteTs = serverGetLastNoteDate(entity);
  let daysSinceLastNote: number;

  if (lastNoteTs && lastNoteTs > 0) {
    daysSinceLastNote = Math.floor((Date.now() - lastNoteTs) / 86400000);
  } else {
    daysSinceLastNote = serverGetDaysSinceCreation(entity);
  }

  if (daysSinceLastNote < (config.min_days || 0)) return { matches: false, context: {} };
  return { matches: true, context: { days_since_last_note: daysSinceLastNote, phase_name: phase } };
}

function evalSprintDeadline(entity: any, config: any, entityType: string): EvalResult {
  const phase = serverGetPhase(entity, entityType);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };

  const sprintStart = serverGetPhaseTimestamp(entity, config.phase);
  if (!sprintStart) return { matches: false, context: {} };

  const sprintDay = Math.floor((Date.now() - sprintStart) / 86400000);
  const warningDay = config.warning_day || 3;
  if (sprintDay < warningDay) return { matches: false, context: {} };

  const expiredDay = config.expired_day || 7;
  return {
    matches: true,
    context: {
      sprint_day: sprintDay,
      sprint_remaining: Math.max(0, expiredDay - sprintDay),
      days_in_phase: sprintDay,
      phase_name: phase,
    },
  };
}

const EVALUATORS: Record<string, (entity: any, config: any, entityType: string) => EvalResult> = {
  phase_time: evalPhaseTime,
  task_incomplete: evalTaskIncomplete,
  task_stale: evalTaskStale,
  date_expiring: (e, c, _t) => evalDateExpiring(e, c),
  time_since_creation: evalTimeSinceCreation,
  last_note_stale: evalLastNoteStale,
  sprint_deadline: evalSprintDeadline,
};

const URGENCY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

function resolveTemplateStr(template: string, context: Record<string, any>): string {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return context[key] !== undefined ? String(context[key]) : `{{${key}}}`;
  });
}

registerTool(
  {
    name: "get_action_items",
    description:
      "Get computed action items (follow-up alerts) for a specific caregiver or across the entire pipeline. Shows what needs attention based on configured rules — like stale leads, missing documents, expiring certifications, and overdue tasks. Use when asked about follow-ups, what needs attention, alerts, or priorities.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "Get action items for a specific caregiver" },
        name: { type: "string", description: "Caregiver name to filter by" },
        urgency: {
          type: "string",
          enum: ["critical", "warning", "info", "all"],
          description: "Filter by urgency level (default: all)",
        },
        entity_type: {
          type: "string",
          enum: ["caregiver", "client"],
          description: "Filter by entity type (default: both)",
        },
        limit: {
          type: "number",
          description: "Max items to return (default: 25, max: 50)",
        },
      },
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const maxItems = Math.min(input.limit || 25, 50);

      // Load action item rules
      const { data: rules, error: rulesErr } = await ctx.supabase
        .from("action_item_rules")
        .select("*")
        .eq("enabled", true)
        .order("sort_order", { ascending: true });

      if (rulesErr) throw rulesErr;
      if (!rules || rules.length === 0) {
        return { result: "No action item rules are configured. Set up rules in Settings > Action Item Rules." };
      }

      // If filtering by specific caregiver
      let singleEntity: any = null;
      let singleEntityType: string | null = null;
      if (input.caregiver_id || input.name) {
        const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
        if (cg && !cg._ambiguous) {
          singleEntity = cg;
          singleEntityType = "caregiver";
        } else if (cg?._ambiguous) {
          return {
            error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.`,
          };
        }
        // Try clients if not found in caregivers
        if (!singleEntity && input.name) {
          const q = input.name.toLowerCase();
          const clientMatches = (ctx.clients || []).filter((c: any) => {
            const full = `${c.first_name} ${c.last_name}`.toLowerCase();
            return full.includes(q) || c.first_name?.toLowerCase().includes(q) || c.last_name?.toLowerCase().includes(q);
          });
          if (clientMatches.length === 1) {
            singleEntity = clientMatches[0];
            singleEntityType = "client";
          } else if (clientMatches.length > 1) {
            return {
              error: `Multiple client matches: ${clientMatches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.`,
            };
          }
        }
        if (!singleEntity) {
          return { error: "No caregiver or client found with that name." };
        }
      }

      // Evaluate rules against entities
      const allItems: Array<{
        entityName: string;
        entityType: string;
        urgency: string;
        icon: string;
        title: string;
        detail: string;
        action: string;
      }> = [];

      const evaluateEntity = (entity: any, entityType: string) => {
        if (entity.archived) return;
        if (serverIsTerminalPhase(entity, entityType)) return;

        const relevantRules = rules.filter((r: any) => r.entity_type === entityType);
        const entityName = `${entity.first_name || ""} ${entity.last_name || ""}`.trim() || "Unnamed";

        for (const rule of relevantRules) {
          const evaluator = EVALUATORS[rule.condition_type];
          if (!evaluator) continue;

          try {
            const { matches, context } = evaluator(entity, rule.condition_config || {}, entityType);
            if (!matches) continue;

            // Resolve urgency (with escalation)
            let urgency = rule.urgency || "info";
            if (rule.urgency_escalation) {
              const esc = rule.urgency_escalation;
              const daysInPhase = serverGetDaysInPhase(entity, entityType);
              const daysSinceCreation = serverGetDaysSinceCreation(entity);
              const relevantDays = Math.max(daysInPhase, daysSinceCreation);
              if (esc.min_days && relevantDays >= esc.min_days && esc.urgency) {
                urgency = esc.urgency;
              }
            }

            // Apply urgency filter
            if (input.urgency && input.urgency !== "all" && urgency !== input.urgency) continue;

            const fullContext = { ...context, name: entityName };

            allItems.push({
              entityName,
              entityType,
              urgency,
              icon: rule.icon || "📋",
              title: resolveTemplateStr(rule.title_template, fullContext),
              detail: resolveTemplateStr(rule.detail_template, fullContext),
              action: resolveTemplateStr(rule.action_template, fullContext),
            });
          } catch {
            // Skip bad rules silently
          }
        }
      };

      if (singleEntity) {
        evaluateEntity(singleEntity, singleEntityType!);
      } else {
        // Evaluate across the pipeline
        const includeCaregiver = !input.entity_type || input.entity_type === "caregiver";
        const includeClient = !input.entity_type || input.entity_type === "client";

        if (includeCaregiver) {
          for (const cg of ctx.caregivers) {
            evaluateEntity(cg, "caregiver");
          }
        }
        if (includeClient) {
          for (const cl of ctx.clients || []) {
            evaluateEntity(cl, "client");
          }
        }
      }

      // Sort by urgency, then by name
      allItems.sort((a, b) => {
        const urgencyDiff = (URGENCY_ORDER[a.urgency] || 2) - (URGENCY_ORDER[b.urgency] || 2);
        if (urgencyDiff !== 0) return urgencyDiff;
        return a.entityName.localeCompare(b.entityName);
      });

      // Apply limit
      const limited = allItems.slice(0, maxItems);

      // Count by urgency
      const criticalCount = allItems.filter((i) => i.urgency === "critical").length;
      const warningCount = allItems.filter((i) => i.urgency === "warning").length;
      const infoCount = allItems.filter((i) => i.urgency === "info").length;

      // Format items
      const urgencyIcons: Record<string, string> = { critical: "🔴", warning: "🟡", info: "🔵" };
      const itemLines = limited.map((item) => {
        const uIcon = urgencyIcons[item.urgency] || "📋";
        return `${uIcon} ${item.icon} **${item.entityName}** [${item.entityType}]: ${item.title}\n   ${item.detail}\n   → ${item.action}`;
      });

      return {
        total_items: allItems.length,
        showing: limited.length,
        by_urgency: { critical: criticalCount, warning: warningCount, info: infoCount },
        ...(singleEntity
          ? { entity: `${singleEntity.first_name} ${singleEntity.last_name}` }
          : {}),
        items: itemLines.length > 0 ? itemLines : ["No action items found — everything looks good!"],
      };
    } catch (err) {
      return { error: `Failed to compute action items: ${(err as Error).message}` };
    }
  },
);
