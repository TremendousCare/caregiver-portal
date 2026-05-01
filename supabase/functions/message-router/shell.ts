// ─── message-router Phase 0.4 cutover shell ───
//
// Drop-in replacement for the legacy router Deno.serve body, gated by
// `app_settings.agent_runtime_cutover.message_router`.
//
// Behavioural contract (must match `index_legacy.ts` byte-equal):
//   * Pulls pending entries from `message_routing_queue` (FIFO, MAX_BATCH_SIZE)
//   * CAS-style mark-as-processing
//   * Per-entry: shift-offer matching → entity context → classifier →
//     autonomy lookup → queue update → dedup → suggestion → optional
//     auto-execute
//   * Same final ProcessResults shape returned in JSON body
//
// Phase 0.4 changes:
//   * Replaces `classifyMessage()` direct fetch with
//     `runAgent({ shape: "router" })` using `buildClassifierUserMessage` +
//     `CLASSIFIER_SYSTEM_PROMPT` to produce a byte-equal request body.
//   * Stamps `ai_suggestions.agent_id` (createSuggestion + the inline
//     unknown-sender alert insert).
//   * `executeSuggestion` reads agent_id from the suggestion row and
//     stamps action_outcomes accordingly (no per-call wiring needed).
//
// Test surface: `src/lib/__tests__/messageRouterShell.test.js`.

import { runAgent } from "../_shared/operations/agentRuntime.ts";
import {
  fetchEntityContext,
  lookupAutonomyLevel,
  createSuggestion,
  executeSuggestion,
  buildClassifierUserMessage,
  CLASSIFIER_SYSTEM_PROMPT,
  MAX_BATCH_SIZE,
  type ClassificationResult,
} from "../_shared/operations/routing.ts";
import { checkDuplicateSuggestion } from "../_shared/operations/planner.ts";
import { logMetric, startTimer } from "../_shared/operations/metrics.ts";
import { matchInboundShiftOfferResponse } from "../_shared/operations/shiftOfferMatching.ts";

export const ROUTER_AGENT_SLUG = "inbound_router";
export const ROUTER_DEFAULT_ORG_SLUG = "tremendous-care";

const MAX_ATTEMPTS = 3;

