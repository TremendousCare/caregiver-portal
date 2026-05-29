// ─── QuickBooks Online OAuth helpers ─────────────────────────────────────
// Shared by the quickbooks-oauth-init and quickbooks-oauth-callback edge
// functions (PR #2) and reused by the token-refresh cron (PR #3).
//
// The pure functions (buildAuthorizeUrl, expiriesFromTokenResponse,
// parseTokenResponse) are unit-tested in
// src/lib/__tests__/quickbooksOauthHelpers.test.js. The network call
// (exchangeCodeForTokens) is exercised in integration tests against
// Intuit's sandbox once the OAuth round-trip is wired up.

// Intuit OAuth 2.0 endpoints — same URLs for sandbox and production;
// the sandbox/prod distinction is determined by which client_id is
// used, not by which URL is called.
export const QB_AUTH_BASE_URL  = "https://appcenter.intuit.com/connect/oauth2";
export const QB_TOKEN_URL      = "https://oauth.platform.intuit.com/oauth2/v1/tokens";
export const QB_REVOKE_URL     = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

// The scope set we request at consent time. Locked with the owner
// 2026-05-29 — accounting covers Customers, Invoices, Items,
// Payments, Bills, Vendors, JournalEntries, Reports (both read AND
// write surfaces), which is sufficient for the profitability
// analytics deliverable and for the future invoicing API push.
// Payments scope intentionally omitted; see CLAUDE.md / chat.
export const QB_DEFAULT_SCOPES: readonly string[] = Object.freeze([
  "com.intuit.quickbooks.accounting",
  "openid",
  "profile",
  "email",
]);

// Shape of Intuit's POST /oauth2/v1/tokens response — see
// https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
export type QBTokenResponse = {
  access_token: string;
  refresh_token: string;
  /** seconds until access_token expires (typically 3600) */
  expires_in: number;
  /** seconds until refresh_token expires (typically ~8,640,000 = 100d) */
  x_refresh_token_expires_in: number;
  token_type: string;
};

export type QBAuthorizeUrlOpts = {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
};

/**
 * Build the Intuit OAuth consent URL.
 *
 * `state` MUST be the UUID returned from init_qb_oauth_state — the
 * callback edge function looks it up to verify the redirect came
 * from a legitimate handshake.
 */
export function buildAuthorizeUrl(opts: QBAuthorizeUrlOpts): string {
  const scopes = opts.scopes ?? QB_DEFAULT_SCOPES;
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    scope: scopes.join(" "),
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${QB_AUTH_BASE_URL}?${params.toString()}`;
}

/**
 * Validate and shape Intuit's token-endpoint response.
 *
 * Intuit returns 200 + a JSON body on success. Anything else is an
 * exchange failure; the caller catches the throw and surfaces the
 * error to the user as a redirect query param.
 */
export function parseTokenResponse(raw: unknown): QBTokenResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("Intuit token response is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.access_token !== "string" || r.access_token.length === 0) {
    throw new Error("Intuit token response missing access_token");
  }
  if (typeof r.refresh_token !== "string" || r.refresh_token.length === 0) {
    throw new Error("Intuit token response missing refresh_token");
  }
  if (typeof r.expires_in !== "number" || r.expires_in <= 0) {
    throw new Error("Intuit token response missing expires_in");
  }
  if (typeof r.x_refresh_token_expires_in !== "number" || r.x_refresh_token_expires_in <= 0) {
    throw new Error("Intuit token response missing x_refresh_token_expires_in");
  }
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_in: r.expires_in,
    x_refresh_token_expires_in: r.x_refresh_token_expires_in,
    token_type: typeof r.token_type === "string" ? r.token_type : "bearer",
  };
}

/**
 * Convert relative expiry seconds into absolute ISO timestamps.
 * `nowMs` is injectable so tests can pin time without freezing the
 * global clock.
 */
export function expiriesFromTokenResponse(
  t: Pick<QBTokenResponse, "expires_in" | "x_refresh_token_expires_in">,
  nowMs: number = Date.now(),
): { accessExpiresAt: Date; refreshExpiresAt: Date } {
  return {
    accessExpiresAt:  new Date(nowMs + t.expires_in * 1000),
    refreshExpiresAt: new Date(nowMs + t.x_refresh_token_expires_in * 1000),
  };
}

export type QBExchangeOpts = {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
};

/**
 * POST Intuit's token endpoint to exchange an auth code for tokens.
 *
 * Per Intuit's spec, the redirect_uri sent here MUST byte-match the
 * one registered for the app — even an extra trailing slash will
 * fail. The caller is responsible for sourcing the same value the
 * authorize URL used (i.e., the QB_REDIRECT_URI env var).
 */
export async function exchangeCodeForTokens(opts: QBExchangeOpts): Promise<QBTokenResponse> {
  const basic = btoa(`${opts.clientId}:${opts.clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const resp = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Intuit token exchange failed: ${resp.status} ${resp.statusText} — ${text}`);
  }
  return parseTokenResponse(await resp.json());
}

/**
 * Refresh an access token using a refresh token. Same endpoint as
 * exchange, different grant_type. Intuit rotates the refresh_token
 * on every call — caller MUST persist the new refresh_token or the
 * connection is bricked.
 */
export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<QBTokenResponse> {
  const basic = btoa(`${opts.clientId}:${opts.clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
  const resp = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Intuit token refresh failed: ${resp.status} ${resp.statusText} — ${text}`);
  }
  return parseTokenResponse(await resp.json());
}
