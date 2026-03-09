// ─── Client Write Operations ───
// Shared business logic for client mutations.
// Used by both ai-chat confirmed handlers and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";
import { UPDATABLE_CLIENT_FIELDS } from "./constants.ts";

/** Move client to a new pipeline phase, logging a note */
export async function updateClientPhase(
  supabase: any,
  clientId: string,
  newPhase: string,
  reason: string | undefined,
  actor: string,
): Promise<OperationResult> {
  const { data: client, error: fetchErr } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();
  if (fetchErr || !client)
    return { success: false, message: "", error: "Client not found." };

  const timestamps = {
    ...(client.phase_timestamps || {}),
    [newPhase]: Date.now(),
  };
  const { error } = await supabase
    .from("clients")
    .update({ phase: newPhase, phase_timestamps: timestamps })
    .eq("id", clientId);
  if (error)
    return { success: false, message: "", error: error.message };

  const note = createNote(
    { text: `Phase changed to ${newPhase}${reason ? `: ${reason}` : ""}` },
    actor,
  );
  await supabase
    .from("clients")
    .update({ notes: [...(client.notes || []), note] })
    .eq("id", clientId);

  return {
    success: true,
    message: `${client.first_name} ${client.last_name} moved to ${newPhase}.`,
  };
}

/** Mark a client task as complete */
export async function completeClientTask(
  supabase: any,
  clientId: string,
  taskId: string,
  actor: string,
): Promise<OperationResult> {
  const { data: client, error: fetchErr } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .single();
  if (fetchErr || !client)
    return { success: false, message: "", error: "Client not found." };

  const tasks = { ...(client.tasks || {}) };
  tasks[taskId] = {
    completed: true,
    completedAt: Date.now(),
    completedBy: actor || "AI Assistant",
  };
  const { error } = await supabase
    .from("clients")
    .update({ tasks })
    .eq("id", clientId);
  if (error)
    return { success: false, message: "", error: error.message };

  return {
    success: true,
    message: `Task "${taskId}" completed for ${client.first_name} ${client.last_name}.`,
  };
}

/** Update a single client field (with allowlist validation) */
export async function updateClientField(
  supabase: any,
  clientId: string,
  field: string,
  value: string,
): Promise<OperationResult> {
  if (!(UPDATABLE_CLIENT_FIELDS as readonly string[]).includes(field)) {
    return {
      success: false,
      message: "",
      error: `Field "${field}" cannot be updated. Allowed: ${UPDATABLE_CLIENT_FIELDS.join(", ")}`,
    };
  }

  const { data: client, error: fetchErr } = await supabase
    .from("clients")
    .select("first_name, last_name")
    .eq("id", clientId)
    .single();
  if (fetchErr || !client)
    return { success: false, message: "", error: "Client not found." };

  const { error } = await supabase
    .from("clients")
    .update({ [field]: value })
    .eq("id", clientId);
  if (error)
    return { success: false, message: "", error: error.message };

  return {
    success: true,
    message: `${client.first_name} ${client.last_name}'s ${field} updated to "${value}".`,
  };
}