const ROUTER_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface RouterShellDeps {
  supabase: any;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface ProcessResults {
  processed: number;
  skipped: number;
  failed: number;
  suggestions_created: number;
  auto_executed: number;
}

export async function runMessageRouterShell(
  req: Request,
  deps: RouterShellDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: ROUTER_CORS_HEADERS });
  }

  try {
    if (!deps.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

    const orgId = await resolveOrgIdFromSlug(deps.supabase, ROUTER_DEFAULT_ORG_SLUG);
    if (!orgId) {
      return new Response(
        JSON.stringify({ error: `Could not resolve org_id for slug='${ROUTER_DEFAULT_ORG_SLUG}'` }),
        { status: 500, headers: { ...ROUTER_CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    // TODO(saas-phase-b5): iterate `organizations` and run once per org.

    const agentId = await resolveAgentIdSafe(deps.supabase, ROUTER_AGENT_SLUG, orgId);

    const results = await processQueue(deps, orgId, agentId);
    return new Response(
      JSON.stringify({ success: true, ...results }),
      { headers: { ...ROUTER_CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[message-router shell] error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...ROUTER_CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
}

async function processQueue(
  deps: RouterShellDeps,
  orgId: string,
  agentId: string | null,
): Promise<ProcessResults> {
  const supabase = deps.supabase;
  const results: ProcessResults = {
    processed: 0,
    skipped: 0,
    failed: 0,
    suggestions_created: 0,
    auto_executed: 0,
  };

  const doneInvocation = startTimer(supabase, "message-router", "invocation");

  const { data: entries, error: fetchErr } = await supabase
    .from("message_routing_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_BATCH_SIZE);

  if (fetchErr) {
    console.error("Failed to fetch queue entries:", fetchErr);
    throw new Error(`Queue fetch failed: ${fetchErr.message}`);
  }

  if (!entries || entries.length === 0) {
    doneInvocation(true, { ...results, queue_depth: 0 });
    return results;
  }

  const entryIds = entries.map((e: any) => e.id);
  await supabase
    .from("message_routing_queue")
    .update({
      status: "processing",
      processing_started_at: new Date().toISOString(),
      attempts: entries[0].attempts + 1,
    })
    .in("id", entryIds)
    .eq("status", "pending");

  for (const entry of entries) {
    try {
      await processEntry(deps, entry, results, orgId, agentId);
    } catch (err) {
      console.error(`Failed to process entry ${entry.id}:`, err);
      logMetric(supabase, "message-router", "error", undefined, false, {
        entry_id: entry.id,
        error: (err as Error).message,
        attempts: (entry.attempts || 0) + 1,
      });
      const attempts = (entry.attempts || 0) + 1;
      await supabase
        .from("message_routing_queue")
        .update({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          error_detail: (err as Error).message,
          attempts,
          updated_at: new Date().toISOString(),
        })
        .eq("id", entry.id);
      results.failed++;
    }
  }

  doneInvocation(true, {
    processed: results.processed,
    skipped: results.skipped,
    failed: results.failed,
    suggestions_created: results.suggestions_created,
    auto_executed: results.auto_executed,
    queue_depth: entries.length,
    runtime: true,
  });

  return results;
}

async function processEntry(
  deps: RouterShellDeps,
  entry: any,
  results: ProcessResults,
  orgId: string,
  agentId: string | null,
): Promise<void> {
  const supabase = deps.supabase;

  // Unknown-sender alert path (legacy parity)
  if (!entry.matched_entity_id || !entry.matched_entity_type) {
    const alertRow: Record<string, any> = {
      source_type: entry.channel === "sms" ? "inbound_sms" : "inbound_email",
      source_id: entry.id,
      entity_type: null,
      entity_id: null,
      entity_name: null,
      suggestion_type: "alert",
      action_type: null,
      title: `Unknown sender: ${entry.sender_identifier}`,
      detail: `Received ${entry.channel.toUpperCase()}: "${(entry.message_text || "").slice(0, 100)}"`,
      drafted_content: null,
      action_params: null,
      intent: "unknown",
      intent_confidence: 0,
      autonomy_level: "L1",
      status: "pending",
    };
    if (agentId) alertRow.agent_id = agentId;
    await supabase.from("ai_suggestions").insert(alertRow);

    await supabase
      .from("message_routing_queue")
      .update({
        status: "skipped",
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", entry.id);

    results.skipped++;
    results.suggestions_created++;
    return;
  }

  // Phase 5b: shift-offer matching (caregiver SMS only)
  if (entry.channel === "sms" && entry.matched_entity_type === "caregiver") {
    try {
      const result = await matchInboundShiftOfferResponse(
        supabase,
        entry.matched_entity_id,
        entry.message_text,
        entry.received_at || entry.created_at,
      );
      if (result.matched) {
        console.log(
          `[message-router] shift-offer match: offer ${result.offerId} → ${result.newStatus} (${result.response})`,
        );
      }
    } catch (err) {
      console.error("[message-router] shift-offer matching failed:", err);
    }
  }

  // Entity context fetch (legacy parity)
  const entityContext = await fetchEntityContext(
    supabase,
    entry.matched_entity_type,
    entry.matched_entity_id,
  );

  if (!entityContext) {
    await supabase
      .from("message_routing_queue")
      .update({
        status: "skipped",
        error_detail: "Entity not found or archived",
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", entry.id);
    results.skipped++;
    return;
  }

  // ── Classify via runAgent (replaces direct classifyMessage call) ──
  const doneClassify = startTimer(supabase, "message-router", "classification");
  const userPrompt = buildClassifierUserMessage(
    entityContext,
    entry.message_text || "",
    entry.channel,
  );

  const agentResult = await runAgent(
    supabase,
    ROUTER_AGENT_SLUG,
    {
      shape: "router",
      router: {
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        userPrompt,
      },
    },
    {
      orgId,
      apiKey: deps.apiKey,
      fetchImpl: deps.fetchImpl,
    },
  );

  const classification = (agentResult.classification || null) as ClassificationResult | null;
  doneClassify(!!classification, {
    intent: classification?.intent || "failed",
    confidence: classification?.confidence || 0,
    action: classification?.suggested_action || "none",
    entity_type: entry.matched_entity_type,
  });

  if (agentResult.status === "killed") {
    // Agent dormant — leave the queue entry pending for the next tick once
    // the kill switch is released. Same posture as classifier failure.
    const attempts = (entry.attempts || 0) + 1;
    await supabase
      .from("message_routing_queue")
      .update({
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        error_detail: "Agent kill_switch=true",
        attempts,
        updated_at: new Date().toISOString(),
      })
      .eq("id", entry.id);
    results.failed++;
    return;
  }

  if (!classification) {
    const attempts = (entry.attempts || 0) + 1;
    await supabase
      .from("message_routing_queue")
      .update({
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        error_detail: "AI classification failed",
        attempts,
        updated_at: new Date().toISOString(),
      })
      .eq("id", entry.id);
    results.failed++;
    return;
  }

  // ── Autonomy lookup (legacy parity) ──
  const actionType = classification.suggested_action !== "none"
    ? classification.suggested_action
    : "add_note";

  const autonomyConfig = await lookupAutonomyLevel(
    supabase,
    actionType,
    entry.matched_entity_type,
  );
  const autonomyLevel = autonomyConfig.autonomy_level;

  // ── Update queue entry with classification results ──
  await supabase
    .from("message_routing_queue")
    .update({
      status: "processed",
      intent: classification.intent,
      confidence: classification.confidence,
      suggested_action: classification.suggested_action,
      drafted_response: classification.drafted_response,
      ai_reasoning: classification.reasoning,
      autonomy_level: autonomyLevel,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", entry.id);

  // ── Dedup ──
  if (classification.suggested_action !== "none") {
    const isDuplicate = await checkDuplicateSuggestion(
      supabase,
      entry.matched_entity_id,
      classification.suggested_action,
      24,
    );
    if (isDuplicate) {
      console.log(
        `[message-router] Skipping duplicate ${classification.suggested_action} for ${entry.matched_entity_id}`,
      );
      results.processed++;
      return;
    }
  }

  // ── Create suggestion (with agent_id stamped) ──
  const entityName = `${entityContext.first_name} ${entityContext.last_name}`.trim();

  const suggestionResult = await createSuggestion(supabase, {
    sourceType: entry.channel === "sms" ? "inbound_sms" : "inbound_email",
    sourceId: entry.id,
    entityType: entry.matched_entity_type,
    entityId: entry.matched_entity_id,
    entityName: entityName || "Unknown",
    classification,
    autonomyLevel,
    channel: entry.channel,
    agentId,
  });

  if (suggestionResult.success) {
    results.suggestions_created++;
  }

  // ── Auto-execute if L3/L4 ──
  if (
    (autonomyLevel === "L3" || autonomyLevel === "L4") &&
    classification.suggested_action !== "none" &&
    classification.drafted_response
  ) {
    const { data: suggestions } = await supabase
      .from("ai_suggestions")
      .select("id")
      .eq("source_id", entry.id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (suggestions && suggestions.length > 0) {
      const execResult = await executeSuggestion(
        supabase,
        suggestions[0].id,
        "system:ai",
      );

      if (execResult.success) {
        results.auto_executed++;
      } else {
        console.error(`Auto-execute failed for suggestion ${suggestions[0].id}:`, execResult.error);
      }
    }
  }

  results.processed++;
}

// ─── Helpers ───

export async function resolveOrgIdFromSlug(
  supabase: any,
  slug: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (error || !data) return null;
    return data.id || null;
  } catch {
    return null;
  }
}

export async function resolveAgentIdSafe(
  supabase: any,
  slug: string,
  orgId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("agents")
      .select("id")
      .eq("slug", slug)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error || !data) return null;
    return data.id || null;
  } catch {
    return null;
  }
}
