// ─── Agent Runtime Handlers ───
//
// Three internal handlers — one per existing production agent shape. Each is
// invoked from `agentRuntime.runAgent()` after manifest load, kill_switch
// check, and shadow_mode setup. The handlers are designed to produce outputs
// byte-equal with the legacy edge function paths so Phase 0.4's cutover can
// flip the call site without behaviour drift.
//
//   runChatHandler    — recruiting agent (today's ai-chat agentic loop)
//   runPlannerHandler — proactive_planner (today's ai-planner Sonnet call)
//   runRouterHandler  — inbound_router  (today's message-router Haiku classifier)
//
// The handlers do NOT handle:
//   * authentication / rate-limiting (those live in the edge-function shells)
//   * cron idempotency (last_planner_run check) — same reason
//   * webhook intake (message_routing_queue read/update) — same reason
// Phase 0.4 keeps those concerns in the per-agent shells so the runtime stays
// a pure orchestrator.

import { callAnthropic } from "./anthropic.ts";
import {
  AgentManifest,
  AgentRuntimeFlags,
  isToolAllowed,
  levelForAction,
  loadAgentFlags,
  recipeLayers,
} from "./manifest.ts";

// ─── Shared types ───

export interface HandlerDeps {
  supabase: any;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Optional override of the Anthropic call (tests inject canned responses). */
  callAnthropicImpl?: typeof callAnthropic;
  /** Optional sleep override for retry backoff (tests pass no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Now() override for deterministic tests. */
  now?: () => number;
  /**
   * Phase 1.3 — per-iteration flag recheck override. Tests inject a
   * stub that flips kill_switch / shadow_mode / read_only_mode between
   * iterations to verify the loop respects mid-flight admin toggles.
   * Production paths use the default `loadAgentFlags` import.
   */
  loadAgentFlagsImpl?: (
    supabase: any,
    agentId: string,
  ) => Promise<AgentRuntimeFlags | null>;
}

export interface HandlerCost {
  input_tokens: number;
  output_tokens: number;
  iterations: number;
  duration_ms: number;
}

export interface HandlerSuggestion {
  id: string | null;
  status: string;
  agent_id: string;
  action_type: string | null;
}

export interface HandlerResult {
  status: "ok" | "shadow" | "read_only" | "killed_mid_flight" | "iteration_limit" | "error" | "skipped";
  reply?: string;
  pendingConfirmation?: any;
  toolResults?: Array<{ tool: string; input: any; result: any }>;
  suggestions?: HandlerSuggestion[];
  cost: HandlerCost;
  contextHealth?: any;
  error?: { message: string; code?: string };
}

const zeroCost = (): HandlerCost => ({
  input_tokens: 0,
  output_tokens: 0,
  iterations: 0,
  duration_ms: 0,
});

// ─── Recruiting / chat handler ───

export interface ChatHandlerRequest {
  messages: Array<{ role: "user" | "assistant"; content: any }>;
  caregiverId?: string;
  currentUser?: string;
  currentUserMailbox?: string | null;
  /** Caregivers + clients snapshot — provided by the shell (it owns the DB read). */
  caregivers?: any[];
  clients?: any[];
  /**
   * The shell wires these up. The runtime stays decoupled from the registry
   * import surface so unit tests can pass small shapes without registering
   * the full 40-tool set.
   */
  toolDefinitions: Array<{ name: string; description?: string; input_schema?: any }>;
  autoExecuteTools: Set<string>;
  confirmTools: Set<string>;
  executeTool: (
    name: string,
    input: any,
    ctx: any,
  ) => Promise<any>;
  /** Optional override for system-prompt assembly (tests inject deterministic prompts). */
  assembleSystemPrompt?: (ctx: {
    supabase: any;
    caregivers: any[];
    clients: any[];
    caregiverId?: string;
    currentUser: string;
    userQuery?: string;
    enabledLayers?: string[] | null;
    manifestPrompt: string;
  }) => Promise<{ prompt: string; health: any }>;
  /** Optional fallback prompt builder (matches ai-chat fallback path). */
  buildFallbackPrompt?: (caregivers: any[], caregiverId: string | undefined, clients: any[]) => string;
  /** Optional model override (tests). Defaults to manifest.model. */
  modelOverride?: string;
  /** Optional max_tokens override (tests). Defaults to 4096 matching ai-chat. */
  maxTokens?: number;
}

