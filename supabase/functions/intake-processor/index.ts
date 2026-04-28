import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ===================================================================
// Intake Processor v1 -- Queue-based cron worker
//
// Called by pg_cron every 2 minutes. Fetches pending entries from
// intake_queue, maps fields, deduplicates, creates caregiver/client
// records, fires automations and sequences, then marks entries done.
//
// Deploy: npx supabase functions deploy intake-processor --no-verify-jwt
//
// NOTE: Field maps and constants below are duplicated from
// src/lib/intakeProcessing.js (which has 84 Vitest tests).
// If you change field mappings here, update that file too and vice versa.
// ===================================================================

// ─── Skip Fields (metadata to ignore) ────────────────────────────

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
  "page_id",
  "form_type",
  "site_url",
  "referer",
  "submission_id",
  "submission_time",
  "date_created_sql",
  "entry_id",
  "captcha-1",
  "html-1",
  "section-1",
  "stripe-1",
  "paypal-1",
  "postdata-1",
  "upload-1",
  "signature-1",
  "_wp_http_referer",
  "nonce",
  "is_submit",
  "render_id",
  "form_module_id",
  "checkbox_1",
  "consent_1",
  "form_title",
  "entry_time",
]);

// ─── Placeholder values for test-ping detection ──────────────────

const PLACEHOLDER_VALUES = new Set([
  "first name",
  "last name",
  "first",
  "last",
  "name",
  "your name",
  "your first name",
  "your last name",
  "email address",
  "email",
  "your email",
  "phone",
  "phone number",
  "your phone",
  "i'm interested in home care services for:",
]);

// ─── Caregiver Field Map ─────────────────────────────────────────

const CAREGIVER_FIELD_MAP: Record<string, string> = {
  first_name: "first_name",
  firstName: "first_name",
  "text-1": "first_name",
  text_1: "first_name",
  name_1_first_name: "first_name",
  name_2_first_name: "first_name",

  last_name: "last_name",
  lastName: "last_name",
  "text-2": "last_name",
  text_2: "last_name",
  name_1_last_name: "last_name",
  name_2_last_name: "last_name",

  email: "email",
  "email-1": "email",
  "email-2": "email",
  email_1: "email",
  email_2: "email",
  user_email: "email",
  email_fb: "email",

  phone: "phone",
  "phone-1": "phone",
  "phone-2": "phone",
  phone_1: "phone",
  phone_2: "phone",
  phone_number: "phone",
  phone_number_fb: "phone",

  address: "address",
  "address-1": "address",
  address_1_street_address: "address",
  address_2_street_address: "address",
  street_address: "address",

  city: "city",
  address_1_city: "city",
  address_2_city: "city",

  state: "state",
  address_1_state: "state",
  address_2_state: "state",

  zip: "zip",
  address_1_zip: "zip",
  address_2_zip: "zip",
  postal_code: "zip",
  zip_code: "zip",

  // Full name -> split into first/last
  name: "_full_name",
  full_name: "_full_name",
  fullname: "_full_name",
  "name-1": "_full_name",
  "name-2": "_full_name",

  // Sub-fields (Forminator)
  "first-name": "first_name",
  "last-name": "last_name",
  "middle-name": "_skip",

  // Subject and message -> stored in note, not column
  subject: "_note_subject",
  message: "_note_message",
  comments: "_note_message",
  notes: "_note_message",
  "textarea-1": "_note_message",
  textarea_1: "_note_message",
  your_message: "_note_message",
};

// ─── Client Extra Field Map (extends caregiver map) ──────────────

const CLIENT_EXTRA_FIELD_MAP: Record<string, string> = {
  care_recipient_name: "care_recipient_name",
  careRecipientName: "care_recipient_name",

  care_recipient_age: "care_recipient_age",
  careRecipientAge: "care_recipient_age",

  relationship: "relationship",

  care_needs: "care_needs",
  careNeeds: "care_needs",
  // For clients, textarea/message/comments -> care_needs (override caregiver)
  "textarea-1": "care_needs",
  "textarea-2": "care_needs",
  textarea_1: "care_needs",
  textarea_2: "care_needs",
  "select-1": "care_needs",
  "radio-1": "care_needs",
  message: "care_needs",
  comments: "care_needs",
  notes: "care_needs",
  radio_1: "care_needs",
  select_1: "care_needs",

  hours_needed: "hours_needed",
  hoursNeeded: "hours_needed",

  start_date_preference: "start_date_preference",
  startDatePreference: "start_date_preference",

  budget_range: "budget_range",
  budgetRange: "budget_range",

  insurance_info: "insurance_info",
  insuranceInfo: "insurance_info",

  priority: "priority",

  contact_name: "contact_name",
  contactName: "contact_name",

  // Gravity Forms / Care Consultation Form common keys
  zip_postal_code: "zip",
  zipcode: "zip",
  postalcode: "zip",
  who_is_care_needed_for: "relationship",
  care_needed_for: "relationship",
  care_for_relationship: "relationship",
  im_interested_in_home_care_services_for: "relationship",
  i_m_interested_in_home_care_services_for: "relationship",
  interested_in_home_care_services_for: "relationship",
};

