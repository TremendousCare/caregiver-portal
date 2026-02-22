import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Side-effect imports: each module registers its tools with the registry
import "./tools/caregiver-read.ts";
import "./tools/caregiver-write.ts";
import "./tools/communication.ts";
import "./tools/email.ts";
import "./tools/calendar.ts";
import "./tools/docusign.ts";
import "./tools/client.ts";
import "./tools/awareness.ts";

import {
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  corsHeaders,
  CLAUDE_MODEL,
  MAX_TOKENS,
  MAX_ITERATIONS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
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
import { logAction, detectOutcome } from "./context/outcomes.ts";
import { generateBriefing } from "./context/briefing.ts";

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

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

    const { messages, caregiverId, confirmAction, currentUser, requestType } =
      await req.json();
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

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

      return new Response(JSON.stringify({ briefing }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      );

      // Log confirmed action as event (fire-and-forget)
      if (result.success) {
        const eventType = toolNameToEventType(confirmAction.action);
        if (eventType) {
          const entityType = confirmAction.caregiver_id ? "caregiver" : confirmAction.client_id ? "client" : null;
          const entityId = confirmAction.caregiver_id || confirmAction.client_id || null;

          logEvent(
            supabase,
            eventType,
            entityType,
            entityId,
            `user:${currentUser || "User"}`,
            { action: confirmAction.action, confirmed: true, ...confirmAction.params },
          );

          // Phase 2: Log confirmed action for outcome tracking
          if (entityType && entityId) {
            logAction(
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

      return new Response(
        JSON.stringify({
          reply: result.success
            ? result.message
            : `Error: ${result.error}`,
          actionResult: result,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
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

    // Fetch all clients
    const { data: allClients, error: clErr } = await supabase
      .from("clients")
      .select("*")
      .order("created_at", { ascending: false });
    if (clErr) console.error(`Clients fetch error: ${clErr.message}`);
    const clients = allClients || [];

    // Build context-aware system prompt (context assembler with memory + situational awareness)
    let systemPrompt: string;
    try {
      systemPrompt = await assembleSystemPrompt({
        supabase,
        caregivers,
        clients,
        caregiverId,
        currentUser: currentUser || "User",
      });
    } catch (assemblerErr) {
      console.warn("[ai-chat] Context assembler failed, falling back to static prompt:", assemblerErr);
      systemPrompt = buildSystemPrompt(caregivers, caregiverId, clients);
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
        const ctx = { supabase, caregivers, clients, currentUser: currentUser || "User" };

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

    // ── Post-conversation: log events for tool actions & save session context ──
    // Fire-and-forget — don't block the response
    (async () => {
      try {
        // Log events for each tool that executed
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

              // Phase 2: Try real-time outcome detection
              // If this event could be an outcome of a prior action, link them
              if (entityType && entityId) {
                await detectOutcome(
                  supabase,
                  eventType,
                  entityType as "caregiver" | "client",
                  entityId,
                  { ...tr.input, ...(tr.result || {}) },
                );
              }
            }
          }
        }

        // Phase 2: Log side-effect actions for outcome tracking
        for (const tr of toolResults) {
          if (tr.result?.success) {
            const eventType = toolNameToEventType(tr.tool);
            if (eventType) {
              const entityType = tr.result?.caregiver_id ? "caregiver" : tr.result?.client_id ? "client" : null;
              const entityId = tr.result?.caregiver_id || tr.result?.client_id || null;
              if (entityType && entityId) {
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
                  },
                  "ai_chat",
                );
              }
            }
          }
        }
        // TODO: Add real-time inbound SMS outcome detection when execute-automation
        // is brought into git. For now, the outcome-analyzer cron handles this.

        // Save context snapshot for session continuity
        if (finalReply && currentMessages.length > 2) {
          const topics = extractTopics(currentMessages);
          await saveContextSnapshot(
            supabase,
            currentUser || "User",
            finalReply.length > 300 ? finalReply.slice(0, 300) + "..." : finalReply,
            topics,
          );
        }
      } catch (bgErr) {
        console.error("[ai-chat] Post-conversation background tasks failed:", bgErr);
      }
    })();

    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("ai-chat error:", err);
    return new Response(
      JSON.stringify({
        error: (err as Error).message || "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

// ─── Helpers for post-conversation processing ───

function toolNameToEventType(toolName: string): string | null {
  const map: Record<string, string> = {
    add_note: "note_added",
    update_phase: "phase_changed",
    complete_task: "task_completed",
    update_caregiver_field: "caregiver_updated",
    update_board_status: "board_status_changed",
    send_sms: "sms_sent",
    send_email: "email_sent",
    send_docusign_envelope: "docusign_sent",
    create_calendar_event: "calendar_event_created",
    update_calendar_event: "calendar_event_updated",
    add_client_note: "note_added",
    update_client_phase: "phase_changed",
    complete_client_task: "task_completed",
    update_client_field: "client_updated",
  };
  return map[toolName] || null;
}

function extractTopics(
  messages: any[],
): Array<{ topic: string; status?: string }> {
  // Extract topics from user messages in the conversation
  const topics: Array<{ topic: string; status?: string }> = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const content = msg.content;
    // Simple topic extraction: take the first meaningful sentence
    const topic = content.length > 80 ? content.slice(0, 80) + "..." : content;
    if (!seen.has(topic)) {
      seen.add(topic);
      topics.push({ topic, status: "discussed" });
    }
  }

  return topics.slice(-5); // Keep last 5 topics
}
