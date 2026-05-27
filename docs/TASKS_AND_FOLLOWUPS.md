# User-Created Tasks & Follow-ups — Design & Rollout Plan

**Status:** Design locked with the owner 2026-05-27. Implementation phased; each phase ships as its own PR.
**Working branch:** `claude/task-followup-architecture-J5AXL`
**Related:** `docs/SAAS_RETROFIT.md` (Phase B compliance), `docs/RLS_GOTCHAS.md`, `docs/AGENT_PLATFORM_VISION.md` (Phase 3 hooks).

---

## 1. Problem & Goal

The office team has no way to capture ad-hoc reminders — *"call Maria Friday at 9am about the I-9"*, *"follow up with the Riverside lead next Tuesday"*, *"renew the Paychex API key Dec 1"*. Today these live in heads, sticky notes, and SMS to themselves, so things fall through the cracks.

**Goal:** Give every staff member a fast way to capture, get reminded of, and clear personal follow-ups — tightly woven into the caregiver/client context they're already working in.

**Non-goals (explicit):**
- A general project-management tool. No sub-tasks, no projects, no dependencies, no Gantt.
- Shared/multi-assignee tasks. One person owns each task.
- Caregiver-facing tasks. Staff only in v1 (matches existing `follow_up_tasks` RLS).
- Multi-entity linking. One task → one entity (or none).
- Native mobile apps. Responsive PWA only.

---

## 2. Owner Decisions (locked 2026-05-27)

1. **Creator is the assignee** — no assignee picker in v1. (A "reassign" affordance still exists post-create for the rare hand-off.)
2. **Staff only** — caregivers do not see tasks in the PWA.
3. **Single entity link** — a task attaches to one caregiver, one client, or nothing.

---

## 3. Current-State Inventory (what we extend, not rebuild)

| Asset | What it is | We reuse it for |
|---|---|---|
| `follow_up_tasks` table (mig `20260525000000`) | Template-driven, anchored to first caregiver-client shift. Status machine: pending → done / snoozed / cancelled. Org-scoped, staff-only RLS. | Single home for **all** tasks (template + user + ai). |
| `follow_up_templates` | Org-configurable cadences (4 seeded: 0d/7d/14d/30d). | Unchanged. Optional anchor for recurring user tasks (Phase 4). |
| `src/features/tasks/TasksDashboard.jsx` | Bucketed view (OVERDUE/TODAY/TOMORROW/THIS WEEK/LATER). | Default landing for the team; we add filters + inline create. |
| `src/lib/followUpTasks.js` | Mapper + read/write helpers. | Extend with `createUserTask`, `updateUserTask`. |
| `src/shared/context/FollowUpContext.jsx` | Realtime-subscribed task store. | Unchanged surface; new fields flow through. |
| `notifications_user` + `NotificationBell` + realtime | In-app notification spine (currently only `new_lead`). | Add `task_due` notification type. |
| `dispatch-lead-notifications` cron edge function | The canonical pattern for "scan a queue, write notifications, set notified_at". | Clone as `dispatch-task-notifications`. |
| `events` append-only bus | Situational-awareness layer for the AI context assembler. | Emit `task_created` / `task_completed` / `task_snoozed` / `task_overdue`. |
| `is_staff()`, `default_org_id()`, `touch_updated_at()` SECURITY DEFINER helpers | Established RLS / DX primitives. | Reuse verbatim. |

---

## 4. Design

### 4.1 Storage — extend `follow_up_tasks`

We do **not** create a parallel `user_tasks` table. One table for template / user / AI tasks means one dashboard, one notification path, one RLS surface, one realtime channel. The cost is small additive schema; the benefit is the team never wonders "which task list is mine?".

**Migration outline** (additive only — no drops, no rewrites, fully idempotent):

