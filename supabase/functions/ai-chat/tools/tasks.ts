// ─── Follow-up Task Tools (Phase 3) ───
//
// Three tools that let the AI assistant participate in the user-
// created follow-ups loop:
//   • list_follow_ups (auto)      — read pending tasks for context
//   • create_follow_up (confirm)  — propose a new follow-up, user confirms
//   • complete_follow_up (confirm)— propose closing a task, user confirms
//
// Risk-level posture matches the rest of the assistant: read tools
// run automatically; any side-effect tool requires explicit user
// confirmation via the standard requires_confirmation flow. Per the
// design (docs/TASKS_AND_FOLLOWUPS.md §4.7), v1 has NO L4-auto path —
// every AI-created task is suggested-then-accepted.

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";

// ═══════════════════════════════════════════════════════════════
// Tool 1: list_follow_ups (auto)
// ═══════════════════════════════════════════════════════════════
// Returns concise summaries of pending follow-ups so the AI can
// reference them when answering "what's on my plate?" or
// "anything overdue for Maria?". Caps at 20 results to keep tokens
// in check.

registerTool(
  {
    name: "list_follow_ups",
    description:
      "List pending follow-up tasks. Use to answer questions like 'what's on my plate?', 'what's overdue?', 'any follow-ups for <caregiver/client>?'. Returns task IDs (needed for complete_follow_up), titles, due times, and entity links. Default scope is 'mine' (assigned to the current user).",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["mine", "all"],
          description: "Whose tasks to list. 'mine' = assigned to the current user (default). 'all' = every staff member's pending tasks.",
        },
        bucket: {
          type: "string",
          enum: ["overdue", "today", "upcoming", "all_open"],
          description: "Time window. 'overdue' = due_at < now. 'today' = due before end of today. 'upcoming' = today + tomorrow. 'all_open' = every pending or snoozed task (default 'today').",
        },
        caregiver_id: {
          type: "string",
          description: "Filter to tasks linked to this caregiver.",
        },
        client_id: {
          type: "string",
          description: "Filter to tasks linked to this client.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Max rows to return (default 10).",
        },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const scope = input.scope === "all" ? "all" : "mine";
    const bucket = input.bucket || "today";
    const limit = Math.max(1, Math.min(20, input.limit || 10));

    let q = ctx.supabase
      .from("follow_up_tasks")
      .select(`
        id, source, title, description, due_at, status, urgency,
        assigned_to, caregiver_id, client_id, created_at,
        follow_up_templates ( name )
      `)
      .in("status", bucket === "all_open" ? ["pending", "snoozed"] : ["pending"])
      .order("due_at", { ascending: true })
      .limit(limit);

    // Scope filter — current user's email. ctx.currentUserMailbox is
    // the canonical email; ctx.currentUser may be a display name.
    if (scope === "mine") {
      const email = ctx.currentUserMailbox || ctx.currentUser;
      if (email) q = q.eq("assigned_to", email);
    }

    // Time bucket filter.
    const now = new Date();
    if (bucket === "overdue") {
      q = q.lt("due_at", now.toISOString());
    } else if (bucket === "today") {
      const eod = new Date(now);
      eod.setHours(23, 59, 59, 999);
      q = q.lte("due_at", eod.toISOString());
    } else if (bucket === "upcoming") {
      const eot = new Date(now);
      eot.setDate(eot.getDate() + 1);
      eot.setHours(23, 59, 59, 999);
      q = q.lte("due_at", eot.toISOString());
    }

    // Entity filters.
    if (input.caregiver_id) q = q.eq("caregiver_id", input.caregiver_id);
    if (input.client_id) q = q.eq("client_id", input.client_id);

    const { data, error } = await q;
    if (error) return { error: `Could not load tasks: ${error.message}` };

    if (!data || data.length === 0) {
      return {
        scope,
        bucket,
        count: 0,
        tasks: [],
        summary: scope === "mine"
          ? `No ${bucket === "all_open" ? "open" : bucket} tasks assigned to you.`
          : `No ${bucket === "all_open" ? "open" : bucket} tasks across the team.`,
      };
    }

    // Build lookup maps from the pre-loaded arrays so we don't N+1
    // the DB for entity names.
    const caregiversById = new Map<string, any>(
      (ctx.caregivers || []).map((c: any) => [c.id, c]),
    );
    const clientsById = new Map<string, any>(
      (ctx.clients || []).map((c: any) => [c.id, c]),
    );

    const formatted = data.map((t: any) => {
      const title = t.title || t.follow_up_templates?.name || "Follow-up";
      const cg = t.caregiver_id ? caregiversById.get(t.caregiver_id) : null;
      const cl = t.client_id ? clientsById.get(t.client_id) : null;
      const entity = cg
        ? `caregiver: ${cg.first_name} ${cg.last_name}`
        : cl
        ? `client: ${cl.first_name} ${cl.last_name}`
        : "no entity link";
      const dueIso = t.due_at;
      const overdueMs = now.getTime() - new Date(dueIso).getTime();
      const dueLabel = overdueMs > 0
        ? `OVERDUE by ${Math.floor(overdueMs / 3600000)}h`
        : `due ${new Date(dueIso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
      return `[${t.id}] ${title} · ${entity} · ${dueLabel} · ${t.urgency}`;
    });

    return {
      scope,
      bucket,
      count: data.length,
      tasks: formatted,
    };
  },
);

// ═══════════════════════════════════════════════════════════════
// Tool 2: create_follow_up (confirm)
// ═══════════════════════════════════════════════════════════════
// Per docs/TASKS_AND_FOLLOWUPS.md §4.7, every AI-created task is
// suggested-then-accepted (L2 Confirm). The handler returns a
// requires_confirmation result with the full proposed row in
// `params`; the confirmed-handler does the actual INSERT.

registerTool(
  {
    name: "create_follow_up",
    description:
      "Propose a new follow-up task for the user to add to their dashboard. REQUIRES USER CONFIRMATION. Use when the conversation surfaces a clear next step that needs a reminder (e.g. 'follow up with X about Y on Friday', 'remind me to send the I-9 to Maria tomorrow'). Defaults: assignee = current user, urgency = 'warning'. Provide ISO 8601 due_at — the user's local time is fine; the system stores it as-is.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short imperative phrase — e.g. 'Call Maria re: I-9 paperwork', 'Send the Riverside proposal'. Max 200 chars.",
        },
        due_at: {
          type: "string",
          description: "ISO 8601 datetime when the task is due. Examples: '2026-06-15T09:00:00' (9am Pacific Jun 15), '2026-06-15T17:00:00'. If only a date is appropriate, append T17:00:00 (5pm) as the default.",
        },
        caregiver_id: {
          type: "string",
          description: "Optional — link to a caregiver. Provide ONLY if the task is clearly about a specific caregiver.",
        },
        client_id: {
          type: "string",
          description: "Optional — link to a client. Mutually exclusive with caregiver_id (one-entity-per-task rule).",
        },
        urgency: {
          type: "string",
          enum: ["critical", "warning", "info"],
          description: "Default 'warning'. Use 'critical' for compliance-deadline tasks; 'info' for low-stakes nudges.",
        },
        description: {
          type: "string",
          description: "Optional 1-2 sentence context the user will appreciate seeing when the task surfaces.",
        },
      },
      required: ["title", "due_at"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const title = String(input.title || "").trim();
    if (!title) return { error: "title is required" };
    if (!input.due_at) return { error: "due_at is required (ISO 8601)" };

    const parsedDue = new Date(input.due_at);
    if (Number.isNaN(parsedDue.getTime())) {
      return { error: `due_at "${input.due_at}" is not a valid ISO 8601 datetime` };
    }

    const urgency = (input.urgency || "warning").toLowerCase();
    if (!["critical", "warning", "info"].includes(urgency)) {
      return { error: "urgency must be critical, warning, or info" };
    }

    const caregiverId = input.caregiver_id || null;
    const clientId = input.client_id || null;
    if (caregiverId && clientId) {
      return { error: "A task can link to a caregiver OR a client, not both." };
    }

    // Resolve entity names for the confirmation summary.
    let entityLabel = "no entity link";
    if (caregiverId) {
      const cg = (ctx.caregivers || []).find((c: any) => c.id === caregiverId);
      entityLabel = cg ? `caregiver: ${cg.first_name} ${cg.last_name}` : `caregiver: ${caregiverId}`;
    } else if (clientId) {
      const cl = (ctx.clients || []).find((c: any) => c.id === clientId);
      entityLabel = cl ? `client: ${cl.first_name} ${cl.last_name}` : `client: ${clientId}`;
    }

    const assignedTo = ctx.currentUserMailbox || ctx.currentUser || null;
    const dueDisplay = parsedDue.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });

    const summary =
      `**Create Follow-up**\n\n` +
      `**Title:** ${title}\n` +
      `**Due:** ${dueDisplay}\n` +
      `**Urgency:** ${urgency}\n` +
      `**About:** ${entityLabel}\n` +
      `**Assigned to:** ${assignedTo || "(unassigned)"}` +
      (input.description ? `\n\n${input.description}` : "");

    return {
      requires_confirmation: true,
      action: "create_follow_up",
      summary,
      // The follow-up tasks system doesn't have a single "caregiver_id"
      // semantic the way other tools do (a task can link to a client
      // or to nothing), but the confirm-handler signature requires one.
      // Pass a sentinel and rely on params for the actual data.
      caregiver_id: caregiverId || "__no_caregiver__",
      params: {
        title,
        due_at: parsedDue.toISOString(),
        urgency,
        description: input.description || null,
        caregiver_id: caregiverId,
        client_id: clientId,
        assigned_to: assignedTo,
      },
    };
  },
  // Confirmed handler — INSERT into follow_up_tasks with source='ai'.
  async (_action: string, _caregiverId: string, params: any, supabase: any, currentUser: string, currentUserMailbox?: string | null): Promise<ToolResult> => {
    const row = {
      source: "ai",
      title: params.title,
      description: params.description || null,
      due_at: params.due_at,
      urgency: params.urgency || "warning",
      caregiver_id: params.caregiver_id || null,
      client_id: params.client_id || null,
      assigned_to: params.assigned_to || currentUserMailbox || currentUser || null,
      // created_by audit trail: 'ai:<acting user>' makes it obvious in
      // the table this came from the assistant rather than the user
      // typing into Cmd+K.
      created_by: `ai:${currentUserMailbox || currentUser || "unknown"}`,
    };
    const { data, error } = await supabase
      .from("follow_up_tasks")
      .insert(row)
      .select("id")
      .single();
    if (error) {
      // The DB shape CHECK is the source of truth; surface its
      // message so the user sees why (e.g. invalid combination).
      return { error: `Could not create task: ${error.message}` };
    }
    // Fire-and-forget event log for the situational-awareness layer.
    try {
      await supabase.from("events").insert({
        event_type: "task_created",
        entity_type: params.caregiver_id ? "caregiver" : params.client_id ? "client" : null,
        entity_id: null,
        actor: `ai:${currentUserMailbox || currentUser || "unknown"}`,
        payload: {
          task_id: data.id,
          source: "ai",
          title: params.title,
          due_at: params.due_at,
          assigned_to: row.assigned_to,
          caregiver_id: params.caregiver_id,
          client_id: params.client_id,
        },
      });
    } catch (err) {
      console.warn("[create_follow_up] event log failed:", err);
    }
    return {
      success: true,
      message: `Follow-up created: "${params.title}" — due ${new Date(params.due_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`,
      task_id: data.id,
    };
  },
);

// ═══════════════════════════════════════════════════════════════
// Tool 3: complete_follow_up (confirm)
// ═══════════════════════════════════════════════════════════════
// Use when the AI detects a task has already been handled via
// another channel — e.g. it sees an outbound SMS to Maria + an open
// "Call Maria" follow-up, and proposes closure. Always confirms
// first so an over-eager AI doesn't silently dismiss real work.

registerTool(
  {
    name: "complete_follow_up",
    description:
      "Propose marking a follow-up task as done. REQUIRES USER CONFIRMATION. Use only when you have a specific task_id (from list_follow_ups or the briefing context) AND clear evidence the action was completed (e.g. an outbound SMS already logged for the same entity). Never use to dismiss tasks the user hasn't acted on.",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "UUID of the follow_up_tasks row. Get this from list_follow_ups or the briefing.",
        },
        completion_note: {
          type: "string",
          description: "Optional short note for the audit trail — e.g. 'Sent SMS at 10:42am'.",
        },
      },
      required: ["task_id"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    if (!input.task_id) return { error: "task_id is required" };

    // Fetch the task so the confirmation summary is informative.
    const { data: task, error } = await ctx.supabase
      .from("follow_up_tasks")
      .select(`
        id, status, title, due_at, urgency,
        caregiver_id, client_id, assigned_to,
        follow_up_templates ( name )
      `)
      .eq("id", input.task_id)
      .maybeSingle();
    if (error) return { error: `Task lookup failed: ${error.message}` };
    if (!task) return { error: `No task found with id ${input.task_id}` };
    if (task.status !== "pending" && task.status !== "snoozed") {
      return { error: `Task is already ${task.status}; nothing to close.` };
    }

    const title = task.title || task.follow_up_templates?.name || "Follow-up";
    const dueDisplay = new Date(task.due_at).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });

    let entityLabel = "no entity link";
    if (task.caregiver_id) {
      const cg = (ctx.caregivers || []).find((c: any) => c.id === task.caregiver_id);
      entityLabel = cg ? `caregiver: ${cg.first_name} ${cg.last_name}` : `caregiver: ${task.caregiver_id}`;
    } else if (task.client_id) {
      const cl = (ctx.clients || []).find((c: any) => c.id === task.client_id);
      entityLabel = cl ? `client: ${cl.first_name} ${cl.last_name}` : `client: ${task.client_id}`;
    }

    const summary =
      `**Mark Follow-up Done**\n\n` +
      `**Task:** ${title}\n` +
      `**About:** ${entityLabel}\n` +
      `**Was due:** ${dueDisplay}` +
      (input.completion_note ? `\n**Note:** ${input.completion_note}` : "");

    return {
      requires_confirmation: true,
      action: "complete_follow_up",
      summary,
      caregiver_id: task.caregiver_id || "__no_caregiver__",
      params: {
        task_id: input.task_id,
        completion_note: input.completion_note || null,
      },
    };
  },
  // Confirmed handler — UPDATE status=done.
  async (_action: string, _caregiverId: string, params: any, supabase: any, currentUser: string, currentUserMailbox?: string | null): Promise<ToolResult> => {
    const completedBy = currentUserMailbox || currentUser || "ai";
    const { data, error } = await supabase
      .from("follow_up_tasks")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        completed_by: completedBy,
        completion_note: params.completion_note || null,
      })
      .eq("id", params.task_id)
      .select("id, title, caregiver_id, client_id")
      .single();
    if (error) return { error: `Could not close task: ${error.message}` };

    try {
      await supabase.from("events").insert({
        event_type: "task_completed",
        entity_type: data.caregiver_id ? "caregiver" : data.client_id ? "client" : null,
        entity_id: null,
        actor: `ai:${completedBy}`,
        payload: {
          task_id: data.id,
          completion_note: params.completion_note || null,
        },
      });
    } catch (err) {
      console.warn("[complete_follow_up] event log failed:", err);
    }

    return {
      success: true,
      message: `Follow-up closed: "${data.title || "Follow-up"}".`,
      task_id: data.id,
    };
  },
);
