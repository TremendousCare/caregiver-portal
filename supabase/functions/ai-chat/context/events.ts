// ─── Event Bus: Unified Event Logger ───
// Emits structured events to the `events` table.
// Called from tool handlers after actions complete.
// Non-blocking: errors are logged but never thrown (events are observability, not critical path).

export interface EventPayload {
  entity_name?: string;
  [key: string]: any;
}

/**
 * Log an event to the unified event bus.
 * Fire-and-forget — never blocks the calling operation.
 */
export async function logEvent(
  supabase: any,
  eventType: string,
  entityType: "caregiver" | "client" | null,
  entityId: string | null,
  actor: string,
  payload: EventPayload = {},
): Promise<void> {
  try {
    await supabase.from("events").insert({
      event_type: eventType,
      entity_type: entityType,
      entity_id: entityId,
      actor,
      payload,
    });
  } catch (err) {
    console.error(`[events] Failed to log ${eventType}:`, err);
  }
}

/**
 * Log a memory observation to context_memory.
 * Used by the AI to record episodic observations after interactions.
 */
export async function storeMemory(
  supabase: any,
  memoryType: "episodic" | "semantic" | "procedural" | "preference",
  content: string,
  options: {
    entityType?: "caregiver" | "client" | "system";
    entityId?: string;
    confidence?: number;
    source?: "ai_observation" | "user_correction" | "outcome_analysis" | "manual";
    tags?: string[];
    expiresAt?: string;
  } = {},
): Promise<void> {
  try {
    await supabase.from("context_memory").insert({
      memory_type: memoryType,
      entity_type: options.entityType || null,
      entity_id: options.entityId || null,
      content,
      confidence: options.confidence ?? 1.0,
      source: options.source || "ai_observation",
      tags: options.tags || [],
      expires_at: options.expiresAt || null,
    });
  } catch (err) {
    console.error(`[memory] Failed to store ${memoryType} memory:`, err);
  }
}

/**
 * Save or update the user's context snapshot (session continuity).
 * Upserts by user_id — one snapshot per user.
 */
export async function saveContextSnapshot(
  supabase: any,
  userId: string,
  sessionSummary: string,
  activeThreads: Array<{ entity_id?: string; topic: string; status?: string }>,
): Promise<void> {
  try {
    await supabase.from("context_snapshots").upsert(
      {
        user_id: userId,
        session_summary: sessionSummary,
        active_threads: activeThreads,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  } catch (err) {
    console.error("[snapshot] Failed to save context snapshot:", err);
  }
}
