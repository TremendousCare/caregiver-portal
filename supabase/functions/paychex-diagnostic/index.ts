// ─── Paychex Diagnostic ───
//
// Phase 0 of the Paychex Flex integration. One-shot read-only edge
// function the owner triggers manually from the Supabase Dashboard
// (Functions → paychex-diagnostic → Invoke) to:
//
//   1. Confirm PAYCHEX_CLIENT_ID / PAYCHEX_CLIENT_SECRET work against
//      Paychex's OAuth2 client_credentials flow and report the granted
//      scope (so we know exactly what the credentials can do today).
//   2. Resolve Tremendous Care's 8-digit Flex display ID (70125496) to
//      the long alphanumeric companyId that every subsequent Paychex
//      API call needs (the value goes into the Phase 1 seed migration
//      at organizations.settings.paychex.company_id).
//   3. Fetch a small (limit 5) sample of workers via the nonpii media
//      type so we can inspect the shape Paychex returns — without
//      pulling SSNs into the response or any logs.
//
// NO write endpoints are called. NO DB tables are touched. NO schema
// changes accompany this function. It exists to surface access issues
// before any dependent code is written, then to be deleted once the
// values it discovers are committed to the seed migration.
//
// Hardcoding displayid=70125496 is acceptable ONLY in this Phase 0
// throwaway: the entire point of running it is to bootstrap the value
// that moves into organizations.settings.paychex.{display_id, company_id}
// in Phase 1. After Phase 1 ships, this function should be deleted.
//
// Output: structured JSON with scope, companyId, total worker count,
// sample worker shape, status codes, and per-call durations. Safe to
// paste back to Claude — no secrets included.
//
// Invocation requires three Edge Function secrets:
//   - PAYCHEX_CLIENT_ID, PAYCHEX_CLIENT_SECRET (the partner-level
//     Paychex OAuth credentials)
//   - PAYCHEX_DIAGNOSTIC_TOKEN (any long random string; pass it as
//     the X-Diagnostic-Token request header). Without this gate the
//     anon key alone could scrape Paychex company metadata + a
//     5-worker nonpii sample because the function is deployed with
//     --no-verify-jwt.
//
// See: docs/plans/2026-04-25-paychex-integration-plan.md (Phase 0).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const PAYCHEX_CLIENT_ID = Deno.env.get("PAYCHEX_CLIENT_ID");
const PAYCHEX_CLIENT_SECRET = Deno.env.get("PAYCHEX_CLIENT_SECRET");
// Shared-secret gate: the function is deployed with --no-verify-jwt
// (see .github/workflows/deploy-edge-functions.yml) so without this
// gate anyone with the public anon key could scrape Paychex company
// metadata + a 5-worker nonpii sample. Set PAYCHEX_DIAGNOSTIC_TOKEN
// to a long random value in Supabase Edge Function secrets, then
// pass it as the X-Diagnostic-Token request header when invoking
// from the Supabase Functions UI.
const PAYCHEX_DIAGNOSTIC_TOKEN = Deno.env.get("PAYCHEX_DIAGNOSTIC_TOKEN");

const PAYCHEX_BASE = "https://api.paychex.com";
const TC_DISPLAY_ID = "70125496";

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
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

type CallReport = {
  label: string;
  method: string;
  endpoint: string;
  status: number | null;
  durationMs: number;
  ok: boolean;
  error?: string;
};

