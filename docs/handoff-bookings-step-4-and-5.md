# Microsoft Bookings Integration — Handoff for Steps 4 & 5

**Use this document to brief a fresh Claude chat session.** Paste it in full as the first message; the new agent will have everything it needs to ship the remaining work.

**Last updated:** 2026-05-01, immediately after PR #251 merged and went live in production.

---

## TL;DR for the new chat

Bookings integration Steps 1, 2, and 3 (with v2 pivot) are **shipped, deployed, and working in production**. Real bookings are flowing into `caregiver_interviews` every 5 minutes via a polling cron. The "Send Interview Booking Link" automation rule is **enabled and live** — completing the "Send Interview Link" task fires an SMS with the booking URL.

**What's left:**
- **Step 4** — UI card on `CaregiverDetail.jsx` showing booking state.
- **Step 5** — In-app cancel/reschedule via Graph PATCH/DELETE.

The owner is non-technical and trusts Claude as senior dev/architect/deployment manager. **Production safety, multi-tenancy compliance, and PR + CI workflow are non-negotiable** — see `CLAUDE.md` prime directives.

---

## Project context

- **App:** Tremendous Care caregiver portal (React 18 + Vite + Supabase + Vercel)
- **Repo:** `TremendousCare/caregiver-portal`
- **Primary working directory:** `/home/user/caregiver-portal`
- **Production URL:** https://caregiver-portal.vercel.app
- **Supabase project ID:** `zocrnurvazyxdpyqimgj`
- **Test framework:** Vitest. Run `npm test` (CI), `npm run test:watch` (dev). Currently ~2,483 tests across 89 files.
- **Multi-tenant retrofit phase:** Phase B (RLS enforcement) — see `docs/SAAS_RETROFIT_STATUS.md`. Anything new must be born multi-tenant: `org_id NOT NULL`, RLS enabled, no hardcoded TC URLs/IDs.

---

## What's shipped (chronological)

### Step 1 — Read-only Graph foundation (PR #246, merged 2026-05-01)
- `supabase/functions/bookings-integration/` edge function with read-only Graph actions: `verify`, `list_businesses`, `list_services`, `list_staff`, `list_appointments`, `get_appointment`.
- Two new Azure AD permissions granted with admin consent: `Bookings.Read.All`, `BookingsAppointment.ReadWrite.All`.
- Microsoft Bookings business "Tremendous Care Caregiver Interviews" created with one published service "Caregiver Interview" assigned to Daniela Hernandez.

### Step 2 — Auto-send via Automations (PR #248, merged 2026-05-01)
- New `{{booking_url}}` merge field, resolved per-org from `organizations.settings.bookings.public_url`.
- Pure helper `supabase/functions/_shared/helpers/bookings.ts` — `getBookingUrlFromOrgSettings`, locked by Vitest.
- Migration `20260504000000` stores TC's bookings config in `organizations.settings.bookings` and seeds the automation rule "Send Interview Booking Link".
- **Status:** Rule is now ENABLED in production (owner flipped it on 2026-05-01). Completing the "Send Interview Link" task triggers an SMS with the booking URL.

### Step 3 v1 — Webhook architecture (PR #250, merged 2026-05-01)
- Created tables `caregiver_interviews` and `bookings_subscriptions` with multi-tenant RLS.
- New edge function `supabase/functions/bookings-webhook/`.
- **Failed in production immediately** — Microsoft Graph returned `Invalid 'changeType' attribute: 'created'`. Root cause: **Microsoft Graph does NOT support change-notification subscriptions for the `bookingAppointment` resource at all.** Multiple Microsoft Q&A threads confirm this. The error message was misleading; no `changeType` value would have worked.

### Step 3 v2 — Pivot to polling (PR #251, merged 2026-05-01)
- Migration `20260505010000` drops `bookings_subscriptions` (was empty), unschedules the dead daily renew cron, schedules new 5-minute polling cron.
- `bookings-integration` edge function got a new `poll_appointments` action; subscribe/renew/unsubscribe actions removed.
- `bookings-webhook` function deleted from the repo (and manually deleted from Supabase Functions dashboard).
- Pruned unused `parseGraphNotifications` helper + 5 tests.
- **End-to-end verified in production**: a real test booking ("Kevin Nash") was successfully mirrored — phone match, status `booked`, correct caregiver_id.

