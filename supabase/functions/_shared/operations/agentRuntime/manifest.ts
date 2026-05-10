// ─── Agent Manifest Loading ───
//
// Loads an agent manifest from the `agents` table and exposes a typed view
// of every field the runtime cares about. The loader is intentionally small —
// it does no caching across requests (Edge runtimes are short-lived enough
// that per-request lookups are fine) and no business logic. The runtime in
// `agentRuntime.ts` is responsible for interpreting kill_switch / shadow_mode
// / context_recipe / tool_allowlist; this module just hands them over.
//
// Phase 0.3 / Agent Platform — see docs/AGENT_PLATFORM.md.

export interface AgentManifest {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  version: number;

  system_prompt: string;
  tool_allowlist: string[];
  autonomy_profile: Record<string, { current_level?: string }>;
  context_recipe: {
    layers?: string[];
    pipeline_scope?: string;
    modes?: string[];
    [k: string]: any;
  };
  model: string;
  max_iterations: number;

  kill_switch: boolean;
  shadow_mode: boolean;
  /**
   * Phase 1.3 — when true, every tool call (auto AND confirm tier) is
   * suppressed and returns a synthetic "tool suppressed" result. The
   * agent still runs and replies from prior context, but performs no
   * DB reads, no DB writes, and creates no `ai_suggestions` rows.
   * Distinct from `shadow_mode` (which only reroutes confirm-tier
   * writes) and `kill_switch` (which prevents the agent from running
   * at all). Defaults false on every existing row via the
   * `20260510150000_…_read_only_mode_column.sql` migration.
   */
  read_only_mode: boolean;

  outcome_definition: Record<string, any>;
  triggers: Record<string, any>;
}

export class AgentNotFoundError extends Error {
  readonly code = "agent_not_found";
  constructor(slug: string, orgId: string) {
    super(`Agent manifest not found for slug="${slug}" org_id=${orgId}.`);
    this.name = "AgentNotFoundError";
  }
}

export class MissingOrgIdError extends Error {
  readonly code = "missing_org_id";
  constructor() {
    super(
      "loadManifest: orgId is required. The runtime uses a service-role " +
        "supabase client which bypasses RLS, so manifest queries must scope " +
        "by org_id explicitly. (agents.unique = (org_id, slug); a slug-only " +
        "lookup returns multiple rows once a second org exists.)",
    );
    this.name = "MissingOrgIdError";
  }
}

export interface LoadManifestOptions {
  /**
   * Org id to scope the lookup to. **Required.** The runtime uses a
   * service-role supabase client which bypasses RLS — and the
   * `agents` schema enforces uniqueness on (org_id, slug), not slug alone.
   * A slug-only query would return multiple rows the moment customer #2
   * is onboarded and `maybeSingle()` would error. Forcing every caller to
   * supply an explicit org id is the only correct posture; it also matches
   * SaaS retrofit Prime Directive #3 ("every new query is org-scoped").
   *
   * Phase 0.4 callers resolve this from the staff JWT (`org_id` claim)
   * for chat invocations and from a known constant for cron-triggered
   * planner / router invocations.
   */
  orgId: string;
}

/**
 * Look up an agent manifest by `(org_id, slug)`. Throws:
 *   - `MissingOrgIdError` if `options.orgId` is empty / undefined.
 *   - `AgentNotFoundError` if no row matches.
 *   - A plain Error on transport failure.
 */
export async function loadManifest(
  supabase: any,
  slug: string,
  options: LoadManifestOptions,
): Promise<AgentManifest> {
  if (!options || typeof options.orgId !== "string" || options.orgId.length === 0) {
    throw new MissingOrgIdError();
  }

  const { data, error } = await supabase
    .from("agents")
    .select(
      "id, org_id, slug, name, version, system_prompt, tool_allowlist, autonomy_profile, context_recipe, model, max_iterations, kill_switch, shadow_mode, read_only_mode, outcome_definition, triggers",
    )
    .eq("slug", slug)
    .eq("org_id", options.orgId)
    .maybeSingle();

  if (error) {
    throw new Error(`Manifest load failed for slug=${slug}: ${error.message}`);
  }

  if (!data) {
    throw new AgentNotFoundError(slug, options.orgId);
  }

  return data as AgentManifest;
}

/**
 * Phase 1.3 — runtime flag snapshot. Returned by `loadAgentFlags` for
 * the per-iteration recheck inside the chat handler tool-use loop.
 *
 * Three booleans, one tiny SELECT — fast enough to call on every
 * iteration without blowing the latency budget. (1 round-trip per
 * iteration × max_iterations × chat_sessions/day = small overhead;
 * see Phase 1.3's risk note in `docs/AGENT_PLATFORM.md`.)
 */
export interface AgentRuntimeFlags {
  kill_switch: boolean;
  shadow_mode: boolean;
  read_only_mode: boolean;
}

/**
 * Re-reads the three runtime safety flags for an already-loaded agent.
 *
 * Used by `runChatHandler` at the top of each tool-use iteration so
 * that an admin flipping `kill_switch` / `shadow_mode` /
 * `read_only_mode` mid-flight takes effect on the *next* iteration,
 * not just the next chat invocation.
 *
 * Failure semantics: returns `null` on any error. Callers MUST treat
 * a null result as "keep going with the prior snapshot" — failing
 * closed (e.g. forcing kill on transient DB errors) would create a
 * worse failure mode than the bug we're trying to prevent.
 */
export async function loadAgentFlags(
  supabase: any,
  agentId: string,
): Promise<AgentRuntimeFlags | null> {
  if (!agentId) return null;
  try {
    const { data, error } = await supabase
      .from("agents")
      .select("kill_switch, shadow_mode, read_only_mode")
      .eq("id", agentId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      kill_switch:    !!data.kill_switch,
      shadow_mode:    !!data.shadow_mode,
      read_only_mode: !!data.read_only_mode,
    };
  } catch {
    return null;
  }
}

/**
 * Returns the autonomy level configured for a given action on this agent.
 * Falls back to "L2" (confirm) if the action isn't enumerated in the profile —
 * matches today's `lookupAutonomyLevel` default behaviour in
 * `_shared/operations/routing.ts`.
 */
export function levelForAction(
  manifest: AgentManifest,
  actionType: string,
): string {
  const entry = manifest.autonomy_profile?.[actionType];
  if (entry && typeof entry.current_level === "string") {
    return entry.current_level;
  }
  return "L2";
}

/**
 * Returns true if the agent's manifest allows this tool. Used to gate
 * tool-registry filtering and also to reject Claude-suggested tool calls
 * that aren't in the allowlist.
 */
export function isToolAllowed(
  manifest: AgentManifest,
  toolName: string,
): boolean {
  return manifest.tool_allowlist.includes(toolName);
}

/**
 * Returns the layers the manifest's context_recipe selects, or null if the
 * recipe doesn't pin a list (in which case the runtime uses today's full
 * default set — preserving legacy behaviour during the 0.3 → 0.4 cutover).
 */
export function recipeLayers(manifest: AgentManifest): string[] | null {
  const layers = manifest.context_recipe?.layers;
  if (Array.isArray(layers) && layers.every((l) => typeof l === "string")) {
    return layers;
  }
  return null;
}
