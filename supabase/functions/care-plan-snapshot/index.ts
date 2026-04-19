// ─── Care Plan Snapshot ───
//
// Generates a caregiver-facing narrative snapshot of a client's care
// plan by calling Claude Opus 4.7. The prompt structure:
//   - System: voice + hard rules
//   - User:   care plan data + structured "think then write"
//             instructions, producing <analysis>/<snapshot>/<gaps>
// We parse <snapshot> for the narrative and <gaps> for a list of
// missing info the care team should collect.
//
// Input: { versionId: string, regenerate?: boolean }
// Output: { narrative, gaps, cached, model, generatedAt, tokensUsed }
//
// Behavior:
//   1. Load version + tasks
//   2. If `regenerate` is false and `generated_summary` exists,
//      return it from cache without calling Claude
//   3. Otherwise, build the prompt, call Claude, parse the tagged
//      response, persist narrative on `generated_summary` +
//      `data.snapshot.narrative` (and gaps on `data.snapshot.gaps`),
//      and emit a `care_plan_snapshot_generated` event.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildSnapshotPrompt, parseSnapshotResponse } from "./prompt.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// Model + pricing (Opus 4.7)
//   Input:  $5.00 / 1M tokens
//   Output: $25.00 / 1M tokens
// The prompt is below the Opus cache threshold, so we no longer mark
// the system block with cache_control.
const CLAUDE_MODEL = "claude-opus-4-7";
// Headroom for <analysis> + 400-600 word <snapshot> + <gaps>.
const CLAUDE_MAX_TOKENS = 6000;

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(status: number, body: unknown, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

function estimateCostUsd(usage: ClaudeUsage): number {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const per_M = 1_000_000;
  const cost =
    (input * 5.0) / per_M +
    (output * 25.0) / per_M +
    (cacheWrite * 6.25) / per_M +
    (cacheRead * 0.5) / per_M;
  return Math.round(cost * 10000) / 10000; // round to 4 decimals
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" }, cors);
  }

  let body: { versionId?: string; regenerate?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" }, cors);
  }

  const { versionId, regenerate = false } = body;
  if (!versionId) {
    return jsonResponse(400, { error: "versionId is required" }, cors);
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse(500, { error: "ANTHROPIC_API_KEY not configured" }, cors);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Load version ─────────────────────────────────────────────
  const { data: version, error: readErr } = await supabase
    .from("care_plan_versions")
    .select("id, care_plan_id, status, data, generated_summary")
    .eq("id", versionId)
    .maybeSingle();

  if (readErr) return jsonResponse(500, { error: readErr.message }, cors);
  if (!version) return jsonResponse(404, { error: "version not found" }, cors);

  // Serve cached summary unless explicitly regenerating.
  if (!regenerate && version.generated_summary) {
    return jsonResponse(200, {
      narrative: version.generated_summary,
      cached: true,
      model: CLAUDE_MODEL,
      generatedAt: null,
    }, cors);
  }

  // ── Load tasks (for the prompt) ──────────────────────────────
  // Order matters: buildUserMessage truncates each category to the
  // first 6 task names, so without a deterministic order Postgres
  // could surface different tasks across runs and silently drop
  // caregiver-prioritized items. Match getTasksForVersion's ordering.
  const { data: tasks, error: tasksErr } = await supabase
    .from("care_plan_tasks")
    .select("id, category, task_name, description")
    .eq("version_id", versionId)
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true });

  if (tasksErr) {
    // Don't write a degraded snapshot. A care plan with rich tasks
    // but a transient task-load failure would otherwise produce a
    // narrative missing the "what the caregiver helps with" thread,
    // and that wrong snapshot would get persisted to
    // generated_summary. Better to surface the error so the admin
    // can retry.
    console.error("[care-plan-snapshot] task load failed:", tasksErr.message);
    return jsonResponse(500, {
      error: `Failed to load care plan tasks: ${tasksErr.message}`,
    }, cors);
  }

  // Normalize task rows to the camelCase shape the prompt expects.
  const normalizedTasks = (tasks || []).map((t: {
    id: string;
    category: string;
    task_name: string;
    description: string | null;
  }) => ({
    id: t.id,
    category: t.category,
    taskName: t.task_name,
    description: t.description,
  }));

  // ── Build prompt ─────────────────────────────────────────────
  const { system, userMessage, summary } = buildSnapshotPrompt({
    versionData: version.data || {},
    tasks: normalizedTasks,
  });

  // ── Call Claude ──────────────────────────────────────────────
  // The user message contains the "think then write" instructions so
  // the model does its own structured reasoning inside <analysis>
  // tags — no separate thinking block needed.
  const requestBody = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system,
    messages: [
      { role: "user", content: userMessage },
    ],
  };

  const claudeStart = Date.now();
  let claudeResp: Response;
  try {
    claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(502, { error: `Claude API unreachable: ${msg}` }, cors);
  }

  if (!claudeResp.ok) {
    const errBody = await claudeResp.text();
    console.error("[care-plan-snapshot] Claude API error",
      claudeResp.status, errBody.slice(0, 500));
    return jsonResponse(claudeResp.status, {
      error: `Claude API returned ${claudeResp.status}`,
      detail: errBody.slice(0, 500),
    }, cors);
  }

  const claudePayload = await claudeResp.json();
  const claudeMs = Date.now() - claudeStart;

  // Pull the first text block from the response and parse its tags.
  let rawText = "";
  for (const block of claudePayload.content || []) {
    if (block.type === "text" && typeof block.text === "string") {
      rawText = block.text;
      break;
    }
  }

  if (!rawText) {
    console.error("[care-plan-snapshot] no text block in response");
    return jsonResponse(502, {
      error: "Claude returned no text content",
    }, cors);
  }

  const { narrative, gaps } = parseSnapshotResponse(rawText);
  if (!narrative) {
    console.error("[care-plan-snapshot] no <snapshot> tag in response");
    return jsonResponse(502, {
      error: "Claude response missing <snapshot> content",
    }, cors);
  }

  const usage: ClaudeUsage = claudePayload.usage || {};
  const costUsd = estimateCostUsd(usage);

  // ── Persist ─────────────────────────────────────────────────
  const mergedData = {
    ...(version.data || {}),
    snapshot: { narrative, gaps: gaps || null },
  };
  const generatedAt = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("care_plan_versions")
    .update({
      generated_summary: narrative,
      data: mergedData,
    })
    .eq("id", versionId);

  if (updateErr) {
    console.error("[care-plan-snapshot] persist failed:", updateErr.message);
    return jsonResponse(500, { error: `Persist failed: ${updateErr.message}` }, cors);
  }

  // ── Observability event (fire-and-forget) ────────────────────
  supabase
    .from("events")
    .insert({
      event_type: "care_plan_snapshot_generated",
      entity_type: "care_plan",
      entity_id: version.care_plan_id,
      actor: "system:ai",
      payload: {
        versionId,
        model: CLAUDE_MODEL,
        regenerate,
        promptSummary: summary,
        usage: {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreationTokens: usage.cache_creation_input_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
        },
        costUsd,
        latencyMs: claudeMs,
      },
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn("[care-plan-snapshot] event log failed:", error.message);
    });

  return jsonResponse(200, {
    narrative,
    gaps: gaps || null,
    cached: false,
    model: CLAUDE_MODEL,
    generatedAt,
    tokensUsed: {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheCreation: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    },
    costUsd,
    latencyMs: claudeMs,
  }, cors);
});
