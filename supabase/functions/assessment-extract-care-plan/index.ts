// ─── assessment-extract-care-plan ─────────────────────────────────
//
// In-home assessment → draft care plan (PR 4).
//
// Takes a TRANSCRIBED assessment and runs Claude over its transcript,
// one care-plan section at a time, to propose structured field values
// and tasks. It REUSES the hardened extraction machinery from
// care-plan-voice-extract (prompt.ts): same forced-tool call, same
// system/user prompts, same defensive claim validation (drop unknown
// ids, enforce enums, require a supporting quote). The only differences
// here are (a) the transcript comes from assessment_transcriptions
// instead of Whisper, and (b) we extract across MANY sections in one
// request instead of one.
//
// This function does NOT write the care plan. Like voice-extract, it
// returns validated per-section claims; the frontend applies them
// through the existing audited storage.js path (createCarePlan /
// createNewDraftVersion / saveDraft / createTask), so the draft is
// written exactly like every other care-plan edit (events,
// current_version_id, version numbering all handled there).
//
// Auth: staff-only + org-scoped — decode the caller's JWT for org_id,
// confirm a real session + staff role, and verify the assessment
// belongs to the caller's org before reading its transcript.
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      SUPABASE_ANON_KEY.

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
} from "../care-plan-voice-extract/prompt.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ANTHROPIC_API_KEY         = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// Same model/limits/pricing as care-plan-voice-extract — schema-locked
// structured extraction where Sonnet is consistently accurate.
const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_MAX_TOKENS = 4096;
const CLAUDE_INPUT_PER_M = 3.0;
const CLAUDE_OUTPUT_PER_M = 15.0;

// Cap how many sections we'll extract per request, and how many Claude
// calls run at once. ~9 eligible sections; concurrency 4 keeps total
// latency to a couple of waves while staying well under rate limits.
const MAX_SECTIONS = 16;
const CONCURRENCY = 4;

const STAFF_ROLES = new Set(["admin", "member", "owner"]);

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

interface AuthCtx { orgId: string; userEmail: string | null; }

async function authenticate(
  authHeader: string | null,
): Promise<{ ok: true; ctx: AuthCtx } | { ok: false; status: number; error: string }> {
  if (!authHeader) return { ok: false, status: 401, error: "Missing Authorization header." };
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, error: "Malformed JWT." };
  let payload: Record<string, unknown>;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    payload = JSON.parse(atob(padded));
  } catch {
    return { ok: false, status: 401, error: "Invalid JWT payload." };
  }
  const orgId = typeof payload.org_id === "string" ? payload.org_id : null;
  if (!orgId) return { ok: false, status: 403, error: "JWT is missing org_id claim." };

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return { ok: false, status: 401, error: "Not authenticated." };
  return { ok: true, ctx: { orgId, userEmail: userData.user.email ?? null } };
}

async function assertStaff(supabase: ReturnType<typeof createClient>, email: string | null): Promise<boolean> {
  if (!email) return false;
  const { data } = await supabase
    .from("user_roles").select("role").eq("email", email.toLowerCase()).maybeSingle();
  return !!data && STAFF_ROLES.has((data as { role: string }).role);
}

interface SectionInput {
  sectionId: string;
  schema: ExtractionSchema;
  taskSchema?: TaskSchema | null;
  currentValues?: Record<string, unknown>;
}

interface SectionResult {
  sectionId: string;
  ok: boolean;
  error?: string;
  extracted: unknown[];
  rejected: unknown[];
  proposedTasks: unknown[];
  rejectedTasks: unknown[];
  inputTokens: number;
  outputTokens: number;
}

// Run the same Claude extraction as care-plan-voice-extract for one
// section against the provided transcript. Never throws — failures are
// returned as { ok:false } so one bad section can't sink the whole draft.
async function extractSection(section: SectionInput, transcript: string): Promise<SectionResult> {
  const base: SectionResult = {
    sectionId: section.sectionId, ok: false,
    extracted: [], rejected: [], proposedTasks: [], rejectedTasks: [],
    inputTokens: 0, outputTokens: 0,
  };
  try {
    const taskSchema = section.taskSchema ?? null;
    const tool = buildExtractionTool({ taskSchema });
    const system = buildSystemPrompt({ includeTasks: !!taskSchema });
    const userMessage = buildUserMessage({
      schema: section.schema,
      transcript,
      currentValues: section.currentValues ?? {},
      taskSchema,
    });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
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

    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).slice(0, 200);
      return { ...base, error: `Claude ${resp.status}: ${detail}` };
    }
    const payload = await resp.json();
    const usage = payload.usage || {};

    let toolInput: { fields?: FieldClaim[]; tasks?: TaskClaim[] } | null = null;
    for (const block of payload.content || []) {
      if (block.type === "tool_use" && block.name === tool.name) { toolInput = block.input; break; }
    }
    if (!toolInput || !Array.isArray(toolInput.fields)) {
      return { ...base, error: "Claude did not call the extraction tool", inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 };
    }

    const { accepted, rejected } = validateClaims({ claims: toolInput.fields, schema: section.schema, transcript });
    const taskClaims: TaskClaim[] = Array.isArray(toolInput.tasks) ? toolInput.tasks : [];
    const taskValidation = taskSchema
      ? validateTaskClaims({ claims: taskClaims, taskSchema, transcript })
      : { accepted: [], rejected: [] };

    return {
      sectionId: section.sectionId,
      ok: true,
      extracted: accepted,
      rejected,
      proposedTasks: taskValidation.accepted,
      rejectedTasks: taskValidation.rejected,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
  } catch (e) {
    return { ...base, error: `Extraction failed: ${(e as Error).message}` };
  }
}

