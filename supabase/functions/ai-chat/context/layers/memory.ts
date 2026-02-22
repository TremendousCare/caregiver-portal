// ─── Layer 3: Relevant Memory ───
// Queries context_memory for memories relevant to the current conversation.
// If viewing a specific entity: pulls episodic memories for that entity.
// If general conversation: pulls system-wide semantic/procedural memories.

const MAX_ENTITY_MEMORIES = 10;
const MAX_SYSTEM_MEMORIES = 8;

export async function buildMemoryLayer(
  supabase: any,
  entityId: string | null,
  entityType: string | null,
): Promise<string> {
  try {
    const lines: string[] = [];

    if (entityId && entityType) {
      // Entity-specific: pull episodic memories for this caregiver/client
      const { data: entityMemories, error: emErr } = await supabase
        .from("context_memory")
        .select("content, memory_type, confidence, created_at")
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .is("superseded_by", null)
        .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(MAX_ENTITY_MEMORIES);

      if (!emErr && entityMemories && entityMemories.length > 0) {
        lines.push("**About this person (from past interactions):**");
        for (const mem of entityMemories) {
          const prefix = mem.memory_type === "preference" ? "[preference] " : "";
          lines.push(`- ${prefix}${mem.content}`);
        }
      }
    }

    // System-wide: pull procedural and preference memories
    const { data: systemMemories, error: smErr } = await supabase
      .from("context_memory")
      .select("content, memory_type, confidence, tags")
      .or("entity_type.is.null,entity_type.eq.system")
      .is("superseded_by", null)
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
      .in("memory_type", ["procedural", "preference", "semantic"])
      .gte("confidence", 0.7)
      .order("confidence", { ascending: false })
      .limit(MAX_SYSTEM_MEMORIES);

    if (!smErr && systemMemories && systemMemories.length > 0) {
      const procedural = systemMemories.filter((m: any) => m.memory_type === "procedural");
      const preferences = systemMemories.filter((m: any) => m.memory_type === "preference");
      const semantic = systemMemories.filter((m: any) => m.memory_type === "semantic");

      if (procedural.length > 0) {
        lines.push("**SOPs & Rules:**");
        for (const mem of procedural) {
          lines.push(`- ${mem.content}`);
        }
      }
      if (preferences.length > 0) {
        lines.push("**User Preferences:**");
        for (const mem of preferences) {
          lines.push(`- ${mem.content}`);
        }
      }
      if (semantic.length > 0) {
        lines.push("**Learned Patterns:**");
        for (const mem of semantic) {
          const conf = mem.confidence < 0.85 ? " (preliminary)" : "";
          lines.push(`- ${mem.content}${conf}`);
        }
      }
    }

    if (lines.length === 0) return "";

    return `## Memory & Context
${lines.join("\n")}`;
  } catch (err) {
    console.error("[context] Memory layer error:", err);
    return "";
  }
}