const CHAT_DEFAULT_MAX_TOKENS = 4096;

export async function runChatHandler(
  manifest: AgentManifest,
  deps: HandlerDeps,
  req: ChatHandlerRequest,
): Promise<HandlerResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const callImpl = deps.callAnthropicImpl ?? callAnthropic;

  const apiMessages = (req.messages || [])
    .slice(-20)
    .map((m: any) => ({ role: m.role, content: m.content }));

  // Build the system prompt. The runtime composes manifest.system_prompt
  // (the static template stored in the agents row) with the legacy assembler
  // layers selected by context_recipe.layers. If the caller doesn't supply
  // an assembler, fall back to the static prompt only.
  const latestUserMsg = apiMessages
    .slice()
    .reverse()
    .find((m: any) => m.role === "user" && typeof m.content === "string");

  let systemPrompt = manifest.system_prompt;
  let contextHealth: any = null;
  // Phase 1.3 — under read_only_mode, skip the assembler entirely.
  // The assembler reads situational / memory / thread layers from
  // Supabase before the loop. Read-only mode's user-facing guarantee
  // is "the agent runs from prior context only, no DB access" — that
  // would be a broken promise if the per-session context-assembly
  // reads still fired. We use the manifest's static system_prompt as
  // the only context, mirroring the buildFallbackPrompt path's minimal
  // shape (Codex P2 #r3214997663).
  if (manifest.read_only_mode) {
    contextHealth = {
      status: "read_only",
      layersLoaded: ["identity", "guidelines"],
      layersFailed: [],
      layersSkipped: ["situational", "memories", "threads", "viewing"],
      tokenEstimate: 0,
    };
  } else if (req.assembleSystemPrompt) {
    try {
      const result = await req.assembleSystemPrompt({
        supabase: deps.supabase,
        caregivers: req.caregivers || [],
        clients: req.clients || [],
        caregiverId: req.caregiverId,
        currentUser: req.currentUser || "User",
        userQuery: latestUserMsg?.content,
        enabledLayers: recipeLayers(manifest),
        manifestPrompt: manifest.system_prompt,
      });
      systemPrompt = result.prompt;
      contextHealth = result.health;
    } catch (err) {
      // Match ai-chat fallback semantics: warn, fall back to static prompt.
      console.warn("[agentRuntime/chat] Assembler failed, using fallback:", err);
      if (req.buildFallbackPrompt) {
        systemPrompt = req.buildFallbackPrompt(
          req.caregivers || [],
          req.caregiverId,
          req.clients || [],
        );
      }
      contextHealth = {
        status: "minimal",
        layersLoaded: ["identity", "guidelines"],
        layersFailed: ["assembler"],
        layersTrimmed: [],
        tokenEstimate: 0,
      };
    }
  }

  // Filter tools by manifest allowlist. Definitions stay in registry order;
  // we only drop the ones the manifest doesn't permit.
  const tools = req.toolDefinitions.filter((t) =>
    isToolAllowed(manifest, t.name)
  );

  let finalReply = "";
  let pendingConfirmation: any = null;
  const toolResults: Array<{ tool: string; input: any; result: any }> = [];
  const currentMessages: any[] = [...apiMessages];
  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let exitedWithoutResponse = false;
  // Phase 1.3 — runtime mode wrapping is decided here, against the raw
  // `req.executeTool`. Doing it here (rather than at the dispatch site
  // in `agentRuntime.ts`) means the per-iteration recheck below can
  // *unwrap* when an admin clears the flag mid-flight by simply
  // re-running `chooseExecuteTool` with the live snapshot — without
  // this, a session that started in shadow/read_only could never
  // restore live tool execution because we'd be re-wrapping the
  // already-wrapped executor (Codex P2 #r3214997666).
  //
  // Initial snapshot mirrors the manifest as seen by the dispatcher;
  // recheck on subsequent iterations updates it.
  let flagsSnapshot: AgentRuntimeFlags = {
    kill_switch:    !!manifest.kill_switch,
    shadow_mode:    !!manifest.shadow_mode,
    read_only_mode: !!manifest.read_only_mode,
  };
  let activeExecuteTool = chooseExecuteTool(req, manifest, flagsSnapshot);
  let killedMidFlight = false;
  const flagsImpl = deps.loadAgentFlagsImpl ?? loadAgentFlags;

  while (iterations < manifest.max_iterations) {
    iterations++;

    // ── Phase 1.3 — per-iteration runtime-flag recheck. ──
    // The startup-time kill_switch check in `runAgent` only stops a
    // brand-new invocation; without this, an admin who flips kill
    // mid-flight would still see this loop drain to its
    // max_iterations cap (≤15 iterations × ~5–15s/iter = up to a
    // couple of minutes of wasted Claude tokens + tool side effects).
    //
    // Recheck happens AFTER iterations++ so the cost stays bounded
    // (we still cap at max_iterations) but BEFORE the Claude call so
    // a kill flip prevents the next round-trip.
    //
    // Skip on iteration 1 — the dispatcher just loaded the manifest,
    // and a recheck here would be a wasted DB hit. From iteration 2
    // onward we re-fetch (small SELECT — three boolean columns).
    if (iterations > 1 && manifest.id) {
      const live = await flagsImpl(deps.supabase, manifest.id);
      if (live) {
        // Kill switch flipped on mid-flight → break out of the loop
        // immediately. We surface the partial reply if we already
        // have one (so the user sees what we managed to say) but do
        // NOT execute any further tools.
        if (live.kill_switch && !flagsSnapshot.kill_switch) {
          killedMidFlight = true;
          break;
        }
        // Mode flips (shadow / read_only) — re-wrap activeExecuteTool
        // so subsequent tool calls honor the new mode. The wrappers
        // here mirror the ones in `agentRuntime.ts`; we keep them
        // inline rather than importing to avoid a circular dep.
        if (
          live.read_only_mode !== flagsSnapshot.read_only_mode ||
          live.shadow_mode !== flagsSnapshot.shadow_mode
        ) {
          activeExecuteTool = chooseExecuteTool(req, manifest, live);
        }
        flagsSnapshot = live;
      }
      // live === null means the recheck SELECT failed transiently.
      // Fall through with the prior snapshot — failing closed (e.g.
      // forcing a kill) on a transient DB hiccup would create a worse
      // failure mode than the bug this recheck prevents.
    }

    const requestBody = {
      model: req.modelOverride ?? manifest.model,
      max_tokens: req.maxTokens ?? CHAT_DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages: currentMessages,
      tools,
    };

    const callResult = await callImpl({
      apiKey: deps.apiKey,
      body: requestBody,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });

    if (!callResult.ok) {
      if (callResult.status === 429) {
        finalReply =
          "The AI service is currently rate-limited. Please wait a moment and try again.";
      } else if (callResult.status === 529 || callResult.status === 503) {
        finalReply =
          "The AI service is temporarily overloaded. Please try again in a few seconds.";
      } else {
        finalReply =
          "I'm having trouble connecting to the AI service right now. Please try again in a moment.";
      }
      break;
    }

    const data = callResult.data;
    if (!data?.content || !Array.isArray(data.content)) {
      finalReply = "I received an unexpected response format. Please try again.";
      break;
    }

    if (data.usage) {
      totalInputTokens += data.usage.input_tokens || 0;
      totalOutputTokens += data.usage.output_tokens || 0;
    }

    const textBlocks: string[] = [];
    const toolUseBlocks: any[] = [];
    for (const block of data.content) {
      if (block.type === "text") textBlocks.push(block.text);
      if (block.type === "tool_use") toolUseBlocks.push(block);
    }

    if (toolUseBlocks.length === 0) {
      finalReply = textBlocks.join("\n");
      break;
    }

    const ctx = {
      supabase: deps.supabase,
      caregivers: req.caregivers || [],
      clients: req.clients || [],
      currentUser: req.currentUser || "User",
      currentUserMailbox: req.currentUserMailbox || null,
    };
    const toolResultBlocks: any[] = [];
    for (const toolUse of toolUseBlocks) {
      const toolName = toolUse.name;
      const toolInput = toolUse.input;

      // Reject tool calls that aren't in the manifest allowlist. Defense in
      // depth: the tools array already excludes them, but a rogue Claude
      // response can still try.
      if (!isToolAllowed(manifest, toolName)) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            error: `Tool ${toolName} is not in this agent's allowlist.`,
          }),
        });
        continue;
      }

      if (req.confirmTools.has(toolName)) {
        // Phase 1.3 — `activeExecuteTool` reflects the latest wrapper
        // (live / shadow / read_only) chosen by the per-iteration
        // recheck above. Initial value mirrors `req.executeTool`.
        const result = await activeExecuteTool(toolName, toolInput, ctx);
        if (result?.requires_confirmation) {
          pendingConfirmation = result;
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              status: "pending_confirmation",
              summary: result.summary,
            }),
          });
        } else {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }
      } else if (req.autoExecuteTools.has(toolName)) {
        const result = await activeExecuteTool(toolName, toolInput, ctx);
        toolResults.push({ tool: toolName, input: toolInput, result });
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      } else {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            error: `Tool ${toolName} is not available.`,
          }),
        });
      }
    }

    currentMessages.push({ role: "assistant", content: data.content });
    currentMessages.push({ role: "user", content: toolResultBlocks });
  }

  if (iterations >= manifest.max_iterations && !finalReply && !pendingConfirmation) {
    exitedWithoutResponse = true;
  }

  // Phase 1.3 — surface a mid-flight kill flip as `killed_mid_flight`
  // so the orchestrator in `agentRuntime.ts` can normalize it to
  // the same `killed` status callers already understand.
  let status: HandlerResult["status"];
  if (killedMidFlight) {
    status = "killed_mid_flight";
  } else if (exitedWithoutResponse) {
    status = "iteration_limit";
  } else {
    status = "ok";
  }

  return {
    status,
    reply: killedMidFlight && !finalReply
      ? "Agent stopped mid-flight (kill switch flipped). No further action taken."
      : finalReply,
    pendingConfirmation,
    toolResults,
    cost: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      iterations,
      duration_ms: now() - startedAt,
    },
    contextHealth,
  };
}

