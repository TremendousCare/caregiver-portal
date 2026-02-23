// ─── Layer 3: Relevant Memory ───
// Queries context_memory for memories relevant to the current conversation.
// If viewing a specific entity: pulls episodic memories for that entity.
// If general conversation: pulls system-wide semantic/procedural memories.
// Uses keyword relevance scoring when a user query is provided.

const MAX_ENTITY_MEMORIES = 10;
const MAX_SYSTEM_MEMORIES = 8;
// Fetch more from DB so we can rank and filter client-side
const ENTITY_FETCH_LIMIT = 25;

// Common words to ignore when scoring relevance
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "about",
  "like", "through", "after", "over", "between", "out", "against", "during",
  "without", "before", "under", "around", "among", "and", "but", "or",
  "nor", "not", "so", "yet", "both", "either", "neither", "each", "every",
  "all", "any", "few", "more", "most", "other", "some", "such", "no",
  "only", "own", "same", "than", "too", "very", "just", "because", "if",
  "when", "where", "how", "what", "which", "who", "whom", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "him", "his", "she", "her", "it", "its", "they", "them", "their",
  "up", "then", "also", "tell", "show", "get", "give", "make",
]);

/**
 * Extract meaningful keywords from a text string.
 */
function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  return new Set(words.filter(w => w.length > 2 && !STOP_WORDS.has(w)));
}

/**
 * Score how relevant a memory is to the user's query.
 * Returns a number 0-1 based on keyword overlap.
 */
function scoreRelevance(memory: { content: string; tags?: string[] }, queryKeywords: Set<string>): number {
  if (queryKeywords.size === 0) return 0.5; // No query = neutral relevance, keep recency order
  const memoryText = memory.content + " " + (memory.tags || []).join(" ");
  const memoryKeywords = extractKeywords(memoryText);
  let matches = 0;
  for (const kw of queryKeywords) {
    if (memoryKeywords.has(kw)) matches++;
  }
  return queryKeywords.size > 0 ? matches / queryKeywords.size : 0;
}

export async function buildMemoryLayer(
  supabase: any,
  entityId: string | null,
  entityType: string | null,
  userQuery?: string,
): Promise<string> {
  try {
    const lines: string[] = [];
    const now = new Date().toISOString();
    const queryKeywords = userQuery ? extractKeywords(userQuery) : new Set<string>();

    // Run both queries in parallel — they are independent
    // Fetch more than needed so we can rank by relevance
    const entityQuery = (entityId && entityType)
      ? supabase
          .from("context_memory")
          .select("content, memory_type, confidence, created_at, tags")
          .eq("entity_type", entityType)
          .eq("entity_id", entityId)
          .is("superseded_by", null)
          .or("expires_at.is.null,expires_at.gt." + now)
          .order("created_at", { ascending: false })
          .limit(ENTITY_FETCH_LIMIT)
      : Promise.resolve({ data: null, error: null });

    const systemQuery = supabase
      .from("context_memory")
      .select("content, memory_type, confidence, tags")
      .or("entity_type.is.null,entity_type.eq.system")
      .is("superseded_by", null)
      .or("expires_at.is.null,expires_at.gt." + now)
      .in("memory_type", ["procedural", "preference", "semantic"])
      .gte("confidence", 0.7)
      .order("confidence", { ascending: false })
      .limit(MAX_SYSTEM_MEMORIES);

    const [
      { data: entityMemories, error: emErr },
      { data: systemMemories, error: smErr },
    ] = await Promise.all([entityQuery, systemQuery]);

    // Entity-specific memories — ranked by relevance when query is provided
    if (!emErr && entityMemories && entityMemories.length > 0) {
      let ranked = entityMemories;
      if (queryKeywords.size > 0) {
        ranked = entityMemories
          .map((mem: any) => ({ ...mem, _relevance: scoreRelevance(mem, queryKeywords) }))
          .sort((a: any, b: any) => b._relevance - a._relevance)
          .slice(0, MAX_ENTITY_MEMORIES);
      } else {
        ranked = entityMemories.slice(0, MAX_ENTITY_MEMORIES);
      }

      lines.push("**About this person (from past interactions):**");
      for (const mem of ranked) {
        const prefix = mem.memory_type === "preference" ? "[preference] " : "";
        lines.push(`- ${prefix}${mem.content}`);
      }
    }

    // System-wide memories
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
