// ─── parse-resume-pdf ─────────────────────────────────────────
// Accepts a single resume PDF (base64) and returns structured fields
// extracted by Claude. Designed for the bulk PDF import flow used by
// the mycnajobs.com resume import on the Caregivers Dashboard.
//
// Request:
//   { pdf_base64: string, file_name: string, source?: string }
// Response:
//   { extracted: ExtractedResume, model: string, ms: number }
//   on error: { error: string, detail?: string }
//
// The function is stateless — it does not write to the database. The
// caller (frontend modal) is responsible for dedup, preview/editing,
// and calling the existing addCaregiver path on import.
//
// TODO(phase-c): replace the single-tenant ANTHROPIC_API_KEY env var
// with a per-org lookup once Phase C lands. The ai-chat function uses
// the same single-tenant key today; both will migrate together.
// See docs/SAAS_RETROFIT_STATUS.md → Phase C.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

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

function jsonResponse(status: number, body: Record<string, unknown>, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ─── Extraction schema ───
// The shape the caller (mycnaResumeParser.js) maps into caregiverData.
// Field names match the visible labels on a mycnajobs PDF where possible,
// with a few additions (firstName/lastName splits, normalized phone) that
// make the frontend mapping cleaner.
type Certification = {
  type: string;            // "CHHA", "CNA", "HHA", etc.
  attended: string;        // School / institution
  date: string;            // Cert date as printed (e.g. "6/21/2022")
  licenseNumber: string;   // License # as printed
};

type ExtractedResume = {
  firstName: string;
  lastName: string;
  city: string;
  state: string;            // 2-letter US abbreviation when possible
  zipCode: string;
  phone: string;            // Raw as printed; frontend normalizes
  email: string;
  yearsExperience: number | null;
  lastEmployer: string;
  willingToTravelMiles: number | null;
  canLegallyDrive: boolean;
  availability: string[];   // ["Full-Time", "Day Shift", ...]
  certifications: Certification[];
  specializations: string[]; // ["Alzheimers / Dementia", ...]
  whyHireMe: string;
  whyCaregiver: string;
};

const EXTRACTION_SYSTEM_PROMPT = `You are a precise resume parser for a home-care recruiting team.

You will be given a single resume PDF, typically downloaded from mycnajobs.com (a job board for CNAs and home health aides). Your job is to extract structured fields into a JSON object that matches the schema below exactly.

# Critical rules
- Output ONLY a single JSON object. No prose, no markdown fences, no commentary.
- If a field is not present on the resume, return an empty string "" for strings, null for numbers, false for booleans, and [] for arrays. Never invent data.
- Ignore mycnajobs.com page chrome: the mycnajobs.com logo, "RESUME SNAPSHOT" watermark, and any site-branding icons in headers/footers. Extract only the candidate's own content.
- Phone: return as printed by the candidate (e.g. "(714) 412-9788"). The caller will normalize.
- State: prefer the 2-letter US abbreviation (e.g. "CA" for "California"). If the resume only shows the full name, you may return the full name.
- yearsExperience: parse a number from phrases like "10 Years" → 10. If a range like "5–10 Years" is given, take the higher end. If absent, null.
- willingToTravelMiles: parse a number from "10 miles" → 10. If absent, null.
- canLegallyDrive: true if the resume shows a "Can Legally Drive" indicator or similar; false otherwise.
- availability: collect every chip/tag listed under Availability (e.g. "Full-Time", "Part-Time", "Day Shift", "Night Shift", "Weekdays", "Weekends"). Preserve the resume's exact wording.
- certifications: each entry should include type (e.g. "CHHA", "CNA", "HHA"), attended (school/institution), date (as printed), licenseNumber. Multiple certifications go in the array. Empty strings if a sub-field is missing.
- specializations: collect every chip/tag listed under Specializations (e.g. "Alzheimers / Dementia", "Hospice Patients", "CPR Certification"). Preserve the resume's exact wording. Do NOT invent or normalize.
- whyHireMe: the candidate's free-text "Why Hire Me?" pitch, verbatim. Empty string if absent.
- whyCaregiver: the candidate's free-text "Why I Want To Be A Caregiver" answer, verbatim. Empty string if absent.

# JSON schema (output exactly this shape)
{
  "firstName": string,
  "lastName": string,
  "city": string,
  "state": string,
  "zipCode": string,
  "phone": string,
  "email": string,
  "yearsExperience": number | null,
  "lastEmployer": string,
  "willingToTravelMiles": number | null,
  "canLegallyDrive": boolean,
  "availability": string[],
  "certifications": [
    { "type": string, "attended": string, "date": string, "licenseNumber": string }
  ],
  "specializations": string[],
  "whyHireMe": string,
  "whyCaregiver": string
}`;

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_MAX_TOKENS = 2048;
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function isLikelyPdfBase64(pdfBase64: string): boolean {
  // PDF magic bytes "%PDF" → base64 prefix "JVBER"
  return typeof pdfBase64 === "string" && pdfBase64.startsWith("JVBER");
}

function estimateBytesFromBase64(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

async function extractWithClaude(pdfBase64: string): Promise<ExtractedResume> {
  const requestBody = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: EXTRACTION_SYSTEM_PROMPT,
        // Cache the long instructions across the parallel batch of resumes —
        // first call pays full price, subsequent calls in the same import
        // batch hit the cached prefix.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64,
            },
          },
          {
            type: "text",
            text: "Extract the resume into the JSON schema. Return ONLY the JSON object.",
          },
        ],
      },
    ],
  };

  const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`claude_${resp.status}: ${errBody.slice(0, 400)}`);
  }

  const payload = await resp.json();

  let rawText = "";
  for (const block of payload.content || []) {
    if (block.type === "text" && typeof block.text === "string") {
      rawText += block.text;
    }
  }

  if (!rawText.trim()) {
    throw new Error("claude_empty_response");
  }

  // Tolerate the model wrapping output in ```json fences even though we
  // told it not to — strip them defensively rather than erroring.
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: ExtractedResume;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`json_parse_error: ${msg} | head=${cleaned.slice(0, 200)}`);
  }

  return parsed;
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, cors);
  }

  if (!ANTHROPIC_API_KEY) {
    console.error("[parse-resume-pdf] missing ANTHROPIC_API_KEY env var");
    return jsonResponse(500, { error: "Server misconfigured: missing Anthropic key" }, cors);
  }

  let body: { pdf_base64?: string; file_name?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" }, cors);
  }

  const pdfBase64 = body.pdf_base64;
  const fileName = body.file_name || "resume.pdf";

  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    return jsonResponse(400, { error: "Missing pdf_base64" }, cors);
  }
  if (!isLikelyPdfBase64(pdfBase64)) {
    return jsonResponse(400, { error: "File does not appear to be a PDF" }, cors);
  }
  const bytes = estimateBytesFromBase64(pdfBase64);
  if (bytes > MAX_PDF_SIZE_BYTES) {
    return jsonResponse(413, {
      error: `PDF too large (${(bytes / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_PDF_SIZE_BYTES / 1024 / 1024} MB.`,
    }, cors);
  }

  const start = Date.now();
  try {
    const extracted = await extractWithClaude(pdfBase64);
    const ms = Date.now() - start;
    console.log(`[parse-resume-pdf] ok file=${fileName} bytes=${bytes} ms=${ms}`);
    return jsonResponse(200, { extracted, model: CLAUDE_MODEL, ms }, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[parse-resume-pdf] fail file=${fileName} err=${msg}`);
    // 502 — Claude (or our parsing of its output) failed.
    return jsonResponse(502, { error: "Resume extraction failed", detail: msg }, cors);
  }
});
