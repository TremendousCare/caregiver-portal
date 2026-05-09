// bd-extract-card — Phase 2 PR #10.
//
// Receives a single business-card photo (multipart/form-data with a
// `file` field, or a raw image body) from the BD portal's "Add
// Contact" flow. Forwards to Claude Vision, asks it to extract the
// structured contact fields the bd_account_contacts schema expects,
// and returns the result. The frontend renders the extracted fields
// in an editable form so the rep can spot-check before saving.
//
// Image is NOT persisted — we transcribe-and-discard like
// bd-transcribe does for voice memos. The extracted JSON is the
// only thing that lives on, in bd_account_contacts.
//
// Auth: Bearer token (service role or any JWT-shaped token) keeps
// random callers off the Anthropic bill.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY         = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Vision-capable model. Sonnet 4.6 is plenty for structured
// extraction off a card; Opus 4.7 is overkill at the price.
const CLAUDE_MODEL  = "claude-sonnet-4-6";
const CLAUDE_TOKENS = 600;

// Generous cap that still bounds cost. A typical iPhone photo is
// ~1-3 MB after compression; 8 MB lets a high-res shot through.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requireAuth(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return json(401, { error: "Bearer token required" });
  const token = match[1];
  if (token === SUPABASE_SERVICE_ROLE_KEY) return null;
  if (JWT_SHAPE.test(token)) return null;
  return json(401, { error: "Invalid token shape" });
}

// Roles must come back as one of the bd_account_contacts.role
// CHECK domain values (or null). Listed verbatim in the prompt
// so Claude doesn't invent new categories.
const ROLE_DOMAIN = [
  "discharge_planner",
  "case_manager",
  "social_worker",
  "admissions",
  "ed_director",
  "administrator",
  "principal",
  "physician",
  "gcm",
  "attorney",
  "financial_planner",
  "office_manager",
  "other",
];

const SYSTEM_PROMPT =
  "You are extracting contact details from a business card photo for " +
  "a home-care business-development CRM. The cards usually belong to " +
  "discharge planners, case managers, social workers, hospital admissions, " +
  "ALF/SNF administrators, geriatric care managers, elder-law attorneys, " +
  "financial planners, or physicians. " +
  "Read carefully. If a field is not present on the card, return null — " +
  "do not guess or hallucinate. " +
  "Map the person's job title to ONE of these role buckets: " +
  ROLE_DOMAIN.join(", ") +
  ". If no bucket clearly fits, return 'other'. " +
  "If the card is not a business card (random photo, blurry, blank), " +
  "return ok=false with a short reason. " +
  "Reply with JSON ONLY, no prose, matching the schema in the user message.";

const USER_INSTRUCTION =
  "Extract the contact from this card and return JSON matching this schema EXACTLY:\n" +
  "{\n" +
  '  "ok": boolean,\n' +
  '  "reason": string | null,        // populated only when ok=false\n' +
  '  "name": string | null,\n' +
  '  "title": string | null,         // verbatim job title from the card\n' +
  '  "role": string | null,          // one of the role bucket values, or null\n' +
  '  "email": string | null,\n' +
  '  "phone_mobile": string | null,  // formatted as printed\n' +
  '  "phone_office": string | null,\n' +
  '  "organization_name": string | null\n' +
  "}\n" +
  "Return only the JSON object, with no surrounding markdown or commentary.";

