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
} from "./config.ts";

import {
  getToolDefinitions,
  getAutoExecuteSet,
  getConfirmSet,
  executeTool,
  executeConfirmedAction,
} from "./registry.ts";

import { buildSystemPrompt } from "./prompt.ts";

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

    const { messages, caregiverId, confirmAction, currentUser } =
      await req.json();
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // ── Handle confirmed action ──
    if (confirmAction) {
      const result = await executeConfirmedAction(
        confirmAction.action,
        confirmAction.caregiver_id || confirmAction.client_id,
        confirmAction.params,
        supabase,
        currentUser || "User",
      );
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

    // Build context-aware system prompt
    const systemPrompt = buildSystemPrompt(caregivers, caregiverId, clients);

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
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            messages: currentMessages,
            tools: TOOLS,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`Claude API error: ${response.status} ${errText}`);
          finalReply = "I'm having trouble connecting to the AI service right now. Please try again in a moment.";
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
