# Sequence Enrollment & Response Detection — Design

**Date:** 2026-02-22
**Status:** Approved
**Version:** v1.0

## Problem

Clients enrolled in automated sequences (drip campaigns) continue receiving messages even after they respond. There's no way to manually start/stop sequences from a client profile, and no distinction between sequences that should stop on response (sales drips) vs. those that shouldn't (newsletters).

## Goals

1. Auto-cancel sequences when a client responds via any channel (SMS, email, call)
2. Manual start/stop of sequences from the client profile
3. Re-enrollment support with ability to pick a starting step
4. Per-sequence toggle for "stop on response" behavior
5. Clean enrollment history for audit trail

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cancel vs pause vs cancel+re-enroll | Cancel + re-enroll | Paused steps go stale (timing context lost). Re-enrollment with step picker gives same flexibility without stale-message risk |
| Response detection timing | 30-minute cron cycle | Piggybacks on existing `automation-cron`. Most drip steps are hours/days apart so catches responses in time |
| Response channels | SMS + email + calls | Any inbound communication counts |
| Multiple simultaneous sequences | Yes, with per-sequence toggle | Newsletters shouldn't stop when client responds to a drip |
| Manual-only sequences | Yes | `trigger_phase: null` sequences can only be started manually from client profile |
| Architecture approach | Dedicated enrollments table | Clean queries, proper state tracking, enrollment history |

## Data Model

### New Table: `client_sequence_enrollments`

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint (auto) | Primary key |
| `client_id` | text (FK -> clients) | Which client |
| `sequence_id` | text (FK -> client_sequences) | Which sequence |
| `status` | text | `active`, `cancelled`, `completed` |
| `current_step` | integer | Index of next step to execute (0-based) |
| `started_at` | timestamptz | When enrolled |
| `started_by` | text | User who enrolled (or `system` for auto-trigger) |
| `start_from_step` | integer | Which step enrollment started from |
| `cancelled_at` | timestamptz | When cancelled (null if active) |
| `cancel_reason` | text | `response_detected`, `manual`, `phase_changed` |
| `cancelled_by` | text | User or `system` |
| `completed_at` | timestamptz | When all steps finished |
| `last_step_executed_at` | timestamptz | Most recent step execution timestamp (response detection window) |

**Unique constraint:** `(client_id, sequence_id) WHERE status = 'active'` — prevents duplicate active enrollments, allows re-enrollment after cancellation.

### Modification to `client_sequences`

- Add column: `stop_on_response` (boolean, default `true`)

## Response Detection Logic

Runs inside existing `automation-cron` (every 30 minutes):

1. Query all `active` enrollments where sequence has `stop_on_response = true`
2. For each enrollment, check for inbound communication since `last_step_executed_at`:
   - **SMS:** RingCentral API — inbound messages from client's phone
   - **Email:** Outlook API — emails from client's email address
   - **Calls:** RingCentral call log — inbound calls from client's phone
3. If response found:
   - Update enrollment: `status = 'cancelled'`, `cancel_reason = 'response_detected'`, `cancelled_by = 'system'`
   - Cancel all pending steps in `client_sequence_log`
   - Add auto-note: "Sequence '{name}' auto-cancelled -- client responded via {channel}"

**Safety check:** Before executing any pending step, cron verifies enrollment is still `active`.

## Step Execution Flow (Cron)

1. Query active enrollments
2. For each, check if next step is due (`last_step_executed_at` + step's `delay_hours`)
3. Before executing: verify enrollment still `active` AND run response check if `stop_on_response = true`
4. Execute step (send SMS/email/create task via `execute-automation`)
5. Update `current_step` and `last_step_executed_at`
6. If last step -> mark enrollment `completed`

## Auto-Trigger Enrollment (Upgraded)

Current behavior executes steps directly on phase entry. New behavior:

1. Client enters trigger phase -> `fireClientSequences()` creates enrollment record (`status = 'active'`, `started_by = 'system'`)
2. Cron picks up enrollment and executes steps on schedule
3. Response detection can cancel before every step

**Edge case — already enrolled:** If client re-enters a trigger phase while already active in that sequence, skip auto-enrollment and add a note.

## Client Profile UI — Sequences Tab

### Active Sequences (top)
- Card per active enrollment: sequence name, progress (Step X of Y), started date, started by
- **Stop** button per card (cancels with `cancel_reason = 'manual'`)

### Start a Sequence (action area)
- **"+ Start Sequence"** button -> dropdown of available sequences
- After selection: shows step list preview
- "Start from step..." dropdown (default: step 1)
- Confirm button creates enrollment

### Past Sequences (bottom, collapsible)
- History of completed/cancelled enrollments
- Shows: sequence name, date range, outcome (completed / manual cancel / auto-cancelled with channel)
- **"Re-enroll"** shortcut button pre-selects that sequence

## Sequence Settings Updates

- Add "Stop on client response" toggle to sequence editor (default: `true`)
- Add badge in sequence list view: "Stops on response" / "Continuous"
- No changes to step definitions, merge fields, or trigger phase selector

## What This Does NOT Include

- Real-time response detection (staying with 30-min cron)
- Caregiver sequences (client-only feature)
- New communication channels
- Sequence analytics/reporting (future enhancement)