async function timedFetch(
  label: string,
  method: string,
  url: string,
  init: RequestInit,
): Promise<{ report: CallReport; bodyText: string; bodyJson: unknown }> {
  const started = performance.now();
  let status: number | null = null;
  let bodyText = "";
  let bodyJson: unknown = null;
  let error: string | undefined;
  try {
    const res = await fetch(url, { ...init, method });
    status = res.status;
    bodyText = await res.text();
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = null;
      }
    }
    if (!res.ok) {
      error = `HTTP ${res.status}`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Math.round(performance.now() - started);
  return {
    report: {
      label,
      method,
      endpoint: url,
      status,
      durationMs,
      ok: status !== null && status >= 200 && status < 300,
      ...(error ? { error } : {}),
    },
    bodyText,
    bodyJson,
  };
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed; use POST" }, cors);
  }

  if (!PAYCHEX_CLIENT_ID || !PAYCHEX_CLIENT_SECRET) {
    return jsonResponse(500, {
      error: "PAYCHEX_CLIENT_ID and PAYCHEX_CLIENT_SECRET must be set in Supabase Edge Function secrets",
    }, cors);
  }

  if (!PAYCHEX_DIAGNOSTIC_TOKEN) {
    return jsonResponse(500, {
      error: "PAYCHEX_DIAGNOSTIC_TOKEN must be set in Supabase Edge Function secrets to invoke this diagnostic",
    }, cors);
  }
  const providedToken = req.headers.get("x-diagnostic-token") || "";
  if (providedToken !== PAYCHEX_DIAGNOSTIC_TOKEN) {
    return jsonResponse(401, {
      error: "missing or invalid X-Diagnostic-Token header",
    }, cors);
  }

  const calls: CallReport[] = [];

  // ─── 1. OAuth2 client_credentials → access token + scope ───
  const tokenForm = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: PAYCHEX_CLIENT_ID,
    client_secret: PAYCHEX_CLIENT_SECRET,
  });
  const tokenResult = await timedFetch(
    "oauth_token",
    "POST",
    `${PAYCHEX_BASE}/auth/oauth/v2/token`,
    {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenForm.toString(),
    },
  );
  calls.push(tokenResult.report);

  if (!tokenResult.report.ok) {
    return jsonResponse(200, {
      summary: {
        ok: false,
        stoppedAt: "oauth_token",
        message: "OAuth token request failed; cannot proceed to companies/workers calls",
      },
      calls,
      tokenResponseBody: tokenResult.bodyJson ?? tokenResult.bodyText.slice(0, 1000),
    }, cors);
  }

  const tokenJson = tokenResult.bodyJson as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  } | null;
  const accessToken = tokenJson?.access_token;
  if (!accessToken) {
    return jsonResponse(200, {
      summary: {
        ok: false,
        stoppedAt: "oauth_token",
        message: "OAuth response did not include access_token",
      },
      calls,
      tokenResponseBody: tokenJson,
    }, cors);
  }

  const tokenMeta = {
    scope: tokenJson?.scope ?? null,
    token_type: tokenJson?.token_type ?? null,
    expires_in: tokenJson?.expires_in ?? null,
  };

  // ─── 2. GET /companies?displayid=70125496 → companyId ───
  const companiesResult = await timedFetch(
    "companies_lookup",
    "GET",
    `${PAYCHEX_BASE}/companies?displayid=${encodeURIComponent(TC_DISPLAY_ID)}`,
    {
      headers: {
        "Accept": "application/vnd.paychex.companies.v1+json",
        "Authorization": `Bearer ${accessToken}`,
      },
    },
  );
  calls.push(companiesResult.report);

  if (!companiesResult.report.ok) {
    return jsonResponse(200, {
      summary: {
        ok: false,
        stoppedAt: "companies_lookup",
        message: `Companies lookup failed for displayid=${TC_DISPLAY_ID}`,
        scope: tokenMeta.scope,
      },
      calls,
      tokenMeta,
      companiesResponseBody: companiesResult.bodyJson ?? companiesResult.bodyText.slice(0, 1000),
    }, cors);
  }

  const companiesBody = companiesResult.bodyJson as {
    content?: Array<{ companyId?: string; displayId?: string; legalName?: string }>;
  } | null;
  const companyEntry = companiesBody?.content?.[0];
  const companyId = companyEntry?.companyId;
  if (!companyId) {
    return jsonResponse(200, {
      summary: {
        ok: false,
        stoppedAt: "companies_lookup",
        message: `No companyId found for displayid=${TC_DISPLAY_ID}; check the response shape`,
        scope: tokenMeta.scope,
      },
      calls,
      tokenMeta,
      companiesResponseBody: companiesBody,
    }, cors);
  }

  // ─── 3. GET /companies/{companyId}/workers?offset=0&limit=5 (nonpii) ───
  const workersResult = await timedFetch(
    "workers_sample",
    "GET",
    `${PAYCHEX_BASE}/companies/${encodeURIComponent(companyId)}/workers?offset=0&limit=5`,
    {
      headers: {
        "Accept": "application/vnd.paychex.workers.nonpii.v1+json",
        "Authorization": `Bearer ${accessToken}`,
      },
    },
  );
  calls.push(workersResult.report);

  if (!workersResult.report.ok) {
    return jsonResponse(200, {
      summary: {
        ok: false,
        stoppedAt: "workers_sample",
        message: "Workers sample call failed; companyId was discovered successfully but worker scope or read access is missing",
        scope: tokenMeta.scope,
        displayId: TC_DISPLAY_ID,
        companyId,
        companyLegalName: companyEntry?.legalName ?? null,
      },
      calls,
      tokenMeta,
      workersResponseBody: workersResult.bodyJson ?? workersResult.bodyText.slice(0, 1000),
    }, cors);
  }

  const workersBody = workersResult.bodyJson as {
    metadata?: { pagination?: { total?: number; offset?: number; limit?: number } };
    content?: unknown[];
  } | null;
  const totalWorkers = workersBody?.metadata?.pagination?.total ?? null;
  const sampleWorkers = Array.isArray(workersBody?.content)
    ? workersBody!.content!.slice(0, 5)
    : [];

  return jsonResponse(200, {
    summary: {
      ok: true,
      scope: tokenMeta.scope,
      displayId: TC_DISPLAY_ID,
      companyId,
      companyLegalName: companyEntry?.legalName ?? null,
      totalWorkers,
      sampleWorkerCount: sampleWorkers.length,
      ranAt: new Date().toISOString(),
    },
    calls,
    tokenMeta,
    companies: companiesBody,
    workersSample: {
      total: totalWorkers,
      pagination: workersBody?.metadata?.pagination ?? null,
      sample: sampleWorkers,
    },
  }, cors);
});
