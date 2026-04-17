import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
const RC_JWT_TOKEN = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
const RC_API_URL = "https://platform.ringcentral.com";

// ─── CORS Headers ───
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Supabase Client (service role for full access) ───
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Phase Labels ───
const PHASE_LABELS: Record<string, string> = {
  intake: "Intake & Screen",
  interview: "Interview & Offer",
  onboarding: "Onboarding Packet",
  verification: "Verification & Handoff",
  orientation: "Orientation",
};

const CLIENT_PHASE_LABELS: Record<string, string> = {
  new_lead: "New Lead",
  initial_contact: "Initial Contact",
  consultation: "Consultation",
  assessment: "In-Home Assessment",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
  nurture: "Nurture",
};

// ─── Whitelisted Fields for update_field Action ───
const ALLOWED_UPDATE_FIELDS_CAREGIVER = ["board_status", "board_note", "availability", "preferred_shift"];
const ALLOWED_UPDATE_FIELDS_CLIENT = ["board_status", "board_note", "availability", "preferred_shift", "priority", "source", "care_type", "assigned_to"];

// ─── Whitelisted Fields for Survey Profile Mapping ───
const ALLOWED_PROFILE_FIELDS = [
  "has_hca", "has_dl", "years_experience", "availability", "preferred_shift",
  "languages", "specializations", "certifications", "per_id",
];

// ─── Phone Number Normalization ───
function normalizePhoneNumber(phone: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ─── Get RingCentral From Number ───
async function getRCFromNumber(): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ringcentral_from_number")
      .single();

    if (data?.value) {
      const val = typeof data.value === "string" ? data.value : String(data.value);
      const digits = val.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      if (val.startsWith("+")) return val;
      return val;
    }
  } catch (err) {
    console.error("Failed to load RC from number:", err);
  }
  const envNum = Deno.env.get("RINGCENTRAL_FROM_NUMBER");
  return envNum || null;
}

// ─── Get RingCentral Access Token ───
async function getRingCentralAccessToken(): Promise<string> {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT_TOKEN) {
    throw new Error("RingCentral credentials not configured");
  }

  const response = await fetch(`${RC_API_URL}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`)}`,
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

// ─── Enhanced Merge Field Substitution ───
function resolveTemplate(
  template: string,
  caregiver: Record<string, any>,
  triggerContext?: Record<string, any>,
  caregiverFullData?: Record<string, any>,
  entityType: string = "caregiver"
): string {
  let daysInPhase = "";
  let overallProgress = "";

  const phaseLabels = entityType === "client" ? CLIENT_PHASE_LABELS : PHASE_LABELS;

  if (caregiverFullData) {
    const phase = entityType === "client"
      ? (caregiverFullData.phase || "new_lead")
      : (caregiverFullData.phase_override || caregiver.phase || "intake");
    const phaseStart = caregiverFullData.phase_timestamps?.[phase];
    if (phaseStart) {
      daysInPhase = String(Math.floor((Date.now() - phaseStart) / 86400000));
    }
  }

  const fieldMap: Record<string, string> = {
    first_name: caregiver.first_name || "",
    last_name: caregiver.last_name || "",
    phone: caregiver.phone || "",
    email: caregiver.email || "",
    phase: caregiver.phase || "",
    phase_name: phaseLabels[caregiver.phase] || caregiver.phase || "",
    days_in_phase: daysInPhase,
    overall_progress: overallProgress,
    completed_task: triggerContext?.task_label || triggerContext?.task_id || "",
    document_type: triggerContext?.document_label || triggerContext?.document_type || "",
    signed_documents: triggerContext?.template_names?.join(", ") || "",
    message_text: triggerContext?.message_text || "",
    sender_number: triggerContext?.sender_number || "",
    survey_link: triggerContext?.survey_link || "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => fieldMap[key] || "");
}

// ─── Send SMS via RingCentral ───
async function sendSMS(phone: string, message: string): Promise<{ success: boolean; error?: string }> {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return { success: false, error: `Invalid phone number: ${phone}` };

  const fromNumber = await getRCFromNumber();
  if (!fromNumber) return { success: false, error: "RingCentral from number not configured. Set it in Settings > RingCentral." };

  let accessToken: string;
  try {
    accessToken = await getRingCentralAccessToken();
  } catch (err) {
    return { success: false, error: `Failed to connect to SMS service: ${err.message}` };
  }

  const smsResponse = await fetch(`${RC_API_URL}/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      from: { phoneNumber: fromNumber },
      to: [{ phoneNumber: normalized }],
      text: message,
    }),
  });

  if (!smsResponse.ok) {
    const errorText = await smsResponse.text();
    if (smsResponse.status === 429) return { success: false, error: "SMS rate limit reached. Try again later." };
    return { success: false, error: `RingCentral API error (${smsResponse.status}): ${errorText}` };
  }

  return { success: true };
}

