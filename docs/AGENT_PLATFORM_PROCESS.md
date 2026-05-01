# Agent Platform — Recruiting Process (As-Is and Target State)

**Vision**: `docs/AGENT_PLATFORM_VISION.md`
**Plan**: `docs/AGENT_PLATFORM.md`
**Status**: `docs/AGENT_PLATFORM_STATUS.md`

This doc captures the actual recruiting/onboarding process the recruiting agent will orchestrate. It exists so that any contributor — human or AI — designing Phase 2 work has a single source of truth for *what the funnel actually does today* and *what we're targeting it to become*. Update this file whenever the process changes (new survey questions, new document categories, new failure modes, new time targets, new human gates).

---

## Why this doc exists

The agent platform's foundation phases (0.1 → 0.2 → 0.3 → 0.4 → 0.5 → 1.x) build infrastructure that does not encode any process choice. Phase 2 is when the recruiting agent transforms from copilot into autonomous funnel orchestrator, and that transformation is entirely about **enacting the process described in this doc**. If this doc changes, Phase 2 changes — and that's by design (process is data, not code).

---

## North-star outcome (locked)

**Successful onboarding = orientation completed = win.**

Operationally, "win" is recorded by the orientation conductor (human) checking off an `onboarding_complete` task on the caregiver record. The agent observes the task completion as a verified third-party outcome. The agent never marks its own work done. This satisfies Prime Directive #2.

**Time targets**:
- **Gold**: ≤ 5 days from application to win
- **Good**: ≤ 7 days
- **Acceptable**: ≤ 14 days
- **Special circumstances**: > 14 days with active engagement (e.g., HCA training in flight)

Time targets become the agent's `outcome_definition` JSONB. Editable from the Settings UI without redeploy.

---

## As-is funnel (today, 2026-04-30)

### Pipeline phases in production

Six pipeline phases on `caregivers.phase_override` (today, in order):

| Phase | Active count | Archived | Top archive point? |
|---|---|---|---|
| `(NULL)` — pre-screening | 109 | — | — |
| `intake` | 4 | **32** | ✓ — top archive point |
| `interview` | 9 | **19** | ✓ — second archive point |
| `verification` | 2 | 1 | — |
| `onboarding` | 5 | 2 | — |
| `orientation` | 8 | 2 | — |

`verification` = the "Pending HCA" sub-tab the user described. Caregivers with HCA gaps land here. Three sub-states inside this phase (described below).

The 109 in pre-screening (NULL) reflects the CSV-upload pattern: bulk uploads land caregivers in NULL until automation moves them forward. Phase numbers will need refinement during Phase 2.1 (the funnel state machine work).

### Application volume / cadence

CSV upload from Indeed, daily, variable volume:
- Average: 10–15 caregivers/day
- Spikes: 27–34 on some days (likely Mondays or post-weekend)
- Trickles: 1–6 on slower days
- Sources: `Indeed` (vast majority), `Other`, `Website`, `Walk-In`

The agent must handle both trickles and batches. A 34-caregiver Monday cannot result in 34 simultaneous SMS bursts.

### Stage-by-stage

**Stage 1 — Application → Screening Survey**
- Caregiver added via CSV bulk upload (or Website / Walk-In).
- Automation rule `Initial Screen Survey` (trigger: `new_caregiver`) fires SMS with the survey link.
- Automation rule `Send Screening Survey Reminder` (trigger: `survey_pending`) fires daily SMS reminders.
- Automation rule `Retry Survey SMS` (trigger: `task_completed`) reattempts after task closure.
- Outcome: pass / flag / disqualify.

**Stage 2 — Survey Triage**
- Automatic disqualify: `Are you legally authorized to work in the U.S.? = No` → archive.
- Automatic flag (currently judgment-driven, no automation): any of:
  - `Do you have experience working as a caregiver? = No`
  - `Do you have a valid driver's license? = No`
  - `Are you able to provide valid auto insurance and auto registration? = No`
  - `Do you have any physical limitations that would prevent you from lifting or transferring patients? = Yes`
- Pass: all hard answers OK + zero flags → ready for interview booking.
- Flagged: human reviews, decides clarify / disqualify / proceed-with-caveats.

The full screening survey (live in production):

