// ─── Calendar Operations ───
// Shared calendar event logic for both ai-chat and autonomous Edge Functions.

import type { OperationResult } from "./types.ts";
import { createNote } from "./notes.ts";

/** Create a calendar event via Outlook Edge Function and log a note */
export async function createCalendarEvent(
  supabase: any,
  caregiverId: string | null,
  params: {
    title: string;
    date: string;
    start_time: string;
    end_time: string;
    caregiver_email: string | null;
    additional_attendees: string | null;
    location: string | null;
    description: string | null;
    is_online: boolean;
  },
  actor: string,
): Promise<OperationResult> {
  let cg: any = null;
  if (caregiverId && caregiverId !== "__no_caregiver__") {
    const { data } = await supabase
      .from("caregivers")
      .select("*")
      .eq("id", caregiverId)
      .single();
    cg = data;
  }

  const {
    title,
    date,
    start_time,
    end_time,
    caregiver_email,
    additional_attendees,
    location,
    description,
    is_online,
  } = params;
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    const attendees: string[] = [];
    if (caregiver_email) attendees.push(caregiver_email);
    if (additional_attendees) {
      attendees.push(
        ...additional_attendees
          .split(",")
          .map((e: string) => e.trim())
          .filter(Boolean),
      );
    }

    const start_datetime = `${date}T${start_time}:00`;
    const end_datetime = `${date}T${end_time}:00`;

    const response = await fetch(
      `${supabaseUrl}/functions/v1/outlook-integration`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          action: "create_event",
          subject: title,
          start_datetime,
          end_datetime,
          attendees,
          location: location || null,
          description: description || null,
          is_online_meeting: is_online || false,
        }),
      },
    );
    const result = await response.json();
    if (result.error)
      return { success: false, message: "", error: result.error };

    if (cg) {
      const eventNote = createNote(
        {
          text: `Calendar event created \u2014 "${title}" on ${result.start_display || date} ${start_time}-${end_time}${attendees.length > 0 ? ` with ${attendees.join(", ")}` : ""}`,
          type: "meeting",
          direction: "outbound",
          outcome: "calendar invite sent",
        },
        actor,
      );
      await supabase
        .from("caregivers")
        .update({ notes: [...(cg.notes || []), eventNote] })
        .eq("id", caregiverId);
    }

    const meetingLink = result.online_meeting_url
      ? `\nTeams Meeting Link: ${result.online_meeting_url}`
      : "";
    return {
      success: true,
      message: `Calendar event created: "${title}" on ${result.start_display || date} (${start_time}-${end_time} PT).${result.attendees_count > 0 ? ` Invitations sent to ${result.attendees_count} attendee(s).` : ""}${meetingLink}${cg ? ` Logged to ${cg.first_name} ${cg.last_name}'s record.` : ""}`,
      data: { event_id: result.event_id },
    };
  } catch (err) {
    console.error("create_calendar_event error:", err);
    return {
      success: false,
      message: "",
      error: `Failed to create calendar event: ${(err as Error).message}`,
    };
  }
}

/** Update an existing calendar event via Outlook Edge Function and log a note */
export async function updateCalendarEvent(
  supabase: any,
  caregiverId: string | null,
  params: {
    event_id: string;
    title: string | null;
    date: string | null;
    start_time: string | null;
    end_time: string | null;
    location: string | null;
    description: string | null;
    caregiver_name: string | null;
  },
  actor: string,
): Promise<OperationResult> {
  let cg: any = null;
  if (caregiverId && caregiverId !== "__no_caregiver__") {
    const { data } = await supabase
      .from("caregivers")
      .select("*")
      .eq("id", caregiverId)
      .single();
    cg = data;
  }

  const { event_id, title, date, start_time, end_time, location, description } =
    params;
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    let start_datetime = null;
    let end_datetime = null;
    if (date && start_time) start_datetime = `${date}T${start_time}:00`;
    if (date && end_time) end_datetime = `${date}T${end_time}:00`;

    const response = await fetch(
      `${supabaseUrl}/functions/v1/outlook-integration`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          action: "update_event",
          event_id,
          subject: title || null,
          start_datetime,
          end_datetime,
          location: location || null,
          description: description || null,
        }),
      },
    );
    const result = await response.json();
    if (result.error)
      return { success: false, message: "", error: result.error };

    const changesList: string[] = [];
    if (title) changesList.push(`title to "${title}"`);
    if (date) changesList.push(`date to ${date}`);
    if (start_time) changesList.push(`start time to ${start_time}`);
    if (end_time) changesList.push(`end time to ${end_time}`);
    if (location) changesList.push(`location to "${location}"`);

    if (cg) {
      const updateNote = createNote(
        {
          text: `Calendar event updated \u2014 ${changesList.length > 0 ? `Changed ${changesList.join(", ")}` : "Updated event details"} (Event: ${result.subject || event_id})`,
          type: "meeting",
          direction: "outbound",
          outcome: "calendar event updated",
        },
        actor,
      );
      await supabase
        .from("caregivers")
        .update({ notes: [...(cg.notes || []), updateNote] })
        .eq("id", caregiverId);
    }

    return {
      success: true,
      message: `Calendar event updated: "${result.subject || title || event_id}".${changesList.length > 0 ? ` Changed: ${changesList.join(", ")}.` : ""}${result.start_display ? ` Now scheduled for ${result.start_display}.` : ""}${cg ? ` Logged to ${cg.first_name} ${cg.last_name}'s record.` : ""}`,
    };
  } catch (err) {
    console.error("update_calendar_event error:", err);
    return {
      success: false,
      message: "",
      error: `Failed to update calendar event: ${(err as Error).message}`,
    };
  }
}
