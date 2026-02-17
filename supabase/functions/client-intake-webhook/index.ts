import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════
// Client Intake Webhook — Generic form intake endpoint
//
// Receives POST from WordPress (Forminator/CF7), Google Ads,
// Meta lead ads, or any external source. Validates an API key,
// maps fields to the clients table, deduplicates, creates the
// record, and fires automations + sequences server-side.
//
// Deploy: npx supabase functions deploy client-intake-webhook --no-verify-jwt
// ═══════════════════════════════════════════════════════════════

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ─── Field Mapping ──────────────────────────────────────────
// Maps various incoming field names to clients table columns.
// First match wins — order matters for aliases.
const FIELD_MAP: Record<string, string> = {
  // Direct snake_case matches
  first_name: "first_name",
  last_name: "last_name",
  phone: "phone",
  email: "email",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  care_recipient_name: "care_recipient_name",
  care_recipient_age: "care_recipient_age",
  relationship: "relationship",
  care_needs: "care_needs",
  hours_needed: "hours_needed",
  start_date_preference: "start_date_preference",
  budget_range: "budget_range",
  insurance_info: "insurance_info",
  priority: "priority",
  contact_name: "contact_name",

  // camelCase aliases
  firstName: "first_name",
  lastName: "last_name",
  careRecipientName: "care_recipient_name",
  careRecipientAge: "care_recipient_age",
  careNeeds: "care_needs",
  hoursNeeded: "hours_needed",
  startDatePreference: "start_date_preference",
  budgetRange: "budget_range",
  insuranceInfo: "insurance_info",
  contactName: "contact_name",

  // Forminator auto-generated field IDs
  "name-1": "first_name",
  "name-2": "last_name",
  "email-1": "email",
  "phone-1": "phone",
  "textarea-1": "care_needs",

  // Common generic names
  name: "_full_name",
  full_name: "_full_name",
  fullname: "_full_name",
  message: "care_needs",
  comments: "care_needs",
  notes: "care_needs",

  // Google Ads Lead Form fields
  user_email: "email",
  phone_number: "phone",
  postal_code: "zip",
  street_address: "address",

  // Meta/Facebook Lead Ad fields
  email_fb: "email",
  phone_number_fb: "phone",
  zip_code: "zip",
};

// Skip these fields during mapping
const SKIP_FIELDS = new Set([
  "api_key",
  "_field_map",
  "hub.mode",
  "hub.verify_token",
  "hub.challenge",
  "consent",
  "gdpr",
  "privacy",
  "terms",
  "_wp_nonce",
  "action",
  "form_id",
  "referer_url",
  "current_url",
  "entry",
]);

// ─── Helpers ────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function resolveClientMergeFields(
  template: string,
  client: Record<string, string>
): string {
  return template
    .replace(/\{\{first_name\}\}/g, client.first_name || "")
    .replace(/\{\{last_name\}\}/g, client.last_name || "")
    .replace(/\{\{phone\}\}/g, client.phone || "")
    .replace(/\{\{email\}\}/g, client.email || "");
}

function normalizeSequenceAction(actionType: string): string {
  switch (actionType) {
    case "send_sms":
    case "sms":
      return "send_sms";
    case "send_email":
    case "email":
      return "send_email";
    case "create_task":
    case "task":
      return "create_task";
    default:
      return actionType;
  }
}

// ─── API Key Validation ─────────────────────────────────────

interface ApiKeyResult {
  valid: boolean;
  source?: string;
  label?: string;
}

async function validateApiKey(
  supabase: any,
  apiKey: string | null
): Promise<ApiKeyResult> {
  if (!apiKey) return { valid: false };

  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "intake_webhook_keys")
    .single();

  if (!data?.value || !Array.isArray(data.value)) return { valid: false };

  const match = data.value.find(
    (entry: any) => entry.key === apiKey && entry.enabled !== false
  );

  if (!match) return { valid: false };
  return { valid: true, source: match.source, label: match.label };
}

// ─── Field Mapping ──────────────────────────────────────────

