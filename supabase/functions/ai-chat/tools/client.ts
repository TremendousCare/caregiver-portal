// ─── Client Pipeline Tools ───
// search_clients, get_client_detail, get_client_pipeline_stats, list_stale_clients (auto)
// update_client_phase, complete_client_task, update_client_field (confirm)
// add_client_note (auto)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import {
  getClientPhase,
  getClientPhaseLabel,
  getClientLastActivity,
  buildClientSummary,
  buildClientProfile,
  resolveClient,
} from "../helpers/client.ts";

// Valid phase IDs for client pipeline
const CLIENT_PHASE_IDS = [
  "new_lead",
  "initial_contact",
  "consultation",
  "assessment",
  "proposal",
  "won",
  "lost",
  "nurture",
];

// ── search_clients (auto) ──

registerTool(
  {
    name: "search_clients",
    description:
      "Search and filter clients (families seeking caregivers) by name, phase, city, care needs, or priority. Returns matching client summaries.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (name, city, phone, email, care needs, etc.)" },
        phase: { type: "string", description: "Filter by pipeline phase (new_lead, initial_contact, consultation, assessment, proposal, won, lost, nurture)" },
        priority: { type: "string", description: "Filter by priority (urgent, high, normal, low)" },
        city: { type: "string", description: "Filter by city" },
        include_archived: { type: "boolean", description: "Include archived clients (default false)" },
        limit: { type: "number", description: "Max results to return (default 20)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    let results = [...(ctx.clients || [])];
    if (!input.include_archived) results = results.filter((c: any) => !c.archived);
    if (input.phase) results = results.filter((c: any) => getClientPhase(c).toLowerCase() === input.phase.toLowerCase());
    if (input.priority) results = results.filter((c: any) => (c.priority || "normal").toLowerCase() === input.priority.toLowerCase());
    if (input.city) results = results.filter((c: any) => c.city?.toLowerCase().includes(input.city.toLowerCase()));
    if (input.query) {
      const q = input.query.toLowerCase();
      results = results.filter((c: any) => {
        const searchable = `${c.first_name} ${c.last_name} ${c.phone} ${c.email} ${c.city} ${c.care_needs} ${c.care_recipient_name} ${c.contact_name}`.toLowerCase();
        return searchable.includes(q);
      });
    }
    const limit = input.limit || 20;
    return { count: results.length, clients: results.slice(0, limit).map(buildClientSummary) };
  },
);

// ── get_client_detail (auto) ──

