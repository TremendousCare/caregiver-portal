// ─── ai-planner shell ───
//
// Deno-free, testable handler for the ai-planner edge function. The
// `index.ts` Deno entry point creates a service-role client and the env
// vars, then calls `runAiPlannerShell(req, deps)`. Tests import directly
// from this file (no Deno.serve, no jsr: imports).
//
// Behavioural contract (locked by `aiPlannerShell.test.js` and the Layer
// B parity fixtures from Phase 0.3):
//   * Honours `planner_enabled`
//   * Full-pipeline-mode idempotency via `app_settings.last_planner_run`
//   * Single-entity-mode 30-min dedup via `ai_suggestions`
//   * Builds the same systemPrompt + userPrompt as legacy
//   * Inserts `ai_suggestions` rows with `agent_id = proactive_planner.id`
//
// Phase 0.4 closeout: the cutover flag and `index_legacy.ts` rollback
// sibling have been removed. This module is the single source of truth.

import { runAgent } from "../_shared/operations/agentRuntime.ts";
import { recordAgentAction } from "../_shared/operations/agentActions.ts";
import {
  buildPipelineSummary,
  formatPipelineSummaryForPrompt,
  formatSingleEntityPrompt,
  parsePlannerResponse,
  checkDuplicateSuggestion,
} from "../_shared/operations/planner.ts";
import {
  lookupAutonomyLevel,
  executeSuggestion,
  fetchEntityContext,
} from "../_shared/operations/routing.ts";
import { logMetric, startTimer } from "../_shared/operations/metrics.ts";

export const PLANNER_AGENT_SLUG = "proactive_planner";
export const PLANNER_DEFAULT_ORG_SLUG = "tremendous-care";

const PLANNER_SYSTEM_PROMPT = `You are the daily planner for Tremendous Care, a home care staffing agency in California. Analyze the full pipeline and recommend the highest-impact actions for today.

For each caregiver/client in the pipeline, you have:
- Name, phase, days in phase, board status
- Last contact date and channel
- Incomplete tasks
- Active alerts from our rules engine (these reflect what the team watches for)
- Recent outcome history (did previous outreach get responses?)
- Whether they have a phone number and/or email

Recommend up to {max_suggestions} actions, prioritized by impact. Consider:
- People who were responsive before but went quiet — a nudge can re-engage them
- People close to completing onboarding — don't let them fall off when they're almost done
- New applicants — first 24h response rate matters most for conversion
- Compliance gaps (expiring HCA, missing documents) — these block deployment
- Don't suggest actions that our automation rules already handle (listed below)
- Don't suggest follow-ups for people you've already suggested follow-ups for recently
- If someone has no phone number, suggest email instead of SMS
- Draft SMS messages under 160 characters, warm and professional
- Draft emails with a clear subject line and brief body

For each recommendation, return a JSON array. Each item must have:
- entity_id: the EXACT UUID from the pipeline data (the string inside square brackets, e.g. "223358e6-b25b-4da5-a1a5-fc46b939b3fc"). NEVER generate your own ID — copy the UUID exactly as shown.
- entity_type: "caregiver" or "client"
- entity_name: their name
- action_type: one of: send_sms, send_email, add_note, complete_task, update_phase, create_calendar_event, send_docusign_envelope
- priority: "high", "medium", or "low"
- title: brief description (under 80 chars)
- detail: your reasoning (1-2 sentences)
- drafted_content: the message text (for send_sms or send_email) or null
- action_params: structured params for execution. For send_sms: {message: "..."}. For send_email: {subject: "...", body: "..."}. For add_note: {text: "...", type: "ai_planner"}. For complete_task: {task_id: "task_xxx"}. For update_phase: {new_phase: "Phase Name"}. For create_calendar_event: {subject: "...", start_time: "ISO string", duration_minutes: 30}.

Respond with ONLY the JSON array. No explanation or markdown wrapping.`;

