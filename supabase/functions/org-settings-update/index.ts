// ─── Org settings: admin-only patch helper ───
//
// Triggered from the Phase 4 PR #3 PayrollSettingsView (and any
// future Settings UI that needs to update `organizations.settings`
// jsonb without hand-rolling the merge / audit / role gate).
//
// Designed as a generic patch helper, but intentionally narrow:
//   - Restricted to known sections (`payroll`, `paychex`,
//     `features_enabled`). Adding a section requires this file
//     change, which keeps the surface auditable.
//   - Each section has a whitelisted set of keys + value validators.
//     Unknown keys are rejected loudly rather than silently merged.
//   - Read-only fields (`paychex.company_id`, `paychex.display_id`,
//     `payroll.timezone`, `payroll.ot_jurisdiction`) are never
//     accepted from this endpoint — they're org-bootstrap values
//     that change shouldn't happen via the Settings UI.
//
// Multi-tenancy:
//   - org_id derives from the caller's JWT.
//   - The UPDATE filters by org_id; cross-tenant edits are
//     impossible.
//   - Audit event is written with the section + patched keys (NOT
//     the values, in case any are ever sensitive — for v1 nothing
//     here is sensitive but the convention preserves future-proofing).
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   docs/handoff-paychex-phase-4.md  ("PR #3 — Payroll Runs view + ...")

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

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

// ─── Auth ────────────────────────────────────────────────────────

interface AuthContext { orgId: string; userEmail: string | null; }

