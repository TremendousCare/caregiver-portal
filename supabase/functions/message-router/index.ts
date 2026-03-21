// ─── Message Router ───
// Cron worker (every 2 minutes) that processes inbound messages from
// message_routing_queue. For each message:
// 1. Fetches entity context (phase, recent notes, tasks)
// 2. Calls Claude Haiku to classify intent and draft a response
// 3. Checks autonomy_config for the appropriate action level
// 4. Creates an ai_suggestions row (L1/L2 = pending, L3/L4 = auto-execute)
//
// Pattern follows intake-processor: batch processing, retry logic, fire-and-forget.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  classifyMessage,
  fetchEntityContext,
  lookupAutonomyLevel,
  createSuggestion,
  executeSuggestion,
  MAX_BATCH_SIZE,
} from "../_shared/operations/routing.ts";
import { checkDuplicateSuggestion } from "../_shared/operations/planner.ts";
import { logMetric, startTimer } from "../_shared/operations/metrics.ts";

// ─── Environment ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Max attempts before marking as failed
const MAX_ATTEMPTS = 3;

// ─── Main Handler ───
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const results = await processQueue();
    return new Response(
      JSON.stringify({ success: true, ...results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("message-router error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ─── Queue Processing ───

interface ProcessResults {
  processed: number;
  skipped: number;
  failed: number;
  suggestions_created: number;
  auto_executed: number;
}

async function processQueue(): Promise<ProcessResults> {
  const results: ProcessResults = {
    processed: 0,
    skipped: 0,
    failed: 0,
    suggestions_created: 0,
    auto_executed: 0,
  };

  const doneInvocation = startTimer(supabase, "message-router", "invocation");

  // Fetch pending entries (oldest first, limited batch size)
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
    return results;
  }

  // Mark all as processing (prevent double-processing by concurrent invocations)
  const entryIds = entries.map((e: any) => e.id);
  await supabase
    .from("message_routing_queue")
    .update({
      status: "processing",
      processing_started_at: new Date().toISOString(),
      attempts: entries[0].attempts + 1, // increment attempt counter
    })
    .in("id", entryIds)
    .eq("status", "pending"); // CAS: only update if still pending

  // Process each entry
  for (const entry of entries) {
    try {
      await processEntry(entry, results);
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
    queue_depth: entries?.length || 0,
  });

  return results;
}

async function processEntry(
  entry: any,
  results: ProcessResults,
): Promise<void> {
  // ── Skip if no matched entity (unknown sender) ──
  if (!entry.matched_entity_id || !entry.matched_entity_type) {
    // Still create an alert suggestion for unknown senders
    await supabase.from("ai_suggestions").insert({
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
    });

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

  // ── Fetch entity context ──
  const entityContext = await fetchEntityContext(
    supabase,
    entry.matched_entity_type,
    entry.matched_entity_id,
  );

  if (!entityContext) {
    // Entity was deleted/archived between webhook and processing
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

  // ── Classify message ──
  const doneClassify = startTimer(supabase, "message-router", "classification");
  const classification = await classifyMessage(
    entityContext,
    entry.message_text || "",
    entry.channel,
  );
  doneClassify(!!classification, {
    intent: classification?.intent || "failed",
    confidence: classification?.confidence || 0,
    action: classification?.suggested_action || "none",
    entity_type: entry.matched_entity_type,
  });

  if (!classification) {
    // Classifier failed — mark as failed, will retry
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

  // ── Look up autonomy level ──
  const actionType = classification.suggested_action !== "none"
    ? classification.suggested_action
    : "add_note"; // Default to add_note for informational messages

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

  // ── Dedup check: skip if same entity+action already suggested within 24h ──
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

  // ── Create suggestion ──
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
  });

  if (suggestionResult.success) {
    results.suggestions_created++;
  }

  // ── Auto-execute if L3 or L4 ──
  if (
    (autonomyLevel === "L3" || autonomyLevel === "L4") &&
    classification.suggested_action !== "none" &&
    classification.drafted_response
  ) {
    // Find the suggestion we just created
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
