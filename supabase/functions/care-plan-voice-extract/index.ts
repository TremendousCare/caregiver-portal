// ─── Care Plan Voice Extract ───
//
// Pipeline:
//   1. Receive multipart POST: audio file + section schema (JSON) +
//      current section values (JSON) + sectionId + clientId.
//   2. Send audio to OpenAI Whisper → transcript.
//   3. Send transcript + schema + current values to Claude Sonnet 4.6
//      with a forced tool call (record_care_plan_facts) → structured
//      field claims.
//   4. Defensively validate every claim against the schema (drop
//      unknown ids, enforce enums, check quote-in-transcript).
//   5. Return { transcript, extracted, rejected, usage, costUsd }.
//
// We do NOT persist:
//   - Audio: discarded after Whisper returns.
//   - Transcript / extraction: returned to the client only. The
//     client renders the review UI, applies accepted claims through
//     the existing saveDraft path (which already emits events for
//     audit), then forgets the audio.
//
// Auth:
//   - Bearer JWT required (any JWT-shaped token is accepted; the
//     edge runtime's verify_jwt is off so we accept service-role key
//     too for testability — same pattern as bd-transcribe).
//
// CORS: scoped allowlist (prod URL + localhost dev ports).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildExtractionTool,
  buildSystemPrompt,
  buildUserMessage,
  validateClaims,
  validateTaskClaims,
  type ExtractionSchema,
  type FieldClaim,
  type TaskClaim,
  type TaskSchema,
} from "./prompt.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY            = Deno.env.get("OPENAI_API_KEY") ?? "";
const ANTHROPIC_API_KEY         = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// Sonnet 4.6: best accuracy/cost tradeoff for structured extraction
// on medical content. Haiku is cheaper but mis-classifies enums more
// often on the dictation patterns nurses actually use. Opus would be
// overkill for this task — the schema-locked output makes the job
// constrained enough that Sonnet is consistently correct.
const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_MAX_TOKENS = 4096;

// Sonnet 4.6 pricing per million tokens
const CLAUDE_INPUT_PER_M  = 3.0;
const CLAUDE_OUTPUT_PER_M = 15.0;

