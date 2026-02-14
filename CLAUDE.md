# Caregiver Portal — Project Notes

## Product Vision
- Build an autonomous AI agent that handles caregiver onboarding end-to-end
- Sell as SaaS to other home care agencies at 10-20% the cost of an employee (~$500-1,000/mo)
- The AI agent is the competitive moat — not the pipeline UI

## Architecture Priorities

### 1. Autonomous AI Agent (Critical Path)
The current AI chatbot is reactive (user asks, it answers with optional confirmation).
The goal is a fully autonomous agent that:
- Monitors the pipeline continuously for state changes and time-based triggers
- Makes decisions about what action to take next (send SMS, email, escalate, advance phase)
- Executes multi-step workflows without human intervention (e.g., 5-day chase sequence)
- Handles inbound responses from caregivers and adjusts behavior accordingly
- Operates within configurable guardrails per organization (auto vs. human-approval thresholds)

Key implementation areas:
- **Event-driven orchestration layer**: Watch for state changes (task completions, time elapsed, inbound messages) and trigger agent decision loops
- **Tool-use architecture**: Expose structured actions (send_sms, send_email, update_task, add_note, advance_phase, schedule_interview) as callable tools for Claude
- **Decision loop with guardrails**: Configurable autonomy levels — some agencies want full auto, others want human approval at key steps
- **Long-running workflow support**: Chase sequences that span days need durable state (not just edge function cold starts)
- **Context assembly**: Agent needs full caregiver record, phase policies, chase scripts, urgency rules, and communication history to make good decisions

### 2. Webhook Receivers (Required for Autonomy)
The agent cannot be truly autonomous if it only sends messages but never hears back.
Need inbound webhook endpoints for:
- **RingCentral**: SMS replies, call status updates, voicemail transcriptions
- **DocuSign**: Envelope completed, envelope declined, envelope voided events
- **SharePoint/OneDrive**: File upload notifications (caregiver submitted a document)
- **CareAcademy** (if API available): Training completion events
- **Guardian/HCA Registry** (if API available): Credential status changes

Each webhook should:
- Validate the incoming signature/token
- Route the event to the correct caregiver record
- Trigger the autonomous agent decision loop with the new context
- Log the event for audit trail

### 3. Testing (Required Before Selling)
No test coverage exists today. Priority areas:
- **Unit tests**: `actionEngine.js` (urgency calculations), `utils.js` (phase progression, green light logic), `automations.js` (trigger matching)
- **Integration tests**: Phase advancement on task completion, automation rule execution, webhook event processing
- **AI agent tests**: Decision quality validation — given a caregiver state, does the agent choose the right action?
- **Compliance tests**: Green light checklist accuracy, HCA expiration warnings, 7-day sprint deadline enforcement
- Framework recommendation: Vitest (already compatible with Vite setup)

### 4. Multi-Tenancy (Required Before Second Customer)
- Add `org_id` to every table
- Update all RLS policies to filter by organization
- Per-org configuration: phases, tasks, urgency rules, compliance requirements
- Per-org integration credentials (encrypted, fetched at runtime)
- Provisioning flow for new organizations

## Tech Stack
- Frontend: React 18 + Vite + React Router 7
- Backend: Supabase (Postgres + Auth + Edge Functions + RLS)
- AI: Claude via Supabase Edge Functions
- Integrations: RingCentral (SMS/calls), Microsoft Graph (SharePoint/Outlook), DocuSign (planned)
- Deployment: Vercel (frontend), Supabase (backend)

## Current State (as of Feb 2026)
- ~7,200 lines of code across ~20 files
- 5-phase pipeline with task tracking, urgency engine, compliance checklists
- AI chatbot exists but is reactive (ask/answer + confirmation pattern)
- Automation engine exists but is basic (fire-and-forget, 2 trigger types)
- No webhook receivers (outbound-only integrations)
- No test coverage
- Single-tenant architecture
- No billing/subscription management

---

# Implementation Guide: Autonomous AI Agent Build-Out

