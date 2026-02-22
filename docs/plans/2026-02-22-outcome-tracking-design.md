# Phase 2: Outcome Tracking — Design Document

**Date:** 2026-02-22
**Branch:** `claude/context-layer-phase2`
**Builds on:** Phase 1 (context_memory, events, context_snapshots tables + context assembler)

---

## Goal

Make the AI genuinely smarter over time by tracking what happens after every action. When the portal sends an SMS, emails a caregiver, or sends a DocuSign packet, the system watches for the outcome — did they respond? How long did it take? — and learns patterns that improve future recommendations.

**North star:** When a user asks "how should I follow up with this caregiver?", the AI draws on real outcome data — not just generic advice — to recommend the best channel, timing, and approach.

**What this is NOT:** A dashboard or analytics page. Learned knowledge is woven naturally into the AI's chat responses and briefing alerts.

---

## Architecture: Hybrid Real-Time + Scheduled Detection

Two detection paths working together:

1. **Real-time path** — When the event bus logs certain inbound events (SMS received, DocuSign completed, phase changed), immediately check if it correlates to a recent outbound action. Outcome detected in seconds.

2. **Scheduled path** — A cron job runs every 4 hours for things real-time can't catch: Outlook calendar correlation, "no response" timeout detection, and semantic memory generation from aggregated outcomes.

Both paths write to the same `action_outcomes` table. Both use `storeMemory()` for learned patterns.

### Data Sources for Correlation

The portal already has read access to all necessary data:
- **RingCentral** — SMS history and call logs (inbound + outbound)
- **Outlook** — Email threads and calendar events
- **DocuSign** — Envelope status changes
- **Supabase** — Caregiver/client records, phase changes, task completions

No new integrations needed. The system correlates across existing data.

---

## Database Schema

### New table: `action_outcomes`

```sql
CREATE TABLE action_outcomes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type       text NOT NULL,
  -- sms_sent, email_sent, docusign_sent, phase_changed,
  -- calendar_event_created, task_completed
  entity_type       text NOT NULL CHECK (entity_type IN ('caregiver', 'client')),
  entity_id         uuid NOT NULL,
  actor             text NOT NULL DEFAULT 'system',
  -- user email, 'automation', or 'ai_chat'
  action_context    jsonb DEFAULT '{}',
  -- details: message content, phone, template, etc.
  source            text NOT NULL DEFAULT 'ai_chat'
    CHECK (source IN ('ai_chat', 'automation', 'manual')),
  outcome_type      text,
  -- NULL (pending), response_received, no_response,
  -- completed, advanced, declined, expired
  outcome_detail    jsonb,
  -- response text, time_to_respond_hours, new_phase, etc.
  outcome_detected_at timestamptz,
  created_at        timestamptz DEFAULT now(),
  expires_at        timestamptz
  -- stop looking after this time (default: 7 days from creation)
);

-- Query pending actions per entity
CREATE INDEX idx_action_outcomes_pending
  ON action_outcomes (entity_type, entity_id, created_at DESC)
  WHERE outcome_type IS NULL;

-- Aggregate outcomes by action type (for memory generation)
CREATE INDEX idx_action_outcomes_aggregate
  ON action_outcomes (action_type, outcome_type, created_at DESC);

-- Find recent outcomes (for briefing)
CREATE INDEX idx_action_outcomes_recent
  ON action_outcomes (outcome_detected_at DESC)
  WHERE outcome_detected_at IS NOT NULL;
```

### RLS Policy
Same pattern as other tables: all authenticated users get full access.

---

## Real-Time Outcome Detection

### File: `supabase/functions/ai-chat/context/outcomes.ts`

Exports `detectOutcome(event)` — called from the post-conversation background task in `index.ts` and from automation event processing.

### Correlation Rules

| Trigger Event | Match Logic | Outcome |
|--------------|-------------|---------|
| Inbound SMS (sms_received) | `from_phone` matches `action_context.to_phone` on a `sms_sent` action within 7 days | `response_received` with response text + time delta |
| Inbound email | `from_email` matches `action_context.to_email` on an `email_sent` action within 7 days | `response_received` with time delta |
| DocuSign status = completed | `envelope_id` matches `action_context.envelope_id` on a `docusign_sent` action | `completed` with time to completion |
| Phase changed | `entity_id` matches a `phase_changed` action — check if new phase is later in pipeline | `advanced` with old/new phase |
| Task completed | `entity_id` + `task_type` matches related action | `completed` |

### Matching Strategy
- Query `action_outcomes` for the same entity with `outcome_type IS NULL` and `created_at` within the lookback window (7 days default)
- Match most recent action first (LIFO — last action is most likely cause)
- One outcome per action (first match wins, no double-counting)

### Error Handling
- All correlation is fire-and-forget (same pattern as Phase 1 event logging)
- If query fails, action stays pending — cron picks it up later
- Never blocks chat response or automation execution

---

## Scheduled Detection (Cron)

### New Edge Function: `outcome-analyzer`

Runs every 4 hours via pg_cron (same mechanism as `automation-cron`).

### Job 1: Calendar Correlation
- Query Outlook calendar for events in next 14 days
- For each caregiver in Interview or Orientation phase, check if a calendar event contains their name or email
- If match found → create outcome on relevant `phase_changed` or `calendar_event_created` action
- Dedup: skip if outcome already detected

### Job 2: No-Response Detection
- Find `action_outcomes` where `outcome_type IS NULL` and `created_at < now() - interval '48 hours'`
- Mark as `no_response` with `outcome_detail: { hours_waited: N }`
- Critical: the AI needs failure data to learn what doesn't work

