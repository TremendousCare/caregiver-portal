// ─── Outlook / Microsoft 365 Integration ───────────────────────────────────
// Per-admin mailbox routing. Each request may specify `admin_email` to read/send
// from that admin's mailbox. Falls back to the global `app_settings.outlook_mailbox`
// for system callers (automation-cron, bulk-email, indeed-parser, etc).
//
// Supported actions:
//   send_email             — send from the admin's mailbox
//   search_emails          — search the admin's mailbox
//   get_email_thread       — read a specific email / conversation
//   create_event           — create a calendar event in the admin's calendar
//   update_event           — update an existing event
//   get_calendar_events    — list upcoming events
//   check_availability     — free/busy calculation
//
// Auth: app-only (client credentials) against the Azure AD app. The app has
// Application-level permissions (Mail.ReadWrite, Mail.Send, Calendars.ReadWrite)
// with admin consent, which allows it to read/write any mailbox in the tenant.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function graphFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  const resp = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  return resp;
}

async function graphGet(token: string, path: string): Promise<any> {
  const resp = await graphFetch(token, path);
  if (!resp.ok) {
    throw new Error(`Graph GET ${path} failed: ${resp.status} - ${await resp.text()}`);
  }
  return resp.json();
}

// ─── Mailbox Resolution ───────────────────────────────────────────────────

async function resolveMailbox(supabase: any, adminEmail: string | null): Promise<string> {
  // 1. If admin_email provided, look up user_roles.mailbox_email (or use the email directly)
  if (adminEmail) {
    const lower = adminEmail.toLowerCase();
    const { data } = await supabase
      .from("user_roles")
      .select("mailbox_email, role")
      .eq("email", lower)
      .maybeSingle();
    if (data?.mailbox_email) return data.mailbox_email.toLowerCase();
    // Admin exists but no mailbox override — use their login email as the mailbox
    if (data) return lower;
    // Unknown user — still allow if it looks like an email (for system callers passing a raw address)
    if (lower.includes("@")) return lower;
  }
  // 2. Fallback — global system mailbox from app_settings
  const { data: settingRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "outlook_mailbox")
    .maybeSingle();
  const raw = settingRow?.value;
  if (typeof raw === "string" && raw.includes("@")) {
    return raw.replace(/^"|"$/g, "").toLowerCase();
  }
  if (raw && typeof raw === "object" && typeof raw.email === "string") {
    return raw.email.toLowerCase();
  }
  throw new Error("No mailbox configured: provide admin_email or set app_settings.outlook_mailbox");
}

async function resolveCalendarMailbox(supabase: any, adminEmail: string | null): Promise<string> {
  if (adminEmail) return resolveMailbox(supabase, adminEmail);
  // Calendar-specific fallback
  const { data: calRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "calendar_mailbox")
    .maybeSingle();
  const raw = calRow?.value;
  if (typeof raw === "string" && raw.includes("@")) {
    return raw.replace(/^"|"$/g, "").toLowerCase();
  }
  return resolveMailbox(supabase, null);
}

// ─── Formatting Helpers ───────────────────────────────────────────────────

