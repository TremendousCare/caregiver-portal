// ─── Persist call_analysis output (Phase 1.6.2) ───
//
// Companion to `runExtractorHandler` in handlers.ts. The runtime is a
// pure orchestrator — it produces a parsed analysis blob and returns
// it without touching the database. This module is the writer:
//
//   1. Stamps `call_sessions.ai_summary` (text) + `ai_outcome` (jsonb)
//      so the call's analysis state moves from "transcript fetched"
//      to "analysed". This is the idempotency anchor for re-runs:
//      post-call-processor only invokes the agent when ai_summary IS
//      NULL.
//   2. Writes one `ai_suggestions` row per action_item the agent
//      emitted, plus one for `suggested_phase_change` when present.
//      All stamped with agent_id, source_type='call_analyst',
//      source_id=call_session.id, autonomy_level='L1', status='pending'.
//   3. Writes one `agent_actions` audit row per suggestion. Phase
//      defaults to 'executed', or 'shadow' when shadow_mode is on.
//      Same tamper-evident chain as the chat / planner / router shells.
//
// Persistence is NOT atomic across these three steps — Supabase's
// REST API doesn't expose multi-statement transactions to the client.
// Failure ordering is designed so partial writes don't poison
// re-runs: call_sessions.ai_summary is stamped LAST. If
// ai_suggestions or agent_actions writes fail, ai_summary stays NULL
// and the next post-call-processor tick retries the whole
// invocation. Downsides: a retry on a partial write produces
// duplicate ai_suggestions rows. Tolerable because the autonomy
// algorithm dedupes via grade verdicts and the operator can dismiss
// duplicates from the notification surface. If duplication becomes a
// real problem in production, swap to a SQL function that writes all
// three in one transaction.

import { recordAgentAction } from "../agentActions.ts";

export interface CallAnalysisPayload {
  call_type: string;
  summary: string;
  sentiment: "positive" | "neutral" | "negative";
  red_flags: string[];
  action_items: Array<{ title: string; detail: string; priority: "high" | "medium" | "low" }>;
  memory_candidates: Array<{ content: string; confidence: number; tags: string[] }>;
  suggested_phase_change: { to_phase: string; rationale: string } | null;
}

export interface PersistCallAnalysisInput {
  callSessionId:    string;
  orgId:            string;
  matchedEntityType: "caregiver" | "client" | null;
  matchedEntityId:   string | null;
  /** From the agent manifest — used to stamp ai_suggestions.agent_id
   *  and agent_actions.agent_id / agent_version. */
  agentId:      string;
  agentVersion: number;
  /** Manifest's shadow_mode flag. When true, every agent_actions row
   *  is stamped with phase='shadow' instead of 'executed'. */
  shadowMode: boolean;
  /** The parsed analysis from the extractor handler. */
  analysis: CallAnalysisPayload;
  /** Token cost + model + latency from the runtime invocation. Stamped
   *  into each agent_actions audit row's `payload._cost` so the metrics
   *  dashboard (`agent_actions.payload._cost`) can attribute token spend
   *  and latency to call_analyst — the same `_cost` shape the ai-chat /
   *  ai-planner / message-router shells emit. The single Sonnet call cost
   *  is shared across every suggestion in the analysis, so we prorate by
   *  suggestion count to avoid double-counting. Optional: when omitted
   *  (legacy callers, tests) no `_cost` is stamped. */
  cost?: {
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    model: string | null;
  };
}

export interface PersistCallAnalysisResult {
  /** Number of `ai_suggestions` rows successfully inserted. */
  suggestionsWritten: number;
  /** Number of `agent_actions` audit rows successfully written. */
  auditRowsWritten:   number;
  /** True if `call_sessions.ai_summary` was stamped (the final step). */
  callSessionUpdated: boolean;
  /** Errors collected non-fatally during the write sequence. */
  errors: Array<{ step: string; message: string }>;
}

const ACTOR_SYSTEM_CALL_ANALYST = "system:call_analyst";