| Question | Answer type | Used as |
|---|---|---|
| Are you legally authorized to work in the U.S.? | yes/no | **HARD DQ if no** |
| Do you have experience working as a caregiver? | yes/no | Flag if no |
| If yes, how many years? | text | Context only |
| Where did you get your experience? | text | Context only |
| Are you registered as a Home Care Aide? | yes/no | Routes to verification path |
| If yes, what is your PER ID? | text | HCA verification input |
| What days and times are you available to work? | text | Scheduling-agent input later |
| Do you have a valid driver's license? | yes/no | Flag if no |
| Are you able to provide valid auto insurance and auto registration? | yes/no | Flag if no |
| Do you have any physical limitations that would prevent you from lifting or transferring patients? | yes/no | Flag if yes |
| What is your email address? | text | Context only |

**Stage 3 — Interview Booking**
- TODAY: TA specialist manually sends Microsoft 365 Bookings link, manually checks her calendar.
- TARGET: agent sends booking link, agent observes booking events directly.
- Templates already exist (`Virtual Interview`, `VI Follow up Attempts`, `VI Last Attempts`) but are not auto-fired today.

**Stage 4 — Virtual Interview** ← HUMAN GATE
- Conducted by human TA specialist.
- Recording + transcript + interview survey produced.
- These artifacts are inputs the agent reads after the interview to inform the next stage.
- **Top failure mode: ghosting the interview.**

**Stage 5 — HCA Verification (the `verification` phase)**

Three sub-paths based on screening survey + interview outcome:

- **Branch A — Has HCA, PER ID provided + verifiable**: skip verification, advance to onboarding documents.
- **Branch B — Claims HCA, no PER ID or unverifiable**: park in Pending HCA tab; agent guides caregiver to find PER ID (educational SMS, links to the state registry).
- **Branch C — No HCA**: park in Pending HCA tab; agent guides caregiver through CareAcademy training + background check. **Failure mode: stuck in Pending HCA / fails to complete training.**

**Stage 6 — Onboarding Documents (the `onboarding` phase)**

Two parallel document tracks:

- **"Request Documents"** flow (unsigned uploads):
  - Driver's License, TB Test Results, Auto Insurance, 1st Form of ID, 2nd Form of ID
  - Sent via SMS, email, or both. Caregiver uploads to a SharePoint folder.
  - System UI shows uploads; agent should be able to read this state too.
- **"eSignatures"** flow (signed packet):
  - 6 documents requiring signature (W-4 visible in UI; full list to be enumerated).
  - "Send Full Packet" button or "Send Individual" per document.
  - Signature events recorded in `esign_envelopes` / `docusign_envelopes`.
- TARGET: agent sends both packets, chases stuck signatures, answers caregiver questions about documents, escalates to human only when judgment needed.
- TODAY: human reviews submitted documents for accuracy ← HUMAN GATE.
- TARGET (later, after shadow-mode bake): AI assists doc review.
- **Failure mode: documents stuck**.

**Stage 7 — Orientation** ← HUMAN GATE
- TODAY: scheduled per-caregiver as needed (in-person or virtual).
- TARGET (user willing to move): weekly cadence. Group orientation sessions.
- Conducted by human.
- Successful orientation completion = **win** (orientation conductor checks `onboarding_complete` task).

### Top-3 failure modes (ordered)

1. **Ghosting the virtual interview** (most common). Caregiver books, doesn't show. Or never books at all after receiving the link.
2. **Failing to complete onboarding documents** — gets stuck on a specific doc, runs out of patience, or simply lets time elapse.
3. **Failing to complete HCA training (CareAcademy + background check)** — long-tail dropout, especially if it's not been completed within a few weeks.

The agent's value will be measured primarily on its ability to reduce these three.

### Human-required gates (locked)

1. **Virtual interview itself** (Stage 4).
2. **Onboarding document accuracy review** (Stage 6 — for now; AI graduates to assist after bake).
3. **Orientation** (Stage 7).