function mapIncomingFields(
  body: Record<string, any>,
  customMap?: Record<string, string>
): { clientData: Record<string, any>; unmappedFields: Record<string, any> } {
  const clientData: Record<string, any> = {};
  const unmappedFields: Record<string, any> = {};

  // Merge custom field map with default
  const effectiveMap = customMap
    ? { ...FIELD_MAP, ...customMap }
    : FIELD_MAP;

  for (const [key, value] of Object.entries(body)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (value === null || value === undefined || value === "") continue;

    const mappedField = effectiveMap[key];

    if (mappedField === "_full_name") {
      // Split full name into first + last
      const parts = String(value).trim().split(/\s+/);
      if (!clientData.first_name) clientData.first_name = parts[0] || "";
      if (!clientData.last_name)
        clientData.last_name = parts.slice(1).join(" ") || "";
    } else if (mappedField) {
      // First match wins
      if (!clientData[mappedField]) {
        clientData[mappedField] = String(value).trim();
      }
    } else {
      unmappedFields[key] = value;
    }
  }

  return { clientData, unmappedFields };
}

// ─── Duplicate Detection ────────────────────────────────────

async function findExistingClient(
  supabase: any,
  phone: string | null,
  email: string | null
): Promise<any | null> {
  if (!phone && !email) return null;

  // Check email first (case-insensitive)
  if (email) {
    const { data: emailMatch } = await supabase
      .from("clients")
      .select("id, first_name, last_name, phone, email, notes")
      .ilike("email", email.trim())
      .eq("archived", false)
      .limit(1);
    if (emailMatch && emailMatch.length > 0) return emailMatch[0];
  }

  // Check phone (normalized comparison)
  if (phone) {
    const normalized = normalizePhone(phone);
    if (normalized.length >= 10) {
      const { data: allClients } = await supabase
        .from("clients")
        .select("id, first_name, last_name, phone, email, notes")
        .eq("archived", false)
        .neq("phone", "");

      if (allClients) {
        const match = allClients.find(
          (c: any) => c.phone && normalizePhone(c.phone) === normalized
        );
        if (match) return match;
      }
    }
  }

  return null;
}

// ─── Automation Triggers (server-side) ──────────────────────

async function fireAutomationRules(
  supabase: any,
  client: Record<string, any>
): Promise<void> {
  try {
    const { data: rules } = await supabase
      .from("automation_rules")
      .select("*")
      .eq("trigger_type", "new_client")
      .eq("entity_type", "client")
      .eq("enabled", true);

    if (!rules || rules.length === 0) return;

    const clientPayload = {
      id: client.id,
      first_name: client.first_name || "",
      last_name: client.last_name || "",
      phone: client.phone || "",
      email: client.email || "",
      phase: client.phase || "new_lead",
    };

    for (const rule of rules) {
      // Evaluate phase condition
      const conds = rule.conditions || {};
      if (conds.phase && client.phase !== conds.phase) continue;

      try {
        await supabase.functions.invoke("execute-automation", {
          body: {
            rule_id: rule.id,
            caregiver_id: client.id,
            entity_type: "client",
            action_type: rule.action_type,
            message_template: rule.message_template,
            action_config: rule.action_config,
            rule_name: rule.name,
            caregiver: clientPayload,
            trigger_context: {},
          },
        });
      } catch (err) {
        console.error(`Automation rule ${rule.id} failed:`, err);
      }
    }
  } catch (err) {
    console.error("fireAutomationRules error:", err);
  }
}

