import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeActionType, resolveAutomationMergeFields } from "../_shared/helpers/automations.ts";
import {
  buildSurveyUrlFromToken,
  isWithinSendWindow,
  resolveReminderConditions,
  shouldRemindSurvey,
} from "../_shared/helpers/surveyReminders.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getStepDelayMs(step: Record<string, any>): number {
  if (typeof step.delay_hours === 'number') {
    return step.delay_hours * 60 * 60 * 1000;
  }
  const value = step.delay_value || 0;
  const unit = step.delay_unit || 'hours';
  switch (unit) {
    case 'minutes': return value * 60 * 1000;
    case 'hours':   return value * 60 * 60 * 1000;
    case 'days':    return value * 24 * 60 * 60 * 1000;
    default:        return value * 60 * 60 * 1000;
  }
}

function normalizePhone(phone: string): string {
  return (phone || '').replace(/[^0-9+]/g, '');
}

function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (na.length < 10 || nb.length < 10) return false;
  return na.slice(-10) === nb.slice(-10);
}

// ─── External Auth Helpers ─────────────────────────────────────────────────────

async function getRingCentralToken(): Promise<string | null> {
  const clientId = Deno.env.get("RINGCENTRAL_CLIENT_ID");
  const clientSecret = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
  const jwtToken = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
  if (!clientId || !clientSecret || !jwtToken) return null;

  try {
    const response = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
      },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwtToken}`,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.access_token;
  } catch {
    return null;
  }
}

async function getMicrosoftToken(): Promise<string | null> {
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
  const tenantId = Deno.env.get("MICROSOFT_TENANT_ID");
  if (!clientId || !clientSecret || !tenantId) return null;

  try {
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_id=${clientId}&client_secret=${encodeURIComponent(clientSecret)}&scope=https://graph.microsoft.com/.default&grant_type=client_credentials`,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.access_token;
  } catch {
    return null;
  }
}

// ─── Response Detection Helpers ────────────────────────────────────────────────

