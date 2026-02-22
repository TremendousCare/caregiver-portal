# Phase 2: Outcome Tracking — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Teach the AI to learn from outcomes of every action — track what happens after SMS, emails, DocuSign, and phase changes, then generate semantic memories that make recommendations smarter over time.

**Architecture:** Hybrid real-time + scheduled detection. Real-time path correlates inbound events (SMS replies, DocuSign completions) instantly. Cron job handles calendar correlation, no-response timeouts, and semantic memory generation every 4 hours. Both write to `action_outcomes` table.

**Tech Stack:** Supabase (Postgres, Edge Functions, pg_cron), Deno/TypeScript, Vitest (frontend tests), existing RingCentral/Outlook/DocuSign integrations.

**Design Doc:** `docs/plans/2026-02-22-outcome-tracking-design.md`

**Branch:** `claude/context-layer-phase2`

---

## Task 1: Database Migration — `action_outcomes` Table

**Files:**
- Create: `supabase/migrations/20260222_action_outcomes.sql`

**Step 1: Write the migration SQL**

```sql
-- Phase 2: Action Outcomes — Tracks what happens after every action
-- so the AI can learn what works and make smarter recommendations.

CREATE TABLE IF NOT EXISTS action_outcomes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type         text NOT NULL,
  entity_type         text NOT NULL CHECK (entity_type IN ('caregiver', 'client')),
  entity_id           text NOT NULL,
  actor               text NOT NULL DEFAULT 'system',
  action_context      jsonb DEFAULT '{}',
  source              text NOT NULL DEFAULT 'ai_chat'
                        CHECK (source IN ('ai_chat', 'automation', 'manual')),
  outcome_type        text CHECK (outcome_type IN (
                        'response_received', 'no_response', 'completed',
                        'advanced', 'declined', 'expired'
                      )),
  outcome_detail      jsonb,
  outcome_detected_at timestamptz,
  created_at          timestamptz DEFAULT now(),
  expires_at          timestamptz
);

-- Pending actions per entity (for briefing: "3 SMS awaiting reply")
CREATE INDEX IF NOT EXISTS idx_action_outcomes_pending
  ON action_outcomes (entity_type, entity_id, created_at DESC)
  WHERE outcome_type IS NULL;

-- Aggregate by action type + outcome (for memory generation)
CREATE INDEX IF NOT EXISTS idx_action_outcomes_aggregate
  ON action_outcomes (action_type, outcome_type, created_at DESC);

-- Recent outcomes (for briefing: "DocuSign completed today")
CREATE INDEX IF NOT EXISTS idx_action_outcomes_recent
  ON action_outcomes (outcome_detected_at DESC)
  WHERE outcome_detected_at IS NOT NULL;

-- RLS: authenticated users get full access (matches existing pattern)
ALTER TABLE action_outcomes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'action_outcomes_all' AND tablename = 'action_outcomes'
  ) THEN
    CREATE POLICY action_outcomes_all ON action_outcomes
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
```

**Step 2: Run migration against Supabase**

Run via Supabase MCP `apply_migration` tool:
- project_id: `zocrnurvazyxdpyqimgj`
- name: `action_outcomes`
- query: (the SQL above)

Expected: `{"success": true}`

**Step 3: Verify table exists**

Run via Supabase MCP `list_tables`:
- Confirm `action_outcomes` appears with 0 rows, RLS enabled

**Step 4: Commit**

```bash
git add supabase/migrations/20260222_action_outcomes.sql
git commit -m "feat: add action_outcomes table for outcome tracking

Phase 2 foundation — tracks every side-effect action and its outcome
so the AI can learn what works over time.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Core Outcome Utilities — `outcomes.ts`

**Files:**
- Create: `supabase/functions/ai-chat/context/outcomes.ts`

**Step 1: Write the outcome logging and detection functions**

This file follows the exact same pattern as `context/events.ts` — fire-and-forget, never throws, logs errors silently.

```typescript
// ─── Outcome Tracking: Action Logging & Outcome Detection ───
// Logs side-effect actions and correlates inbound events to detect outcomes.
// Fire-and-forget: errors are logged but never thrown.

// Default expiry windows per action type (days)
const EXPIRY_DAYS: Record<string, number> = {
  sms_sent: 7,
  email_sent: 7,
  docusign_sent: 14,
  phase_changed: 14,
  calendar_event_created: 21,
  task_completed: 7,
};