export async function persistCallAnalysis(
  supabase: any,
  input: PersistCallAnalysisInput,
): Promise<PersistCallAnalysisResult> {
  const errors: PersistCallAnalysisResult["errors"] = [];
  const phase = input.shadowMode ? "shadow" : "executed";

  // ─── 1. Write per-action-item ai_suggestions rows ───
  const suggestionRows: any[] = input.analysis.action_items.map((a) => ({
    org_id:           input.orgId,
    source_type:      "call_analyst",
    source_id:        null, // call_session.id is text; source_id is uuid. The link lives in action_params.
    entity_type:      input.matchedEntityType,
    entity_id:        input.matchedEntityId,
    entity_name:      null, // filled by downstream consumers if needed
    suggestion_type:  "action",
    action_type:      "task_create",
    title:            a.title,
    detail:           a.detail,
    drafted_content:  null,
    action_params:    {
      priority:         a.priority,
      call_session_id:  input.callSessionId,
    },
    autonomy_level:   "L1",
    status:           "pending",
    agent_id:         input.agentId,
  }));

  if (input.analysis.suggested_phase_change) {
    suggestionRows.push({
      org_id:           input.orgId,
      source_type:      "call_analyst",
      source_id:        null,
      entity_type:      input.matchedEntityType,
      entity_id:        input.matchedEntityId,
      entity_name:      null,
      suggestion_type:  "action",
      action_type:      input.matchedEntityType === "client" ? "update_client_phase" : "update_phase",
      title:            `Move to ${input.analysis.suggested_phase_change.to_phase}`,
      detail:           input.analysis.suggested_phase_change.rationale,
      drafted_content:  null,
      action_params:    {
        new_phase:        input.analysis.suggested_phase_change.to_phase,
        call_session_id:  input.callSessionId,
      },
      autonomy_level:   "L1",
      status:           "pending",
      agent_id:         input.agentId,
    });
  }

  let insertedSuggestionIds: Array<{ id: string; action_type: string; entity_type: string | null; entity_id: string | null }> = [];
  if (suggestionRows.length > 0) {
    const { data, error } = await supabase
      .from("ai_suggestions")
      .insert(suggestionRows)
      .select("id, action_type, entity_type, entity_id");
    if (error) {
      errors.push({ step: "insert_ai_suggestions", message: error.message });
    } else if (Array.isArray(data)) {
      insertedSuggestionIds = data;
    }
  }

  // ─── 2. Write per-suggestion agent_actions audit rows ───
  // Prorate the single analysis-call token cost across the suggestions
  // so the metrics dashboard can SUM payload._cost without
  // double-counting (mirrors ai-planner/shell.ts).
  const suggestionCount = Math.max(1, insertedSuggestionIds.length);
  const perSuggestionCost = input.cost
    ? {
        input_tokens:  Math.round(input.cost.input_tokens / suggestionCount),
        output_tokens: Math.round(input.cost.output_tokens / suggestionCount),
        duration_ms:   input.cost.duration_ms,
        model:         input.cost.model,
      }
    : null;

  let auditRowsWritten = 0;
  for (const row of insertedSuggestionIds) {
    try {
      const result = await recordAgentAction(supabase, {
        orgId:        input.orgId,
        agentId:      input.agentId,
        agentVersion: input.agentVersion,
        actionType:   row.action_type || "task_create",
        phase,
        entityType:   row.entity_type as "caregiver" | "client" | null,
        entityId:     row.entity_id,
        actor:        ACTOR_SYSTEM_CALL_ANALYST,
        payload: {
          source:           "call_analyst_extraction",
          suggestion_id:    row.id,
          call_session_id:  input.callSessionId,
          ...(perSuggestionCost ? { _cost: perSuggestionCost } : {}),
        },
        outcomeId: null,
      });
      if (result.success) auditRowsWritten += 1;
      else errors.push({
        step: "record_agent_action",
        message: result.error?.message || "unknown failure",
      });
    } catch (err) {
      errors.push({
        step: "record_agent_action",
        message: (err as Error).message || String(err),
      });
    }
  }

  // ─── 3. Stamp call_sessions LAST (idempotency anchor) ───
  // The summary lives on the column; everything else (call_type,
  // sentiment, red_flags, memory_candidates DRAFT) lives in ai_outcome.
  // Memory candidates are emitted as a draft array — Phase 1.6.3's
  // Memories review UI promotes them into context_memory after operator
  // approval. context_memory is NOT written from this path.
  const callSessionUpdate = {
    ai_summary: input.analysis.summary || null,
    ai_outcome: {
      call_type:               input.analysis.call_type,
      sentiment:               input.analysis.sentiment,
      red_flags:               input.analysis.red_flags,
      memory_candidates_draft: input.analysis.memory_candidates,
      analyzed_at:             new Date().toISOString(),
      analyzed_by_agent_id:    input.agentId,
      analyzed_in_shadow_mode: input.shadowMode,
    },
  };
  const { error: stampErr } = await supabase
    .from("call_sessions")
    .update(callSessionUpdate)
    .eq("id", input.callSessionId);
  const callSessionUpdated = !stampErr;
  if (stampErr) {
    errors.push({ step: "update_call_sessions", message: stampErr.message });
  }

  return {
    suggestionsWritten: insertedSuggestionIds.length,
    auditRowsWritten,
    callSessionUpdated,
    errors,
  };
}