// ─── Phone Normalization ─────────────────────────────────────────

function normalizePhone(raw: string): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

// ─── Placeholder Detection ───────────────────────────────────────

function isPlaceholderData(data: Record<string, any>): boolean {
  const checkFields = ["first_name", "last_name", "email", "phone"];
  const presentFields = checkFields.filter(
    (f) => data[f] && String(data[f]).trim() !== ""
  );

  // If no identifying fields at all, treat as placeholder/test
  if (presentFields.length === 0) return true;

  // If ALL present fields are placeholder values, it's a test ping
  return presentFields.every((f) =>
    PLACEHOLDER_VALUES.has(String(data[f]).trim().toLowerCase())
  );
}

// ─── Split full name into first/last ─────────────────────────────

function splitFullName(name: string): { first: string; last: string } {
  const trimmed = name.trim();
  if (!trimmed) return { first: "", last: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

// ─── Field Mapping ───────────────────────────────────────────────

interface MappingResult {
  data: Record<string, any>;
  noteSubject: string;
  noteMessage: string;
  unmappedFields: Record<string, any>;
}

function mapFields(
  raw: Record<string, any>,
  entityType: string
): MappingResult {
  // Build the field map: for clients, client-specific overrides first
  const fieldMap: Record<string, string> =
    entityType === "client"
      ? { ...CAREGIVER_FIELD_MAP, ...CLIENT_EXTRA_FIELD_MAP }
      : { ...CAREGIVER_FIELD_MAP };

  const data: Record<string, any> = {};
  const unmappedFields: Record<string, any> = {};
  let noteSubject = "";
  let noteMessage = "";

  // Track which target columns are already set (first-match-wins)
  const setColumns = new Set<string>();

  for (const [rawKey, rawValue] of Object.entries(raw)) {
    // Skip null/undefined/empty
    if (rawValue === null || rawValue === undefined) continue;

    // Skip metadata fields
    if (SKIP_FIELDS.has(rawKey)) continue;

    // Handle Forminator object fields (e.g. name-1 as object)
    if (typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)) {
      // Check if parent key is in the field map
      const parentTarget = fieldMap[rawKey];
      if (parentTarget === "_full_name") {
        // Extract sub-fields like first-name, last-name
        for (const [subKey, subVal] of Object.entries(rawValue)) {
          if (typeof subVal !== "string" || !subVal.trim()) continue;
          const subTarget = fieldMap[subKey];
          if (subTarget && subTarget !== "_skip" && !subTarget.startsWith("_") && !setColumns.has(subTarget)) {
            data[subTarget] = String(subVal).trim();
            setColumns.add(subTarget);
          }
        }
      } else {
        // Flatten sub-keys through field map
        for (const [subKey, subVal] of Object.entries(rawValue)) {
          if (typeof subVal !== "string" || !subVal.trim()) continue;
          const subTarget = fieldMap[subKey];
          if (subTarget && subTarget !== "_skip") {
            if (subTarget === "_note_subject") {
              if (!noteSubject) noteSubject = String(subVal).trim();
            } else if (subTarget === "_note_message") {
              if (!noteMessage) noteMessage = String(subVal).trim();
            } else if (subTarget === "_full_name") {
              if (!setColumns.has("first_name")) {
                const { first, last } = splitFullName(String(subVal).trim());
                if (first) { data.first_name = first; setColumns.add("first_name"); }
                if (last) { data.last_name = last; setColumns.add("last_name"); }
              }
            } else if (!setColumns.has(subTarget)) {
              data[subTarget] = String(subVal).trim();
              setColumns.add(subTarget);
            }
          }
        }
      }
      continue;
    }

    // Convert to string and trim
    const value = String(rawValue).trim();
    if (!value) continue;

    // Look up in field map
    const target = fieldMap[rawKey];

    if (!target) {
      // Unknown field -> unmapped
      unmappedFields[rawKey] = value;
      continue;
    }

    if (target === "_skip") continue;

    if (target === "_note_subject") {
      if (!noteSubject) noteSubject = value;
      continue;
    }

    if (target === "_note_message") {
      if (!noteMessage) noteMessage = value;
      continue;
    }

    if (target === "_full_name") {
      // Split into first/last if not already set
      if (!setColumns.has("first_name")) {
        const { first, last } = splitFullName(value);
        if (first) { data.first_name = first; setColumns.add("first_name"); }
        if (last) { data.last_name = last; setColumns.add("last_name"); }
      }
      continue;
    }

    // Normal mapped field: first-match-wins
    if (setColumns.has(target)) continue;

    // Normalize phone
    if (target === "phone") {
      data[target] = normalizePhone(value);
    } else {
      data[target] = value;
    }
    setColumns.add(target);
  }

  return { data, noteSubject, noteMessage, unmappedFields };
}

// ─── Build Initial Note ──────────────────────────────────────────

function buildInitialNote(
  entityType: string,
  source: string,
  apiKeyLabel: string | null,
  unmappedFields: Record<string, any>,
  extraText: string
): { text: string; type: string; timestamp: number; author: string } {
  const label = entityType === "client" ? "Client" : "Caregiver";
  let text = `${label} created via ${source || "webhook"}${apiKeyLabel ? ` (${apiKeyLabel})` : ""}.`;

  if (extraText) {
    text += "\n\n" + extraText;
  }

  // Unmapped fields summary
  const unmappedKeys = Object.keys(unmappedFields);
  if (unmappedKeys.length > 0) {
    const summary = unmappedKeys
      .map((k) => `${k}: ${unmappedFields[k]}`)
      .join("\n");
    text += "\n\nAdditional form data:\n" + summary;
  }

  return {
    text,
    type: "auto",
    timestamp: Date.now(),
    author: "Intake Webhook",
  };
}

// ─── Duplicate Detection ─────────────────────────────────────────

async function findExistingRecord(
  supabase: any,
  table: string,
  phone: string | null,
  email: string | null
): Promise<any | null> {
  if (!phone && !email) return null;

  // Check email first (case-insensitive)
  if (email) {
    const { data: emailMatch } = await supabase
      .from(table)
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
      // Only fetch columns needed for matching — notes excluded for performance
      const { data: allRecords } = await supabase
        .from(table)
        .select("id, first_name, last_name, phone, email")
        .eq("archived", false)
        .neq("phone", "");

      if (allRecords) {
        const match = allRecords.find(
          (r: any) => r.phone && normalizePhone(r.phone) === normalized
        );
        if (match) return match;
      }
    }
  }

  return null;
}

