// ─── Microsoft 365 Bookings Integration ─────────────────────────────────────
// Talks to Microsoft Graph's Bookings API (/solutions/bookingBusinesses/...)
// using the same app-only client-credentials flow as outlook-integration.
//
// Required Azure AD application permissions (admin consent granted):
//   - Bookings.Read.All
//   - BookingsAppointment.ReadWrite.All  (read + cancel/reschedule)
//
// Supported actions:
//   verify              — list every booking business in the tenant with services + staff.
//                         Use this once after granting permissions to identify the
//                         booking business ID we'll wire to the caregiver pipeline.
//   list_businesses     — list booking businesses (id + displayName + url)
//   get_business        — get one business by id
//   list_services       — list services of a business
//   list_staff          — list staff members of a business
//   list_appointments   — list appointments for a business in a date window
//   get_appointment     — get one appointment by id
//   subscribe           — create (or renew) Graph change-notification subscriptions
//                         on every org's configured Bookings business. Idempotent.
//                         Stores the subscription ID + clientState in
//                         bookings_subscriptions for the bookings-webhook to verify.
//   renew_subscriptions — alias of `subscribe`. Daily pg_cron entry-point;
//                         renames clarify intent in cron logs.
//   unsubscribe         — admin-only escape hatch; deletes Graph subscriptions
//                         for a given business_id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRAPH = "https://graph.microsoft.com/v1.0";
const TZ = "Pacific Standard Time";

// Service-role client for the subscribe/renew/unsubscribe actions, which
// need to read organizations + write bookings_subscriptions across all
// tenants. Read-only Graph actions don't touch Supabase at all.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// ─── Microsoft Graph Auth ─────────────────────────────────────────────────

async function getGraphToken(): Promise<string> {
  const tenantId = Deno.env.get("MICROSOFT_TENANT_ID");
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Missing MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Microsoft token error: ${resp.status} - ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token as string;
}

