# Paychex Phase 4 — Handoff

**Created:** 2026-04-27
**Author:** previous Claude session
**For:** the next Claude session that picks up Phase 4
**Phase:** 4 — Approval UI and CSV export

This doc exists so Phase 4 can start in a fresh context window without re-litigating decisions made across the 100+ messages that produced Phases 0–3. **Read it top to bottom before writing any code.** Then read the files in "Files to read first" below.

---

## Status

- **Phases 0, 1, 2, 3 shipped.** PRs #207, #211, #212, #216, all merged to `main`.
- **Phase 3 cron auto-fired 2026-04-27 at 13:00 UTC** and produced its first real drafts unprompted. Engine math verified by hand against $520.40 gross. Bake period started.
- **Phase 4 not started.** This is what you're picking up.
- **Phase 5 is gated on Paychex enabling the Payroll & Check API scope** — not on the critical path. Phase 4's CSV export delivers full operational value without it.
- **Phase 2 real worker writes are blocked on Paychex enabling the worker WRITE entitlement.** Same Paychex-rep-side blocker as Phase 5. Does NOT block Phase 4 — Phase 4 doesn't call Paychex.

## Files to read first, in order

1. `CLAUDE.md` (repo root) — production safety rules + multi-tenancy directives.
2. `docs/plans/2026-04-25-paychex-integration-plan.md` — the durable Paychex plan. Especially "Decisions locked", "Phase 3 results", "Phase 4 — Approval UI and CSV export", "Cross-cutting reliability practices", "Anti-patterns".
3. `docs/SAAS_RETROFIT.md` + `docs/SAAS_RETROFIT_STATUS.md` — multi-tenancy retrofit status. Phase B (org_id on every table) is in progress. Phase 4's new tables / queries must respect this.
4. `src/lib/payroll/` — pure functions shipped in Phase 3 (`constants.js`, `overtimeRules.js`, `timesheetBuilder.js`, `exceptions.js`, `__tests__/`). Phase 4 imports from these and ADDS `csvExport.js`.
5. `supabase/functions/payroll-generate-timesheets/index.ts` — Phase 3 cron, the source of the data Phase 4 surfaces.
6. `supabase/functions/_shared/paychex.ts` + `supabase/functions/paychex-sync-worker/index.ts` — Phase 2 conventions to mirror (CORS allowlist, jsonResponse helper, JWT-derived org_id, per-call audit logging).
7. `supabase/migrations/20260425170000_*` through `20260426000000_payroll_generate_timesheets_cron.sql` — the payroll data model.
8. `src/AdminApp.jsx` (route registration) and `src/shared/layout/AppShell.jsx` + `src/shared/layout/Sidebar.jsx` (sidebar conventions) — for adding the Accounting nav.

## Confirmed decisions (do not re-litigate)

These were resolved across the 2026-04-25 → 2026-04-27 conversations with the owner. They are locked.

### Paychex SPI file format (resolved 2026-04-27)

Phase 4's CSV export targets the **Paychex Flex "Hours Only Flexible"** template (one of several SPI templates). Confirmed by the owner via download from Paychex Flex Payroll Center → Import payroll data → Files → Download template.

**File format:** `.csv`, max 15 MB, filename < 151 chars.

**Six columns, in this order:**