Everything else is agent-eligible (with autonomy ramped per Phase 1.2's algorithm).

### Existing automations (only 3, all screening)

| Rule | Trigger | Action |
|---|---|---|
| Initial Screen Survey | `new_caregiver` | send_sms |
| Send Screening Survey Reminder | `survey_pending` | send_sms |
| Retry Survey SMS | `task_completed` | send_sms |

**Nothing yet for**: interview chasing, doc chasing, HCA chasing, orientation reminders. This is the agent's white space.

### Existing message templates

| Category | Template |
|---|---|
| onboarding | Onboarding Welcome |
| onboarding | Virtual Interview |
| onboarding | VI Follow up Attempts |
| onboarding | VI Last Attempts |
| general | General Follow-Up |
| scheduling | Shift Check-In |

The agent's first job at each stage transition is "select the right template from the catalog and personalize it" — not "compose a brand new message." Templates are the safe rail. The agent can deviate (with approval) only when no template fits.

---

## Target state — autonomous funnel

The recruiting agent's mandate:

> Drive every caregiver from CSV upload to verified orientation completion within the time targets. Insert humans only at the three locked gates (interview, doc review, orientation). Surface caregivers needing human attention via `ai_suggestions(suggestion_type='alert')`. Never silently archive — bubble up.

### Funnel state machine (Phase 2.1 implementation)

A new table `funnel_stages` represents the funnel as data. Each row:

```
funnel_stages
  id                   uuid
  org_id               uuid (Tremendous Care for now)
  agent_slug           text  -- 'recruiting'
  slug                 text  -- 'screening', 'booking', 'interview', 'verification', 'onboarding_docs', 'orientation'
  display_name         text
  pipeline_phase       text  -- maps to existing caregivers.phase_override
  sequence             int
  human_gate           bool
  enter_action         jsonb -- {action_type, params, template_slug}
  wait_until           jsonb -- {event_type | task_id | external_signal | timeout_days}
  on_success           text  -- next stage slug
  on_timeout           jsonb -- {action: 'remind' | 'escalate' | 'archive', after_days, max_attempts}
  on_failure           text  -- next stage slug or 'archive'
  enabled              bool
  agent_paused         bool  -- temporary kill switch per stage
```

A second table `funnel_transitions` captures conditional branches between stages (e.g., HCA Branch A vs B vs C). Each transition row carries a `condition_json` that the agent evaluates against the caregiver's data.

This makes the funnel **fully editable from the Settings UI**. Add a stage = add a row. Tighten a timeout = edit the row. Disable a stage = flip a flag. The agent re-reads the manifest on each invocation.

### Orchestrator loop

Phase 2.2 introduces the recruiting orchestrator: a cron-driven + event-triggered evaluator that, for each active caregiver:

1. Looks up the caregiver's current pipeline phase + funnel stage.
2. Evaluates "what's the agent supposed to do next?" via `funnel_stages` + `funnel_transitions`.
3. If the answer is "wait," does nothing.
4. If the answer is "act," takes the action subject to autonomy gating.
5. Records the action and any wait condition.
6. Schedules the next evaluation (or relies on event triggers).

The orchestrator is **stateless per invocation** — every decision is recomputed from current state. No "the agent is sleeping waiting for a response." This is the same pattern as `ai-planner`'s daily cron + event-triggered mode, scaled out per-caregiver.

### Calibration via shadow mode + retrospective grading

Phase 1.5 ships the retrospective grading UI. Phase 2.x ships each stage's orchestrator in shadow mode for ≥14 days, with operator daily review (good / bad / harmful). Calibrated agreement rate ≥ 70% + zero harmful before any L1 promotion.

---

## Microsoft 365 Bookings integration spec (for owner to implement)

The user is implementing the Bookings integration. This section is the contract the agent needs.

### Capabilities the integration must expose

**Required for Phase 2.2 (booking → interview stage):**

1. **Generate booking link** — given a caregiver, produce a unique booking URL. The link must be matchable back to the caregiver later (via metadata, query string, or a stored mapping).
2. **Webhook on booking events** — the integration must emit events to a webhook endpoint we control (a new edge function `bookings-webhook`). Required events:
   - `booking_created` — caregiver booked a slot. Payload: caregiver_id (or matchable identifier), event_id, scheduled_start, scheduled_end.
   - `booking_rescheduled` — caregiver moved their slot.
   - `booking_cancelled` — caregiver or staff cancelled.
   - `booking_completed` — meeting happened (Microsoft fires this when the calendar event passes its end time).
3. **Booking metadata accessible** — calendar event id, attendee email/phone (so we can match to caregiver record), recording URL, transcript URL once produced.
4. **No-show detection** — M365 does not natively flag no-shows. Implement an inferred signal: "if `booking_completed` fires with no recording attached AND scheduled_start is in the past by ≥ 30 minutes, treat as candidate no-show; require human confirmation OR mark via a dedicated UI button."
5. **Booking-link expiry** — links should auto-expire (e.g., 7 days) so stale links don't get reused after a stage transition.

**Required for Phase 5+ (orientation booking):**

6. The same capabilities, but for the orientation booking calendar (separate Bookings page or shared calendar with a tag distinguishing interview vs orientation).

### Integration depth recommendation

Use the Graph API integration you already have (`outlook-integration` edge function). The agent calls existing Graph endpoints to:
- Create the booking link
- Register webhook subscriptions on the bookings calendar
- Pull recording / transcript URLs after the meeting

Webhook subscriptions through Graph have lifecycle quirks (24h-72h expiry; auto-renewal needed). Build a renewal cron now or it'll silently expire later.

### What "ready" looks like

When the integration is ready, this query should return rows for every caregiver who has booked an interview:

```sql
SELECT c.id, c.first_name, c.last_name,
       e.event_type, e.payload->>'scheduled_start' AS slot,
       e.payload->>'recording_url' AS recording
FROM public.caregivers c
JOIN public.events e ON e.entity_id = c.id::text
WHERE e.event_type IN ('booking_created', 'booking_completed')
ORDER BY e.created_at DESC;
```

The agent will read this exact query shape via a new tool `get_bookings_history` in Phase 2.2.

---

## Document collection — how the agent will see state

Two parallel tracks (per the UI screenshot user provided):

### Track A — "Request Documents" (unsigned uploads)

Documents:
- Driver's License
- TB Test Results
- Auto Insurance
- 1st Form of Identification
- 2nd Form of Identification

Sent via SMS, email, or both. Caregiver uploads to a SharePoint folder (per-caregiver, via the existing `sharepoint-docs` integration). System UI shows uploaded docs.

The agent needs a tool: `get_caregiver_documents` (already exists in the recruiting agent's allowlist) returns the upload state. Phase 2.5 (onboarding docs orchestrator) reads this to detect "all unsigned docs uploaded."

### Track B — "eSignatures" (6-document signed packet)

Sent via the native e-signature edge function (`esign`). Visible signature: W-4 in screenshot; full enumeration to come from the `esign_templates` table.

Send modes:
- "Send Full Packet" — fires all 6 in one envelope.
- "Send Individual" — per-document.

Status flows through `esign_envelopes` (sent → delivered → viewed → completed → declined/voided).

### "All complete" definition

The agent considers Stage 6 complete when **both**:
- Track A: all required unsigned documents have an upload entry.
- Track B: all 6 e-signature documents are in `completed` status.

Then human review (locked gate). After human approval, advance to Stage 7 (orientation booking).

---

## Open process questions

These don't block infrastructure phases (0.3 / 0.4 / 0.5 / 1.x) but should be answered before Phase 2.1 ships.

1. **Pre-screening NULL pile** — 109 caregivers sit in pre-screening (NULL phase). Are they all "ready for screening survey," or some are "abandoned"? An archive sweep may be appropriate before Phase 2 starts.
2. **Disqualification authority** — agent today has only one auto-DQ (legal-to-work). Should the agent ever auto-DQ on combinations of flags (e.g., no experience + physical limitations + no driver's license)? Lean: never autonomously, always flag for human until calibration data justifies promotion.
3. **Phase rename / addition** — `intake` is overloaded today (means both "post-application pre-survey" and "post-survey ready-for-interview"?). Worth disambiguating into two phases. Discuss before Phase 2.1.
4. **Pre-screening NULL → intake transition** — what currently moves a caregiver from NULL to `intake`? Survey completion? A human action? Need to verify before designing the Stage 1 → Stage 2 transition rule.
5. **Orientation cadence change** — user willing to move from "as-needed" to weekly. Decide before Phase 2.6 design.
6. **Eligibility for re-engagement** — when a caregiver ghosts the interview and stages stop chasing them, can the agent re-engage them 30 days later? Lean: yes, with explicit operator opt-in per caregiver, never automatic.
7. **`Pending HCA` sub-paths** — three branches inside the verification phase. Are these distinguishable in data today, or human-tagged? Need explicit field or convention.
8. **Action-item rules for the funnel** — `action_item_rules` is empty today (no rules seeded for Tremendous Care). The agent will populate / curate these in Phase 2 to surface "what needs human attention" cleanly.

---

## How this doc evolves

- Process changes (new survey question, new doc, new failure mode) update this doc in the same PR that ships the change.
- Time targets, autonomy ceilings, and human gates are owner-only decisions.
- New stages or transitions are proposed by contributors and approved by owner before adding rows to `funnel_stages`.
- This doc is the persistent record of *what the agent enacts*. The agent itself enacts the rows in `funnel_stages` + `funnel_transitions`. The doc is the human-readable contract; the rows are the machine-readable execution. They must stay in sync — a row that doesn't appear here is a process not the team owns yet, and a process here without a row is unenacted.
