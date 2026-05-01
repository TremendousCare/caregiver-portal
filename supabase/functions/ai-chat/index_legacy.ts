// ─── ai-chat legacy handler (Phase 0.4 rollback sibling) ───
//
// This file contains the *verbatim* pre-0.4 ai-chat implementation, lifted
// out of the original `index.ts` into an exported `legacyHandler(req)`. The
// new dispatcher in `index.ts` calls this when the
// `app_settings.agent_runtime_cutover.ai_chat` flag is false (default).
// Remove this file in the post-bake cleanup PR after the runtime path has
// been live ≥ 7 days clean.
//
// IMPORTANT: do not refactor this file. Drift between this and `shell.ts`
// would defeat the parity contract that lets us flip the flag back without
// surprises. The byte-equal Layer B parity tests for the runtime cover
// `runAgent`; the shell's pre/post-runtime logic is covered by the new
// `aiChatShell.test.js`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Side-effect imports: each module registers its tools with the registry
import "./tools/caregiver-read.ts";
import "./tools/caregiver-write.ts";
import "./tools/communication.ts";
import "./tools/email.ts";
import "./tools/calendar.ts";
import "./tools/docusign.ts";
import "./tools/esign.ts";
import "./tools/client.ts";
import "./tools/awareness.ts";

import {
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  getCorsHeaders,
  CLAUDE_MODEL,
  MAX_TOKENS,
  MAX_ITERATIONS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "./config.ts";

import {
  getToolDefinitions,
  getAutoExecuteSet,
  getConfirmSet,
  executeTool,
  executeConfirmedAction,
} from "./registry.ts";

import { buildSystemPrompt } from "./prompt.ts";
import { assembleSystemPrompt } from "./context/assembler.ts";
import { logEvent, saveContextSnapshot } from "./context/events.ts";
import { logAction } from "./context/outcomes.ts";
import { generateBriefing } from "./context/briefing.ts";
import { runConsolidation } from "./context/consolidation.ts";
import { logMetric, startTimer } from "../_shared/operations/metrics.ts";
import {
  toolNameToEventType,
  extractTopics,
} from "./helpers/postConversation.ts";

// ─── Retry helper for transient Claude API errors ───
const RETRYABLE_STATUSES = new Set([429, 500, 503, 529]);

async function callClaudeWithRetry(requestBody: string): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[ai-chat] Retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
    lastResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: requestBody,
    });
    if (lastResponse.ok || !RETRYABLE_STATUSES.has(lastResponse.status)) {
      return lastResponse;
    }
    console.warn(`[ai-chat] Transient error HTTP ${lastResponse.status}, will retry`);
  }
  return lastResponse!;
}

// ─── Legacy Handler (was `Deno.serve` body in pre-0.4 index.ts) ───

