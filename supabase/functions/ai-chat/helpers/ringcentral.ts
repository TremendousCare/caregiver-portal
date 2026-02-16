// ─── RingCentral Auth & API Helpers ───

import {
  RC_CLIENT_ID,
  RC_CLIENT_SECRET,
  RC_JWT_TOKEN,
  RC_FROM_NUMBER,
  RC_API_URL,
} from "../config.ts";

export async function getRingCentralAccessToken(): Promise<string> {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT_TOKEN) {
    throw new Error("RingCentral credentials not configured");
  }

  const response = await fetch(`${RC_API_URL}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RC_JWT_TOKEN,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`RingCentral auth failed: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
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
  return RC_FROM_NUMBER || null;
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
