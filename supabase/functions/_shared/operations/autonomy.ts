// ─── Autonomy promotion algorithm v2 (Phase 1.2) ───
//
// Replaces the legacy consecutive-counter approach in
// `_shared/operations/routing.ts:recordAutonomyOutcome` with a per-(agent ×
// action) sliding-window evaluator that reads from the `agent_actions`
// audit chain.
//
// Core decisions (per `docs/AGENT_PLATFORM.md` → 1.2 + VISION.md prime
// directive #5):
//
//   * Per-transition thresholds. L1→L2 cheap, L2→L3 stricter, L3→L4
//     strictest. Each transition has its own `min_consecutive`,
//     `min_success_rate`, and `min_sample`.
//   * Sliding window. Success rate is computed over the last
//     `lookback_window` actions (default 50), not lifetime. A quiet week of
//     trivial approvals cannot promote a critical action.
//   * Refuses to promote past `max_level`.
//   * Auto-demote on harm. A single action with `payload.severity ===
//     'harmful'` (an operator override flag the UI sets when they reverse
//     an agent action) demotes one level immediately and locks promotion
//     for `lockout_hours_after_demote` hours from that action's timestamp.
//
// `evaluatePromotion` is **pure** — it returns a verdict. The stateful
// wrapper `recordAutonomyOutcomeV2` is what actually mutates
// `agents.autonomy_profile` and writes a promotion event to the `events`
// bus.
//
// Why we don't write promotion events to `agent_actions`: the
// `agent_actions.phase` CHECK constraint is locked to seven values
// (suggested | confirmed | executed | auto_executed | rejected | expired |
// shadow) and the hash chain is sacrosanct (per CEO constraint #6). The
// `events` bus is the right home for governance signals like
// `agent_autonomy_promoted` / `agent_autonomy_demoted` — it's append-only,
// org-scoped, and already the audit trail for kill_switch / shadow_mode
// toggles (see `toggle_agent_flag_v1`).
//
// Why we don't issue an RPC for the autonomy_profile UPDATE: Phase 0.5
// PR B's `agent_table_write_lockdown` migration revoked
// INSERT/UPDATE/DELETE on `agents` from `authenticated`. The runtime uses
// the *service role* key, which bypasses RLS and is unaffected by the
// REVOKE. A direct UPDATE from a service-role edge-function client is
// equivalent in effect to an RPC and avoids both an extra round-trip and
// a new SECURITY DEFINER surface to maintain. (Future Phase 1.4 may add
// a Settings-UI promotion-history surface; that surface goes through a
// SELECT-only path so the lockdown stays intact.)
//
// All side-effects are fire-and-forget. Failures log to `console.error`
// and do not propagate to the caller — autonomy bookkeeping must never
// block a successful agent action.

// ─── Types ───

export const AUTONOMY_LEVEL_ORDER: Record<string, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

const PROMOTION_NEXT: Record<string, string> = { L1: "L2", L2: "L3", L3: "L4" };
const DEMOTION_PREV: Record<string, string> = { L4: "L3", L3: "L2", L2: "L1" };

export type AutonomyLevel = "L1" | "L2" | "L3" | "L4";

/** A single (action_type) entry inside `agents.autonomy_profile`. */
export interface AutonomyProfileEntryV2 {
  current_level: AutonomyLevel;
  max_level?: AutonomyLevel;
  lookback_window?: number;
  promotion_thresholds?: Record<
    "L1->L2" | "L2->L3" | "L3->L4",
    { min_consecutive: number; min_success_rate: number; min_sample: number }
  >;
  demote_on_harmful?: boolean;
  lockout_hours_after_demote?: number;
  /** ISO timestamp; promotion is locked until now() >= this. Set on demote. */
  lockout_until?: string | null;
  /**
   * ISO timestamp of the harmful action that triggered the most recent
   * demote, if any. We refuse to re-demote on the same (or older)
   * harmful action — without this, a single harmful row sitting in the
   * 50-action lookback would walk an agent from L4 → L1 over the next
   * few normal outcomes (Codex P2 #r3214228070).
   */
  last_demote_at?: string | null;
}

/** The shape of a row in `agent_actions` that this module reads. */
export interface AgentActionRow {
  phase: string;
  payload: Record<string, any> | null;
  created_at: string;
}

export interface EvaluationMetrics {
  sample_size: number;
  consecutive_approvals: number;
  success_rate: number;
  harmful_present: boolean;
  /** ISO timestamp of the harmful action that triggered the demote, if any. */
  harmful_at: string | null;
}

