// ─── Paychex API client (shared) ───
//
// Single OAuth2 client used by every Paychex edge function. Keeps the
// auth/retry/idempotency/logging concerns in one place so individual
// functions (paychex-sync-worker, future payroll-submit-run, etc.)
// stay focused on their business logic.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   ("Paychex API client" + "Cross-cutting reliability practices").
//
// Responsibilities (keep this list in sync with the plan):
//   1. OAuth2 token acquisition + caching (5-minute pre-expiry refresh).
//   2. Vendor media types per call. No request leaves without one.
//   3. POST/PATCH path asymmetry encoded once.
//   4. Idempotency keys on every write.
//   5. Retry with exponential backoff on 5xx + network errors only.
//      4xx never retries. 423 is a hard non-retriable fail and the
//      caller MUST NOT persist any workerId from the 423 response.
//   6. Persist every call (incl. dry-run) to paychex_api_log.
//   7. PAYCHEX_DRY_RUN env flag — write calls log dry_run=true and
//      return synthetic success without contacting Paychex.
//
// What the caller (e.g. paychex-sync-worker) is responsible for:
//   - Deriving org_id from the request JWT (or other authoritative
//     source). We deliberately do NOT pull org_id from the JWT here:
//     this client is also imported by future cron jobs that iterate
//     orgs without a request JWT, so org_id must arrive as an
//     explicit parameter.
//   - Persisting business state (caregivers.paychex_worker_id, sync
//     status fields) on success/failure.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Configuration ─────────────────────────────────────────────────

export const PAYCHEX_API_BASE = "https://api.paychex.com";
const TOKEN_PATH = "/auth/oauth/v2/token";

// Refresh tokens 5 minutes before expiry to avoid mid-request 401s.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Retry policy — 5xx + network errors only. 4xx never retries.
const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

// 423 Locked is a hard non-retriable fail. Paychex docs warn that the
// response may include a workerId that is invalid; callers must drop it
// on the floor and surface a structured `client_account_locked` error.
const HARD_FAIL_STATUS = 423;

// ─── Module-scope token cache ──────────────────────────────────────
//
// Decision: in-memory module-scope cache (NOT Deno KV).
//
// Trade-offs considered:
//   - Deno KV: persists across function invocations within an
//     instance and survives soft restarts. Adds a roundtrip per
//     request and forces a non-trivial key-schema decision.
//   - Module-scope: zero extra I/O. Survives within a warm function
//     instance for the lifetime of that instance — Supabase Edge
//     Functions reuse instances aggressively, so a single sync run
//     across many caregivers will hit the cache reliably. Cold
//     starts grab a fresh token, which is cheap (~150ms) and
//     happens at most a few times per hour even with bursty traffic.
//
// Module-scope wins on simplicity. If we ever observe rate-limit
// pressure from too-frequent token requests, swap in Deno KV behind
// the same getAccessToken() interface — no caller changes needed.
//
// The cache is keyed by client_id so that hypothetical future
// per-org credential rotation doesn't accidentally serve a stale
// token from a different credential set. Today there's only one
// partner credential pair so the map has at most one entry.

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

// ─── Public types ──────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PATCH";

export interface PaychexClientContext {
  /** Service-role Supabase client used to write to paychex_api_log. */
  supabase: SupabaseClient;
  /** Caller-derived org_id; required for every log row. */
  orgId: string;
}

export interface PaychexCallOptions {
  /** Path under api.paychex.com, beginning with `/`. */
  path: string;
  /** "GET" | "POST" | "PATCH". */
  method: HttpMethod;
  /** Vendor-specific Accept media type. Required (no fallback). */
  mediaType: string;
  /**
   * Idempotency key. Required for POST/PATCH. The Paychex API uses
   * this to dedupe retries. Use a stable hash for sync calls and
   * the payroll_runs.id for submission calls.
   */
  idempotencyKey?: string;
  /** Request body (will be JSON.stringified). Optional for GETs. */
  body?: unknown;
}

export interface PaychexCallResult {
  status: number;
  /** Parsed JSON body, or null if the response was empty / non-JSON. */
  body: unknown;
  /** True iff the call was intercepted by PAYCHEX_DRY_RUN. */
  dryRun: boolean;
  /** Total wall-clock duration in ms (incl. retries). */
  durationMs: number;
}

