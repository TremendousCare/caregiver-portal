// ─── Agent Runtime (Phase 0.3) ───
//
// One entry point — `runAgent(supabase, slug, request)` — that loads an
// agent manifest, applies kill_switch + shadow_mode, dispatches to the
// per-shape handler (chat / planner / router), stamps every write with
// `agent_id`, and returns a normalized result.
//
// This module ships in Phase 0.3 with NO call sites in production. The
// existing edge functions (`ai-chat`, `ai-planner`, `message-router`) are
// untouched. Phase 0.4 thins those functions down to call `runAgent`. Until
// then, this is exercised solely by the unit (Layer A), parity (Layer B),
// and live-API (Layer C) test harnesses in `src/lib/__tests__/`.
//
// Behavioural contract:
//   * Pure additive — touching this module never changes production today.
//   * Manifest-driven — model, max_iterations, system_prompt, tool_allowlist,
//     context_recipe, and autonomy_profile all come from the agents row.
//   * Kill switch returns immediately with a `killed` status; nothing is
//     written to ai_suggestions, action_outcomes, events, or context_memory.
//   * Shadow mode executes the agent loop normally but routes every
//     would-be side-effect to `ai_suggestions` with `status='shadow'` and
//     never invokes `executeSuggestion`.
//   * Every write that the runtime is responsible for stamps `agent_id`.
//     (The shells own writes that happen before/after the runtime call;
//     those get stamped in Phase 0.4 cutover.)
//
// See docs/AGENT_PLATFORM.md → Phase 0.3 for the full design.

import {
  AgentManifest,
  AgentNotFoundError,
  MissingOrgIdError,
  loadManifest,
  isToolAllowed,
  levelForAction,
  recipeLayers,
} from "./agentRuntime/manifest.ts";
import {
  HandlerDeps,
  HandlerResult,
  HandlerSuggestion,
  ChatHandlerRequest,
  PlannerHandlerRequest,
  RouterHandlerRequest,
  RouterClassification,
  runChatHandler,
  runPlannerHandler,
  runRouterHandler,
} from "./agentRuntime/handlers.ts";

export type {
  AgentManifest,
  ChatHandlerRequest,
  PlannerHandlerRequest,
  RouterHandlerRequest,
  RouterClassification,
};
export {
  AgentNotFoundError,
  MissingOrgIdError,
  isToolAllowed,
  levelForAction,
  recipeLayers,
};

// ─── Public types ───

export type AgentInvocationShape = "chat" | "planner" | "router";

export interface AgentRequest {
  shape: AgentInvocationShape;
  /** Chat-shape payload. Required when shape === "chat". */
  chat?: ChatHandlerRequest;
  /** Planner-shape payload. Required when shape === "planner". */
  planner?: PlannerHandlerRequest;
  /** Router-shape payload. Required when shape === "router". */
  router?: RouterHandlerRequest;
}

export interface AgentResult {
  status: "ok" | "killed" | "shadow" | "read_only" | "iteration_limit" | "error" | "skipped";
  reply?: string;
  pendingConfirmation?: any;
  toolResults?: Array<{ tool: string; input: any; result: any }>;
  /** Suggestions written by the runtime. In shadow mode every write lands here. */
  suggestions?: HandlerSuggestion[];
  /** Router-only: the parsed classification (null when error). */
  classification?: RouterClassification | null;
  cost: {
    input_tokens: number;
    output_tokens: number;
    iterations: number;
    duration_ms: number;
  };
  contextHealth?: any;
  agent: { id: string; slug: string; version: number; model: string };
  shadow: boolean;
  error?: { message: string; code?: string };
}