### Job 3: Expiry Cleanup
- Actions past `expires_at` with no outcome → mark `expired`
- Default expiry: 7 days for SMS/email, 14 days for DocuSign, 21 days for calendar

### Job 4: Semantic Memory Generation
The core learning engine. Aggregates outcomes into learned patterns.

**Process:**
1. Group `action_outcomes` by `action_type` + relevant conditions (entity phase, source, channel)
2. Calculate: success rate, avg response time, sample size
3. Apply confidence gates:
   - 30+ data points → create memory at confidence 0.6 (preliminary)
   - 100+ data points → promote to confidence 0.85 (established)
   - Stable trend (last 20 outcomes match overall) → boost confidence +0.1
4. Store via `storeMemory()`:
   - `memory_type: 'semantic'`
   - `source: 'outcome_analysis'`
   - `entity_type: 'system'` (system-wide patterns) or `'caregiver'` (per-entity)
   - `tags: ['sms', 'lead_phase', 'response_rate']` (for retrieval)
5. If updating an existing pattern, use `superseded_by` to link old → new memory

**Example generated memories:**
- "SMS to Lead-phase caregivers: 42% respond within 48h (38 observations)"
- "DocuSign packets: avg 3.2 days to completion (15 observations)"
- "Email follow-ups after 3+ days silence: 18% response rate (45 observations)"
- "Caregivers from Indeed respond 2x faster than walk-ins (22 observations)"

**Per-entity memories (when enough data):**
- "Sarah Miller: typically responds to SMS within 4 hours (5 interactions)"
- "Kevin Nash: prefers email over SMS (3 email responses, 0 SMS responses)"

---

## How the AI Uses Learned Knowledge

### In Chat (Automatic — No Code Changes Needed)

The Phase 1 memory layer (`context/layers/memory.ts`) already queries `context_memory` for semantic memories with `confidence >= 0.7`. When the cron generates outcome-based memories, they flow into the AI's context automatically.

**Before Phase 2:**
> "You are TC Assistant. Pipeline: 5 caregivers..."

**After Phase 2 (with outcome data):**
> "You are TC Assistant. Pipeline: 5 caregivers...
>
> LEARNED PATTERNS:
> - SMS to Lead-phase caregivers: 42% respond within 48h
> - Best follow-up window: within 24h (55% vs 18% response rate)
> - DocuSign completion: avg 3.2 days"

The AI naturally incorporates this into recommendations without any prompt engineering changes.

### In Briefing (Small Extension)

Extend `context/briefing.ts` with two new sections:

1. **Pending Actions** — Query `action_outcomes WHERE outcome_type IS NULL AND created_at > now() - interval '48h'`
   - "3 SMS sent yesterday — 1 reply received, 2 still waiting"

2. **Recent Successes** — Query `action_outcomes WHERE outcome_detected_at > now() - interval '24h'`
   - "DocuSign for Sarah Miller completed — ready for next phase"

---

## Action Logging Integration

### From AI Chat (index.ts)
After each side-effect tool execution in the post-conversation background task, also insert into `action_outcomes`:
- `send_sms` → action_type: 'sms_sent', action_context: { to_phone, message }
- `send_email` → action_type: 'email_sent', action_context: { to_email, subject }
- `update_phase` → action_type: 'phase_changed', action_context: { old_phase, new_phase }
- `complete_task` → action_type: 'task_completed', action_context: { task_id, task_name }
- `create_calendar_event` → action_type: 'calendar_event_created', action_context: { event details }
- `send_docusign_envelope` → action_type: 'docusign_sent', action_context: { envelope_id, templates }

### From Automations (execute-automation)
When automation engine executes a side-effect action, also insert into `action_outcomes` with `source: 'automation'`.

### Manual/Integration Detection
When inbound SMS webhook fires or DocuSign webhook fires, also check if a recent manual action (not from portal) could be correlated. This captures outcomes of actions taken outside the portal but visible through integrations.

---

## File Structure

```
supabase/functions/ai-chat/context/
  assembler.ts        (existing — no changes)
  briefing.ts         (extend with pending actions + recent successes)
  events.ts           (existing — no changes)
  outcomes.ts         (NEW — detectOutcome, logAction, correlateEvents)
  layers/
    memory.ts         (existing — no changes, auto-surfaces semantic memories)
    situational.ts    (existing — no changes)
    threads.ts        (existing — no changes)

supabase/functions/outcome-analyzer/
  index.ts            (NEW — cron job entry point)
  correlators/
    calendar.ts       (NEW — Outlook calendar correlation)
    timeout.ts        (NEW — no-response detection)
    memory-gen.ts     (NEW — semantic memory aggregation + generation)

supabase/migrations/
  20260222_action_outcomes.sql  (NEW — table + indexes + RLS)
```

---

## Confidence Gates & Safety

- **30+ data points** required before any semantic memory is created
- **Preliminary memories** (30-99 data points) created at confidence 0.6 — visible to AI but marked as preliminary
- **Established memories** (100+ data points) promoted to confidence 0.85
- **Supersede chain** — updated patterns don't delete old ones; they link via `superseded_by` for full audit trail
- **Per-entity memories** only created after 5+ interactions with that specific entity
- **Expiry** — preliminary memories expire after 90 days if not promoted (prevents stale early patterns from persisting)

---

## What This Enables for Phase 3 (Graduated Autonomy)

Phase 2 outcome data directly feeds Phase 3's autonomy decisions:
- High success rate (>80%) for an action type → candidate for auto-execution
- Low success rate (<30%) → flag for human review
- Stable confidence (0.85+) → earned trust for higher autonomy level

This is the data foundation that makes graduated autonomy possible.
