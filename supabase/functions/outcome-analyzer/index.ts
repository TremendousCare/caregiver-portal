import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
  }

  // ── Job 2: Mark no-response after 48 hours ──
  try {
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: pending } = await supabase
      .from("action_outcomes")
      .select("id, action_type, created_at")
      .is("outcome_type", null)
      .lt("created_at", cutoff48h)
      .gt("expires_at", new Date().toISOString())
      .in("action_type", ["sms_sent", "email_sent"])
      .limit(100);

    let noResponseCount = 0;
    for (const action of pending || []) {
      const hoursWaited = Math.round(
        (Date.now() - new Date(action.created_at).getTime()) /
          (1000 * 60 * 60),
      );

      await supabase
        .from("action_outcomes")
        .update({
          outcome_type: "no_response",
          outcome_detected_at: new Date().toISOString(),
          outcome_detail: { hours_waited: hoursWaited },
        })
        .eq("id", action.id);

      noResponseCount++;
    }

    results.no_response = { count: noResponseCount };
  } catch (err) {
    results.no_response = { error: (err as Error).message };
  }

  // ── Job 3: Correlate inbound SMS with pending actions ──
  try {
    // Find recent inbound SMS from the last 24 hours
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: inboundSms } = await supabase
      .from("inbound_sms_log")
      .select(
        "from_phone, message_text, matched_entity_type, matched_entity_id, processed_at",
      )
      .gte("processed_at", since24h)
      .limit(50);

    let smsCorrelated = 0;
    for (const sms of inboundSms || []) {
      if (!sms.matched_entity_id) continue;

      // Find a pending sms_sent action for this entity
      const { data: pendingAction } = await supabase
        .from("action_outcomes")
        .select("id, created_at")
        .eq("action_type", "sms_sent")
        .eq("entity_id", sms.matched_entity_id)
        .is("outcome_type", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (pendingAction) {
        const hoursElapsed =
          Math.round(
            ((new Date(sms.processed_at).getTime() -
              new Date(pendingAction.created_at).getTime()) /
              (1000 * 60 * 60)) *
              10,
          ) / 10;

        await supabase
          .from("action_outcomes")
          .update({
            outcome_type: "response_received",
            outcome_detected_at: new Date().toISOString(),
            outcome_detail: {
              channel: "sms",
              hours_to_outcome: hoursElapsed,
              response_preview: sms.message_text?.slice(0, 200) || null,
            },
          })
          .eq("id", pendingAction.id);

        smsCorrelated++;
      }
    }

    results.sms_correlated = { count: smsCorrelated };
  } catch (err) {
    results.sms_correlated = { error: (err as Error).message };
  }

  // ── Job 4: Semantic memory generation ──
  try {
    let memoryCount = 0;

    // Query all resolved outcomes (not expired)
    const { data: allOutcomes } = await supabase
      .from("action_outcomes")
      .select(
        "action_type, outcome_type, outcome_detail, action_context, created_at",
      )
      .not("outcome_type", "is", null)
      .not("outcome_type", "eq", "expired")
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

        // Determine confidence based on sample size
        const confidence = total >= 100 ? 0.85 : 0.6;

        // Build the memory content
        const actionLabel = actionType.replace(/_/g, " ");
        let content = `${actionLabel}: ${successRate}% success rate (${total} observations)`;
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
          // Supersede the old memory with updated stats
          const newMemoryId = crypto.randomUUID();
          await supabase
            .from("context_memory")
            .update({ superseded_by: newMemoryId })
            .eq("id", existing.id);

          await supabase.from("context_memory").insert({
            id: newMemoryId,
            memory_type: "semantic",
            entity_type: "system",
            content,
            confidence,
            source: "outcome_analysis",
            tags,
            expires_at:
              confidence < 0.7
                ? new Date(
                    Date.now() + 90 * 24 * 60 * 60 * 1000,
                  ).toISOString()
                : null,
          });
        } else {
          // Create new memory
          await supabase.from("context_memory").insert({
            memory_type: "semantic",
            entity_type: "system",
            content,
            confidence,
            source: "outcome_analysis",
            tags,
            expires_at:
              confidence < 0.7
                ? new Date(
                    Date.now() + 90 * 24 * 60 * 60 * 1000,
                  ).toISOString()
                : null,
          });
        }

        memoryCount++;
      }
    }

    results.memories_generated = { count: memoryCount };
  } catch (err) {
    results.memories_generated = { error: (err as Error).message };
  }

  return new Response(JSON.stringify({ success: true, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
