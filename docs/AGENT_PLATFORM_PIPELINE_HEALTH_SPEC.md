# Agent Platform — Pipeline Health UI spec

**Phase**: 1.5 follow-up → "Pipeline Health" UI surface (supersedes the current AI Priorities feed)
**Status**: Spec only. No implementation in this PR.
**Implementation gate**: Loop closure PR #347 verified producing organic `phase='executed'` audit rows in production (Query A in `agent_actions` per the PR #347 smoke checklist).
**Bake gate before Phase 1.6 starts**: None. The Pipeline Health UI work and Phase 1.6.1 (`call_taxonomy` + `context_memory.related_entity_id` additive schema) are independent and can run sequentially.

This document is the implementation contract for the Pipeline Health UI work. Read it alongside `docs/AGENT_PLATFORM_STATUS.md` ("Long-term UI direction is pattern C+D") and `docs/AGENT_PLATFORM.md` ("Phase 2 gate" — Phase 2 begins with this UI direction baked in). Strategic framing is not restated here.

The doc closes with §8: open decisions the owner has not yet locked. Implementation does not begin until those are closed.

---

## 1. Goals & non-goals

### Goals

1. A new admin route `/pipeline-health` becomes the daily-driver surface for operators running the recruiting funnel. It replaces the existing AI Priorities feed as the "what should I look at first this morning" view.
2. The surface answers one question well: **"where is my pipeline stuck, and who needs me?"** It does not answer "what does the AI want me to do" — that's a deliberate reframe.
3. AI is surfaced as a tertiary signal (small inline badge per caregiver), not as the primary attention-grabber. Operators take action through the regular per-caregiver UI surfaces; PR #347's loop closure converts those into positive autonomy signal automatically.
4. The dead-code `NotificationCenter` component is removed in the same PR.
5. The `AIPrioritiesPanel` sidebar widget is removed from the existing Dashboard in the same PR — the new route is the destination.
6. No new tables, no schema changes. All data is pulled from existing rows (`caregivers.phaseTimestamps`, `ai_suggestions`, `agent_actions`, `events`).

### Non-goals

