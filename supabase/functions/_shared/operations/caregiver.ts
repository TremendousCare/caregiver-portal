// ─── Caregiver Write Operations ───
// Shared business logic for caregiver mutations.
// Used by both ai-chat confirmed handlers and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";
import { getPhaseLabel } from "../helpers/caregiver.ts";
import { UPDATABLE_CAREGIVER_FIELDS } from "./constants.ts";

/** Move caregiver to a new pipeline phase, logging a note */
export async function updateCaregiverPhase(
  supabase: any,
  caregiverId: string,
  newPhase: string,
  reason: string | undefined,
  actor: string,
): Promise<OperationResult> {
  const { data: cg, error: fetchErr } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", caregiverId)
    .single();
  if (fetchErr || !cg)
    return { success: false, message: "", error: "Caregiver not found." };

  const timestamps = { ...(cg.phase_timestamps || {}), [newPhase]: Date.now() };
  const { error } = await supabase
    .from("caregivers")
    .update({ phase_override: newPhase, phase_timestamps: timestamps })
    .eq("id", caregiverId);
  if (error)
    return { success: false, message: "", error: error.message };

  const phaseLabel = getPhaseLabel(newPhase);
  const note = createNote(
    { text: `Phase changed to ${phaseLabel}${reason ? `: ${reason}` : ""}` },
    actor,
  );
  await supabase
    .from("caregivers")
    .update({ notes: [...(cg.notes || []), note] })
    .eq("id", caregiverId);

  return {
    success: true,
    message: `${cg.first_name} ${cg.last_name} moved to ${phaseLabel}.`,
  };
}

/** Mark a caregiver task as complete */
export async function completeCaregiverTask(
  supabase: any,
  caregiverId: string,
  taskName: string,
  actor: string,
): Promise<OperationResult> {
  const { data: cg, error: fetchErr } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", caregiverId)
    .single();
  if (fetchErr || !cg)
    return { success: false, message: "", error: "Caregiver not found." };

  const tasks = { ...(cg.tasks || {}) };
  tasks[taskName] = {
    completed: true,
    completedAt: Date.now(),
    completedBy: actor || "AI Assistant",
  };
  const { error } = await supabase
    .from("caregivers")
    .update({ tasks })
    .eq("id", caregiverId);
  if (error)
    return { success: false, message: "", error: error.message };

  return {
    success: true,
    message: `Task "${taskName}" completed for ${cg.first_name} ${cg.last_name}.`,
  };
}

/** Update a single caregiver field (with allowlist validation) */
export async function updateCaregiverField(
  supabase: any,
  caregiverId: string,
  field: string,
  value: string,
): Promise<OperationResult> {
  if (!(UPDATABLE_CAREGIVER_FIELDS as readonly string[]).includes(field)) {
    return {
      success: false,
      message: "",
      error: `Field "${field}" cannot be updated. Allowed: ${UPDATABLE_CAREGIVER_FIELDS.join(", ")}`,
    };
  }

  const { data: cg, error: fetchErr } = await supabase
    .from("caregivers")
    .select("first_name, last_name")
    .eq("id", caregiverId)
    .single();
  if (fetchErr || !cg)
    return { success: false, message: "", error: "Caregiver not found." };

  const { error } = await supabase
    .from("caregivers")
    .update({ [field]: value })
    .eq("id", caregiverId);
  if (error)
    return { success: false, message: "", error: error.message };

  return {
    success: true,
    message: `${cg.first_name} ${cg.last_name}'s ${field} updated to "${value}".`,
  };
}

/** Move caregiver to a different board column */
export async function updateBoardStatus(
  supabase: any,
  caregiverId: string,
  newStatus: string,
  note: string | undefined,
): Promise<OperationResult> {
  const { data: cg, error: fetchErr } = await supabase
    .from("caregivers")
    .select("first_name, last_name, board_note")
    .eq("id", caregiverId)
    .single();
  if (fetchErr || !cg)
    return { success: false, message: "", error: "Caregiver not found." };

  const { error } = await supabase
    .from("caregivers")
    .update({
      board_status: newStatus,
      board_note: note || cg.board_note,
      board_moved_at: Date.now(),
    })
    .eq("id", caregiverId);
  if (error)
    return { success: false, message: "", error: error.message };

  return {
    success: true,
    message: `${cg.first_name} ${cg.last_name} moved to "${newStatus}" on the board.`,
  };
}
