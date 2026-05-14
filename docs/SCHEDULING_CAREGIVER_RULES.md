# Scheduling — Regular Caregiver Rules

Status: in flight (initial PR opens 2026-05-14)
Owner: scheduling subsystem
Prereqs: service-plan ongoing extension cron (shipped 2026-05-07)

This is the design for **persistent day-of-week caregiver assignments
on service plans**. It closes a hole in the current scheduling model
that becomes visible the first time the cron rolls a new 12-week
window past the previously-assigned shifts.

---

## Problem

Today the scheduling model has three layers:

1. **Service plan** (`service_plans`) — pure recurrence pattern.
   When to run, how long, which days of the week. **No caregivers.**
2. **Shift instance** (`shifts`) — concrete row materialized from the
   pattern by the cron. Carries `assigned_caregiver_id`, nullable.
3. **Cron** (`service-plan-extend-ongoing`) — materializes a rolling
   12-week window of `shifts` rows for every `is_ongoing = true`
   plan, **all with `status = 'open'` and no caregiver**.

The team's actual workflow needs a layer between #1 and #2: a
persistent statement of "Ciara is the regular Thursday caregiver for
Sheldon," durable across cron runs.

### What's broken in observable terms

- Scheduler opens the calendar, assigns Ciara to Sheldon's Thursdays
  using the existing "Apply to all future shifts in this recurring
  series" checkbox in the shift drawer. Every materialized future
  Thursday gets Ciara. Great.
- 12 weeks pass. The cron materializes the next batch of Thursdays.
  Those new shifts are open — **the assignment doesn't survive
  because the rule was never persisted; it only lived on the
  materialized rows**.
- The team has to re-assign every recurring shift every quarter,
  forever.

### What's *not* the problem

- The model that lets you assign one caregiver per shift is fine.
  The "Apply to future" checkbox already works for the
  currently-materialized window.
- The recurrence pattern itself auto-continues via `is_ongoing`. The
  pattern persists; only the staffing decisions don't.
- The cron is not buggy. It's correct given the data it has — there
  is just nothing for it to read about who staffs which day.

### Bonus, smaller problem

There is no first-class answer to "who is Sheldon's regular Thursday
caregiver?" without scanning the most recent Thursday shift. This is
fine for one client; it gets awkward for reporting, payroll
projections, and the team's mental model of coverage.

---

## Goals

1. The cron materializes future shifts **already assigned to the
   right caregiver** for each day of the week, when a rule exists.
2. The scheduler can answer "who covers Sheldon on Thursdays?" by
   looking at the service plan, not the calendar.
3. Day-of-week assignments are first-class data — created, edited,
   audited, expired.
4. The existing one-off-per-shift workflow continues to work
   unchanged. A rule is the optional persistent layer; not requiring
   one is a feature.
5. **Nothing destructive.** Past shifts with clock events are never
   touched by anything in this design.

## Non-goals (v1)

- **Rotating patterns** (week-on / week-off, biweekly rotation). Out
  of scope. Roughly 5% of agency workflows. Solvable later by adding
  a rotation-offset column or by clever use of effective date
  ranges; not solved here.
- **Multiple caregivers per shift instance** (e.g. caregiver + nurse
  on the same visit). Different problem; not what was requested.
- **Inferring rules from existing shift history.** No migration of
  legacy assignments. The team captures patterns going forward by
  using the new UI surfaces.
- **Cross-tenant features**, billing, automated availability
  proposals, AI-suggested coverage. All deferred.

---

## Data model

One new table. Zero changes to existing tables.

```sql
CREATE TABLE service_plan_caregiver_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  service_plan_id uuid NOT NULL REFERENCES service_plans(id) ON DELETE CASCADE,
  day_of_week     smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  caregiver_id    text NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  effective_from  date NOT NULL,
  effective_to    date,
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scpr_dates_ordered CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);
```

**Indexes**

```sql
-- Hot path: cron lookup. For each materialized instance, find the
-- active rule for (plan, day_of_week, date). Sorted by effective_from
-- descending so a single row read picks the most recent rule that
-- covers the date.
CREATE INDEX idx_scpr_lookup
  ON service_plan_caregiver_rules (service_plan_id, day_of_week, effective_from DESC);

-- "Which plans does caregiver X cover?" — used by the
-- remove-caregiver-from-client cascade and by conflict detection.
CREATE INDEX idx_scpr_caregiver
  ON service_plan_caregiver_rules (caregiver_id, day_of_week);

-- Per-org tenancy.
CREATE INDEX idx_scpr_org
  ON service_plan_caregiver_rules (org_id);
```

### Schema decisions

- **`day_of_week` not `days_of_week[]`.** One row per day. Picking
  caregivers per day is the whole point; an array column would make
  per-day edits a read-modify-write footgun. One row per day keeps
  every operation a simple insert/update/delete.

