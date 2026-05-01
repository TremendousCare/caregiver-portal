// ─── Anthropic API call helper ───
//
// Single retry-with-backoff helper used by every agent runtime handler. The
// behaviour mirrors `callClaudeWithRetry` in `ai-chat/index.ts` so that Phase
// 0.4's edge-function cutover is byte-equal: same retries on the same status
// codes, same backoff curve, same response shape returned to the caller.
//
// fetchImpl is injectable so unit tests can supply canned responses without
// monkey-patching globals — the runtime itself never reaches outside of what
// the caller hands it.

const RETRYABLE_STATUSES = new Set([429, 500, 503, 529]);

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicCallOptions {
  apiKey: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  /** Max retries on retryable HTTP statuses. Defaults to 2 (matches ai-chat). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Defaults to 1000. */
  retryBaseDelayMs?: number;
  /** Optional sleep function — tests pass a no-op. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AnthropicCallResult {
  /** True if the final response.ok was true. */
  ok: boolean;
  /** HTTP status from the final attempt (the one returned). */
  status: number;
  /** Parsed JSON body, or null if non-2xx and body could not be parsed. */
  data: any | null;
  /** Raw response text on failure (for logging). */
  errorText?: string;
  /** Number of attempts made (1 = no retry). */
  attempts: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs a request to Anthropic Messages with the same retry profile as
 * `ai-chat`. Always returns a normalized result; never throws on transport
 * errors — the caller decides how to surface them.
 */
export async function callAnthropic(
  opts: AnthropicCallOptions,
): Promise<AnthropicCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const retryBase = opts.retryBaseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;

  const requestBody = JSON.stringify(opts.body);
  let lastResponse: Response | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    if (attempt > 0) {
      const delay = retryBase * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
    try {
      lastResponse = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: requestBody,
      });
    } catch (err) {
      // Network-layer failure — treat as retryable until the loop exhausts.
      if (attempt === maxRetries) {
        return {
          ok: false,
          status: 0,
          data: null,
          errorText: (err as Error).message || "network_error",
          attempts,
        };
      }
      continue;
    }
    if (lastResponse.ok || !RETRYABLE_STATUSES.has(lastResponse.status)) {
      break;
    }
    // Otherwise: retryable, loop again.
  }

  if (!lastResponse) {
    return {
      ok: false,
      status: 0,
      data: null,
      errorText: "no_response",
      attempts,
    };
  }

  if (!lastResponse.ok) {
    let errorText = "";
    try {
      errorText = await lastResponse.text();
    } catch {
      errorText = "<unreadable>";
    }
    return {
      ok: false,
      status: lastResponse.status,
      data: null,
      errorText,
      attempts,
    };
  }

  let data: any = null;
  try {
    data = await lastResponse.json();
  } catch (err) {
    return {
      ok: false,
      status: lastResponse.status,
      data: null,
      errorText: `parse_error: ${(err as Error).message}`,
      attempts,
    };
  }

  return { ok: true, status: lastResponse.status, data, attempts };
}
