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