// Whisper-1 audio cap (matches OpenAI's per-request size).
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Hard caps on what we accept in the multipart body. Schemas are
// small (under 10KB even for the largest sections); current values
// can be bigger but should never exceed ~100KB of JSON.
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_CURRENT_BYTES = 256 * 1024;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const ALLOWED_ORIGINS = [
  "https://caregiver-portal.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function requireAuth(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return "Bearer token required";
  const token = match[1];
  if (token === SUPABASE_SERVICE_ROLE_KEY) return null;
  if (JWT_SHAPE.test(token)) return null;
  return "Invalid token shape";
}


Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json(405, { error: "method not allowed" }, cors);

  const authErr = requireAuth(req);
  if (authErr) return json(401, { error: authErr }, cors);

  if (!OPENAI_API_KEY)    return json(500, { error: "OPENAI_API_KEY not configured" }, cors);
  if (!ANTHROPIC_API_KEY) return json(500, { error: "ANTHROPIC_API_KEY not configured" }, cors);

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return json(415, { error: `expected multipart/form-data; got ${contentType || "<empty>"}` }, cors);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return json(400, { error: `could not parse multipart body: ${(e as Error).message}` }, cors);
  }

  // ── Parse + validate inputs ──────────────────────────────────
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return json(400, { error: "missing or empty 'file' field" }, cors);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return json(413, { error: `audio too large (${file.size} bytes; max ${MAX_AUDIO_BYTES})` }, cors);
  }

  const schemaRaw = String(form.get("schema") ?? "");
  if (!schemaRaw) return json(400, { error: "missing 'schema' field" }, cors);
  if (schemaRaw.length > MAX_SCHEMA_BYTES) {
    return json(413, { error: "schema too large" }, cors);
  }
  let schema: ExtractionSchema;
  try {
    schema = JSON.parse(schemaRaw);
  } catch (e) {
    return json(400, { error: `invalid schema JSON: ${(e as Error).message}` }, cors);
  }
  if (!schema?.sectionId || !Array.isArray(schema.fields)) {
    return json(400, { error: "schema missing sectionId or fields[]" }, cors);
  }

  const currentRaw = String(form.get("currentValues") ?? "{}");
  if (currentRaw.length > MAX_CURRENT_BYTES) {
    return json(413, { error: "currentValues too large" }, cors);
  }
  let currentValues: Record<string, unknown> = {};
  try {
    currentValues = JSON.parse(currentRaw);
  } catch {
    // Tolerate bad current-values JSON — extraction can proceed
    // without it; we just won't show "current vs proposed" context to
    // Claude.
    currentValues = {};
  }

  // Phase 3: optional task schema. Only sent for sections with a
  // care_plan_tasks side table (ADLs, IADLs). Bad/missing schema =
  // tasks not in scope for this call; we don't error so flat
  // sections continue to work.
  const taskSchemaRaw = String(form.get("taskSchema") ?? "");
  let taskSchema: TaskSchema | null = null;
  if (taskSchemaRaw) {
    if (taskSchemaRaw.length > MAX_SCHEMA_BYTES) {
      return json(413, { error: "taskSchema too large" }, cors);
    }
    try {
      const parsed = JSON.parse(taskSchemaRaw);
      if (
        parsed
        && Array.isArray(parsed.categories) && parsed.categories.length > 0
        && Array.isArray(parsed.shifts)
        && Array.isArray(parsed.daysOfWeek)
        && Array.isArray(parsed.priorities)
      ) {
        taskSchema = parsed as TaskSchema;
      }
    } catch {
      // Bad task schema = silently treat as no-tasks. Flat-section
      // path is unaffected.
      taskSchema = null;
    }
  }

  const clientId  = String(form.get("clientId")  ?? "") || null;
  const versionId = String(form.get("versionId") ?? "") || null;
  const userId    = String(form.get("userId")    ?? "") || null;

  // Pick a Whisper-friendly filename based on the blob's content type.
  let filename = "memo.webm";
  const blobType = (file as Blob).type || "";
  if (blobType.includes("mp4"))       filename = "memo.mp4";
  else if (blobType.includes("mpeg")) filename = "memo.mp3";
  else if (blobType.includes("wav"))  filename = "memo.wav";
  else if (blobType.includes("ogg"))  filename = "memo.ogg";

  // ── 1. Transcribe via Whisper ────────────────────────────────
  const whisperStart = Date.now();
  const whisperForm = new FormData();
  whisperForm.append("file", file as Blob, filename);
  whisperForm.append("model", "whisper-1");
  whisperForm.append("response_format", "verbose_json");
  // Bias Whisper toward home-care terminology so it transcribes
  // common medication names and clinical terms more accurately.
  whisperForm.append(
    "prompt",
    "Home care intake dictation. May include medication names, dosages, diagnoses, and clinical terms.",
  );

  let whisperResp: Response;
  try {
    whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: whisperForm,
    });
  } catch (e) {
    return json(502, { error: `Whisper unreachable: ${(e as Error).message}` }, cors);
  }
  if (!whisperResp.ok) {
    const errBody = await whisperResp.text().catch(() => "");
    console.error(`[care-plan-voice-extract] Whisper ${whisperResp.status}:`, errBody.slice(0, 500));
    return json(whisperResp.status === 429 ? 429 : 502, {
      error: `Whisper returned ${whisperResp.status}`,
      detail: errBody.slice(0, 300),
    }, cors);
  }
  let whisperData: { text?: string; duration?: number; language?: string };
  try {
    whisperData = await whisperResp.json();
  } catch (e) {
    return json(502, { error: `Whisper returned non-JSON: ${(e as Error).message}` }, cors);
  }
  const transcript = (whisperData.text ?? "").trim();
  const whisperMs = Date.now() - whisperStart;

  if (!transcript) {
    return json(200, {
      transcript: "",
      extracted: [],
      rejected: [],
      transcriptionMs: whisperMs,
      warnings: ["Whisper returned an empty transcript — try recording again."],
    }, cors);
  }

  // ── 2. Extract structured fields via Claude tool use ─────────
  const tool = buildExtractionTool({ taskSchema });
  const system = buildSystemPrompt({ includeTasks: !!taskSchema });
  const userMessage = buildUserMessage({ schema, transcript, currentValues, taskSchema });

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
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system,
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (e) {
    return json(502, { error: `Claude unreachable: ${(e as Error).message}` }, cors);
  }
  if (!claudeResp.ok) {
    const errBody = await claudeResp.text().catch(() => "");
    console.error(`[care-plan-voice-extract] Claude ${claudeResp.status}:`, errBody.slice(0, 500));
    return json(claudeResp.status === 429 ? 429 : 502, {
      error: `Claude returned ${claudeResp.status}`,
      detail: errBody.slice(0, 300),
      transcript,
    }, cors);
  }
  const claudePayload = await claudeResp.json();
  const claudeMs = Date.now() - claudeStart;

  // Pull the tool_use block.
  let toolInput: { fields?: FieldClaim[]; tasks?: TaskClaim[] } | null = null;
  for (const block of claudePayload.content || []) {
    if (block.type === "tool_use" && block.name === tool.name) {
      toolInput = block.input;
      break;
    }
  }
  if (!toolInput || !Array.isArray(toolInput.fields)) {
    console.error("[care-plan-voice-extract] no tool_use block in response");
    return json(502, {
      error: "Claude did not call the extraction tool",
      transcript,
    }, cors);
  }

  // ── 3. Validate claims against the schema ───────────────────
  const { accepted, rejected } = validateClaims({
    claims: toolInput.fields,
    schema,
    transcript,
  });

  // Validate task claims when the section accepts tasks.
  const taskClaims: TaskClaim[] = Array.isArray(toolInput.tasks) ? toolInput.tasks : [];
  const taskValidation = taskSchema
    ? validateTaskClaims({ claims: taskClaims, taskSchema, transcript })
    : { accepted: [], rejected: [] };

  // ── 4. Cost + observability ─────────────────────────────────
  const usage = claudePayload.usage || {};
  const costUsd = Math.round(
    (
      ((usage.input_tokens || 0) * CLAUDE_INPUT_PER_M / 1_000_000) +
      ((usage.output_tokens || 0) * CLAUDE_OUTPUT_PER_M / 1_000_000) +
      // Whisper: $0.006/min, billed per second
      ((whisperData.duration || 0) * 0.006 / 60)
    ) * 10000,
  ) / 10000;

  if (clientId || versionId) {
    // Fire-and-forget event log so we can see how voice extraction is
    // being used without blocking the response path.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    supabase
      .from("events")
      .insert({
        event_type: "care_plan_voice_extracted",
        entity_type: "care_plan",
        entity_id: clientId || versionId,
        actor: userId ? `user:${userId}` : "system:ai",
        payload: {
          sectionId: schema.sectionId,
          versionId,
          transcriptLength: transcript.length,
          transcriptDurationSec: whisperData.duration || 0,
          claimsTotal: toolInput.fields.length,
          claimsAccepted: accepted.length,
          claimsRejected: rejected.length,
          tasksProposed: taskClaims.length,
          tasksAccepted: taskValidation.accepted.length,
          tasksRejected: taskValidation.rejected.length,
          model: CLAUDE_MODEL,
          costUsd,
          whisperMs,
          claudeMs,
        },
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.warn("[care-plan-voice-extract] event log failed:", error.message);
      });
  }

  return json(200, {
    transcript,
    transcriptionMs: whisperMs,
    extractionMs: claudeMs,
    transcriptionLanguage: whisperData.language ?? null,
    transcriptDurationSec: whisperData.duration ?? null,
    extracted: accepted,
    rejected,
    proposedTasks: taskValidation.accepted,
    rejectedTasks: taskValidation.rejected,
    usage: {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    },
    costUsd,
    model: CLAUDE_MODEL,
  }, cors);
});