| Column | Max | Format | TC value |
|---|---|---|---|
| `Company ID` | 8 | alphanumeric | `70125496` (TC's Paychex company number; lives in `organizations.settings.paychex.display_id`) |
| `Worker ID` | 10 | alphanumeric | TC uses **short integers** like `54`, `67`, `52`. **NOT the long Paychex `workerId` we currently store.** This is Paychex's `employeeId` field — a per-company small integer. We don't have it in our DB yet (Phase 4 PR #1 captures it). |
| `Pay Component` | 20 | alphanumeric | Earning name. **Case-sensitive — must match an Earning configured in TC's Paychex.** TC has: `Hourly`, `Overtime`, `Mileage`. Doubletime not yet configured. |
| `Hours` | 7 | numeric -999.99 to 999.99 | Hours for this row (or miles, for the Mileage row) |
| `Rate` | 9 | numeric 0.0001 to 99999999.9999 | Hourly rate for this row. **Pre-multiplied for OT/DT** (see below). |
| `Rate #` | 2 | alphanumeric 1–25 or `M` | Skip / leave blank — only used if a worker has 5+ predefined rates configured in Paychex. TC doesn't. |

**One earning per row.** A caregiver with regular + OT + mileage in a week becomes 3 rows for that caregiver in the CSV. Same `Worker ID`, different `Pay Component` per row. The `Check Sequence Number` field doesn't exist in Hours Only — Paychex groups rows into a single check by `Worker ID` + `Pay Component`, and TC has only one check per caregiver per pay period, so no sequencing is needed.

**Rate convention (verified against an actual TC paystub):** Paychex does NOT auto-apply OT/DT premium multipliers. The rate column is the literal `$/hr` to multiply by `Hours`. So:
- Regular row: `Rate = base_hourly_rate`
- Overtime row: `Rate = base_hourly_rate × 1.5`
- Doubletime row: `Rate = base_hourly_rate × 2`
- Mileage row: `Rate = $0.725` (the IRS-aligned rate; lives in `organizations.settings.payroll.mileage_rate`), `Hours = miles_driven`

This mirrors what TC's back office currently types into Paychex by hand, so behavior is unchanged.

### TC's Paychex Pay Components (resolved 2026-04-27)

| Earning | TC's exact name | Paychex Component Type | Configured? |
|---|---|---|---|
| Regular hours | `Hourly` | regular wages, taxable | Yes (existing) |
| Overtime hours | `Overtime` | regular wages, taxable | Yes (existing) |
| Doubletime hours | (not configured) | would be regular wages, taxable | **No** — owner deferred. Engine produces DT hours rarely (only on shifts >12h or 7th consecutive day). When it does, Phase 4 must block the timesheet with `dt_pay_component_missing` until the owner either (a) adds a DT earning in Paychex Flex Settings → Earnings and tells us the name, or (b) zeroes out the DT hours via inline edit. |
| Mileage reimbursement | `Mileage` | `Exp Reimb Non Tax` | Yes — owner created 2026-04-27, Amount $0, Custom Name `Mileage`. The earning's calc type is "Flat dollar amount / Every Pay Period" (Paychex didn't allow changing it on Exp Reimb), but our SPI import overrides per-row. We'll verify the override works on the first real export — if Paychex auto-applies $0/period to everyone with the earning assigned, that's a no-op. If it auto-applies to caregivers who don't have it explicitly assigned, we may need a tweak. |

**Where these strings live in code:** Phase 4 PR #1 stores them in `organizations.settings.payroll.pay_components`:

```jsonc
{
  "pay_components": {
    "regular": "Hourly",
    "overtime": "Overtime",
    "double_time": null,        // null until owner configures + provides
    "mileage": "Mileage"
  }
}
```

The CSV export reads them from there. No hardcoded strings in source.

### Worker ID — data model gap to close in Phase 4 PR #1

We currently store Paychex's **long** workerId (e.g. `00H2A1IUK695XL45NDO6`) in `caregivers.paychex_worker_id`, set by Phase 2's sync function on a successful POST. The SPI CSV needs Paychex's **short** employeeId (e.g. `54`, `67`).

Add column `caregivers.paychex_employee_id text` (additive, nullable). Backfill via `GET /companies/{companyId}/workers` — Paychex returns both `workerId` (long) and `employeeId` (short) in the response. Match on `workerCorrelationId` (which equals our `caregivers.id` from Phase 2's mapping). The `_shared/paychex.ts` client already supports the call.

Note: as of 2026-04-27 only the test caregiver has been synced for real (Paychex worker WRITE entitlement is still gated on Paychex's backend). The backfill function will populate IDs for whatever subset we've actually synced. Once the entitlement lands and the back office syncs the rest, the same backfill helper handles them.

### Per-shift rates — deferred to Phase 4

The owner explicitly asked for this and it's the right call. Phase 3's timesheet builder uses a single "modal rate" per caregiver per week and blocks via `rate_mismatch` when shifts differ. Phase 4 should:

- Allow each shift to carry its own `hourly_rate`.
- Compute gross pay per-shift at that shift's rate × that shift's hours-classification multiplier (1.0 for reg, 1.5 for OT, 2.0 for DT).
- For OT premiums, CA labor law requires using the **weighted-average regular rate of pay** when rates vary across the workweek. Implement this in `overtimeRules.js` as a new `computeRegularRateOfPay(byShiftWithRates)` helper, used only when distinct rates are detected. When all rates are equal, the math simplifies to the current single-rate calculation.
- Drop the `rate_mismatch` blocker in `exceptions.js` once per-shift rates are wired.
- The CSV export then emits one Hourly row per distinct rate per worker (e.g. a caregiver with 8h @ $20 and 16h @ $22 in regular hours produces two `Hourly` rows: one with `Hours=8, Rate=20`, one with `Hours=16, Rate=22`). Paychex sums them into one check.

**This is the largest single piece of new logic in Phase 4.** Test it heavily — the weighted-average regular rate is a place where labor-law correctness matters and small bugs become wage-theft claims.

### What's NOT in Phase 4

- **Email notification cron** — owner said skip; revisit when asked. Plan calls for Mondays 7 AM PT email when drafts exist; not on the critical path because the back office checks the dashboard regularly.
- **Direct API submission to Paychex** — that's Phase 5, gated on Paychex Payroll & Check API scope. Phase 4's "Submit Run" generates a CSV and the back office uploads it manually. Phase 5 graduates "upload manually" to "submit via API."
- **W-2 / I-9 / direct deposit onboarding** — that's Phase 6.

## Phase 4 PR breakdown (recommended)

The plan estimates Phase 4 as 4 days as one PR. Owner agreed in 2026-04-27 conversation that **smaller PRs are safer for production and easier to review**. Three PRs proposed:

### PR #1 — Backend foundation + read-only This Week view

**Migrations:**
- `caregivers.paychex_employee_id text` (additive, nullable)
- Seed `organizations.settings.payroll.pay_components` for TC: `{ regular: "Hourly", overtime: "Overtime", double_time: null, mileage: "Mileage" }`

**Pure functions + tests:**
- `src/lib/payroll/csvExport.js` — `(timesheets[], orgSettings) → CSV string` in SPI Hours Only format. Tested in `__tests__/csvExport.test.js` against a hand-constructed expected output. Cover: single caregiver clean week, multi-row caregiver (reg + OT + mileage), per-shift-rate split (one Hourly row per distinct rate), null/undefined Pay Component handling (skip Mileage row when org hasn't configured the code; skip DT row but flag), CSV escaping for names with commas/quotes (probably won't happen — Worker ID is numeric — but defensive).
- Update `src/lib/payroll/exceptions.js`: add `dt_pay_component_missing` block code, fired when timesheet has DT hours > 0 AND `orgSettings.payroll.pay_components.double_time` is null/missing. Also add `caregiver_missing_paychex_employee_id` block code, fired when caregiver has timesheet but `paychex_employee_id` is null (we can't generate a CSV row without the short ID).
- Update `src/lib/payroll/timesheetBuilder.js` per-shift-rate logic if you tackle it in PR #1. Otherwise defer to PR #2 and keep the current modal-rate behavior — your call. The owner has only ~2 caregivers with shifts each week right now, so the rate_mismatch blocker isn't a daily pain point yet.

**Edge function:**
- `supabase/functions/paychex-backfill-employee-ids/index.ts` — service-role helper. Calls `GET /companies/{companyId}/workers` (paginated), matches on `workerCorrelationId`, populates `caregivers.paychex_employee_id` for any caregiver where the column is null and a match is found. Idempotent; safe to re-run. Owner invokes once after merge, then automatically as new caregivers sync.

**UI (read-only):**
- New top-level sidebar entry `Accounting` in `AppShell.jsx`, gated on `features_enabled.payroll === true` AND user role admin OR member.
  - **AppContext gap:** `currentOrgSettings` isn't currently exposed. Add it. Load alongside the existing role lookup in `handleUserReady`. Cache it; refresh on a manual hook if Settings changes it (Phase 4 PR #3 will add Settings UI).
- New route `/accounting` rendering `src/features/accounting/AccountingPage.jsx`. Sub-tab routing inside the page (segmented control), Payroll active by default. `AccountingPage` is a thin wrapper; the meat is `PayrollTab.jsx`.
- `src/features/accounting/payroll/ThisWeekView.jsx` — read-only timesheet table for the current pay period. Columns: caregiver name + employee ID, hours (Reg / OT / DT), mileage, gross pay, status badge, exception badges. Row expands to show the underlying shifts (clock-in/out times, geofence pass, hourly rate, mileage). NO inline edits and NO approve buttons in PR #1 — that's PR #2.
- `src/features/accounting/payroll/ExceptionBadge.jsx` — visual badge component, red for `block`, yellow for `warn`, with hover tooltip showing the exception message.
- `src/features/accounting/payroll/TimesheetRow.jsx` — single-row component used by the table.
- Module CSS files for each. Match the project's existing `*.module.css` conventions (see `src/features/scheduling/SchedulePage.module.css` for an example of similar table-heavy layout).
- Sticky footer with running totals: caregiver count, total hours, total gross. Important UX — money totals are the most prominent element on every payroll screen per the plan.
- Empty-state, single-caregiver, and 50+-caregiver render must be acceptable. The 55-caregiver case will be reality once Paychex unlocks worker WRITE.

**Phase 4 PR #1 tests:**
- `csvExport.test.js` — see above.
- `exceptions.test.js` — extend with cases for the new `dt_pay_component_missing` and `caregiver_missing_paychex_employee_id` codes.
- A smoke test for the read-only ThisWeekView would be nice but the project's existing UI tests are limited; pure-function coverage is the priority.

**PR #1 exit criteria:**
- All migrations applied cleanly.
- Backfill function populates `paychex_employee_id` for the test caregiver.
- 92+ existing payroll tests still pass; new csvExport + exceptions tests pass; `npm run build` clean.
- Back office can navigate to Accounting → Payroll → This Week and see the same drafts the SQL queries from Phase 3 surface.

**PR #1 rollback:**
- Down migration drops `paychex_employee_id` and reverts the seed (jsonb subtraction).
- Hide the Accounting sidebar entry behind a feature flag override.
- Edge function deletion via Supabase Dashboard.

### PR #2 — Edits + approval + Generate Run + CSV export

**UI:**
- Inline hour / rate / mileage edits on `ThisWeekView`, with a required reason text field. Logs `timesheet_adjusted` event on save.
- "Regenerate" button per row that triggers the cron's logic for that single caregiver / week (DELETE the existing timesheet + re-run the builder). Solves the current DELETE-then-rerun pain point.
- Per-row "Approve" button (gated on no `block`-severity exceptions).
- Bulk "Approve All Clean" button.
- "Generate Payroll Run" button at the top of `ThisWeekView`. Batches all approved timesheets for the period into a `payroll_runs` row in `draft` status. Opens a confirmation modal with caregiver count, total hours, total gross, and a **dollar-typed confirmation field** (user types the gross total to confirm). Modal header shows `PRODUCTION` or `DRY-RUN` indicator (read from env / org setting).

**Backend:**
- `supabase/functions/payroll-export-run/index.ts` — receives a list of approved timesheet IDs, validates they all belong to the caller's org, generates the CSV via `csvExport.js`, uploads to Supabase Storage, marks the `payroll_runs` row + member timesheets as `exported`, writes `payroll_run_submitted` event. Returns a short-lived signed URL the frontend uses to trigger the download.
- New API surface for the inline edits on `timesheets` and `shifts` (the existing edit paths if they exist; otherwise add a small RPC or edit endpoint).

**Tests:**
- Approval state-machine transitions.
- "Generate Run" rejects mixed-org timesheet lists (cross-tenant guard test).
- CSV export upload + signed URL retrieval round-trip.

### PR #3 — Payroll Runs view + Mark as Paid + Settings

**UI:**
- `src/features/accounting/payroll/PayrollRunsView.jsx` — historical batches sorted by `pay_date` desc. Per-run detail view shows the constituent timesheets, links to `paychex_api_log` (when Phase 5 lands), error details if any. Action buttons: Download CSV (re-generate from existing timesheet IDs), Mark as Paid in Paychex, View in Paychex (deep-link to Flex if available).
- "Mark as Paid in Paychex" flow: confirmation modal → flips the `payroll_runs` row to `completed`, all member timesheets to `paid`, writes `payroll_run_completed` event with the date the user marked it paid.
- `src/features/accounting/payroll/PayrollSettingsView.jsx` — payroll configuration UI for the current org. Connection status (Paychex Worker API: connected / Payroll API: pending). Pay period config (frequency / end day / pay day) — read/write with confirmation. Default mileage rate — read/write. **Pay Component code editor** — owner can update the strings without a deploy if they ever rename an earning in Paychex. OT jurisdiction (read-only `CA` in v1). Timezone (read-only `LA` in v1).

**Backend:**
- Settings persistence: an RPC or edge function that updates `organizations.settings` jsonb safely (jsonb merge, audit event on change). Restrict to `admin` role only.

**PR #3 exit criteria:**
- Back office can complete a full pay cycle end-to-end on a Vercel preview deploy: review → approve → generate run → download CSV → manually upload to Paychex → mark as paid.
- One real production cycle by the back office (probably the cycle starting Monday after PR #3 merges).

## Gotchas / things you might miss

- **`AppContext` doesn't currently expose `currentOrgSettings`.** It exposes `currentOrgId`, `currentOrgSlug`, `currentOrgRole`. Add a `currentOrgSettings` accessor and load it in `handleUserReady`. Several Phase 4 components need it (sidebar gate, mileage rate display, Pay Component lookup for CSV export, etc.).
- **The cron is registered as pg_cron job `payroll-generate-timesheets`** — schedule `0 13 * * 1`. Don't accidentally re-register it. CLAUDE.md tracks all pg_cron jobs.
- **Worker ID column on the SPI is 10 chars max.** TC's are 2-digit integers, no risk. But if you ever extend this to other orgs, that's the cap.
- **Paychex's "Mileage" earning was set up with Calculation Type = "Flat dollar amount" and Frequency = "Every Pay Period"** because their UI didn't offer a per-unit option for `Exp Reimb Non Tax`. The owner saved Amount=$0 to neutralize the auto-application. We **expect** the SPI import to override per-row when we send `Pay Component=Mileage, Hours=miles, Rate=0.725`. If the first real export reveals that Paychex applies $0 to every assigned worker IN ADDITION TO our import (as opposed to just our import), we'll need to either (a) not assign the Mileage earning to caregivers at the company level, or (b) work with Paychex support to change the calc type. Document this in the PR description and watch the first real export.
- **CA weighted-average regular rate of pay** is non-trivial. The formula is: `regular_rate = total_straight_time_pay / total_non_OT_hours_worked` for the workweek. Then OT premium = `0.5 × regular_rate × OT_hours` and DT premium = `1.0 × regular_rate × DT_hours`. Most online calculators get this wrong; cross-reference DLSE Opinion Letter 2002.12.09-2 if in doubt.
- **`now()` cannot be used in partial index predicates** (CLAUDE.md note). Filter at query time instead.
- **No emojis in code, comments, UI strings, or docs** per the plan's locked decisions.
- **Don't add new env vars for tenant-sensitive integrations.** PAYCHEX_CLIENT_ID/SECRET are partner-level env vars (allowed exception). Anything else org-specific lives in `organizations.settings`.

## Production data quality issues observed during Phase 3

These are real TC data issues that Phase 4's UI must surface and let the back office fix:

1. **Some shifts have `hourly_rate = NULL`.** Caregivers `9ef3d469…` had no rates set. Phase 4 inline rate-edit on ThisWeekView solves this. Until rates are set, gross_pay computes to $0 (engine is correct; data is incomplete).
2. **Some completed shifts have no clock-out events.** Caregiver `ac335ae3…` had two such shifts in the week of 2026-04-20. The engine fell back to scheduled end times and flagged `missing_clock_out`. Phase 4 needs:
   - An inline "Use scheduled end" affirmation that clears the block without forcing a clock_event insert.
   - Option to manually enter actual clock-out time (creates a `clock_events` row with a "manually entered by Jessica at <date>" annotation).
3. **Caregivers with multiple distinct hourly rates within a single workweek.** Phase 3 blocks via `rate_mismatch`. Phase 4's per-shift rate support solves this; remove the `rate_mismatch` blocker once that lands.

## Multi-tenancy checklist (apply to every Phase 4 PR)

Per `.github/pull_request_template.md`:

- All new tables have `org_id uuid REFERENCES organizations(id)` from creation, with RLS — N/A for Phase 4 PRs that don't add tables, but `payroll_runs` already exists with org_id (Phase 1).
- Any new query is org-scoped (explicit `WHERE org_id = ...` or RLS). Frontend reads should filter by `currentOrgId`.
- Any new edge function reads `org_id` from JWT or explicit parameter. Pattern from `paychex-sync-worker`: decode JWT directly to get `org_id` claim, then verify with `auth.getUser()`.
- Any new event in `events` table includes `org_id` and the entity's primary id as top-level payload keys (Phase B backfill recipe).
- No new env vars for tenant-sensitive integrations.
- No new hardcoded TC strings, URLs, or branding.
- Rollback plan in every PR description.

## Verification after each PR merges

1. `Deploy Edge Functions` workflow runs cleanly and the new function is invokable.
2. If migrations: `Deploy Database Migrations` workflow with `dry_run=true` first, then apply. Always.
3. PR #1: backfill runs, `caregivers.paychex_employee_id` populates for the test caregiver. ThisWeekView renders the existing drafts.
4. PR #2: full review → approve → generate run → download CSV flow works on Vercel preview. Owner spot-checks the generated CSV against a hand-built expected output for one cycle. **Critical:** before owner uses the CSV in real Paychex, confirm one row by hand that the import wouldn't produce an unexpected charge.
5. PR #3: owner runs one full real production cycle. After two clean cycles, the doc graduates to `docs/runbooks/payroll-runbook.md`.

## Open questions for owner before PR #3 (not blocking PR #1/#2)

- **CSV format mileage row behavior in production.** Do we need to update the Mileage earning's calculation type via Paychex support before we can rely on per-row override?
- **Settings UI for "Mark as Paid":** does the owner want a date picker (to enter the actual Paychex pay date) or auto-set to today? Default to today with override.
- **Notification cron:** if/when the owner wants the Monday "drafts ready" email, who's the recipient list? Plan default = all admin + member role users in the org.

## Don't redo this work

- The OT engine, timesheet builder, exception detector, and cron edge function are all shipped and verified. Do not rewrite them.
- The Paychex SPI column investigation is complete; do not ask the owner to re-confirm the format.
- The Pay Component strings (`Hourly`, `Overtime`, `Mileage`) are confirmed; do not ask the owner to re-confirm them.
- The Worker ID format (short integer) is confirmed; do not ask the owner.
- The mileage rate ($0.725/mi) and timezone (`America/Los_Angeles`) are in `organizations.settings` already; do not hardcode.
- `paychex-sync-worker` dry-run polish shipped in PR #216; don't re-touch unless the owner asks.

## Branch + PR conventions

- **Branch off latest `main` after this handoff doc PR merges.** Don't fork off the handoff branch.
- Branch name: `claude/paychex-phase-4-pr1` (or `-pr2`, `-pr3`). Or whatever the project's branch-naming pattern is — CLAUDE.md may specify.
- `npm test && npm run build` before pushing.
- Multi-tenancy checklist filled in PR description.
- Subscribe to PR activity after opening; address Codex review comments before requesting merge.
- Owner non-technical — give explicit click-by-click verification steps in PR description's test plan.

---

That's everything. Good luck — Phase 4 is the biggest single piece of UI work in the integration but the backend is solid and the format details are nailed down. The hard part is just writing it cleanly.