/**
 * Phase 1.3 — pick the executeTool wrapper for the current iteration
 * based on the latest flag snapshot. Mirrors the wrappers in
 * `agentRuntime.ts:wrapChatRequestForShadow / ForReadOnly` but is
 * defined inline here to avoid a circular import (handlers.ts is
 * imported by agentRuntime.ts, not the other way round).
 *
 * Precedence: `read_only_mode > shadow_mode > live`. Read-only is
 * strictly more restrictive than shadow (suppresses auto-tier reads
 * too) so it wins when both are on.
 */
function chooseExecuteTool(
  req: ChatHandlerRequest,
  manifest: AgentManifest,
  flags: AgentRuntimeFlags,
): ChatHandlerRequest["executeTool"] {
  if (flags.read_only_mode) {
    return async (name: string, _input: any, _ctx: any) => ({
      status: "read_only",
      message:
        `Read-only mode: ${name} was suppressed. The agent must respond from prior context only.`,
      read_only: true,
      agent_id: manifest.id,
      agent_slug: manifest.slug,
    });
  }
  if (flags.shadow_mode) {
    const original = req.executeTool;
    return async (name: string, input: any, ctx: any) => {
      if (req.confirmTools.has(name)) {
        return {
          status: "shadow",
          message: `Shadow mode: ${name} would have been suggested for confirmation.`,
          shadow: true,
          agent_id: manifest.id,
          agent_slug: manifest.slug,
        };
      }
      return await original(name, input, ctx);
    };
  }
  return req.executeTool;
}