```sql
ALTER TABLE public.follow_up_tasks
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'template'
    CHECK (source IN ('template','user','ai')),
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

-- template_id and caregiver_id and client_id all become nullable so that
-- user/ai tasks can stand alone or attach to a single entity.
ALTER TABLE public.follow_up_tasks
  ALTER COLUMN template_id DROP NOT NULL,
  ALTER COLUMN caregiver_id DROP NOT NULL,
  ALTER COLUMN client_id DROP NOT NULL;

-- Integrity: every task is valid under exactly one shape.
ALTER TABLE public.follow_up_tasks
  ADD CONSTRAINT follow_up_tasks_shape CHECK (
    (source = 'template'
       AND template_id IS NOT NULL
       AND caregiver_id IS NOT NULL
       AND client_id IS NOT NULL
       AND title IS NULL)
    OR
    (source IN ('user','ai')
       AND title IS NOT NULL
       AND length(btrim(title)) > 0
       AND NOT (caregiver_id IS NOT NULL AND client_id IS NOT NULL))
  );

-- Dispatch-supporting index: scan for due+unnotified+pending efficiently.
CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_dispatch
  ON public.follow_up_tasks (due_at)
  WHERE status = 'pending' AND notified_at IS NULL;

-- Personal-inbox indexes: "show me my open tasks ordered by due_at".
CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_assigned
  ON public.follow_up_tasks (assigned_to, status, due_at);
```

**Notes on the constraint:**
- Template tasks keep exactly today's shape (both entity IDs required, `title` NULL since the template carries the name). The existing rows already satisfy this.
- User/AI tasks require a `title`, may attach to at most one entity, and never carry a `template_id`. (Recurring user tasks in Phase 4 will attach to a template — the constraint is loose enough to allow that without changes.)

**RLS:** Existing four policies (select/insert/update/delete) on `follow_up_tasks` already enforce `is_staff() AND org_id = jwt.org_id`. They cover the new rows without modification — same predicate, no new policies, no recursion risk.

**Realtime:** `follow_up_tasks` is already in `supabase_realtime`. New rows flow through existing subscriptions.

### 4.2 The lifecycle (kept brutally simple)

```
States:  pending → done
                 → snoozed (snoozed_until) → pending (auto, dispatcher unsnoozes when snoozed_until <= now())
                 → cancelled
Times:   created_at, due_at, snoozed_until, completed_at, notified_at
```

- **No undated tasks.** UI defaults `due_at` to today 17:00 local if blank.
- **Snooze ≠ reschedule.** Snooze sets `status='snoozed' AND snoozed_until=...`. The dispatcher flips it back to `pending` when the snooze expires and notifies again. Reschedule edits `due_at` directly and clears `notified_at` so a fresh notification fires.
- **Overdue handling (v1):** one notification at `due_at`. No automatic re-ping. The dashboard's OVERDUE bucket is the persistent surface.

### 4.3 Notification flow

```
              user creates task                  task due (cron tick)
                     │                                   │
                     ▼                                   ▼
       INSERT follow_up_tasks                dispatch-task-notifications
            (notified_at=NULL)                  scans dispatch index,
                                                writes notifications_user,
                                                sets notified_at
                                                          │
                                                          ▼
                                                NotificationBell (realtime)
                                                  → unread badge, toast
```

**`notifications_user` change:** widen the CHECK to include `task_due`:

```sql
ALTER TABLE public.notifications_user
  DROP CONSTRAINT notifications_user_notification_type_check,
  ADD  CONSTRAINT notifications_user_notification_type_check
       CHECK (notification_type IN ('new_lead','task_due'));
```

**Snooze expiry:** the same dispatcher tick checks for `status='snoozed' AND snoozed_until <= now()`, flips to `pending`, clears `notified_at`, then the next pass notifies. Two trips through the same cron — cleaner than embedding "is this really due?" math in three places.

**Cron schedule:** every 5 minutes (matches `dispatch-lead-notifications`).

### 4.4 Event logging (AI context hooks)

After every successful state transition, emit to `events`:

| Trigger | event_type | actor | payload |
|---|---|---|---|
| User creates task | `task_created` | `user:<email>` | `{ task_id, title, due_at, entity_type, entity_id }` |
| User marks done | `task_completed` | `user:<email>` | `{ task_id, completion_note }` |
| User snoozes | `task_snoozed` | `user:<email>` | `{ task_id, snoozed_until }` |
| Dispatcher fires reminder | `task_due` | `system:cron` | `{ task_id, assigned_to }` |

Implementation: write a thin `logTaskEvent(client, type, task)` helper in `src/lib/followUpTasks.js`. Fire-and-forget — failures must never block the user's action.

The AI assembler's situational-awareness layer already reads `events` from the last 24h; these new types flow in for free.

### 4.5 Quick capture — the single most important UX surface

A modal triggered by **`Cmd/Ctrl+K`** globally, or "+ Follow-up" buttons embedded in entity pages.

```
┌─ New follow-up ─────────────────────────────────────┐
│                                                     │
│  What needs doing?                                  │
│  [_______________________________________________]  │
│                                                     │
│  Due:  [tomorrow 9am                           ▾]   │
│        ↳ parsed: Thu May 28, 2026 9:00 AM           │
│                                                     │
│  About (optional):                                  │
│  [ search caregiver or client …               ▾ ]   │
│                                                     │
│  Urgency:  ( ) Info  (●) Warning  ( ) Critical      │
│                                                     │
│                            [ Cancel ]  [ Save ⏎ ]   │
└─────────────────────────────────────────────────────┘
```

**Non-negotiable:** natural-language date parsing via `chrono-node`. The team must be able to type "fri 2pm", "tomorrow", "next monday", "in 3 days" and have it work. A date picker is a fallback, not the primary input.

**Pre-fill rules:**
- `assigned_to = current user's email` (locked decision: creator = assignee).
- If invoked from a caregiver/client detail page → entity pre-selected, not changeable.
- If invoked globally (Cmd+K) → entity blank, optional typeahead.
- `due_at` blank → defaults to today 17:00 local on save.
- `urgency` defaults to `warning` (matches template default).

### 4.6 Contextual surfaces

| Surface | Behaviour |
|---|---|
| `CaregiverDetail` / `ClientDetail` | "+ Follow-up" button beside the existing notes/ActivityLog entry. Inline list shows open follow-ups for that entity (already wired via `loadFollowUpsForCaregiver/Client`). |
| `TasksDashboard` | Default landing for staff. Adds a "+ New" button and a source filter (All / Auto-generated / Mine). Keyboard `c` complete, `s` snooze, `e` edit. |
| `NotificationBell` | Already realtime-subscribed to `notifications_user`. New `task_due` rows render in the same dropdown. |
| Sidebar badge | Existing `countNavBadge()` already counts pending+due. Extends naturally. |

### 4.7 AI integration (Phase 3, designed now)

The AI assistant gains two tools:

- `create_task({ title, due_at, entity?, urgency })` — proposes a task in chat; one-click accept inserts a `source='ai'` row.
- `complete_task({ task_id, reason })` — when the AI detects an action was performed via another channel (e.g. an outbound SMS to the same caregiver about the same topic), it proposes closure.

The briefing layer (`supabase/functions/ai-chat/context/briefing.ts`) surfaces:
- count of overdue tasks assigned to the current user
- next 3 pending tasks ordered by `due_at`
- any task due in the next 2 hours

No proactive AI action without confirmation in v1 — every AI task creation is a suggested-then-accepted flow, matching the "L2 Confirm" tier in `docs/AGENT_PLATFORM.md`.

---

## 5. Phased Rollout

Each phase is **its own PR** off `claude/task-followup-architecture-J5AXL` (or a child branch). Each PR is independently reviewable, deployable, and reversible.

### Phase 1 — Foundation (target PR #1)