async function fireSequences(
  supabase: any,
  client: Record<string, any>
): Promise<void> {
  try {
    const phase = client.phase || "new_lead";

    const { data: sequences } = await supabase
      .from("client_sequences")
      .select("*")
      .eq("trigger_phase", phase)
      .eq("enabled", true);

    if (!sequences || sequences.length === 0) return;

    const clientPayload = {
      id: client.id,
      first_name: client.first_name || "",
      last_name: client.last_name || "",
      phone: client.phone || "",
      email: client.email || "",
      phase,
    };

    const nowMs = Date.now();

    for (const sequence of sequences) {
      const steps = sequence.steps || [];
      if (steps.length === 0) continue;

      // Check if already enrolled
      const { data: existing } = await supabase
        .from("client_sequence_log")
        .select("id")
        .eq("sequence_id", sequence.id)
        .eq("client_id", client.id)
        .limit(1);

      if (existing && existing.length > 0) continue;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const delayHours = step.delay_hours || 0;
        const actionType = normalizeSequenceAction(step.action_type);

        if (delayHours === 0) {
          // Immediate execution
          if (actionType === "send_sms" || actionType === "send_email") {
            const resolvedTemplate = resolveClientMergeFields(
              step.template || "",
              clientPayload
            );

            try {
              await supabase.functions.invoke("execute-automation", {
                body: {
                  rule_id: `seq_${sequence.id}_step_${i}`,
                  caregiver_id: client.id,
                  entity_type: "client",
                  action_type: actionType,
                  message_template: resolvedTemplate,
                  action_config:
                    actionType === "send_email"
                      ? {
                          subject: resolveClientMergeFields(
                            step.subject || "Message from Tremendous Care",
                            clientPayload
                          ),
                        }
                      : {},
                  rule_name: `${sequence.name} - Step ${i + 1}`,
                  caregiver: clientPayload,
                },
              });
            } catch (err) {
              console.error(`Sequence step ${i} failed:`, err);
            }
          } else if (actionType === "create_task") {
            const resolvedTemplate = resolveClientMergeFields(
              step.template || "",
              clientPayload
            );
            const { data: freshClient } = await supabase
              .from("clients")
              .select("notes")
              .eq("id", client.id)
              .single();
            const notes = freshClient?.notes || [];
            notes.push({
              text: resolvedTemplate,
              type: "task",
              timestamp: nowMs,
              author: "Automation",
              outcome: `Sequence: ${sequence.name}, Step ${i + 1}`,
            });
            await supabase
              .from("clients")
              .update({ notes })
              .eq("id", client.id);
          }

          // Log as executed
          await supabase.from("client_sequence_log").insert({
            sequence_id: sequence.id,
            client_id: client.id,
            step_index: i,
            action_type: actionType,
            status: "executed",
            scheduled_at: nowMs,
            executed_at: nowMs,
          });
        } else {
          // Delayed — enqueue for cron
          const scheduledAt = nowMs + delayHours * 60 * 60 * 1000;
          await supabase.from("client_sequence_log").insert({
            sequence_id: sequence.id,
            client_id: client.id,
            step_index: i,
            action_type: actionType,
            status: "pending",
            scheduled_at: scheduledAt,
          });
        }
      }
    }
  } catch (err) {
    console.error("fireSequences error:", err);
  }
}