// ─── Planner handler ───

export interface PlannerHandlerRequest {
  /** "full_pipeline_daily" or "single_entity_event_triggered". */
  mode: "full_pipeline_daily" | "single_entity_event_triggered";
  systemPrompt: string;
  userPrompt: string;
  /** max_tokens forwarded to Anthropic (matches legacy 2048 default). */
  maxTokens?: number;
}

export async function runPlannerHandler(
  manifest: AgentManifest,
  deps: HandlerDeps,
  req: PlannerHandlerRequest,
): Promise<HandlerResult & { responseText?: string }> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const callImpl = deps.callAnthropicImpl ?? callAnthropic;

  const callResult = await callImpl({
    apiKey: deps.apiKey,
    body: {
      model: manifest.model,
      max_tokens: req.maxTokens ?? 2048,
      system: req.systemPrompt,
      messages: [{ role: "user", content: req.userPrompt }],
    },
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });

  if (!callResult.ok) {
    return {
      status: "error",
      error: {
        message: `Sonnet API error: HTTP ${callResult.status}`,
        code: "anthropic_error",
      },
      cost: { ...zeroCost(), iterations: 1, duration_ms: now() - startedAt },
    };
  }

  const data = callResult.data;
  const responseText = data?.content?.[0]?.text || "";
  const inputTokens = data?.usage?.input_tokens || 0;
  const outputTokens = data?.usage?.output_tokens || 0;

  return {
    status: "ok",
    reply: responseText,
    responseText,
    cost: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      iterations: 1,
      duration_ms: now() - startedAt,
    },
  };
}