- **`effective_from` / `effective_to`** instead of a single "active"
  boolean. Two reasons:
  - Future-dated changes ("starting July 2, Maria takes Thursdays")
    are first-class. Insert the new row with `effective_from =
    2026-07-02`; update the old row's `effective_to = 2026-07-01`.
    No background job, no scheduled task — the cron's per-row
    lookup picks the right rule automatically.
  - Audit trail. Past coverage is preserved and queryable. "Who
    was the regular Thursday caregiver in Q1 2026?" is a single
    `SELECT`.

- **No `default_caregiver_id` on `service_plans`.** Considered and
  rejected. The moment a plan has any day-specific assignment, a
  "default" becomes misleading. Keep the model pure: every assignment
  is day-specific.

- **`caregiver_id` is `text`** to match the existing
  `caregivers.id text` column. `service_plan_id` is `uuid` to match
  `service_plans.id uuid`. This matches the existing `shifts` table.

- **`ON DELETE CASCADE` on both FKs.** If a service plan is deleted,
  its rules go with it (rules without a plan are nonsense). If a
  caregiver is deleted, their rules go with them — the cron simply
  stops auto-assigning. Past shifts retain `assigned_caregiver_id`
  via the existing `ON DELETE SET NULL` on `shifts.assigned_caregiver_id`.

- **Indexes hit the cron's hot query.** The cron will materialize up
  to a few hundred shifts per run across all ongoing plans. Per-shift
  rule lookup needs to be O(log n). `(service_plan_id, day_of_week,
  effective_from DESC)` makes "give me the active rule for plan P
  on day D at date X" a single index probe.

### RLS

Following the precedent set by the existing scheduling tables
(`service_plans`, `shifts`, `caregiver_availability`, etc.), the
policy is straightforward "authenticated users have full access."
The codebase's tenant-isolation layer (`is_staff()` / Phase B) sits
above this; per-table per-tenant policies will come later in the
SaaS retrofit and uniformly apply to all scheduling tables at once.

```sql
ALTER TABLE service_plan_caregiver_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY scpr_all ON service_plan_caregiver_rules
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
```

**RLS gotchas to watch for** (per `docs/RLS_GOTCHAS.md`):

- No inline `EXISTS (SELECT ... FROM service_plan_caregiver_rules)`
  anywhere — but this table is leaf-ish, so the policies that read
  *from* it (the cron, frontend storage layer) are all using the
  service-role key or the simple authenticated policy. No recursion
  risk.
- The cron uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS, so
  the cron's rule lookup is unaffected by policy decisions either
  way. Frontend lookups go through `authenticated` and the trivial
  policy.

---

## Cron change

File: `supabase/functions/service-plan-extend-ongoing/index.ts`

The cron's current behavior: materialize `shifts` rows with
`status: 'open'` and no caregiver. The change is one batch
lookup + a per-row resolve:

```typescript
// Before insert, load all rules for the plan once.
const { data: rules } = await supabase
  .from("service_plan_caregiver_rules")
  .select("day_of_week, caregiver_id, effective_from, effective_to")
  .eq("service_plan_id", plan.id);

const resolveCaregiverForInstance = (instance) => {
  const startDate = instance.date;            // 'YYYY-MM-DD'
  const dow = dayOfWeekUtc(instance.start_time); // 0..6
  // Active rules for this day, in priority order (most recent first).
  const candidates = (rules ?? [])
    .filter((r) =>
      r.day_of_week === dow &&
      r.effective_from <= startDate &&
      (r.effective_to == null || r.effective_to >= startDate)
    )
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return candidates[0]?.caregiver_id ?? null;
};

const rows = newInstances.map((inst) => {
  const caregiverId = resolveCaregiverForInstance(inst);
  return {
    org_id: plan.org_id,
    service_plan_id: plan.id,
    client_id: plan.client_id,
    start_time: inst.start_time,
    end_time: inst.end_time,
    assigned_caregiver_id: caregiverId,
    status: caregiverId ? "scheduled" : "open",
    recurrence_group_id: plan.id,
    recurrence_rule: plan.recurrence_pattern,
    created_by: "system:service-plan-extend-ongoing",
  };
});
```

**Backward compatibility**: if a plan has no rules, the resolver
returns `null` and the shift is created `status: 'open'` exactly as
today. **The cron's behavior on existing plans is bit-for-bit
identical until someone writes a rule.**

**`status: 'scheduled'`** is the right status for an auto-assigned
new shift per the existing CHECK constraint (`'open' | 'offered' |
'assigned' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled'
| 'no_show'`). The `assigned` status implies a manual decision and
notifications/confirmation flow; `scheduled` is the right neutral
state for "the schedule says this person is here." We will likely
need a small UI note in the calendar that distinguishes auto-scheduled
from manually-assigned, but that's a follow-up — both states are
visible-to-caregivers and visible-on-the-calendar today.

