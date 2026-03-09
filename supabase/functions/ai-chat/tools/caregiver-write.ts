// ─── Caregiver Write Tools ───
// add_note, draft_message (auto), update_phase, complete_task, update_caregiver_field, update_board_status (confirm)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { getPhase, getPhaseLabel } from "../helpers/caregiver.ts";
import { CAREGIVER_PHASES } from "../config.ts";
import { requireCaregiver, withResolve } from "../helpers/resolve.ts";
import { appendCaregiverNote } from "../../_shared/operations/notes.ts";
import {
  updateCaregiverPhase,
  completeCaregiverTask,
  updateCaregiverField,
  updateBoardStatus,
} from "../../_shared/operations/caregiver.ts";
import { UPDATABLE_CAREGIVER_FIELDS } from "../../_shared/operations/constants.ts";

// ── add_note (auto) ──

registerTool(
  {
    name: "add_note",
    description:
      "Add a timestamped note to a caregiver's record. Use this when the user asks to log a call, add a note, or record an interaction.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        text: { type: "string", description: "The note content" },
        type: { type: "string", enum: ["note", "call", "text", "email", "voicemail", "meeting"], description: "Type of interaction (default: note)" },
        direction: { type: "string", enum: ["inbound", "outbound"], description: "Direction of communication if applicable" },
        outcome: { type: "string", description: "Outcome of the interaction (e.g., 'left voicemail', 'scheduled interview')" },
      },
      required: ["text"],
    },
    riskLevel: "auto",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    const result = await appendCaregiverNote(ctx.supabase, cg.id, input, ctx.currentUser);
    if (!result.success) return { error: result.error };
    return { success: true, message: result.message, note: result.data?.note };
  }),
);

// ── draft_message (auto) ──

registerTool(
  {
    name: "draft_message",
    description:
      "Generate a follow-up text/email draft for a caregiver. The draft is displayed to the user, NOT sent. Use this to gather context before calling send_sms or send_email.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        channel: { type: "string", enum: ["text", "email"], description: "Message channel (default: text)" },
        purpose: { type: "string", description: "Purpose of the message (follow-up, scheduling, reminder, etc.)" },
        tone: { type: "string", enum: ["professional", "friendly", "urgent"], description: "Tone (default: professional)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    return {
      _draft_context: true,
      caregiver_name: `${cg.first_name} ${cg.last_name}`,
      caregiver_id: cg.id,
      phone: cg.phone,
      email: cg.email,
      phase: getPhase(cg),
      channel: input.channel || "text",
      purpose: input.purpose || "follow-up",
      tone: input.tone || "professional",
      recent_notes: (cg.notes || []).slice(-3),
      days_in_pipeline: cg.created_at ? Math.floor((Date.now() - cg.created_at) / 86400000) : 0,
    };
  }),
);

// ── update_phase (confirm) ──

registerTool(
  {
    name: "update_phase",
    description: "Move a caregiver to a different pipeline phase. REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        new_phase: { type: "string", enum: [...CAREGIVER_PHASES], description: "The target phase (intake, interview, onboarding, verification, orientation)" },
        reason: { type: "string", description: "Why this phase change is being made" },
      },
      required: ["new_phase"],
    },
    riskLevel: "confirm",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    return {
      requires_confirmation: true,
      action: "update_phase",
      summary: `Move **${cg.first_name} ${cg.last_name}** from **${getPhaseLabel(getPhase(cg))}** to **${getPhaseLabel(input.new_phase)}**${input.reason ? ` \u2014 ${input.reason}` : ""}`,
      caregiver_id: cg.id,
      params: { new_phase: input.new_phase, reason: input.reason },
    };
  }),
  // Confirmed handler — delegates to shared operation
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const result = await updateCaregiverPhase(supabase, caregiverId, params.new_phase, params.reason, currentUser);
    return result.success ? { success: true, message: result.message } : { error: result.error };
  },
);

// ── complete_task (confirm) ──

registerTool(
  {
    name: "complete_task",
    description: "Mark a phase task as completed for a caregiver. REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        task_name: { type: "string", description: "The exact task name to mark complete" },
      },
      required: ["task_name"],
    },
    riskLevel: "confirm",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    const tasks = cg.tasks || {};
    if (!(input.task_name in tasks)) return { error: `Task "${input.task_name}" not found. Available tasks: ${Object.keys(tasks).join(", ")}` };
    return {
      requires_confirmation: true,
      action: "complete_task",
      summary: `Mark task **"${input.task_name}"** as complete for **${cg.first_name} ${cg.last_name}**`,
      caregiver_id: cg.id,
      params: { task_name: input.task_name },
    };
  }),
  // Confirmed handler — delegates to shared operation
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const result = await completeCaregiverTask(supabase, caregiverId, params.task_name, currentUser);
    return result.success ? { success: true, message: result.message } : { error: result.error };
  },
);

// ── update_caregiver_field (confirm) ──

registerTool(
  {
    name: "update_caregiver_field",
    description: "Update a specific field on a caregiver's record (phone, email, address, etc.). REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        field: { type: "string", description: "Field to update (phone, email, address, city, state, zip, etc.)" },
        value: { type: "string", description: "New value for the field" },
      },
      required: ["field", "value"],
    },
    riskLevel: "confirm",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    if (!(UPDATABLE_CAREGIVER_FIELDS as readonly string[]).includes(input.field)) return { error: `Field "${input.field}" cannot be updated. Allowed fields: ${UPDATABLE_CAREGIVER_FIELDS.join(", ")}` };
    return {
      requires_confirmation: true,
      action: "update_caregiver_field",
      summary: `Update **${cg.first_name} ${cg.last_name}**'s **${input.field}** from "${cg[input.field] || "(empty)"}" to "${input.value}"`,
      caregiver_id: cg.id,
      params: { field: input.field, value: input.value },
    };
  }),
  // Confirmed handler — delegates to shared operation
  async (_action: string, caregiverId: string, params: any, supabase: any, _currentUser: string): Promise<ToolResult> => {
    const result = await updateCaregiverField(supabase, caregiverId, params.field, params.value);
    return result.success ? { success: true, message: result.message } : { error: result.error };
  },
);

// ── update_board_status (confirm) ──

registerTool(
  {
    name: "update_board_status",
    description: "Move a caregiver to a different column on the Kanban board. REQUIRES USER CONFIRMATION.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string", description: "The caregiver's ID" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        new_status: { type: "string", description: "The target board column/status" },
        note: { type: "string", description: "Optional note about the move" },
      },
      required: ["new_status"],
    },
    riskLevel: "confirm",
  },
  withResolve(async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await requireCaregiver(input, ctx);
    return {
      requires_confirmation: true,
      action: "update_board_status",
      summary: `Move **${cg.first_name} ${cg.last_name}** on the board from **${cg.board_status || "(none)"}** to **${input.new_status}**${input.note ? ` \u2014 ${input.note}` : ""}`,
      caregiver_id: cg.id,
      params: { new_status: input.new_status, note: input.note },
    };
  }),
  // Confirmed handler — delegates to shared operation
  async (_action: string, caregiverId: string, params: any, supabase: any, _currentUser: string): Promise<ToolResult> => {
    const result = await updateBoardStatus(supabase, caregiverId, params.new_status, params.note);
    return result.success ? { success: true, message: result.message } : { error: result.error };
  },
);