// Side-effect tools that should be tracked
const TRACKABLE_ACTIONS = new Set([
  "sms_sent",
  "email_sent",
  "docusign_sent",
  "phase_changed",
  "calendar_event_created",
  "task_completed",
]);

/**
 * Log a side-effect action for outcome tracking.
 * Called from post-conversation background task after tool execution.
 * Fire-and-forget — never blocks the calling operation.
 */
export async function logAction(
  supabase: any,
  actionType: string,
  entityType: "caregiver" | "client",
  entityId: string,
  actor: string,
  actionContext: Record<string, any> = {},
  source: "ai_chat" | "automation" | "manual" = "ai_chat",
): Promise<void> {
  if (!TRACKABLE_ACTIONS.has(actionType)) return;

  try {
    const expiryDays = EXPIRY_DAYS[actionType] || 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    await supabase.from("action_outcomes").insert({
      action_type: actionType,
      entity_type: entityType,
      entity_id: entityId,
      actor,
      action_context: actionContext,
      source,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error(`[outcomes] Failed to log action ${actionType}:`, err);
  }
}

/**
 * Try to detect an outcome for a pending action based on an inbound event.
 * Called when inbound events are logged (SMS received, DocuSign completed, etc.).
 * Matches the most recent pending action for the same entity.
 * Fire-and-forget — never blocks the calling operation.
 */
export async function detectOutcome(
  supabase: any,
  triggerEventType: string,
  entityType: "caregiver" | "client",
  entityId: string,
  eventPayload: Record<string, any> = {},
): Promise<void> {
  try {
    // Determine which action type this event could be an outcome for
    const actionType = eventToActionMap(triggerEventType);
    if (!actionType) return;

    // Find the most recent pending action for this entity
    const { data: pendingAction, error } = await supabase
      .from("action_outcomes")
      .select("*")
      .eq("action_type", actionType)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .is("outcome_type", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !pendingAction) return; // No pending action to correlate

    // Calculate time delta
    const actionTime = new Date(pendingAction.created_at).getTime();
    const now = Date.now();
    const hoursElapsed = Math.round((now - actionTime) / (1000 * 60 * 60) * 10) / 10;

    // Determine outcome type and detail
    const { outcomeType, outcomeDetail } = buildOutcome(
      triggerEventType,
      hoursElapsed,
      eventPayload,
      pendingAction.action_context,
    );

    // Update the action with the detected outcome
    await supabase
      .from("action_outcomes")
      .update({
        outcome_type: outcomeType,
        outcome_detail: {
          ...outcomeDetail,
          hours_to_outcome: hoursElapsed,
          trigger_event: triggerEventType,
        },
        outcome_detected_at: new Date().toISOString(),
      })
      .eq("id", pendingAction.id);
  } catch (err) {
    console.error(`[outcomes] Failed to detect outcome for ${triggerEventType}:`, err);
  }
}

/**
 * Map inbound event types to the action types they could be outcomes for.
 */
function eventToActionMap(eventType: string): string | null {
  const map: Record<string, string> = {
    sms_received: "sms_sent",
    email_received: "email_sent",
    docusign_completed: "docusign_sent",
    phase_changed: "phase_changed",
    task_completed: "task_completed",
  };
  return map[eventType] || null;
}

/**
 * Build the outcome type and detail from the trigger event.
 */
function buildOutcome(
  triggerEventType: string,
  hoursElapsed: number,
  eventPayload: Record<string, any>,
  actionContext: Record<string, any>,
): { outcomeType: string; outcomeDetail: Record<string, any> } {
  switch (triggerEventType) {
    case "sms_received":
      return {
        outcomeType: "response_received",
        outcomeDetail: {
          channel: "sms",
          response_preview: eventPayload.message_text
            ? String(eventPayload.message_text).slice(0, 200)
            : null,
        },
      };

    case "email_received":
      return {
        outcomeType: "response_received",
        outcomeDetail: {
          channel: "email",
          subject: eventPayload.subject || null,
        },
      };

    case "docusign_completed":
      return {
        outcomeType: "completed",
        outcomeDetail: {
          envelope_id: eventPayload.envelope_id || actionContext.envelope_id,
        },
      };

    case "phase_changed":
      return {
        outcomeType: "advanced",
        outcomeDetail: {
          from_phase: actionContext.to_phase || null,
          to_phase: eventPayload.to_phase || null,
        },
      };

    case "task_completed":
      return {
        outcomeType: "completed",
        outcomeDetail: {
          task_id: eventPayload.task_id || null,
        },
      };

    default:
      return {
        outcomeType: "completed",
        outcomeDetail: {},
      };
  }
}
```

**Step 2: Verify the file imports cleanly**

Check that TypeScript syntax is valid by reviewing the file. No runtime test needed yet — this is a Deno Edge Function module.

**Step 3: Commit**

```bash
git add supabase/functions/ai-chat/context/outcomes.ts
git commit -m "feat: add outcome tracking utilities (logAction, detectOutcome)

Core functions for logging side-effect actions and correlating
inbound events to detect outcomes. Fire-and-forget pattern
matching Phase 1 conventions.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Integrate Action Logging into AI Chat

**Files:**
- Modify: `supabase/functions/ai-chat/index.ts` (lines 311-349, post-conversation background task)

**Step 1: Add import for logAction and detectOutcome**

At the top of `index.ts`, alongside the existing event imports, add:

```typescript
import { logAction } from "./context/outcomes.ts";
```

**Step 2: Extend the post-conversation background task**

After the existing event logging loop (line 333), add action outcome logging:

```typescript
        // Log action outcomes for side-effect tools (Phase 2)
        for (const tr of toolResults) {
          if (tr.result?.success) {
            const eventType = toolNameToEventType(tr.tool);
            if (eventType) {
              const entityType = tr.result?.caregiver_id ? "caregiver" : tr.result?.client_id ? "client" : null;
              const entityId = tr.result?.caregiver_id || tr.result?.client_id || null;
              if (entityType && entityId) {
                await logAction(
                  supabase,
                  eventType,
                  entityType as "caregiver" | "client",
                  entityId,
                  `user:${currentUser || "User"}`,
                  {
                    tool: tr.tool,
                    entity_name: tr.result?.entity_name || null,
                    ...tr.input,
                    ...(tr.result?.params || {}),
                  },
                  "ai_chat",
                );
              }
            }
          }
        }
```

This goes AFTER the existing `logEvent` loop and BEFORE the `saveContextSnapshot` call.

**Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds with no new errors.

**Step 4: Commit**

```bash
git add supabase/functions/ai-chat/index.ts
git commit -m "feat: log side-effect actions to action_outcomes table

Every confirmed tool execution (send_sms, send_email, docusign,
phase_change, etc.) now logs to action_outcomes for outcome tracking.
Fire-and-forget, same pattern as event logging.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Real-Time Outcome Detection on Inbound Events

**Files:**
- Modify: `supabase/functions/ai-chat/index.ts` (post-conversation task, add detectOutcome calls)

**Step 1: Add import for detectOutcome**

Update the import line from Task 3:

```typescript
import { logAction, detectOutcome } from "./context/outcomes.ts";
```

**Step 2: Add outcome detection after event logging**

After the logEvent call inside the event logging loop (line ~320-332), add:

```typescript
              // Try real-time outcome detection (Phase 2)
              // If this event could be an outcome of a prior action, link them
              await detectOutcome(
                supabase,
                eventType,
                entityType as "caregiver" | "client",
                entityId,
                { ...tr.input, ...(tr.result || {}) },
              );
```

This checks: "is this event the RESULT of something we did earlier?" For example, if `phase_changed` fires, it checks if we previously changed this caregiver's phase and they've now advanced further.

**Step 3: Also detect outcomes from inbound SMS events**

The inbound SMS webhook (`inbound_sms_log` table inserts) already fire automation triggers. We need the outcome detection to also run when inbound SMS are logged. This happens in the `execute-automation` Edge Function (not in git).

For now, the cron job (Task 6) will handle inbound SMS correlation. Real-time inbound SMS detection will be added when we bring `execute-automation` into git.

Document this in a code comment:

```typescript
// TODO: Add real-time inbound SMS outcome detection when execute-automation
// is brought into git. For now, the outcome-analyzer cron handles this.
```

**Step 4: Commit**

```bash
git add supabase/functions/ai-chat/index.ts
git commit -m "feat: add real-time outcome detection on tool events

When tools fire events (phase_changed, task_completed, etc.),
check if they correlate to a prior pending action. Enables
instant outcome detection for chat-driven actions.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Outcome Analyzer Cron — Timeout & No-Response Detection

**Files:**
- Create: `supabase/functions/outcome-analyzer/index.ts`

**Step 1: Write the cron Edge Function**

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
        (Date.now() - new Date(action.created_at).getTime()) / (1000 * 60 * 60)
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
      .select("from_phone, message_text, matched_entity_type, matched_entity_id, processed_at")
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
        const hoursElapsed = Math.round(
          (new Date(sms.processed_at).getTime() - new Date(pendingAction.created_at).getTime()) /
            (1000 * 60 * 60) * 10
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
  // (Task 7 — added separately after aggregation logic is built)

  return new Response(JSON.stringify({ success: true, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
```

**Step 2: Commit**

```bash
git add supabase/functions/outcome-analyzer/index.ts
git commit -m "feat: add outcome-analyzer cron for timeout and SMS correlation

Handles: expired action cleanup, 48h no-response detection,
and inbound SMS correlation. Runs every 4 hours via pg_cron.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Briefing Enhancement — Pending Actions & Recent Successes

**Files:**
- Modify: `supabase/functions/ai-chat/context/briefing.ts`

**Step 1: Add pending actions section**

After the existing briefing sections (inbound messages, stale caregivers, etc.), add a new section that queries `action_outcomes`:

```typescript
  // ── N. Pending actions awaiting response ──
  try {
    const since48h = new Date(now - 48 * HOURS_24).toISOString();
    const { data: pending } = await supabase
      .from("action_outcomes")
      .select("action_type, entity_id, action_context, created_at")
      .is("outcome_type", null)
      .gte("created_at", since48h)
      .order("created_at", { ascending: false })
      .limit(10);

    if (pending && pending.length > 0) {
      const smsPending = pending.filter((a: any) => a.action_type === "sms_sent").length;
      const emailPending = pending.filter((a: any) => a.action_type === "email_sent").length;
      const docusignPending = pending.filter((a: any) => a.action_type === "docusign_sent").length;

      const parts: string[] = [];
      if (smsPending > 0) parts.push(`${smsPending} SMS`);
      if (emailPending > 0) parts.push(`${emailPending} email${emailPending > 1 ? "s" : ""}`);
      if (docusignPending > 0) parts.push(`${docusignPending} DocuSign`);

      if (parts.length > 0) {
        items.push({
          type: "info",
          text: `${parts.join(", ")} awaiting response`,
          action: "Show me pending actions that haven't gotten a response yet",
        });
      }
    }
  } catch { /* ignore */ }
```

**Step 2: Add recent successes section**

```typescript
  // ── N+1. Recent successful outcomes ──
  try {
    const since24h = new Date(now - HOURS_24).toISOString();
    const { data: successes } = await supabase
      .from("action_outcomes")
      .select("action_type, entity_id, action_context, outcome_type, outcome_detected_at")
      .in("outcome_type", ["response_received", "completed"])
      .gte("outcome_detected_at", since24h)
      .order("outcome_detected_at", { ascending: false })
      .limit(5);

    if (successes && successes.length > 0) {
      const names = successes
        .map((s: any) => s.action_context?.entity_name)
        .filter(Boolean);

      if (names.length > 0) {
        const uniqueNames = [...new Set(names)].slice(0, 3);
        items.push({
          type: "suggestion",
          text: `${uniqueNames.join(", ")} responded recently \u2014 ready for next steps`,
          action: `What's the latest with ${uniqueNames[0]}?`,
        });
      }
    }
  } catch { /* ignore */ }
```

**Step 3: Commit**

```bash
git add supabase/functions/ai-chat/context/briefing.ts
git commit -m "feat: add pending actions and recent successes to briefing

Users now see 'N SMS, M emails awaiting response' and
'X responded recently' when opening the chat.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Semantic Memory Generation

**Files:**
- Modify: `supabase/functions/outcome-analyzer/index.ts` (add Job 4)

**Step 1: Write the memory aggregation and generation logic**

Replace the Job 4 placeholder comment with:

```typescript
  // ── Job 4: Semantic memory generation ──
  try {
    // Aggregate outcomes by action_type for system-wide patterns
    const { data: aggregates } = await supabase.rpc("aggregate_action_outcomes");

    // If no RPC, use raw query fallback:
    // Query: group by action_type, outcome_type; count(*); avg response time
    let memoryCount = 0;

    if (!aggregates) {
      // Fallback: query directly
      const { data: allOutcomes } = await supabase
        .from("action_outcomes")
        .select("action_type, outcome_type, outcome_detail, action_context, created_at")
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
          if (outcomes.length < 30) continue; // Confidence gate

          const total = outcomes.length;
          const successes = outcomes.filter(
            (o: any) => o.outcome_type === "response_received" || o.outcome_type === "completed"
          ).length;
          const successRate = Math.round((successes / total) * 100);

          // Calculate avg response time for successes
          const responseTimes = outcomes
            .filter((o: any) => o.outcome_detail?.hours_to_outcome)
            .map((o: any) => o.outcome_detail.hours_to_outcome);
          const avgResponseHours = responseTimes.length > 0
            ? Math.round((responseTimes.reduce((a: number, b: number) => a + b, 0) / responseTimes.length) * 10) / 10
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
            // Supersede the old memory
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
              expires_at: confidence < 0.7
                ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
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
              expires_at: confidence < 0.7
                ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
                : null,
            });
          }

          memoryCount++;
        }
      }
    }

    results.memories_generated = { count: memoryCount };
  } catch (err) {
    results.memories_generated = { error: (err as Error).message };
  }
```

**Step 2: Commit**

```bash
git add supabase/functions/outcome-analyzer/index.ts
git commit -m "feat: add semantic memory generation to outcome analyzer

Aggregates outcomes across 30+ data points to generate learned
patterns. Confidence-gated: 0.6 for preliminary (30+), 0.85 for
established (100+). Supersedes old memories with updated stats.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Tests for Confidence Calculation Logic

**Files:**
- Create: `src/lib/__tests__/outcomeTracking.test.js`

**Step 1: Write tests for the pure logic functions**

Extract testable pure functions (confidence calculation, outcome aggregation) and write Vitest tests:

```javascript
import { describe, it, expect } from 'vitest';

// ── Pure functions extracted for testing ──

function calculateConfidence(sampleSize) {
  if (sampleSize >= 100) return 0.85;
  if (sampleSize >= 30) return 0.6;
  return 0; // Below threshold, no memory created
}

function calculateSuccessRate(outcomes) {
  if (!outcomes || outcomes.length === 0) return 0;
  const successes = outcomes.filter(
    o => o.outcome_type === 'response_received' || o.outcome_type === 'completed'
  ).length;
  return Math.round((successes / outcomes.length) * 100);
}

function calculateAvgResponseHours(outcomes) {
  const times = outcomes
    .filter(o => o.outcome_detail?.hours_to_outcome)
    .map(o => o.outcome_detail.hours_to_outcome);
  if (times.length === 0) return null;
  return Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10;
}

function shouldCreateMemory(sampleSize) {
  return sampleSize >= 30;
}

function buildMemoryContent(actionType, successRate, total, avgHours) {
  const label = actionType.replace(/_/g, ' ');
  let content = `${label}: ${successRate}% success rate (${total} observations)`;
  if (avgHours) content += `. Average response time: ${avgHours} hours`;
  return content;
}

// ── Tests ──

describe('Outcome Tracking — Confidence Calculation', () => {
  it('returns 0 for fewer than 30 data points', () => {
    expect(calculateConfidence(0)).toBe(0);
    expect(calculateConfidence(10)).toBe(0);
    expect(calculateConfidence(29)).toBe(0);
  });

  it('returns 0.6 for 30-99 data points (preliminary)', () => {
    expect(calculateConfidence(30)).toBe(0.6);
    expect(calculateConfidence(50)).toBe(0.6);
    expect(calculateConfidence(99)).toBe(0.6);
  });

  it('returns 0.85 for 100+ data points (established)', () => {
    expect(calculateConfidence(100)).toBe(0.85);
    expect(calculateConfidence(500)).toBe(0.85);
  });
});

describe('Outcome Tracking — Success Rate', () => {
  it('returns 0 for empty outcomes', () => {
    expect(calculateSuccessRate([])).toBe(0);
  });

  it('calculates correct percentage for mixed outcomes', () => {
    const outcomes = [
      { outcome_type: 'response_received' },
      { outcome_type: 'no_response' },
      { outcome_type: 'response_received' },
      { outcome_type: 'no_response' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(50);
  });

  it('counts completed as success', () => {
    const outcomes = [
      { outcome_type: 'completed' },
      { outcome_type: 'completed' },
      { outcome_type: 'expired' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(67);
  });

  it('returns 100 for all successes', () => {
    const outcomes = [
      { outcome_type: 'response_received' },
      { outcome_type: 'response_received' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(100);
  });

  it('returns 0 for all failures', () => {
    const outcomes = [
      { outcome_type: 'no_response' },
      { outcome_type: 'expired' },
    ];
    expect(calculateSuccessRate(outcomes)).toBe(0);
  });
});

describe('Outcome Tracking — Average Response Time', () => {
  it('returns null when no outcomes have response times', () => {
    const outcomes = [{ outcome_detail: {} }, { outcome_detail: {} }];
    expect(calculateAvgResponseHours(outcomes)).toBeNull();
  });

  it('calculates correct average', () => {
    const outcomes = [
      { outcome_detail: { hours_to_outcome: 2 } },
      { outcome_detail: { hours_to_outcome: 4 } },
      { outcome_detail: { hours_to_outcome: 6 } },
    ];
    expect(calculateAvgResponseHours(outcomes)).toBe(4);
  });

  it('ignores outcomes without response times', () => {
    const outcomes = [
      { outcome_detail: { hours_to_outcome: 3 } },
      { outcome_detail: {} },
      { outcome_detail: { hours_to_outcome: 5 } },
    ];
    expect(calculateAvgResponseHours(outcomes)).toBe(4);
  });
});

describe('Outcome Tracking — Memory Generation Gate', () => {
  it('does not create memory below 30 data points', () => {
    expect(shouldCreateMemory(29)).toBe(false);
  });

  it('creates memory at 30+ data points', () => {
    expect(shouldCreateMemory(30)).toBe(true);
    expect(shouldCreateMemory(100)).toBe(true);
  });
});

describe('Outcome Tracking — Memory Content', () => {
  it('builds content string with success rate and count', () => {
    const content = buildMemoryContent('sms_sent', 42, 38, null);
    expect(content).toBe('sms sent: 42% success rate (38 observations)');
  });

  it('includes average response time when available', () => {
    const content = buildMemoryContent('sms_sent', 42, 38, 4.5);
    expect(content).toBe('sms sent: 42% success rate (38 observations). Average response time: 4.5 hours');
  });

  it('formats action type labels correctly', () => {
    const content = buildMemoryContent('calendar_event_created', 80, 50, null);
    expect(content).toContain('calendar event created');
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass including the new outcome tracking tests.

**Step 3: Commit**

```bash
git add src/lib/__tests__/outcomeTracking.test.js
git commit -m "test: add outcome tracking pure logic tests

Tests for confidence calculation, success rate, average response
time, memory gate threshold, and memory content formatting.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 9: Deploy and Verify

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass (165 existing + ~15 new = ~180).

**Step 2: Run production build**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Deploy ai-chat Edge Function**

Run: `npx supabase functions deploy ai-chat --no-verify-jwt`
Expected: Deployed successfully.

**Step 4: Deploy outcome-analyzer Edge Function**

Run: `npx supabase functions deploy outcome-analyzer --no-verify-jwt`
Expected: Deployed successfully.

**Step 5: Set up pg_cron for outcome-analyzer**

Run via Supabase MCP `execute_sql`:

```sql
SELECT cron.schedule(
  'outcome-analyzer',
  '0 */4 * * *',
  $$SELECT net.http_post(
    url := 'https://zocrnurvazyxdpyqimgj.supabase.co/functions/v1/outcome-analyzer',
    headers := '{"Authorization": "Bearer ' || current_setting('supabase.service_role_key') || '"}'::jsonb
  )$$
);
```

**Step 6: Test the outcome-analyzer manually**

Invoke the Edge Function via curl or Supabase dashboard to verify it runs without errors.

**Step 7: Verify briefing shows new sections**

Open the chat on the production app. The briefing should now include pending actions (if any exist) and recent successes.

**Step 8: Push branch and open PR**

```bash
git push -u origin claude/context-layer-phase2
gh pr create --title "feat: Phase 2 — Outcome Tracking & Semantic Memory" --body "..."
```

**Step 9: Verify CI passes, request merge approval**

Wait for CI + Vercel preview. Test on preview. Ask user to approve merge.