Wait — checking the CHECK constraint on shifts: the allowed values
are `open, offered, assigned, confirmed, in_progress, completed,
cancelled, no_show`. There is no `scheduled`. So auto-assigned new
shifts use `assigned` (matching the dialog's behavior when the user
picks a caregiver up front). This is correct: a rule represents the
team's standing assignment decision, and "Apply to future Thursdays"
already produces `assigned` shifts today, so the cron should match.

**Day-of-week derivation**: must use UTC and the org timezone in
exactly the same way the recurrence expansion does. We add a tiny
helper `dayOfWeekForInstance(instance, timezone)` next to the
existing recurrence helpers so the cron and the frontend share one
implementation.

---

## UX surfaces

Two entry points into the same underlying rule table. They must
agree on what they show.

### 1. Service plan — "Regular caregivers" grid

In the service plan editor (likely
`src/features/scheduling/ServicePlanEditor.jsx` or wherever the plan
form lives), a new section below the recurrence-pattern picker:

```
Regular caregivers (optional — can be set later)
┌───────────┬───────────┬───────────┬───────────┬───────────┬───────────┬───────────┐
│   Sun     │   Mon     │   Tue     │   Wed     │   Thu     │   Fri     │   Sat     │
├───────────┼───────────┼───────────┼───────────┼───────────┼───────────┼───────────┤
│   —       │  [Maria]  │   —       │  [Bob ]   │  [Maria]  │  [Bob ]   │   —       │
└───────────┴───────────┴───────────┴───────────┴───────────┴───────────┴───────────┘
```

Rules:

- Days that aren't in `recurrence_pattern.days_of_week` are greyed
  out and not editable. ("Sun" and "Tue" above.)
- Picking a caregiver fires the conflict check immediately. If the
  caregiver has a conflict (their stated unavailability, another
  rule, an existing one-off shift), a warning is shown inline.
- Save writes/updates rules. Effective_from defaults to today.
- Removing a caregiver from a day **expires** the rule (sets
  `effective_to = today`) and unassigns future open-status shifts
  that match the day-of-week. Past shifts and any shift with clock
  events are untouched.

### 2. Shift drawer — "Apply to" radio

The existing "Also apply to all future shifts in this recurring
series" checkbox upgrades to a small inline radio:

```
Apply this caregiver change to:
  ( ) This shift only
  ( ) All future Thursday shifts for Sheldon's plan
```

