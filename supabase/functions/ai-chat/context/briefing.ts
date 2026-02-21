// ─── Briefing Generator ───
// Builds a proactive briefing when the user opens the chat.
// Returns structured data (not an AI response) — fast, no Claude call needed.
// The frontend renders this as a contextual welcome message.

const HOURS_24 = 24 * 60 * 60 * 1000;

export interface BriefingItem {
  type: "urgent" | "info" | "suggestion";
  text: string;
  entityId?: string;
  entityType?: string;
  action?: string; // suggested quick action prompt
}

export interface Briefing {
  greeting: string;
  items: BriefingItem[];
  quickActions: Array<{ label: string; prompt: string }>;
}

export async function generateBriefing(
  supabase: any,
  currentUser: string,
  caregivers: any[],
  clients: any[],
): Promise<Briefing> {
  const now = Date.now();
  const items: BriefingItem[] = [];
  const quickActions: Array<{ label: string; prompt: string }> = [];

  // ── 1. Check for recent inbound messages (need attention) ──
  try {
    const since = new Date(now - HOURS_24).toISOString();
    const { data: recentInbound } = await supabase
      .from("events")
      .select("entity_type, entity_id, payload, created_at")
      .eq("event_type", "sms_received")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);

    if (recentInbound && recentInbound.length > 0) {
      const names = recentInbound
        .map((e: any) => e.payload?.entity_name)
        .filter(Boolean);
      if (names.length > 0) {
        items.push({
          type: "urgent",
          text: `New message(s) from ${[...new Set(names)].join(", ")}`,
          action: "Show me recent inbound messages",
        });
      }
    }
  } catch { /* ignore */ }

  // ── 2. Check for stale caregivers (no activity in 3+ days) ──
  const activeCaregivers = caregivers.filter((c: any) => !c.archived);
  const staleCaregivers = activeCaregivers.filter((c: any) => {
    const notes = c.notes || [];
    let lastActivity = c.created_at || 0;
    for (const n of notes) {
      const ts = typeof n === "string" ? 0 : (n.timestamp || 0);
      if (ts > lastActivity) lastActivity = ts;
    }
    const daysSince = (now - lastActivity) / 86400000;
    return daysSince >= 3;
  });

  if (staleCaregivers.length > 0) {
    const top3 = staleCaregivers.slice(0, 3).map((c: any) => `${c.first_name} ${c.last_name}`);
    items.push({
      type: "urgent",
      text: `${staleCaregivers.length} caregiver(s) need follow-up: ${top3.join(", ")}${staleCaregivers.length > 3 ? ` +${staleCaregivers.length - 3} more` : ""}`,
      action: "Who needs follow-up? Show me stale leads",
    });
    quickActions.push({
      label: `Follow up (${staleCaregivers.length})`,
      prompt: "Who needs follow-up? Show me stale leads that need attention",
    });
  }

  // ── 3. Check for new applications (last 24h) ──
  const newCaregivers = activeCaregivers.filter((c: any) => {
    return c.created_at && (now - c.created_at) < HOURS_24;
  });
  if (newCaregivers.length > 0) {
    const names = newCaregivers.map((c: any) => `${c.first_name} ${c.last_name}`);
    items.push({
      type: "info",
      text: `${newCaregivers.length} new application(s): ${names.join(", ")}`,
    });
    quickActions.push({
      label: `New applicants (${newCaregivers.length})`,
      prompt: `Tell me about the ${newCaregivers.length} new caregiver application(s) from today`,
    });
  }

  // ── 4. Check for stale clients ──
  const activeClients = (clients || []).filter((c: any) => !c.archived);
  const staleClients = activeClients.filter((c: any) => {
    const phase = c.phase || "new_lead";
    if (phase === "won" || phase === "lost") return false;
    const notes = c.notes || [];
    let lastActivity = c.created_at || 0;
    for (const n of notes) {
      const ts = typeof n === "string" ? 0 : (n.timestamp || 0);
      if (ts > lastActivity) lastActivity = ts;
    }
    return (now - lastActivity) / 86400000 >= 3;
  });

  if (staleClients.length > 0) {
    items.push({
      type: "info",
      text: `${staleClients.length} client(s) need follow-up`,
      action: "Show me stale clients that need follow-up",
    });
  }

  // ── 5. Check last session context ──
  try {
    const { data: snapshot } = await supabase
      .from("context_snapshots")
      .select("session_summary, active_threads, updated_at")
      .eq("user_id", currentUser)
      .single();

    if (snapshot) {
      const snapshotAge = now - new Date(snapshot.updated_at).getTime();
      if (snapshotAge < 7 * 24 * 60 * 60 * 1000) {
        const threads = snapshot.active_threads;
        if (Array.isArray(threads) && threads.length > 0) {
          const firstThread = threads[0];
          if (firstThread?.topic) {
            quickActions.push({
              label: "Continue last session",
              prompt: `Last time we discussed: ${firstThread.topic}. Can you pick up where we left off?`,
            });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // ── 6. Always include pipeline summary ──
  quickActions.push({
    label: "Pipeline summary",
    prompt: "Give me a quick summary of the current pipeline",
  });

  // ── 7. Add compliance check if needed ──
  quickActions.push({
    label: "Compliance check",
    prompt: "Run a compliance check across all caregivers",
  });

  // ── Build greeting ──
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const greeting = `Good ${timeOfDay}${currentUser ? `, ${currentUser}` : ""}!`;

  return {
    greeting,
    items,
    quickActions: quickActions.slice(0, 4), // Max 4 quick actions
  };
}