export interface PromotionVerdict {
  shouldPromote: boolean;
  shouldDemote: boolean;
  currentLevel: AutonomyLevel;
  newLevel: AutonomyLevel;
  /** Stable string for the promotion-history UI. */
  reason: string;
  metrics: EvaluationMetrics;
  /** Echo of the entry the verdict was computed against (with defaults applied). */
  entry: Required<
    Omit<
      AutonomyProfileEntryV2,
      "current_level" | "max_level" | "lockout_until" | "last_demote_at"
    >
  > & {
    current_level: AutonomyLevel;
    max_level: AutonomyLevel;
    lockout_until: string | null;
    last_demote_at: string | null;
  };
}

// ─── Defaults ───

const DEFAULT_THRESHOLDS = {
  "L1->L2": { min_consecutive: 5, min_success_rate: 0.8, min_sample: 10 },
  "L2->L3": { min_consecutive: 10, min_success_rate: 0.9, min_sample: 30 },
  "L3->L4": { min_consecutive: 20, min_success_rate: 0.95, min_sample: 100 },
} as const;

const DEFAULT_LOOKBACK_WINDOW = 50;
const DEFAULT_MAX_LEVEL: AutonomyLevel = "L4";
const DEFAULT_LOCKOUT_HOURS = 24;
const DEFAULT_DEMOTE_ON_HARMFUL = true;

/** Normalize an inbound profile entry, layering in defaults for missing keys. */
export function normalizeEntry(
  entry: AutonomyProfileEntryV2 | null | undefined,
): PromotionVerdict["entry"] {
  const current = (entry?.current_level ?? "L1") as AutonomyLevel;
  return {
    current_level: AUTONOMY_LEVEL_ORDER[current] ? current : "L1",
    max_level: (entry?.max_level && AUTONOMY_LEVEL_ORDER[entry.max_level]
      ? entry.max_level
      : DEFAULT_MAX_LEVEL) as AutonomyLevel,
    lookback_window:
      typeof entry?.lookback_window === "number" && entry.lookback_window > 0
        ? entry.lookback_window
        : DEFAULT_LOOKBACK_WINDOW,
    promotion_thresholds: entry?.promotion_thresholds ?? DEFAULT_THRESHOLDS,
    demote_on_harmful: entry?.demote_on_harmful ?? DEFAULT_DEMOTE_ON_HARMFUL,
    lockout_hours_after_demote:
      typeof entry?.lockout_hours_after_demote === "number"
        ? entry.lockout_hours_after_demote
        : DEFAULT_LOCKOUT_HOURS,
    lockout_until: entry?.lockout_until ?? null,
    last_demote_at: entry?.last_demote_at ?? null,
  };
}

// ─── Pure evaluator ───

/** Phases that count as a positive signal (action did its job). */
const SUCCESS_PHASES = new Set(["confirmed", "executed", "auto_executed"]);
/** Phases that count as a negative signal (operator rejected, action expired). */
const FAILURE_PHASES = new Set(["rejected", "expired"]);

export interface EvaluatePromotionInput {
  /** The (already-normalized or raw v1/v2) profile entry for this action. */
  entry: AutonomyProfileEntryV2 | null | undefined;
  /**
   * Most-recent-first list of `agent_actions` rows for this (agent, action).
   * Caller is responsible for the SELECT — this function does the math.
   *
   * Order matters: index 0 = most recent. The caller must apply
   * `ORDER BY chain_seq DESC LIMIT lookback_window` (or equivalent).
   */
  recentActions: AgentActionRow[];
  /** ISO timestamp; defaults to now(). Tests inject a fixed clock. */
  now?: string;
}

/**
 * Pure decision function. Reads the profile entry, the recent action
 * window, and the current time; returns whether to promote, demote, or
 * hold steady, along with the metrics that drove the decision.
 */