This guide transforms the caregiver portal from a reactive pipeline tool into an autonomous AI-driven onboarding platform. Each step is designed to be executed in order. Steps within a phase can often be done in parallel. Steps across phases generally depend on previous phases being complete.

## How the Current System Works (Context for All Steps)

**Current AI chatbot** (`src/components/AIChatbot.jsx`):
- User types a message in a floating chat panel
- Message is sent to the `ai-chat` Supabase Edge Function with conversation history, optional `caregiverId`, and `currentUser`
- Edge Function calls Claude, returns a text `reply` and optionally a `pendingConfirmation` object
- If `pendingConfirmation` is returned, the UI shows a Confirm/Cancel card
- User clicks Confirm → Edge Function executes the action (add_note, update_task, etc.)
- The AI never acts without a human in the loop. It never initiates. It only responds.

**Current automation engine** (`src/lib/automations.js`):
- Only fires on `new_caregiver` and `days_inactive` trigger types
- Queries `automation_rules` table for matching enabled rules
- Invokes `execute-automation` Edge Function fire-and-forget (never blocks UI)
- Can send SMS (RingCentral) or email (Outlook) via merge templates
- No inbound processing — outbound only
- No chaining — one trigger fires one action, no sequences

**Current action engine** (`src/lib/actionEngine.js`):
- Runs client-side, generates dashboard action items for human recruiters
- Checks all caregivers against hardcoded urgency rules (24-hour interview standard, 7-day onboarding sprint, HCA expiration, etc.)
- Returns sorted array of action items with urgency levels (critical/warning/info)
- These are display-only — no actions are executed automatically

**Database** (`supabase/schema.sql`):
- `caregivers` table: main record with JSONB fields for `tasks`, `notes`, `phase_timestamps`
- `app_data` table: key-value store for settings (phase_tasks, board_columns, orientation)
- `automation_rules` table: trigger-based rules with message templates
- `automation_log` table: execution history
- `app_settings` table: integration config (outlook_mailbox, ringcentral_from_number, etc.)
- `user_roles` table: admin/member access control
- `caregiver_documents` table: SharePoint file metadata
- All tables use RLS with authenticated-only access, no org isolation

**Key files to understand before making changes:**
- `src/lib/constants.js` — PHASES (5 phases), DEFAULT_PHASE_TASKS (task definitions per phase), CHASE_SCRIPTS (multi-day follow-up templates), GREEN_LIGHT_ITEMS
- `src/lib/utils.js` — Phase calculation logic (`getCurrentPhase`, `getPhaseProgress`, `isGreenLight`, `getDaysInPhase`)
- `src/lib/storage.js` — Supabase/localStorage abstraction, camelCase↔snake_case mapping (`dbToCaregiver`, `caregiverToDb`)
- `src/App.jsx` — Root component, state management, routing, calls `fireEventTriggers` on new caregiver creation
- `src/components/CaregiverDetail.jsx` — Full caregiver profile, tasks, documents, notes, communications

---

## PHASE 1: Foundation — Database Tables & Test Framework

These are prerequisites that everything else builds on. Do these first.

### Step 1.1: Create the `agent_events` Table

**What:** A table to log every event the agent processes — inbound webhooks, time-based triggers, task completions, agent decisions.

**Why:** The autonomous agent needs an audit trail. Every action it takes must be traceable. This also becomes the event stream that drives the agent loop.