export interface PaychexErrorShape {
  code:
    | "client_account_locked"  // 423
    | "client_error"           // other 4xx
    | "server_error"           // exhausted 5xx retries
    | "network_error"          // exhausted network-error retries
    | "config_error";          // missing env / invalid call
  status: number | null;
  message: string;
  /** Last response body, if any. */
  responseBody?: unknown;
}

/**
 * Custom error class so callers can pattern-match on `.code` without
 * parsing free-form messages.
 */
export class PaychexError extends Error {
  readonly code: PaychexErrorShape["code"];
  readonly status: number | null;
  readonly responseBody: unknown;

  constructor(shape: PaychexErrorShape) {
    super(shape.message);
    this.name = "PaychexError";
    this.code = shape.code;
    this.status = shape.status;
    this.responseBody = shape.responseBody;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function isDryRun(): boolean {
  const v = Deno.env.get("PAYCHEX_DRY_RUN");
  if (!v) return false;
  const lower = v.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get("PAYCHEX_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYCHEX_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new PaychexError({
      code: "config_error",
      status: null,
      message:
        "PAYCHEX_CLIENT_ID / PAYCHEX_CLIENT_SECRET not configured in edge function secrets",
    });
  }
  return { clientId, clientSecret };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON response (e.g. HTML error page from a gateway). Return
    // the raw text so the audit log can show what came back.
    return { raw: text };
  }
}

/**
 * Truncate a string to a max length so paychex_api_log.error stays
 * sane even if Paychex returns a wall of text.
 */
function truncate(value: string, max = 1000): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "…";
}

// ─── Token acquisition ─────────────────────────────────────────────

/**
 * Returns a valid Bearer access token, fetching a new one when none
 * is cached or the cached one is within the refresh margin.
 */