function formatDisplay(iso: string | null): string {
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

function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function previewFrom(body: any): string {
  const text = typeof body === "string" ? body : htmlToText(body?.content || "");
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}

function attendeeEmails(attendees: any[]): string[] {
  if (!Array.isArray(attendees)) return [];
  return attendees.map((a) => a?.emailAddress?.address).filter(Boolean);
}

// ─── Actions ──────────────────────────────────────────────────────────────

async function sendEmail(token: string, mailbox: string, body: any): Promise<any> {
  const { to_email, to_name, subject, body: emailBody, cc } = body;
  if (!to_email || !subject || !emailBody) {
    throw new Error("send_email requires to_email, subject, body");
  }
  const message: any = {
    subject,
    body: { contentType: "Text", content: emailBody },
    toRecipients: [{ emailAddress: { address: to_email, name: to_name || undefined } }],
  };
  if (cc) {
    message.ccRecipients = [{ emailAddress: { address: cc } }];
  }
  const resp = await graphFetch(token, `/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!resp.ok) {
    throw new Error(`sendMail failed: ${resp.status} - ${await resp.text()}`);
  }
  return { success: true, mailbox, to_email, subject };
}

async function searchEmails(token: string, mailbox: string, body: any): Promise<any> {
  const daysBack = Math.min(Math.max(Number(body.days_back) || 30, 1), 90);
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();
  const filters: string[] = [`receivedDateTime ge ${since}`];
  const addr = body.email_address ? String(body.email_address).toLowerCase() : null;
  if (addr) {
    // Messages where the address appears as sender OR recipient
    filters.push(
      `(from/emailAddress/address eq '${addr}' or toRecipients/any(r:r/emailAddress/address eq '${addr}'))`,
    );
  }
  const filter = filters.join(" and ");
  const select = [
    "id",
    "conversationId",
    "subject",
    "from",
    "toRecipients",
    "receivedDateTime",
    "bodyPreview",
    "hasAttachments",
  ].join(",");
  let path = `/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(
    filter,
  )}&$top=${limit}&$select=${select}&$orderby=receivedDateTime desc`;
  if (body.keyword) {
    // $search and $filter can't be combined; prefer search when keyword is provided.
    path = `/users/${encodeURIComponent(mailbox)}/messages?$search="${encodeURIComponent(
      String(body.keyword),
    )}"&$top=${limit}&$select=${select}`;
  }
  const data = await graphGet(token, path);
  const emails = (data.value || []).map((m: any) => ({
    id: m.id,
    conversation_id: m.conversationId,
    subject: m.subject || "(no subject)",
    from: m.from?.emailAddress?.address || "",
    from_name: m.from?.emailAddress?.name || "",
    to: (m.toRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(", "),
    date: m.receivedDateTime,
    preview: m.bodyPreview || "",
    has_attachments: !!m.hasAttachments,
  }));
  return {
    mailbox,
    days_searched: daysBack,
    total_results: emails.length,
    emails,
  };
}

