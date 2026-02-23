// ─── Memory Consolidation Pipeline ───
// Analyzes action_outcomes and episodic memories to generate higher-order memories.
// Three consolidation pathways:
//   1. Outcome → Semantic: When 30+ outcomes exist for an action type, create/update
//      a semantic memory with success rates and response times.
//   2. Correction → Procedural: When 3+ user corrections share a pattern,
//      create a procedural memory (SOP) from the corrections.
//   3. Expired outcomes: Mark stale pending outcomes as "expired".
//
// Designed to run periodically (end of session, daily cron, or on-demand).
// All operations are fire-and-forget — failures are logged but never thrown.

import { storeMemory } from "./events.ts";

// ── Pure functions (also tested in outcomeTracking.test.js) ──

export function calculateConfidence(sampleSize: number): number {
  if (sampleSize >= 100) return 0.85;
  if (sampleSize >= 30) return 0.6;
  return 0;
}

export function calculateSuccessRate(outcomes: Array<{ outcome_type: string }>): number {
  if (!outcomes || outcomes.length === 0) return 0;
  const successes = outcomes.filter(
    o => o.outcome_type === "response_received" || o.outcome_type === "completed",
  ).length;
  return Math.round((successes / outcomes.length) * 100);
}

export function calculateAvgResponseHours(
  outcomes: Array<{ outcome_detail?: { hours_to_outcome?: number } }>,
): number | null {
  const times = outcomes
    .filter(o => o.outcome_detail?.hours_to_outcome)
    .map(o => o.outcome_detail!.hours_to_outcome!);
  if (times.length === 0) return null;
  return Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10;
}

export function shouldCreateMemory(sampleSize: number): boolean {
  return sampleSize >= 30;
}

export function buildMemoryContent(
  actionType: string,
  successRate: number,
  total: number,
  avgHours: number | null,
): string {
  const label = actionType.replace(/_/g, " ");
  let content = `${label}: ${successRate}% success rate (${total} observations)`;
  if (avgHours) content += `. Average response time: ${avgHours} hours`;
  return content;
}

// ── Drift Detection ──

// If success rate shifts by more than this threshold, flag as significant drift
const DRIFT_THRESHOLD_PERCENT = 15;

/**
 * Extract the success rate percentage from an existing memory content string.
 * Expects format: "sms sent: 42% success rate (38 observations)"
 * Returns null if parsing fails.
 */