**Ships:**
- Migration: ALTER `follow_up_tasks` (new columns + nullable template/entity + shape CHECK + indexes).
- Migration: widen `notifications_user.notification_type` to include `task_due`.
- `src/lib/followUpTasks.js`: add `createUserTask`, `updateUserTask`, extend mapper for new fields, add `logTaskEvent` helper.
- `src/features/tasks/QuickCaptureModal.jsx` — the Cmd+K modal.
- `src/features/tasks/TaskCreateButton.jsx` — the contextual "+ Follow-up" button, mounted on caregiver/client detail.
- Global hotkey wiring in `AppShell.jsx`.
- `chrono-node` dependency.
- Tests: `chronoParsing.test.js`, `followUpTasks.test.js` extensions (createUserTask, mapper coverage), shape CHECK reproduction in `followUpTasksMigration.test.js`.
- No edge functions, no cron. The dispatcher comes in Phase 2 so this PR is independently mergeable and rollbackable.

**Behavior change visible to users:** Cmd+K opens the modal; staff can create user follow-ups; they appear on the dashboard. **No new notifications fire yet** — staff still see them via the dashboard's OVERDUE/TODAY buckets.

**What the owner does:**
1. Review the PR.
2. Test on the Vercel preview deploy (Cmd+K, create a task, verify it appears in `TasksDashboard`).
3. Merge.
4. **Trigger the `Deploy Database Migrations` workflow** from the GitHub Actions tab — first with `dry_run=true` to confirm the pending list shows only the new migration, then `dry_run=false`.