---

## Current production state

**Tables:**
- `caregiver_interviews` — local mirror of Bookings appointments. Multi-tenant: `org_id NOT NULL DEFAULT public.default_org_id()`, tenant-isolation RLS, service_role bypass. UNIQUE on `(org_id, graph_appointment_id)`. Indexed for upcoming/unmatched queries.

**Edge functions (auto-deployed via `.github/workflows/deploy-edge-functions.yml`):**
- `bookings-integration` — handles all Graph reads + `poll_appointments`.

**pg_cron jobs:**
- `poll-bookings-appointments` at `*/5 * * * *` — calls `bookings-integration` with `action: 'poll_appointments'`. Loops over every org with `settings.bookings.business_id` configured.

**Per-org config in `organizations.settings.bookings` (only TC populated today):**
```json
{
  "business_id":       "TremendousCareCaregiverInterviews@themedconnection.com",
  "service_id":        "63251fbe-3727-45d7-9be4-0d13619cf74d",
  "default_staff_id":  "81612be5-14ef-4b94-b059-73e310aad598",
  "public_url":        "https://outlook.office.com/book/TremendousCareCaregiverInterviews@themedconnection.com/"
}
```

**Automation rule:** "Send Interview Booking Link" — ENABLED. Trigger: `task_completed` with `task_id: send_interview_link`. Action: `send_sms`. Template: `Hi {{first_name}}! It's Tremendous Care. Thanks for your interest in becoming a caregiver. Please pick a time for your interview here: {{booking_url}}`.

---

## CRITICAL: do-not-undo context

### Microsoft Graph does NOT support webhooks for Bookings appointments

The polling-cron architecture is **the only viable design**, not a workaround that "should be replaced with webhooks later." Anyone trying to "fix" the architecture by going back to webhook subscriptions will fail with the same `Invalid 'changeType' attribute` error and waste time. This is a Microsoft platform limitation with no announced timeline for change.

If Microsoft adds support someday, the existing `caregiver_interviews` schema accommodates either source — but until then, **polling is correct and final**. See PR #251 description for the full investigation.

### Multi-tenancy is mandatory

CLAUDE.md prime directives apply:
- Every new table: `org_id` NOT NULL with `public.default_org_id()` default
- Every new query: org-scoped (either `WHERE org_id = ...` or RLS predicate)
- Every new secret: per-org lookup pattern (see `communication_routes` reference impl)
- No new hardcoded TC URLs, IDs, or branding — all configurable strings in `organizations.settings`

### Production safety rules

From `CLAUDE.md`:
1. Never push directly to `main` — feature branch + PR
2. Never merge a PR with failing CI
3. Never DROP tables or DELETE rows without explicit user approval
4. All schema changes are additive
5. Run `npm test` and `npm run build` before pushing
6. Write Vitest tests for any new utility / business logic function

---

## STEP 4 — UI card on caregiver detail (next up)

### Why
Right now the polling mirror works, but a recruiter has no UI to see whether a caregiver booked, when, with which staff member. They'd have to query SQL or check Outlook. Step 4 surfaces the booking state inline on the caregiver detail page.

### Scope
Add a compact "Interview" card to `CaregiverDetail.jsx`, **above** `PhaseDetail`. The card has five visible states, driven by the latest `caregiver_interviews` row for that caregiver:

| State | Trigger | UI |
|---|---|---|
| Not Sent | No "Send Interview Link" task completed | "Interview link not sent yet." Greyed-out card. |
| Link Sent (Xh ago) | Task completed but no row in `caregiver_interviews` | "Link sent {timeAgo}." [Resend] button (re-fires the automation). |
| Booked | Latest row `status = 'booked'` and `start_at >= now()` | "Booked: {date} at {time} with {staff_name}." [Reschedule] [Cancel] [Join Teams] (if `join_web_url`). |
| Cancelled | `status = 'cancelled'` | "Cancelled." [Resend] to send link again. |
| Completed | `start_at < now()` and `status` was `'booked'` | "Completed {timeAgo}." (Outcome capture is Phase 2 of context layer — not Step 4.) |

### Where to read data
```js
// Pattern: org-scoped, latest first
const { data } = await supabase
  .from('caregiver_interviews')
  .select('*')
  .eq('caregiver_id', caregiverId)
  .order('start_at', { ascending: false })
  .limit(1);
```
RLS will scope to current org automatically (Phase B in progress; new policy is `org_id = (auth.jwt() ->> 'org_id')::uuid`). For non-archived caregivers only.