export function parseSuccessRateFromContent(content: string): number | null {
  const match = content.match(/(\d+)%\s*success\s*rate/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Detect if a significant drift has occurred between old and new success rates.
 */
export function detectDrift(
  oldRate: number | null,
  newRate: number,
): { drifted: boolean; delta: number } {
  if (oldRate === null) return { drifted: false, delta: 0 };
  const delta = newRate - oldRate;
  return { drifted: Math.abs(delta) >= DRIFT_THRESHOLD_PERCENT, delta };
}

// ── Consolidation: Outcomes → Semantic Memories ──

/**
 * Analyze completed action outcomes and generate/update semantic memories
 * for action types with enough data points (30+).
 * Includes drift detection — logs when success rates shift significantly.
 */
async function consolidateOutcomes(supabase: any): Promise<{ created: number; driftEvents: string[] }> {
  let memoriesCreated = 0;
  const driftEvents: string[] = [];

  try {
    // Get all completed outcomes grouped by action_type
    const { data: outcomes, error } = await supabase
      .from("action_outcomes")
      .select("action_type, outcome_type, outcome_detail, created_at")
      .not("outcome_type", "is", null)
      .order("created_at", { ascending: false });

    if (error || !outcomes) {
      console.error("[consolidation] Failed to fetch outcomes:", error);
      return { created: 0, driftEvents: [] };
    }

    // Group by action_type
    const groups: Record<string, any[]> = {};
    for (const o of outcomes) {
      if (!groups[o.action_type]) groups[o.action_type] = [];
      groups[o.action_type].push(o);
    }

    for (const [actionType, actionOutcomes] of Object.entries(groups)) {
      if (!shouldCreateMemory(actionOutcomes.length)) continue;

      const successRate = calculateSuccessRate(actionOutcomes);
      const avgHours = calculateAvgResponseHours(actionOutcomes);
      const confidence = calculateConfidence(actionOutcomes.length);
      const content = buildMemoryContent(actionType, successRate, actionOutcomes.length, avgHours);

      // Check if a semantic memory for this action type already exists
      const { data: existing } = await supabase
        .from("context_memory")
        .select("id, content")
        .eq("memory_type", "semantic")
        .eq("source", "outcome_analysis")
        .is("superseded_by", null)
        .like("content", `${actionType.replace(/_/g, " ")}:%`)
        .limit(1);

      if (existing && existing.length > 0) {
        // Check for drift
        const oldRate = parseSuccessRateFromContent(existing[0].content);
        const { drifted, delta } = detectDrift(oldRate, successRate);

        if (drifted) {
          const direction = delta > 0 ? "improved" : "declined";
          const driftMsg = `[drift] ${actionType} success rate ${direction}: ${oldRate}% → ${successRate}% (${delta > 0 ? "+" : ""}${delta}pp, ${actionOutcomes.length} observations)`;
          console.warn(`[consolidation] ${driftMsg}`);
          driftEvents.push(driftMsg);
        }

        // Content changed — supersede the old memory
        if (existing[0].content !== content) {
          const tags = [actionType, "outcome_pattern", "auto_generated"];
          if (drifted) tags.push("drift_detected");

          const { data: newMem } = await supabase
            .from("context_memory")
            .insert({
              memory_type: "semantic",
              content,
              confidence,
              source: "outcome_analysis",
              tags,
            })
            .select("id")
            .single();

          // Supersede the old one
          if (newMem) {
            await supabase
              .from("context_memory")
              .update({ superseded_by: newMem.id })
              .eq("id", existing[0].id);
            memoriesCreated++;
          }
        }
      } else {
        // No existing memory — create new
        await storeMemory(supabase, "semantic", content, {
          confidence,
          source: "outcome_analysis",
          tags: [actionType, "outcome_pattern", "auto_generated"],
        });
        memoriesCreated++;
      }
    }
  } catch (err) {
    console.error("[consolidation] Outcome consolidation error:", err);
  }

  return { created: memoriesCreated, driftEvents };
}

// ── Consolidation: Repeated Corrections → Procedural Memories ──

const CORRECTION_THRESHOLD = 3; // 3+ corrections on similar topics = create a procedure

/**
 * Analyze user corrections (episodic memories from user_correction source)
 * and consolidate repeated patterns into procedural memories.
 */
async function consolidateCorrections(supabase: any): Promise<number> {
  let memoriesCreated = 0;

  try {
    // Fetch all active user corrections
    const { data: corrections, error } = await supabase
      .from("context_memory")
      .select("id, content, entity_type, entity_id, tags, created_at")
      .eq("memory_type", "episodic")
      .eq("source", "user_correction")
      .is("superseded_by", null)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error || !corrections || corrections.length < CORRECTION_THRESHOLD) return 0;

    // Group corrections by their primary tag (first tag = topic category)
    const tagGroups: Record<string, any[]> = {};
    for (const corr of corrections) {
      const primaryTag = (corr.tags && corr.tags[0]) || "general";
      if (!tagGroups[primaryTag]) tagGroups[primaryTag] = [];
      tagGroups[primaryTag].push(corr);
    }

    for (const [tag, group] of Object.entries(tagGroups)) {
      if (group.length < CORRECTION_THRESHOLD) continue;

      // Check if a procedural memory already exists for this tag
      const { data: existing } = await supabase
        .from("context_memory")
        .select("id")
        .eq("memory_type", "procedural")
        .eq("source", "outcome_analysis")
        .is("superseded_by", null)
        .contains("tags", [tag, "auto_consolidated"])
        .limit(1);

      if (existing && existing.length > 0) continue; // Already consolidated

      // Build procedural memory from the corrections
      const correctionTexts = group
        .slice(0, 5)
        .map((c: any) => c.content);

      const entityScope = group[0].entity_type && group[0].entity_id
        ? ` for ${group[0].entity_type} ${group[0].entity_id}`
        : "";

      const content = `Based on ${group.length} corrections${entityScope}: ${correctionTexts.join("; ")}`;

      await storeMemory(supabase, "procedural", content, {
        confidence: calculateConfidence(group.length),
        source: "outcome_analysis",
        tags: [tag, "auto_consolidated", "from_corrections"],
      });

      memoriesCreated++;
    }
  } catch (err) {
    console.error("[consolidation] Correction consolidation error:", err);
  }

  return memoriesCreated;
}

// ── Expire stale pending outcomes ──

/**
 * Mark pending action_outcomes as "expired" if they've passed their expires_at.
 */
async function expireStalePendingOutcomes(supabase: any): Promise<number> {
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("action_outcomes")
      .update({
        outcome_type: "expired",
        outcome_detected_at: now,
        outcome_detail: { reason: "auto_expired", expired_at: now },
      })
      .is("outcome_type", null)
      .lt("expires_at", now)
      .select("id");

    if (error) {
      console.error("[consolidation] Failed to expire stale outcomes:", error);
      return 0;
    }

    return data?.length || 0;
  } catch (err) {
    console.error("[consolidation] Expire outcomes error:", err);
    return 0;
  }
}

// ── Main Consolidation Runner ──

export interface ConsolidationResult {
  semanticMemoriesCreated: number;
  proceduralMemoriesCreated: number;
  outcomesExpired: number;
  driftEvents: string[];
  durationMs: number;
}

/**
 * Run the full memory consolidation pipeline.
 * Safe to call frequently — idempotent and fire-and-forget.
 */
export async function runConsolidation(supabase: any): Promise<ConsolidationResult> {
  const start = Date.now();
  console.log("[consolidation] Starting memory consolidation pipeline...");

  const [outcomeResult, proceduralMemoriesCreated, outcomesExpired] =
    await Promise.all([
      consolidateOutcomes(supabase),
      consolidateCorrections(supabase),
      expireStalePendingOutcomes(supabase),
    ]);

  const durationMs = Date.now() - start;
  const result: ConsolidationResult = {
    semanticMemoriesCreated: outcomeResult.created,
    proceduralMemoriesCreated,
    outcomesExpired,
    driftEvents: outcomeResult.driftEvents,
    durationMs,
  };

  console.log(`[consolidation] Complete in ${durationMs}ms: ${outcomeResult.created} semantic, ${proceduralMemoriesCreated} procedural, ${outcomesExpired} expired, ${outcomeResult.driftEvents.length} drift events`);

  return result;
}
