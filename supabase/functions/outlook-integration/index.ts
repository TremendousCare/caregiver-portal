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

import { createClient } from "jsr:@supabase/supabase-js@2";

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

// Resolve the email_from_address + email_from_name for a given route.
// Returns { mailbox, fromName } or null if the route is missing / inactive
// / has no email sender configured. Caller decides whether to fall back.
async function resolveRoute(
  supabase: any,
  category: string | null,
): Promise<{ mailbox: string; fromName: string | null } | null> {
  if (!category) return null;
  const { data } = await supabase
    .from("communication_routes")
    .select("email_from_address, email_from_name, is_active")
    .eq("category", category)
    .maybeSingle();
  if (!data || data.is_active === false) return null;
  const addr = typeof data.email_from_address === "string"
    ? data.email_from_address.trim().toLowerCase()
    : "";
  if (!addr.includes("@")) return null;
  const name = typeof data.email_from_name === "string" && data.email_from_name.trim()
    ? data.email_from_name.trim()
    : null;
  return { mailbox: addr, fromName: name };
}

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

async function sendEmail(
  token: string,
  mailbox: string,
  body: any,
  fromName?: string | null,
  supabase?: any,
): Promise<any> {
  const { to_email, to_name, subject, body: emailBody, cc, attachment_file_ids } = body;
  if (!to_email || !subject || !emailBody) {
    throw new Error("send_email requires to_email, subject, body");
  }

  const attachmentIds = Array.isArray(attachment_file_ids)
    ? attachment_file_ids.filter((x: any) => typeof x === "string" && x.length > 0)
    : [];

  // When there are no attachments, take the simple one-call /sendMail
  // path — it's the hot path for every existing automation, and
  // changing it would also force the bulk-email and ai-chat callers
  // through a draft+send flow they don't need.
  if (attachmentIds.length === 0) {
    const message: any = {
      subject,
      body: { contentType: "Text", content: emailBody },
      toRecipients: [{ emailAddress: { address: to_email, name: to_name || undefined } }],
    };
    if (fromName) {
      // Setting `from` lets us control the recipient's "From" display name
      // when the mailbox's default doesn't match (e.g. shared mailboxes
      // or when we want a friendlier label than the M365 user object).
      // Address must equal the mailbox we POST to — Graph rejects mismatches
      // unless the app holds explicit Send-As permission, which we don't
      // need with tenant-wide application Mail.Send.
      message.from = { emailAddress: { address: mailbox, name: fromName } };
    }
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

  // Attachment path: create a draft, attach each file (inline for
  // small files, chunked upload session for large ones), then send.
  // This is the only Graph path that supports attachments >3MB.
  if (!supabase) {
    throw new Error("send_email with attachments requires a supabase client");
  }
  return await sendEmailWithAttachments(
    token,
    mailbox,
    {
      to_email,
      to_name,
      subject,
      body: emailBody,
      cc,
      attachment_file_ids: attachmentIds,
    },
    fromName ?? null,
    supabase,
  );
}

// Hard ceilings to keep us safely under M365's per-message limits.
// Outlook's effective inbound limit on most M365 tenants is 25MB,
// but partner-tenant rules vary. 20MB total + 20MB per file gives us
// headroom and surfaces "too big" errors at config time, not send time.
const MAX_ATTACHMENT_BYTES_PER_FILE = 20 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_TOTAL = 20 * 1024 * 1024;
// Files smaller than this go in as a single POST .../attachments.
// Larger files use the chunked upload-session flow. 3MB is Microsoft's
// documented threshold for attachment uploads.
const INLINE_ATTACHMENT_THRESHOLD = 3 * 1024 * 1024;
// Upload-session chunk size. Graph rejects chunks larger than 4MB; we
// stay a touch under that. Chunks do NOT need to be 320KiB-aligned —
// that's a OneDrive-only requirement.
const UPLOAD_SESSION_CHUNK_BYTES = 3 * 1024 * 1024;

// Base64-encode a Uint8Array without blowing the call stack. The
// naive `btoa(String.fromCharCode(...bytes))` form fails on inputs
// over ~64KB on most JS runtimes.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sendEmailWithAttachments(
  token: string,
  mailbox: string,
  body: {
    to_email: string;
    to_name?: string | null;
    subject: string;
    body: string;
    cc?: string | null;
    attachment_file_ids: string[];
  },
  fromName: string | null,
  supabase: any,
): Promise<any> {
  // 1. Load attachment metadata.
  const { data: files, error: filesErr } = await supabase
    .from("email_attachment_files")
    .select("id, file_name, storage_path, content_type, size_bytes")
    .in("id", body.attachment_file_ids);
  if (filesErr) {
    throw new Error(`Failed to load attachment metadata: ${filesErr.message}`);
  }
  if (!files || files.length === 0) {
    throw new Error("send_email: attachment_file_ids provided but no matching files found");
  }
  if (files.length !== body.attachment_file_ids.length) {
    const found = new Set(files.map((f: any) => f.id));
    const missing = body.attachment_file_ids.filter((id) => !found.has(id));
    throw new Error(`send_email: attachment file(s) not found: ${missing.join(", ")}`);
  }

  // Preserve the order the caller specified so previews and emails
  // match. Postgres `.in()` returns whatever order it likes.
  const orderIndex = new Map(body.attachment_file_ids.map((id, idx) => [id, idx]));
  files.sort((a: any, b: any) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));

  // 2. Validate sizes before we incur Graph API roundtrips.
  let totalBytes = 0;
  for (const f of files) {
    if (typeof f.size_bytes !== "number" || f.size_bytes <= 0) {
      throw new Error(`Attachment ${f.file_name} has invalid size_bytes (${f.size_bytes})`);
    }
    if (f.size_bytes > MAX_ATTACHMENT_BYTES_PER_FILE) {
      throw new Error(
        `Attachment ${f.file_name} is ${(f.size_bytes / 1024 / 1024).toFixed(1)}MB — exceeds per-file cap of ${MAX_ATTACHMENT_BYTES_PER_FILE / 1024 / 1024}MB`,
      );
    }
    totalBytes += f.size_bytes;
  }
  if (totalBytes > MAX_ATTACHMENT_BYTES_TOTAL) {
    throw new Error(
      `Attachments total ${(totalBytes / 1024 / 1024).toFixed(1)}MB — exceeds combined cap of ${MAX_ATTACHMENT_BYTES_TOTAL / 1024 / 1024}MB`,
    );
  }

  // 3. Download every file from Storage in parallel — these are
  // independent network calls and we already validated sizes.
  const downloads = await Promise.all(
    files.map(async (f: any) => {
      const { data: blob, error } = await supabase.storage
        .from("email-attachments")
        .download(f.storage_path);
      if (error || !blob) {
        throw new Error(`Failed to download ${f.file_name}: ${error?.message || "no blob"}`);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { ...f, bytes };
    }),
  );

  // 4. Create the draft message.
  const draftMessage: any = {
    subject: body.subject,
    body: { contentType: "Text", content: body.body },
    toRecipients: [
      { emailAddress: { address: body.to_email, name: body.to_name || undefined } },
    ],
  };
  if (fromName) {
    draftMessage.from = { emailAddress: { address: mailbox, name: fromName } };
  }
  if (body.cc) {
    draftMessage.ccRecipients = [{ emailAddress: { address: body.cc } }];
  }
  const draftResp = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages`,
    { method: "POST", body: JSON.stringify(draftMessage) },
  );
  if (!draftResp.ok) {
    throw new Error(`Create draft failed: ${draftResp.status} - ${await draftResp.text()}`);
  }
  const draft = await draftResp.json();
  const messageId = draft.id as string;

  // 5. Attach each file. Inline POST for <3MB, chunked upload session
  // for >=3MB. We attach sequentially to keep error reporting clean —
  // if file 3 of 5 fails we want a specific error, not a Promise.all
  // rejection that hides which one. Throughput is fine: the hot
  // path is ~5 PDFs once a day.
  for (const f of downloads) {
    try {
      if (f.bytes.length < INLINE_ATTACHMENT_THRESHOLD) {
        await attachInline(token, mailbox, messageId, f);
      } else {
        await attachViaUploadSession(token, mailbox, messageId, f);
      }
    } catch (err) {
      // Best-effort cleanup so we don't leave orphan drafts in the
      // sender's Drafts folder if an attachment fails mid-stream.
      await graphFetch(
        token,
        `/users/${encodeURIComponent(mailbox)}/messages/${messageId}`,
        { method: "DELETE" },
      ).catch(() => {});
      throw err;
    }
  }

  // 6. Send the draft.
  const sendResp = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/send`,
    { method: "POST" },
  );
  if (!sendResp.ok) {
    throw new Error(`Send draft failed: ${sendResp.status} - ${await sendResp.text()}`);
  }
  return {
    success: true,
    mailbox,
    to_email: body.to_email,
    subject: body.subject,
    attachments_count: files.length,
    attachments_bytes: totalBytes,
  };
}

