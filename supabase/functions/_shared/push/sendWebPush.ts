// ─── Shared Web Push sender ───
// Wraps the web-push library (npm, available in the Supabase edge runtime)
// with VAPID configuration from env. Used by shift-reminders (cron) and
// send-push (self-test).
//
// Required secrets (Supabase → Edge Functions):
//   VAPID_PUBLIC_KEY   base64url, app-wide (also baked into the PWA as
//                      VITE_VAPID_PUBLIC_KEY — the two MUST match)
//   VAPID_PRIVATE_KEY  base64url
//   VAPID_SUBJECT      optional mailto: or https URL; falls back to
//                      SUPABASE_URL so we never hardcode a tenant URL.

import webpush from "npm:web-push@3.6.7";

let configured = false;

export function configureVapid(): boolean {
  if (configured) return true;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT")
    || Deno.env.get("SUPABASE_URL")
    || "https://localhost";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  ok: boolean;
  statusCode?: number;
  expired: boolean;
  error?: string;
}

// Send one notification. `expired` is true when the push service reports
// the subscription is gone (404/410) so the caller can disable that row.
export async function sendToSubscription(
  sub: StoredSubscription,
  payload: Record<string, unknown>,
): Promise<SendResult> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true, expired: false };
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    return {
      ok: false,
      statusCode,
      expired: statusCode === 404 || statusCode === 410,
      error: String((err as { body?: string })?.body ?? (err as Error)?.message ?? err),
    };
  }
}
