// ─── ai-chat shell ───
//
// Deno-free, testable handler for the ai-chat edge function. The
// `index.ts` Deno entry point creates the supabase clients (service-role
// + user-context for JWT verify) and resolves env vars, then calls
// `runAiChatShell(req, deps)`. Tests import directly from this file
// (no Deno.serve, no jsr: imports) and stub `./config.ts`.
//
// Behavioural contract (locked by `aiChatShell.test.js` and the Layer B
// parity fixtures from Phase 0.3):
//   * JWT auth via supabaseAuth.auth.getUser()
//   * Strict org_id claim required → 403 otherwise
//   * Rate limit 60/hour per user (counted off `events` table)
//   * Briefing, confirmAction, and chat paths each handled
//   * Every events/action_outcomes write stamps agent_id = recruiting.id
//   * Post-conversation: per-tool logEvent + logAction, session snapshot,
//     fire-and-forget memory consolidation
//
// Phase 0.4 closeout: the cutover flag and `index_legacy.ts` rollback
// sibling have been removed. This module is the single source of truth.

import {
  runAgent,
  type AgentResult,
} from "../_shared/operations/agentRuntime.ts";
import { recordAgentAction } from "../_shared/operations/agentActions.ts";
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
 * Top-level shell entry. Every path that touches the Claude agent loop
 * dispatches into `runAgent()` and stamps agent_id on every observability write.
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

    // ── JWT Authentication ──
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
    //
    // Phase 1.1.C also needs the agent's current version for the
    // agent_actions audit row (confirmAction path doesn't have a
    // runAgent result to read it from). One extra cheap SELECT here
    // beats a new helper file. Falls back to 0 ("unknown") if the
    // lookup fails — recordAgentAction tolerates 0 and the verifier
    // surfaces it in the report. Result.agent.version from runAgent
    // is preferred where available (chat path post-conversation loop).
    const agentId = await resolveAgentIdSafe(supabase, RECRUITING_AGENT_SLUG, orgId);
    let agentVersionFromDb = 0;
    if (agentId) {
      try {
        const { data } = await supabase
          .from("agents")
          .select("version")
          .eq("id", agentId)
          .maybeSingle();
        agentVersionFromDb = (data && typeof data.version === "number") ? data.version : 0;
      } catch (_) { /* fallback 0 */ }
    }

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

    // ── Briefing path (no Claude call) ──
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
    // Every event/action write carries agent_id.
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

          // Phase 1.1.C dual-write: confirmed user action ran. Phase
          // 'confirmed' (the human approved) is conceptually distinct
          // from 'executed' (the side-effect ran). Per locked spec we
          // emit 'executed' here because by the time we're past
          // executeConfirmedAction, the side-effect has already
          // happened. Phase 1.1.C-future could split into two rows
          // (suggested → confirmed → executed) but for 1.1.C the
          // 1-row-per-action shorthand matches existing events
          // semantics.
          if (agentId && orgId) {
            recordAgentAction(supabase, {
              orgId,
              agentId,
              agentVersion: agentVersionFromDb,
              actionType: eventType,
              phase: "executed",
              entityType: entityType as "caregiver" | "client" | null,
              entityId,
              actor: `user:${currentUser || "User"}`,
              payload: { action: confirmAction.action, confirmed: true, ...confirmAction.params },
              outcomeId: null,
            }).catch((err: unknown) =>
              console.error("[ai-chat audit confirmAction] record_agent_action failed:", err),
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
    // assembler the legacy path used — keeping prompt content identical.
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
      modelOverride: undefined, // let manifest dictate
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

    // ── Translate AgentResult → response shape ──
    if (result.status === "error") {
      console.error("[ai-chat] runAgent error:", result.error);
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
    // Every write stamps agent_id.
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

            // Phase 1.1.C dual-write: tamper-evident audit row. Fire-
            // and-forget — a failed audit must not roll back the
            // events/action_outcomes write (those have their own
            // value); the verifier (PR 1.1.B daily cron) reports
            // chain gaps in retrospect.
            //
            // Phase 1.4 — stamp the chat session's token cost + model +
            // latency into payload._cost so the per-agent metrics
            // dashboard can aggregate spend. The session cost is shared
            // across every tool-call row from the same invocation — the
            // dashboard de-dupes by chain_seq when summing.
            if (agentId && orgId) {
              const sessionDurationMs = Date.now() - sessionStart;
              recordAgentAction(supabase, {
                orgId,
                agentId,
                agentVersion: result.agent?.version ?? 0,
                actionType: eventType,
                phase: "executed",
                entityType: entityType as "caregiver" | "client" | null,
                entityId,
                actor: `user:${currentUser || "User"}`,
                payload: {
                  tool: tr.tool,
                  entity_name: tr.result?.entity_name || null,
                  ...tr.input,
                  _cost: {
                    input_tokens: result.cost.input_tokens,
                    output_tokens: result.cost.output_tokens,
                    duration_ms: sessionDurationMs,
                    model: result.agent?.model || null,
                  },
                },
                outcomeId: null,
              }).catch((err: unknown) =>
                console.error("[ai-chat audit] record_agent_action failed:", err),
              );
            }
          }
        }
      }

      // Session continuity snapshot. The runtime returns the user-visible
      // reply only, not the full message stack — we still extract topics
      // from the original messages array.
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
      console.error("[ai-chat] Post-conversation tasks failed:", bgErr);
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
    console.error("[ai-chat] error:", err);
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
 * Returns null on any failure so writes degrade to NULL stamping.
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