### Staff name resolution
The row stores `staff_member_ids: text[]` (Graph staff IDs). To display "Daniela Hernandez" instead of `81612be5-...`:
- **Option A (simpler):** read `organizations.settings.bookings.default_staff_id` and only resolve that ID via a one-time `list_staff` Graph call cached client-side. Works for TC's single-staff setup.
- **Option B (right for multi-staff):** add a small `bookings_staff` cache table or an `organizations.settings.bookings.staff_directory` map. Defer until a second recruiter joins.

Recommendation: ship Option A in Step 4. Add a TODO for Option B when multi-staff is needed.

### Buttons
- **[Resend]** — re-fires the "Send Interview Booking Link" automation. Could call `execute-automation` directly with the rule_id, or expose a small new endpoint. Easiest: trigger by checking and unchecking the task (existing flow already fires the automation on task completion). Decide based on UX preferred by the team.
- **[Reschedule]** and **[Cancel]** — wire up in Step 5 (next section). For Step 4, just add the buttons disabled with a "Coming soon" tooltip, OR ship Step 5 in the same PR. **Recommended: ship Step 5 alongside Step 4** so the card is fully functional from day one.
- **[Join Teams]** — opens `join_web_url` in a new tab. Trivial.

### Files likely touched in Step 4
- `src/admin/CaregiverDetail.jsx` (or wherever the detail page lives — search for `<PhaseDetail` to find insertion point)
- New component: `src/admin/InterviewCard.jsx` (or similar)
- Possibly a new context provider if data needs to be shared with other tabs
- New Vitest test for any pure utility (e.g., a state-resolver that takes a caregiver row + interview row and returns one of the 5 states)

### Testing
- Unit test the state-resolver function (5 states × edge cases)
- Visual: book a test interview, see the card render. Cancel it, see status update within 5 minutes (or tighten the polling cadence temporarily for faster iteration).
- Verify on a caregiver with no interview record (should show "Not Sent" or "Link Sent" cleanly).

---

## STEP 5 — In-app cancel/reschedule

### Why
Step 4 surfaces booking state. Step 5 lets the recruiter act on it without leaving the portal. Cancellations push through to Microsoft, which emails the caregiver — single source of truth stays Microsoft.

### Scope
Two new actions in `bookings-integration/index.ts`:

**`cancel_appointment`** — body: `{business_id, appointment_id, cancellation_message?}`. Calls Graph DELETE on `/solutions/bookingBusinesses/{bid}/appointments/{aid}` (or POST `/cancel` if the API requires it — check Graph docs). Returns success/error. The next 5-minute poll will reconcile the status flip; for instant UI feedback, optionally also fire an immediate poll for that org.

**`reschedule_appointment`** — body: `{business_id, appointment_id, start_iso, end_iso, time_zone}`. Calls Graph PATCH on the same path with the new `startDateTime`/`endDateTime` payload. Same reconciliation pattern.

### Frontend wiring
- [Cancel] button on the InterviewCard — opens a confirm modal with optional cancellation message → calls the new edge function action.
- [Reschedule] button — opens a date/time picker (or links to the public booking page with the existing `selfServiceAppointmentId`, which lets the caregiver reschedule themselves through the Bookings UI). Decide which UX feels right with the team.

### Optimistic UI
After a successful cancel/reschedule, the card should update immediately (optimistic) AND the next poll will confirm. If they disagree, trust the poll (Microsoft is source of truth).

### Testing
- Unit test the new action handlers (mocked Graph)
- Live test: book → cancel from app → verify Outlook reflects cancellation + caregiver receives email
- Live test: book → reschedule from app → verify both portal card and Outlook update

---

## Out of scope (deliberate; later phases)

These were called out in the original Step-1-2 handoff and remain out of scope for Steps 4 & 5:

- **Outcome capture** (passed/failed/no-show) feeding `action_outcomes` table. This is Phase 2 of the AI context layer (already partially built; see `CLAUDE.md` "Context Layer Architecture"). Belongs in a separate stream of work.
- **Multi-staff routing** — once a second recruiter joins TC, route bookings based on caregiver's region/skill/etc. Requires a routing-rules table.
- **Per-org Microsoft tenant credentials** — currently TC uses the single shared Azure AD app. When a second customer org onboards, they need their own Microsoft tenant and credentials. This lives in the SaaS retrofit Phase C (see `docs/SAAS_RETROFIT_STATUS.md`).

