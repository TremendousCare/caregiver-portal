// ─────────────────────────────────────────────────────────────────
// Interview Reminders
//
// Cron-invoked worker (every 5 minutes, see migration
// 20260514000000_interview_reminder_trigger_and_cron.sql) that sends
// SMS / email reminders to caregivers ahead of their scheduled
// Microsoft Bookings interviews.
//
// Why a dedicated cron job (not a section inside automation-cron):
//   The shared automation-cron runs every 30 minutes. A 15-minute
//   reminder needs cron precision ≤ the lead time, so we'd have to
//   bump that schedule 6× to support this trigger — re-running every
//   survey / availability / shift-reminder rule far more often than
//   necessary. A dedicated 5-minute job keeps the cadence change
//   scoped to interview reminders.
//
// Per rule:
//   1. Parse conditions.minutes_before into a sorted list of lead
//      times (supports single value, array, or "15, 60" string).
//   2. Bound a candidate window: every caregiver_interviews row with
//      start_at in [now, now + max_lead + buffer], status in
//      ('booked', 'rescheduled'), org scoped to the rule's org.
//   3. For each (interview × minutes_before) pair, check
//      isInReminderWindow(). If yes, dedup against automation_log
//      keyed on (rule_id, interview_id, minutes_before) so reschedules
//      and re-runs don't double-send.
//   4. Resolve recipient: matched caregiver's phone wins; falls back
//      to interview.customer_phone for unmatched-but-known bookings.
//   5. POST to execute-automation with a pre-formatted trigger_context
//      so the template can resolve {{interview_start_text}},
//      {{interview_join_url}}, {{minutes_until}}, etc.
//
// Rate-limit pacing matches the survey / shift reminder cadence:
// 10-second spacing between sends, well under RingCentral's 40 SMS /
// 60s limit, with comfortable headroom for staff manual sends.
//
// Production safety:
//   - Idempotent via automation_log dedup on (rule_id, interview_id,
//     minutes_before). A second cron tick inside the same 5-min
//     window will not re-send.
//   - Skips: cancelled / completed / no_show interviews; archived or
//     sms_opted_out caregivers (latter happens inside
//     execute-automation as the single TCPA gate).
//   - Org-scoped: rules carry org_id, interviews carry org_id, the
//     query joins on both.
// ─────────────────────────────────────────────────────────────────

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  parseInterviewReminderMinutes,
  isInReminderWindow,
  computeInterviewReminderLookaheadMs,
  formatInterviewStartText,
  isInterviewStatusReminderEligible,
  INTERVIEW_REMINDER_ACTIVE_STATUSES,
} from '../_shared/helpers/bookings.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const REMINDER_SEND_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProcessSummary {
  rules_processed: number;
  candidates: number;
  executions: number;
  skipped: number;
  errors: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const summary: ProcessSummary = {
    rules_processed: 0,
    candidates: 0,
    executions: 0,
    skipped: 0,
    errors: 0,
  };
  const now = new Date();
  const nowMs = now.getTime();

  try {
    const { data: rules, error: rulesErr } = await supabase
      .from('automation_rules')
      .select('*')
      .eq('enabled', true)
      .eq('trigger_type', 'interview_reminder');

    if (rulesErr) {
      console.error('Failed to fetch interview_reminder rules:', rulesErr);
      return new Response(
        JSON.stringify({ ok: false, error: rulesErr.message, summary }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!rules || rules.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, summary }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    for (const rule of rules) {
      summary.rules_processed++;

      const minutesBeforeList = parseInterviewReminderMinutes(rule.conditions?.minutes_before);
      if (minutesBeforeList.length === 0) {
        // Malformed rule — log and skip rather than crash the cron run.
        console.warn(
          `Skipping rule ${rule.id} (${rule.name}): no valid minutes_before in conditions`,
          rule.conditions,
        );
        continue;
      }

      const lookaheadMs = computeInterviewReminderLookaheadMs(minutesBeforeList);
      const windowEnd = new Date(nowMs + lookaheadMs).toISOString();
      // Look slightly into the past too so the per-(interview,
      // minutes_before) window-overlap check has the right candidates
      // even if a previous tick missed (e.g. function cold-start
      // jitter, transient DB error).
      const windowStart = new Date(nowMs - 5 * 60 * 1000).toISOString();

      let interviewQuery = supabase
        .from('caregiver_interviews')
        .select(
          'id, org_id, caregiver_id, start_at, end_at, status, join_web_url, customer_phone, customer_name, service_name',
        )
        .gte('start_at', windowStart)
        .lte('start_at', windowEnd)
        .in('status', INTERVIEW_REMINDER_ACTIVE_STATUSES as readonly string[]);

      // automation_rules does not yet carry org_id (Phase B retrofit
      // hasn't reached this table). Interviews ARE org-scoped via
      // caregiver_interviews.org_id, so when org_id eventually lands
      // on rules this guard scopes the query. Today (single-org
      // Tremendous Care) it's a no-op — same scope as every other
      // section in automation-cron.
      if ((rule as any).org_id) {
        interviewQuery = interviewQuery.eq('org_id', (rule as any).org_id);
      }

      const { data: candidateInterviews, error: interviewsErr } = await interviewQuery;
      if (interviewsErr) {
        console.error(`Failed to fetch interviews for rule ${rule.id}:`, interviewsErr);
        summary.errors++;
        continue;
      }
      if (!candidateInterviews || candidateInterviews.length === 0) continue;

      // Bulk pre-fetch every prior success for this rule across the
      // candidate interview set. Build a Set of (interview_id, minutes_before)
      // pairs already sent.
      const interviewIds = candidateInterviews.map((i: any) => i.id);
      const { data: priorSends } = await supabase
        .from('automation_log')
        .select('trigger_context')
        .eq('rule_id', rule.id)
        .eq('status', 'success')
        .in('trigger_context->>interview_id', interviewIds);
      const alreadySent = new Set<string>();
      for (const row of priorSends || []) {
        const iid = (row as any)?.trigger_context?.interview_id;
        const mb = (row as any)?.trigger_context?.minutes_before;
        if (iid && (mb || mb === 0)) {
          alreadySent.add(`${iid}::${mb}`);
        }
      }

      // Bulk fetch matched caregivers so we don't N+1 inside the loop.
      const cgIds = Array.from(
        new Set(candidateInterviews.map((i: any) => i.caregiver_id).filter(Boolean)),
      );
      const cgMap = new Map<string, any>();
      if (cgIds.length > 0) {
        const { data: cgRows } = await supabase
          .from('caregivers')
          .select('id, first_name, last_name, phone, email, sms_opted_out, archived')
          .in('id', cgIds);
        for (const cg of cgRows || []) cgMap.set(cg.id, cg);
      }

      // Iterate (interview × minutes_before). Order: minutes_before is
      // pre-sorted descending so 24-hour reminders fire before 15-min
      // reminders for the same interview (only matters if a single tick
      // spans multiple windows — rare but deterministic).
      for (const interview of candidateInterviews) {
        if (!isInterviewStatusReminderEligible(interview.status)) {
          summary.skipped++;
          continue;
        }

        for (const minutesBefore of minutesBeforeList) {
          if (!isInReminderWindow({ startAt: interview.start_at, minutesBefore, now: nowMs })) {
            continue;
          }
          summary.candidates++;

          const dedupKey = `${interview.id}::${minutesBefore}`;
          if (alreadySent.has(dedupKey)) {
            summary.skipped++;
            continue;
          }

          // Recipient resolution. Matched caregiver wins; if no match
          // we can't dispatch (execute-automation requires caregiver_id
          // for logging + dedup). Unmatched bookings are skipped — the
          // ops team handles them out-of-band via the interviews UI.
          const caregiver = interview.caregiver_id ? cgMap.get(interview.caregiver_id) : null;
          if (!caregiver) {
            summary.skipped++;
            continue;
          }
          if (caregiver.archived) {
            summary.skipped++;
            continue;
          }
          // sms_opted_out is enforced by execute-automation's TCPA
          // gate — we still pre-skip here to avoid spending the
          // 10-second pacing budget on a guaranteed no-op.
          if (caregiver.sms_opted_out && rule.action_type === 'send_sms') {
            summary.skipped++;
            continue;
          }

          const interviewStartText = formatInterviewStartText(interview.start_at);
          const minutesUntilStart = Math.max(
            0,
            Math.round((Date.parse(interview.start_at) - nowMs) / 60000),
          );

          try {
            const response = await fetch(
              `${SUPABASE_URL}/functions/v1/execute-automation`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                  rule_id: rule.id,
                  caregiver_id: caregiver.id,
                  action_type: rule.action_type,
                  message_template: rule.message_template,
                  action_config: rule.action_config,
                  rule_name: rule.name,
                  caregiver: {
                    id: caregiver.id,
                    first_name: caregiver.first_name,
                    last_name: caregiver.last_name,
                    phone: caregiver.phone,
                    email: caregiver.email,
                  },
                  trigger_context: {
                    interview_id: interview.id,
                    minutes_before: minutesBefore,
                    interview_start_at: interview.start_at,
                    interview_start_text: interviewStartText,
                    interview_join_url: interview.join_web_url || '',
                    interview_service_name: interview.service_name || '',
                    minutes_until: String(minutesUntilStart),
                  },
                }),
              },
            );
            const result = await response.json();
            if (result.success) {
              summary.executions++;
              alreadySent.add(dedupKey);
            } else if (result.skipped) {
              summary.skipped++;
            } else {
              summary.errors++;
              console.error(
                `Interview reminder failed (rule ${rule.name}, interview ${interview.id}, minutes_before ${minutesBefore}):`,
                result.error,
              );
            }
          } catch (err) {
            summary.errors++;
            console.error(
              `execute-automation call failed for interview ${interview.id}:`,
              err,
            );
          }

          await sleep(REMINDER_SEND_DELAY_MS);
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: true, summary }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('interview-reminders failed:', err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message, summary }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