// ─── Add Duplicate Note ──────────────────────────────────────────

async function addDuplicateNote(
  supabase: any,
  table: string,
  existingRecord: any,
  entry: any,
  mappedData: Record<string, any>
): Promise<void> {
  const notes = Array.isArray(existingRecord.notes)
    ? [...existingRecord.notes]
    : [];

  notes.push({
    text: `Duplicate intake submission detected from ${entry.source || "webhook"}${entry.api_key_label ? ` (${entry.api_key_label})` : ""}. Submitted name: ${mappedData.first_name || ""} ${mappedData.last_name || ""}`.trim(),
    type: "auto",
    timestamp: Date.now(),
    author: "Intake Webhook",
  });

  await supabase
    .from(table)
    .update({ notes })
    .eq("id", existingRecord.id);
}

// ─── Fire Automation Rules ───────────────────────────────────────

async function fireAutomationRules(
  supabase: any,
  record: any,
  entityType: string
): Promise<void> {
  const triggerType =
    entityType === "client" ? "new_client" : "new_caregiver";

  const { data: rules } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("trigger_type", triggerType)
    .eq("enabled", true);

  if (!rules || rules.length === 0) return;

  for (const rule of rules) {
    // Check entity_type filter if present
    if (rule.entity_type && rule.entity_type !== entityType) continue;

    // Evaluate phase condition
    const conds = rule.conditions || {};
    const phase =
      entityType === "client" ? record.phase || "new_lead" : "new_lead";
    if (conds.phase && phase !== conds.phase) continue;

    try {
      await supabase.functions.invoke("execute-automation", {
        body: {
          rule_id: rule.id,
          caregiver_id: record.id,
          entity_type: entityType,
          action_type: rule.action_type,
          message_template: rule.message_template,
          action_config: rule.action_config,
          rule_name: rule.name,
          caregiver: {
            id: record.id,
            first_name: record.first_name || "",
            last_name: record.last_name || "",
            phone: record.phone || "",
            email: record.email || "",
            phase: phase,
          },
          trigger_context: {},
        },
      });
    } catch (err) {
      console.error(`Automation rule ${rule.id} failed:`, err);
    }
  }
}