// ─── Send Email via Outlook Integration ───
async function sendEmail(
  toEmail: string,
  toName: string,
  subject: string,
  body: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ action: "send_email", to_email: toEmail, to_name: toName, subject, body }),
    });

    const text = await response.text();
    let result: any = {};
    if (text && text.trim().length > 0) {
      try {
        result = JSON.parse(text);
      } catch (_) {
        if (response.ok) return { success: true };
        return { success: false, error: `Email API returned non-JSON response (${response.status}): ${text.substring(0, 200)}` };
      }
    } else if (response.ok) {
      return { success: true };
    }

    if (result.error) return { success: false, error: result.error };
    return { success: true };
  } catch (err) {
    return { success: false, error: `Email send failed: ${err.message}` };
  }
}

// ─── Main Handler ───
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      rule_id,
      caregiver_id,
      action_type,
      message_template,
      action_config,
      rule_name,
      caregiver,
      trigger_context,
      entity_type = "caregiver",
    } = await req.json();

    const tableName = entity_type === "client" ? "clients" : "caregivers";
    const entityLabel = entity_type === "client" ? "client" : "caregiver";
    const phaseLabels = entity_type === "client" ? CLIENT_PHASE_LABELS : PHASE_LABELS;
    const allowedFields = entity_type === "client" ? ALLOWED_UPDATE_FIELDS_CLIENT : ALLOWED_UPDATE_FIELDS_CAREGIVER;

    if (!rule_id || !caregiver_id || !action_type || !caregiver) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: rule_id, caregiver_id, action_type, caregiver" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Context-Aware Dedup Check ───
    let dedupQuery = supabase
      .from("automation_log")
      .select("id")
      .eq("rule_id", rule_id)
      .eq("caregiver_id", caregiver_id)
      .eq("status", "success");

    if (trigger_context?.to_phase) {
      dedupQuery = dedupQuery.contains("trigger_context", { to_phase: trigger_context.to_phase });
    }
    if (trigger_context?.task_id) {
      dedupQuery = dedupQuery.contains("trigger_context", { task_id: trigger_context.task_id });
    }
    if (trigger_context?.document_type) {
      dedupQuery = dedupQuery.contains("trigger_context", { document_type: trigger_context.document_type });
    }
    if (trigger_context?.envelope_id) {
      dedupQuery = dedupQuery.contains("trigger_context", { envelope_id: trigger_context.envelope_id });
    }
    if (trigger_context?.rc_message_id) {
      dedupQuery = dedupQuery.contains("trigger_context", { rc_message_id: trigger_context.rc_message_id });
    }
    if (trigger_context?.reminder_number) {
      dedupQuery = dedupQuery.contains("trigger_context", { reminder_number: trigger_context.reminder_number });
    }

    const { data: existingLog } = await dedupQuery.limit(1);

    if (existingLog && existingLog.length > 0) {
      return new Response(
        JSON.stringify({ skipped: true, message: `Rule already fired for this ${entityLabel}/context` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Fetch Full Entity Data for Dynamic Fields ───
    let caregiverFullData: Record<string, any> | null = null;
    if (message_template?.includes("{{days_in_phase}}") || message_template?.includes("{{overall_progress}}") ||
        ["update_phase", "complete_task", "add_note", "update_field", "send_docusign_envelope"].includes(action_type)) {
      const { data: cgData } = await supabase
        .from(tableName)
        .select("*")
        .eq("id", caregiver_id)
        .single();
      caregiverFullData = cgData;
    }

    // ─── Resolve Template ───
    const resolvedMessage = message_template
      ? resolveTemplate(message_template, caregiver, trigger_context, caregiverFullData, entity_type)
      : "";

    // ─── Execute Action ───
    let result: { success: boolean; error?: string };

    switch (action_type) {
      case "send_sms": {
        if (!caregiver.phone) {
          result = { success: false, error: `${entityLabel === "client" ? "Client" : "Caregiver"} has no phone number` };
          break;
        }
        result = await sendSMS(caregiver.phone, resolvedMessage);
        break;
      }
      case "send_email": {
        if (!caregiver.email) {
          result = { success: false, error: `${entityLabel === "client" ? "Client" : "Caregiver"} has no email address` };
          break;
        }
        const subject = action_config?.subject || "Message from Tremendous Care";
        const toName = `${caregiver.first_name || ""} ${caregiver.last_name || ""}`.trim();
        result = await sendEmail(caregiver.email, toName, subject, resolvedMessage);
        break;
      }

      case "update_phase": {
        const targetPhase = action_config?.target_phase;
        if (!targetPhase) {
          result = { success: false, error: "No target_phase in action_config" };
          break;
        }
        const timestamps = caregiverFullData?.phase_timestamps || {};
        if (!timestamps[targetPhase]) {
          timestamps[targetPhase] = Date.now();
        }
        const phaseUpdateField = entity_type === "client" ? "phase" : "phase_override";
        const { error: updateErr } = await supabase
          .from(tableName)
          .update({ [phaseUpdateField]: targetPhase, phase_timestamps: timestamps })
          .eq("id", caregiver_id);
        result = updateErr
          ? { success: false, error: `Failed to update phase: ${updateErr.message}` }
          : { success: true };
        break;
      }

      case "complete_task": {
        const taskId = action_config?.task_id;
        if (!taskId) {
          result = { success: false, error: "No task_id in action_config" };
          break;
        }
        const tasks = caregiverFullData?.tasks || {};
        tasks[taskId] = { completed: true, completedAt: Date.now(), completedBy: "Automation Engine" };
        const { error: taskErr } = await supabase
          .from(tableName)
          .update({ tasks })
          .eq("id", caregiver_id);
        result = taskErr
          ? { success: false, error: `Failed to complete task: ${taskErr.message}` }
          : { success: true };
        break;
      }

      case "add_note": {
        const notes = caregiverFullData?.notes || [];
        const noteText = resolvedMessage || "(automation note)";
        notes.push({
          text: noteText,
          type: "note",
          timestamp: Date.now(),
          author: "Automation Engine",
          outcome: `Added via automation rule: ${rule_name || rule_id}`,
        });
        const { error: noteErr } = await supabase
          .from(tableName)
          .update({ notes })
          .eq("id", caregiver_id);
        result = noteErr
          ? { success: false, error: `Failed to add note: ${noteErr.message}` }
          : { success: true };
        break;
      }

      case "update_field": {
        const fieldName = action_config?.field_name;
        const fieldValue = action_config?.field_value;
        if (!fieldName) {
          result = { success: false, error: "No field_name in action_config" };
          break;
        }
        if (!allowedFields.includes(fieldName)) {
          result = { success: false, error: `Field '${fieldName}' is not allowed for automation updates` };
          break;
        }
        const { error: fieldErr } = await supabase
          .from(tableName)
          .update({ [fieldName]: fieldValue })
          .eq("id", caregiver_id);
        result = fieldErr
          ? { success: false, error: `Failed to update field: ${fieldErr.message}` }
          : { success: true };
        break;
      }

      // ─── Survey Profile Field Mapping ───
      case "update_profile_fields": {
        const fields = action_config?.fields;
        if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
          result = { success: false, error: "No fields provided in action_config.fields" };
          break;
        }
        // Filter to only allowed profile fields
        const safeUpdates: Record<string, any> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (ALLOWED_PROFILE_FIELDS.includes(key)) {
            safeUpdates[key] = value;
          }
        }
        if (Object.keys(safeUpdates).length === 0) {
          result = { success: false, error: "No allowed profile fields in update" };
          break;
        }
        const { error: profileErr } = await supabase
          .from(tableName)
          .update(safeUpdates)
          .eq("id", caregiver_id);
        result = profileErr
          ? { success: false, error: `Failed to update profile fields: ${profileErr.message}` }
          : { success: true };
        break;
      }

      case "send_docusign_envelope": {
        if (entity_type === "client") {
          result = { success: false, error: "DocuSign envelopes are only supported for caregivers" };
          break;
        }
        if (!caregiver.email) {
          result = { success: false, error: "Caregiver has no email address" };
          break;
        }
        try {
          const { data: templateSetting } = await supabase
            .from("app_settings")
            .select("value")
            .eq("key", "docusign_templates")
            .single();
          const templates = templateSetting?.value || [];
          if (templates.length === 0) {
            result = { success: false, error: "No DocuSign templates configured" };
            break;
          }

          const sendAll = action_config?.send_all !== false;
          const toName = `${caregiver.first_name || ""} ${caregiver.last_name || ""}`.trim();

          const body: Record<string, any> = {
            action: sendAll ? "send_packet" : "send_envelope",
            caregiver_id,
            caregiver_email: caregiver.email,
            caregiver_name: toName,
            sent_by: "Automation Engine",
          };
          if (!sendAll) {
            body.template_ids = templates.map((t: any) => t.templateId);
            body.template_names = templates.map((t: any) => t.name);
          }

          const dsResponse = await fetch(`${SUPABASE_URL}/functions/v1/docusign-integration`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify(body),
          });

          const dsText = await dsResponse.text();
          let dsResult: any;
          try { dsResult = JSON.parse(dsText); } catch { dsResult = { error: dsText }; }

          if (dsResult.error) {
            result = { success: false, error: `DocuSign send failed: ${dsResult.error}` };
          } else {
            result = { success: true };
          }
        } catch (err) {
          result = { success: false, error: `DocuSign send failed: ${err.message}` };
        }
        break;
      }

      default:
        result = { success: false, error: `Unknown action type: ${action_type}` };
    }

    // ─── Log Result (with trigger_context) ───
    const logEntry = {
      rule_id,
      caregiver_id,
      action_type,
      status: result.success ? "success" : "failed",
      message_sent: resolvedMessage || `${action_type}: ${JSON.stringify(action_config || {})}`,
      error_detail: result.error || null,
      trigger_context: trigger_context || {},
    };

    await supabase.from("automation_log").insert(logEntry);

    // ─── Auto-Note on Entity Record (on success, skip for silent actions) ───
    if (result.success && !["add_note", "update_profile_fields"].includes(action_type)) {
      const { data: cgData } = await supabase
        .from(tableName)
        .select("notes")
        .eq("id", caregiver_id)
        .single();

      const currentNotes = cgData?.notes || [];

      let noteType = "note";
      let noteText = resolvedMessage;
      let noteDirection: string | undefined;

      if (action_type === "send_sms") {
        noteType = "text";
        noteDirection = "outbound";
      } else if (action_type === "send_email") {
        noteType = "email";
        noteDirection = "outbound";
        noteText = `Email sent \u2014 Subject: ${action_config?.subject || "(no subject)"}\n\n${resolvedMessage.length > 300 ? resolvedMessage.substring(0, 300) + "..." : resolvedMessage}`;
      } else if (action_type === "update_phase") {
        noteText = `Phase updated to ${phaseLabels[action_config?.target_phase] || action_config?.target_phase} via automation rule: ${rule_name || rule_id}`;
      } else if (action_type === "complete_task") {
        noteText = `Task \"${action_config?.task_id}\" completed via automation rule: ${rule_name || rule_id}`;
      } else if (action_type === "update_field") {
        noteText = `Field \"${action_config?.field_name}\" set to \"${action_config?.field_value}\" via automation rule: ${rule_name || rule_id}`;
      } else if (action_type === "send_docusign_envelope") {
        noteType = "docusign";
        noteDirection = "outbound";
        noteText = `DocuSign envelope sent via automation rule: ${rule_name || rule_id}`;
      }

      const autoNote: Record<string, any> = {
        text: noteText,
        type: noteType,
        outcome: `via automation rule: ${rule_name || rule_id}`,
        timestamp: Date.now(),
        author: "Automation Engine",
      };
      if (noteDirection) autoNote.direction = noteDirection;

      await supabase
        .from(tableName)
        .update({ notes: [...currentNotes, autoNote] })
        .eq("id", caregiver_id);
    }

    // ─── Response ───
    const entitySuffix = entity_type === "client" ? " to client" : "";
    const actionLabels: Record<string, string> = {
      send_sms: `SMS sent${entitySuffix}`,
      send_email: `Email sent${entitySuffix}`,
      update_phase: `Phase updated to ${action_config?.target_phase || "unknown"}`,
      complete_task: `Task \"${action_config?.task_id || "unknown"}\" completed`,
      add_note: "Note added",
      update_field: `Field \"${action_config?.field_name || "unknown"}\" updated`,
      update_profile_fields: "Profile fields updated from survey",
      send_docusign_envelope: "DocuSign envelope sent",
    };

    return new Response(
      JSON.stringify({
        success: result.success,
        message: result.success
          ? `${actionLabels[action_type] || action_type} for ${caregiver.first_name} ${caregiver.last_name}`
          : result.error,
        error: result.error || undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("execute-automation error:", err);
    return new Response(
      JSON.stringify({ error: `Internal error: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
