// ─── Caregiver Write Tools ───
// add_note, draft_message (auto), update_phase, complete_task, update_caregiver_field, update_board_status (confirm)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { getPhase, resolveCaregiver } from "../helpers/caregiver.ts";

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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
    const newNote = {
      text: input.text,
      type: input.type || "note",
      direction: input.direction || null,
      outcome: input.outcome || null,
      timestamp: Date.now(),
      author: ctx.currentUser || "AI Assistant",
    };
    const { error } = await ctx.supabase
      .from("caregivers")
      .update({ notes: [...(cg.notes || []), newNote] })
      .eq("id", cg.id);
    if (error) return { error: `Failed to add note: ${error.message}` };
    return { success: true, message: `Note added to ${cg.first_name} ${cg.last_name}'s record.`, note: newNote };
  },
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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
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
  },
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
        new_phase: { type: "string", enum: ["Lead", "Phone Screen", "Interview", "Background Check", "Onboarding", "Active"], description: "The target phase" },
        reason: { type: "string", description: "Why this phase change is being made" },
      },
      required: ["new_phase"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
    return {
      requires_confirmation: true,
      action: "update_phase",
      summary: `Move **${cg.first_name} ${cg.last_name}** from **${getPhase(cg)}** to **${input.new_phase}**${input.reason ? ` \u2014 ${input.reason}` : ""}`,
      caregiver_id: cg.id,
      params: { new_phase: input.new_phase, reason: input.reason },
    };
  },
  // Confirmed handler
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const { data: cg, error: fetchErr } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
    if (fetchErr || !cg) return { error: "Caregiver not found." };
    const timestamps = { ...(cg.phase_timestamps || {}), [params.new_phase]: Date.now() };
    const { error } = await supabase.from("caregivers").update({ phase_override: params.new_phase, phase_timestamps: timestamps }).eq("id", caregiverId);
    if (error) return { error: error.message };
    const note = { text: `Phase changed to ${params.new_phase}${params.reason ? `: ${params.reason}` : ""}`, type: "note", timestamp: Date.now(), author: currentUser || "AI Assistant" };
    await supabase.from("caregivers").update({ notes: [...(cg.notes || []), note] }).eq("id", caregiverId);
    return { success: true, message: `${cg.first_name} ${cg.last_name} moved to ${params.new_phase}.` };
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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
    const tasks = cg.tasks || {};
    if (!(input.task_name in tasks)) return { error: `Task "${input.task_name}" not found. Available tasks: ${Object.keys(tasks).join(", ")}` };
    return {
      requires_confirmation: true,
      action: "complete_task",
      summary: `Mark task **"${input.task_name}"** as complete for **${cg.first_name} ${cg.last_name}**`,
      caregiver_id: cg.id,
      params: { task_name: input.task_name },
    };
  },
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    const { data: cg, error: fetchErr } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
    if (fetchErr || !cg) return { error: "Caregiver not found." };
    const tasks = { ...(cg.tasks || {}) };
    tasks[params.task_name] = { completed: true, completedAt: Date.now(), completedBy: currentUser || "AI Assistant" };
    const { error } = await supabase.from("caregivers").update({ tasks }).eq("id", caregiverId);
    if (error) return { error: error.message };
    return { success: true, message: `Task "${params.task_name}" completed for ${cg.first_name} ${cg.last_name}.` };
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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
    const allowedFields = ["phone", "email", "address", "city", "state", "zip", "per_id", "has_hca", "has_dl", "hca_expiration", "availability", "preferred_shift", "years_experience", "languages", "specializations", "certifications", "source", "source_detail"];
    if (!allowedFields.includes(input.field)) return { error: `Field "${input.field}" cannot be updated. Allowed fields: ${allowedFields.join(", ")}` };
    return {
      requires_confirmation: true,
      action: "update_caregiver_field",
      summary: `Update **${cg.first_name} ${cg.last_name}**'s **${input.field}** from "${cg[input.field] || "(empty)"}" to "${input.value}"`,
      caregiver_id: cg.id,
      params: { field: input.field, value: input.value },
    };
  },
  async (_action: string, caregiverId: string, params: any, supabase: any, _currentUser: string): Promise<ToolResult> => {
    const { data: cg, error: fetchErr } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
    if (fetchErr || !cg) return { error: "Caregiver not found." };
    const { error } = await supabase.from("caregivers").update({ [params.field]: params.value }).eq("id", caregiverId);
    if (error) return { error: error.message };
    return { success: true, message: `${cg.first_name} ${cg.last_name}'s ${params.field} updated to "${params.value}".` };
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
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
    if (!cg) return { error: "Caregiver not found." };
    if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
    return {
      requires_confirmation: true,
      action: "update_board_status",
      summary: `Move **${cg.first_name} ${cg.last_name}** on the board from **${cg.board_status || "(none)"}** to **${input.new_status}**${input.note ? ` \u2014 ${input.note}` : ""}`,
      caregiver_id: cg.id,
      params: { new_status: input.new_status, note: input.note },
    };
  },
  async (_action: string, caregiverId: string, params: any, supabase: any, _currentUser: string): Promise<ToolResult> => {
    const { data: cg, error: fetchErr } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
    if (fetchErr || !cg) return { error: "Caregiver not found." };
    const { error } = await supabase.from("caregivers").update({ board_status: params.new_status, board_note: params.note || cg.board_note, board_moved_at: Date.now() }).eq("id", caregiverId);
    if (error) return { error: error.message };
    return { success: true, message: `${cg.first_name} ${cg.last_name} moved to "${params.new_status}" on the board.` };
  },
);