registerTool(
  {
    name: "get_client_detail",
    description:
      "Get full detailed profile for a specific client including all tasks, notes, care needs, and activity history.",
    input_schema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "The client's ID or name (first, last, or full)" },
      },
      required: ["identifier"],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const client = await resolveClient(ctx.supabase, input, ctx.clients || []);
    if (!client) return { error: "Client not found. Please check the name or ID." };
    if (client._ambiguous) return { error: `Multiple matches found: ${client.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
    return { profile: buildClientProfile(client) };
  },
);

// ── get_client_pipeline_stats (auto) ──

registerTool(
  {
    name: "get_client_pipeline_stats",
    description:
      "Get client pipeline statistics: counts by phase, total active, won this month, average days to close.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
    riskLevel: "auto",
  },
  async (_input: any, ctx: ToolContext): Promise<ToolResult> => {
    const clients = ctx.clients || [];
    const active = clients.filter((c: any) => !c.archived);
    const phases: Record<string, number> = {};
    for (const cl of active) {
      const p = getClientPhaseLabel(cl);
      phases[p] = (phases[p] || 0) + 1;
    }

    // Won this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const wonThisMonth = active.filter((c: any) => {
      if (getClientPhase(c) !== "won") return false;
      const wonAt = c.phase_timestamps?.won;
      return wonAt && wonAt >= monthStart;
    }).length;

    // Average days to close (for clients in "won" phase)
    const wonClients = active.filter((c: any) => getClientPhase(c) === "won");
    let avgDaysToClose = 0;
    if (wonClients.length > 0) {
      const totalDays = wonClients.reduce((sum: number, c: any) => {
        const created = c.created_at || 0;
        const wonAt = c.phase_timestamps?.won || Date.now();
        return sum + Math.floor((wonAt - created) / 86400000);
      }, 0);
      avgDaysToClose = Math.round(totalDays / wonClients.length);
    }

    return {
      total_active: active.length,
      total_archived: clients.length - active.length,
      phase_distribution: phases,
      won_this_month: wonThisMonth,
      average_days_to_close: avgDaysToClose,
    };
  },
);

// ── list_stale_clients (auto) ──

registerTool(
  {
    name: "list_stale_clients",
    description:
      "Find clients with no activity (notes/task completions) in X days. Helps identify leads falling through the cracks.",
    input_schema: {
      type: "object",
      properties: {
        days_inactive: { type: "number", description: "Number of days of inactivity to consider stale (default 7)" },
        phase: { type: "string", description: "Optionally filter by phase" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const days = input.days_inactive || 7;
    const cutoff = Date.now() - days * 86400000;
    let leads = (ctx.clients || []).filter((c: any) => !c.archived && getClientLastActivity(c) < cutoff);
    if (input.phase) leads = leads.filter((c: any) => getClientPhase(c).toLowerCase() === input.phase.toLowerCase());
    leads.sort((a: any, b: any) => getClientLastActivity(a) - getClientLastActivity(b));
    return {
      count: leads.length,
      days_inactive_threshold: days,
      clients: leads.map((c: any) => {
        const daysSince = Math.floor((Date.now() - getClientLastActivity(c)) / 86400000);
        return `${buildClientSummary(c)} | Last activity: ${daysSince} days ago`;
      }),
    };
  },
);

// ── add_client_note (auto) ──

registerTool(
  {
    name: "add_client_note",
    description:
      "Add a timestamped note to a client's record. Use this when the user asks to log a call, add a note, or record an interaction with a client/family.",
    input_schema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "The client's ID or name" },
        text: { type: "string", description: "The note content" },
        type: { type: "string", enum: ["note", "call", "text", "email", "voicemail", "meeting"], description: "Type of interaction (default: note)" },
        direction: { type: "string", enum: ["inbound", "outbound"], description: "Direction of communication if applicable" },
        outcome: { type: "string", description: "Outcome of the interaction (e.g., 'left voicemail', 'scheduled consultation')" },
      },
      required: ["identifier", "text"],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const client = await resolveClient(ctx.supabase, input, ctx.clients || []);
    if (!client) return { error: "Client not found. Please check the name or ID." };
    if (client._ambiguous) return { error: `Multiple matches: ${client.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
    const newNote = {
      text: input.text,
      type: input.type || "note",
      direction: input.direction || null,
      outcome: input.outcome || null,
      timestamp: Date.now(),
      author: ctx.currentUser || "AI Assistant",
    };
    const { error } = await ctx.supabase
      .from("clients")
      .update({ notes: [...(client.notes || []), newNote] })
      .eq("id", client.id);
    if (error) return { error: `Failed to add note: ${error.message}` };
    return { success: true, message: `Note added to ${client.first_name} ${client.last_name}'s record.`, note: newNote };
  },
);

// ── update_client_phase (confirm) ──