export function evaluatePromotion(
  input: EvaluatePromotionInput,
): PromotionVerdict {
  const entry = normalizeEntry(input.entry);
  const nowIso = input.now ?? new Date().toISOString();

  const windowedActions = input.recentActions.slice(0, entry.lookback_window);
  const metrics = computeMetrics(windowedActions);

  // ── Demote-on-harm path takes precedence over everything else. ──
  // We only fire on a harmful action that is *strictly newer* than
  // `last_demote_at`. Without this guard, a single harmful row that sits
  // in the lookback window (typically 50 actions = days of traffic) would
  // re-trigger on every subsequent call and walk an agent from L4 → L1
  // over the next few normal outcomes. The lockout marker doesn't help on
  // its own because it's only ~24h while the harmful row stays in the
  // window for much longer (Codex P2 #r3214228070).
  if (
    entry.demote_on_harmful &&
    metrics.harmful_present &&
    isStrictlyAfter(metrics.harmful_at, entry.last_demote_at)
  ) {
    const prev = DEMOTION_PREV[entry.current_level];
    if (prev) {
      return {
        shouldPromote: false,
        shouldDemote: true,
        currentLevel: entry.current_level,
        newLevel: prev as AutonomyLevel,
        reason: `Demoted to ${prev} due to harmful outcome at ${metrics.harmful_at ?? "unknown time"}`,
        metrics,
        entry,
      };
    }
    // Already at L1 and harmful — can't demote further. Hold + report.
    return {
      shouldPromote: false,
      shouldDemote: false,
      currentLevel: entry.current_level,
      newLevel: entry.current_level,
      reason: "Harmful outcome observed but already at L1 (no further demote)",
      metrics,
      entry,
    };
  }

  // ── Lockout window check. ──
  if (entry.lockout_until) {
    const lockoutMs = Date.parse(entry.lockout_until);
    const nowMs = Date.parse(nowIso);
    if (Number.isFinite(lockoutMs) && Number.isFinite(nowMs) && nowMs < lockoutMs) {
      return {
        shouldPromote: false,
        shouldDemote: false,
        currentLevel: entry.current_level,
        newLevel: entry.current_level,
        reason: `Promotion locked until ${entry.lockout_until}`,
        metrics,
        entry,
      };
    }
  }

  // ── Promotion path. ──
  const next = PROMOTION_NEXT[entry.current_level];
  if (!next) {
    return {
      shouldPromote: false,
      shouldDemote: false,
      currentLevel: entry.current_level,
      newLevel: entry.current_level,
      reason: "Already at L4 — no further promotion possible",
      metrics,
      entry,
    };
  }
  if (AUTONOMY_LEVEL_ORDER[next] > AUTONOMY_LEVEL_ORDER[entry.max_level]) {
    return {
      shouldPromote: false,
      shouldDemote: false,
      currentLevel: entry.current_level,
      newLevel: entry.current_level,
      reason: `Cap reached: max_level=${entry.max_level}`,
      metrics,
      entry,
    };
  }

  const transitionKey = `${entry.current_level}->${next}` as keyof typeof DEFAULT_THRESHOLDS;
  const thresholds = entry.promotion_thresholds[transitionKey] ?? DEFAULT_THRESHOLDS[transitionKey];
  if (!thresholds) {
    return {
      shouldPromote: false,
      shouldDemote: false,
      currentLevel: entry.current_level,
      newLevel: entry.current_level,
      reason: `No thresholds defined for ${transitionKey}`,
      metrics,
      entry,
    };
  }

  if (metrics.sample_size < thresholds.min_sample) {
    return {
      shouldPromote: false,
      shouldDemote: false,
      currentLevel: entry.current_level,
      newLevel: entry.current_level,
      reason: `Sample size ${metrics.sample_size} < required ${thresholds.min_sample} for ${transitionKey}`,
      metrics,
      entry,
    };
  }
  if (metrics.success_rate < thresholds.min_success_rate) {
    return {
      shouldPromote: false,
      shouldDemote: false,
      currentLevel: entry.current_level,
      newLevel: entry.current_level,
      reason: `Success rate ${metrics.success_rate.toFixed(3)} < required ${thresholds.min_success_rate} for ${transitionKey}`,
      metrics,
      entry,
    };
  }
  if (metrics.consecutive_approvals < thresholds.min_consecutive) {
    return {
      shouldPromote: false,
      shouldDemote: false,
      currentLevel: entry.current_level,
      newLevel: entry.current_level,
      reason: `Consecutive ${metrics.consecutive_approvals} < required ${thresholds.min_consecutive} for ${transitionKey}`,
      metrics,
      entry,
    };
  }

  return {
    shouldPromote: true,
    shouldDemote: false,
    currentLevel: entry.current_level,
    newLevel: next as AutonomyLevel,
    reason: `Promoted ${transitionKey} (sample=${metrics.sample_size}, success=${metrics.success_rate.toFixed(3)}, consecutive=${metrics.consecutive_approvals})`,
    metrics,
    entry,
  };
}