async function getEmailThread(token: string, mailbox: string, body: any): Promise<any> {
  const { email_id, conversation_id } = body;
  if (!email_id && !conversation_id) {
    throw new Error("get_email_thread requires email_id or conversation_id");
  }
  const select = [
    "id",
    "conversationId",
    "subject",
    "from",
    "toRecipients",
    "ccRecipients",
    "receivedDateTime",
    "body",
    "hasAttachments",
  ].join(",");
  let emails: any[] = [];
  if (conversation_id) {
    const filter = encodeURIComponent(`conversationId eq '${conversation_id}'`);
    const data = await graphGet(
      token,
      `/users/${encodeURIComponent(mailbox)}/messages?$filter=${filter}&$select=${select}&$orderby=receivedDateTime asc&$top=50`,
    );
    emails = data.value || [];
  } else {
    const m = await graphGet(
      token,
      `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(email_id)}?$select=${select}`,
    );
    emails = [m];
  }
  return {
    mailbox,
    total_messages: emails.length,
    emails: emails.map((m: any) => ({
      id: m.id,
      conversation_id: m.conversationId,
      subject: m.subject || "(no subject)",
      from: m.from?.emailAddress?.address || "",
      from_name: m.from?.emailAddress?.name || "",
      to: (m.toRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(", "),
      cc: (m.ccRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(", "),
      date: m.receivedDateTime,
      body: htmlToText(m.body?.content || ""),
      has_attachments: !!m.hasAttachments,
    })),
  };
}

async function createEvent(token: string, mailbox: string, body: any): Promise<any> {
  const { subject, start_datetime, end_datetime, attendees, location, description, is_online_meeting } = body;
  if (!subject || !start_datetime || !end_datetime) {
    throw new Error("create_event requires subject, start_datetime, end_datetime");
  }
  const payload: any = {
    subject,
    start: { dateTime: start_datetime, timeZone: TZ },
    end: { dateTime: end_datetime, timeZone: TZ },
    body: { contentType: "Text", content: description || "" },
    attendees: (attendees || []).map((a: string) => ({
      emailAddress: { address: a },
      type: "required",
    })),
  };
  if (location) payload.location = { displayName: location };
  if (is_online_meeting) {
    payload.isOnlineMeeting = true;
    payload.onlineMeetingProvider = "teamsForBusiness";
  }
  const resp = await graphFetch(token, `/users/${encodeURIComponent(mailbox)}/events`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`create_event failed: ${resp.status} - ${await resp.text()}`);
  }
  const ev = await resp.json();
  return {
    event_id: ev.id,
    subject: ev.subject,
    start_display: formatDisplay(ev.start?.dateTime),
    attendees_count: (payload.attendees || []).length,
    online_meeting_url: ev.onlineMeeting?.joinUrl || null,
    calendar_mailbox: mailbox,
  };
}

async function updateEvent(token: string, mailbox: string, body: any): Promise<any> {
  const { event_id, subject, start_datetime, end_datetime, location, description } = body;
  if (!event_id) throw new Error("update_event requires event_id");
  const payload: any = {};
  if (subject) payload.subject = subject;
  if (start_datetime) payload.start = { dateTime: start_datetime, timeZone: TZ };
  if (end_datetime) payload.end = { dateTime: end_datetime, timeZone: TZ };
  if (location) payload.location = { displayName: location };
  if (description) payload.body = { contentType: "Text", content: description };
  const resp = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/events/${encodeURIComponent(event_id)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
  if (!resp.ok) {
    throw new Error(`update_event failed: ${resp.status} - ${await resp.text()}`);
  }
  const ev = await resp.json();
  return {
    event_id: ev.id,
    subject: ev.subject,
    start_display: formatDisplay(ev.start?.dateTime),
    calendar_mailbox: mailbox,
  };
}

async function getCalendarEvents(token: string, mailbox: string, body: any): Promise<any> {
  const start = body.start_date || new Date().toISOString().split("T")[0];
  const endDefault = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
  const end = body.end_date || endDefault;
  const startISO = `${start}T00:00:00`;
  const endISO = `${end}T23:59:59`;
  const select = [
    "id",
    "subject",
    "organizer",
    "showAs",
    "location",
    "attendees",
    "bodyPreview",
    "start",
    "end",
    "onlineMeeting",
  ].join(",");
  const path =
    `/users/${encodeURIComponent(mailbox)}/calendarView` +
    `?startDateTime=${encodeURIComponent(startISO)}` +
    `&endDateTime=${encodeURIComponent(endISO)}` +
    `&$select=${select}&$top=50&$orderby=start/dateTime asc`;
  const resp = await fetch(`${GRAPH}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: `outlook.timezone="${TZ}"`,
    },
  });
  if (!resp.ok) {
    throw new Error(`get_calendar_events failed: ${resp.status} - ${await resp.text()}`);
  }
  const data = await resp.json();
  let events = (data.value || []).map((e: any) => ({
    id: e.id,
    subject: e.subject || "(no subject)",
    organizer: e.organizer?.emailAddress?.address || "",
    show_as: e.showAs || "busy",
    location: e.location?.displayName || "No location",
    attendees: attendeeEmails(e.attendees || []),
    preview: e.bodyPreview || "",
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    start_display: formatDisplay(e.start?.dateTime),
    end_display: formatDisplay(e.end?.dateTime),
    online_meeting_url: e.onlineMeeting?.joinUrl || null,
  }));
  if (body.attendee_email) {
    const needle = String(body.attendee_email).toLowerCase();
    events = events.filter(
      (e: any) =>
        e.organizer.toLowerCase() === needle ||
        e.attendees.some((a: string) => a.toLowerCase() === needle),
    );
  }
  return {
    calendar_mailbox: mailbox,
    start_date: start,
    end_date: end,
    total_events: events.length,
    events,
  };
}

async function checkAvailability(token: string, mailbox: string, body: any): Promise<any> {
  const date = body.date;
  let startISO: string;
  let endISO: string;
  if (date) {
    startISO = `${date}T08:00:00`;
    endISO = `${date}T18:00:00`;
  } else {
    const s = body.start_date || new Date().toISOString().split("T")[0];
    const e = body.end_date || s;
    startISO = s.includes("T") ? s : `${s}T00:00:00`;
    endISO = e.includes("T") ? e : `${e}T23:59:59`;
  }
  const calData = await getCalendarEvents(token, mailbox, {
    start_date: startISO.split("T")[0],
    end_date: endISO.split("T")[0],
  });
  const rangeStartMs = new Date(startISO).getTime();
  const rangeEndMs = new Date(endISO).getTime();
  const busy = calData.events
    .filter((e: any) => e.show_as !== "free")
    .map((e: any) => ({
      start: e.start,
      end: e.end,
      subject: e.subject,
      status: e.show_as,
    }))
    .filter((s: any) => {
      const sMs = new Date(s.start).getTime();
      const eMs = new Date(s.end).getTime();
      return eMs > rangeStartMs && sMs < rangeEndMs;
    })
    .sort((a: any, b: any) => new Date(a.start).getTime() - new Date(b.start).getTime());

  // Compute free slots (inverse of busy within [startISO, endISO])
  const freeSlots: any[] = [];
  let cursor = rangeStartMs;
  for (const b of busy) {
    const bStart = new Date(b.start).getTime();
    const bEnd = new Date(b.end).getTime();
    if (bStart > cursor) {
      freeSlots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(bStart).toISOString(),
        duration_minutes: Math.round((bStart - cursor) / 60000),
      });
    }
    cursor = Math.max(cursor, bEnd);
  }
  if (cursor < rangeEndMs) {
    freeSlots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(rangeEndMs).toISOString(),
      duration_minutes: Math.round((rangeEndMs - cursor) / 60000),
    });
  }
  const usable = freeSlots.filter((s) => s.duration_minutes >= 15);
  return {
    calendar_mailbox: mailbox,
    date_range: { start: startISO, end: endISO },
    summary: `${busy.length} busy slot(s), ${usable.length} free slot(s) ≥15min`,
    busy_slots: busy,
    free_slots: usable,
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
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();
    const action = body.action;
    const adminEmail: string | null = body.admin_email || null;

    const token = await getGraphToken();

    let result: any;
    if (action === "send_email") {
      const mailbox = await resolveMailbox(supabase, adminEmail);
      result = await sendEmail(token, mailbox, body);
    } else if (action === "search_emails") {
      const mailbox = await resolveMailbox(supabase, adminEmail);
      result = await searchEmails(token, mailbox, body);
    } else if (action === "get_email_thread") {
      const mailbox = await resolveMailbox(supabase, adminEmail);
      result = await getEmailThread(token, mailbox, body);
    } else if (action === "create_event") {
      const mailbox = await resolveCalendarMailbox(supabase, adminEmail);
      result = await createEvent(token, mailbox, body);
    } else if (action === "update_event") {
      const mailbox = await resolveCalendarMailbox(supabase, adminEmail);
      result = await updateEvent(token, mailbox, body);
    } else if (action === "get_calendar_events") {
      const mailbox = await resolveCalendarMailbox(supabase, adminEmail);
      result = await getCalendarEvents(token, mailbox, body);
    } else if (action === "check_availability") {
      const mailbox = await resolveCalendarMailbox(supabase, adminEmail);
      result = await checkAvailability(token, mailbox, body);
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
    console.error("outlook-integration error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
