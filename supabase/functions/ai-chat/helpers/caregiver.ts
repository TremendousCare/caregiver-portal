// ─── Caregiver Helper Functions ───

export function detectPhase(cg: any): string {
  const phaseOrder = [
    "Lead",
    "Phone Screen",
    "Interview",
    "Background Check",
    "Onboarding",
    "Active",
  ];
  const timestamps = cg.phase_timestamps || {};
  let currentPhase = "Lead";
  for (const phase of phaseOrder) {
    if (timestamps[phase]) currentPhase = phase;
  }
  return currentPhase;
}

export function getPhase(cg: any): string {
  return cg.phase_override || detectPhase(cg);
}

export function getLastActivity(cg: any): number {
  let latest = cg.created_at || 0;
  const notes = cg.notes || [];
  for (const n of notes) {
    const d = typeof n === "string" ? 0 : (n.timestamp || n.date || 0);
    if (d > latest) latest = d;
  }
  const tasks = cg.tasks || {};
  for (const val of Object.values(tasks)) {
    const t = (val as any)?.completedAt || 0;
    if (t > latest) latest = t;
  }
  return latest;
}

export function buildCaregiverSummary(cg: any): string {
  const phase = getPhase(cg);
  const tasks = cg.tasks || {};
  const completedTasks = Object.values(tasks).filter(
    (t: any) => t === true || t?.completed,
  ).length;
  const totalTasks = Object.keys(tasks).length;
  return `${cg.first_name} ${cg.last_name} | Phase: ${phase} | Tasks: ${completedTasks}/${totalTasks} | Phone: ${cg.phone || "N/A"} | City: ${cg.city || "N/A"}${cg.archived ? " [ARCHIVED]" : ""}`;
}

export function buildCaregiverProfile(cg: any): string {
  const phase = getPhase(cg);
  const tasks = cg.tasks || {};
  const completedTasks = Object.values(tasks).filter(
    (t: any) => t === true || t?.completed,
  ).length;
  const totalTasks = Object.keys(tasks).length;
  const daysInPipeline = cg.created_at
    ? Math.floor((Date.now() - cg.created_at) / 86400000)
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

  const allNotes = cg.notes || [];
  const MAX_NOTES = 50;
  const truncatedNotes = allNotes.length > MAX_NOTES ? allNotes.slice(-MAX_NOTES) : allNotes;
  const notesOmitted = allNotes.length > MAX_NOTES ? allNotes.length - MAX_NOTES : 0;
  const notes = truncatedNotes
    .map((n: any, i: number) => {
      const idx = notesOmitted + i + 1;
      if (typeof n === "string") return `  ${idx}. ${n}`;
      const ts = n.timestamp || n.date;
      const dateStr = ts ? new Date(ts).toLocaleDateString() : "";
      return `  ${idx}. [${dateStr}] ${n.type || "note"}${n.direction ? ` (${n.direction})` : ""}${n.outcome ? ` \u2014 ${n.outcome}` : ""}: ${n.text || ""} ${n.author ? `(by ${n.author})` : ""}`;
    })
    .join("\n");
  const notesHeader = notesOmitted > 0 ? `  (${notesOmitted} older notes not shown)\n` : "";

  return `### ${cg.first_name} ${cg.last_name} (ID: ${cg.id})${cg.archived ? " [ARCHIVED]" : ""}
- Phase: ${phase} | Tasks: ${completedTasks}/${totalTasks} | Days in pipeline: ${daysInPipeline}
- Phone: ${cg.phone || "N/A"} | Email: ${cg.email || "N/A"}
- Address: ${[cg.address, cg.city, cg.state, cg.zip].filter(Boolean).join(", ") || "N/A"}
- Source: ${cg.source || "N/A"}${cg.source_detail ? ` (${cg.source_detail})` : ""}
- HCA: ${cg.has_hca || "N/A"} | HCA Expiration: ${cg.hca_expiration || "N/A"} | DL: ${cg.has_dl || "N/A"}
- PER ID: ${cg.per_id || "N/A"}
- Experience: ${cg.years_experience || "N/A"} | Languages: ${cg.languages || "N/A"}
- Specializations: ${cg.specializations || "N/A"} | Certifications: ${cg.certifications || "N/A"}
- Preferred Shift: ${cg.preferred_shift || "N/A"} | Availability: ${cg.availability || "N/A"}
- Application Date: ${cg.application_date || "N/A"}
- Board Status: ${cg.board_status || "N/A"}${cg.board_note ? ` (${cg.board_note})` : ""}
${cg.archived ? `- Archive Reason: ${cg.archive_reason || "N/A"} | Phase at archive: ${cg.archive_phase || "N/A"}\n- Archive Detail: ${cg.archive_detail || "N/A"}` : ""}- Tasks:\n${taskList || "  None"}
- Activity Log:\n${notesHeader}${notes || "  No notes"}`;
}

export async function resolveCaregiver(
  supabase: any,
  input: { caregiver_id?: string; name?: string },
  caregivers: any[],
): Promise<any | null> {
  if (input.caregiver_id) {
    return caregivers.find((c: any) => c.id === input.caregiver_id) || null;
  }
  if (input.name) {
    const q = input.name.toLowerCase();
    const matches = caregivers.filter((c: any) => {
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
