// ─── Call-derived context helpers (Phase 1.6.2) ───
//
// Three reusable, individually-testable functions that fetch the
// context a call-driven agent needs. Designed to be imported by:
//
//   * `runExtractorHandler` (Phase 1.6.2) — composes all three inline
//     to build the call_analyst's system prompt.
//   * `ai-chat/context/assembler.ts` (Phase 1.6.4) — wraps the same
//     primitives as a formal `callContext` assembler layer so the
//     recruiting agent can answer "what did Sarah say about her
//     availability last call?" from a chat session.
//   * Future agents (intake_analyst, scheduling_analyst) — same
//     reuse pattern.
//
// Each function returns a plain string suitable for concatenation
// into a system prompt. Returning structured data instead would push
// JSON-stringification (with token-budget consequences) to every
// caller; returning prompt-shaped strings keeps the helpers focused
// and the caller paths simple.
//
// All three are read-only and tolerate failure by returning an empty
// string + logging — never throw. The extractor handler is the
// orchestrator that decides what "missing context" means for the
// invocation.

// ─── Public types ───

export interface MatchedEntity {
  type: "caregiver" | "client";
  id: string;
}

export interface CallSessionContext {
  id: string;
  org_id: string;
  matched_entity_type: "caregiver" | "client" | null;
  matched_entity_id: string | null;
  recording_id: string | null;
  direction: "inbound" | "outbound" | null;
  from_e164: string | null;
  to_e164: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

// ─── Helpers ───

/**
 * Load the call_session row + matched-entity metadata for a given
 * call_session_id. Service-role caller expected (post-call-processor
 * runs with SUPABASE_SERVICE_ROLE_KEY).
 *
 * Returns null if the row is missing. The extractor handler treats
 * that as a no-op invocation — there's nothing to analyse.
 */
export async function loadCallSessionContext(
  supabase: any,
  callSessionId: string,
): Promise<CallSessionContext | null> {
  if (!callSessionId || typeof callSessionId !== "string") return null;
  const { data, error } = await supabase
    .from("call_sessions")
    .select(
      "id, org_id, matched_entity_type, matched_entity_id, recording_id, direction, from_e164, to_e164, ended_at, duration_seconds",
    )
    .eq("id", callSessionId)
    .maybeSingle();
  if (error || !data) return null;
  return data as CallSessionContext;
}

/**
 * Fetch the call transcript text by recording_id (the PK of
 * `call_transcriptions`). Returns the raw transcript as a single
 * prompt-shaped block, or an empty string when missing.
 *
 * Failure modes are intentionally silent — the extractor handler
 * checks for empty transcript and skips the invocation if so.
 */
export async function fetchCallTranscriptContext(
  supabase: any,
  recordingId: string | null,
): Promise<string> {
  if (!recordingId) return "";
  const { data, error } = await supabase
    .from("call_transcriptions")
    .select("transcript, duration_seconds")
    .eq("recording_id", recordingId)
    .maybeSingle();
  if (error || !data) return "";
  const transcript = typeof data.transcript === "string" ? data.transcript.trim() : "";
  if (!transcript) return "";
  const dur = data.duration_seconds ? `${Math.floor(data.duration_seconds / 60)}m ${data.duration_seconds % 60}s` : "unknown length";
  return [
    "## Transcript",
    `Recording id: ${recordingId} | Duration: ${dur}`,
    "",
    transcript,
  ].join("\n");
}

/**
 * Fetch the active call_taxonomy rows for an org, grouped by axis,
 * and format them as a prompt block listing valid slugs the agent
 * may emit.
 *
 * Reads the table directly. RLS-gated when called from a JWT user;
 * service-role bypasses (the typical post-call invocation path).
 */
export async function fetchCallTaxonomyContext(
  supabase: any,
  orgId: string,
): Promise<string> {
  if (!orgId) return "";
  const { data, error } = await supabase
    .from("call_taxonomy")
    .select("axis, slug, label, description, sort_order")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("axis", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("slug", { ascending: true });
  if (error || !data) return "";

  const callTypes: any[]  = [];
  const redFlags: any[]   = [];
  for (const row of data) {
    if (row.axis === "call_type") callTypes.push(row);
    else if (row.axis === "red_flag") redFlags.push(row);
  }

  const fmt = (rows: any[]) =>
    rows.length === 0
      ? "  (none configured)"
      : rows.map((r: any) => `  - ${r.slug}: ${r.label}${r.description ? ` — ${r.description}` : ""}`).join("\n");

  return [
    "## Taxonomy (use these exact slugs)",
    "",
    "Call types (pick exactly one):",
    fmt(callTypes),
    "",
    "Red flag categories (zero or more):",
    fmt(redFlags),
  ].join("\n");
}

/**
 * Fetch recent context_memory rows scoped to a matched entity,
 * formatted as a prompt block. Returns an empty string when there
 * are no memories or the entity reference is null.
 *
 * Limit is a soft cap on rows; the underlying query orders by
 * created_at DESC so the freshest memories survive truncation. Only
 * non-superseded rows are returned.
 *
 * NOTE: context_memory.entity_id is uuid; caregivers.id and
 * clients.id are text. The current schema stores the entity id as
 * uuid only when the row was written via the AI runtime (which uses
 * the legacy chat agent's writeback). When integrating with
 * caregiver/client ids that are text, callers should validate the
 * id format before passing it in. Phase 1.6.1's
 * `related_entity_id text` column is the structured cross-entity
 * path for the future — Phase 1.6.4 wires it.
 */
export async function fetchEntityMemoriesForCall(
  supabase: any,
  entityType: "caregiver" | "client" | null,
  entityId: string | null,
  options: { limit?: number; orgId?: string } = {},
): Promise<string> {
  if (!entityType || !entityId) return "";
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

  let q = supabase
    .from("context_memory")
    .select("memory_type, content, confidence, source, tags, created_at, related_entity_type, related_entity_id")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .is("superseded_by", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  // Filter by org_id when supplied (RLS may do this anyway, but the
  // extra eq is harmless and protects service-role callers from
  // pulling cross-tenant rows by mistake).
  if (options.orgId) q = q.eq("org_id", options.orgId);

  const { data, error } = await q;
  if (error || !data || data.length === 0) return "";

  const lines: string[] = [
    "## Recent memories for this entity",
    "",
  ];
  for (const m of data) {
    const conf = typeof m.confidence === "number" ? ` (conf ${m.confidence.toFixed(2)})` : "";
    const src = m.source ? ` [${m.source}]` : "";
    const tags = Array.isArray(m.tags) && m.tags.length ? ` #${m.tags.join(" #")}` : "";
    lines.push(`- ${m.content}${conf}${src}${tags}`);
  }
  return lines.join("\n");
}

/**
 * Tiny formatter helper — given a matched_entity_type / id pair,
 * returns a one-line identification block for the prompt. Pulls the
 * entity's first_name + last_name from the appropriate table.
 *
 * Returns an empty string when the entity is null or the lookup
 * fails. The extractor handler will fall back to a "no matched
 * entity" prompt path in that case.
 */
export async function fetchCallEntityIdentity(
  supabase: any,
  entityType: "caregiver" | "client" | null,
  entityId: string | null,
): Promise<string> {
  if (!entityType || !entityId) return "";
  const table = entityType === "caregiver" ? "caregivers" : "clients";
  const { data, error } = await supabase
    .from(table)
    .select("first_name, last_name")
    .eq("id", entityId)
    .maybeSingle();
  if (error || !data) return "";
  const fullName = `${data.first_name || ""} ${data.last_name || ""}`.trim() || "(unnamed)";
  return [
    "## Matched entity",
    `Type: ${entityType}`,
    `Id:   ${entityId}`,
    `Name: ${fullName}`,
  ].join("\n");
}
