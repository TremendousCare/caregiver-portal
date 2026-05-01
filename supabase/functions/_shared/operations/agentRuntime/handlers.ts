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
  isToolAllowed,
  levelForAction,
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
  status: "ok" | "shadow" | "iteration_limit" | "error" | "skipped";
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
  if (req.assembleSystemPrompt) {
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

  while (iterations < manifest.max_iterations) {
    iterations++;

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
        const result = await req.executeTool(toolName, toolInput, ctx);
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
        const result = await req.executeTool(toolName, toolInput, ctx);
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

  return {
    status: exitedWithoutResponse ? "iteration_limit" : "ok",
    reply: finalReply,
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
