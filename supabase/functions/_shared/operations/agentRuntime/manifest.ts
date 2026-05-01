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

  outcome_definition: Record<string, any>;
  triggers: Record<string, any>;
}

export class AgentNotFoundError extends Error {
  readonly code = "agent_not_found";
  constructor(slug: string, orgId?: string) {
    super(
      `Agent manifest not found for slug="${slug}"${orgId ? ` org_id=${orgId}` : ""}.`,
    );
    this.name = "AgentNotFoundError";
  }
}

export interface LoadManifestOptions {
  /**
   * Org id to scope the lookup to. Defaults to the caller's resolved org. In
   * Phase 0.3 every call passes Tremendous Care's org via the supabase
   * service-role client, which bypasses RLS. Phase 0.4 + Phase B5 work
   * tightens this — at that point the runtime resolves org from the JWT.
   */
  orgId?: string;
}

/**
 * Look up an agent manifest by slug. Throws `AgentNotFoundError` if no row
 * matches. Throws a plain Error on transport failure (so callers can decide
 * whether to retry or surface).
 */
export async function loadManifest(
  supabase: any,
  slug: string,
  options: LoadManifestOptions = {},
): Promise<AgentManifest> {
  let query = supabase
    .from("agents")
    .select(
      "id, org_id, slug, name, version, system_prompt, tool_allowlist, autonomy_profile, context_recipe, model, max_iterations, kill_switch, shadow_mode, outcome_definition, triggers",
    )
    .eq("slug", slug);

  if (options.orgId) {
    query = query.eq("org_id", options.orgId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`Manifest load failed for slug=${slug}: ${error.message}`);
  }

  if (!data) {
    throw new AgentNotFoundError(slug, options.orgId);
  }

  return data as AgentManifest;
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