export interface RunAgentOptions {
  /**
   * Org id to scope the manifest lookup to. **Required.** The runtime uses a
   * service-role supabase client which bypasses RLS, and `agents.unique` is
   * `(org_id, slug)` — a slug-only query would return multiple rows the
   * moment customer #2 is onboarded. Phase 0.4 shells resolve this from the
   * staff JWT for chat or from a known constant for cron-triggered runs.
   */
  orgId: string;
  /** Anthropic API key. Pulled from env in production; injected in tests. */
  apiKey?: string;
  /** Override fetch (tests). Production uses globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override the Anthropic POST helper (tests). */
  callAnthropicImpl?: HandlerDeps["callAnthropicImpl"];
  /** Override now() for deterministic cost.duration_ms (tests). */
  now?: () => number;
  /** Override sleep() so retry backoff doesn't burn real time (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const ZERO_COST = {
  input_tokens: 0,
  output_tokens: 0,
  iterations: 0,
  duration_ms: 0,
};

const SHADOW_SUGGESTION_STATUS = "shadow";

/**
 * Loads the agent manifest for `slug`, applies kill_switch + shadow_mode,
 * and dispatches `request` to the right handler. Returns a normalized
 * `AgentResult`. Never throws on operational errors — they're surfaced
 * through `result.status === "error"` with a structured `error` field.
 */
export async function runAgent(
  supabase: any,
  slug: string,
  request: AgentRequest,
  options: RunAgentOptions,
): Promise<AgentResult> {
  // ── Validate orgId (required) ──
  if (
    !options ||
    typeof options.orgId !== "string" ||
    options.orgId.length === 0
  ) {
    return {
      status: "error",
      error: {
        message:
          "runAgent: options.orgId is required. The runtime uses a service-role " +
          "supabase client and agents.unique is (org_id, slug) — every call must " +
          "scope the manifest lookup to an explicit org.",
        code: "missing_org_id",
      },
      agent: { id: "", slug, version: 0, model: "" },
      shadow: false,
      cost: { ...ZERO_COST },
    };
  }

  // ── Resolve API key ──
  let apiKey = options.apiKey;
  if (!apiKey) {
    try {
      apiKey =
        typeof Deno !== "undefined" && Deno.env
          ? Deno.env.get("ANTHROPIC_API_KEY") ?? undefined
          : undefined;
    } catch {
      apiKey = undefined;
    }
  }

  // ── Load manifest ──
  let manifest: AgentManifest;
  try {
    manifest = await loadManifest(supabase, slug, { orgId: options.orgId });
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      return {
        status: "error",
        error: { message: err.message, code: err.code },
        agent: { id: "", slug, version: 0, model: "" },
        shadow: false,
        cost: { ...ZERO_COST },
      };
    }
    if (err instanceof MissingOrgIdError) {
      return {
        status: "error",
        error: { message: err.message, code: err.code },
        agent: { id: "", slug, version: 0, model: "" },
        shadow: false,
        cost: { ...ZERO_COST },
      };
    }
    return {
      status: "error",
      error: {
        message: (err as Error).message || "manifest_load_failed",
        code: "manifest_load_failed",
      },
      agent: { id: "", slug, version: 0, model: "" },
      shadow: false,
      cost: { ...ZERO_COST },
    };
  }

  const agentRef = {
    id: manifest.id,
    slug: manifest.slug,
    version: manifest.version,
    model: manifest.model,
  };

  // ── Kill switch — return immediately, no Claude call, no writes. ──
  if (manifest.kill_switch) {
    return {
      status: "killed",
      reply:
        "Agent is currently dormant (kill switch engaged). No action taken.",
      agent: agentRef,
      shadow: false,
      cost: { ...ZERO_COST },
    };
  }

  if (!apiKey) {
    return {
      status: "error",
      error: {
        message: "ANTHROPIC_API_KEY not configured",
        code: "missing_api_key",
      },
      agent: agentRef,
      shadow: manifest.shadow_mode,
      cost: { ...ZERO_COST },
    };
  }

  // ── Validate request shape ──
  if (!request || !request.shape) {
    return {
      status: "error",
      error: {
        message: "AgentRequest.shape is required",
        code: "invalid_request",
      },
      agent: agentRef,
      shadow: manifest.shadow_mode,
      cost: { ...ZERO_COST },
    };
  }

  const handlerDeps: HandlerDeps = {
    supabase,
    apiKey,
    fetchImpl: options.fetchImpl,
    callAnthropicImpl: options.callAnthropicImpl,
    sleep: options.sleep,
    now: options.now,
  };

  // ── Dispatch ──
  let handlerResult: HandlerResult & {
    classification?: RouterClassification | null;
  };

  try {
    switch (request.shape) {
      case "chat": {
        if (!request.chat) {
          return shapeMismatch("chat", agentRef, manifest.shadow_mode);
        }
        // Phase 1.3 — wrapping the executeTool fn for shadow / read_only
        // is now done INSIDE `runChatHandler` (via `chooseExecuteTool`)
        // rather than here. Reason: the per-iteration recheck needs to
        // be able to *unwrap* when an admin clears the flag mid-flight,
        // and that requires the handler to keep a reference to the raw
        // executor `req.executeTool`. If we pre-wrap here, the handler
        // sees only the wrapper and can't restore live behaviour
        // (Codex P2 #r3214997666). The exported wrappers below remain
        // for unit tests of the wrap shape itself.
        handlerResult = await runChatHandler(manifest, handlerDeps, request.chat);
        break;
      }
      case "planner": {
        if (!request.planner) {
          return shapeMismatch("planner", agentRef, manifest.shadow_mode);
        }
        handlerResult = await runPlannerHandler(
          manifest,
          handlerDeps,
          request.planner,
        );
        break;
      }
      case "router": {
        if (!request.router) {
          return shapeMismatch("router", agentRef, manifest.shadow_mode);
        }
        handlerResult = await runRouterHandler(
          manifest,
          handlerDeps,
          request.router,
        );
        break;
      }
      default:
        return {
          status: "error",
          error: {
            message: `Unknown agent invocation shape: ${(request as any).shape}`,
            code: "invalid_request",
          },
          agent: agentRef,
          shadow: manifest.shadow_mode,
          cost: { ...ZERO_COST },
        };
    }
  } catch (err) {
    return {
      status: "error",
      error: {
        message: (err as Error).message || "handler_threw",
        code: "handler_exception",
      },
      agent: agentRef,
      shadow: manifest.shadow_mode,
      cost: { ...ZERO_COST },
    };
  }