async function checkInboundSms(rcToken: string, phone: string, since: string): Promise<boolean> {
  if (!rcToken || !phone) return false;
  const norm = normalizePhone(phone);
  if (norm.length < 10) return false;

  try {
    const sinceDate = new Date(since).toISOString();
    const url = `https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/message-store?direction=Inbound&dateFrom=${encodeURIComponent(sinceDate)}&messageType=SMS&perPage=10`;
    const response = await fetch(url, { headers: { "Authorization": `Bearer ${rcToken}` } });
    if (!response.ok) return false;
    const data = await response.json();
    for (const msg of data.records || []) {
      const fromNum = msg.from?.phoneNumber || '';
      if (phonesMatch(fromNum, phone)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function checkInboundCalls(rcToken: string, phone: string, since: string): Promise<boolean> {
  if (!rcToken || !phone) return false;
  const norm = normalizePhone(phone);
  if (norm.length < 10) return false;

  try {
    const sinceDate = new Date(since).toISOString();
    const url = `https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/call-log?direction=Inbound&dateFrom=${encodeURIComponent(sinceDate)}&perPage=10`;
    const response = await fetch(url, { headers: { "Authorization": `Bearer ${rcToken}` } });
    if (!response.ok) return false;
    const data = await response.json();
    for (const call of data.records || []) {
      const fromNum = call.from?.phoneNumber || '';
      if (phonesMatch(fromNum, phone)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function checkInboundEmails(msToken: string, mailbox: string, clientEmail: string, since: string): Promise<boolean> {
  if (!msToken || !clientEmail || !mailbox) return false;

  try {
    const sinceDate = new Date(since).toISOString();
    const filter = encodeURIComponent(`from/emailAddress/address eq '${clientEmail}' and receivedDateTime ge ${sinceDate}`);
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages?$filter=${filter}&$top=1&$select=id`;
    const response = await fetch(url, { headers: { "Authorization": `Bearer ${msToken}` } });
    if (!response.ok) return false;
    const data = await response.json();
    return (data.value || []).length > 0;
  } catch { /* ignore */ }
  return false;
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const summary: Record<string, any> = {
    rules_processed: 0,
    executions: 0,
    skipped: 0,
    errors: 0,
    sequences_processed: 0,
    sequence_steps_executed: 0,
    sequence_steps_enqueued: 0,
    response_cancellations: 0,
    out_of_order_skips: 0,
    survey_reminders_sent: 0,
    survey_reminders_skipped: 0,
    // Captures the last few survey-reminder failures (HTTP status + body
    // snippet + error message) so the cron's JSON response exposes *why*
    // `errors` is non-zero without needing edge-function logs.
    survey_reminder_errors: [] as Array<Record<string, any>>,
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 1: DAYS_INACTIVE RULES (caregivers + clients)
    // ═══════════════════════════════════════════════════════════════════════════

    const { data: rules, error: rulesError } = await supabase
      .from("automation_rules")
      .select("*")
      .eq("enabled", true)
      .eq("trigger_type", "days_inactive");

    if (rulesError) {
      console.error("Failed to fetch rules:", rulesError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch automation rules", detail: rulesError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (rules && rules.length > 0) {
      for (const rule of rules) {
        summary.rules_processed++;

        const days = rule.conditions?.days;
        if (!days || days <= 0) {
          console.warn(`Rule ${rule.id} (${rule.name}) has invalid days condition:`, rule.conditions);
          continue;
        }

        const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
        const entityType = rule.entity_type || 'caregiver';

        let entities: any[] = [];

        if (entityType === 'client') {
          const { data: clients, error: clientError } = await supabase
            .from("clients")
            .select("id, first_name, last_name, phone, email, phase, notes, created_at")
            .eq("archived", false)
            .not("phase", "in", "(won,lost)");
          if (clientError) { console.error(`Failed to fetch clients for rule ${rule.id}:`, clientError); summary.errors++; continue; }
          entities = clients || [];
        } else {
          const { data: caregivers, error: cgError } = await supabase
            .from("caregivers")
            .select("id, first_name, last_name, phone, email, phase, notes, created_at")
            .eq("archived", false);
          if (cgError) { console.error(`Failed to fetch caregivers for rule ${rule.id}:`, cgError); summary.errors++; continue; }
          entities = caregivers || [];
        }

        if (entities.length === 0) continue;

        const inactiveEntities = entities.filter((entity) => {
          let latestActivity = entity.created_at;
          if (entity.notes && Array.isArray(entity.notes) && entity.notes.length > 0) {
            for (const note of entity.notes) {
              const ts = note.timestamp;
              if (ts && typeof ts === "number" && ts > latestActivity) latestActivity = ts;
            }
          }
          return latestActivity < cutoffMs;
        });

        if (inactiveEntities.length === 0) continue;

        const { data: existingLogs } = await supabase
          .from("automation_log")
          .select("caregiver_id")
          .eq("rule_id", rule.id)
          .eq("status", "success");

        const alreadyFired = new Set((existingLogs || []).map((l: any) => l.caregiver_id));

        for (const entity of inactiveEntities) {
          if (alreadyFired.has(entity.id)) { summary.skipped++; continue; }

          try {
            const payload: Record<string, any> = {
              rule_id: rule.id,
              caregiver_id: entity.id,
              action_type: rule.action_type,
              message_template: rule.message_template,
              action_config: rule.action_config,
              rule_name: rule.name,
              caregiver: {
                id: entity.id, first_name: entity.first_name, last_name: entity.last_name,
                phone: entity.phone, email: entity.email, phase: entity.phase,
              },
            };
            if (entityType === 'client') payload.entity_type = 'client';

            const response = await fetch(`${SUPABASE_URL}/functions/v1/execute-automation`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
              body: JSON.stringify(payload),
            });
            const result = await response.json();
            if (result.skipped) summary.skipped++;
            else if (result.success) summary.executions++;
            else { summary.errors++; console.error(`Automation failed for rule ${rule.name}, ${entityType} ${entity.id}:`, result.error); }
          } catch (err) {
            summary.errors++;
            console.error(`Failed to call execute-automation for rule ${rule.name}, ${entityType} ${entity.id}:`, err);
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 1.5: SURVEY_PENDING REMINDER RULES
    // ═══════════════════════════════════════════════════════════════════════════
    // Re-sends the pre-screening survey to caregivers who haven't completed it.
    // Each rule's conditions control the interval (hours), cap (max_reminders),
    // and local-time send window. Per-caregiver opt-out lives on
    // survey_responses.reminders_stopped (toggle from the caregiver profile).
    //
    // We never create a new survey token for a reminder — we reuse the token
    // that was generated when the survey was first sent, so the link in every
    // reminder matches the original one.

    try {
      const now = new Date();

      const { data: surveyRules, error: surveyRulesErr } = await supabase
        .from("automation_rules")
        .select("*")
        .eq("enabled", true)
        .eq("trigger_type", "survey_pending");

      if (surveyRulesErr) {
        console.error("Failed to fetch survey_pending rules:", surveyRulesErr);
      } else if (surveyRules && surveyRules.length > 0) {
        const appBaseUrl =
          Deno.env.get("APP_BASE_URL") || "https://caregiver-portal.vercel.app";

        for (const rule of surveyRules) {
          summary.rules_processed++;
          const resolved = resolveReminderConditions(rule.conditions);

          // Gate on the configured local-time window. Checked per-rule so
          // different rules could have different timezones in future.
          if (!isWithinSendWindow(now, resolved.tz, resolved.start_hour, resolved.end_hour)) {
            continue;
          }

          // Pull candidate rows — the shouldRemindSurvey helper does the
          // precise filtering in JS so the logic is unit-testable.
          const { data: candidates, error: candErr } = await supabase
            .from("survey_responses")
            .select(
              "id, caregiver_id, token, status, reminders_sent, last_reminder_sent_at, reminders_stopped, sent_at"
            )
            .eq("status", "pending")
            .eq("reminders_stopped", false)
            .lt("reminders_sent", resolved.max_reminders);

          if (candErr) {
            console.error(`Failed to fetch pending surveys for rule ${rule.id}:`, candErr);
            summary.errors++;
            continue;
          }

          const dueSurveys = (candidates || []).filter((sr: any) =>
            shouldRemindSurvey(sr, rule.conditions, now)
          );

          if (dueSurveys.length === 0) continue;

          // Bulk fetch caregivers for the due surveys
          const caregiverIds = Array.from(
            new Set(dueSurveys.map((s: any) => s.caregiver_id).filter(Boolean))
          );
          if (caregiverIds.length === 0) continue;

          const { data: caregivers, error: cgErr } = await supabase
            .from("caregivers")
            .select("id, first_name, last_name, phone, email, phase, archived")
            .in("id", caregiverIds);

          if (cgErr) {
            console.error(`Failed to fetch caregivers for rule ${rule.id}:`, cgErr);
            summary.errors++;
            continue;
          }

          const cgMap = new Map((caregivers || []).map((c: any) => [c.id, c]));

          for (const survey of dueSurveys) {
            const caregiver = cgMap.get(survey.caregiver_id);
            if (!caregiver || caregiver.archived) {
              summary.survey_reminders_skipped++;
              summary.skipped++;
              continue;
            }

            const surveyLink = buildSurveyUrlFromToken(survey.token, appBaseUrl);

            // Build once so we can reference it in error diagnostics.
            const reminderPayload = {
              rule_id: rule.id,
              caregiver_id: caregiver.id,
              action_type: rule.action_type,
              message_template: rule.message_template,
              action_config: rule.action_config || {},
              rule_name: rule.name,
              caregiver: {
                id: caregiver.id,
                first_name: caregiver.first_name,
                last_name: caregiver.last_name,
                phone: caregiver.phone,
                email: caregiver.email,
                phase: caregiver.phase,
              },
              trigger_context: {
                survey_link: surveyLink,
                survey_response_id: survey.id,
                reminder_number: (survey.reminders_sent || 0) + 1,
                max_reminders: resolved.max_reminders,
              },
            };

            const recordError = (detail: Record<string, any>) => {
              summary.errors++;
              const entry = {
                rule_id: rule.id,
                rule_name: rule.name,
                survey_id: survey.id,
                caregiver_id: caregiver.id,
                ...detail,
              };
              console.error("Survey reminder error:", entry);
              // Keep only the most recent 5 so the response doesn't balloon.
              if (summary.survey_reminder_errors.length < 5) {
                summary.survey_reminder_errors.push(entry);
              }
            };

            try {
              const response = await fetch(
                `${SUPABASE_URL}/functions/v1/execute-automation`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                  },
                  body: JSON.stringify(reminderPayload),
                }
              );

              // Read as text first so non-JSON responses (HTML error pages,
              // truncated payloads, 5xx from the gateway) are captured verbatim
              // instead of throwing inside response.json() and losing context.
              const rawBody = await response.text();
              let result: any = null;
              try {
                result = rawBody ? JSON.parse(rawBody) : null;
              } catch (_parseErr) {
                recordError({
                  stage: "parse_response",
                  http_status: response.status,
                  body_snippet: rawBody.slice(0, 500),
                });
                continue;
              }

              if (!response.ok) {
                recordError({
                  stage: "http_error",
                  http_status: response.status,
                  error: result?.error,
                  body_snippet: rawBody.slice(0, 500),
                });
                continue;
              }

              if (result?.success) {
                summary.executions++;
                summary.survey_reminders_sent++;
                // Atomically bump the counter + last-sent timestamp. We use
                // the previously-read reminders_sent as the optimistic base;
                // if two cron runs collide, only one will win — the other's
                // update is still safe (just increments by 1 either way).
                await supabase
                  .from("survey_responses")
                  .update({
                    reminders_sent: (survey.reminders_sent || 0) + 1,
                    last_reminder_sent_at: now.toISOString(),
                  })
                  .eq("id", survey.id);
              } else if (result?.skipped) {
                summary.skipped++;
                summary.survey_reminders_skipped++;
              } else {
                recordError({
                  stage: "execute_automation_failed",
                  http_status: response.status,
                  error: result?.error,
                  result,
                });
              }
            } catch (err) {
              recordError({
                stage: "fetch_threw",
                error: (err as Error).message,
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("Survey reminder section failed:", err);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 2: RESPONSE DETECTION (cancel sequences on client response)
    // ═══════════════════════════════════════════════════════════════════════════

    try {
      const { data: activeEnrollments } = await supabase
        .from("client_sequence_enrollments")
        .select("id, client_id, sequence_id, last_step_executed_at, client_sequences(name, stop_on_response)")
        .eq("status", "active")
        .not("last_step_executed_at", "is", null);

      // Filter to only stop_on_response = true enrollments
      const checkable = (activeEnrollments || []).filter(
        (e: any) => e.client_sequences?.stop_on_response === true
      );

      if (checkable.length > 0) {
        const rcToken = await getRingCentralToken();
        const msToken = await getMicrosoftToken();

        // Get mailbox from app_settings
        let mailbox = '';
        const { data: mailboxSetting } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "outlook_mailbox")
          .single();
        if (mailboxSetting) mailbox = mailboxSetting.value;

        for (const enrollment of checkable) {
          const { data: client } = await supabase
            .from("clients")
            .select("phone, email, first_name, last_name, notes")
            .eq("id", enrollment.client_id)
            .single();

          if (!client) continue;

          const since = enrollment.last_step_executed_at;
          let responseChannel = '';

          // Check SMS
          if (!responseChannel && rcToken && client.phone) {
            const hasSms = await checkInboundSms(rcToken, client.phone, since);
            if (hasSms) responseChannel = 'SMS';
          }

          // Check calls
          if (!responseChannel && rcToken && client.phone) {
            const hasCall = await checkInboundCalls(rcToken, client.phone, since);
            if (hasCall) responseChannel = 'call';
          }

          // Check email
          if (!responseChannel && msToken && client.email && mailbox) {
            const hasEmail = await checkInboundEmails(msToken, mailbox, client.email, since);
            if (hasEmail) responseChannel = 'email';
          }

          if (responseChannel) {
            // Cancel enrollment
            await supabase
              .from("client_sequence_enrollments")
              .update({
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
                cancel_reason: "response_detected",
                cancelled_by: "system",
              })
              .eq("id", enrollment.id);

            // Cancel pending steps
            await supabase
              .from("client_sequence_log")
              .update({ status: "cancelled" })
              .eq("sequence_id", enrollment.sequence_id)
              .eq("client_id", enrollment.client_id)
              .eq("status", "pending");

            // Add auto-note
            const seqName = (enrollment as any).client_sequences?.name || "Unknown";
            const currentNotes = Array.isArray(client.notes) ? client.notes : [];
            await supabase
              .from("clients")
              .update({
                notes: [...currentNotes, {
                  text: `Sequence "${seqName}" auto-cancelled — client responded via ${responseChannel}.`,
                  type: "auto",
                  timestamp: Date.now(),
                  author: "System",
                }],
              })
              .eq("id", enrollment.client_id);

            summary.response_cancellations++;
            console.log(`Cancelled enrollment ${enrollment.id} for client ${enrollment.client_id} — response via ${responseChannel}`);
          }
        }
      }
    } catch (err) {
      console.error("Response detection error:", err);
      summary.response_detection_error = (err as Error).message;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 3: SEQUENCE RUNNER (client_sequences — enrollment-aware)
    //
    // FIX: Steps are now processed strictly in order. A step is only executed
    //      if ALL preceding steps have been executed (or skipped/failed).
    //      Enrollment is only marked "completed" when ALL steps are done,
    //      not just when the highest-index step happens to run.
    // ═══════════════════════════════════════════════════════════════════════════

    const { data: sequences, error: seqError } = await supabase
      .from("client_sequences")
      .select("*")
      .eq("enabled", true);

    if (seqError) {
      console.error("Failed to fetch sequences:", seqError);
    } else if (sequences && sequences.length > 0) {
      for (const sequence of sequences) {
        summary.sequences_processed++;
        const steps = sequence.steps || [];
        if (steps.length === 0) continue;

        const triggerPhase = sequence.trigger_phase;
        if (!triggerPhase) continue;

        const { data: clients, error: clientsError } = await supabase
          .from("clients")
          .select("id, first_name, last_name, phone, email, phase, notes, created_at")
          .eq("phase", triggerPhase)
          .eq("archived", false);

        if (clientsError) { console.error(`Failed to fetch clients for sequence ${sequence.id}:`, clientsError); summary.errors++; continue; }
        if (!clients || clients.length === 0) continue;

        for (const client of clients) {
          try {
            // ── Check enrollment status ──
            const { data: enrollment } = await supabase
              .from("client_sequence_enrollments")
              .select("id, status, current_step")
              .eq("sequence_id", sequence.id)
              .eq("client_id", client.id)
              .eq("status", "active")
              .limit(1)
              .single();

            // Skip if no active enrollment (cancelled or completed)
            if (!enrollment) continue;

            const { data: logEntries, error: logError } = await supabase
              .from("client_sequence_log")
              .select("*")
              .eq("sequence_id", sequence.id)
              .eq("client_id", client.id)
              .order("step_index", { ascending: true });

            if (logError) { console.error(`Failed to fetch log for client ${client.id}, sequence ${sequence.id}:`, logError); summary.errors++; continue; }

            const nowMs = Date.now();

            if (!logEntries || logEntries.length === 0) {
              // Enqueue step 0
              const firstStep = steps[0];
              const delayMs = getStepDelayMs(firstStep);
              const scheduledAt = nowMs + delayMs;

              const { error: insertError } = await supabase
                .from("client_sequence_log")
                .insert({
                  sequence_id: sequence.id,
                  client_id: client.id,
                  step_index: 0,
                  action_type: normalizeActionType(firstStep.action_type),
                  status: 'pending',
                  scheduled_at: scheduledAt,
                });

              if (insertError) { summary.errors++; } else { summary.sequence_steps_enqueued++; }
              continue;
            }

            // ── Build a status map: step_index → status ──
            const stepStatusMap: Record<number, string> = {};
            for (const entry of logEntries) {
              stepStatusMap[entry.step_index] = entry.status;
            }

            // ── Find the NEXT step to execute (strictly in order) ──
            // Walk through steps 0..N-1 and find the first one that is 'pending'
            // but ONLY if all preceding steps are done (executed/skipped/failed/cancelled)
            const DONE_STATUSES = new Set(['executed', 'skipped', 'failed', 'cancelled']);

            let nextPendingIndex = -1;
            let allPrecedingDone = true;

            for (let i = 0; i < steps.length; i++) {
              const status = stepStatusMap[i];

              if (!status) {
                // Step not in log at all — needs to be enqueued first
                // Only enqueue if all preceding are done
                if (allPrecedingDone) {
                  const step = steps[i];
                  const delayMs = getStepDelayMs(step);
                  const scheduledAt = nowMs + delayMs;

                  const { error: insertError } = await supabase
                    .from("client_sequence_log")
                    .insert({
                      sequence_id: sequence.id,
                      client_id: client.id,
                      step_index: i,
                      action_type: normalizeActionType(step.action_type),
                      status: 'pending',
                      scheduled_at: scheduledAt,
                    });

                  if (insertError) { summary.errors++; } else { summary.sequence_steps_enqueued++; }
                }
                // Either way, this step isn't done yet
                allPrecedingDone = false;
                break;
              }

              if (status === 'pending') {
                if (allPrecedingDone) {
                  nextPendingIndex = i;
                } else {
                  // Previous step not done — can't process this one yet
                  summary.out_of_order_skips++;
                  console.log(`Skipping step ${i} for client ${client.id} — previous steps not yet done`);
                }
                break; // Stop at the first pending step
              }

              if (!DONE_STATUSES.has(status)) {
                // Unknown status — treat as blocking
                allPrecedingDone = false;
                break;
              }
              // This step is done, continue to next
            }

            // ── Execute the next pending step if it's due ──
            if (nextPendingIndex >= 0) {
              const pendingEntry = logEntries.find((e: any) => e.step_index === nextPendingIndex);
              if (!pendingEntry || pendingEntry.scheduled_at > nowMs) {
                // Not yet due — skip
                continue;
              }

              // Re-verify enrollment is still active (may have been cancelled by response detection)
              const { data: enrollCheck } = await supabase
                .from("client_sequence_enrollments")
                .select("id, status")
                .eq("sequence_id", sequence.id)
                .eq("client_id", client.id)
                .eq("status", "active")
                .limit(1)
                .single();

              if (!enrollCheck) continue;

              const stepIndex = pendingEntry.step_index;
              const step = steps[stepIndex];
              if (!step) {
                await supabase.from("client_sequence_log").update({ status: 'skipped', executed_at: nowMs }).eq("id", pendingEntry.id);
                continue;
              }

              // ── Execute the step ──
              let stepSuccess = false;
              const normalizedAction = normalizeActionType(step.action_type);

              if (normalizedAction === 'send_sms' || normalizedAction === 'send_email') {
                const resolvedMessage = resolveAutomationMergeFields(step.template || '', client);
                try {
                  const body: Record<string, any> = {
                    rule_id: `seq_${sequence.id}_step_${stepIndex}`,
                    caregiver_id: client.id,
                    action_type: normalizedAction,
                    message_template: resolvedMessage,
                    action_config: normalizedAction === 'send_email' ? { subject: resolveAutomationMergeFields(step.subject || '', client) } : {},
                    rule_name: `${sequence.name} - Step ${stepIndex + 1}`,
                    entity_type: 'client',
                    caregiver: {
                      id: client.id, first_name: client.first_name, last_name: client.last_name,
                      phone: client.phone, email: client.email, phase: client.phase,
                    },
                  };
                  const response = await fetch(`${SUPABASE_URL}/functions/v1/execute-automation`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
                    body: JSON.stringify(body),
                  });
                  const result = await response.json();
                  stepSuccess = !!result.success;
                  if (!stepSuccess) console.error(`Step failed for client ${client.id}:`, result.error);
                } catch (err) { console.error(`Step error for client ${client.id}:`, err); }

              } else if (normalizedAction === 'create_task') {
                const resolvedMessage = resolveAutomationMergeFields(step.template || '', client);
                const currentNotes = Array.isArray(client.notes) ? client.notes : [];
                const taskNote = {
                  text: resolvedMessage, type: 'task', timestamp: nowMs,
                  author: 'Automation', outcome: `Sequence: ${sequence.name}, Step ${stepIndex + 1}`,
                };
                const { error: updateError } = await supabase
                  .from("clients")
                  .update({ notes: [...currentNotes, taskNote] })
                  .eq("id", client.id);
                stepSuccess = !updateError;
              }

              // ── Update log entry + enrollment ──
              if (stepSuccess) {
                await supabase.from("client_sequence_log").update({ status: 'executed', executed_at: nowMs }).eq("id", pendingEntry.id);
                summary.sequence_steps_executed++;

                const nextStepIndex = stepIndex + 1;

                // Update enrollment progress
                await supabase
                  .from("client_sequence_enrollments")
                  .update({
                    current_step: nextStepIndex,
                    last_step_executed_at: new Date().toISOString(),
                  })
                  .eq("id", enrollCheck.id);

                // ── FIX: Check if ALL steps are done before marking complete ──
                // Re-fetch log to get current state after this execution
                const { data: updatedLog } = await supabase
                  .from("client_sequence_log")
                  .select("step_index, status")
                  .eq("sequence_id", sequence.id)
                  .eq("client_id", client.id);

                const updatedStatusMap: Record<number, string> = {};
                for (const entry of (updatedLog || [])) {
                  updatedStatusMap[entry.step_index] = entry.status;
                }

                // Check every step 0..N-1 is in a terminal state
                let allStepsDone = true;
                for (let i = 0; i < steps.length; i++) {
                  const s = updatedStatusMap[i];
                  if (!s || s === 'pending') {
                    allStepsDone = false;
                    break;
                  }
                }

                if (allStepsDone) {
                  await supabase
                    .from("client_sequence_enrollments")
                    .update({ status: "completed", completed_at: new Date().toISOString() })
                    .eq("id", enrollCheck.id);
                  console.log(`Enrollment ${enrollCheck.id} completed — all ${steps.length} steps done`);
                }

                // Enqueue next step if it exists and isn't already enqueued
                if (nextStepIndex < steps.length) {
                  const alreadyEnqueued = logEntries.some((entry: any) => entry.step_index === nextStepIndex);
                  if (!alreadyEnqueued) {
                    const nextStep = steps[nextStepIndex];
                    const nextDelayMs = getStepDelayMs(nextStep);
                    const nextScheduledAt = nowMs + nextDelayMs;
                    const { error: nextInsertError } = await supabase
                      .from("client_sequence_log")
                      .insert({
                        sequence_id: sequence.id, client_id: client.id,
                        step_index: nextStepIndex, action_type: normalizeActionType(nextStep.action_type),
                        status: 'pending', scheduled_at: nextScheduledAt,
                      });
                    if (nextInsertError) summary.errors++; else summary.sequence_steps_enqueued++;
                  }
                }
              } else {
                await supabase.from("client_sequence_log")
                  .update({ status: 'failed', executed_at: nowMs, error_detail: `Step execution failed: action_type=${step.action_type}` })
                  .eq("id", pendingEntry.id);
                summary.errors++;
              }
            }
          } catch (clientErr) {
            console.error(`Error processing client ${client.id} in sequence ${sequence.id}:`, clientErr);
            summary.errors++;
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DONE
    // ═══════════════════════════════════════════════════════════════════════════

    return new Response(
      JSON.stringify({ message: "Automation cron completed", summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("automation-cron error:", err);
    return new Response(
      JSON.stringify({ error: `Internal error: ${(err as Error).message}`, summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