async function attachInline(
  token: string,
  mailbox: string,
  messageId: string,
  file: { file_name: string; content_type: string; bytes: Uint8Array },
): Promise<void> {
  const resp = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`,
    {
      method: "POST",
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: file.file_name,
        contentType: file.content_type || "application/octet-stream",
        contentBytes: bytesToBase64(file.bytes),
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`Inline attach ${file.file_name} failed: ${resp.status} - ${await resp.text()}`);
  }
}

async function attachViaUploadSession(
  token: string,
  mailbox: string,
  messageId: string,
  file: { file_name: string; content_type: string; bytes: Uint8Array },
): Promise<void> {
  const total = file.bytes.length;
  const sessionResp = await graphFetch(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
    {
      method: "POST",
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: "file",
          name: file.file_name,
          size: total,
          contentType: file.content_type || "application/octet-stream",
        },
      }),
    },
  );
  if (!sessionResp.ok) {
    throw new Error(
      `Create upload session for ${file.file_name} failed: ${sessionResp.status} - ${await sessionResp.text()}`,
    );
  }
  const { uploadUrl } = await sessionResp.json();
  if (!uploadUrl) {
    throw new Error(`Upload session for ${file.file_name} returned no uploadUrl`);
  }

  let start = 0;
  while (start < total) {
    const end = Math.min(start + UPLOAD_SESSION_CHUNK_BYTES, total);
    const chunk = file.bytes.subarray(start, end);
    // The upload URL is pre-authenticated — do not send the Graph
    // bearer token to it; Microsoft explicitly returns 400 if you do.
    const chunkResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end - 1}/${total}`,
      },
      body: chunk,
    });
    if (!chunkResp.ok && chunkResp.status !== 201 && chunkResp.status !== 200 && chunkResp.status !== 202) {
      throw new Error(
        `Upload chunk for ${file.file_name} failed at byte ${start}: ${chunkResp.status} - ${await chunkResp.text()}`,
      );
    }
    start = end;
  }
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
    const category: string | null = typeof body.category === "string" && body.category.trim()
      ? body.category.trim()
      : null;

    const token = await getGraphToken();

    let result: any;
    if (action === "send_email") {
      // Resolution order for outbound email:
      //   1. category → communication_routes.email_from_address (+ name)
      //   2. admin_email → user_roles.mailbox_email (per-admin override)
      //   3. global app_settings.outlook_mailbox
      // Categories are how sequences and route-aware automation rules
      // pick a sender; admin_email is for per-user UI sends; the
      // global default catches everything else.
      const route = await resolveRoute(supabase, category);
      let mailbox: string;
      let fromName: string | null = null;
      if (route) {
        mailbox = route.mailbox;
        fromName = route.fromName;
      } else {
        mailbox = await resolveMailbox(supabase, adminEmail);
      }
      result = await sendEmail(token, mailbox, body, fromName, supabase);
      result.routeUsed = route ? category : null;
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