const SINGLE_ENTITY_SYSTEM_PROMPT = `You are an event-triggered planner for Tremendous Care, a home care staffing agency in California. An event just occurred for one entity. Analyze the full context and recommend 1-3 immediate next actions.

You have deep context for this person:
- Full conversation history (SMS/email thread)
- Current phase and all tasks (with human-readable labels)
- Calendar context (upcoming events)
- Recent events and outcome history
- The specific trigger that invoked this analysis

Consider:
- What the trigger event means for this person's onboarding journey
- What the logical next step is given the trigger
- Whether this person has been responsive (check conversation history and outcomes)
- Don't suggest actions that automation rules already handle (listed below)
- If someone has no phone number, suggest email instead of SMS
- Draft SMS messages under 160 characters, warm and professional
- Draft emails with a clear subject line and brief body

For each recommendation, return a JSON array. Each item must have:
- entity_id: the EXACT UUID shown in the Entity Profile section below (e.g. "223358e6-b25b-4da5-a1a5-fc46b939b3fc"). NEVER generate your own ID — copy the UUID exactly.
- entity_type: "caregiver" or "client"
- entity_name: their name
- action_type: one of: send_sms, send_email, add_note, complete_task, update_phase, create_calendar_event, send_docusign_envelope
- priority: "high", "medium", or "low"
- title: brief description (under 80 chars)
- detail: your reasoning (1-2 sentences)
- drafted_content: the message text (for send_sms or send_email) or null
- action_params: structured params for execution. For send_sms: {message: "..."}. For send_email: {subject: "...", body: "..."}. For add_note: {text: "...", type: "ai_planner"}. For complete_task: {task_id: "task_xxx"}. For update_phase: {new_phase: "Phase Name"}. For create_calendar_event: {subject: "...", start_time: "ISO string", duration_minutes: 30}.

Respond with ONLY the JSON array. No explanation or markdown wrapping.`;

const PLANNER_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export interface PlannerShellDeps {
  supabase: any;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
}

