import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════
// Indeed Email Parser — Cron-triggered Edge Function
//
// Polls the configured Outlook mailbox for Indeed notification
// emails, parses applicant data, and pushes entries into the
// intake_queue for processing by the existing intake-processor.
//
// Called by pg_cron every 5 minutes.
//
// Deploy: npx supabase functions deploy indeed-email-parser --no-verify-jwt
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ─── Microsoft Auth (same pattern as automation-cron) ─────────

async function getMicrosoftToken(): Promise<string | null> {
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
  const tenantId = Deno.env.get("MICROSOFT_TENANT_ID");
  if (!clientId || !clientSecret || !tenantId) return null;

  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `client_id=${clientId}&client_secret=${encodeURIComponent(clientSecret)}&scope=https://graph.microsoft.com/.default&grant_type=client_credentials`,
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.access_token;
  } catch {
    return null;
  }
}

// ─── Indeed Email Detection ───────────────────────────────────

function isFromIndeed(senderAddress: string): boolean {
  if (!senderAddress) return false;
  return senderAddress.toLowerCase().trim().endsWith("@indeed.com");
}

// ─── Email Parsing (mirrors src/lib/indeedEmailParser.js) ─────
// Duplicated here because Edge Functions run in Deno and can't
// import from src/lib/. If you change parsing logic, update both.

