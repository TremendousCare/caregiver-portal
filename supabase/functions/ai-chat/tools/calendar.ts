// ─── Outlook Calendar Tools ───
// get_calendar_events (auto), check_availability (auto), create_calendar_event (confirm), update_calendar_event (confirm)

import { registerTool } from "../registry.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config.ts";
import { resolveCaregiver } from "../helpers/caregiver.ts";

// ── get_calendar_events (auto) ──

registerTool(
  {
    name: "get_calendar_events",
    description:
      "Get upcoming calendar events from the company Outlook calendar. Can filter by date range and/or attendee. Returns event details including subject, time, location, attendees, and online meeting links.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date for the search range (YYYY-MM-DD format). Defaults to today." },
        end_date: { type: "string", description: "End date for the search range (YYYY-MM-DD format). Defaults to 7 days from start." },
        caregiver_id: { type: "string", description: "Filter events by caregiver (uses their email to match attendees)" },
        name: { type: "string", description: "Caregiver name if ID not known (used to filter by attendee email)" },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    let attendeeEmail = null;
    let caregiverName = null;

    if (input.caregiver_id || input.name) {
      const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
      if (!cg) return { error: "Caregiver not found. Please check the name or ID." };
      if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}. Please be more specific.` };
      caregiverName = `${cg.first_name} ${cg.last_name}`;
      attendeeEmail = cg.email || null;
      if (!attendeeEmail) return { error: `No email address on file for ${caregiverName}. Cannot filter calendar by attendee.` };
    }

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({
          action: "get_calendar_events",
          start_date: input.start_date || null,
          end_date: input.end_date || null,
          attendee_email: attendeeEmail,
        }),
      });
      const result = await response.json();
      if (result.error) return { error: result.error };
      return {
        caregiver_filter: caregiverName || null,
        calendar_mailbox: result.calendar_mailbox,
        date_range: { start: result.start_date, end: result.end_date },
        total_events: result.total_events,
        events: result.events.map((e: any) => {
          const attendeeStr = e.attendees.length > 0 ? `\n    Attendees: ${e.attendees.join(", ")}` : "";
          const locationStr = e.location !== "No location" ? `\n    Location: ${e.location}` : "";
          const previewStr = e.preview ? `\n    Notes: ${e.preview}` : "";
          return `  [${e.start_display} - ${e.end_display}] ${e.subject}\n    Organizer: ${e.organizer} | Status: ${e.show_as}${locationStr}${attendeeStr}${previewStr}\n    (event_id: ${e.id})`;
        }),
      };
    } catch (err) {
      console.error("get_calendar_events error:", err);
      return { error: `Failed to get calendar events: ${(err as Error).message}` };
    }
  },
);

// ── check_availability (auto) ──

registerTool(
  {
    name: "check_availability",
    description:
      "Check the calendar for available time slots on a specific date or date range. Returns free/busy information and available slots for scheduling interviews, orientations, or meetings.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Single date to check availability (YYYY-MM-DD). Checks business hours 8 AM - 6 PM." },
        start_date: { type: "string", description: "Start of date range (YYYY-MM-DD or ISO datetime). Use with end_date for multi-day or specific time range." },
        end_date: { type: "string", description: "End of date range (YYYY-MM-DD or ISO datetime). Use with start_date." },
      },
      required: [],
    },
    riskLevel: "auto",
  },
  async (input: any, _ctx: ToolContext): Promise<ToolResult> => {
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({
          action: "check_availability",
          date: input.date || null,
          start_date: input.start_date || null,
          end_date: input.end_date || null,
        }),
      });
      const result = await response.json();
      if (result.error) return { error: result.error };

      const busyFormatted = result.busy_slots.map((s: any) => {
        const startTime = s.start ? new Date(s.start).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "?";
        const endTime = s.end ? new Date(s.end).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "?";
        return `  ${startTime} - ${endTime}: ${s.subject} (${s.status})`;
      });

      const freeFormatted = result.free_slots.map((s: any) => {
        const startTime = new Date(s.start).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
        const endTime = new Date(s.end).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
        const durHrs = Math.floor(s.duration_minutes / 60);
        const durMin = s.duration_minutes % 60;
        const durStr = durHrs > 0 ? `${durHrs}h${durMin > 0 ? ` ${durMin}m` : ""}` : `${durMin}m`;
        return `  ${startTime} - ${endTime} (${durStr} available)`;
      });

      return {
        calendar_mailbox: result.calendar_mailbox,
        date_range: result.date_range,
        summary: result.summary,
        busy_slots: busyFormatted.length > 0 ? busyFormatted : ["No busy slots"],
        free_slots: freeFormatted.length > 0 ? freeFormatted : ["No free slots found"],
      };
    } catch (err) {
      console.error("check_availability error:", err);
      return { error: `Failed to check availability: ${(err as Error).message}` };
    }
  },
);

// ── create_calendar_event (confirm) ──

registerTool(
  {
    name: "create_calendar_event",
    description:
      "Create a new calendar event (interview, orientation, meeting) on the company Outlook calendar. REQUIRES USER CONFIRMATION. The event will be created and invitations sent to attendees. After creating, auto-logs a note to the caregiver record if linked.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title/subject (e.g., 'Interview with Sarah Johnson', 'Orientation - New Hires')" },
        date: { type: "string", description: "Event date in YYYY-MM-DD format" },
        start_time: { type: "string", description: "Start time in 24-hour format HH:MM (e.g., '14:00' for 2 PM). Timezone: Pacific." },
        end_time: { type: "string", description: "End time in 24-hour format HH:MM (e.g., '15:00' for 3 PM). Timezone: Pacific." },
        caregiver_id: { type: "string", description: "The caregiver's ID (will add their email as attendee)" },
        name: { type: "string", description: "Caregiver name if ID not known" },
        additional_attendees: { type: "string", description: "Comma-separated email addresses of additional attendees" },
        location: { type: "string", description: "Event location (address, room name, or Zoom/Teams link)" },
        description: { type: "string", description: "Event description/notes" },
        is_online: { type: "boolean", description: "Create as Teams online meeting (default false). Set to true for virtual interviews." },
      },
      required: ["title", "date", "start_time", "end_time"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    let caregiverEmail = null;
    let caregiverName = null;
    let caregiverIdForLog: string | null = null;

    if (input.caregiver_id || input.name) {
      const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
      if (!cg) return { error: "Caregiver not found." };
      if (cg._ambiguous) return { error: `Multiple matches: ${cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ")}.` };
      caregiverEmail = cg.email || null;
      caregiverName = `${cg.first_name} ${cg.last_name}`;
      caregiverIdForLog = cg.id;
    }

    const attendees: string[] = [];
    if (caregiverEmail) attendees.push(caregiverEmail);
    if (input.additional_attendees) {
      attendees.push(...input.additional_attendees.split(",").map((e: string) => e.trim()).filter(Boolean));
    }

    const summary = `**Create Calendar Event**\n\n**Title:** ${input.title}\n**Date:** ${input.date}\n**Time:** ${input.start_time} - ${input.end_time} PT${input.location ? `\n**Location:** ${input.location}` : ""}${attendees.length > 0 ? `\n**Attendees:** ${attendees.join(", ")}` : ""}${input.is_online ? "\n**Online Meeting:** Yes (Teams link will be generated)" : ""}`;

    return {
      requires_confirmation: true,
      action: "create_calendar_event",
      summary,
      caregiver_id: caregiverIdForLog || "__no_caregiver__",
      params: {
        title: input.title,
        date: input.date,
        start_time: input.start_time,
        end_time: input.end_time,
        caregiver_email: caregiverEmail,
        caregiver_name: caregiverName,
        additional_attendees: input.additional_attendees || null,
        location: input.location || null,
        description: input.description || null,
        is_online: input.is_online || false,
      },
    };
  },
  // Confirmed handler
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    let cg: any = null;
    if (caregiverId && caregiverId !== "__no_caregiver__") {
      const { data } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
      cg = data;
    }

    const { title, date, start_time, end_time, caregiver_email, additional_attendees, location, description, is_online } = params;
    try {
      const attendees: string[] = [];
      if (caregiver_email) attendees.push(caregiver_email);
      if (additional_attendees) {
        attendees.push(...additional_attendees.split(",").map((e: string) => e.trim()).filter(Boolean));
      }

      const start_datetime = `${date}T${start_time}:00`;
      const end_datetime = `${date}T${end_time}:00`;

      const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
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
      });
      const result = await response.json();
      if (result.error) return { error: result.error };

      if (cg) {
        const eventNote = {
          text: `Calendar event created \u2014 "${title}" on ${result.start_display || date} ${start_time}-${end_time}${attendees.length > 0 ? ` with ${attendees.join(", ")}` : ""}`,
          type: "meeting",
          direction: "outbound",
          outcome: "calendar invite sent",
          timestamp: Date.now(),
          author: currentUser || "AI Assistant",
        };
        await supabase.from("caregivers").update({ notes: [...(cg.notes || []), eventNote] }).eq("id", caregiverId);
      }

      const meetingLink = result.online_meeting_url ? `\nTeams Meeting Link: ${result.online_meeting_url}` : "";
      return {
        success: true,
        message: `Calendar event created: "${title}" on ${result.start_display || date} (${start_time}-${end_time} PT).${result.attendees_count > 0 ? ` Invitations sent to ${result.attendees_count} attendee(s).` : ""}${meetingLink}${cg ? ` Logged to ${cg.first_name} ${cg.last_name}'s record.` : ""}`,
        event_id: result.event_id,
      };
    } catch (err) {
      console.error("create_calendar_event error:", err);
      return { error: `Failed to create calendar event: ${(err as Error).message}` };
    }
  },
);

