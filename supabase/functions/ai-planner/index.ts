// ─── AI Planner ───
// Daily cron (7am PT / 14:00 UTC) that analyzes the full pipeline
// using Claude Sonnet and generates up to 7 high-impact suggestions.
//
// Reads: caregivers, clients, action_item_rules, automation_rules,
//        action_outcomes, app_settings (business context + planner config)
// Writes: ai_suggestions (source_type = 'proactive')
//
// All suggestions flow through autonomy_config (context = 'proactive')
// and executeSuggestion() for the same guardrails as inbound routing.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logMetric, startTimer } from "../_shared/operations/metrics.ts";
import {
  buildPipelineSummary,
  formatPipelineSummaryForPrompt,
  parsePlannerResponse,
  checkDuplicateSuggestion,
  type PlannerSuggestion,
} from "../_shared/operations/planner.ts";
import {
  lookupAutonomyLevel,
  executeSuggestion,
} from "../_shared/operations/routing.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const SONNET_MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 2048;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Planner System Prompt ───

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
- entity_id: the ID string from the pipeline data (in brackets)
- entity_type: "caregiver" or "client"
- entity_name: their name
- action_type: one of: send_sms, send_email, add_note, complete_task, update_phase, create_calendar_event, send_docusign_envelope
- priority: "high", "medium", or "low"
- title: brief description (under 80 chars)
- detail: your reasoning (1-2 sentences)
- drafted_content: the message text (for send_sms or send_email) or null
- action_params: structured params for execution. For send_sms: {message: "..."}. For send_email: {subject: "...", body: "..."}. For add_note: {text: "...", type: "ai_planner"}. For complete_task: {task_id: "task_xxx"}. For update_phase: {new_phase: "Phase Name"}. For create_calendar_event: {subject: "...", start_time: "ISO string", duration_minutes: 30}.

Respond with ONLY the JSON array. No explanation or markdown wrapping.`;

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Record<string, any> = {};
  const doneInvocation = startTimer(supabase, "ai-planner", "invocation");

  try {
    // ── Check if planner is enabled ──
    const { data: enabledSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "planner_enabled")
      .single();

    if (enabledSetting?.value === "false" || enabledSetting?.value === false) {
      results.skipped = "Planner is disabled";
      doneInvocation(true, results);
      return new Response(JSON.stringify({ success: true, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Check idempotency (don't run twice in same day) ──
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
        return new Response(JSON.stringify({ success: true, results }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── Get max suggestions setting ──
    const { data: maxSugSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "planner_max_suggestions")
      .single();
    const maxSuggestions = parseInt(maxSugSetting?.value) || 7;

    // ── Load pipeline data ──
    const { data: caregivers } = await supabase
      .from("caregivers")
      .select("id, first_name, last_name, phone, email, phase_override, phase_timestamps, tasks, notes, created_at, archived, board_status, has_hca, hca_expiration")
      .order("created_at", { ascending: false });

    const { data: clients } = await supabase
      .from("clients")
      .select("id, first_name, last_name, phone, email, phase, phase_timestamps, tasks, notes, created_at, archived")
      .order("created_at", { ascending: false });

    // ── Load rules context ──
    const { data: actionItemRules } = await supabase
      .from("action_item_rules")
      .select("name, entity_type, condition_type, condition_config, urgency, title_template, detail_template, enabled")
      .eq("enabled", true);

    const { data: automationRules } = await supabase
      .from("automation_rules")
      .select("name, trigger_type, action_type, conditions, enabled, entity_type")
      .eq("enabled", true);

    // ── Load recent outcomes (last 14 days) ──
    const since14d = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recentOutcomes } = await supabase
      .from("action_outcomes")
      .select("entity_id, action_type, outcome_type, created_at")
      .gte("created_at", since14d)
      .order("created_at", { ascending: false })
      .limit(200);

    // ── Load business context ──
    const { data: bizCtx } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ai_business_context")
      .single();
    const businessContext = bizCtx?.value || "";

    // ── Build pipeline summary ──
    const { entities, rules_context, automation_context } = buildPipelineSummary(
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
      return new Response(JSON.stringify({ success: true, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Build Sonnet prompt ──
    const pipelineText = formatPipelineSummaryForPrompt(entities);
    const systemPrompt = PLANNER_SYSTEM_PROMPT.replace("{max_suggestions}", String(maxSuggestions));

    let userPrompt = `## Pipeline (${entities.length} active entities)\n\n${pipelineText}`;

    if (rules_context) {
      userPrompt += `\n\n## Active Alert Rules (what our team watches for)\n${rules_context}`;
    }
    if (automation_context) {
      userPrompt += `\n\n## Active Automation Rules (already handled automatically — skip these)\n${automation_context}`;
    }
    if (businessContext) {
      userPrompt += `\n\n## Business Context & Preferences\n${businessContext}`;
    }

    // ── Call Sonnet ──
    const doneClassify = startTimer(supabase, "ai-planner", "sonnet_call");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      doneClassify(false, { error: `HTTP ${response.status}`, detail: errText.slice(0, 200) });
      throw new Error(`Sonnet API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    const responseText = data.content?.[0]?.text || "";
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    doneClassify(true, { input_tokens: inputTokens, output_tokens: outputTokens });

    results.input_tokens = inputTokens;
    results.output_tokens = outputTokens;

    // ── Parse response ──
    const suggestions = parsePlannerResponse(responseText);
    results.suggestions_parsed = suggestions.length;

    // ── Create suggestions with dedup + autonomy ──
    let created = 0;
    let skipped = 0;
    let autoExecuted = 0;

    for (const sug of suggestions.slice(0, maxSuggestions)) {
      // Dedup check
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

      // Look up autonomy level for proactive context
      const autonomyConfig = await lookupAutonomyLevel(
        supabase,
        sug.action_type,
        sug.entity_type,
        "proactive",
      );
      const autonomyLevel = autonomyConfig.autonomy_level;

      // Build action_params with required fields
      const actionParams = {
        ...sug.action_params,
        entity_id: sug.entity_id,
        entity_type: sug.entity_type,
      };

      // Insert suggestion
      const status = (autonomyLevel === "L3" || autonomyLevel === "L4")
        ? "auto_executed"
        : "pending";

      const { data: inserted, error: insertErr } = await supabase
        .from("ai_suggestions")
        .insert({
          source_type: "proactive",
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
          input_tokens: Math.round(inputTokens / suggestions.length),
          output_tokens: Math.round(outputTokens / suggestions.length),
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error(`[ai-planner] Failed to insert suggestion for ${sug.entity_name}:`, insertErr);
        continue;
      }

      created++;

      // Auto-execute if L3/L4
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

    // ── Record planner run ──
    await supabase
      .from("app_settings")
      .upsert({
        key: "last_planner_run",
        value: new Date().toISOString(),
      });

    doneInvocation(true, results);

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[ai-planner] Fatal error:", err);
    logMetric(supabase, "ai-planner", "error", undefined, false, {
      error: (err as Error).message,
    });
    doneInvocation(false, { error: (err as Error).message });

    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