// Strips Markdown code fences ```json ... ``` if Claude wraps the
// JSON despite the instruction. Returns the raw inner string.
function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*\n/, "")
      .replace(/\n```\s*$/, "")
      .trim();
  }
  return trimmed;
}

interface ExtractedContact {
  ok: boolean;
  reason: string | null;
  name: string | null;
  title: string | null;
  role: string | null;
  email: string | null;
  phone_mobile: string | null;
  phone_office: string | null;
  organization_name: string | null;
}

function normalizeExtracted(raw: Record<string, unknown>): ExtractedContact {
  const out: ExtractedContact = {
    ok:                Boolean(raw.ok ?? raw.name ?? false),
    reason:            (raw.reason as string | null) ?? null,
    name:              (raw.name as string | null) ?? null,
    title:             (raw.title as string | null) ?? null,
    role:              null,
    email:             (raw.email as string | null) ?? null,
    phone_mobile:      (raw.phone_mobile as string | null) ?? null,
    phone_office:      (raw.phone_office as string | null) ?? null,
    organization_name: (raw.organization_name as string | null) ?? null,
  };
  // Coerce role to a CHECK-domain value or null. Defensive against
  // Claude returning a label like "Other" or "case_manager " that
  // Postgres would reject.
  if (typeof raw.role === "string") {
    const candidate = raw.role.trim().toLowerCase();
    if (ROLE_DOMAIN.includes(candidate)) out.role = candidate;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  const authError = requireAuth(req);
  if (authError) return authError;

  if (!ANTHROPIC_API_KEY) {
    return json(500, { error: "ANTHROPIC_API_KEY not configured on this project" });
  }

  // Pull the image bytes + mime type. Accept multipart (frontend
  // path) or a raw body (curl-friendly).
  const contentType = req.headers.get("content-type") ?? "";
  let imageBytes: Uint8Array;
  let mediaType  = "image/jpeg";

  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (e) {
      return json(400, { error: `Could not parse multipart body: ${(e as Error).message}` });
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return json(400, { error: "Missing 'file' field in multipart body" });
    }
    imageBytes = new Uint8Array(await file.arrayBuffer());
    if (file.type) mediaType = file.type;
  } else if (contentType.startsWith("image/") || contentType === "application/octet-stream") {
    imageBytes = new Uint8Array(await req.arrayBuffer());
    if (contentType.startsWith("image/")) mediaType = contentType;
  } else {
    return json(415, { error: `Unsupported content-type: ${contentType || "<empty>"}` });
  }

  if (imageBytes.byteLength === 0) {
    return json(400, { error: "Image body is empty" });
  }
  if (imageBytes.byteLength > MAX_IMAGE_BYTES) {
    return json(413, {
      error: `Image too large (${imageBytes.byteLength} bytes; max ${MAX_IMAGE_BYTES})`,
    });
  }
  if (!ALLOWED_MEDIA.includes(mediaType)) {
    return json(415, { error: `Unsupported image type: ${mediaType}` });
  }

  // Anthropic API base64-encodes images inline. base64 inflates ~33%
  // so we're well under the API's per-request limit.
  const base64 = btoa(String.fromCharCode(...imageBytes));

  const requestBody = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text",  text: USER_INSTRUCTION },
      ],
    }],
  };

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    return json(502, { error: `Claude unreachable: ${(e as Error).message}` });
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(`[bd-extract-card] Claude ${resp.status}:`, body.slice(0, 500));
    return json(resp.status === 429 ? 429 : 502, {
      error: `Claude returned ${resp.status}`,
      detail: body.slice(0, 300),
    });
  }

  let payload: { content?: Array<{ type?: string; text?: string }> };
  try {
    payload = await resp.json();
  } catch (e) {
    return json(502, { error: `Claude returned non-JSON: ${(e as Error).message}` });
  }

  const textBlock = (payload.content ?? []).find((b) => b.type === "text");
  const rawText   = (textBlock?.text ?? "").trim();
  if (!rawText) {
    return json(502, { error: "Claude returned an empty response." });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFences(rawText));
  } catch (e) {
    console.error(`[bd-extract-card] JSON parse failed:`, rawText.slice(0, 300));
    return json(502, {
      error: `Could not parse Claude's response: ${(e as Error).message}`,
      raw: rawText.slice(0, 300),
    });
  }

  const contact = normalizeExtracted(parsed);

  if (!contact.ok && !contact.name) {
    return json(200, {
      ok: false,
      reason: contact.reason ?? "Could not read the card. Try retaking the photo with better lighting.",
    });
  }

  return json(200, {
    ok: true,
    contact,
    bytes: imageBytes.byteLength,
  });
});