registerTool(
  {
    name: "update_client_phase",
    description: "Move a client to a different pipeline phase. REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "The client's ID or name" },
        phase: { type: "string", enum: CLIENT_PHASE_IDS, description: "The target phase" },
        reason: { type: "string", description: "Why this phase change is being made" },
      },
      required: ["identifier", "phase"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const client = await resolveClient(ctx.supabase, input, ctx.clients || []);
    if (!client) return { error: "Client not found." };
    if (client._ambiguous) return { error: `Multiple matches: ${client.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
    if (!CLIENT_PHASE_IDS.includes(input.phase)) return { error: `Invalid phase "${input.phase}". Valid phases: ${CLIENT_PHASE_IDS.join(", ")}` };
    return {
      requires_confirmation: true,
      action: "update_client_phase",
      summary: `Move **${client.first_name} ${client.last_name}** from **${getClientPhaseLabel(client)}** to **${input.phase}**${input.reason ? ` — ${input.reason}` : ""}`,
      client_id: client.id,
      params: { phase: input.phase, reason: input.reason },
    };
  },
  // Confirmed handler
  async (_action: string, clientId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const { data: client, error: fetchErr } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (fetchErr || !client) return { error: "Client not found." };
    const timestamps = { ...(client.phase_timestamps || {}), [params.phase]: Date.now() };
    const { error } = await supabase.from("clients").update({ phase: params.phase, phase_timestamps: timestamps }).eq("id", clientId);
    if (error) return { error: error.message };
    const note = { text: `Phase changed to ${params.phase}${params.reason ? `: ${params.reason}` : ""}`, type: "note", timestamp: Date.now(), author: currentUser || "AI Assistant" };
    await supabase.from("clients").update({ notes: [...(client.notes || []), note] }).eq("id", clientId);
    return { success: true, message: `${client.first_name} ${client.last_name} moved to ${params.phase}.` };
  },
);

// ── complete_client_task (confirm) ──

registerTool(
  {
    name: "complete_client_task",
    description: "Mark a pipeline task as completed for a client. REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "The client's ID or name" },
        task_id: { type: "string", description: "The task ID to mark complete (e.g., 'lead_reviewed', 'consultation_completed')" },
      },
      required: ["identifier", "task_id"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const client = await resolveClient(ctx.supabase, input, ctx.clients || []);
    if (!client) return { error: "Client not found." };
    if (client._ambiguous) return { error: `Multiple matches: ${client.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
    return {
      requires_confirmation: true,
      action: "complete_client_task",
      summary: `Mark task **"${input.task_id}"** as complete for **${client.first_name} ${client.last_name}**`,
      client_id: client.id,
      params: { task_id: input.task_id },
    };
  },
  async (_action: string, clientId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const { data: client, error: fetchErr } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (fetchErr || !client) return { error: "Client not found." };
    const tasks = { ...(client.tasks || {}) };
    tasks[params.task_id] = { completed: true, completedAt: Date.now(), completedBy: currentUser || "AI Assistant" };
    const { error } = await supabase.from("clients").update({ tasks }).eq("id", clientId);
    if (error) return { error: error.message };
    return { success: true, message: `Task "${params.task_id}" completed for ${client.first_name} ${client.last_name}.` };
  },
);

// ── update_client_field (confirm) ──

registerTool(
  {
    name: "update_client_field",
    description: "Update a specific field on a client's record (phone, email, care_needs, priority, etc.). REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "The client's ID or name" },
        field: { type: "string", description: "Field to update (phone, email, address, city, state, zip, care_needs, hours_needed, budget_range, priority, assigned_to, etc.)" },
        value: { type: "string", description: "New value for the field" },
      },
      required: ["identifier", "field", "value"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const client = await resolveClient(ctx.supabase, input, ctx.clients || []);
    if (!client) return { error: "Client not found." };
    if (client._ambiguous) return { error: `Multiple matches: ${client.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
    const allowedFields = [
      "phone", "email", "address", "city", "state", "zip",
      "contact_name", "relationship", "care_recipient_name", "care_recipient_age",
      "care_needs", "hours_needed", "start_date_preference", "budget_range",
      "insurance_info", "referral_source", "referral_detail",
      "priority", "assigned_to", "lost_reason", "lost_detail",
    ];
    if (!allowedFields.includes(input.field)) return { error: `Field "${input.field}" cannot be updated. Allowed fields: ${allowedFields.join(", ")}` };
    return {
      requires_confirmation: true,
      action: "update_client_field",
      summary: `Update **${client.first_name} ${client.last_name}**'s **${input.field}** from "${client[input.field] || "(empty)"}" to "${input.value}"`,
      client_id: client.id,
      params: { field: input.field, value: input.value },
    };
  },
  async (_action: string, clientId: string, params: any, supabase: any, _currentUser: string): Promise<ToolResult> => {
    const { data: client, error: fetchErr } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (fetchErr || !client) return { error: "Client not found." };
    const { error } = await supabase.from("clients").update({ [params.field]: params.value }).eq("id", clientId);
    if (error) return { error: error.message };
    return { success: true, message: `${client.first_name} ${client.last_name}'s ${params.field} updated to "${params.value}".` };
  },
);