// ─── Main Handler ───────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);

  // ── GET: Health check + Meta webhook verification ──
  if (req.method === "GET") {
    // Meta webhook verification
    const hubMode = url.searchParams.get("hub.mode");
    const hubVerifyToken = url.searchParams.get("hub.verify_token");
    const hubChallenge = url.searchParams.get("hub.challenge");

    if (hubMode === "subscribe" && hubVerifyToken && hubChallenge) {
      const keyResult = await validateApiKey(supabase, hubVerifyToken);
      if (keyResult.valid) {
        return new Response(hubChallenge, {
          status: 200,
          headers: corsHeaders,
        });
      }
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    return new Response(
      JSON.stringify({ status: "ok", service: "client-intake-webhook", version: 1 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // ── POST: Intake submission ──
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Parse body
    let body: Record<string, any>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Request body must be JSON", code: "INVALID_BODY" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract API key (header > query param > body field)
    const apiKey =
      req.headers.get("x-api-key") ||
      url.searchParams.get("api_key") ||
      body.api_key ||
      null;

    // Validate API key
    const keyResult = await validateApiKey(supabase, apiKey);
    if (!keyResult.valid) {
      return new Response(
        JSON.stringify({ error: "Invalid or missing API key", code: "INVALID_API_KEY" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Map fields
    const { clientData, unmappedFields } = mapIncomingFields(
      body,
      body._field_map || undefined
    );

    // Validate — need at least one identifying field
    if (
      !clientData.first_name &&
      !clientData.last_name &&
      !clientData.phone &&
      !clientData.email
    ) {
      return new Response(
        JSON.stringify({
          error:
            "At least one of first_name, last_name, phone, or email is required",
          code: "VALIDATION_ERROR",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check for duplicates
    const existing = await findExistingClient(
      supabase,
      clientData.phone || null,
      clientData.email || null
    );

    if (existing) {
      // Add a note to the existing client about the duplicate submission
      const notes = existing.notes || [];
      const unmappedSummary = Object.keys(unmappedFields).length > 0
        ? `\nAdditional data: ${JSON.stringify(unmappedFields)}`
        : "";
      notes.push({
        text: `Duplicate form submission received from ${keyResult.source || "webhook"}${keyResult.label ? ` (${keyResult.label})` : ""}.${unmappedSummary}`,
        type: "auto",
        timestamp: Date.now(),
        author: "Intake Webhook",
      });

      await supabase
        .from("clients")
        .update({ notes, updated_at: Date.now() })
        .eq("id", existing.id);

      return new Response(
        JSON.stringify({
          success: true,
          client_id: existing.id,
          duplicate: true,
          message: `Client already exists (matched by ${existing.email && clientData.email ? "email" : "phone"})`,
          source: keyResult.source,
          automations_fired: false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build new client record
    const nowMs = Date.now();
    const clientId = crypto.randomUUID();

    // Build unmapped fields summary for the initial note
    const unmappedSummary = Object.keys(unmappedFields).length > 0
      ? `\n\nAdditional form data:\n${Object.entries(unmappedFields)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n")}`
      : "";

    const initialNote = {
      text: `Client created via ${keyResult.source || "webhook"}${keyResult.label ? ` (${keyResult.label})` : ""}.${unmappedSummary}`,
      type: "auto",
      timestamp: nowMs,
      author: "Intake Webhook",
    };

    const newClient: Record<string, any> = {
      id: clientId,
      first_name: clientData.first_name || "",
      last_name: clientData.last_name || "",
      phone: clientData.phone || "",
      email: clientData.email || "",
      address: clientData.address || "",
      city: clientData.city || "",
      state: clientData.state || "",
      zip: clientData.zip || "",
      contact_name: clientData.contact_name || "",
      relationship: clientData.relationship || "",
      care_recipient_name: clientData.care_recipient_name || "",
      care_recipient_age: clientData.care_recipient_age || null,
      care_needs: clientData.care_needs || "",
      hours_needed: clientData.hours_needed || "",
      start_date_preference: clientData.start_date_preference || null,
      budget_range: clientData.budget_range || "",
      insurance_info: clientData.insurance_info || "",
      referral_source: keyResult.source || "Webhook",
      referral_detail: keyResult.label || "",
      phase: "new_lead",
      phase_timestamps: { new_lead: nowMs },
      tasks: {},
      notes: [initialNote],
      active_sequences: [],
      priority: clientData.priority || "normal",
      archived: false,
      archived_at: null,
      archive_reason: null,
      archive_detail: null,
      lost_reason: null,
      lost_detail: null,
      assigned_to: null,
      created_at: nowMs,
      updated_at: nowMs,
    };

    // Insert
    const { error: insertErr } = await supabase
      .from("clients")
      .insert(newClient);

    if (insertErr) {
      console.error("Client insert error:", insertErr);
      return new Response(
        JSON.stringify({
          error: `Failed to create client: ${insertErr.message}`,
          code: "INSERT_ERROR",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fire automations + sequences (fire-and-forget, don't block response)
    const automationPromise = fireAutomationRules(supabase, newClient).catch(
      (err) => console.error("Automation rules error:", err)
    );
    const sequencePromise = fireSequences(supabase, newClient).catch((err) =>
      console.error("Sequences error:", err)
    );

    // Wait briefly for automations (but don't block too long)
    await Promise.race([
      Promise.all([automationPromise, sequencePromise]),
      new Promise((resolve) => setTimeout(resolve, 8000)), // 8s max wait
    ]);

    const clientName = [newClient.first_name, newClient.last_name]
      .filter(Boolean)
      .join(" ") || "Unknown";

    return new Response(
      JSON.stringify({
        success: true,
        client_id: clientId,
        duplicate: false,
        message: `Client '${clientName}' created successfully`,
        source: keyResult.source,
        automations_fired: true,
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(
      JSON.stringify({
        error: `Internal error: ${err.message || "Unknown"}`,
        code: "INTERNAL_ERROR",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