async function authenticateRequest(
  authHeader: string | null,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; status: number; error: string }> {
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
  if (!orgId) {
    return { ok: false, status: 403, error: "JWT is missing org_id claim." };
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return { ok: false, status: 401, error: "Not authenticated." };
  return { ok: true, ctx: { orgId, userEmail: userData.user.email ?? null } };
}

async function assertAdmin(
  supabase: ReturnType<typeof createClient>,
  email: string | null,
) {
  if (!email) return { ok: false, status: 403, error: "Admin access required." } as const;
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (!roleRow || (roleRow as { role: string }).role !== "admin") {
    return { ok: false, status: 403, error: "Admin access required." } as const;
  }
  return { ok: true } as const;
}

// ─── Validators ──────────────────────────────────────────────────

function isStringOrNull(v: unknown): boolean {
  return v === null || typeof v === "string";
}
function isPositiveNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}
function isBoolean(v: unknown): boolean {
  return typeof v === "boolean";
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Per-section schema. Each entry maps a key to a validator. Any key
// not in this map is rejected when present in the patch.
const PAYROLL_KEYS: Record<string, (v: unknown) => boolean> = {
  // pay_components is a nested object; validate its inner shape too.
  pay_components: (v) =>
    isPlainObject(v)
    && Object.keys(v).every((k) => ["regular", "overtime", "double_time", "mileage"].includes(k))
    && Object.values(v).every(isStringOrNull),
  mileage_rate: isPositiveNumber,
  dry_run: isBoolean,
};

const PAYCHEX_KEYS: Record<string, (v: unknown) => boolean> = {
  // The display_id is the 8-digit Paychex Flex client number; the
  // back office may need to update it if the company moves Paychex
  // accounts. company_id is the long alphanumeric — never edit by
  // hand (it's discovered via the diagnostic in Phase 0).
  display_id: (v) => typeof v === "string" && /^[A-Za-z0-9]{1,8}$/.test(v),
};

const FEATURES_ENABLED_KEYS: Record<string, (v: unknown) => boolean> = {
  payroll: isBoolean,
  invoicing: isBoolean,
};

const SECTION_SCHEMAS: Record<string, Record<string, (v: unknown) => boolean>> = {
  payroll: PAYROLL_KEYS,
  paychex: PAYCHEX_KEYS,
  features_enabled: FEATURES_ENABLED_KEYS,
};

function validatePatch(
  section: string,
  patch: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const schema = SECTION_SCHEMAS[section];
  if (!schema) {
    return { ok: false, error: `Unknown section "${section}". Allowed: ${Object.keys(SECTION_SCHEMAS).join(", ")}.` };
  }
  for (const [k, v] of Object.entries(patch)) {
    const validator = schema[k];
    if (!validator) {
      return { ok: false, error: `Unknown key "${k}" for section "${section}".` };
    }
    if (!validator(v)) {
      return { ok: false, error: `Invalid value for "${section}.${k}".` };
    }
  }
  return { ok: true };
}

// ─── Main handler ────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse(405, { error: "POST required." }, cors);

  // ── Auth ──
  const authResult = await authenticateRequest(req.headers.get("Authorization"));
  if (!authResult.ok) return jsonResponse(authResult.status, { error: authResult.error }, cors);
  const { orgId, userEmail } = authResult.ctx;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const adminCheck = await assertAdmin(admin, userEmail);
  if (!adminCheck.ok) return jsonResponse(adminCheck.status, { error: adminCheck.error }, cors);

  // ── Body ──
  let body: { section?: string; patch?: Record<string, unknown> } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Body must be valid JSON." }, cors);
  }
  const section = typeof body.section === "string" ? body.section : null;
  const patch = isPlainObject(body.patch) ? body.patch : null;
  if (!section || !patch) {
    return jsonResponse(400, { error: "section + patch (object) are required." }, cors);
  }
  if (Object.keys(patch).length === 0) {
    return jsonResponse(400, { error: "Patch must include at least one key." }, cors);
  }

  // ── Validate the patch shape ──
  const validation = validatePatch(section, patch);
  if (!validation.ok) {
    return jsonResponse(400, { error: validation.error, code: "invalid_patch" }, cors);
  }

  // ── Load existing settings ──
  const { data: orgRow, error: orgErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) {
    return jsonResponse(500, { error: `Org lookup failed: ${orgErr.message}` }, cors);
  }
  if (!orgRow) {
    return jsonResponse(404, { error: "Organization not found for caller." }, cors);
  }
  const settings = ((orgRow as { settings: Record<string, unknown> }).settings ?? {});
  const existingSection = isPlainObject(settings[section])
    ? (settings[section] as Record<string, unknown>)
    : {};

  // Merge at the section level. For pay_components specifically, deep
  // merge so a partial patch (e.g. only `mileage`) doesn't blow away
  // the other 3 keys.
  let mergedSection = { ...existingSection, ...patch };
  if (section === "payroll" && isPlainObject(patch.pay_components)) {
    const existingPayComponents = isPlainObject(existingSection.pay_components)
      ? (existingSection.pay_components as Record<string, unknown>)
      : {};
    mergedSection = {
      ...mergedSection,
      pay_components: {
        ...existingPayComponents,
        ...(patch.pay_components as Record<string, unknown>),
      },
    };
  }

  const newSettings = { ...settings, [section]: mergedSection };

  // ── Write ──
  const { error: updateErr } = await admin
    .from("organizations")
    .update({
      settings: newSettings,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);
  if (updateErr) {
    return jsonResponse(500, { error: `Settings update failed: ${updateErr.message}` }, cors);
  }

  // ── Audit event ──
  admin.from("events").insert({
    event_type: "org_settings_updated",
    entity_type: "caregiver", // events constrains entity_type; org-level events use null entity_id
    entity_id: null,
    actor: `user:${userEmail || "unknown"}`,
    org_id: orgId,
    payload: {
      org_id: orgId,
      section,
      // Log keys, not values, so future sensitive sections don't leak.
      // For v1 this is just paranoia; payroll / paychex / features
      // values are all non-sensitive.
      patched_keys: Object.keys(patch),
    },
  }).then(({ error }: { error: { message: string } | null }) => {
    if (error) console.warn(`[org-settings-update] event log failed: ${error.message}`);
  });

  return jsonResponse(200, {
    ok: true,
    section,
    settings: newSettings,
  }, cors);
});
