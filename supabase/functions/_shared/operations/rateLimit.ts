// ─── RingCentral rate-limit detection ───────────────────────────────────────
//
// Single source of truth for "did this failure come from RingCentral's rate
// limiter?" Used by background workers (post-call-processor, transcript-
// backfill) to STOP a batch the moment a shared per-extension bucket enters
// its penalty interval, instead of charging ahead and firing more requests
// that are guaranteed to also be rejected.
//
// Why this exists: RingCentral's Heavy API group (recording downloads,
// message-store, call-log) is capped at 10 requests / 60s per extension with
// a 60s penalty. A per-minute cron pulling a batch of N recordings blew past
// that ceiling, parked the bucket in perpetual penalty, and starved every
// other consumer on the same extension — including the interactive
// get-communications message-history reads. Once we see the FIRST 429 in a
// tick, every subsequent request in that tick will also 429 (the penalty
// window outlives the batch), so the only useful move is to halt and let the
// next, more widely-spaced tick try again.
//
// Detection is string-based because the thrown errors originate from many
// call sites that all stringify the upstream RC response into the Error
// message (e.g. `RC recording download failed (429): ...`,
// `RingSense insights fetch failed (429): ...`). We match both the HTTP
// status token and RingCentral's CMN-301 application error code.

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\(429\)/, // "... failed (429): ..." — the shape our RC helpers throw
  /\b429\b/, // bare status code
  /CMN-301/i, // RingCentral's "Request rate exceeded" error code
  /request rate exceeded/i, // its human-readable message
  /too many requests/i, // generic 429 phrasing
];

/**
 * True when `err` looks like a RingCentral (or generic HTTP) rate-limit
 * rejection. Accepts an Error, a string, or anything stringifiable so callers
 * can pass either a caught exception or a pre-extracted message.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err == null) return false;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return String(err);
            } catch {
              return "";
            }
          })();
  if (!message) return false;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(message));
}
