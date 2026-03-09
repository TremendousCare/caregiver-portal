// ─── Note Operations ───
// Shared note creation and appending for both caregivers and clients.
// Eliminates duplication across 7+ tool handlers.

import type { NoteInput, OperationResult } from "./types.ts";

/** Build a timestamped note object */
export function createNote(
  input: NoteInput,
  actor: string,
): Record<string, any> {
  return {
    text: input.text,
    type: input.type || "note",
    direction: input.direction || null,
    outcome: input.outcome || null,
    timestamp: Date.now(),
    author: actor || "AI Assistant",
  };
}

/** Append a note to a caregiver record */
export async function appendCaregiverNote(
  supabase: any,
  caregiverId: string,
  input: NoteInput,
  actor: string,
): Promise<OperationResult> {
  const { data: cg, error: fetchErr } = await supabase
    .from("caregivers")
    .select("notes, first_name, last_name")
    .eq("id", caregiverId)
    .single();
  if (fetchErr || !cg)
    return { success: false, message: "", error: "Caregiver not found." };

  const note = createNote(input, actor);
  const { error } = await supabase
    .from("caregivers")
    .update({ notes: [...(cg.notes || []), note] })
    .eq("id", caregiverId);
  if (error)
    return {
      success: false,
      message: "",
      error: `Failed to add note: ${error.message}`,
    };

  return {
    success: true,
    message: `Note added to ${cg.first_name} ${cg.last_name}'s record.`,
    data: { note },
  };
}

/** Append a note to a client record */
export async function appendClientNote(
  supabase: any,
  clientId: string,
  input: NoteInput,
  actor: string,
): Promise<OperationResult> {
  const { data: client, error: fetchErr } = await supabase
    .from("clients")
    .select("notes, first_name, last_name")
    .eq("id", clientId)
    .single();
  if (fetchErr || !client)
    return { success: false, message: "", error: "Client not found." };

  const note = createNote(input, actor);
  const { error } = await supabase
    .from("clients")
    .update({ notes: [...(client.notes || []), note] })
    .eq("id", clientId);
  if (error)
    return {
      success: false,
      message: "",
      error: `Failed to add note: ${error.message}`,
    };

  return {
    success: true,
    message: `Note added to ${client.first_name} ${client.last_name}'s record.`,
    data: { note },
  };
}