**Where:** Add to `supabase/schema.sql` and run in Supabase SQL Editor.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS agent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id TEXT REFERENCES caregivers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  -- event_type values: 'sms_inbound', 'sms_outbound', 'email_inbound', 'email_outbound',
  -- 'docusign_completed', 'docusign_declined', 'task_completed', 'phase_advanced',
  -- 'agent_decision', 'agent_action', 'scheduled_action_fired', 'human_escalation',
  -- 'webhook_received', 'caregiver_response'
  event_source TEXT NOT NULL,
  -- event_source values: 'ringcentral_webhook', 'docusign_webhook', 'agent_loop',
  -- 'cron_trigger', 'user_action', 'automation_rule'
  payload JSONB DEFAULT '{}'::jsonb,
  -- Flexible payload: message content, decision reasoning, action parameters, etc.
  agent_reasoning TEXT,
  -- When event_type is 'agent_decision', store Claude's reasoning here
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_events_caregiver ON agent_events(caregiver_id, created_at DESC);
CREATE INDEX idx_agent_events_type ON agent_events(event_type, created_at DESC);

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated full access" ON agent_events
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
```

### Step 1.2: Create the `scheduled_actions` Table

**What:** A table for durable, time-delayed actions. When the agent decides "send follow-up SMS in 24 hours," it writes a row here. A cron job picks it up later.

**Why:** Chase sequences span days. Edge Functions can't stay running for days. This table is the agent's "calendar" — it schedules future work and the cron job executes it on time.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS scheduled_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id TEXT REFERENCES caregivers(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  -- action_type values: 'send_sms', 'send_email', 'agent_review', 'escalate_human',
  -- 'advance_phase', 'archive_caregiver'
  action_payload JSONB NOT NULL,
  -- Contains everything needed to execute: message text, recipient, subject, etc.
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- status values: 'pending', 'executed', 'cancelled', 'failed'
  cancel_on_event TEXT,
  -- Optional: auto-cancel if this event type occurs before execution
  -- e.g., 'sms_inbound' — if caregiver replies, cancel the follow-up
  created_by TEXT DEFAULT 'agent',
  executed_at TIMESTAMPTZ,
  error_detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scheduled_pending ON scheduled_actions(status, scheduled_for)
  WHERE status = 'pending';
CREATE INDEX idx_scheduled_caregiver ON scheduled_actions(caregiver_id, status);

ALTER TABLE scheduled_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated full access" ON scheduled_actions
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
```

### Step 1.3: Create the `agent_config` Table

**What:** Per-organization (and eventually per-org) configuration for the agent's autonomy levels and behavior.