/**
 * Returns true if `a` is a parseable ISO timestamp strictly after `b`.
 * If `b` is null/undefined/unparseable, treats `a` as newer (so the
 * first-ever harmful action always triggers a demote). If `a` itself is
 * null/unparseable, returns false.
 */
function isStrictlyAfter(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a) return false;
  const aMs = Date.parse(a);
  if (!Number.isFinite(aMs)) return false;
  if (!b) return true;
  const bMs = Date.parse(b);
  if (!Number.isFinite(bMs)) return true;
  return aMs > bMs;
}

function computeMetrics(actions: AgentActionRow[]): EvaluationMetrics {
  let success = 0;
  let failure = 0;
  let consecutive = 0;
  let consecutiveBroken = false;
  let harmful_at: string | null = null;

  for (const a of actions) {
    const isHarmful =
      a.payload && typeof a.payload === "object" &&
      (a.payload as any).severity === "harmful";
    if (isHarmful && !harmful_at) harmful_at = a.created_at;

    if (SUCCESS_PHASES.has(a.phase) && !isHarmful) {
      success++;
      if (!consecutiveBroken) consecutive++;
    } else if (FAILURE_PHASES.has(a.phase) || isHarmful) {
      failure++;
      consecutiveBroken = true;
    }
    // Other phases (suggested, shadow) are ignored — they're not yet
    // resolved into approve/reject signals.
  }

  const sample = success + failure;
  return {
    sample_size: sample,
    consecutive_approvals: consecutive,
    success_rate: sample > 0 ? success / sample : 0,
    harmful_present: harmful_at !== null,
    harmful_at,
  };
}

// ─── Stateful wrapper ───

export interface RecordAutonomyOutcomeV2Args {
  agentId: string;
  actionType: string;
  /**
   * Optional. If provided, the function uses this as the most-recent
   * action's outcome (e.g. the call site that just fired the action knows
   * its own phase and whether the operator flagged it harmful). The lookup
   * still pulls the prior `lookback_window - 1` rows from `agent_actions`.
   *
   * If omitted, all rows come from `agent_actions`.
   */
  latest?: { phase: string; severity?: "harmful" | string; created_at?: string };
}

export interface RecordAutonomyOutcomeV2Result {
  applied: "promoted" | "demoted" | "hold";
  newLevel: AutonomyLevel;
  reason: string;
  metrics: EvaluationMetrics;
}

/**
 * Stateful wrapper. Loads the agent manifest, evaluates promotion, and if
 * the verdict is promote/demote, updates `agents.autonomy_profile` and
 * logs an `events` row. Fire-and-forget: a thrown error is swallowed and
 * surfaced via `console.error`, returning a `hold` verdict so the caller
 * is never blocked.
 *
 * Caller responsibility: pass `agentId`, `agentVersion`, `orgId`, and the
 * `actionType` for which this outcome applies. The function does the rest.
 */
