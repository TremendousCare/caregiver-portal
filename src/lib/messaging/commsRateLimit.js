// ─── Frontend RingCentral rate-limit detection ──────────────────────────────
//
// Classifies an error returned by a `supabase.functions.invoke('get-
// communications', ...)` call as a RingCentral rate-limit (CMN-301 / HTTP
// 429) vs a generic failure. The get-communications edge function returns
// HTTP 429 with `{ rate_limited: true }` when RC's per-extension "Heavy"
// bucket is in penalty; the Supabase client surfaces that on the error's
// `context.status`. We also pattern-match the message as a belt-and-
// suspenders fallback for older shapes.
//
// Mirrors the edge-side isRateLimitError in
// supabase/functions/_shared/operations/rateLimit.ts (edge functions can't
// import from the frontend tree, so the two are kept in sync by hand — the
// patterns here intentionally match that module's).

const RATE_LIMIT_MESSAGE = /rate.?limit|\b429\b|CMN-301|too many requests/i;

/**
 * True when a get-communications invoke error represents RingCentral
 * rate-limiting (so the UI can say "temporarily unavailable" rather than
 * "no messages"). Accepts the FunctionsHttpError-style object the Supabase
 * client returns. Null/undefined safe.
 */
export function isCommsRateLimitError(error) {
  if (!error) return false;
  if (error?.context?.status === 429) return true;
  const message = typeof error === 'string' ? error : error?.message || '';
  return RATE_LIMIT_MESSAGE.test(message);
}

// User-facing copy. Kept here so every comms surface shows identical wording.
export const COMMS_RATE_LIMITED_MESSAGE =
  'Communication history temporarily unavailable (rate limited). Try again shortly.';
export const COMMS_LOAD_FAILED_MESSAGE =
  'Could not load external communication data.';

/**
 * Pick the right user-facing banner for a failed comms fetch.
 */
export function commsErrorMessage(error) {
  return isCommsRateLimitError(error)
    ? COMMS_RATE_LIMITED_MESSAGE
    : COMMS_LOAD_FAILED_MESSAGE;
}
