// ─── ai-chat Phase 0.4 cutover shell ───
//
// When `app_settings.agent_runtime_cutover.ai_chat = true` the dispatcher
// in `index.ts` calls `runAiChatShell()` instead of `legacyHandler`. This
// module preserves every concern that lived in the legacy file (JWT auth,
// rate limiting, briefing path, confirmedAction path, post-conversation
// observability) but routes the agentic chat path through `runAgent()` —
// the Phase 0.3 manifest-driven runtime.
//
// Design constraints:
//   * Neutral imports only (no `Deno.serve`, no `jsr:`). All Deno-side
//     plumbing (`createClient`, env reads) is injected via `ShellDeps`,
//     making this file directly importable from Vitest in Node.
//   * Every events / action_outcomes write that the runtime path triggers
//     stamps `agent_id = recruiting.id`. (Legacy path keeps writing NULL
//     to preserve byte-equal rollback.) Suggestion writes the runtime
//     itself does not perform — they happen via `executeConfirmedAction`,
//     which runs through the existing tool registry (registry.ts hands
//     out the writes; the inserts inside operations like sendSMS / sendEmail
//     don't touch the four AI-tier tables).
//   * The chat handler in `_shared/operations/agentRuntime/handlers.ts`
//     accepts `assembleSystemPrompt` as an injected callback, so the shell
//     wraps the existing assembler with a 1:1 thunk. Layer B parity locks
//     the byte-equal contract on the request body sent to Anthropic.
//
// Test surface: `src/lib/__tests__/aiChatShell.test.js`.

import {
  runAgent,
  type AgentResult,
} from "../_shared/operations/agentRuntime.ts";
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
  CLAUDE_MODEL,
  MAX_TOKENS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "./config.ts";
import {
  toolNameToEventType,
  extractTopics,
} from "./helpers/postConversation.ts";

// ─── Constants & types ───

/** Slug of the agent this shell delegates to. Stable contract with the manifest. */
export const RECRUITING_AGENT_SLUG = "recruiting";

export interface ShellDeps {
  /** Service-role supabase client (Deno wrapper supplies; tests inject mock). */
  supabase: any;
  /** User-context supabase client used to call auth.getUser() for JWT verify. */
  supabaseAuth: any;
  /** ANTHROPIC_API_KEY pulled from the env by the wrapper. */
  apiKey: string | undefined;
  /** Optional CORS headers calculator (Deno wrapper supplies; tests pass {}). */
  corsHeaders: Record<string, string>;
  /** Override fetch for runtime tests. Defaults to globalThis.fetch via runAgent. */
  fetchImpl?: typeof fetch;
}

export interface ShellRequestBody {
  messages?: any[];
  caregiverId?: string;
  confirmAction?: any;
  currentUser?: string;
  currentUserMailbox?: string | null;
  requestType?: string;
}

export interface JwtAuthContext {
  userId: string;
  orgId: string;
}

// ─── Public entry point ───

/**
 * Top-level shell entry. Mirrors `legacyHandler(req)` but every path that
 * touches the Claude agent loop dispatches into `runAgent()` and stamps
 * agent_id on every observability write.
 */