// ── update_calendar_event (confirm) ──

registerTool(
  {
    name: "update_calendar_event",
    description:
      "Update an existing calendar event (reschedule, change location, add attendees). REQUIRES USER CONFIRMATION. Use get_calendar_events first to find the event_id. Only provide fields you want to change.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The event ID (from get_calendar_events results). Required." },
        title: { type: "string", description: "New event title/subject" },
        date: { type: "string", description: "New date in YYYY-MM-DD format" },
        start_time: { type: "string", description: "New start time in 24-hour format HH:MM. Timezone: Pacific." },
        end_time: { type: "string", description: "New end time in 24-hour format HH:MM. Timezone: Pacific." },
        location: { type: "string", description: "New location" },
        description: { type: "string", description: "New description/notes" },
        caregiver_id: { type: "string", description: "Caregiver ID (for auto-logging the update)" },
        name: { type: "string", description: "Caregiver name if ID not known" },
      },
      required: ["event_id"],
    },
    riskLevel: "confirm",
  },
  async (input: any, ctx: ToolContext): Promise<ToolResult> => {
    let caregiverName = null;
    let caregiverIdForLog: string | null = null;

    if (input.caregiver_id || input.name) {
      const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
      if (cg && !cg._ambiguous) {
        caregiverName = `${cg.first_name} ${cg.last_name}`;
        caregiverIdForLog = cg.id;
      }
    }

    const changesList: string[] = [];
    if (input.title) changesList.push(`title to "${input.title}"`);
    if (input.date) changesList.push(`date to ${input.date}`);
    if (input.start_time) changesList.push(`start time to ${input.start_time}`);
    if (input.end_time) changesList.push(`end time to ${input.end_time}`);
    if (input.location) changesList.push(`location to "${input.location}"`);

    return {
      requires_confirmation: true,
      action: "update_calendar_event",
      summary: `**Update Calendar Event**\n\nEvent ID: ${input.event_id}\n${changesList.length > 0 ? `Changes: ${changesList.join(", ")}` : "No changes specified"}`,
      caregiver_id: caregiverIdForLog || "__no_caregiver__",
      params: {
        event_id: input.event_id,
        title: input.title || null,
        date: input.date || null,
        start_time: input.start_time || null,
        end_time: input.end_time || null,
        location: input.location || null,
        description: input.description || null,
        caregiver_name: caregiverName,
      },
    };
  },
  // Confirmed handler
  async (_action: string, caregiverId: string, params: any, supabase: any, currentUser: string): Promise<ToolResult> => {
    let cg: any = null;
    if (caregiverId && caregiverId !== "__no_caregiver__") {
      const { data } = await supabase.from("caregivers").select("*").eq("id", caregiverId).single();
      cg = data;
    }

    const { event_id, title, date, start_time, end_time, location, description, caregiver_name } = params;
    try {
      let start_datetime = null;
      let end_datetime = null;
      if (date && start_time) start_datetime = `${date}T${start_time}:00`;
      if (date && end_time) end_datetime = `${date}T${end_time}:00`;

      const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({
          action: "update_event",
          event_id,
          subject: title || null,
          start_datetime,
          end_datetime,
          location: location || null,
          description: description || null,
        }),
      });
      const result = await response.json();
      if (result.error) return { error: result.error };

      const changesList: string[] = [];
      if (title) changesList.push(`title to "${title}"`);
      if (date) changesList.push(`date to ${date}`);
      if (start_time) changesList.push(`start time to ${start_time}`);
      if (end_time) changesList.push(`end time to ${end_time}`);
      if (location) changesList.push(`location to "${location}"`);

      if (cg) {
        const updateNote = {
          text: `Calendar event updated \u2014 ${changesList.length > 0 ? `Changed ${changesList.join(", ")}` : "Updated event details"} (Event: ${result.subject || event_id})`,
          type: "meeting",
          direction: "outbound",
          outcome: "calendar event updated",
          timestamp: Date.now(),
          author: currentUser || "AI Assistant",
        };
        await supabase.from("caregivers").update({ notes: [...(cg.notes || []), updateNote] }).eq("id", caregiverId);
      }

      return {
        success: true,
        message: `Calendar event updated: "${result.subject || title || event_id}".${changesList.length > 0 ? ` Changed: ${changesList.join(", ")}.` : ""}${result.start_display ? ` Now scheduled for ${result.start_display}.` : ""}${cg ? ` Logged to ${cg.first_name} ${cg.last_name}'s record.` : ""}`,
      };
    } catch (err) {
      console.error("update_calendar_event error:", err);
      return { error: `Failed to update calendar event: ${(err as Error).message}` };
    }
  },
);