- **No write actions on `/pipeline-health` in V1.** No approve/reject buttons. No edit-suggestion modal. Operators act through the per-caregiver page (which PR #347 already wired). The Pipeline Health surface is read-only.
- **No `/agent-activity` digest view in this PR.** Pattern D (daily-digest of what the AI did) ships as a follow-up PR once Phase 2's recruiting orchestrator starts producing autonomous actions worth digesting. Until then, the audit data is too sparse to make a digest valuable — we'd be designing a surface in the dark.
- **No client pipeline in V1.** The recruiting funnel is the wedge. Clients have a separate pipeline (intake) that gets its own Pipeline Health surface in Phase 3 if data signals divergence.
- **No funnel-chart visualization at the top.** Decided 2026-05-15: a chart that nobody acts on is decoration. The phase-grouped table is the only top-level component.
- **No weekly-summary metrics tiles at the top** (e.g. "5 stalled this week"). Same rationale — until we have weeks of clean data, the tiles are noise. Revisit once Phase 2's orchestrator has been running long enough that weekly deltas tell a story.
- **No `agent_actions` chain verification surface.** That's an admin tooling concern handled by the daily `agent-actions-verify` cron + the per-agent metrics dashboard.

---

## 2. Surface design — `/pipeline-health`

### Route placement

Sidebar nav structure changes:

| Sidebar section | V1 route | After this PR |
|---|---|---|
| Caregivers → Dashboard | `/` | Unchanged route; AIPrioritiesPanel widget removed from its content. |
| Caregivers → Pipeline Health | (new) `/pipeline-health` | New default daily-driver surface. |
| Caregivers → Board, Roster, ... | unchanged | unchanged |
| Admin → Agent Metrics, Suggestion Grading | unchanged | unchanged |

`/pipeline-health` is admin-only via the existing `<AdminOnly>` route guard, mirroring `/agent-metrics` and `/agent-grading`. Tremendous Care operators are admins, so this gates correctly today; the Phase D SaaS rollout will revisit when non-admin user roles are introduced.

### Top of the surface

**One section per active pipeline phase.** Section header: phase name + caregiver count in that phase + median days-in-phase. Beneath each header: a sortable table of caregivers currently in that phase.

Phase order follows `lib/constants.PHASES` (Application → Pre-Screening → Onboarding → Documents → Background Check → Orientation → ...). Terminal phases (Active Roster, Disqualified, Archived) are not shown — they're not "in the pipeline."

Empty phases render the section header with `(0 caregivers)` and no table. Operators see at a glance which phases are bare.

### Per-caregiver row

Columns, left to right:

1. **Caregiver name** — links to `/caregiver/<id>`.
2. **Days in this phase** — `now() - caregiver.phaseTimestamps[currentPhase]`, rounded to whole days. Rows where this exceeds **5 days** are highlighted (light amber background). Rows exceeding **14 days** get a stronger highlight (red text on the days column). The 5/14 thresholds are locked here; they become editable per-org in Phase D.
3. **Days since any activity** — `now() - max(caregiver.created_at, latest_note_timestamp, latest_event_for_this_entity)`. This distinguishes "stuck in phase but recently touched" (waiting on response, fine) from "stuck and forgotten" (needs operator action).
4. **AI inline cue** — small badge if `ai_suggestions` has a pending row for this caregiver. Badge shows the action type and is clickable to expand a tooltip with the AI's reasoning (the `detail` field on the suggestion). No action buttons in the tooltip — operators act through the regular UI. The badge is small and grey-toned by design; it should not visually dominate the row.
5. **Last operator action** — text like "Note added 2d ago by Jessica" or "SMS sent 4h ago by Kevin." Pulled from `events` table, scoped to this `entity_id`. If no event in the last 30 days, shows "—".

Default sort within each phase section: **days in this phase, descending** (most stalled at top). Sort is per-section, not global; operators see the stalled-est caregiver in each phase, not just the stalled-est overall.

### Filters

A top filter bar with three controls:

- **Phase filter** — multi-select pills, all phases on by default. Toggle off to hide a phase section.
- **Stalled-only toggle** — when on, hides rows below the 5-day-in-phase threshold. Filters the daily-driver use case quickly.
- **Has AI suggestion toggle** — when on, shows only caregivers with at least one pending `ai_suggestions` row. Operators who want to triage AI suggestions specifically can use this. Off by default — AI is not the organizing principle.

No search box in V1. Operators searching by name use the existing global search.

### Realtime updates

Subscribe to `caregivers` table changes for any row already on screen — phase changes, note additions update the row in place. Same pattern as the existing Dashboard. New caregivers entering the funnel mid-day appear on the next refresh (no realtime subscription for new rows in V1 — too noisy).

---

## 3. Data model & queries

### Reads (read-only RLS, no new policies)

```sql
-- The main fetch: every non-archived, non-active-roster caregiver
-- with their phase, phaseTimestamps, and last-activity proxy.
SELECT id, first_name, last_name, phase_override, phase_timestamps,
       employment_status, created_at, notes, board_status
  FROM caregivers
 WHERE archived = false
   AND (employment_status IS NULL OR employment_status = 'onboarding');
```

The current phase per caregiver is computed client-side via the existing `getCurrentPhase()` util — same source of truth as the rest of the app.

```sql
-- Pending AI suggestions for any caregiver visible on screen.
SELECT entity_id, action_type, title, detail, created_at, expires_at
  FROM ai_suggestions
 WHERE entity_type = 'caregiver'
   AND entity_id = ANY($1::text[])   -- visible caregiver ids
   AND status = 'pending'
   AND expires_at > now();
```

```sql
-- Latest event per visible caregiver, for the "last operator action" column.
SELECT DISTINCT ON (entity_id) entity_id, event_type, actor, created_at, payload
  FROM events
 WHERE entity_type = 'caregiver'
   AND entity_id = ANY($1::text[])
   AND created_at > now() - interval '30 days'
 ORDER BY entity_id, created_at DESC;
```

No edge function required — all three queries are direct Supabase reads gated by existing RLS. The page is a single `useEffect` fetch + a single realtime subscription on `caregivers` changes.

### No writes

V1 is read-only. No new RPC, no new edge function.

---

## 4. Dead-code retirement

Two surfaces are removed in this PR. Both are net-negative today: zero users, ongoing maintenance burden, mental confusion when someone reads the code looking for the "AI surface."

### `AIPrioritiesPanel`

- File `src/features/caregivers/AIPrioritiesPanel.jsx` is deleted.
- File `src/features/caregivers/AIPrioritiesPanel.module.css` is deleted.
- Import + render in `src/features/caregivers/Dashboard.jsx` (lines 17 + 728) is removed.
- The pure-logic file `src/lib/aiPriorities.js` is **kept** — its `computeStaleCaregivers()` function is reused by `/pipeline-health` (under the renamed export `computeDaysSinceActivity()` or similar — TBD during implementation).
- Tests in `src/lib/__tests__/aiPriorities.test.js` are kept and updated to cover whatever surface in `/pipeline-health` consumes the function.

### `NotificationCenter`

- File `src/shared/components/NotificationCenter.jsx` is deleted.
- File `src/shared/components/NotificationCenter.module.css` is deleted.
- No call sites exist (confirmed via repo-wide grep on 2026-05-15) — the component was built but never mounted. Deletion is a no-op behaviorally.
- Approve/execute logic the component implements is duplicative of `executeSuggestion` in `supabase/functions/_shared/operations/routing.ts`, which is the canonical execution path used by the AI chat and the autonomy v2 auto-executor.

---

## 5. Sub-PR slicing

This work ships as a **single PR**, UI-A. The deliberate small scope:

- Add `/pipeline-health` route with the phase-grouped table.
- Add the three filters (phase, stalled-only, has-AI-suggestion).
- Add the realtime subscription on `caregivers`.
- Remove `AIPrioritiesPanel` from the Dashboard render path.
- Delete the two dead-code files (`AIPrioritiesPanel` + `NotificationCenter`).
- Add a sidebar nav link under "Caregivers" pointing to the new route.
- Add Vitest specs covering: phase grouping, days-in-phase computation, stalled threshold highlighting, AI badge rendering when a pending suggestion exists, filter toggles, sort order.

**Not in this PR**: `/agent-activity` digest, client pipeline, weekly-summary tiles, funnel chart, write actions. Those are explicitly deferred per §1.

### Phase D follow-up (not gated by this PR)

When Phase 2's recruiting orchestrator starts producing meaningful autonomous-action volume, ship UI-B:

- `/agent-activity` route under "Admin" sidebar section, next to `/agent-metrics`.
- Default view: today + last 7 days, counts by `action_type` × `phase` from `agent_actions`.
- One-click revert on `phase='auto_executed'` rows where the action_type allows reversal.
- Owner-led design conversation before scoping the PR — by then we'll have real data on what's worth digesting.

Phase 2 design begins regardless of UI-B status. UI-B's existence does not gate Phase 2.

---

## 6. Anti-patterns (do not do)

- **Don't reintroduce a "notifications feed" pattern.** The mental model shift away from notification-fatigue is the entire point of this work. If a future PR adds a notification surface back, it has failed the design.
- **Don't surface auto-executed actions on the Pipeline Health view.** That's the digest view's job (UI-B). Pipeline Health is about pipeline state, not agent activity.
- **Don't render counts of `agent_actions` rows on the per-caregiver row.** Operators don't care how many things the AI tried; they care whether the caregiver is moving. The AI is the helper, not the protagonist.
- **Don't add a "click to approve" or "click to execute" affordance to the AI badge.** The badge is informational. Action happens through the regular UI surfaces, where PR #347's loop closure converts the operator's deliberate action into positive autonomy signal. Adding an approve button reverts to the failed Notification Center model.
- **Don't pre-fetch transcripts or large `agent_actions.payload` blobs into the table view.** Keep the table lightweight; details load on click-through to the per-caregiver page.
- **Don't seed UX with a tutorial / empty-state hand-holding.** Operators are running operations; an empty phase section showing "no caregivers in this phase yet" is information, not failure.

---

## 7. Rollback

Pure additive at the data layer (no schema changes, no new tables, no new RPCs), so rollback is purely UI-level:

- Revert the PR. The `/pipeline-health` route disappears; `AIPrioritiesPanel` and `NotificationCenter` come back; the Dashboard reverts to its previous content.
- No data migration to undo. No edge function to redeploy.

If the new surface is correct but specific behaviors are wrong (wrong threshold, wrong filter behavior), a forward-fix PR is preferred over a full revert.

---

## 8. Decisions locked

All five §8 decisions were signed off by the owner on **2026-05-15** in the conversation that produced this spec. Locked answers:

- **D1. Sidebar section.** `/pipeline-health` lives under the existing "Caregivers" section, alongside Dashboard / Board / Roster. Revisit when the client pipeline ships its own Pipeline Health surface in Phase 3.
- **D2. Default route on app load.** `/` (the existing Dashboard) remains the default. Operators discover `/pipeline-health` via the sidebar; no forced default change.
- **D3. Stalled thresholds.** Ship at **5 days** for the amber highlight on "Days in this phase" and **14 days** for the strong red-text highlight. Revisit after ~4 weeks of production use; both thresholds become editable per-org in Phase D.
- **D4. AI badge interaction depth.** Single-click expands a tooltip showing the suggestion's `detail` field (the AI's reasoning). **No action buttons inside the tooltip** — operators act through the regular per-caregiver UI surfaces, which PR #347's loop closure already converts into positive autonomy signal.
- **D5. Empty-state behavior.** When zero caregivers are stalled, the dashboard renders the phase-grouped table with **all** caregivers (not blank). The "Stalled only" filter is off by default; operators see the full pipeline regardless of stall state and can opt into the stalled-only view.

Implementation of UI-A is unblocked once this spec lands on `main`.

---

## How to update this file

- When implementation PR opens, change "Status" to "In progress."
- When implementation PR merges, change "Status" to "Shipped" with the date + PR number.
- §8 decisions, once locked, move to "Decisions locked" (inline § header) and stay in the doc as a historical record.
- When UI-B (`/agent-activity` digest) is scoped, add §9 — the digest spec — to this file rather than creating a separate doc. One source of truth for the Pipeline Health work.