export async function runAiPlannerShell(
  req: Request,
  deps: PlannerShellDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: PLANNER_CORS_HEADERS });
  }

  const supabase = deps.supabase;
  const results: Record<string, any> = {};
  const doneInvocation = startTimer(supabase, "ai-planner", "invocation");

  try {
    if (!deps.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

    let body: any = {};
    try { body = await req.json(); } catch { /* empty body = daily cron */ }
    const { entity_id, entity_type, trigger_reason } = body;
    const isSingleEntity = !!(entity_id && entity_type);

    // Resolve org_id. Cron runs without a JWT, so we use the deterministic
    // helper (single-tenant today; per-org loop arrives in SaaS Phase B5+).
    // TODO(saas-phase-b5): iterate `organizations` and run once per org.
    const orgId = await resolveOrgIdFromSlug(supabase, PLANNER_DEFAULT_ORG_SLUG);
    if (!orgId) {
      results.skipped = `Could not resolve org_id for slug='${PLANNER_DEFAULT_ORG_SLUG}'`;
      doneInvocation(false, results);
      return jsonOk(results);
    }

    const agentId = await resolveAgentIdSafe(supabase, PLANNER_AGENT_SLUG, orgId);

    // ── planner_enabled ──
    const { data: enabledSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "planner_enabled")
      .single();

    if (enabledSetting?.value === "false" || enabledSetting?.value === false) {
      results.skipped = "Planner is disabled";
      doneInvocation(true, results);
      return jsonOk(results);
    }

    // ── Shared context ──
    const { data: actionItemRules } = await supabase
      .from("action_item_rules")
      .select("name, entity_type, condition_type, condition_config, urgency, title_template, detail_template, enabled")
      .eq("enabled", true);

    const { data: automationRules } = await supabase
      .from("automation_rules")
      .select("name, trigger_type, action_type, conditions, enabled, entity_type")
      .eq("enabled", true);

    const since14d = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recentOutcomes } = await supabase
      .from("action_outcomes")
      .select("entity_id, action_type, outcome_type, created_at")
      .gte("created_at", since14d)
      .order("created_at", { ascending: false })
      .limit(200);

    const { data: bizCtx } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ai_business_context")
      .single();
    const businessContext = bizCtx?.value || "";

    const rules_context = (actionItemRules || [])
      .filter((r: any) => r.enabled)
      .map((r: any) => `- ${r.name}: ${r.detail_template || r.title_template} (${r.urgency})`)
      .join("\n");

    const automation_context = (automationRules || [])
      .filter((r: any) => r.enabled)
      .map((r: any) => `- ${r.name}: trigger=${r.trigger_type}, action=${r.action_type}`)
      .join("\n");

    let systemPrompt: string;
    let userPrompt: string;
    let maxSuggestions: number;
    let sourceType: string;

    if (isSingleEntity) {
      results.mode = "single_entity";
      results.entity_id = entity_id;
      results.trigger_reason = trigger_reason;

      const since30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: recentTrigger } = await supabase
        .from("ai_suggestions")
        .select("id")
        .eq("entity_id", entity_id)
        .eq("source_type", "event_triggered")
        .gte("created_at", since30m)
        .limit(1);

      if (recentTrigger && recentTrigger.length > 0) {
        results.skipped = `Event-triggered suggestion for ${entity_id} already exists within 30 minutes`;
        doneInvocation(true, results);
        return jsonOk(results);
      }

      const entityContext = await fetchEntityContext(supabase, entity_type, entity_id);
      if (!entityContext) {
        results.skipped = `Entity ${entity_id} not found or context fetch failed`;
        doneInvocation(true, results);
        return jsonOk(results);
      }

      const tableName = entity_type === "client" ? "clients" : "caregivers";
      const { data: rawEntity } = await supabase
        .from(tableName)
        .select("*")
        .eq("id", entity_id)
        .single();

      const entityPromptText = formatSingleEntityPrompt(
        entityContext,
        trigger_reason || "Event triggered (no reason specified)",
        recentOutcomes || [],
        actionItemRules || [],
        rawEntity || {},
      );

      systemPrompt = SINGLE_ENTITY_SYSTEM_PROMPT;
      maxSuggestions = 3;
      sourceType = "event_triggered";

      userPrompt = entityPromptText;
      if (automation_context) {
        userPrompt += `\n\n## Active Automation Rules (already handled automatically — skip these)\n${automation_context}`;
      }
      if (businessContext) {
        userPrompt += `\n\n## Business Context & Preferences\n${businessContext}`;
      }
    } else {
      results.mode = "full_pipeline";

      const { data: lastRun } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "last_planner_run")
        .single();

      const today = new Date().toISOString().split("T")[0];
      if (lastRun?.value && typeof lastRun.value === "string") {
        const lastRunDate = lastRun.value.split("T")[0];
        if (lastRunDate === today) {
          results.skipped = `Already ran today (${lastRun.value})`;
          doneInvocation(true, results);
          return jsonOk(results);
        }
      }

      const { data: maxSugSetting } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "planner_max_suggestions")
        .single();
      maxSuggestions = parseInt(maxSugSetting?.value) || 7;

      const { data: caregivers } = await supabase
        .from("caregivers")
        .select("id, first_name, last_name, phone, email, phase_override, phase_timestamps, tasks, notes, created_at, archived, board_status, has_hca, hca_expiration")
        .order("created_at", { ascending: false });

      const { data: clients } = await supabase
        .from("clients")
        .select("id, first_name, last_name, phone, email, phase, phase_timestamps, tasks, notes, created_at, archived")
        .order("created_at", { ascending: false });

      const { entities } = buildPipelineSummary(
        caregivers || [],
        clients || [],
        actionItemRules || [],
        automationRules || [],
        recentOutcomes || [],
      );

      results.pipeline_size = entities.length;
      results.active_rules = (actionItemRules || []).length;
      results.active_automations = (automationRules || []).length;

      if (entities.length === 0) {
        results.skipped = "No active entities in pipeline";
        doneInvocation(true, results);
        return jsonOk(results);
      }

      const pipelineText = formatPipelineSummaryForPrompt(entities);
      systemPrompt = PLANNER_SYSTEM_PROMPT.replace("{max_suggestions}", String(maxSuggestions));
      sourceType = "proactive";

      userPrompt = `## Pipeline (${entities.length} active entities)\n\n${pipelineText}`;
      if (rules_context) {
        userPrompt += `\n\n## Active Alert Rules (what our team watches for)\n${rules_context}`;
      }
      if (automation_context) {
        userPrompt += `\n\n## Active Automation Rules (already handled automatically — skip these)\n${automation_context}`;
      }
      if (businessContext) {
        userPrompt += `\n\n## Business Context & Preferences\n${businessContext}`;
      }
    }

    // ── Sonnet call via runAgent ──
    const doneClassify = startTimer(supabase, "ai-planner", "sonnet_call");

    const agentResult = await runAgent(
      supabase,
      PLANNER_AGENT_SLUG,
      {
        shape: "planner",
        planner: {
          mode: isSingleEntity
            ? "single_entity_event_triggered"
            : "full_pipeline_daily",
          systemPrompt,
          userPrompt,
        },
      },
      {
        orgId,
        apiKey: deps.apiKey,
        fetchImpl: deps.fetchImpl,
      },
    );

    if (agentResult.status === "error") {
      doneClassify(false, { error: agentResult.error?.message });
      throw new Error(agentResult.error?.message || "agent_runtime_error");
    }

    if (agentResult.status === "killed") {
      results.skipped = "Agent kill_switch=true";
      doneInvocation(true, results);
      return jsonOk(results);
    }

    const responseText = agentResult.reply || "";
    const inputTokens = agentResult.cost.input_tokens;
    const outputTokens = agentResult.cost.output_tokens;
    doneClassify(true, { input_tokens: inputTokens, output_tokens: outputTokens });

    results.input_tokens = inputTokens;
    results.output_tokens = outputTokens;

    const suggestions = parsePlannerResponse(responseText);
    results.suggestions_parsed = suggestions.length;

    let created = 0;
    let skipped = 0;
    let autoExecuted = 0;

    for (const sug of suggestions.slice(0, maxSuggestions)) {
      const isDuplicate = await checkDuplicateSuggestion(
        supabase,
        sug.entity_id,
        sug.action_type,
        24,
      );
      if (isDuplicate) {
        skipped++;
        continue;
      }

      const autonomyConfig = await lookupAutonomyLevel(
        supabase,
        sug.action_type,
        sug.entity_type,
        "proactive",
      );
      const autonomyLevel = autonomyConfig.autonomy_level;

      const actionParams = {
        ...sug.action_params,
        entity_id: sug.entity_id,
        entity_type: sug.entity_type,
      };

      const status = (autonomyLevel === "L3" || autonomyLevel === "L4")
        ? "auto_executed"
        : "pending";

      const insertRow: Record<string, any> = {
        source_type: sourceType,
        source_id: null,
        entity_type: sug.entity_type,
        entity_id: sug.entity_id,
        entity_name: sug.entity_name,
        suggestion_type: sug.action_type.startsWith("send_") ? "follow_up" : "action",
        action_type: sug.action_type,
        title: `[${sug.priority.toUpperCase()}] ${sug.title}`,
        detail: sug.detail,
        drafted_content: sug.drafted_content,
        action_params: actionParams,
        intent: "proactive_planner",
        intent_confidence: 0.9,
        autonomy_level: autonomyLevel,
        status,
        input_tokens: Math.round(inputTokens / Math.max(1, suggestions.length)),
        output_tokens: Math.round(outputTokens / Math.max(1, suggestions.length)),
      };
      if (agentId) insertRow.agent_id = agentId;

      const { data: inserted, error: insertErr } = await supabase
        .from("ai_suggestions")
        .insert(insertRow)
        .select("id")
        .single();

      if (insertErr) {
        console.error(`[ai-planner] Failed to insert suggestion for ${sug.entity_name}:`, insertErr);
        continue;
      }

      created++;

      // Phase 1.1.C dual-write: tamper-evident audit row for the
      // suggestion. Phase 'suggested' (the planner produced it) or
      // 'auto_executed' (autonomy says fire it now). Fire-and-forget
      // — a failed audit must not roll back the suggestion insert.
      if (agentId) {
        recordAgentAction(supabase, {
          orgId,
          agentId,
          agentVersion: agentResult.agent?.version ?? 0,
          actionType: sug.action_type,
          phase: status === "auto_executed" ? "auto_executed" : "suggested",
          entityType: sug.entity_type as "caregiver" | "client" | null,
          entityId: sug.entity_id,
          actor: "system:ai-planner",
          payload: {
            suggestion_id: inserted?.id,
            source_type: sourceType,
            priority: sug.priority,
            title: sug.title,
            autonomy_level: autonomyLevel,
            ...sug.action_params,
          },
          outcomeId: null,
        }).catch((err: unknown) =>
          console.error("[ai-planner audit] record_agent_action failed:", err),
        );
      }

      if (status === "auto_executed" && inserted?.id) {
        const execResult = await executeSuggestion(
          supabase,
          inserted.id,
          "system:ai-planner",
        );
        if (execResult.success) {
          autoExecuted++;
        } else {
          console.error(`[ai-planner] Auto-execute failed for ${inserted.id}:`, execResult.error);
        }
      }
    }

    results.suggestions_created = created;
    results.suggestions_skipped_dedup = skipped;
    results.auto_executed = autoExecuted;
    results.shadow = agentResult.shadow;
    results.runtime = true;

    if (!isSingleEntity) {
      await supabase
        .from("app_settings")
        .upsert({
          key: "last_planner_run",
          value: new Date().toISOString(),
        });
    }

    doneInvocation(true, results);
    return jsonOk(results);
  } catch (err) {
    console.error("[ai-planner] Fatal error:", err);
    logMetric(supabase, "ai-planner", "error", undefined, false, {
      error: (err as Error).message,
    });
    doneInvocation(false, { error: (err as Error).message });
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...PLANNER_CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
}

// ─── Helpers ───

export async function resolveOrgIdFromSlug(
  supabase: any,
  slug: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (error || !data) return null;
    return data.id || null;
  } catch {
    return null;
  }
}

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

function jsonOk(results: Record<string, any>): Response {
  return new Response(
    JSON.stringify({ success: true, results }),
    { headers: { ...PLANNER_CORS_HEADERS, "Content-Type": "application/json" } },
  );
}
