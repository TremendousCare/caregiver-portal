import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logMetric, startTimer } from "../_shared/operations/metrics.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Record<string, any> = {};
  const doneInvocation = startTimer(supabase, "outcome-analyzer", "invocation");

  // ── Job 1: Mark expired actions ──
  try {
    const { data: expired, error } = await supabase
      .from("action_outcomes")
      .update({
        outcome_type: "expired",
        outcome_detected_at: new Date().toISOString(),
        outcome_detail: { reason: "past_expiry_window" },
      })
      .is("outcome_type", null)
      .lt("expires_at", new Date().toISOString())
      .select("id");

    results.expired = { count: expired?.length || 0, error: error?.message };
  } catch (err) {
    results.expired = { error: (err as Error).message };
    logMetric(supabase, "outcome-analyzer", "error", undefined, false, {
      job: "expired_actions",
      error: (err as Error).message,
    });
  }

  // ── Job 2: Mark no-response at expiry window (not 48h) ──
  // Changed from 48h to expiry window to avoid premature marking.
  // Late responses (Job 3) can still upgrade no_response → response_received.
  try {
    const now = new Date().toISOString();

    const { data: pending, error } = await supabase
      .from("action_outcomes")
      .select("id, action_type, created_at")
      .is("outcome_type", null)
      .lt("expires_at", now)
      .in("action_type", ["sms_sent", "email_sent"])
      .limit(100);

    if (error) {
      results.no_response = { error: error.message };
    } else {
      let noResponseCount = 0;
      for (const action of pending || []) {
        const hoursWaited = Math.round(
          (Date.now() - new Date(action.created_at).getTime()) /
            (1000 * 60 * 60),
        );

        const { error: updateErr } = await supabase
          .from("action_outcomes")
          .update({
            outcome_type: "no_response",
            outcome_detected_at: new Date().toISOString(),
            outcome_detail: { hours_waited: hoursWaited },
          })
          .eq("id", action.id);

        if (updateErr) {
          console.error(`[outcome-analyzer] Failed to mark no_response for ${action.id}:`, updateErr);
        } else {
          noResponseCount++;
        }
      }

      results.no_response = { count: noResponseCount };
    }
  } catch (err) {
    results.no_response = { error: (err as Error).message };
    logMetric(supabase, "outcome-analyzer", "error", undefined, false, {
      job: "no_response",
      error: (err as Error).message,
    });
  }

  // ── Job 3: Correlate inbound SMS with pending or no_response actions ──
  // Matches pending (outcome_type IS NULL) first, then upgrades no_response
  // if a late reply arrives before expiry.
  try {
    // Find recent inbound SMS from the last 24 hours
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: inboundSms } = await supabase
      .from("message_routing_queue")
      .select(
        "sender_identifier, message_text, matched_entity_type, matched_entity_id, processed_at",
      )
      .eq("channel", "sms")
      .eq("direction", "inbound")
      .in("status", ["processed", "processing"])
      .gte("processed_at", since24h)
      .order("processed_at", { ascending: false })
      .limit(50);

    let smsCorrelated = 0;
    for (const sms of inboundSms || []) {
      if (!sms.matched_entity_id) continue;

      // First try: find a pending (null outcome) sms_sent action
      const { data: pendingAction } = await supabase
        .from("action_outcomes")
        .select("id, created_at")
        .eq("action_type", "sms_sent")
        .eq("entity_id", sms.matched_entity_id)
        .is("outcome_type", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      // Second try: find a no_response action that hasn't expired yet (late reply)
      let actionToUpdate = pendingAction;
      if (!actionToUpdate) {
        const { data: noResponseAction } = await supabase
          .from("action_outcomes")
          .select("id, created_at")
          .eq("action_type", "sms_sent")
          .eq("entity_id", sms.matched_entity_id)
          .eq("outcome_type", "no_response")
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .single();
        actionToUpdate = noResponseAction;
      }

      if (actionToUpdate) {
        const hoursElapsed =
          Math.round(
            ((new Date(sms.processed_at).getTime() -
              new Date(actionToUpdate.created_at).getTime()) /
              (1000 * 60 * 60)) *
              10,
          ) / 10;

        const { error: updateErr } = await supabase
          .from("action_outcomes")
          .update({
            outcome_type: "response_received",
            outcome_detected_at: new Date().toISOString(),
            outcome_detail: {
              channel: "sms",
              hours_to_outcome: hoursElapsed,
              response_preview: sms.message_text?.slice(0, 200) || null,
              late_response: !pendingAction, // flag if this upgraded a no_response
            },
          })
          .eq("id", actionToUpdate.id);

        if (updateErr) {
          console.error(`[outcome-analyzer] Failed to correlate SMS for ${actionToUpdate.id}:`, updateErr);
        } else {
          smsCorrelated++;
        }
      }
    }

    results.sms_correlated = { count: smsCorrelated };
  } catch (err) {
    results.sms_correlated = { error: (err as Error).message };
    logMetric(supabase, "outcome-analyzer", "error", undefined, false, {
      job: "sms_correlation",
      error: (err as Error).message,
    });
  }

  // ── Job 4: Semantic memory generation ──
  try {
    let memoryCount = 0;

    // Query resolved outcomes from the last 90 days (not expired)
    const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: allOutcomes } = await supabase
      .from("action_outcomes")
      .select(
        "action_type, outcome_type, outcome_detail, action_context, created_at",
      )
      .not("outcome_type", "is", null)
      .not("outcome_type", "eq", "expired")
      .gte("created_at", since90d)
      .order("created_at", { ascending: false })
      .limit(500);

    if (allOutcomes && allOutcomes.length >= 30) {
      // Group by action_type
      const groups: Record<string, any[]> = {};
      for (const o of allOutcomes) {
        const key = o.action_type;
        if (!groups[key]) groups[key] = [];
        groups[key].push(o);
      }

      for (const [actionType, outcomes] of Object.entries(groups)) {
        if (outcomes.length < 30) continue; // Confidence gate: 30+ data points required

        const total = outcomes.length;
        const successes = outcomes.filter(
          (o: any) =>
            o.outcome_type === "response_received" ||
            o.outcome_type === "completed",
        ).length;
        const successRate = Math.round((successes / total) * 100);

        // Calculate avg response time for successes
        const responseTimes = outcomes
          .filter((o: any) => o.outcome_detail?.hours_to_outcome)
          .map((o: any) => o.outcome_detail.hours_to_outcome);
        const avgResponseHours =
          responseTimes.length > 0
            ? Math.round(
                (responseTimes.reduce((a: number, b: number) => a + b, 0) /
                  responseTimes.length) *
                  10,
              ) / 10
            : null;

        // Sliding confidence based on sample size:
        // 30-49: 0.7, 50-99: 0.75, 100+: 0.85
        const confidence = total >= 100 ? 0.85 : total >= 50 ? 0.75 : 0.7;

        // Build the memory content
        const actionLabel = actionType.replace(/_/g, " ");
        let content = `${actionLabel}: ${successRate}% success rate (${total} observations, last 90 days)`;
        if (avgResponseHours) {
          content += `. Average response time: ${avgResponseHours} hours`;
        }

        // Check if we already have a memory for this pattern
        const tags = [actionType, "outcome_pattern", "system_wide"];
        const { data: existing } = await supabase
          .from("context_memory")
          .select("id, content")
          .eq("memory_type", "semantic")
          .eq("source", "outcome_analysis")
          .eq("entity_type", "system")
          .contains("tags", [actionType, "outcome_pattern"])
          .is("superseded_by", null)
          .limit(1)
          .single();

        if (existing) {
          // Supersede the old memory with updated stats.
          // Insert new memory FIRST — superseded_by has a FK constraint
          // on context_memory.id, so the target must exist before update.
          const newMemoryId = crypto.randomUUID();
          const { error: insertErr } = await supabase.from("context_memory").insert({
            id: newMemoryId,
            memory_type: "semantic",
            entity_type: "system",
            content,
            confidence,
            source: "outcome_analysis",
            tags,
          });

          if (insertErr) {
            console.error(`[outcome-analyzer] Failed to insert semantic memory for ${actionType}:`, insertErr);
            continue;
          }

          const { error: updateErr } = await supabase
            .from("context_memory")
            .update({ superseded_by: newMemoryId })
            .eq("id", existing.id);

          if (updateErr) {
            console.error(`[outcome-analyzer] Failed to supersede memory ${existing.id}:`, updateErr);
          }
        } else {
          // Create new memory
          const { error: insertErr } = await supabase.from("context_memory").insert({
            memory_type: "semantic",
            entity_type: "system",
            content,
            confidence,
            source: "outcome_analysis",
            tags,
          });

          if (insertErr) {
            console.error(`[outcome-analyzer] Failed to insert new semantic memory for ${actionType}:`, insertErr);
            continue;
          }
        }

        memoryCount++;
      }
    }

    results.memories_generated = { count: memoryCount };
  } catch (err) {
    results.memories_generated = { error: (err as Error).message };
    logMetric(supabase, "outcome-analyzer", "error", undefined, false, {
      job: "memory_generation",
      error: (err as Error).message,
    });
  }

  doneInvocation(true, results);

  return new Response(JSON.stringify({ success: true, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