async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret } = getCredentials();
  const now = Date.now();
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAtMs - now > TOKEN_REFRESH_MARGIN_MS) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(`${PAYCHEX_API_BASE}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new PaychexError({
      code: "config_error",
      status: resp.status,
      message: `Paychex token endpoint returned ${resp.status}: ${truncate(errText, 300)}`,
    });
  }

  const data = await resp.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new PaychexError({
      code: "config_error",
      status: resp.status,
      message: "Paychex token response missing access_token",
    });
  }

  // Default TTL to ~1h if Paychex omits expires_in (per Phase 0 it
  // always includes 3599; the fallback is defensive).
  const ttlSeconds = typeof data.expires_in === "number" ? data.expires_in : 3599;
  tokenCache.set(clientId, {
    accessToken: data.access_token,
    expiresAtMs: now + ttlSeconds * 1000,
  });
  return data.access_token;
}

/**
 * Test/debug-only: clear the cached token. Not exported via index;
 * call sites that need this can import it directly.
 */
export function _clearTokenCacheForTests(): void {
  tokenCache.clear();
}

// ─── Audit logging ─────────────────────────────────────────────────

interface LogRow {
  org_id: string;
  endpoint: string;
  method: HttpMethod;
  request_body: unknown;
  response_status: number | null;
  response_body: unknown;
  error: string | null;
  idempotency_key: string | null;
  dry_run: boolean;
  duration_ms: number;
}

async function writeLog(
  ctx: PaychexClientContext,
  row: LogRow,
): Promise<void> {
  // We do NOT swallow log failures silently — losing audit rows would
  // undermine the integration's "prove what happened to Paychex" goal.
  // But we also don't want a transient log failure to mask the real
  // result. Strategy: write, log a console error if it fails, and
  // return — the call still returns its real response/error to the
  // caller.
  const { error } = await ctx.supabase.from("paychex_api_log").insert(row);
  if (error) {
    console.error(
      `[paychex] failed to write audit log for ${row.method} ${row.endpoint}: ${error.message}`,
    );
  }
}

// ─── Main call interface ───────────────────────────────────────────

/**
 * Make a single Paychex API call. Handles auth, retries, idempotency,
 * dry-run interception, and audit logging.
 */
export async function paychexCall(
  ctx: PaychexClientContext,
  opts: PaychexCallOptions,
): Promise<PaychexCallResult> {
  if (!opts.mediaType || typeof opts.mediaType !== "string") {
    throw new PaychexError({
      code: "config_error",
      status: null,
      message:
        `paychexCall: mediaType is required (e.g. application/vnd.paychex.workers.nonpii.v1+json)`,
    });
  }
  if ((opts.method === "POST" || opts.method === "PATCH") && !opts.idempotencyKey) {
    throw new PaychexError({
      code: "config_error",
      status: null,
      message: `paychexCall: idempotencyKey is required for ${opts.method} requests`,
    });
  }
  if (!ctx.orgId) {
    throw new PaychexError({
      code: "config_error",
      status: null,
      message: "paychexCall: ctx.orgId is required for audit logging",
    });
  }

  const isWrite = opts.method === "POST" || opts.method === "PATCH";
  const dryRun = isWrite && isDryRun();

  const start = Date.now();

  // ── Dry-run interception ─────────────────────────────────────
  if (dryRun) {
    const durationMs = Date.now() - start;
    const syntheticBody = {
      dry_run: true,
      message: `PAYCHEX_DRY_RUN active — no request sent to Paychex`,
      method: opts.method,
      path: opts.path,
    };
    await writeLog(ctx, {
      org_id: ctx.orgId,
      endpoint: opts.path,
      method: opts.method,
      request_body: opts.body ?? null,
      response_status: 200,
      response_body: syntheticBody,
      error: null,
      idempotency_key: opts.idempotencyKey ?? null,
      dry_run: true,
      duration_ms: durationMs,
    });
    return {
      status: 200,
      body: syntheticBody,
      dryRun: true,
      durationMs,
    };
  }

  // ── Real call with retry loop ────────────────────────────────
  let attempt = 0;
  let lastStatus: number | null = null;
  let lastBody: unknown = null;
  let lastErrorMessage: string | null = null;

  while (true) {
    let response: Response | null = null;
    let networkError: Error | null = null;

    try {
      const token = await getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: opts.mediaType,
      };
      if (isWrite) {
        headers["Content-Type"] = opts.mediaType;
        // Paychex honors a request-level idempotency header on POST/PATCH.
        // Using the same key on a retry guarantees the server dedupes.
        headers["Idempotency-Key"] = opts.idempotencyKey!;
      }

      response = await fetch(`${PAYCHEX_API_BASE}${opts.path}`, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      networkError = err instanceof Error ? err : new Error(String(err));
    }

    // ── Network error path ──────────────────────────────────
    if (networkError) {
      lastStatus = null;
      lastBody = null;
      lastErrorMessage = `network_error: ${networkError.message}`;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        attempt += 1;
        continue;
      }
      break;
    }

    // ── HTTP response path ──────────────────────────────────
    const status = response!.status;
    const body = await safeReadJson(response!);
    lastStatus = status;
    lastBody = body;

    if (status >= 200 && status < 300) {
      const durationMs = Date.now() - start;
      await writeLog(ctx, {
        org_id: ctx.orgId,
        endpoint: opts.path,
        method: opts.method,
        request_body: opts.body ?? null,
        response_status: status,
        response_body: body,
        error: null,
        idempotency_key: opts.idempotencyKey ?? null,
        dry_run: false,
        duration_ms: durationMs,
      });
      return { status, body, dryRun: false, durationMs };
    }

    if (status === HARD_FAIL_STATUS) {
      // 423 Locked — never retry, never trust any workerId in the body.
      lastErrorMessage = "client_account_locked";
      break;
    }

    if (status >= 400 && status < 500) {
      // Other 4xx — no retry.
      lastErrorMessage = `client_error: ${status}`;
      break;
    }

    if (RETRYABLE_STATUS_CODES.has(status) && attempt < RETRY_DELAYS_MS.length) {
      lastErrorMessage = `server_error: ${status} (attempt ${attempt + 1})`;
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt += 1;
      continue;
    }

    // Non-retryable 5xx, or retries exhausted.
    lastErrorMessage = `server_error: ${status}`;
    break;
  }

  // ── Failure: log + throw ────────────────────────────────────
  const durationMs = Date.now() - start;
  await writeLog(ctx, {
    org_id: ctx.orgId,
    endpoint: opts.path,
    method: opts.method,
    request_body: opts.body ?? null,
    response_status: lastStatus,
    response_body: lastBody,
    error: lastErrorMessage ? truncate(lastErrorMessage) : null,
    idempotency_key: opts.idempotencyKey ?? null,
    dry_run: false,
    duration_ms: durationMs,
  });

  // Map the failure into a PaychexError with a stable .code.
  if (lastStatus === HARD_FAIL_STATUS) {
    throw new PaychexError({
      code: "client_account_locked",
      status: lastStatus,
      message: `Paychex returned 423 Locked for ${opts.method} ${opts.path}; workerId in response (if any) was discarded per docs`,
      responseBody: lastBody,
    });
  }
  if (lastStatus !== null && lastStatus >= 400 && lastStatus < 500) {
    throw new PaychexError({
      code: "client_error",
      status: lastStatus,
      message: `Paychex ${opts.method} ${opts.path} failed: ${lastStatus}`,
      responseBody: lastBody,
    });
  }
  if (lastStatus !== null) {
    throw new PaychexError({
      code: "server_error",
      status: lastStatus,
      message: `Paychex ${opts.method} ${opts.path} failed after retries: ${lastStatus}`,
      responseBody: lastBody,
    });
  }
  throw new PaychexError({
    code: "network_error",
    status: null,
    message: `Paychex ${opts.method} ${opts.path} failed after retries: ${lastErrorMessage ?? "unknown error"}`,
  });
}

// ─── Idempotency key helper ────────────────────────────────────────

/**
 * Build a stable idempotency key from a worker correlation id and
 * a date bucket. Used for sync calls so retries within the same day
 * dedupe at Paychex's side.
 *
 * For payroll submission (Phase 5) the caller passes payroll_runs.id
 * directly instead.
 */
export async function buildSyncIdempotencyKey(
  workerCorrelationId: string,
  bucketDate: Date | string,
): Promise<string> {
  const bucket = typeof bucketDate === "string"
    ? bucketDate
    : bucketDate.toISOString().slice(0, 10);
  const input = `${workerCorrelationId}|${bucket}`;
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Convenience wrappers for worker calls ─────────────────────────
//
// The POST / PATCH path asymmetry is encoded once here so callers
// can't accidentally swap them.

export const WORKER_NONPII_MEDIA_TYPE =
  "application/vnd.paychex.workers.nonpii.v1+json";

/**
 * POST /companies/{companyId}/workers — body wrapped as a single-
 * element array per the Paychex API. Returns the parsed response.
 */
export async function postWorker(
  ctx: PaychexClientContext,
  args: {
    companyId: string;
    worker: Record<string, unknown>;
    idempotencyKey: string;
    mediaType?: string;
  },
): Promise<PaychexCallResult> {
  return paychexCall(ctx, {
    path: `/companies/${encodeURIComponent(args.companyId)}/workers`,
    method: "POST",
    mediaType: args.mediaType ?? WORKER_NONPII_MEDIA_TYPE,
    idempotencyKey: args.idempotencyKey,
    body: [args.worker],
  });
}

/**
 * PATCH /workers/{workerId} — no companyId in path, body is a single
 * object. Returns the parsed response.
 */
export async function patchWorker(
  ctx: PaychexClientContext,
  args: {
    workerId: string;
    worker: Record<string, unknown>;
    idempotencyKey: string;
    mediaType?: string;
  },
): Promise<PaychexCallResult> {
  return paychexCall(ctx, {
    path: `/workers/${encodeURIComponent(args.workerId)}`,
    method: "PATCH",
    mediaType: args.mediaType ?? WORKER_NONPII_MEDIA_TYPE,
    idempotencyKey: args.idempotencyKey,
    body: args.worker,
  });
}

/**
 * GET /workers/{workerId} — defaults to the nonpii variant so SSNs
 * never enter paychex_api_log unless a caller explicitly opts in.
 */
export async function getWorker(
  ctx: PaychexClientContext,
  args: {
    workerId: string;
    mediaType?: string;
  },
): Promise<PaychexCallResult> {
  return paychexCall(ctx, {
    path: `/workers/${encodeURIComponent(args.workerId)}`,
    method: "GET",
    mediaType: args.mediaType ?? WORKER_NONPII_MEDIA_TYPE,
  });
}

// ─── Misc helpers re-exported for callers ──────────────────────────

export function makeServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  return createClient(url, key);
}
