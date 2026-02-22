// ─── Layer 4: Active Threads (Session Continuity) ───
// Queries context_snapshots for the user's last conversation summary
// and active threads. Gives the AI continuity across sessions.

export async function buildThreadLayer(
  supabase: any,
  currentUser: string,
): Promise<string> {
  try {
    const { data: snapshot, error } = await supabase
      .from("context_snapshots")
      .select("session_summary, active_threads, updated_at")
      .eq("user_id", currentUser)
      .single();

    if (error || !snapshot) return "";

    const lines: string[] = [];

    // Only include if snapshot is from within the last 7 days
    const snapshotAge = Date.now() - new Date(snapshot.updated_at).getTime();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    if (snapshotAge > SEVEN_DAYS) return "";

    if (snapshot.session_summary) {
      lines.push(`**Last session summary:** ${snapshot.session_summary}`);
    }

    const threads = snapshot.active_threads;
    if (Array.isArray(threads) && threads.length > 0) {
      lines.push("**Active threads from last session:**");
      for (const thread of threads.slice(0, 5)) {
        const status = thread.status ? ` (${thread.status})` : "";
        lines.push(`- ${thread.topic || "Unknown topic"}${status}`);
      }
    }

    if (lines.length === 0) return "";

    return `## Conversation Continuity
${lines.join("\n")}`;
  } catch (err) {
    console.error("[context] Thread layer error:", err);
    return "";
  }
}