export async function runAiChatShell(
  req: Request,
  deps: ShellDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: deps.corsHeaders });
  }

  try {
    if (!deps.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

    // ── JWT Authentication (matches legacy path verbatim) ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse(deps.corsHeaders, 401, {
        error: "Missing or invalid Authorization header",
      });
    }
    const token = authHeader.replace("Bearer ", "");

    const { data: { user }, error: authError } = await deps.supabaseAuth.auth.getUser();
    if (authError || !user) {
      return jsonResponse(deps.corsHeaders, 401, {
        error: "Invalid or expired session",
      });
    }

    // ── Resolve org_id from JWT claim. Strict by design: missing claim →
    //    403 with the same error wording payroll-export-run uses. ──
    const orgId = decodeOrgIdFromJwt(token);
    if (!orgId) {
      return jsonResponse(deps.corsHeaders, 403, {
        error:
          "JWT is missing org_id claim. Confirm the SaaS-retrofit access token hook is enabled.",
      });
    }

    const authenticatedUserId = user.id;
    const auth: JwtAuthContext = { userId: authenticatedUserId, orgId };

    const body = (await req.json()) as ShellRequestBody;
    const {
      messages,
      caregiverId,
      confirmAction,
      currentUser,
      currentUserMailbox,
      requestType,
    } = body;

    const supabase = deps.supabase;
    const doneInvocation = startTimer(supabase, "ai-chat", "invocation");

    // We need the recruiting agent's id for stamping. The runtime loads it
    // from the manifest itself; we mirror that lookup once per invocation
    // for the writes that happen *outside* runAgent (briefing, confirmAction,
    // post-conversation logEvent/logAction). On lookup failure we fall back
    // to NULL stamping rather than 500-ing — safety over visibility.
    const agentId = await resolveAgentIdSafe(supabase, RECRUITING_AGENT_SLUG, orgId);

    // ── Rate Limiting (fails open, matches legacy) ──
    try {
      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
      const { count, error: rlError } = await supabase
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "ai_chat_request")
        .eq("actor", `user:${authenticatedUserId}`)
        .gte("created_at", windowStart);

      if (!rlError && count !== null && count >= RATE_LIMIT_MAX_REQUESTS) {
        return jsonResponse(deps.corsHeaders, 429, {
          error: "Rate limit exceeded. Please try again later.",
        });
      }
    } catch (rlErr) {
      console.warn("[ai-chat] Rate limit check failed (failing open):", rlErr);
    }

    // Log this request as an event for rate-limit tracking. Stamped with
    // agent_id = recruiting per the Phase 0.4 contract — these markers are
    // per-agent traffic and feed the metrics dashboard.
    logEvent(
      supabase,
      "ai_chat_request",
      null,
      null,
      `user:${authenticatedUserId}`,
      { currentUser: currentUser || "User", requestType: requestType || "chat" },
      agentId,
    ).catch((err: unknown) =>
      console.warn("[ai-chat] Failed to log request event:", err),
    );

    // ── Briefing path (unchanged from legacy; no Claude call) ──
    if (requestType === "briefing") {
      const { data: allCg } = await supabase
        .from("caregivers")
        .select(
          "id, first_name, last_name, phone, notes, created_at, archived, phase_override, phase_timestamps, tasks",
        )
        .order("created_at", { ascending: false });
      const { data: allCl } = await supabase
        .from("clients")
        .select(
          "id, first_name, last_name, phone, notes, created_at, archived, phase, phase_timestamps, tasks",
        )
        .order("created_at", { ascending: false });

      const briefing = await generateBriefing(
        supabase,
        currentUser || "User",
        allCg || [],
        allCl || [],
      );

      doneInvocation(true, { request_type: "briefing" });
      return jsonResponse(deps.corsHeaders, 200, { briefing });
    }

    // ── Confirmed action path (post-suggestion execution) ──
    // Same flow as legacy, but every event/action write carries agent_id.
    if (confirmAction) {
      const result = await executeConfirmedAction(
        confirmAction.action,
        confirmAction.caregiver_id || confirmAction.client_id,
        confirmAction.params,
        supabase,
        currentUser || "User",
        currentUserMailbox || null,
      );

      if (result.success) {
        const eventType = toolNameToEventType(confirmAction.action);
        if (eventType) {
          const entityType = confirmAction.caregiver_id
            ? "caregiver"
            : confirmAction.client_id
              ? "client"
              : null;
          const entityId =
            confirmAction.caregiver_id || confirmAction.client_id || null;

          await logEvent(
            supabase,
            eventType,
            entityType,
            entityId,
            `user:${currentUser || "User"}`,
            { action: confirmAction.action, confirmed: true, ...confirmAction.params },
            agentId,
          );

          if (entityType && entityId) {
            await logAction(
              supabase,
              eventType,
              entityType as "caregiver" | "client",
              entityId,
              `user:${currentUser || "User"}`,
              { action: confirmAction.action, confirmed: true, ...confirmAction.params },
              "ai_chat",
              agentId,
            );
          }
        }
      }

      doneInvocation(true, {
        request_type: "confirmed_action",
        action: confirmAction.action,
      });
      return jsonResponse(deps.corsHeaders, 200, {
        reply: result.success ? result.message : `Error: ${result.error}`,
        actionResult: result,
      });
    }

    // ── Chat path — dispatch into runAgent ──
    if (!messages || !Array.isArray(messages)) {
      throw new Error("messages array is required");
    }

    const { data: allCaregivers, error: cgErr } = await supabase
      .from("caregivers")
      .select(
        "id, first_name, last_name, phone, email, address, city, state, zip, phase_override, phase_timestamps, tasks, notes, created_at, archived, archive_reason, archive_phase, archive_detail, board_status, board_note, board_moved_at, source, source_detail, has_hca, has_dl, hca_expiration, per_id, years_experience, languages, specializations, certifications, preferred_shift, availability, application_date",
      )
      .order("created_at", { ascending: false });
    if (cgErr) throw new Error(`DB error: ${cgErr.message}`);
    const caregivers = allCaregivers || [];

    const { data: allClients, error: clErr } = await supabase
      .from("clients")
      .select(
        "id, first_name, last_name, phone, email, address, city, state, zip, phase, phase_timestamps, tasks, notes, created_at, archived, priority, care_needs, care_recipient_name, contact_name, hours_needed, budget_range, start_date_preference, insurance_info, referral_source, referral_detail, assigned_to, lost_reason, lost_detail, relationship, care_recipient_age",
      )
      .order("created_at", { ascending: false });
    if (clErr) console.error(`Clients fetch error: ${clErr.message}`);
    const clients = allClients || [];

    const sessionStart = Date.now();

    // Build the ChatHandlerRequest for runAgent. The chat handler accepts
    // an injected `assembleSystemPrompt` so the shell hands over the same
    // assembler the legacy path uses — keeping prompt content identical.
    const chatRequest = {
      messages,
      caregiverId,
      currentUser: currentUser || "User",
      currentUserMailbox: currentUserMailbox || null,
      caregivers,
      clients,
      toolDefinitions: getToolDefinitions(),
      autoExecuteTools: getAutoExecuteSet(),
      confirmTools: getConfirmSet(),
      executeTool: (name: string, input: any, ctx: any) =>
        executeTool(name, input, ctx),
      assembleSystemPrompt: async (ctx: any) => {
        // The runtime layer hint is informational today (the assembler
        // doesn't honor `enabledLayers` yet — that ships when context_recipe
        // becomes authoritative). We pass it through so the field is in
        // place for the future without changing assembler behaviour now.
        const result = await assembleSystemPrompt({
          supabase: ctx.supabase,
          caregivers: ctx.caregivers,
          clients: ctx.clients,
          caregiverId: ctx.caregiverId,
          currentUser: ctx.currentUser,
          userQuery: ctx.userQuery,
        });
        return { prompt: result.prompt, health: result.health };
      },
      buildFallbackPrompt: (
        cgs: any[],
        cgId: string | undefined,
        cls: any[],
      ) => buildSystemPrompt(cgs, cgId, cls),
      modelOverride: undefined, // let manifest dictate; legacy used CLAUDE_MODEL constant
      maxTokens: MAX_TOKENS,
    };

    const result: AgentResult = await runAgent(
      supabase,
      RECRUITING_AGENT_SLUG,
      { shape: "chat", chat: chatRequest },
      {
        orgId,
        apiKey: deps.apiKey,
        fetchImpl: deps.fetchImpl,
      },
    );

    // ── Translate AgentResult → legacy response shape ──
    if (result.status === "error") {
      console.error("[ai-chat shell] runAgent error:", result.error);
      doneInvocation(false, { error: result.error?.message });
      return jsonResponse(deps.corsHeaders, 500, {
        error: "Something went wrong. Please try again.",
      });
    }

    const finalReply =
      result.reply ||
      (result.status === "killed"
        ? "Agent is currently dormant (kill switch engaged). No action taken."
        : "I couldn't generate a response. Please try again.");

    const responseBody: any = { reply: finalReply };
    if (result.pendingConfirmation) {
      responseBody.pendingConfirmation = result.pendingConfirmation;
    }
    if (result.contextHealth) {
      responseBody._contextHealth = result.contextHealth;
    }
    if (result.shadow) {
      responseBody._shadow = true;
    }

    // ── Post-conversation: log events for tool actions & save snapshot ──
    // Mirrors legacy behaviour 1:1, but every write stamps agent_id.
    try {
      for (const tr of result.toolResults || []) {
        if (tr.result?.success) {
          const eventType = toolNameToEventType(tr.tool);
          if (eventType) {
            const entityType = tr.result?.caregiver_id
              ? "caregiver"
              : tr.result?.client_id
                ? "client"
                : null;
            const entityId =
              tr.result?.caregiver_id || tr.result?.client_id || null;

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
              agentId,
            );

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
                    input_tokens: result.cost.input_tokens,
                    output_tokens: result.cost.output_tokens,
                    iterations: result.cost.iterations,
                    session_duration_ms: sessionDurationMs,
                  },
                },
                "ai_chat",
                agentId,
              );
            }
          }
        }
      }

      // Session continuity snapshot. The runtime returns the user-visible
      // reply only, not the full message stack — we still extract topics
      // from the original messages array which is identical to legacy.
      if (finalReply && Array.isArray(messages) && messages.length > 1) {
        const topics = extractTopics(messages, caregivers, clients);
        await saveContextSnapshot(
          supabase,
          currentUser || "User",
          finalReply.length > 300 ? finalReply.slice(0, 300) + "..." : finalReply,
          topics,
        );
      }

      runConsolidation(supabase).catch((err: unknown) =>
        console.error("[ai-chat] Consolidation failed:", err),
      );
    } catch (bgErr) {
      console.error("[ai-chat shell] Post-conversation tasks failed:", bgErr);
    }

    doneInvocation(true, {
      request_type: "chat",
      iterations: result.cost.iterations,
      input_tokens: result.cost.input_tokens,
      output_tokens: result.cost.output_tokens,
      tools_used: (result.toolResults || []).length,
      shadow: result.shadow,
      runtime: true,
    });

    return jsonResponse(deps.corsHeaders, 200, responseBody);
  } catch (err) {
    console.error("[ai-chat shell] error:", err);
    try {
      logMetric(deps.supabase, "ai-chat", "error", undefined, false, {
        error: (err as Error).message,
      });
    } catch (_) { /* swallow */ }
    const safeMessage = (err as Error).message?.includes("required")
      ? (err as Error).message
      : "Something went wrong. Please try again.";
    return jsonResponse(deps.corsHeaders, 500, { error: safeMessage });
  }
}

// ─── Helpers (exported for testing) ───

/**
 * Decode the `org_id` claim from a Supabase access token. Returns null on
 * any decode failure so the caller decides the response (we 403 in the
 * shell entry point — same posture as `payroll-export-run`).
 */
export function decodeOrgIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.org_id === "string" && payload.org_id.length > 0
      ? payload.org_id
      : null;
  } catch {
    return null;
  }
}

/**
 * Look up the agent row's id for stamping observability writes. The runtime
 * itself loads the full manifest separately; we just need the id here.
 * Returns null on any failure so writes degrade to legacy NULL stamping.
 */
export async function resolveAgentIdSafe(
  supabase: any,
  slug: string,
  orgId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("agents")
      .select("id")
      .eq("slug", slug)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error || !data) return null;
    return data.id || null;
  } catch {
    return null;
  }
}

function jsonResponse(
  cors: Record<string, string>,
  status: number,
  body: any,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Test hooks
export const __testables = {
  RECRUITING_AGENT_SLUG,
  jsonResponse,
};
