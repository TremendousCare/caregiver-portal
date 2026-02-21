// ─── Layer 2: Situational Awareness ───
// Queries the events table for recent activity and surfaces what happened
// since the user's last session. Gives the AI awareness of the current state
// without needing to be told.

const HOURS_24 = 24 * 60 * 60 * 1000;

export async function buildSituationalLayer(supabase: any): Promise<string> {
  try {
    const since = new Date(Date.now() - HOURS_24).toISOString();

    // Fetch recent events (last 24h, max 50 to cap token usage)
    const { data: recentEvents, error } = await supabase
      .from("events")
      .select("event_type, entity_type, entity_id, actor, payload, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error || !recentEvents || recentEvents.length === 0) {
      return "";
    }

    // Group events by type for a concise summary
    const groups: Record<string, any[]> = {};
    for (const evt of recentEvents) {
      const key = evt.event_type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(evt);
    }

    const lines: string[] = [];

    // Summarize each event type concisely
    if (groups.sms_sent) {
      lines.push(`- ${groups.sms_sent.length} text message(s) sent`);
    }
    if (groups.sms_received) {
      const names = groups.sms_received
        .map((e: any) => e.payload?.entity_name)
        .filter(Boolean);
      if (names.length > 0) {
        lines.push(`- Inbound text(s) from: ${[...new Set(names)].join(", ")}`);
      } else {
        lines.push(`- ${groups.sms_received.length} inbound text(s) received`);
      }
    }
    if (groups.email_sent) {
      lines.push(`- ${groups.email_sent.length} email(s) sent`);
    }
    if (groups.email_received) {
      lines.push(`- ${groups.email_received.length} email(s) received`);
    }
    if (groups.phase_changed) {
      const details = groups.phase_changed
        .slice(0, 5)
        .map((e: any) => {
          const name = e.payload?.entity_name || "Unknown";
          const to = e.payload?.new_phase || "?";
          return `${name} → ${to}`;
        });
      lines.push(`- Phase changes: ${details.join("; ")}`);
    }
    if (groups.task_completed) {
      lines.push(`- ${groups.task_completed.length} task(s) completed`);
    }
    if (groups.note_added) {
      lines.push(`- ${groups.note_added.length} note(s) logged`);
    }
    if (groups.caregiver_created) {
      const names = groups.caregiver_created
        .map((e: any) => e.payload?.entity_name)
        .filter(Boolean);
      lines.push(`- New caregiver(s): ${names.length > 0 ? names.join(", ") : groups.caregiver_created.length}`);
    }
    if (groups.client_created) {
      const names = groups.client_created
        .map((e: any) => e.payload?.entity_name)
        .filter(Boolean);
      lines.push(`- New client(s): ${names.length > 0 ? names.join(", ") : groups.client_created.length}`);
    }
    if (groups.docusign_sent) {
      lines.push(`- ${groups.docusign_sent.length} DocuSign envelope(s) sent`);
    }
    if (groups.docusign_completed) {
      const names = groups.docusign_completed
        .map((e: any) => e.payload?.entity_name)
        .filter(Boolean);
      lines.push(`- DocuSign completed: ${names.length > 0 ? names.join(", ") : groups.docusign_completed.length}`);
    }
    if (groups.automation_fired) {
      lines.push(`- ${groups.automation_fired.length} automation(s) fired`);
    }
    if (groups.calendar_event_created) {
      lines.push(`- ${groups.calendar_event_created.length} calendar event(s) created`);
    }

    if (lines.length === 0) return "";

    return `## Recent Activity (Last 24 Hours)
${lines.join("\n")}`;
  } catch (err) {
    console.error("[context] Situational layer error:", err);
    return "";
  }
}