**Rollback plan:** Migration is purely additive. To roll back: ignore the new columns (legacy code still works since they're nullable / defaulted) and revert the frontend PR via Vercel. No data migration required.

**Risk:** Low. Existing template-task code path untouched (constraint excludes those rows).

---

### Phase 2 — Notifications + Polish (target PR #2)

**Ships:**
- Edge function `supabase/functions/dispatch-task-notifications/` modeled on `dispatch-lead-notifications`.
- Migration: pg_cron job `dispatch-task-notifications` every 5 minutes.
- Dispatcher logic: scan dispatch index, write `notifications_user`, set `notified_at`, flip expired snoozes back to pending, emit `task_due` events.
- Snooze popover (1h / tonight 5pm / tomorrow 9am / Mon 9am / custom) in `TasksDashboard` + entity panels.
- Keyboard shortcuts: `c` complete, `s` snooze, `e` edit.
- "My Day" default filter on `TasksDashboard` (today + overdue, mine).
- Tests: dispatcher integration (mocked supabase), snooze popover unit tests.

**Behavior change visible to users:** notifications now fire at due time via the bell + toast. Snooze becomes a real workflow.

**What the owner does:**
1. Review + merge.
2. Trigger `Deploy Database Migrations` workflow.
3. Edge function auto-deploys via existing `.github/workflows/deploy-edge-functions.yml`.
4. Watch the bell on the preview deploy — within 5 min of a task's `due_at`, a notification should appear.

**Rollback plan:** Disable the cron job (single SQL `SELECT cron.unschedule('dispatch-task-notifications')`). No data corruption possible — dispatcher is idempotent on `notified_at IS NULL`.

---

### Phase 3 — AI Integration (target PR #3)

**Ships:**
- Two new tools in `supabase/functions/ai-chat/`: `create_task`, `complete_task`.
- Briefing layer additions in `context/briefing.ts`.
- System prompt updates in `context/assembler.ts` describing the new tools.
- Tests: tool-output schema, briefing payload shape.

**Behavior change:** AI can propose tasks and propose closures from chat; briefings surface what's on your plate.

**Rollback:** Revert the PR; nothing structural changes in the DB.

---

### Phase 4 — Recurrence + Optional SMS Escalation (target PR #4)

**Ships:**
- Wire `recurring_interval_days` for templates (already in schema, never used). When a recurring template's instance is marked done, spawn the next via the same dispatcher cron. (Also unlocks the four seeded recurring template if any.)
- For `source='user'`, allow attaching a lightweight per-task `repeat_every_days` integer (additive column). Spawned by the same cron path.
- Opt-in per-user morning digest email (single daily summary 7am local) — `user_preferences` table or `organizations.settings` per-email map.
- (Stretch) SMS escalation for `urgency='critical'` tasks unacknowledged 1h past `due_at`, sent via the existing RingCentral route.

**Decision point at the start of Phase 4:** confirm with owner whether SMS escalation actually solves a real miss, or whether the bell + digest is sufficient. Don't build SMS escalation speculatively.

---

## 6. Test Plan (Phase 1 detail; later phases analogous)

**Unit:**
- `bucketFollowUps` — already covered; extend with user-task fixtures (no template, no entity).
- `dbToFollowUpTask` mapper — new fields (source, title, description, created_by, notified_at).
- `createUserTask` — happy path, validation errors, optional entity link.
- `chrono-node` integration — "tomorrow", "fri 2pm", "next monday", "in 3 days", empty input → default.

**Migration:**
- `followUpTasksMigration.test.js` extension: the shape CHECK rejects malformed rows (e.g., source='user' with both caregiver_id and client_id).

**Integration (manual, on preview deploy):**
- Cmd+K → create → dashboard shows.
- From caregiver detail → "+ Follow-up" → pre-filled, appears in inline panel + dashboard.
- Existing first-day-checkin auto-generation still fires when a new shift is scheduled (regression check).
- RLS: non-staff user cannot read/write tasks.

**Build & CI:** `npm test` and `npm run build` green locally before each push, per CLAUDE.md.

---

## 7. RLS Safety Audit (per `docs/RLS_GOTCHAS.md`)

We are **not** adding new policies on `follow_up_tasks`. The existing four (select/insert/update/delete) use the canonical `is_staff() AND org_id = jwt` predicate — no inline subqueries, no recursion risk.

We **are** widening a CHECK constraint on `notifications_user`. RLS policies on that table reference `user_email`, not `notification_type`, so the widening is transparent.

Manual reproduction before merging Phase 1 PR (per RLS gotchas doc):
```sql
-- as authenticated staff
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"...","email":"jessica@...","org_id":"..."}';
SELECT * FROM follow_up_tasks WHERE source='user' LIMIT 1;
INSERT INTO follow_up_tasks (org_id, source, title, due_at, assigned_to) VALUES (...);
```
Expected: no `infinite recursion detected in policy` error.

---

## 8. Multi-Tenant Compliance (per `docs/SAAS_RETROFIT.md`)

- `org_id` already NOT NULL on `follow_up_tasks` and `notifications_user`. New rows inherit `default_org_id()`.
- No hardcoded org IDs introduced.
- No new env vars introduced.
- No new Tremendous Care branding strings.
- The dispatcher cron scopes by org via the existing `is_staff() AND org_id = jwt` RLS — same pattern as `dispatch-lead-notifications`.

---

## 9. Success Criteria

Phase 1 ships successfully when:
1. CI green, build green, no test regressions.
2. Owner can press Cmd+K, type "call Maria tomorrow 9am", press Enter, and see the task appear on `TasksDashboard` under TOMORROW.
3. The existing first-day-checkin trigger still fires on shift insert (regression check).
4. The shape CHECK rejects malformed rows in the SQL editor.

Phase 2 ships successfully when:
1. A task created with `due_at = now() + 2 minutes` produces a `notifications_user` row + a visible bell notification within 7 minutes.
2. Snoozing a task to "1 hour" makes it disappear from the dashboard, then reappear with a fresh notification ~1 hour later.

---

## 10. Open Future Questions (not blocking)

- Per-user notification preferences (digest opt-in, channel routing) — Phase 4.
- Caregiver-facing tasks via PWA — re-evaluate after 3 months of staff usage.
- Multi-entity attachment (e.g., a meet-and-greet involving both caregiver + client) — re-evaluate based on actual demand, schema-cheap to allow later via an additional ID column with another CHECK.
- Org-level timezone awareness for `due_at` rendering — coupled to the broader Phase D branding work.

---

## 11. Changelog

- **2026-05-27** — Initial design, locked with owner. Three decisions confirmed: creator=assignee, staff-only, single-entity link.