function parseSubject(
  subject: string
): { applicantName: string | null; jobTitle: string | null } {
  if (!subject) return { applicantName: null, jobTitle: null };

  // "Indeed Application: Job Title - Applicant Name"
  const fmt1 = subject.match(/Indeed Application:\s*(.+?)\s*-\s*([^-]+)$/i);
  if (fmt1) return { jobTitle: fmt1[1].trim(), applicantName: fmt1[2].trim() };

  // "Applicant Name applied to your Job Title job"
  const fmt2 = subject.match(
    /^(.+?)\s+applied to (?:your\s+)?(.+?)(?:\s+job)?$/i
  );
  if (fmt2) return { applicantName: fmt2[1].trim(), jobTitle: fmt2[2].trim() };

  // "New application: Job Title"
  const fmt3 = subject.match(/New application:\s*(.+)$/i);
  if (fmt3) return { applicantName: null, jobTitle: fmt3[1].trim() };

  return { applicantName: null, jobTitle: null };
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  if (!fullName) return { firstName: "", lastName: "" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

function extractLabeledValue(text: string, labels: string[]): string | null {
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  for (const label of sorted) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped + "\\s*:\\s*([^\\n<]+)", "i");
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function extractEmail(text: string): string | null {
  if (!text) return null;
  const labeled = extractLabeledValue(text, [
    "Email",
    "E-mail",
    "Email Address",
  ]);
  if (labeled) {
    const m = labeled.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
    if (m) return m[0].toLowerCase();
  }
  const allEmails = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/g);
  if (allEmails) {
    const nonIndeed = allEmails.find(
      (e) => !e.toLowerCase().endsWith("@indeed.com")
    );
    if (nonIndeed) return nonIndeed.toLowerCase();
  }
  return null;
}

function extractPhone(text: string): string | null {
  if (!text) return null;
  const labeled = extractLabeledValue(text, [
    "Phone Number",
    "Phone",
    "Tel",
    "Mobile",
    "Cell",
  ]);
  if (labeled) {
    const digits = labeled.replace(/\D/g, "");
    if (digits.length >= 7) return labeled;
  }
  const patterns = [
    /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
    /\+?1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

function normalizePhone(raw: string): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function extractLocation(text: string): { city: string; state: string } {
  if (!text) return { city: "", state: "" };
  const labeled = extractLabeledValue(text, [
    "Location",
    "City",
    "Address",
  ]);
  if (labeled) {
    const m = labeled.match(/^([^,]+),\s*([A-Z]{2})\b/i);
    if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
    return { city: labeled, state: "" };
  }
  const cityState = text.match(/([A-Z][a-zA-Z ]+),\s*([A-Z]{2})\b/);
  if (cityState) {
    return { city: cityState[1].trim(), state: cityState[2].trim() };
  }
  return { city: "", state: "" };
}

interface ParsedApplicant {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  source: string;
  source_detail: string;
  jobTitle: string;
  messageId: string;
}

function parseIndeedEmailBody(
  subject: string,
  bodyHtml: string,
  messageId: string
): ParsedApplicant | null {
  const { applicantName, jobTitle } = parseSubject(subject);
  const plainText = stripHtml(bodyHtml || "");

  let firstName = "";
  let lastName = "";
  if (applicantName) {
    const split = splitName(applicantName);
    firstName = split.firstName;
    lastName = split.lastName;
  }

  const email = extractEmail(plainText) || "";
  const rawPhone = extractPhone(plainText);
  const phone = normalizePhone(rawPhone || "");
  const { city, state } = extractLocation(plainText);

  // Need at least a name or email to be useful
  if (!firstName && !email) return null;

  return {
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    city,
    state,
    source: "Indeed",
    source_detail: jobTitle || "",
    jobTitle: jobTitle || "",
    messageId,
  };
}

// ─── Main Handler ─────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const summary = {
    emails_checked: 0,
    emails_parsed: 0,
    queued: 0,
    skipped_already_processed: 0,
    skipped_parse_failed: 0,
    errors: [] as string[],
  };

  try {
    // ── 1. Get routing config ──────────────────────────────────
    // Find email accounts routed for indeed_parsing

    const { data: routes, error: routeErr } = await supabase
      .from("email_routing")
      .select("*, email_accounts(*)")
      .eq("function_name", "indeed_parsing")
      .eq("enabled", true);

    if (routeErr) {
      console.error("Failed to fetch email routing:", routeErr);
      return new Response(
        JSON.stringify({ error: "Failed to fetch routing config" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!routes || routes.length === 0) {
      console.log("No enabled indeed_parsing routes found");
      return new Response(
        JSON.stringify({ message: "No routes configured", ...summary }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 2. Get Microsoft token ─────────────────────────────────

    const msToken = await getMicrosoftToken();
    if (!msToken) {
      console.error("Failed to get Microsoft token");
      return new Response(
        JSON.stringify({ error: "Microsoft auth failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 3. Process each route ──────────────────────────────────

    for (const route of routes) {
      const account = route.email_accounts;
      if (!account || !account.enabled || !account.email_address) continue;

      const mailbox = account.email_address;
      const senderFilter =
        route.filter_rules?.sender_contains || "indeed.com";

      // Determine time window: check since last_checked_at or last 30 minutes
      const lastChecked = route.last_checked_at
        ? new Date(route.last_checked_at)
        : new Date(Date.now() - 30 * 60 * 1000);

      const sinceISO = lastChecked.toISOString();
      const nowISO = new Date().toISOString();

      console.log(
        `Checking ${mailbox} for Indeed emails since ${sinceISO}`
      );

      // ── 4. Query Microsoft Graph for emails ─────────────────

      try {
        const filter = encodeURIComponent(
          `receivedDateTime ge ${sinceISO} and from/emailAddress/address eq '${senderFilter}' or (receivedDateTime ge ${sinceISO} and contains(from/emailAddress/address, '${senderFilter}'))`
        );

        // Use a simpler, more reliable filter approach
        const searchFilter = encodeURIComponent(
          `receivedDateTime ge ${sinceISO}`
        );

        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$filter=${searchFilter}&$top=50&$select=id,subject,from,receivedDateTime,body&$orderby=receivedDateTime desc`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${msToken}` },
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(
            `Graph API error for ${mailbox}: ${response.status} ${errText}`
          );
          summary.errors.push(
            `Graph API ${response.status} for ${mailbox}`
          );
          continue;
        }

        const data = await response.json();
        const messages = data.value || [];

        // Filter to Indeed emails only
        const indeedMessages = messages.filter((msg: any) => {
          const senderAddr =
            msg.from?.emailAddress?.address || "";
          return isFromIndeed(senderAddr);
        });

        summary.emails_checked += indeedMessages.length;
        console.log(
          `Found ${indeedMessages.length} Indeed emails in ${mailbox}`
        );

        // ── 5. Process each Indeed email ──────────────────────

        for (const msg of indeedMessages) {
          const messageId: string = msg.id;
          const subject: string = msg.subject || "";
          const bodyHtml: string = msg.body?.content || "";
          const receivedAt: string = msg.receivedDateTime || "";

          // Check if we already processed this email (dedup by messageId)
          const { data: existing } = await supabase
            .from("intake_queue")
            .select("id")
            .eq("source", "Indeed")
            .eq("raw_payload->>_messageId", messageId)
            .limit(1);

          if (existing && existing.length > 0) {
            summary.skipped_already_processed++;
            continue;
          }

          // Parse the email
          const parsed = parseIndeedEmailBody(subject, bodyHtml, messageId);

          if (!parsed) {
            console.warn(
              `Could not parse Indeed email: ${subject}`
            );
            summary.skipped_parse_failed++;
            continue;
          }

          summary.emails_parsed++;

          // ── 6. Push to intake_queue ────────────────────────

          const payload: Record<string, any> = {
            first_name: parsed.first_name,
            last_name: parsed.last_name,
            email: parsed.email,
            phone: parsed.phone,
            city: parsed.city,
            state: parsed.state,
            // Metadata for tracking
            _source: "Indeed",
            _jobTitle: parsed.jobTitle,
            _messageId: parsed.messageId,
            _receivedAt: receivedAt,
            _parsedAt: new Date().toISOString(),
          };

          const { error: insertErr } = await supabase
            .from("intake_queue")
            .insert({
              source: "Indeed",
              entity_type: "caregiver",
              raw_payload: payload,
              api_key_label: "indeed-email-parser",
              status: "pending",
            });

          if (insertErr) {
            console.error(
              `Failed to queue Indeed applicant: ${insertErr.message}`
            );
            summary.errors.push(
              `Queue insert failed: ${insertErr.message}`
            );
          } else {
            summary.queued++;
            console.log(
              `Queued Indeed applicant: ${parsed.first_name} ${parsed.last_name} (${parsed.email})`
            );
          }
        }
      } catch (err: any) {
        console.error(
          `Error processing mailbox ${mailbox}:`,
          err
        );
        summary.errors.push(
          `Mailbox ${mailbox}: ${err.message || String(err)}`
        );
      }

      // ── 7. Update last_checked_at ───────────────────────────

      await supabase
        .from("email_routing")
        .update({ last_checked_at: nowISO })
        .eq("id", route.id);
    }
  } catch (err: any) {
    console.error("indeed-email-parser fatal error:", err);
    return new Response(
      JSON.stringify({
        error: err.message || String(err),
        ...summary,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log("indeed-email-parser summary:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
