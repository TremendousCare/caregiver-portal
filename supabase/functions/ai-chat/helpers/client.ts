// ─── Client Helper Functions ───

const CLIENT_PHASE_LABELS: Record<string, string> = {
  new_lead: "New Lead",
  initial_contact: "Initial Contact",
  consultation: "Consultation",
  assessment: "In-Home Assessment",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
  nurture: "Nurture",
};

export function getClientPhase(client: any): string {
  return client.phase || "new_lead";
}

export function getClientPhaseLabel(client: any): string {
  const phase = getClientPhase(client);
  return CLIENT_PHASE_LABELS[phase] || phase;
}

export function getClientLastActivity(client: any): number {
  let latest = client.created_at || 0;
  const notes = client.notes || [];
  for (const n of notes) {
    const d = typeof n === "string" ? 0 : (n.timestamp || n.date || 0);
    if (d > latest) latest = d;
  }
  const tasks = client.tasks || {};
  for (const val of Object.values(tasks)) {
    const t = (val as any)?.completedAt || 0;
    if (t > latest) latest = t;
  }
  return latest;
}

export function buildClientSummary(client: any): string {
  const phase = getClientPhaseLabel(client);
  const tasks = client.tasks || {};
  const completedTasks = Object.values(tasks).filter(
    (t: any) => t === true || t?.completed,
  ).length;
  const totalTasks = Object.keys(tasks).length;
  const daysSinceCreated = client.created_at
    ? Math.floor((Date.now() - client.created_at) / 86400000)
    : 0;
  return `${client.first_name} ${client.last_name} | Phase: ${phase} | Tasks: ${completedTasks}/${totalTasks} | Care needs: ${client.care_needs || "N/A"} | ${daysSinceCreated}d since created${client.archived ? " [ARCHIVED]" : ""}`;
}

export function buildClientProfile(client: any): string {
  const phase = getClientPhaseLabel(client);
  const tasks = client.tasks || {};
  const completedTasks = Object.values(tasks).filter(
    (t: any) => t === true || t?.completed,
  ).length;
  const totalTasks = Object.keys(tasks).length;
  const daysSinceCreated = client.created_at
    ? Math.floor((Date.now() - client.created_at) / 86400000)
    : 0;

  const phaseTimestamps = client.phase_timestamps || {};
  const currentPhase = getClientPhase(client);
  const phaseStart = phaseTimestamps[currentPhase];
  const daysInPhase = phaseStart
    ? Math.floor((Date.now() - phaseStart) / 86400000)
    : 0;

  const taskList = Object.entries(tasks)
    .map(([key, val]: [string, any]) => {
      const done = val === true || val?.completed;
      const completedAt = val?.completedAt
        ? new Date(val.completedAt).toLocaleDateString()
        : "";
      const completedBy = val?.completedBy || "";
      return `  - [${done ? "x" : " "}] ${key}${completedAt ? ` (completed ${completedAt}${completedBy ? ` by ${completedBy}` : ""})` : ""}`;
    })
    .join("\n");

  const allNotes = client.notes || [];
  const MAX_NOTES = 50;
  const truncatedNotes = allNotes.length > MAX_NOTES ? allNotes.slice(-MAX_NOTES) : allNotes;
  const notesOmitted = allNotes.length > MAX_NOTES ? allNotes.length - MAX_NOTES : 0;
  const notes = truncatedNotes
    .map((n: any, i: number) => {
      const idx = notesOmitted + i + 1;
      if (typeof n === "string") return `  ${idx}. ${n}`;
      const ts = n.timestamp || n.date;
      const dateStr = ts ? new Date(ts).toLocaleDateString() : "";
      return `  ${idx}. [${dateStr}] ${n.type || "note"}${n.direction ? ` (${n.direction})` : ""}${n.outcome ? ` — ${n.outcome}` : ""}: ${n.text || ""} ${n.author ? `(by ${n.author})` : ""}`;
    })
    .join("\n");
  const notesHeader = notesOmitted > 0 ? `  (${notesOmitted} older notes not shown)\n` : "";

  return `### ${client.first_name} ${client.last_name} (ID: ${client.id})${client.archived ? " [ARCHIVED]" : ""}
- Phase: ${phase} | Tasks: ${completedTasks}/${totalTasks} | Days since created: ${daysSinceCreated} | Days in phase: ${daysInPhase}
- Priority: ${client.priority || "normal"} | Assigned to: ${client.assigned_to || "Unassigned"}
- Phone: ${client.phone || "N/A"} | Email: ${client.email || "N/A"}
- Address: ${[client.address, client.city, client.state, client.zip].filter(Boolean).join(", ") || "N/A"}
- Contact: ${client.contact_name || "N/A"}${client.relationship ? ` (${client.relationship})` : ""}
- Care Recipient: ${client.care_recipient_name || "N/A"}${client.care_recipient_age ? `, age ${client.care_recipient_age}` : ""}
- Care Needs: ${client.care_needs || "N/A"}
- Hours Needed: ${client.hours_needed || "N/A"} | Start Preference: ${client.start_date_preference || "N/A"}
- Budget: ${client.budget_range || "N/A"} | Insurance: ${client.insurance_info || "N/A"}
- Source: ${client.referral_source || "N/A"}${client.referral_detail ? ` (${client.referral_detail})` : ""}
${client.phase === "lost" ? `- Lost Reason: ${client.lost_reason || "N/A"} | Detail: ${client.lost_detail || "N/A"}\n` : ""}${client.archived ? `- Archive Reason: ${client.archive_reason || "N/A"}\n- Archive Detail: ${client.archive_detail || "N/A"}\n` : ""}- Tasks:\n${taskList || "  None"}
- Activity Log:\n${notesHeader}${notes || "  No notes"}`;
}

export async function resolveClient(
  supabase: any,
  input: { client_id?: string; identifier?: string; name?: string },
  clients: any[],
): Promise<any | null> {
  // Try by explicit client_id first
  if (input.client_id) {
    return clients.find((c: any) => c.id === input.client_id) || null;
  }
  // Try by identifier (could be ID or name)
  const searchTerm = input.identifier || input.name;
  if (searchTerm) {
    // Check if it looks like a UUID (exact ID match)
    const idMatch = clients.find((c: any) => c.id === searchTerm);
    if (idMatch) return idMatch;

    // Fuzzy name match
    const q = searchTerm.toLowerCase();
    const matches = clients.filter((c: any) => {
      const full = `${c.first_name} ${c.last_name}`.toLowerCase();
      return (
        full.includes(q) ||
        c.first_name?.toLowerCase().includes(q) ||
        c.last_name?.toLowerCase().includes(q)
      );
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return { _ambiguous: true, matches };
  }
  return null;
}
