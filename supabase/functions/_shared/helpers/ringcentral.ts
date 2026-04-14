// ─── RingCentral Auth & API Helpers ───
// Reads credentials directly from Deno.env so this module has no dependency
// on ai-chat's config.ts and can be imported by any Edge Function.

export const RC_API_URL = "https://platform.ringcentral.com";

// Legacy helper: uses the global RINGCENTRAL_JWT_TOKEN env var.
// Still used by helpers that don't participate in category routing
// (fetchRCMessages, fetchRCCallLog) — those read call logs which have
// always been account-level and don't depend on sender identity.
export async function getRingCentralAccessToken(): Promise<string> {
  const jwtToken = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
  if (!jwtToken) {
    throw new Error("RingCentral JWT not configured (RINGCENTRAL_JWT_TOKEN env var missing)");
  }
  return getRingCentralAccessTokenWithJwt(jwtToken);
}

// Category-aware helper: takes a JWT as a parameter so the caller can
// decide which RingCentral extension to authenticate as. Used by the
// sendSMS shared operation after a route lookup via
// getSendingCredentials() below.
export async function getRingCentralAccessTokenWithJwt(
  jwt: string,
): Promise<string> {
  const clientId = Deno.env.get("RINGCENTRAL_CLIENT_ID");
  const clientSecret = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("RingCentral client credentials not configured");
  }
  if (!jwt) {
    throw new Error("RingCentral JWT not provided");
  }

  const response = await fetch(`${RC_API_URL}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`RingCentral auth failed: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Resolve the sending phone number + JWT pair for an SMS send based on an
 * optional `category`. This mirrors the logic in bulk-sms/index.ts so all
 * edge functions that send SMS can share a single source of truth.
 *
 * - When `category` is provided → calls the service-role-only
 *   get_route_ringcentral_jwt RPC to look up the route's phone and
 *   decrypted JWT from Supabase Vault. Throws with a descriptive error
 *   if the route is missing, inactive, or incomplete.
 *
 * - When `category` is null/undefined → falls back to the legacy env-var
 *   path (app_settings.ringcentral_from_number + RINGCENTRAL_JWT_TOKEN).
 *   Byte-identical to pre-routing behavior.
 */
export async function getSendingCredentials(
  supabase: any,
  category: string | null | undefined,
): Promise<{ fromNumber: string; jwt: string }> {
  // ── Path A: category specified → route-based lookup ──
  if (category) {
    const { data, error } = await supabase.rpc("get_route_ringcentral_jwt", {
      p_category: category,
    });
    if (error) {
      throw new Error(
        `Route lookup failed for "${category}": ${error.message}`,
      );
    }
    if (!data || data.length === 0) {
      throw new Error(
        `Communication route "${category}" not found or inactive.`,
      );
    }
    const route = data[0];
    if (!route.sms_from_number) {
      throw new Error(
        `Route "${category}" has no phone number configured. Set one in Admin Settings → Communication Routes.`,
      );
    }
    if (!route.jwt) {
      throw new Error(
        `Route "${category}" has no JWT configured. Set one in Admin Settings → Communication Routes.`,
      );
    }
    // Normalize the phone number to E.164
    const digits = String(route.sms_from_number).replace(/\D/g, "");
    let normalized: string | null = null;
    if (digits.length === 10) normalized = `+1${digits}`;
    else if (digits.length === 11 && digits.startsWith("1")) normalized = `+${digits}`;
    if (!normalized) {
      throw new Error(
        `Route "${category}" has an invalid phone number: ${route.sms_from_number}`,
      );
    }
    return { fromNumber: normalized, jwt: route.jwt };
  }

  // ── Path B: no category → legacy env-var path ──
  const fromNumber = await getRCFromNumber(supabase);
  if (!fromNumber) {
    throw new Error("RingCentral from number not configured");
  }
  const jwt = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
  if (!jwt) {
    throw new Error(
      "RingCentral JWT not configured (RINGCENTRAL_JWT_TOKEN env var missing)",
    );
  }
  return { fromNumber, jwt };
}

export async function getRCFromNumber(
  supabase: any,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ringcentral_from_number")
      .single();

    if (data?.value) {
      const val =
        typeof data.value === "string" ? data.value : String(data.value);
      const digits = val.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      if (val.startsWith("+")) return val;
      return val;
    }
  } catch (err) {
    console.warn(
      "[getRCFromNumber] Failed to read from app_settings, using env fallback:",
      (err as Error).message,
    );
  }
  return Deno.env.get("RINGCENTRAL_FROM_NUMBER") || null;
}

export async function fetchRCMessages(
  accessToken: string,
  phoneNumber: string,
  daysBack: number,
): Promise<any[]> {
  const dateFrom = new Date(Date.now() - daysBack * 86400000).toISOString();
  const url = `${RC_API_URL}/restapi/v1.0/account/~/extension/~/message-store?messageType=SMS&phoneNumber=${encodeURIComponent(phoneNumber)}&dateFrom=${dateFrom}&perPage=100`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(
      `RC Message Store API error (${response.status}): ${err}`,
    );
  }

  const data = await response.json();
  return data.records || [];
}

export async function fetchRCCallLog(
  accessToken: string,
  phoneNumber: string,
  daysBack: number,
): Promise<any[]> {
  const dateFrom = new Date(Date.now() - daysBack * 86400000).toISOString();
  const url = `${RC_API_URL}/restapi/v1.0/account/~/extension/~/call-log?phoneNumber=${encodeURIComponent(phoneNumber)}&dateFrom=${dateFrom}&type=Voice&perPage=100&view=Detailed`;

  console.log(
    `[get_call_log] Fetching calls for ${phoneNumber}, daysBack=${daysBack}`,
  );

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`RC Call Log API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  console.log(
    `[get_call_log] Found ${data.records?.length || 0} records with phoneNumber filter`,
  );

  if (!data.records || data.records.length === 0) {
    console.log(
      `[get_call_log] No results with filter, trying client-side filtering...`,
    );
    const allUrl = `${RC_API_URL}/restapi/v1.0/account/~/extension/~/call-log?dateFrom=${dateFrom}&type=Voice&perPage=250&view=Detailed`;

    const allResponse = await fetch(allUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!allResponse.ok) {
      const err = await allResponse.text();
      throw new Error(`RC Call Log API error (${allResponse.status}): ${err}`);
    }

    const allData = await allResponse.json();
    const allRecords = allData.records || [];
    console.log(`[get_call_log] Total calls in period: ${allRecords.length}`);

    const targetDigits = phoneNumber.replace(/\D/g, "");
    const targetLast10 = targetDigits.slice(-10);

    const filtered = allRecords.filter((record: any) => {
      const legs = record.legs || [];
      for (const leg of legs) {
        const fromNum = leg.from?.phoneNumber?.replace(/\D/g, "") || "";
        const toNum = leg.to?.phoneNumber?.replace(/\D/g, "") || "";
        if (
          fromNum.slice(-10) === targetLast10 ||
          toNum.slice(-10) === targetLast10
        ) {
          return true;
        }
      }
      const fromNum = record.from?.phoneNumber?.replace(/\D/g, "") || "";
      const toNum = record.to?.phoneNumber?.replace(/\D/g, "") || "";
      return (
        fromNum.slice(-10) === targetLast10 ||
        toNum.slice(-10) === targetLast10
      );
    });

    console.log(
      `[get_call_log] Client-side filtered: ${filtered.length} matching calls`,
    );
    return filtered;
  }

  return data.records;
}
