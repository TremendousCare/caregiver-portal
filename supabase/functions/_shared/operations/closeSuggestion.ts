// Phase 1.5 follow-up — close-pending-suggestion shared helper.
//
// When an operator performs an action through a regular UI surface
// (SMS compose, email compose, scheduling, phase change, task complete,
// note add), `ai_suggestions` rows the planner / router emitted for
// that (entity, action_type) sit stale at `status='pending'` forever —
// the dashboard buttons today only navigate, they don't execute. The
// `agent_actions` audit log never receives a `phase='executed'` row,
// so the autonomy v2 algorithm has no positive signal to chew on. Net
// effect: the algorithm can mathematically never promote an action
// past L1 — the numerator is near-zero, the denominator (rejected +
// expired) is large.
//
// This helper closes the loop. Call it from any operator-write
// surface immediately after the underlying action lands successfully
// (e.g. after `bulk-sms` returns OK). It:
//
//   1. Finds the most recent non-resolved `ai_suggestions` row matching
//      (entity_type, entity_id, action_type) with status='pending' and
//      expires_at > now(). Older suggestions sit too — but we only
//      want the freshest one; if the operator's action genuinely
//      doesn't correspond to any open suggestion, the helper is a
//      no-op.
//   2. Atomically transitions that row from 'pending' → 'executed'
//      (CAS-style WHERE clause guards against races with an auto-
//      executor or another tab).
//   3. Writes one `agent_actions` row with `phase='executed'`,
//      `actor=user:<email>`, payload echoing the params the operator
//      actually used. This is the positive autonomy signal.
//
// Failure modes are intentionally non-fatal — the operator's primary
// action already succeeded, so a downstream audit write failing must
// never block the UI flow. Caller is expected to swallow + log.

import { recordAgentAction } from "./agentActions.ts";

export type CloseEntityType = "caregiver" | "client";

/** Action types the helper understands. Strict allowlist — keeps the
 *  closure heuristic narrow so we never close an unrelated suggestion
 *  just because action_type strings drift over time. Mirrors the
 *  vocabulary the ai-planner emits (see ai-planner/shell.ts:63). */
export const CLOSEABLE_ACTION_TYPES = [
  "send_sms",
  "send_email",
  "add_note",
  "complete_task",
  "update_phase",
  "create_calendar_event",
  "send_docusign_envelope",
] as const;
export type CloseableActionType = typeof CLOSEABLE_ACTION_TYPES[number];

export interface ClosePendingSuggestionInput {
  entityType: CloseEntityType;
  entityId:   string;
  actionType: CloseableActionType;
  /** `user:<email>` if known, else `system:<source>`. Stamped on the
   *  closed suggestion (`resolved_by`) and the audit row (`actor`). */
  actor:      string;
  /** Echo of the params the operator used (e.g. SMS body, route).
   *  Stored in the agent_actions row's payload for downstream review.
   *  Keep it small — large payloads inflate the audit chain. */
  params?:    Record<string, unknown>;
}

export interface ClosePendingSuggestionResult {
  /** True if a pending suggestion matched and was closed. False when
   *  no matching suggestion existed (genuine no-op — operator acted
   *  ahead of any AI suggestion). */
  closed:           boolean;
  /** The closed suggestion's id, if any. */
  suggestion_id:    string | null;
  /** The audit row's id, if the audit write succeeded. */
  agent_action_id:  string | null;
  /** Whether the audit dual-write failed despite the suggestion close
   *  succeeding. Surfaced for the caller's metric / log. */
  audit_failed:     boolean;
  /** Diagnostic info — not user-facing. */
  reason?:          string;
}

const SUGGESTION_COLUMNS = "id, agent_id, action_type, status, expires_at";

/**
 * Look up the freshest pending suggestion for (entity_type, entity_id,
 * action_type) and close it. Service-role supabase client expected —
 * the function reads/writes through RLS-bypass.
 */