- Default is "This shift only" (today's behavior).
- "All future Thursdays" path:
  1. Update this one shift's `assigned_caregiver_id`.
  2. Upsert a rule: `(service_plan_id, day_of_week=this_dow,
     caregiver_id=new_id, effective_from=this_shift.date)`. If a rule
     already exists for that day, close it (`effective_to =
     this_shift.date - 1`) and open the new one.
  3. Update all future siblings (same `recurrence_group_id`, later
     `start_time`, **no clock events**, status not in
     `{cancelled, completed, no_show}`) to the new caregiver.
- Unassign + "all future" path: delete or expire the rule, unassign
  future open shifts.

The wording "All future Thursday shifts" is dynamic — picks up the
weekday name from the shift's start time.

---

## Removing a caregiver

| Where you act | What happens |
|---|---|
| Service plan grid → clear Thursday's caregiver | Expire that day's rule. Unassign future Thursdays on this plan that have no clock events. |
| Shift drawer → Unassign → "This shift only" | `assigned_caregiver_id = NULL` on that single row. Rule untouched. |
| Shift drawer → Unassign → "All future Thursdays" | Same as service plan grid action. |
| Client page → "Remove caregiver from all schedules" | For every active rule where `service_plan.client_id = client AND caregiver_id = caregiver`: expire rule. Then unassign all future shifts that match (no clock events). |

**Invariant: nothing in this design ever mutates a shift that has
clock events.** Backfill operations filter by

```
WHERE NOT EXISTS (SELECT 1 FROM clock_events WHERE shift_id = shifts.id)
  AND shifts.status NOT IN ('completed', 'in_progress')
  AND shifts.start_time > now()
```

UI shows "X past shifts kept (already worked)" when this filter
trims any rows.

---

## Conflict detection

When a rule is created or its caregiver is changed, run the existing
shift conflict checker against the rule's representative time window
on each occurrence. Sources of truth, in order:

1. **`caregiver_availability`** — stated availability. If the
   caregiver hasn't declared they're available Thursday evenings, we
   surface the gap (warning, not block — the team can override with
   their judgement).
2. **Other rules for this caregiver** — same `day_of_week`,
   overlapping `(effective_from, effective_to)`, overlapping
   wall-clock times across their service plans' recurrence patterns.
   Hard conflict.
3. **Existing `shifts` rows assigned to this caregiver** — same
   day-of-week, overlapping time on dates within the rule's
   effective range. Catches one-off shifts they're already on.
4. **`time_off_requests` / blackouts** — if and when they exist.
5. **Hours-per-week / max-clients caps** — if policy is configured.

The rule-creation form does not write a rule that produces hard
conflicts without explicit confirmation. The shift drawer's "Apply
to future" path runs the same check on the underlying rule it's
about to write.

We **don't** invent a new conflict engine. The form calls the same
function the shift assignment flow uses today, with the rule's
pattern expanded to the next ~4 occurrences as test inputs.

---

## Failure modes & edge cases

- **A rule covers a date but the pattern doesn't.** Rule says
  "Thursdays → Maria"; pattern only schedules Mon/Wed/Fri.
  No instances are materialized on Thursdays, so the rule is inert
  for that pattern. Allowed (lets you save a partial setup; the
  team may extend the pattern later). The grid greys out rule
  cells whose day-of-week isn't in the pattern as a visual cue.

- **Pattern changes after rules exist.** Same as above — rules
  remain but become inert if they don't match. No cascade. Service
  plan editor flags inert rules with a quiet "not in current
  schedule" note.

- **Caregiver is terminated.** Two options:
  - Manual: scheduler expires the rule via the cascade action.
  - Automatic: a small follow-up adds a trigger that, when
    `caregivers.terminated_at` is set, expires all active rules
    where `caregiver_id = NEW.id` with `effective_to = NEW.terminated_at`.
    Not in v1.

- **Overlapping rules** for the same `(plan, day_of_week)` with
  overlapping effective ranges. Allowed by the schema, resolved at
  read time by `effective_from DESC` ordering — the most recent
  rule wins. This lets you transition cleanly without a hard
  ownership change. UI lints overlapping rules as a soft warning
  (likely a mistake, but valid).

- **Cron races a frontend rule write.** Both write to disjoint
  rows; no contention. The cron reads rules at start-of-run; if a
  rule is added mid-run, that rule applies to the next run.
  Acceptable.

- **Day-of-week computation.** Postgres `extract(dow from ...)`
  returns 0=Sunday..6=Saturday. JS `Date.getUTCDay()` likewise.
  `recurrence.js` already uses this convention. We codify it in one
  helper, used by cron, conflict checker, and UI.

---

## Migration / rollout

1. **Phase 1 (this PR)** — Migration + cron change + storage layer
   + service plan grid + shift drawer radio + cascade action + tests.
   New code is backward-compatible: until rules exist, behavior is
   bit-for-bit identical to today.

2. **Phase 2 (follow-up, separate PR)** — Auto-expire rules when a
   caregiver is terminated. Not in v1.

3. **Phase 3 (follow-up)** — UI for viewing the rule history of a
   plan ("show me every Thursday caregiver this plan has had"). Not
   in v1.

### Deployment order

Because the Vercel preview deploys hit the production Supabase
instance, **the migration must be applied before this PR's code
deploys**:

1. Merge migration via Deploy Database Migrations workflow with
   `dry_run=true`, confirm the new table is the only pending
   change, then `dry_run=false`.
2. Merge the PR to `main`. Vercel auto-deploys frontend; GitHub
   Actions auto-deploys the cron.
3. Storage layer guards against the table not existing yet (try/catch
   that logs and returns empty results), so an out-of-order deploy
   degrades gracefully — UI renders with no rules visible — rather
   than throwing 500s on every page that touches a service plan.

### Rollback plan

- **Cron**: the cron's rule lookup is purely additive. If a bug
  emerges, redeploy the prior version of `service-plan-extend-ongoing`
  via the Deploy Edge Functions workflow on an earlier commit.
- **Schema**: rolling back the new table is safe — no existing code
  depends on it. Drop the table via a rollback migration; existing
  shifts and service plans are untouched. (`_rollback/` directory
  follows existing convention.)
- **Frontend**: Vercel dashboard → previous deployment → "Promote
  to production" if a UI bug emerges. The cron and migration can
  stay; they're independent.

---

## Open questions (to settle by review)

- **Future-rule UI**: should the grid offer a calendar picker for
  `effective_from` on each cell, or default to "today" with an
  advanced toggle? V1 keeps it simple — always "today" or "service
  plan start date." Future-dated changes go through the shift drawer
  by editing a future shift first.
- **Auto-status for cron-assigned shifts**: `assigned` matches what
  manual "apply to future" produces today, but it conflates two
  concepts (team committed vs. caregiver acknowledged). Likely a
  future migration adds a separate `auto_scheduled` flag. For v1,
  `assigned` is correct; we accept the conflation.