export async function recordAutonomyOutcomeV2(
  supabase: any,
  args: RecordAutonomyOutcomeV2Args,
): Promise<RecordAutonomyOutcomeV2Result> {
  const HOLD: RecordAutonomyOutcomeV2Result = {
    applied: "hold",
    newLevel: "L1",
    reason: "skipped",
    metrics: {
      sample_size: 0,
      consecutive_approvals: 0,
      success_rate: 0,
      harmful_present: false,
      harmful_at: null,
    },
  };

  try {
    // 1. Load the current autonomy_profile entry for this action. We also
    //    pull org_id + version off the same row so the events insert can
    //    record both without a second round-trip.
    const { data: agentRow, error: agentErr } = await supabase
      .from("agents")
      .select("id, org_id, version, autonomy_profile")
      .eq("id", args.agentId)
      .maybeSingle();
    if (agentErr || !agentRow) {
      console.error(
        `[autonomy v2] Failed to load agent ${args.agentId}:`,
        agentErr?.message ?? "row not found",
      );
      return HOLD;
    }

    const profile = (agentRow.autonomy_profile ?? {}) as Record<
      string,
      AutonomyProfileEntryV2
    >;
    const entry = profile[args.actionType];

    // 2. Read the lookback window from `agent_actions`.
    const normalized = normalizeEntry(entry);
    const { data: actions, error: actionsErr } = await supabase
      .from("agent_actions")
      .select("phase, payload, created_at")
      .eq("agent_id", args.agentId)
      .eq("action_type", args.actionType)
      .order("chain_seq", { ascending: false })
      .limit(normalized.lookback_window);
    if (actionsErr) {
      console.error(
        `[autonomy v2] Failed to read agent_actions for ${args.agentId}/${args.actionType}:`,
        actionsErr.message,
      );
      return HOLD;
    }

    let recent: AgentActionRow[] = (actions ?? []) as AgentActionRow[];
    if (args.latest) {
      // The just-fired action may not yet be visible in agent_actions
      // (the audit dual-write is fire-and-forget upstream of this call).
      // Splice it on the front so the verdict reflects current reality.
      recent = [
        {
          phase: args.latest.phase,
          payload: args.latest.severity ? { severity: args.latest.severity } : {},
          created_at: args.latest.created_at ?? new Date().toISOString(),
        },
        ...recent,
      ].slice(0, normalized.lookback_window);
    }

    // 3. Evaluate.
    const verdict = evaluatePromotion({ entry, recentActions: recent });

    if (!verdict.shouldPromote && !verdict.shouldDemote) {
      return {
        applied: "hold",
        newLevel: verdict.newLevel,
        reason: verdict.reason,
        metrics: verdict.metrics,
      };
    }

    // 4. Apply. Build the next profile entry, preserving any keys we
    //    don't manage (allows admin custom fields to ride through).
    const nextEntry: AutonomyProfileEntryV2 = {
      ...(entry ?? {}),
      current_level: verdict.newLevel,
    };
    if (verdict.shouldDemote) {
      const lockMs = Date.now() + (verdict.entry.lockout_hours_after_demote * 3600_000);
      nextEntry.lockout_until = new Date(lockMs).toISOString();
      // Remember the harmful action that triggered this demote so we
      // don't re-demote on the same row as it sits in the lookback
      // window (Codex P2 #r3214228070).
      nextEntry.last_demote_at = verdict.metrics.harmful_at ?? new Date().toISOString();
    } else if (verdict.shouldPromote) {
      // Promotion clears any prior lockout marker — the system has
      // re-earned trust by climbing through the threshold.
      nextEntry.lockout_until = null;
    }

    // Atomic single-key UPDATE via SECURITY DEFINER RPC. The previous
    // read-modify-write of the whole `autonomy_profile` raced concurrent
    // outcomes for *different* action types — second write would drop
    // the first (Codex P2 #r3214228075). The RPC's `jsonb_set` merges
    // into the live column rather than overwriting it.
    const { error: rpcErr } = await supabase.rpc(
      "update_autonomy_profile_entry_v1",
      {
        p_agent_id:    args.agentId,
        p_action_type: args.actionType,
        p_entry:       nextEntry,
        p_updated_by:  "system:autonomy_v2",
      },
    );
    if (rpcErr) {
      console.error(
        `[autonomy v2] Failed to update autonomy_profile for ${args.agentId}/${args.actionType}:`,
        rpcErr.message,
      );
      return HOLD;
    }

    // 5. Audit trail to events bus.
    const eventType = verdict.shouldPromote
      ? "agent_autonomy_promoted"
      : "agent_autonomy_demoted";
    supabase
      .from("events")
      .insert({
        org_id: agentRow.org_id,
        agent_id: args.agentId,
        event_type: eventType,
        // events.entity_type CHECK accepts ('caregiver', 'client') only;
        // agent-scoped events use the agent_id column itself, with
        // entity_type/entity_id NULL (matches `toggle_agent_flag_v1`).
        entity_type: null,
        entity_id: null,
        actor: "system:autonomy_v2",
        payload: {
          action_type:    args.actionType,
          from_level:     verdict.currentLevel,
          to_level:       verdict.newLevel,
          reason:         verdict.reason,
          metrics:        verdict.metrics,
          agent_version:  agentRow.version,
        },
      })
      .then(() => {})
      .catch((err: Error) =>
        console.error(`[autonomy v2] Failed to log ${eventType} event:`, err),
      );

    return {
      applied: verdict.shouldPromote ? "promoted" : "demoted",
      newLevel: verdict.newLevel,
      reason: verdict.reason,
      metrics: verdict.metrics,
    };
  } catch (err) {
    console.error(
      `[autonomy v2] Unexpected error for ${args.agentId}/${args.actionType}:`,
      err,
    );
    return HOLD;
  }
}