async function graphGet(token: string, path: string): Promise<any> {
  const resp = await fetch(`${GRAPH}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: `outlook.timezone="${TZ}"`,
    },
  });
  if (!resp.ok) {
    throw new Error(`Graph GET ${path} failed: ${resp.status} - ${await resp.text()}`);
  }
  return resp.json();
}

// ─── Formatting Helpers ───────────────────────────────────────────────────

function formatDisplay(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Los_Angeles",
    });
  } catch {
    return iso;
  }
}

function shapeBusiness(b: any) {
  return {
    id: b.id,
    display_name: b.displayName,
    business_type: b.businessType || null,
    public_url: b.publicUrl || null,
    default_currency: b.defaultCurrencyIso || null,
    is_published: b.isPublished ?? null,
    language: b.languageTag || null,
    email: b.email || null,
    phone: b.phone || null,
  };
}

function shapeService(s: any) {
  return {
    id: s.id,
    display_name: s.displayName,
    duration_iso: s.defaultDuration || null,
    description: s.description || "",
    is_hidden_from_customers: !!s.isHiddenFromCustomers,
    default_price: s.defaultPrice ?? null,
    default_price_type: s.defaultPriceType || null,
    staff_member_ids: Array.isArray(s.staffMemberIds) ? s.staffMemberIds : [],
  };
}

function shapeStaff(s: any) {
  return {
    id: s.id,
    display_name: s.displayName,
    email: s.emailAddress || null,
    role: s.role || null,
    is_email_notification_enabled: !!s.isEmailNotificationEnabled,
    use_business_hours: !!s.useBusinessHours,
  };
}

function shapeAppointment(a: any) {
  const customers = Array.isArray(a.customers) ? a.customers : [];
  return {
    id: a.id,
    self_service_id: a.selfServiceAppointmentId || null,
    service_id: a.serviceId || null,
    service_name: a.serviceName || null,
    staff_member_ids: Array.isArray(a.staffMemberIds) ? a.staffMemberIds : [],
    start: a.startDateTime?.dateTime || null,
    end: a.endDateTime?.dateTime || null,
    start_display: formatDisplay(a.startDateTime?.dateTime),
    end_display: formatDisplay(a.endDateTime?.dateTime),
    duration_iso: a.duration || null,
    is_online_meeting: !!a.isLocationOnline,
    join_web_url: a.joinWebUrl || null,
    customer_time_zone: a.customerTimeZone || null,
    customers: customers.map((c: any) => ({
      customer_id: c.customerId || null,
      name: c.name || "",
      email: c.emailAddress || "",
      phone: c.phone || "",
      notes: c.notes || "",
      time_zone: c.timeZone || null,
      custom_question_answers: Array.isArray(c.customQuestionAnswers)
        ? c.customQuestionAnswers.map((q: any) => ({
            question: q.question || "",
            answer: q.answer || "",
            question_id: q.questionId || null,
          }))
        : [],
    })),
  };
}

// ─── Actions ──────────────────────────────────────────────────────────────

async function listBusinesses(token: string): Promise<any> {
  const data = await graphGet(token, `/solutions/bookingBusinesses`);
  return {
    total: (data.value || []).length,
    businesses: (data.value || []).map(shapeBusiness),
  };
}

async function getBusiness(token: string, body: any): Promise<any> {
  const id = body.business_id;
  if (!id) throw new Error("get_business requires business_id");
  const b = await graphGet(token, `/solutions/bookingBusinesses/${encodeURIComponent(id)}`);
  return shapeBusiness(b);
}

async function listServices(token: string, body: any): Promise<any> {
  const id = body.business_id;
  if (!id) throw new Error("list_services requires business_id");
  const data = await graphGet(
    token,
    `/solutions/bookingBusinesses/${encodeURIComponent(id)}/services`,
  );
  return {
    business_id: id,
    total: (data.value || []).length,
    services: (data.value || []).map(shapeService),
  };
}

async function listStaff(token: string, body: any): Promise<any> {
  const id = body.business_id;
  if (!id) throw new Error("list_staff requires business_id");
  const data = await graphGet(
    token,
    `/solutions/bookingBusinesses/${encodeURIComponent(id)}/staffMembers`,
  );
  return {
    business_id: id,
    total: (data.value || []).length,
    staff: (data.value || []).map(shapeStaff),
  };
}

async function listAppointments(token: string, body: any): Promise<any> {
  const id = body.business_id;
  if (!id) throw new Error("list_appointments requires business_id");
  const start = body.start_date || new Date().toISOString().split("T")[0];
  const endDefault = new Date(Date.now() + 60 * 86400000).toISOString().split("T")[0];
  const end = body.end_date || endDefault;

  // Fetch a window of appointments. Filter syntax against
  // bookingAppointment's dateTimeTimeZone property is finicky across Graph
  // versions, so we pull a generous page and filter client-side. Keeps the
  // first integration robust.
  const top = Math.min(Math.max(Number(body.top) || 200, 1), 999);
  const data = await graphGet(
    token,
    `/solutions/bookingBusinesses/${encodeURIComponent(id)}/appointments?$top=${top}`,
  );
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T23:59:59Z`).getTime();
  const all = (data.value || []).map(shapeAppointment);
  const inRange = all.filter((a: any) => {
    if (!a.start) return false;
    const t = new Date(a.start).getTime();
    return t >= startMs && t <= endMs;
  });
  inRange.sort((a: any, b: any) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return {
    business_id: id,
    start_date: start,
    end_date: end,
    total_in_range: inRange.length,
    total_fetched: all.length,
    appointments: inRange,
  };
}

async function getAppointment(token: string, body: any): Promise<any> {
  const businessId = body.business_id;
  const appointmentId = body.appointment_id;
  if (!businessId || !appointmentId) {
    throw new Error("get_appointment requires business_id and appointment_id");
  }
  const a = await graphGet(
    token,
    `/solutions/bookingBusinesses/${encodeURIComponent(businessId)}/appointments/${encodeURIComponent(appointmentId)}`,
  );
  return shapeAppointment(a);
}

// One-shot setup helper. Lists every business in the tenant and, for each,
// pulls services + staff. Use this immediately after granting the Bookings
// permissions to identify which bookingBusiness corresponds to the caregiver
// interview booking page.
async function verify(token: string): Promise<any> {
  const biz = await listBusinesses(token);
  const detailed = await Promise.all(
    biz.businesses.map(async (b: any) => {
      try {
        const [services, staff] = await Promise.all([
          listServices(token, { business_id: b.id }),
          listStaff(token, { business_id: b.id }),
        ]);
        return {
          ...b,
          services_count: services.total,
          staff_count: staff.total,
          services: services.services,
          staff: staff.staff,
        };
      } catch (err) {
        return { ...b, error: (err as Error).message };
      }
    }),
  );
  return {
    permissions_ok: true,
    total_businesses: biz.total,
    businesses: detailed,
    next_step:
      biz.total === 0
        ? "No booking businesses returned. Either Bookings is not provisioned in this tenant or the app permissions have not propagated yet (can take up to 10 minutes after admin consent)."
        : "Identify which business is the caregiver interview page and capture its `id`. We'll store it in organizations.settings.bookings.business_id.",
  };
}

// ─── Graph Subscriptions ──────────────────────────────────────────────────
// Microsoft Graph caps Bookings appointment subscriptions at ~3 days.
// We POST to /subscriptions to create one, and PATCH the same path to
// renew. Both responses include `id` (subscription ID) and
// `expirationDateTime`. Failures fall through to a fresh create — Graph
// returns 404 on expired subs and the renew loop is meant to recover.
//
// The notification URL is this project's bookings-webhook function. Graph
// does a synchronous validation handshake (POSTs back with a
// validationToken query string) at subscription create-time, so the
// webhook must already be deployed before the first subscribe call.

const SUBSCRIPTION_LIFETIME_MINUTES = 4230; // 70.5h, just under Graph's ~72h cap

function generateClientState(): string {
  // 32 hex chars from 16 random bytes. crypto.getRandomValues is
  // available in Deno without an import.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function graphPost(token: string, path: string, body: any): Promise<any> {
  const resp = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Graph POST ${path} failed: ${resp.status} - ${await resp.text()}`);
  }
  return resp.json();
}

async function graphPatch(token: string, path: string, body: any): Promise<Response> {
  return fetch(`${GRAPH}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function graphDelete(token: string, path: string): Promise<Response> {
  return fetch(`${GRAPH}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Build the Graph subscription POST body for a given business + clientState.
// `resource` points at the appointments collection of one bookingBusiness;
// Graph notifies on any create/update/delete in that collection.
function buildSubscriptionBody(
  businessId: string,
  notificationUrl: string,
  clientState: string,
  expirationIso: string,
) {
  return {
    changeType: "created,updated,deleted",
    notificationUrl,
    resource: `/solutions/bookingBusinesses/${businessId}/appointments`,
    expirationDateTime: expirationIso,
    clientState,
  };
}

// Try to renew an existing subscription. Returns the new expiration on
// success, null if Graph rejects the renewal (typically 404 because it
// expired between cron runs). Caller falls back to a fresh create.
async function tryRenewSubscription(
  token: string,
  subscriptionId: string,
  expirationIso: string,
): Promise<string | null> {
  const resp = await graphPatch(
    token,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { expirationDateTime: expirationIso },
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data.expirationDateTime as string) || expirationIso;
}

interface OrgWithBookings {
  id: string;
  slug: string;
  business_id: string;
}

// Read every org with a bookings.business_id in settings. Multi-tenant
// from day one — the cron processes all orgs in one run.
async function loadOrgsWithBookings(): Promise<OrgWithBookings[]> {
  if (!supabase) throw new Error("Supabase service-role client not configured");
  const { data, error } = await supabase
    .from("organizations")
    .select("id, slug, settings")
    .not("settings->bookings", "is", null);
  if (error) {
    throw new Error(`organizations lookup failed: ${error.message}`);
  }
  const out: OrgWithBookings[] = [];
  for (const row of data || []) {
    const settings = (row as any).settings || {};
    const bookings = settings.bookings || {};
    if (typeof bookings.business_id === "string" && bookings.business_id) {
      out.push({ id: row.id, slug: row.slug, business_id: bookings.business_id });
    }
  }
  return out;
}

// Subscribe (or renew) one org's bookings business. The function is
// the per-org primitive that the bulk subscribe/renew action loops over.
async function subscribeOneOrg(
  token: string,
  org: OrgWithBookings,
  notificationUrl: string,
): Promise<Record<string, unknown>> {
  if (!supabase) throw new Error("Supabase service-role client not configured");

  const expirationIso = new Date(
    Date.now() + SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1000,
  ).toISOString();

  // Look up the existing subscription row, if any.
  const { data: existing } = await supabase
    .from("bookings_subscriptions")
    .select("id, subscription_id, client_state")
    .eq("org_id", org.id)
    .eq("business_id", org.business_id)
    .maybeSingle();

  // Try to renew first — cheaper, preserves the subscriptionId in our
  // mirror so we don't have to wait for Graph's validation handshake.
  if (existing?.subscription_id) {
    try {
      const newExpiration = await tryRenewSubscription(
        token,
        existing.subscription_id,
        expirationIso,
      );
      if (newExpiration) {
        await supabase
          .from("bookings_subscriptions")
          .update({
            expires_at: newExpiration,
            last_renewed_at: new Date().toISOString(),
            last_synced_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("id", existing.id);
        return {
          org_id: org.id,
          slug: org.slug,
          business_id: org.business_id,
          action: "renewed",
          subscription_id: existing.subscription_id,
          expires_at: newExpiration,
        };
      }
    } catch (err) {
      // Fall through to create-new on any renew failure.
      console.warn("subscribe renew failed, falling through:", (err as Error).message);
    }
  }

  // Create a fresh subscription. clientState is generated per-create
  // so a leaked secret can be rotated by simply re-running the cron.
  const clientState = generateClientState();
  let subData: any;
  try {
    subData = await graphPost(token, "/subscriptions", buildSubscriptionBody(
      org.business_id,
      notificationUrl,
      clientState,
      expirationIso,
    ));
  } catch (err) {
    const message = (err as Error).message || String(err);
    await supabase.from("bookings_subscriptions").upsert(
      {
        org_id: org.id,
        business_id: org.business_id,
        last_synced_at: new Date().toISOString(),
        last_error: message,
      },
      { onConflict: "org_id,business_id" },
    );
    return {
      org_id: org.id,
      slug: org.slug,
      business_id: org.business_id,
      action: "failed",
      error: message,
    };
  }

  await supabase.from("bookings_subscriptions").upsert(
    {
      org_id: org.id,
      business_id: org.business_id,
      subscription_id: subData.id,
      expires_at: subData.expirationDateTime || expirationIso,
      notification_url: notificationUrl,
      client_state: clientState,
      last_renewed_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "org_id,business_id" },
  );

  return {
    org_id: org.id,
    slug: org.slug,
    business_id: org.business_id,
    action: "created",
    subscription_id: subData.id,
    expires_at: subData.expirationDateTime || expirationIso,
  };
}

async function subscribeAll(token: string): Promise<any> {
  if (!SUPABASE_URL) {
    throw new Error("SUPABASE_URL env var missing");
  }
  const notificationUrl = `${SUPABASE_URL}/functions/v1/bookings-webhook`;
  const orgs = await loadOrgsWithBookings();
  if (orgs.length === 0) {
    return {
      total: 0,
      results: [],
      note: "No organizations have settings.bookings.business_id set; nothing to subscribe.",
    };
  }
  // Serial loop: keeps Graph rate-limit risk minimal and error
  // attribution clean.
  const results: any[] = [];
  for (const org of orgs) {
    results.push(await subscribeOneOrg(token, org, notificationUrl));
  }
  return {
    total: results.length,
    notification_url: notificationUrl,
    results,
  };
}

// Admin-only escape hatch. Deletes any active subscription for the
// given business and clears the local row. Useful when rotating
// secrets, decommissioning a Bookings business, or recovering from a
// stuck subscription.
async function unsubscribeBusiness(token: string, body: any): Promise<any> {
  if (!supabase) throw new Error("Supabase service-role client not configured");
  const businessId = body.business_id;
  if (!businessId) throw new Error("unsubscribe requires business_id");

  const { data: rows } = await supabase
    .from("bookings_subscriptions")
    .select("id, org_id, subscription_id")
    .eq("business_id", businessId);

  const results: any[] = [];
  for (const row of rows || []) {
    if (row.subscription_id) {
      const resp = await graphDelete(
        token,
        `/subscriptions/${encodeURIComponent(row.subscription_id)}`,
      );
      // Best-effort: 404 is fine (already gone). Anything else gets logged.
      if (!resp.ok && resp.status !== 404) {
        const err = await resp.text();
        results.push({ id: row.id, action: "graph_delete_failed", status: resp.status, error: err });
        continue;
      }
    }
    await supabase
      .from("bookings_subscriptions")
      .update({
        subscription_id: null,
        expires_at: null,
        client_state: null,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", row.id);
    results.push({ id: row.id, org_id: row.org_id, action: "unsubscribed" });
  }
  return { total: results.length, results };
}

// ─── Request Handler ──────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const action = body.action;
    const token = await getGraphToken();

    let result: any;
    if (action === "verify") {
      result = await verify(token);
    } else if (action === "list_businesses") {
      result = await listBusinesses(token);
    } else if (action === "get_business") {
      result = await getBusiness(token, body);
    } else if (action === "list_services") {
      result = await listServices(token, body);
    } else if (action === "list_staff") {
      result = await listStaff(token, body);
    } else if (action === "list_appointments") {
      result = await listAppointments(token, body);
    } else if (action === "get_appointment") {
      result = await getAppointment(token, body);
    } else if (action === "subscribe" || action === "renew_subscriptions") {
      result = await subscribeAll(token);
    } else if (action === "unsubscribe") {
      result = await unsubscribeBusiness(token, body);
    } else {
      return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("bookings-integration error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