---

## Key IDs to keep handy

```
Supabase project:                       zocrnurvazyxdpyqimgj
Tremendous Care org_id:                 62fbaf9d-13ab-49f4-b92a-a774c67b69a6
Bookings business_id:                   TremendousCareCaregiverInterviews@themedconnection.com
Service ID (Caregiver Interview):       63251fbe-3727-45d7-9be4-0d13619cf74d
Staff ID (Daniela Hernandez):           81612be5-14ef-4b94-b059-73e310aad598
Public booking URL:                     https://outlook.office.com/book/TremendousCareCaregiverInterviews@themedconnection.com/
```

## Branch + PR conventions

The owner uses Claude Code on the web. Branches follow the pattern `claude/<descriptor>-<random>`. Recent merged PRs:
- #246 — Step 1 (read-only Graph)
- #248 — Step 2 (auto-send automation)
- #250 — Step 3 v1 (webhook — failed in prod)
- #251 — Step 3 v2 (pivot to polling — live and working)

When opening a new PR for Step 4/5, reference these for context.

## Code locations

- `supabase/functions/bookings-integration/index.ts` — the edge function (only one needed for Steps 4 & 5)
- `supabase/functions/_shared/helpers/bookings.ts` — pure helpers (matchCustomerToCaregiver, normalizeGraphAppointment, getBookingUrlFromOrgSettings, etc.)
- `supabase/migrations/20260504000000_bookings_step2_org_config_and_seed_rule.sql` — TC's per-org config + automation rule
- `supabase/migrations/20260505000000_bookings_step3_caregiver_interviews_and_subscriptions.sql` — created `caregiver_interviews`
- `supabase/migrations/20260505010000_bookings_step3_v2_pivot_to_polling.sql` — dropped subscriptions table, scheduled poll cron
- `src/lib/__tests__/bookingsHelper.test.js` — 32 tests on the helpers
- `src/admin/CaregiverDetail.jsx` (or wherever it currently lives — Step 4 will edit this)

## Deploy mechanics

- **Edge functions**: auto-deploy on merge to `main` via `.github/workflows/deploy-edge-functions.yml`. No manual CLI.
- **Database migrations**: manual `Deploy Database Migrations` GitHub Actions workflow — first with `dry_run=true` to confirm pending list, then `dry_run=false` to apply. Use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` so re-runs are idempotent.
- **Frontend**: auto-deploys to Vercel on merge to `main`. PRs get a preview deployment.

## Sanity-check SQL the new chat may want

```sql
-- Confirm cron is alive
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE '%booking%';

-- See latest mirrored bookings
SELECT graph_appointment_id, caregiver_id, match_method, status,
       customer_name, start_at, created_at
FROM caregiver_interviews
ORDER BY created_at DESC LIMIT 20;

-- See unmatched bookings (people who booked but aren't in the pipeline)
SELECT customer_name, customer_phone, customer_email, start_at, created_at
FROM caregiver_interviews
WHERE caregiver_id IS NULL
ORDER BY created_at DESC LIMIT 20;

-- Confirm per-org config is set
SELECT slug, settings -> 'bookings' AS bookings_config
FROM organizations
WHERE settings -> 'bookings' IS NOT NULL;
```

---

## What the new chat should do first

1. Read `CLAUDE.md` and `docs/SAAS_RETROFIT_STATUS.md` to absorb the prime directives and current retrofit phase.
2. Skim PRs #246, #248, #250, #251 in order to understand the architecture and the v1→v2 pivot story.
3. Run `git pull origin main` then `git checkout -b claude/<descriptor>-<random>`.
4. Confirm tests pass on main with `npm test` and `npm run build` before adding anything.
5. Propose the Step 4 + Step 5 plan to the owner before writing code (the owner prefers discussion over surprise — see CLAUDE.md "Production Safety Rules").
6. Ship Step 4 + Step 5 as a single PR if scoped tightly, or as two PRs (Step 4 first, Step 5 immediately after) if it gets large.

Welcome to the project. The pipe is full and the data is flowing — just need the UI.