// Bounded-concurrency map preserving input order.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST required." }, cors);

  if (!ANTHROPIC_API_KEY) return json(500, { error: "ANTHROPIC_API_KEY not configured." }, cors);

  const auth = await authenticate(req.headers.get("Authorization"));
  if (!auth.ok) return json(auth.status, { error: auth.error }, cors);
  const { orgId, userEmail } = auth.ctx;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!(await assertStaff(admin, userEmail))) {
    return json(403, { error: "Staff access required." }, cors);
  }

  let body: { assessment_id?: string; sections?: SectionInput[] } = {};
  try { body = await req.json(); } catch { return json(400, { error: "Body must be valid JSON." }, cors); }

  const assessmentId = typeof body.assessment_id === "string" ? body.assessment_id : null;
  if (!assessmentId) return json(400, { error: "assessment_id is required." }, cors);

  const sections = Array.isArray(body.sections) ? body.sections : [];
  if (sections.length === 0) return json(400, { error: "sections[] is required." }, cors);
  if (sections.length > MAX_SECTIONS) return json(413, { error: `Too many sections (max ${MAX_SECTIONS}).` }, cors);
  for (const s of sections) {
    if (!s?.schema?.sectionId || !Array.isArray(s.schema.fields)) {
      return json(400, { error: "Each section needs schema.sectionId and schema.fields[]." }, cors);
    }
  }

  // Load the assessment org-scoped (tenancy gate) + its transcript.
  const { data: assessment, error: aErr } = await admin
    .from("assessments")
    .select("id, org_id, client_id, status")
    .eq("id", assessmentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (aErr) return json(500, { error: `Assessment lookup failed: ${aErr.message}` }, cors);
  if (!assessment) return json(404, { error: "Assessment not found." }, cors);

  const { data: txRow } = await admin
    .from("assessment_transcriptions")
    .select("transcript")
    .eq("assessment_id", assessmentId)
    .maybeSingle();
  const transcript = (txRow as { transcript: string | null } | null)?.transcript?.trim() ?? "";
  if (!transcript) {
    return json(409, { error: "This assessment has no transcript yet.", code: "no_transcript" }, cors);
  }

  // Extract every section against the transcript (bounded concurrency).
  const results = await mapPool(sections, CONCURRENCY, (s) => extractSection(s, transcript));

  const inputTokens = results.reduce((n, r) => n + r.inputTokens, 0);
  const outputTokens = results.reduce((n, r) => n + r.outputTokens, 0);
  const costUsd = Math.round(
    ((inputTokens * CLAUDE_INPUT_PER_M / 1_000_000) + (outputTokens * CLAUDE_OUTPUT_PER_M / 1_000_000)) * 10000,
  ) / 10000;

  // Fire-and-forget audit event.
  admin.from("events").insert({
    event_type: "care_plan_drafted_from_assessment",
    entity_type: assessment.client_id ? "client" : null,
    entity_id: assessment.client_id ?? null,
    actor: userEmail ? `user:${userEmail}` : "system:ai",
    payload: {
      assessment_id: assessmentId,
      transcriptChars: transcript.length,
      sections: results.map((r) => ({
        sectionId: r.sectionId, ok: r.ok,
        fields: r.extracted.length, tasks: r.proposedTasks.length,
      })),
      model: CLAUDE_MODEL,
      costUsd,
    },
  }).then(({ error }: { error: { message: string } | null }) => {
    if (error) console.warn("[assessment-extract-care-plan] event log failed:", error.message);
  });

  return json(200, {
    assessment_id: assessmentId,
    transcriptChars: transcript.length,
    model: CLAUDE_MODEL,
    sections: results.map((r) => ({
      sectionId: r.sectionId,
      ok: r.ok,
      error: r.error,
      extracted: r.extracted,
      rejected: r.rejected,
      proposedTasks: r.proposedTasks,
      rejectedTasks: r.rejectedTasks,
    })),
    usage: { inputTokens, outputTokens },
    costUsd,
  }, cors);
});