  // Apply shadow / read-only status override at the orchestrator boundary
  // so callers can distinguish "the agent ran successfully under a runtime
  // restriction" from a regular ok. Phase 1.3: read_only is its own
  // surface and supersedes shadow when both are on (read_only is strictly
  // more restrictive — see Prime Directive #6 + the wrap precedence in
  // the chat dispatch above). We never silently downgrade an
  // iteration_limit or error — those still propagate.
  let finalStatus = handlerResult.status;
  if (finalStatus === "ok") {
    if (manifest.read_only_mode) finalStatus = "read_only";
    else if (manifest.shadow_mode) finalStatus = "shadow";
  } else if (finalStatus === "killed_mid_flight") {
    // Phase 1.3 — handler-level kill flip mid-iteration. Surface as
    // killed so the caller treats it identically to a kill_switch
    // tripped before dispatch.
    finalStatus = "killed";
  }

  return {
    status: finalStatus,
    reply: handlerResult.reply,
    pendingConfirmation: handlerResult.pendingConfirmation,
    toolResults: handlerResult.toolResults,
    suggestions: handlerResult.suggestions,
    classification: handlerResult.classification,
    cost: handlerResult.cost,
    contextHealth: handlerResult.contextHealth,
    agent: agentRef,
    shadow: manifest.shadow_mode,
    error: handlerResult.error,
  };
}

// ─── Internal helpers ───

function shapeMismatch(
  shape: AgentInvocationShape,
  agent: { id: string; slug: string; version: number; model: string },
  shadow: boolean,
): AgentResult {
  return {
    status: "error",
    error: {
      message: `AgentRequest.${shape} payload is required when shape="${shape}"`,
      code: "invalid_request",
    },
    agent,
    shadow,
    cost: { ...ZERO_COST },
  };
}

/**
 * In shadow mode, intercept the chat handler's confirm-tier tool execution.
 * Auto-tier (read-only) tools pass through; confirm-tier tools resolve to a
 * synthetic "shadow" result without ever reaching the side-effect path.
 *
 * The runtime owns this wrap (rather than asking every caller to do it)
 * because shadow mode is a runtime guarantee, not a caller convention.
 */
export function wrapChatRequestForShadow(
  req: ChatHandlerRequest,
  manifest: AgentManifest,
): ChatHandlerRequest {
  const originalExecute = req.executeTool;
  const wrappedExecute = async (name: string, input: any, ctx: any) => {
    if (req.confirmTools.has(name)) {
      // Synthetic confirm-tier shadow result. No DB write here — the
      // suggestion-row write is the shell's responsibility in 0.4. For
      // 0.3 this short-circuits the side effect and the runtime returns
      // status='shadow' to the caller.
      return {
        status: "shadow",
        message: `Shadow mode: ${name} would have been suggested for confirmation.`,
        shadow: true,
        agent_id: manifest.id,
        agent_slug: manifest.slug,
      };
    }
    return await originalExecute(name, input, ctx);
  };
  return { ...req, executeTool: wrappedExecute };
}

/**
 * Phase 1.3 — read-only mode wrapper. Suppresses *every* tool call (auto
 * AND confirm tier) and returns a synthetic result. Used when an agent
 * needs to run against prior context only — privacy mode, debugging
 * without side effects, or agents pinned to historical-only context.
 *
 * Distinct from shadow mode (which only intercepts confirm-tier writes
 * and lets auto-tier reads through). Read-only is strictly more
 * restrictive: a read-only agent makes zero DB queries beyond what the
 * shell already loaded into the request payload.
 */
export function wrapChatRequestForReadOnly(
  req: ChatHandlerRequest,
  manifest: AgentManifest,
): ChatHandlerRequest {
  const wrappedExecute = async (name: string, _input: any, _ctx: any) => {
    return {
      status: "read_only",
      message:
        `Read-only mode: ${name} was suppressed. The agent must respond from prior context only.`,
      read_only: true,
      agent_id: manifest.id,
      agent_slug: manifest.slug,
    };
  };
  return { ...req, executeTool: wrappedExecute };
}

// ─── Test-only re-exports ───

export const __testables = {
  ZERO_COST,
  SHADOW_SUGGESTION_STATUS,
  wrapChatRequestForShadow,
  wrapChatRequestForReadOnly,
};