export async function closePendingSuggestion(
  supabase: any,
  input: ClosePendingSuggestionInput,
): Promise<ClosePendingSuggestionResult> {
  // ── Defensive validation. The edge function does the same, but we
  //    don't want a malformed call to bypass the allowlist if a future
  //    caller forgets. ──
  if (!input.entityType || (input.entityType !== "caregiver" && input.entityType !== "client")) {
    return base({ reason: "invalid entity_type" });
  }
  if (!input.entityId || typeof input.entityId !== "string") {
    return base({ reason: "invalid entity_id" });
  }
  if (!input.actionType || !CLOSEABLE_ACTION_TYPES.includes(input.actionType as CloseableActionType)) {
    return base({ reason: `action_type ${input.actionType} not in closeable allowlist` });
  }
  if (!input.actor || typeof input.actor !== "string") {
    return base({ reason: "actor required" });
  }

  // ── 1. Find the freshest non-resolved pending suggestion. ──
  const nowIso = new Date().toISOString();
  const { data: candidates, error: selErr } = await supabase
    .from("ai_suggestions")
    .select(SUGGESTION_COLUMNS)
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
    .eq("action_type", input.actionType)
    .eq("status", "pending")
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1);
  if (selErr) {
    return base({ reason: `select failed: ${selErr.message}` });
  }
  const candidate = candidates?.[0];
  if (!candidate) {
    return base({ reason: "no pending suggestion to close" });
  }

  // ── 2. CAS-style status transition. The extra `.eq('status',
  //    'pending')` is the guard against a concurrent close (auto-
  //    executor, another tab). If the UPDATE matches zero rows, some
  //    other writer already resolved this suggestion and we skip the
  //    audit row so we don't double-count. ──
  const { data: updated, error: updErr } = await supabase
    .from("ai_suggestions")
    .update({
      status:       "executed",
      resolved_at:  nowIso,
      resolved_by:  input.actor,
    })
    .eq("id", candidate.id)
    .eq("status", "pending")
    .select("id, agent_id")
    .maybeSingle();
  if (updErr) {
    return base({ reason: `update failed: ${updErr.message}` });
  }
  if (!updated) {
    // Lost the CAS race. Not an error — another writer closed it.
    return base({ reason: "lost CAS race; another writer resolved the suggestion" });
  }

  // ── 3. Look up agent version for the audit row. The suggestion's
  //    agent_id may be NULL on legacy rows that pre-date Phase 0.2;
  //    skip the audit row entirely in that case (no agent to stamp). ──
  const agentId = updated.agent_id || candidate.agent_id;
  if (!agentId) {
    return {
      closed:           true,
      suggestion_id:    updated.id,
      agent_action_id:  null,
      audit_failed:     true,
      reason:           "suggestion has no agent_id; audit row skipped",
    };
  }

  const { data: agentRow, error: agentErr } = await supabase
    .from("agents")
    .select("id, org_id, version")
    .eq("id", agentId)
    .maybeSingle();
  if (agentErr || !agentRow) {
    return {
      closed:           true,
      suggestion_id:    updated.id,
      agent_action_id:  null,
      audit_failed:     true,
      reason:           `agent lookup failed: ${agentErr?.message ?? "not found"}`,
    };
  }

  // ── 4. Write the audit row. phase='executed' = positive autonomy
  //    signal. The autonomy v2 reader picks this up in its lookback
  //    window next time the (agent × action_type) outcome is
  //    evaluated. ──
  const auditResult = await recordAgentAction(supabase, {
    orgId:        agentRow.org_id,
    agentId,
    agentVersion: agentRow.version,
    actionType:   input.actionType,
    phase:        "executed",
    entityType:   input.entityType,
    entityId:     input.entityId,
    actor:        input.actor,
    payload: {
      source:        "operator_action_loop_closure",
      suggestion_id: updated.id,
      // Only echo a tight subset of params. The full operator input
      // (e.g. SMS body) lives in caregiver/client notes already — no
      // need to duplicate it into the audit chain.
      params:        sanitizeParams(input.params ?? {}),
    },
    outcomeId: null,
  });

  if (!auditResult.success) {
    return {
      closed:           true,
      suggestion_id:    updated.id,
      agent_action_id:  null,
      audit_failed:     true,
      reason:           `audit write failed: ${auditResult.error?.message ?? "unknown"}`,
    };
  }

  return {
    closed:          true,
    suggestion_id:   updated.id,
    agent_action_id: auditResult.id ?? null,
    audit_failed:    false,
  };
}

function base(overrides: Partial<ClosePendingSuggestionResult>): ClosePendingSuggestionResult {
  return {
    closed:          false,
    suggestion_id:   null,
    agent_action_id: null,
    audit_failed:    false,
    ...overrides,
  };
}

/** Cap a single-level params object so the audit payload stays small.
 *  Strings are truncated to 200 chars; nested objects flattened to
 *  their key set. Numbers + booleans pass through. */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") {
      out[k] = v.length > 200 ? v.slice(0, 197) + "..." : v;
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `[array length ${v.length}]`;
    } else if (typeof v === "object") {
      out[k] = `[object keys: ${Object.keys(v as object).join(", ")}]`;
    }
    // Functions, symbols, undefined: dropped silently.
  }
  return out;
}
