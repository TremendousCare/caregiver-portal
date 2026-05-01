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
export { AgentNotFoundError, isToolAllowed, levelForAction, recipeLayers };

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
  status: "ok" | "killed" | "shadow" | "iteration_limit" | "error" | "skipped";
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
  agent: { id: string; slug: string; version: number };
  shadow: boolean;
  error?: { message: string; code?: string };
}

export interface RunAgentOptions {
  /** Service-role supabase client (the runtime never uses user JWT in 0.3). */
  // (passed positionally; documented here for clarity)
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
  /** Optional org id to scope the manifest lookup. Defaults to RLS-implicit. */
  orgId?: string;
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
  options: RunAgentOptions = {},
): Promise<AgentResult> {
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
        agent: { id: "", slug, version: 0 },
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
      agent: { id: "", slug, version: 0 },
      shadow: false,
      cost: { ...ZERO_COST },
    };
  }

  const agentRef = {
    id: manifest.id,
    slug: manifest.slug,
    version: manifest.version,
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
        // In shadow mode, swap the executeTool wrapper so confirm-tier tools
        // never reach side effects. The chat agent's "auto" tools are reads
        // only; they stay live (matches Phase 1.3's described behaviour).
        const chatReq = manifest.shadow_mode
          ? wrapChatRequestForShadow(request.chat, manifest)
          : request.chat;
        handlerResult = await runChatHandler(manifest, handlerDeps, chatReq);
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

  // Apply shadow status override at the orchestrator boundary so callers can
  // distinguish "the agent ran successfully but in shadow mode" from a regular
  // ok. We never silently downgrade an iteration_limit or error — those still
  // propagate.
  let finalStatus = handlerResult.status;
  if (manifest.shadow_mode && finalStatus === "ok") {
    finalStatus = "shadow";
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
  agent: { id: string; slug: string; version: number },
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
function wrapChatRequestForShadow(
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

// ─── Test-only re-exports ───

export const __testables = {
  ZERO_COST,
  SHADOW_SUGGESTION_STATUS,
  wrapChatRequestForShadow,
};