// ─── Router (inbound classifier) handler ───
//
// The router's job in the legacy flow is exactly: run Haiku once, parse the
// JSON result, validate against `VALID_INTENTS` / `VALID_ACTIONS`. The shell
// keeps queue management, suggestion creation, and auto-execute around it.

export interface RouterHandlerRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Legacy default = 400 tokens. */
  maxTokens?: number;
  /** List of allowed intents. Defaults to today's `VALID_INTENTS`. */
  validIntents?: string[];
  /** List of allowed actions. Defaults to today's `VALID_ACTIONS`. */
  validActions?: string[];
}

export interface RouterClassification {
  intent: string;
  confidence: number;
  suggested_action: string;
  suggested_params: Record<string, any>;
  drafted_response: string;
  reasoning: string;
}

export const ROUTER_DEFAULT_INTENTS = [
  "question",
  "document_submission",
  "scheduling_request",
  "general_response",
  "confirmation",
  "opt_out",
  "unknown",
];

export const ROUTER_DEFAULT_ACTIONS = [
  "send_sms",
  "send_email",
  "add_note",
  "add_client_note",
  "update_phase",
  "update_client_phase",
  "complete_task",
  "complete_client_task",
  "update_caregiver_field",
  "update_client_field",
  "update_board_status",
  "create_calendar_event",
  "send_docusign_envelope",
  "send_esign_envelope",
  "none",
];

export async function runRouterHandler(
  manifest: AgentManifest,
  deps: HandlerDeps,
  req: RouterHandlerRequest,
): Promise<HandlerResult & { classification?: RouterClassification | null }> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const callImpl = deps.callAnthropicImpl ?? callAnthropic;

  const callResult = await callImpl({
    apiKey: deps.apiKey,
    body: {
      model: manifest.model,
      max_tokens: req.maxTokens ?? 400,
      system: req.systemPrompt,
      messages: [{ role: "user", content: req.userPrompt }],
    },
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });

  if (!callResult.ok) {
    return {
      status: "error",
      error: {
        message: `Classifier API error: HTTP ${callResult.status}`,
        code: "anthropic_error",
      },
      classification: null,
      cost: { ...zeroCost(), iterations: 1, duration_ms: now() - startedAt },
    };
  }

  const data = callResult.data;
  const text = data?.content?.[0]?.text || "";
  const inputTokens = data?.usage?.input_tokens || 0;
  const outputTokens = data?.usage?.output_tokens || 0;

  const validIntents = req.validIntents ?? ROUTER_DEFAULT_INTENTS;
  const validActions = req.validActions ?? ROUTER_DEFAULT_ACTIONS;

  // Permissive JSON extract — same heuristic the legacy classifier uses.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      status: "error",
      error: { message: "Classifier returned non-JSON.", code: "parse_error" },
      classification: null,
      cost: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        iterations: 1,
        duration_ms: now() - startedAt,
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      status: "error",
      error: {
        message: `Classifier JSON parse failed: ${(err as Error).message}`,
        code: "parse_error",
      },
      classification: null,
      cost: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        iterations: 1,
        duration_ms: now() - startedAt,
      },
    };
  }

  const classification: RouterClassification = {
    intent: validIntents.includes(parsed.intent) ? parsed.intent : "unknown",
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    suggested_action: validActions.includes(parsed.suggested_action)
      ? parsed.suggested_action
      : "none",
    suggested_params:
      parsed.suggested_params && typeof parsed.suggested_params === "object"
        ? parsed.suggested_params
        : {},
    drafted_response: String(parsed.drafted_response || ""),
    reasoning: String(parsed.reasoning || ""),
  };

  return {
    status: "ok",
    reply: text,
    classification,
    cost: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      iterations: 1,
      duration_ms: now() - startedAt,
    },
  };
}

// ─── Helpers exported for tests ───

export const __testables = {
  zeroCost,
  CHAT_DEFAULT_MAX_TOKENS,
  levelForAction,
};