**Why:** Different agencies want different levels of automation. Some want full auto-send on chase messages, others want human approval. This table stores those preferences.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS agent_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated full access" ON agent_config
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
```

**Default configuration to insert:**
```sql
INSERT INTO agent_config (key, value) VALUES
('autonomy_levels', '{
  "send_chase_sms": "auto",
  "send_chase_email": "auto",
  "advance_phase": "auto",
  "archive_caregiver": "human_approval",
  "send_offer_letter": "human_approval",
  "retract_offer": "human_approval",
  "schedule_interview": "auto",
  "escalate_to_manager": "auto"
}'::jsonb),
('agent_enabled', 'true'::jsonb),
('chase_hours', '{"start": 9, "end": 18, "timezone": "America/Los_Angeles"}'::jsonb),
('max_chase_attempts', '5'::jsonb);
```

The `autonomy_levels` values mean:
- `"auto"`: Agent executes without human approval
- `"human_approval"`: Agent creates a pending action, human must approve in the UI
- `"notify_only"`: Agent notifies a human but takes no action

### Step 1.4: Set Up Vitest

**What:** Install and configure the test framework.

**Why:** No tests exist. The compliance logic, urgency engine, and phase calculations are the kind of code where bugs have real consequences.

**How:**
1. Run: `npm install -D vitest`
2. Add to `vite.config.js`:
```js
export default defineConfig({
  // ...existing config
  test: {
    environment: 'node',
    globals: true,
  },
});
```
3. Add to `package.json` scripts: `"test": "vitest run", "test:watch": "vitest"`

### Step 1.5: Write Unit Tests for Existing Logic

**What:** Test the core business logic that the agent will depend on.

**Files to create:**
- `src/lib/__tests__/utils.test.js` — Test `getCurrentPhase`, `getPhaseProgress`, `getOverallProgress`, `isGreenLight`, `getDaysInPhase`, `getDaysSinceApplication`, `isTaskDone`
- `src/lib/__tests__/actionEngine.test.js` — Test `generateActionItems` with mock caregivers at each phase, verify urgency levels and thresholds (24-hour interview, 7-day sprint, HCA expiration at 0/30/90 days)

**Test approach:** Create mock caregiver objects with specific task states and timestamps, then assert the functions return expected results. Test edge cases: all tasks complete, no tasks complete, expired HCA, caregiver at day 7 exactly, phase override behavior.

**Important:** The `getPhaseTasks()` function in `utils.js` reads from module-level state in `storage.js`. Tests need to call `setPhaseTasks(DEFAULT_PHASE_TASKS)` in a `beforeEach` to ensure consistent state.

---

## PHASE 2: Agent Tool Definitions & Edge Function

This phase builds the agent's brain — the Edge Function that receives context about a caregiver, decides what to do, and executes actions via structured tools.

### Step 2.1: Create the Agent Edge Function

**What:** A new Supabase Edge Function `agent-loop` that runs the autonomous decision loop for one or more caregivers.

**Where:** `supabase/functions/agent-loop/index.ts`

**What it does:**
1. Receives a list of caregiver IDs to evaluate (or `"all"` for the cron sweep)
2. For each caregiver, assembles full context (see Step 2.2)
3. Calls Claude with tool definitions (see Step 2.3) and a system prompt encoding the onboarding policies
4. Executes whatever tools Claude calls
5. Logs every decision and action to `agent_events`
6. If Claude decides to schedule a future action, writes to `scheduled_actions`

**Request payload:**
```typescript
interface AgentLoopRequest {
  caregiver_ids: string[] | 'all';
  trigger: 'cron' | 'webhook' | 'manual';
  trigger_event?: {
    type: string;       // e.g., 'sms_inbound'
    payload: any;       // e.g., { from: '+1234567890', body: 'I sent my I-9' }
  };
}
```

**The Edge Function must:**
- Authenticate via Supabase service role key (for cron triggers) or user JWT (for manual triggers)
- Read `agent_config` to check if agent is enabled and what autonomy levels apply
- Respect `chase_hours` — don't send messages outside business hours (schedule for next morning instead)
- Set a per-caregiver lock (using Postgres advisory locks or a simple `processing` flag) to prevent duplicate processing if cron overlaps

### Step 2.2: Context Assembly

**What:** Build the complete context object the agent needs to make decisions.

**For each caregiver, assemble:**
```typescript
interface AgentContext {
  caregiver: {
    id: string;
    name: string;
    phone: string;
    email: string;
    current_phase: string;
    days_in_phase: number;
    days_since_application: number;
    tasks: Record<string, { completed: boolean; completedAt?: number; completedBy?: string }>;
    phase_progress: Record<string, { done: number; total: number; pct: number }>;
    overall_progress: number;
    green_light: boolean;
    notes: Array<{ text: string; timestamp: number; author: string; type?: string }>;
    phase_timestamps: Record<string, number>;
    hca_expiration: string | null;
    archived: boolean;
  };
  recent_communications: Array<{
    direction: 'inbound' | 'outbound';
    channel: 'sms' | 'email' | 'call';
    content: string;
    timestamp: string;
  }>;
  pending_scheduled_actions: Array<{
    id: string;
    action_type: string;
    scheduled_for: string;
  }>;
  recent_agent_events: Array<{
    event_type: string;
    payload: any;
    created_at: string;
  }>;
  policies: {
    chase_scripts: typeof CHASE_SCRIPTS;
    phase_tasks: typeof DEFAULT_PHASE_TASKS;
    green_light_items: typeof GREEN_LIGHT_ITEMS;
    autonomy_levels: Record<string, string>;
    chase_hours: { start: number; end: number; timezone: string };
  };
  trigger_event?: {
    type: string;
    payload: any;
  };
}
```

**How to get `recent_communications`:**
- Query the `agent_events` table for this caregiver where `event_type` is `sms_inbound`, `sms_outbound`, `email_inbound`, `email_outbound` — last 30 days
- Also call the existing `get-communications` Edge Function to pull RingCentral history if available

**Key point:** The context assembly is the most important part of the agent. Claude's decision quality is directly proportional to the quality and completeness of the context it receives. Don't skimp here.

### Step 2.3: Define Agent Tools

**What:** Structured tool definitions that Claude can call during the decision loop. Use the Claude API tool_use format.

**Tools to define:**

```typescript
const AGENT_TOOLS = [
  {
    name: "send_sms",
    description: "Send an SMS text message to the caregiver via RingCentral. Use for chase sequences, reminders, and quick communications.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string" },
        message: { type: "string", description: "The SMS body text. Keep under 160 chars when possible." }
      },
      required: ["caregiver_id", "message"]
    }
  },
  {
    name: "send_email",
    description: "Send an email to the caregiver via Outlook/Microsoft Graph. Use for formal communications, document requests, and detailed instructions.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Email body in plain text." }
      },
      required: ["caregiver_id", "subject", "body"]
    }
  },
  {
    name: "update_task",
    description: "Mark a task as completed or uncompleted for a caregiver.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string" },
        task_id: { type: "string", description: "Task ID from the phase task definitions (e.g., 'offer_signed', 'i9_form')." },
        completed: { type: "boolean" }
      },
      required: ["caregiver_id", "task_id", "completed"]
    }
  },
  {
    name: "add_note",
    description: "Add a note to the caregiver's record. Use to log agent reasoning, actions taken, or observations.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string" },
        text: { type: "string" },
        type: { type: "string", enum: ["note", "call", "text", "email", "system"], description: "The note type. Use 'system' for agent-generated notes." }
      },
      required: ["caregiver_id", "text"]
    }
  },
  {
    name: "schedule_followup",
    description: "Schedule a future action. Use for chase sequences where the next step should happen in N hours/days. The action will auto-cancel if the caregiver responds before the scheduled time.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string" },
        action_type: { type: "string", enum: ["send_sms", "send_email", "agent_review", "escalate_human"] },
        action_payload: { type: "object", description: "The payload to pass when the action fires (e.g., { message: '...' } for SMS)." },
        delay_hours: { type: "number", description: "Hours from now to execute the action." },
        cancel_on_reply: { type: "boolean", description: "If true, cancel this action if the caregiver sends any inbound message before execution." }
      },
      required: ["caregiver_id", "action_type", "action_payload", "delay_hours"]
    }
  },
  {
    name: "escalate_to_human",
    description: "Flag a caregiver for human review. Use when the situation requires judgment beyond the agent's confidence level (e.g., caregiver complaint, ambiguous response, compliance edge case).",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string" },
        reason: { type: "string", description: "Why human review is needed." },
        urgency: { type: "string", enum: ["critical", "warning", "info"] }
      },
      required: ["caregiver_id", "reason"]
    }
  },
  {
    name: "no_action_needed",
    description: "Explicitly indicate that no action is needed for this caregiver right now. Use when the caregiver is progressing normally and no intervention is required.",
    input_schema: {
      type: "object",
      properties: {
        caregiver_id: { type: "string" },
        reason: { type: "string", description: "Brief explanation of why no action is needed." }
      },
      required: ["caregiver_id", "reason"]
    }
  }
];
```

### Step 2.4: Write the Agent System Prompt

**What:** The system prompt that tells Claude how to behave as an onboarding agent. This is the core "intelligence" of the product.

**Where:** Store as a constant in the Edge Function, or in the `agent_config` table for future customization.

**The system prompt should encode:**
1. The agent's role: "You are an autonomous caregiver onboarding agent for a home care agency."
2. The 5-phase pipeline and what each phase means
3. Chase sequence policies: intake chase (Day 1/2/3/5), onboarding 7-day sprint (Day 1/2/3/4/7 deadline)
4. Urgency rules: 24-hour interview standard, 3-day offer letter policy, HCA expiration thresholds
5. Green light requirements: what must be true before orientation
6. Communication tone: professional, warm, concise. Example messages from the CHASE_SCRIPTS in constants.js
7. Decision-making principles:
   - Always check if there are already pending scheduled actions before creating duplicates
   - Don't send messages outside business hours — use schedule_followup instead
   - If a caregiver hasn't responded after the full chase sequence, escalate to human
   - When a caregiver responds to a chase message, cancel pending follow-ups
   - Log reasoning for every decision via add_note with type 'system'
8. Autonomy boundaries: check the `autonomy_levels` config. If an action requires `human_approval`, use `escalate_to_human` instead of executing directly.

**Critical:** The system prompt must tell Claude to examine the `trigger_event` first (if present). If this is a webhook-triggered run (e.g., caregiver replied to SMS), the agent should process that specific event. If this is a cron-triggered run, the agent should evaluate the caregiver's current state and decide proactively.

### Step 2.5: Implement Tool Execution

**What:** The backend logic that actually executes each tool when Claude calls it.

**For each tool, implement:**

- **`send_sms`**: Call the existing `execute-automation` Edge Function (or directly call RingCentral API). Log to `agent_events` with `event_type: 'sms_outbound'`.
- **`send_email`**: Call Microsoft Graph API via the existing Outlook integration pattern. Log to `agent_events` with `event_type: 'email_outbound'`.
- **`update_task`**: Read the caregiver from the `caregivers` table, update the `tasks` JSONB field, write back. Log to `agent_events` with `event_type: 'task_completed'`.
- **`add_note`**: Read the caregiver, append to the `notes` JSONB array, write back. Include `author: 'AI Agent'`.
- **`schedule_followup`**: Insert a row into `scheduled_actions` with `scheduled_for = NOW() + delay_hours`. If `cancel_on_reply` is true, set `cancel_on_event = 'sms_inbound'`.
- **`escalate_to_human`**: Insert a row into `agent_events` with `event_type: 'human_escalation'`. Also add a note to the caregiver record so it's visible in the UI.
- **`no_action_needed`**: Log to `agent_events` with `event_type: 'agent_decision'` and `agent_reasoning` = the reason.

---

## PHASE 3: Webhook Receivers

The agent's "ears." Without these, the agent sends messages but never knows what happens next.

### Step 3.1: RingCentral SMS Webhook

**What:** A Supabase Edge Function that receives inbound SMS events from RingCentral.

**Where:** `supabase/functions/webhook-ringcentral/index.ts`

**How RingCentral webhooks work:**
1. You register a webhook subscription via the RingCentral API pointing to your Edge Function URL
2. RingCentral sends a verification request first (respond with the `validation-token` header)
3. On each inbound SMS, RingCentral POSTs an event with `body.body.type === 'SMS'`, containing `from`, `to`, `subject` (message body), and `direction`

**What the Edge Function does:**
1. Validate the webhook (RingCentral verification token handshake)
2. Extract the sender phone number and message body
3. Query `caregivers` table to find the caregiver by phone number: `WHERE phone = normalized_phone`
4. If found:
   - Log to `agent_events` with `event_type: 'sms_inbound'`
   - Cancel any pending `scheduled_actions` for this caregiver where `cancel_on_event = 'sms_inbound'`
   - Invoke the `agent-loop` Edge Function with `trigger: 'webhook'` and the inbound message as `trigger_event`
5. If not found: log the event but don't trigger the agent (unknown sender)

**Phone number normalization:** Strip all non-digits, handle +1 prefix. Both the webhook phone and stored phone must be compared in the same format.

### Step 3.2: DocuSign Webhook (Connect)

**What:** A Supabase Edge Function that receives envelope status changes from DocuSign.

**Where:** `supabase/functions/webhook-docusign/index.ts`

**How DocuSign Connect works:**
1. Configure a Connect webhook in DocuSign admin pointing to your Edge Function URL
2. DocuSign sends XML or JSON payloads when envelope status changes
3. Key events: `envelope-completed` (signed), `envelope-declined`, `envelope-voided`

**What the Edge Function does:**
1. Validate the HMAC signature using your DocuSign Connect secret
2. Parse the envelope event — extract recipient email, envelope status, envelope ID
3. Query `caregivers` table to find the caregiver by email
4. Based on status:
   - **`completed`**: Log event, mark `offer_signed` task as completed, trigger agent loop
   - **`declined`**: Log event, trigger agent loop (agent will likely escalate to human)
   - **`voided`**: Log event, add note to caregiver record
5. Trigger `agent-loop` with `trigger: 'webhook'` and the DocuSign event as `trigger_event`

### Step 3.3: Webhook Event Processing Pattern

**What:** A shared utility pattern that all webhook Edge Functions use.

**The pattern:**
```typescript
async function processWebhookEvent(
  supabaseClient: SupabaseClient,
  caregiverId: string,
  eventType: string,
  eventSource: string,
  payload: any
) {
  // 1. Log the event
  await supabaseClient.from('agent_events').insert({
    caregiver_id: caregiverId,
    event_type: eventType,
    event_source: eventSource,
    payload: payload,
  });

  // 2. Cancel any scheduled actions that should be cancelled by this event
  await supabaseClient.from('scheduled_actions')
    .update({ status: 'cancelled' })
    .eq('caregiver_id', caregiverId)
    .eq('status', 'pending')
    .eq('cancel_on_event', eventType);

  // 3. Trigger the agent loop
  await supabaseClient.functions.invoke('agent-loop', {
    body: {
      caregiver_ids: [caregiverId],
      trigger: 'webhook',
      trigger_event: { type: eventType, payload },
    },
  });
}
```

---

## PHASE 4: Cron-Based Agent Loop (The Heartbeat)

This makes the agent proactive rather than just reactive to webhooks.

### Step 4.1: Set Up pg_cron

**What:** Use Supabase's built-in `pg_cron` extension to run the agent on a schedule.

**Why:** The agent needs to check for time-based triggers: "has it been 24 hours since we sent the offer letter?" "is this caregiver at day 5 of the 7-day sprint?" These checks need to happen on a schedule, not just when events come in.

**SQL to run in Supabase SQL Editor:**
```sql
-- Enable pg_cron (may already be enabled in your Supabase project)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Run the agent sweep every 15 minutes during business hours (PST)
-- This calls a database function that invokes the agent-loop Edge Function
SELECT cron.schedule(
  'agent-sweep',
  '*/15 9-18 * * 1-5',  -- Every 15 min, 9am-6pm, Mon-Fri
  $$SELECT net.http_post(
    url := 'YOUR_SUPABASE_URL/functions/v1/agent-loop',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY',
      'Content-Type', 'application/json'
    ),
    body := '{"caregiver_ids": "all", "trigger": "cron"}'::jsonb
  );$$
);
```

**Note:** Replace `YOUR_SUPABASE_URL` and `YOUR_SERVICE_ROLE_KEY` with actual values. The `pg_net` extension (already available in Supabase) handles the HTTP call.

### Step 4.2: Execute Pending Scheduled Actions

**What:** A companion cron job (or part of the agent-loop) that executes scheduled actions whose time has come.

**SQL or Edge Function logic:**
```sql
-- Run every 5 minutes to execute due scheduled actions
SELECT cron.schedule(
  'execute-scheduled-actions',
  '*/5 * * * *',
  $$SELECT net.http_post(
    url := 'YOUR_SUPABASE_URL/functions/v1/execute-scheduled',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );$$
);
```

**The `execute-scheduled` Edge Function:**
1. Query `scheduled_actions WHERE status = 'pending' AND scheduled_for <= NOW()`
2. For each action:
   - Mark as `status = 'executing'` (prevent double-execution)
   - Execute the action (send_sms, send_email, etc.)
   - On success: mark `status = 'executed'`, set `executed_at`
   - On failure: mark `status = 'failed'`, set `error_detail`
   - Log to `agent_events`

---

## PHASE 5: Frontend — Agent Activity Feed & Controls

The portal UI needs to show what the agent is doing and let humans intervene.

### Step 5.1: Agent Activity Feed Component

**What:** A new component or section in `CaregiverDetail.jsx` that shows the agent's recent actions and decisions for a specific caregiver.

**Data source:** Query `agent_events` for the caregiver, ordered by `created_at DESC`, limit 50.

**Display:** Timeline-style feed showing:
- SMS sent/received (with message content)
- Tasks auto-completed by agent
- Agent decisions with reasoning
- Human escalation requests (with approve/dismiss buttons)
- Scheduled future actions (with cancel button)

### Step 5.2: Pending Approvals UI

**What:** When the agent needs human approval (based on `autonomy_levels`), show pending actions in the dashboard.

**Where:** Either a new section in the Dashboard or a notification badge in the sidebar.

**Data source:** Query `agent_events` where `event_type = 'human_escalation'` and no corresponding approval/dismissal event exists.

**Each pending approval shows:**
- Caregiver name and current phase
- What the agent wants to do
- Why it's asking (agent_reasoning)
- Approve / Dismiss buttons
- Clicking Approve triggers the agent-loop with a special `trigger_event` indicating the action was approved

### Step 5.3: Agent Configuration UI

**What:** An admin settings panel to configure the agent's behavior.

**Where:** New section in `AdminSettings.jsx`.

**Controls:**
- Toggle: Agent enabled/disabled
- Per-action autonomy level dropdowns (auto / human_approval / notify_only)
- Chase hours: start time, end time, timezone
- Max chase attempts before auto-escalation

**Data source:** Read/write the `agent_config` table.

### Step 5.4: Update the Existing AI Chatbot

**What:** The floating chatbot in `AIChatbot.jsx` should be enhanced to show agent activity, not just respond to user queries.

**Changes:**
- Add a "Recent Agent Activity" section visible when the chat opens (before any user message)
- When on a caregiver detail page, show what the agent last did for that caregiver
- Let users ask the chatbot about agent decisions: "Why did you send that message to Maria?"
- The chatbot should have access to `agent_events` for the current caregiver in its context

---

## PHASE 6: Testing the Agent

### Step 6.1: Agent Decision Quality Tests

**What:** Tests that validate the agent makes the right decision given a specific caregiver state.

**Where:** `src/lib/__tests__/agentDecisions.test.js` (or a dedicated test directory)

**Approach:** Don't call Claude in tests. Instead, test the context assembly and tool execution layers independently:

1. **Context assembly tests:** Given a caregiver record, does the context builder produce the correct structure? Does it calculate days_in_phase correctly? Does it include recent communications?

2. **Tool execution tests:** Given a tool call `send_sms({ caregiver_id: '123', message: 'Hi' })`, does it correctly call RingCentral, log to agent_events, and return success?

3. **Scheduled action tests:** Given a scheduled action whose time has come, does the executor fire it? If a cancel event arrives first, does it cancel?

4. **Webhook processing tests:** Given an inbound RingCentral webhook payload, does it correctly identify the caregiver, cancel pending actions, and trigger the agent loop?

### Step 6.2: Integration Tests

**What:** End-to-end tests of key workflows.

**Scenarios to test:**
- New caregiver added → agent sends Day 1 chase SMS → caregiver replies → agent cancels Day 2 follow-up and processes reply
- Offer letter sent → 3 days pass → agent sends "unsigned" chase → DocuSign webhook fires "completed" → agent marks task done and advances phase
- Caregiver at Day 7 of onboarding sprint → agent escalates to human → human approves retract → agent archives caregiver

---

## Execution Order Summary

1. **Phase 1** (Foundation): Database tables + Vitest setup + unit tests — Do first, everything depends on this
2. **Phase 2** (Agent Brain): Edge Function + tools + system prompt — The core product
3. **Phase 3** (Webhooks): RingCentral + DocuSign receivers — Enables the feedback loop
4. **Phase 4** (Cron): Scheduled execution — Makes the agent proactive
5. **Phase 5** (Frontend): Activity feed + approvals + config UI — Makes it manageable
6. **Phase 6** (Testing): Agent quality tests — Makes it sellable

Phases 2 and 3 can be worked on in parallel. Phase 4 depends on Phase 2. Phase 5 depends on Phases 1-3. Phase 6 should be ongoing throughout.
