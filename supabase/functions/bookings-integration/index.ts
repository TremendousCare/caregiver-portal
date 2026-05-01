// ─── Microsoft 365 Bookings Integration ─────────────────────────────────────
// Read-only first cut. Talks to Microsoft Graph's Bookings API
// (/solutions/bookingBusinesses/...) using the same app-only client-credentials
// flow as outlook-integration.
//
// Required Azure AD application permissions (admin consent granted):
//   - Bookings.Read.All
//   - BookingsAppointment.ReadWrite.All  (read used here; write actions come later)
//
// Supported actions:
//   verify             — list every booking business in the tenant with services + staff.
//                        Use this once after granting permissions to identify the
//                        booking business ID we'll wire to the caregiver pipeline.
//   list_businesses    — list booking businesses (id + displayName + url)
//   get_business       — get one business by id
//   list_services      — list services of a business
//   list_staff         — list staff members of a business
//   list_appointments  — list appointments for a business in a date window
//   get_appointment    — get one appointment by id
//
// Write actions (cancel/reschedule) intentionally not included in this first cut.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRAPH = "https://graph.microsoft.com/v1.0";
const TZ = "Pacific Standard Time";

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