export async function legacyHandler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

    // ── JWT Authentication ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    const token = authHeader.replace("Bearer ", "");

    // Create a user-context client to verify the JWT
    const supabaseAuth = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    const authenticatedUserId = user.id;

    const { messages, caregiverId, confirmAction, currentUser, currentUserMailbox, requestType } =
      await req.json();

    // Service-role client for data operations
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const doneInvocation = startTimer(supabase, "ai-chat", "invocation");

    // ── Rate Limiting (fails open) ──
    try {
      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
      const { count, error: rlError } = await supabase
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "ai_chat_request")
        .eq("actor", `user:${authenticatedUserId}`)
        .gte("created_at", windowStart);

      if (!rlError && count !== null && count >= RATE_LIMIT_MAX_REQUESTS) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } },
        );
      }
    } catch (rlErr) {
      // Fail open — don't block users if rate limit check errors
      console.warn("[ai-chat] Rate limit check failed (failing open):", rlErr);
    }

    // Log this request as an event for rate limiting tracking
    logEvent(
      supabase,
      "ai_chat_request",
      null,
      null,
      `user:${authenticatedUserId}`,
      { currentUser: currentUser || "User", requestType: requestType || "chat" },
    ).catch((err: unknown) => console.warn("[ai-chat] Failed to log request event:", err));

    // ── Handle briefing request (fast, no Claude call) ──
    if (requestType === "briefing") {
      const { data: allCg } = await supabase
        .from("caregivers")
        .select("id, first_name, last_name, phone, notes, created_at, archived, phase_override, phase_timestamps, tasks")
        .order("created_at", { ascending: false });
      const { data: allCl } = await supabase
        .from("clients")
        .select("id, first_name, last_name, phone, notes, created_at, archived, phase, phase_timestamps, tasks")
        .order("created_at", { ascending: false });

      const briefing = await generateBriefing(
        supabase,
        currentUser || "User",
        allCg || [],
        allCl || [],
      );

      doneInvocation(true, { request_type: "briefing" });
      return new Response(JSON.stringify({ briefing }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Handle confirmed action ──
    if (confirmAction) {
      const result = await executeConfirmedAction(
        confirmAction.action,
        confirmAction.caregiver_id || confirmAction.client_id,
        confirmAction.params,
        supabase,
        currentUser || "User",
        currentUserMailbox || null,
      );

      // Log confirmed action as event (awaited to ensure completion before response)
      if (result.success) {
        const eventType = toolNameToEventType(confirmAction.action);
        if (eventType) {
          const entityType = confirmAction.caregiver_id ? "caregiver" : confirmAction.client_id ? "client" : null;
          const entityId = confirmAction.caregiver_id || confirmAction.client_id || null;

          await logEvent(
            supabase,
            eventType,
            entityType,
            entityId,
            `user:${currentUser || "User"}`,
            { action: confirmAction.action, confirmed: true, ...confirmAction.params },
          );

          // Phase 2: Log confirmed action for outcome tracking
          if (entityType && entityId) {
            await logAction(
              supabase,
              eventType,
              entityType as "caregiver" | "client",
              entityId,
              `user:${currentUser || "User"}`,
              { action: confirmAction.action, confirmed: true, ...confirmAction.params },
              "ai_chat",
            );
          }
        }
      }

      doneInvocation(true, { request_type: "confirmed_action", action: confirmAction.action });
      return new Response(
        JSON.stringify({
          reply: result.success
            ? result.message
            : `Error: ${result.error}`,
          actionResult: result,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    // ── Handle chat messages ──
    if (!messages || !Array.isArray(messages)) {
      throw new Error("messages array is required");
    }

    // Fetch all caregivers (select only needed columns to avoid payload bloat)
    const { data: allCaregivers, error: cgErr } = await supabase
      .from("caregivers")
      .select("id, first_name, last_name, phone, email, address, city, state, zip, phase_override, phase_timestamps, tasks, notes, created_at, archived, archive_reason, archive_phase, archive_detail, board_status, board_note, board_moved_at, source, source_detail, has_hca, has_dl, hca_expiration, per_id, years_experience, languages, specializations, certifications, preferred_shift, availability, application_date")
      .order("created_at", { ascending: false });
    if (cgErr) throw new Error(`DB error: ${cgErr.message}`);
    const caregivers = allCaregivers || [];

    // Fetch all clients (select only needed columns to avoid payload bloat)
    const { data: allClients, error: clErr } = await supabase
      .from("clients")
      .select("id, first_name, last_name, phone, email, address, city, state, zip, phase, phase_timestamps, tasks, notes, created_at, archived, priority, care_needs, care_recipient_name, contact_name, hours_needed, budget_range, start_date_preference, insurance_info, referral_source, referral_detail, assigned_to, lost_reason, lost_detail, relationship, care_recipient_age")
      .order("created_at", { ascending: false });
    if (clErr) console.error(`Clients fetch error: ${clErr.message}`);
    const clients = allClients || [];

    // Build context-aware system prompt (context assembler with memory + situational awareness)
    let systemPrompt: string;
    let contextHealth: any = null;
    try {
      // Extract latest user message for memory relevance filtering
      const latestUserMsg = messages
        .slice()
        .reverse()
        .find((m: any) => m.role === "user" && typeof m.content === "string");

      const assemblerResult = await assembleSystemPrompt({
        supabase,
        caregivers,
        clients,
        caregiverId,
        currentUser: currentUser || "User",
        userQuery: latestUserMsg?.content,
      });
      systemPrompt = assemblerResult.prompt;
      contextHealth = assemblerResult.health;
    } catch (assemblerErr) {
      console.warn("[ai-chat] Context assembler failed, falling back to static prompt:", assemblerErr);
      systemPrompt = buildSystemPrompt(caregivers, caregiverId, clients);
      contextHealth = { status: "minimal", layersLoaded: ["identity", "guidelines"], layersFailed: ["assembler"], layersTrimmed: [], tokenEstimate: 0 };
    }

    // Get tool definitions from registry
    const TOOLS = getToolDefinitions();
    const AUTO_EXECUTE_TOOLS = getAutoExecuteSet();
    const CONFIRM_TOOLS = getConfirmSet();

    const apiMessages = messages
      .slice(-20)
      .map((m: any) => ({ role: m.role, content: m.content }));

    let finalReply = "";
    let pendingConfirmation: any = null;
    const toolResults: any[] = [];
    let currentMessages = [...apiMessages];
    let iterations = 0;
    const sessionStart = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // ── Agentic loop ──
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      try {
        const requestBody = JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: currentMessages,
          tools: TOOLS,
        });
        console.log(`[ai-chat] Iteration ${iterations}: payload ${requestBody.length} chars, ${currentMessages.length} messages, ${TOOLS.length} tools`);

        const response = await callClaudeWithRetry(requestBody);

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[ai-chat] Claude API error on iteration ${iterations}: HTTP ${response.status} — ${errText.slice(0, 500)}`);
          if (response.status === 429) {
            finalReply = "The AI service is currently rate-limited. Please wait a moment and try again.";
          } else if (response.status === 529 || response.status === 503) {
            finalReply = "The AI service is temporarily overloaded. Please try again in a few seconds.";
          } else {
            finalReply = "I'm having trouble connecting to the AI service right now. Please try again in a moment.";
          }
          break;
        }

        let data: any;
        try {
          data = await response.json();
        } catch (parseErr) {
          console.error("Failed to parse Claude API response:", parseErr);
          finalReply = "I received an unexpected response. Please try again.";
          break;
        }

        if (!data.content || !Array.isArray(data.content)) {
          console.error("Claude API returned unexpected content structure:", JSON.stringify(data).slice(0, 500));
          finalReply = "I received an unexpected response format. Please try again.";
          break;
        }

        // Track token usage for cost-per-outcome
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

        // No tool calls — return text response
        if (toolUseBlocks.length === 0) {
          finalReply = textBlocks.join("\n");
          break;
        }

        // Process tool calls
        const toolResultBlocks: any[] = [];
        const ctx = { supabase, caregivers, clients, currentUser: currentUser || "User", currentUserMailbox: currentUserMailbox || null };

        for (const toolUse of toolUseBlocks) {
          const toolName = toolUse.name;
          const toolInput = toolUse.input;

          if (CONFIRM_TOOLS.has(toolName)) {
            const result = await executeTool(toolName, toolInput, ctx);
            if (result.requires_confirmation) {
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
          } else if (AUTO_EXECUTE_TOOLS.has(toolName)) {
            const result = await executeTool(toolName, toolInput, ctx);
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

      } catch (loopErr) {
        console.error(`Agentic loop iteration ${iterations} failed:`, loopErr);
        finalReply = "Something went wrong while processing your request. Please try again.";
        break;
      }
    }

    const responseBody: any = {
      reply: finalReply || "I couldn't generate a response. Please try again.",
    };
    if (pendingConfirmation) {
      responseBody.pendingConfirmation = pendingConfirmation;
    }
    if (contextHealth) {
      responseBody._contextHealth = contextHealth;
    }

    // ── Post-conversation: log events for tool actions & save session context ──
    // Awaited before returning response to ensure completion in Edge runtime
    try {
      // Log events and actions for each tool that executed
      for (const tr of toolResults) {
        if (tr.result?.success) {
          const eventType = toolNameToEventType(tr.tool);
          if (eventType) {
            const entityType = tr.result?.caregiver_id ? "caregiver" : tr.result?.client_id ? "client" : null;
            const entityId = tr.result?.caregiver_id || tr.result?.client_id || null;

            await logEvent(
              supabase,
              eventType,
              entityType,
              entityId,
              `user:${currentUser || "User"}`,
              {
                tool: tr.tool,
                entity_name: tr.result?.entity_name || null,
                ...tr.input,
              },
            );

            // Phase 2: Log side-effect actions for outcome tracking (with cost data)
            if (entityType && entityId) {
              const sessionDurationMs = Date.now() - sessionStart;
              await logAction(
                supabase,
                eventType,
                entityType as "caregiver" | "client",
                entityId,
                `user:${currentUser || "User"}`,
                {
                  tool: tr.tool,
                  entity_name: tr.result?.entity_name || null,
                  ...tr.input,
                  ...(tr.result?.params || {}),
                  _cost: {
                    input_tokens: totalInputTokens,
                    output_tokens: totalOutputTokens,
                    iterations,
                    session_duration_ms: sessionDurationMs,
                  },
                },
                "ai_chat",
              );
            }
          }
        }
      }

      // Save context snapshot for session continuity
      if (finalReply && currentMessages.length > 2) {
        const topics = extractTopics(currentMessages, caregivers, clients);
        await saveContextSnapshot(
          supabase,
          currentUser || "User",
          finalReply.length > 300 ? finalReply.slice(0, 300) + "..." : finalReply,
          topics,
        );
      }

      // Run memory consolidation pipeline (fire-and-forget, never blocks response)
      runConsolidation(supabase).catch((err: unknown) =>
        console.error("[ai-chat] Consolidation failed:", err),
      );
    } catch (bgErr) {
      console.error("[ai-chat] Post-conversation tasks failed:", bgErr);
    }

    doneInvocation(true, {
      request_type: "chat",
      iterations,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      tools_used: toolResults.length,
    });

    return new Response(JSON.stringify(responseBody), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("ai-chat error:", err);
    // Log error metric (best-effort — supabase client may not exist if error was early)
    try {
      const errSupabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
      logMetric(errSupabase, "ai-chat", "error", undefined, false, {
        error: (err as Error).message,
      });
    } catch (_) { /* swallow */ }
    // Don't leak internal error details to the client
    const safeMessage = (err as Error).message?.includes("required")
      ? (err as Error).message  // Validation errors are safe to show
      : "Something went wrong. Please try again.";
    return new Response(
      JSON.stringify({ error: safeMessage }),
      {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }
}

// ─── Helpers for post-conversation processing ───
// Phase 0.4: extracted to ./helpers/postConversation.ts so the new
// `shell.ts` can share them. The legacy handler uses the imported
// symbols above; this file no longer defines them.