// ─── Client Merge Field Resolver ─────────────────────────────────

function resolveClientMergeFields(template: string, client: any): string {
  return template
    .replace(/\{\{first_name\}\}/g, client.first_name || "")
    .replace(/\{\{last_name\}\}/g, client.last_name || "")
    .replace(/\{\{phone\}\}/g, client.phone || "")
    .replace(/\{\{email\}\}/g, client.email || "");
}

// ─── Normalize Sequence Action Type ──────────────────────────────

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

// ─── Fire Sequences (Clients Only) ───────────────────────────────

async function fireSequences(
  supabase: any,
  client: any
): Promise<void> {
  const phase = client.phase || "new_lead";

  const { data: sequences } = await supabase
    .from("client_sequences")
    .select("*")
    .eq("trigger_phase", phase)
    .eq("enabled", true);

  if (!sequences || sequences.length === 0) return;

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
        // Execute immediately
        if (actionType === "send_sms" || actionType === "send_email") {
          const resolvedTemplate = resolveClientMergeFields(
            step.template || "",
            client
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
                          step.subject ||
                            "Message from Tremendous Care",
                          client
                        ),
                      }
                    : {},
                rule_name: `${sequence.name} - Step ${i + 1}`,
                caregiver: {
                  id: client.id,
                  first_name: client.first_name || "",
                  last_name: client.last_name || "",
                  phone: client.phone || "",
                  email: client.email || "",
                  phase: client.phase || "new_lead",
                },
              },
            });
          } catch (err) {
            console.error(`Sequence step ${i} failed:`, err);
          }
        } else if (actionType === "create_task") {
          const resolvedTemplate = resolveClientMergeFields(
            step.template || "",
            client
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
        // Delayed -- schedule for cron
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
}

// ─── Process a Single Entry ──────────────────────────────────────

async function processEntry(
  supabase: any,
  entry: any
): Promise<{ status: string; resultId?: string }> {
  const entityType: string = entry.entity_type;
  const raw: Record<string, any> = entry.raw_payload || {};

  // 1. Map fields
  const { data, noteSubject, noteMessage, unmappedFields } = mapFields(
    raw,
    entityType
  );

  // 2. Check for placeholder data (test pings)
  if (isPlaceholderData(data)) {
    console.log(`Entry ${entry.id}: detected test ping, skipping`);
    await supabase
      .from("intake_queue")
      .update({
        status: "processed",
        processed_at: new Date().toISOString(),
        error_detail: "test ping - placeholder data detected",
      })
      .eq("id", entry.id);
    return { status: "test_ping" };
  }

  // 3. Validate minimum fields
  const hasMinimum =
    (data.first_name && data.first_name.trim()) ||
    (data.last_name && data.last_name.trim()) ||
    (data.phone && data.phone.trim()) ||
    (data.email && data.email.trim());

  if (!hasMinimum) {
    console.log(`Entry ${entry.id}: insufficient data, no identifying fields`);
    await supabase
      .from("intake_queue")
      .update({
        status: "error",
        attempts: (entry.attempts || 0) + 1,
        error_detail: "No identifying fields (first_name, last_name, phone, email)",
      })
      .eq("id", entry.id);
    return { status: "error" };
  }

  // 4. Determine target table
  const table = entityType === "client" ? "clients" : "caregivers";

  // 5. Deduplicate
  const existing = await findExistingRecord(
    supabase,
    table,
    data.phone || null,
    data.email || null
  );

  if (existing) {
    console.log(
      `Entry ${entry.id}: duplicate found -> ${table}.${existing.id}`
    );
    await addDuplicateNote(supabase, table, existing, entry, data);
    await supabase
      .from("intake_queue")
      .update({
        status: "duplicate",
        result_id: existing.id,
        processed_at: new Date().toISOString(),
      })
      .eq("id", entry.id);
    return { status: "duplicate", resultId: existing.id };
  }

  // 6. Build extra text for notes (caregiver: subject + message)
  let extraText = "";
  if (entityType === "caregiver") {
    const parts: string[] = [];
    if (noteSubject) parts.push(`Subject: ${noteSubject}`);
    if (noteMessage) parts.push(`Message: ${noteMessage}`);
    extraText = parts.join("\n");
  }

  // 7. Build initial note
  const initialNote = buildInitialNote(
    entityType,
    entry.source,
    entry.api_key_label,
    unmappedFields,
    extraText
  );

  // 8. Create the record
  const newId = crypto.randomUUID();

  if (entityType === "caregiver") {
    const newCaregiver = {
      id: newId,
      first_name: data.first_name || "",
      last_name: data.last_name || "",
      phone: data.phone || "",
      email: data.email || "",
      address: data.address || "",
      city: data.city || "",
      state: data.state || "",
      zip: data.zip || "",
      source: entry.source || "Website",
      source_detail: entry.api_key_label || "",
      application_date: new Date().toISOString().split("T")[0],
      initial_notes: noteMessage || "",
      phase_timestamps: { new_lead: Date.now() },
      tasks: {},
      notes: [initialNote],
      created_at: Date.now(),
      archived: false,
    };

    const { error: insertErr } = await supabase
      .from("caregivers")
      .insert(newCaregiver);

    if (insertErr) {
      throw new Error(`Caregiver insert failed: ${insertErr.message}`);
    }

    console.log(`Entry ${entry.id}: created caregiver ${newId}`);

    // Fire automations
    await fireAutomationRules(supabase, newCaregiver, "caregiver");
  } else {
    // Client
    const newClient = {
      id: newId,
      first_name: data.first_name || "",
      last_name: data.last_name || "",
      phone: data.phone || "",
      email: data.email || "",
      address: data.address || "",
      city: data.city || "",
      state: data.state || "",
      zip: data.zip || "",
      contact_name: data.contact_name || "",
      relationship: data.relationship || "",
      care_recipient_name: data.care_recipient_name || "",
      care_recipient_age: data.care_recipient_age || null,
      care_needs: data.care_needs || "",
      hours_needed: data.hours_needed || "",
      start_date_preference: data.start_date_preference || null,
      budget_range: data.budget_range || "",
      insurance_info: data.insurance_info || "",
      referral_source: entry.source || "Webhook",
      referral_detail: entry.api_key_label || "",
      phase: "new_lead",
      phase_timestamps: { new_lead: Date.now() },
      tasks: {},
      notes: [initialNote],
      active_sequences: [],
      priority: data.priority || "normal",
      archived: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const { error: insertErr } = await supabase
      .from("clients")
      .insert(newClient);

    if (insertErr) {
      throw new Error(`Client insert failed: ${insertErr.message}`);
    }

    console.log(`Entry ${entry.id}: created client ${newId}`);

    // Fire automations
    await fireAutomationRules(supabase, newClient, "client");

    // Fire sequences (clients only)
    await fireSequences(supabase, newClient);
  }

  // 9. Mark entry as processed
  await supabase
    .from("intake_queue")
    .update({
      status: "processed",
      result_id: newId,
      processed_at: new Date().toISOString(),
    })
    .eq("id", entry.id);

  return { status: "processed", resultId: newId };
}

// ─── Main Handler ────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // Only accept POST (from pg_cron)
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Fetch pending entries (batch limit: 20)
  const { data: entries, error: fetchErr } = await supabase
    .from("intake_queue")
    .select("*")
    .eq("status", "pending")
    .lt("attempts", 3)
    .order("created_at", { ascending: true })
    .limit(20);

  if (fetchErr) {
    console.error("Failed to fetch queue entries:", fetchErr);
    return new Response(
      JSON.stringify({ error: fetchErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!entries || entries.length === 0) {
    return new Response(
      JSON.stringify({ processed: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(`intake-processor: processing ${entries.length} entries`);

  let processed = 0;
  let duplicates = 0;
  let errors = 0;

  for (const entry of entries) {
    try {
      const result = await processEntry(supabase, entry);
      if (result.status === "processed" || result.status === "test_ping") {
        processed++;
      } else if (result.status === "duplicate") {
        duplicates++;
      } else if (result.status === "error") {
        errors++;
      }
    } catch (err: any) {
      console.error(`Entry ${entry.id} failed:`, err);
      errors++;

      // Increment attempts and log error; mark as 'error' after 3 failures
      try {
        const newAttempts = (entry.attempts || 0) + 1;
        const updatePayload: Record<string, any> = {
          attempts: newAttempts,
          error_detail: err.message || String(err),
        };
        if (newAttempts >= 3) {
          updatePayload.status = "error";
        }
        await supabase
          .from("intake_queue")
          .update(updatePayload)
          .eq("id", entry.id);
      } catch (updateErr) {
        console.error(
          `Failed to update error for entry ${entry.id}:`,
          updateErr
        );
      }
    }
  }

  console.log(
    `intake-processor: done. processed=${processed}, duplicates=${duplicates}, errors=${errors}`
  );

  return new Response(
    JSON.stringify({
      processed,
      duplicates,
      errors,
      total: entries.length,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
