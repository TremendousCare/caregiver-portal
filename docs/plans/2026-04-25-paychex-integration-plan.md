# Paychex Flex Payroll Integration — Implementation Plan

**Date:** 2026-04-25
**Branch:** `claude/integrate-paychex-payroll-W2tQj`
**Related docs:** `docs/SAAS_RETROFIT.md`, `docs/SAAS_RETROFIT_STATUS.md`, `CLAUDE.md`
**Status:** Planning. No code written yet.

---

## Purpose

This document is the durable plan for adding Paychex Flex payroll processing to the Tremendous Care caregiver portal. It exists so any contributor — human or AI — opening the repo can pick up the work without reconstructing context from chat history.

The integration is being built **after** the SaaS retrofit's Phase A shipped (PR #186). All new tables, queries, secrets, and configuration in this plan respect the six prime directives in `CLAUDE.md`. If you have not read `CLAUDE.md` and `docs/SAAS_RETROFIT.md`, read those first.

## Vision in one paragraph

A back-office user opens the Accounting section every Monday morning, reviews the prior week's timesheets generated automatically from `shifts` and `clock_events`, resolves any flagged exceptions, previews the submission, and clicks one button to push the payroll run to Paychex Flex. Caregivers are paid Friday. The owner never logs into Paychex unless investigating an exception. The system is multi-org-ready from the first migration — Tremendous Care is org #1, but every table, query, and secret is structured so a future agency can be onboarded by inserting an `organizations` row, populating `organizations.settings.paychex`, and storing per-org credentials, with no code changes required.

## Status of Paychex access

Confirmed by screenshots from the owner on 2026-04-25:

- The portal app is registered inside Paychex Flex App Hub under company **Tremendous Care, ID 70125496**, status **Connected**. This is the Flex In-App API path, not `developer.paychex.com`. It is production, not sandbox.
- **Company and Worker APIs**: enabled with **Read and Write** scope (GET, POST, PATCH, DELETE). Sufficient to read/create/update/delete worker records.
- **Payroll and Check APIs**: NOT enabled. The portal shows "Need Access? Your Paychex representative can help." This scope is required for Phase 5 (payroll submission).

There is **no separate sandbox**. All worker writes hit real production data. Mitigation: the first synced caregiver is a designated test record ("Test Caregiver — Do Not Pay") and a `PAYCHEX_DRY_RUN` environment flag intercepts writes during development.

The owner is contacting Paychex to enable the Payroll and Check API scope. This unblocks Phase 5 only; Phases 0–4 and 6 do not depend on it.

## Decisions locked

- **Worker classification**: W-2 employees only at launch. No 1099 contractor flow.
- **Pay period**: weekly. Specific day-of-week boundaries to be set per org in `organizations.settings.paychex.pay_period`. Tremendous Care defaults: Sunday end-of-day cutoff, Friday pay date.
- **Overtime jurisdiction at launch**: California rules (daily >8h at 1.5x, daily >12h at 2x, weekly >40h at 1.5x, 7th consecutive day rules). Future orgs may need other states; the OT engine takes a jurisdiction parameter from day one even though only `CA` is implemented in v1.
- **Timezone for OT day boundaries**: `America/Los_Angeles`. Stored as a single constant in `src/lib/payroll/constants.js`. Future orgs that operate in other timezones will read this from `organizations.settings.timezone`.
- **Mileage**: tracked per-shift on `shifts.mileage`. Reimbursed as a non-taxable line item in Paychex (separate from wages). Rate stored in `organizations.settings.payroll.mileage_rate`. IRS 2026 standard rate ($0.70/mi) is the Tremendous Care default.
- **Tax data storage**: all sensitive PII (SSN, bank account, W-4 elections) is sent directly to Paychex and **never stored locally**. The portal stores only `paychex_worker_id` and onboarding completion timestamps.
- **Approval workflow**: every timesheet must be approved by a user with role `admin` or `member` (back-office) before it can be included in a payroll run. Caregivers themselves cannot approve their own timesheets.
- **Submission gating**: a payroll run cannot be submitted within 2 hours of the Paychex submission cutoff for that pay date. Hard block with a clear UI message.
- **Sidebar placement**: a new top-level `Accounting` nav item with `Payroll` as a sub-tab inside the Accounting page. Future tabs: `Invoicing`, `Expenses`, `Reports`. Gated behind `organizations.settings.features_enabled.payroll === true`.
- **No emojis** in any payroll UI strings, code comments, or documentation.

## Decisions still open

- **Per-org credential storage mechanism**: SAAS_RETROFIT.md Phase C lists "Vault entries vs dedicated `org_secrets` table" as still-open. This integration will pioneer the pattern. The proposal in this doc (a `getOrgSecret(orgId, secretName)` abstraction with env-var fallback gated to TC during transition) needs owner approval before Phase 1 starts.
- **Multi-state expansion timing**: when do we add OT rules for other US states? Defer until the second org with non-CA caregivers is signing.
- **Off-cycle payroll** (bonuses, corrections, terminations mid-period): out of scope for v1. Manual via Paychex UI. Add to v2 backlog.
- **Year-end W-2 generation**: handled automatically by Paychex once workers are synced. No work required from us; document in the runbook.
- **Caregiver-facing pay stub view**: Paychex provides employee self-service. Out of scope for v1 unless owner wants pay stubs surfaced inside the caregiver PWA.

## Architecture — multi-org from day one

### Where the Paychex company ID lives

`organizations.settings.paychex.company_id` (jsonb). Tremendous Care's row gets `"70125496"` set by a one-line UPDATE in the seed migration. Code reads it via the standard `useOrgSettings()` hook on the frontend or by selecting `organizations.settings -> 'paychex'` in edge functions. **Never hardcoded in source.**

Display string also stored: `organizations.settings.paychex.company_display`. For TC: `"70125496 - Tremendous Care"`. Used in the admin UI ("Connected to Paychex Flex Company: ...").

### Where Paychex API credentials live

The retrofit plan defers the Vault-vs-dedicated-table decision to Phase C kickoff. Paychex pioneers the pattern.

Proposed abstraction: a single helper `getOrgSecret(orgId, secretName)` in `supabase/functions/_shared/orgSecrets.ts`. During the transition for Tremendous Care, it reads from environment variables (`PAYCHEX_CLIENT_ID`, `PAYCHEX_CLIENT_SECRET`) gated on `org_id = (SELECT id FROM organizations WHERE slug = 'tremendous-care')`. For any other org, it queries Vault via an RPC (to be created in this work). When Phase C generalizes the pattern, the helper signature stays the same; only the implementation changes.

This means **no new env vars for tenant-sensitive data going forward**. The TC env vars are a transition allowance explicitly permitted by directive 4 in `CLAUDE.md`.

### How edge functions read org context

Every payroll edge function reads `org_id` from the JWT via the existing `getOrgClaims(session)` helper pattern (`src/lib/supabase.js`, server-side equivalent in `_shared`). Cron jobs that touch payroll iterate `organizations` first, then for each org with `features_enabled.payroll === true`, perform per-org work with that org's credentials and settings.

### RLS on new tables

Every new payroll table is born with row-level security. Predicate: `(auth.jwt() ->> 'org_id')::uuid = org_id`. Policies are defined in the migration that creates the table — not as a follow-up. New tables do not need the existing-table backfill dance Phase B uses.

### Events table integration

Every payroll-related action writes to the existing `events` table: `timesheet_generated`, `timesheet_approved`, `timesheet_adjusted`, `payroll_run_submitted`, `payroll_run_completed`, `payroll_run_failed`, `paychex_worker_synced`, `paychex_worker_sync_failed`. The `events` table does not yet have an `org_id` column (Phase B work). Events are written without org_id today; Phase B's backfill will populate from the entity reference. Acceptable.

### Paychex API client

`supabase/functions/_shared/paychex.ts` — single OAuth2 client used by every payroll edge function. Responsibilities:
- Token acquisition via client_credentials, cached in Deno KV until 5 minutes before expiry.
- Idempotency keys on every write (hash of payload + ISO date bucket).
- Retry with exponential backoff: 3 retries on 5xx or network errors at 2s, 4s, 8s. No retry on 4xx.
- Every call writes a row to `paychex_api_log` before the response returns to the caller.
- Honors `PAYCHEX_DRY_RUN` env flag — when true, write calls log the intended request to `paychex_api_log` with `dry_run = true` and return a synthetic success response without contacting Paychex.

### CA overtime rules

Pure functions in `src/lib/payroll/overtimeRules.js`. Signature: `classifyHours({ shifts, weekStart, jurisdiction, timezone })` returns `{ regular, overtime, doubleTime }` totals plus a per-shift breakdown. Jurisdiction parameter exists from day one. Only `CA` is implemented in v1; other values throw a clear error.

## Data model

All new tables get `org_id uuid REFERENCES public.organizations(id)` from creation, with RLS enforcing tenant isolation. Migration filenames follow the project convention `YYYYMMDDHHMMSS_description.sql`.

### Additions to existing tables

`caregivers` table (additive columns, all nullable):

| Column | Type | Purpose |
|---|---|---|
| `paychex_worker_id` | text | Paychex Worker ID once synced. Null until first sync. |
| `paychex_sync_status` | text | One of `not_started`, `pending`, `active`, `error`. Default `not_started`. |
| `paychex_last_synced_at` | timestamptz | Timestamp of last successful sync. |
| `paychex_sync_error` | text | Last error message. Cleared on successful sync. |
| `w4_completed_at` | timestamptz | Timestamp when W-4 was filed in Paychex. |
| `i9_completed_at` | timestamptz | Timestamp when I-9 was completed. |
| `direct_deposit_completed_at` | timestamptz | Timestamp when direct deposit was set up. |

These three onboarding timestamps are flags only. The actual W-4 / I-9 / bank data lives in Paychex.

### New tables

**`timesheets`** — one per caregiver per pay period. Source of truth for what gets paid.

Key columns: `id uuid PK`, `org_id uuid NOT NULL REFERENCES organizations(id)`, `caregiver_id text REFERENCES caregivers(id)`, `pay_period_start date`, `pay_period_end date`, `status text` (one of `draft | pending_approval | approved | submitted | paid | rejected | blocked`), `regular_hours numeric(6,2)`, `overtime_hours numeric(6,2)`, `double_time_hours numeric(6,2)`, `mileage_total numeric(8,2)`, `mileage_reimbursement numeric(10,2)`, `gross_pay numeric(10,2)`, `approved_by text`, `approved_at timestamptz`, `submitted_at timestamptz`, `paychex_check_id text`, `block_reason text` (when status = blocked), `notes text`, `created_at timestamptz`. UNIQUE constraint on `(caregiver_id, pay_period_start)`.

**`timesheet_shifts`** — junction table linking timesheets to the shifts they cover, with the per-shift hour classification.

Key columns: `timesheet_id uuid REFERENCES timesheets(id) ON DELETE CASCADE`, `shift_id uuid REFERENCES shifts(id)`, `hours_worked numeric(5,2)`, `hour_classification text` (one of `regular | overtime | double_time`), `mileage numeric(6,2)`, PRIMARY KEY `(timesheet_id, shift_id)`. Inherits org isolation via the parent timesheet's RLS.

**`payroll_runs`** — a batch of timesheets submitted together to Paychex.

Key columns: `id uuid PK`, `org_id uuid NOT NULL`, `pay_period_start date`, `pay_period_end date`, `pay_date date`, `status text` (one of `draft | submitted | processing | completed | failed`), `timesheet_count int`, `total_gross numeric(12,2)`, `total_mileage numeric(10,2)`, `paychex_payperiod_id text`, `submitted_by text`, `submitted_at timestamptz`, `completed_at timestamptz`, `error_details jsonb`, `created_at timestamptz`. UNIQUE constraint on `(org_id, pay_period_start, pay_date)` to prevent duplicate runs.

**`paychex_api_log`** — every Paychex API call, request, response, and outcome.

Key columns: `id uuid PK`, `org_id uuid NOT NULL`, `endpoint text`, `method text`, `request_body jsonb`, `response_status int`, `response_body jsonb`, `error text`, `idempotency_key text`, `dry_run boolean DEFAULT false`, `duration_ms int`, `created_at timestamptz`. Indexes on `idempotency_key` and `(org_id, created_at DESC)`.

### Updates to `organizations.settings`

The seed migration sets, for the Tremendous Care row only, a `paychex` object inside `settings`:

```jsonc
{
  "paychex": {
    "company_id": "70125496",
    "company_display": "70125496 - Tremendous Care",
    "pay_period": { "frequency": "weekly", "ends_on": "sunday", "pay_day": "friday" }
  },
  "payroll": {
    "mileage_rate": 0.70,
    "ot_jurisdiction": "CA",
    "timezone": "America/Los_Angeles"
  },
  "features_enabled": {
    "payroll": true
  }
}
```

The migration uses jsonb merge (`||`) so existing keys in `settings` are preserved.

## UI placement — Accounting and Payroll

### Sidebar

A new top-level nav item `Accounting` is added to `src/shared/layout/AppShell.jsx`. It lives below `Scheduling` and above `Boards`. Visibility gated on:
- User role is `admin` or `member` (not `caregiver`).
- `organizations.settings.features_enabled.payroll === true` (read from AppContext).

If both conditions fail, the item is not rendered. No route guard needed because the link is the only entry point.

### Page structure

Single route `/accounting` rendering an `AccountingPage` component with horizontal sub-tabs inside the page (not nested in the sidebar). Sub-tabs at launch:

- **Payroll** (active by default)

Future sub-tabs (out of scope for v1, listed so the structure makes sense): Invoicing, Expenses, Reports, Tax Documents.

### Payroll sub-tab

Three internal views, switched via segmented control at the top of the Payroll content area:

1. **This Week** — current pay period's draft and pending-approval timesheets.
   - Table: Caregiver, Hours (Regular / OT / DT), Mileage, Gross, Status, Exceptions.
   - Row expands to show the individual shifts feeding the timesheet, with clock-in/out times and geofence status pulled from `clock_events`.
   - Exception badges in red (blocking: missing clock-out, caregiver not in Paychex, rate mismatch) or yellow (warning: out-of-geofence, shift >16h).
   - Inline hour edits require a reason; logged as event `timesheet_adjusted`.
   - Per-row Approve and bulk Approve All Clean button.
   - Sticky footer with running totals: caregiver count, total hours, total gross.

2. **Payroll Runs** — historical batches.
   - List sorted by `pay_date` desc with status badge, total gross, submitted-by, submitted-at.
   - Click a row for the detail view: every timesheet in the batch, link to corresponding `paychex_api_log` entry, error details if `failed`.
   - Action buttons on the detail view: Download CSV, Retry (if failed), View in Paychex (deep link to Flex if available).

3. **Settings** — payroll configuration for the current org.
   - Connection status (Paychex Worker API: connected / Payroll API: pending or connected).
   - Pay period config (frequency, end day, pay day).
   - Default mileage rate.
   - OT jurisdiction (read-only `CA` in v1).
   - Timezone (read-only `America/Los_Angeles` in v1).

### Visual priorities

Money totals are the most prominent element on every screen. Exceptions surface to the top of lists, never buried. Submission requires a confirmation modal where the user types the dollar total to confirm — standard pattern for irreversible money operations. The environment indicator (production vs dry-run) is shown in the modal header in unmistakable color.

## Phased implementation

Each phase is independently shippable as its own PR. Each PR satisfies the multi-tenancy checklist in `.github/pull_request_template.md`. Each PR includes a rollback plan.

### Phase 0 — Verification (half day, no schema changes)

Goal: confirm the API keys actually work against the real Paychex Flex company, and surface any access issues before writing dependent code.

- New file: `supabase/functions/paychex-diagnostic/index.ts`. A throwaway-style edge function that authenticates with the existing keys, calls `GET /companies` and `GET /companies/{id}/workers?limit=5`, and returns a structured report (status codes, sample data, scope decoded from the OAuth token).
- Run via the Supabase Functions UI by the owner. Output captured for the project notes.
- No production data written. No schema changes.

Exit criteria: we can confirm we're talking to TC's real Paychex Flex company (not a sandbox or wrong account), Worker scope works for both read and write, and we know the exact JSON shape Paychex returns.

Rollback: delete the function. Nothing else depends on it.

### Phase 1 — Data model (1 day)

Goal: every payroll-related table exists with proper org isolation, RLS, and indexes. No application code reads or writes them yet.

Migrations:
- `YYYYMMDDHHMMSS_payroll_caregiver_columns.sql` — additive nullable columns on `caregivers`.
- `YYYYMMDDHHMMSS_create_timesheets.sql` — `timesheets` table with RLS.
- `YYYYMMDDHHMMSS_create_timesheet_shifts.sql` — junction table.
- `YYYYMMDDHHMMSS_create_payroll_runs.sql` — `payroll_runs` table with RLS.
- `YYYYMMDDHHMMSS_create_paychex_api_log.sql` — audit log table with RLS.
- `YYYYMMDDHHMMSS_seed_tc_payroll_settings.sql` — UPDATE on `organizations` row to merge the `paychex`, `payroll`, and `features_enabled.payroll` settings.

Down scripts in `supabase/migrations/_rollback/` for every schema migration.

Exit criteria: all migrations apply cleanly to a dev branch of the database. RLS policies pass smoke test (a TC user can read their org's rows, a hypothetical second-org user cannot). `npm test` and `npm run build` both green.

Rollback: run the down scripts in reverse migration order. No existing tables modified, so nothing else regresses.

### Phase 2 — Paychex client and worker sync (2 days)

Goal: ship the Paychex API client. Sync caregivers to Paychex one at a time. Read-only impact on caregivers (mapping caregiver fields to Worker fields), one-way write to Paychex.

New files:
- `supabase/functions/_shared/paychex.ts` — OAuth2 client, idempotency, retries, structured logging to `paychex_api_log`. Honors `PAYCHEX_DRY_RUN`.
- `supabase/functions/_shared/orgSecrets.ts` — `getOrgSecret(orgId, secretName)` abstraction.
- `supabase/functions/paychex-sync-worker/index.ts` — given `caregiver_id`, upsert the Paychex Worker record. Reads org from JWT.
- `src/lib/paychex/workerMapping.js` — pure function: caregiver row → Paychex Worker payload.
- `src/lib/paychex/__tests__/workerMapping.test.js` — Vitest coverage.

UI: a dev-only sync button is **not** added to the caregiver detail view in this phase. Verification happens via direct edge function invocation. UI lives in Phase 6.

Exit criteria: a designated test caregiver can be synced to Paychex via the edge function. Sync status fields populate correctly. All API calls visible in `paychex_api_log`. Tests for the mapping function pass with ≥90% coverage of caregiver → worker transformations.

Rollback: revert the PR. The edge function ceases to exist; existing data is unchanged.

### Phase 3 — Timesheet generation and overtime engine (3 days)

Goal: roll up shifts into draft timesheets with correct CA OT classification. No UI yet.

New files:
- `src/lib/payroll/constants.js` — timezone, jurisdiction defaults.
- `src/lib/payroll/overtimeRules.js` — pure CA OT classification.
- `src/lib/payroll/timesheetBuilder.js` — given caregiver_id + week boundaries, build a draft timesheet from `shifts` + `clock_events`.
- `src/lib/payroll/exceptions.js` — exception detection (missing clock-out, geofence violations, rate mismatches, blocked-caregiver).
- `src/lib/payroll/__tests__/` — extensive Vitest coverage. Minimum 30 OT cases including: standard week, daily OT, weekly OT, 7th consecutive day, split shifts crossing midnight, daylight saving boundary, missing clock-out, rate change mid-period.
- `supabase/functions/payroll-generate-timesheets/index.ts` — weekly cron Monday 6 AM Pacific. Iterates orgs with `features_enabled.payroll === true`, then per-org generates draft timesheets for the prior week.

Exit criteria: cron runs and produces correct draft timesheets for real TC shift data over the prior 2-3 weeks. Owner spot-checks numbers. Tests passing. No payroll submission yet.

Rollback: disable the cron in Supabase. Drafts in `timesheets` can be ignored or marked `rejected` manually.

### Phase 4 — Approval UI (3 days)

Goal: the Accounting > Payroll page goes live. Back office can review, edit, and approve timesheets. No Paychex submission yet.

New files:
- `src/features/accounting/AccountingPage.jsx` — top-level page with sub-tab routing.
- `src/features/accounting/PayrollTab.jsx` — three-view payroll content.
- `src/features/accounting/payroll/ThisWeekView.jsx`
- `src/features/accounting/payroll/PayrollRunsView.jsx`
- `src/features/accounting/payroll/PayrollSettingsView.jsx`
- `src/features/accounting/payroll/TimesheetRow.jsx`
- `src/features/accounting/payroll/ExceptionBadge.jsx`
- Module CSS files for each.
- Route + sidebar entry in `AppShell.jsx`.

Notification: a Monday 7 AM Pacific cron job sends an email and writes an `events` row when draft timesheets exist for the prior week, addressed to users with role `admin` or `member` in the org.

Exit criteria: a back-office user can complete a full week's review and approval flow on a Vercel preview deploy. Empty state, single-caregiver state, and 50+-caregiver state all render and perform acceptably. Approval writes events to the `events` table.

Rollback: hide the sidebar entry behind a feature flag override. Route stays accessible to debug. Data is unchanged.

### Phase 5 — Submission and webhook (3 days, gated on Payroll API scope)

**Cannot start until owner confirms Payroll and Check API scope is enabled by Paychex.**

Goal: clean submission of approved timesheets to Paychex, with status surfaced back via webhook.

New files:
- `supabase/functions/payroll-submit-run/index.ts` — wraps DB transaction (mark run `submitted` before API call) and Paychex `/paydata` call. Idempotency key = `payroll_runs.id`.
- `supabase/functions/paychex-webhook/index.ts` — validates Paychex signature, updates `payroll_runs.status` and per-timesheet `paychex_check_id`, writes `events`.
- Submission UI: confirmation modal on the Payroll Runs view requiring the user to type the gross total to confirm.
- Preview Submission view: shows exactly what will be sent to Paychex, line by line.

Production cutover requires owner sign-off after a sandbox-equivalent dry run on at least one full pay period using `PAYCHEX_DRY_RUN=true`.

Exit criteria: a payroll run submits successfully via the live API for one pay period. Webhook updates status. Failure modes (rejected workers, validation errors) surface clearly in the UI. Audit trail complete in `paychex_api_log` and `events`.

Rollback: void any in-flight submission via Paychex Flex UI directly. Code rollback via Vercel. The `payroll_runs.status` machine permits a `failed` terminal state from any prior state, so a stuck record can be force-marked manually.

### Phase 6 — W-2 tax onboarding flow (3 days)

Goal: new caregivers complete W-4, I-9, direct deposit setup without manual back-office intervention.

Recommended path: **Paychex-hosted onboarding link**. Generate a link via the Paychex API, send to the caregiver via existing SMS/email automation, Paychex notifies via webhook on completion. Portal stores only the completion timestamps. Less work than building a white-label form, leverages Paychex's compliance infrastructure, and naturally integrates with the existing onboarding sequence.

New files:
- `supabase/functions/paychex-generate-onboarding-link/index.ts`
- Webhook handling for onboarding completion (extend `paychex-webhook`).
- Caregiver detail view: a "Payroll Setup" section showing W-4 / I-9 / Direct Deposit status with a "Send Onboarding Link" button.
- Block on `caregivers.employment_status = 'active'` transition until all three timestamps are set.

Exit criteria: a new caregiver receives the onboarding link, completes the steps in Paychex's hosted flow, and the portal reflects the completion timestamps. Existing onboarding automation gracefully integrates the payroll setup step.

Rollback: revert the PR. Existing caregivers' status is unchanged.

## Cross-cutting reliability practices

Applied across every phase:

1. **Idempotency on every write to Paychex.** Idempotency key = stable hash of payload + ISO date bucket for sync calls; `payroll_runs.id` for submission. Retries cannot create duplicates.
2. **Append-only audit via the existing `events` table.** Every approval, edit, submission, and webhook is an event. Fits the project's existing observability architecture.
3. **`paychex_api_log` records every request and response**, including dry-run calls. Persists for at least 1 year. Lets us prove what happened to Paychex if there is ever a dispute.
4. **`PAYCHEX_DRY_RUN=true` env flag** intercepts all writes during development and returns synthetic success without contacting Paychex. Production deployment leaves this unset.
5. **Two-hour pre-cutoff submission block.** UI hard-blocks submission within 2 hours of Paychex's processing cutoff for the pay date. Prevents late-submission scrambles.
6. **Dollar-total typed confirmation** before any submission. Standard pattern for irreversible money operations.
7. **Per-environment indicator** in the UI on every payroll page header (`PRODUCTION` or `DRY-RUN`) so it is impossible to confuse the two.
8. **Tests before UI.** OT engine, worker mapping, and timesheet builder all reach ≥90% coverage before any UI is written. Pure functions are easy to test exhaustively; do it.
9. **Per-org cron iteration.** Every cron in this work iterates `organizations` with `features_enabled.payroll === true`. No global queries.
10. **Rollback plan documented per PR**, per the multi-tenancy checklist.

## Anti-patterns

Things that will be tempting and must not be done:

- **Hardcoding company ID `70125496` anywhere in source.** It belongs in `organizations.settings`. Always.
- **Adding new env vars for tenant-sensitive secrets**. New env vars violate directive 4. The TC env-var fallback is a transition allowance, not a pattern to extend.
- **Adding queries that read shifts, clock_events, caregivers, or any tenant data without org scoping.** Either explicit `WHERE org_id = ...` or rely on RLS. Never trust the assumption that there is only one org today.
- **Storing SSN, bank account, or W-4 election data in the local database.** All sensitive PII goes directly to Paychex. Storing it locally turns the portal into a HIPAA + PCI surface and is unnecessary.
- **Approving and submitting in one click.** Approval and submission are two distinct user actions on two distinct screens. Removing the gap is removing the safety.
- **Auto-approving timesheets with no exceptions.** Even clean weeks need a human click. The system prepares; humans authorize.
- **Skipping the dry-run preview before first production submission.** At least one full pay period must be validated with `PAYCHEX_DRY_RUN=true` before the live cutover.
- **Adding mileage to the wage total instead of as a separate non-taxable line item.** Wrong tax treatment, real consequences.
- **Reusing one Paychex `/paydata` call for multiple pay periods.** One submission per period. Composability is not a feature here; correctness is.

## Testing strategy

- **Pure-function unit tests** for `overtimeRules.js`, `timesheetBuilder.js`, `workerMapping.js`, `exceptions.js`. Vitest. Aim ≥90% line coverage on business logic.
- **OT case matrix** (minimum 30 cases): standard week; daily OT thresholds (8h, 12h); weekly OT (40h); 7th consecutive day; rest day breaks; split shifts; shifts spanning midnight; daylight saving spring-forward and fall-back; missing clock-out; rate change mid-period; mileage with no hours; high-mileage anomaly.
- **Mapping function tests** for every caregiver field that maps to a Paychex Worker field, including null-handling and special characters.
- **RLS smoke tests** in a dedicated test migration that creates a second org and verifies a JWT for that org cannot read TC's payroll data.
- **End-to-end manual test plan** documented in the runbook (out of scope for this doc — created during Phase 4).
- **Sandbox-equivalent validation period**: two weeks of `PAYCHEX_DRY_RUN=true` against real shift data before any production submission. Owner spot-checks totals against current process.

## Open questions for the owner

These need owner input before or during the relevant phase. Listed in the order they become blocking.

1. **Paychex submission cutoff timing**: confirm how many business days before pay date Paychex Flex requires the `/paydata` submission. Affects the Phase 4 cutoff-block UI and the Monday review notification timing.
2. **Pay period boundaries**: confirm Sunday end-of-day cutoff and Friday pay date are correct for Tremendous Care today.
3. **Mileage rate**: confirm $0.70/mi for 2026 is the rate currently used. If TC reimburses at a different rate, set it accordingly in the seed migration.
4. **Per-org credential storage approval**: the proposed `getOrgSecret(orgId, secretName)` abstraction with TC env-var fallback. This is the pattern that Phase C of the SaaS retrofit will generalize. Owner approval needed before Phase 1 starts.
5. **Notification recipients**: which users receive the Monday "payroll ready to review" email? All `admin` + `member` role users in the org by default; owner can override.
6. **Test caregiver setup**: owner creates the "Test Caregiver — Do Not Pay" record in Paychex Flex before Phase 2 begins.
7. **Paychex rep status**: track the Payroll and Check API scope request. Phase 5 cannot start until the scope is enabled.

## Immediate next actions

In strict order. Do not proceed past a step until it succeeds.

1. **Owner**: email Paychex rep to enable Payroll and Check API scope on the existing Caregiver Portal app in App Hub. Reference Company ID 70125496.
2. **Owner**: answer the seven open questions above. Especially questions 1, 2, 3 — they go straight into the seed migration.
3. **Claude**: open a draft PR from `claude/integrate-paychex-payroll-W2tQj` containing this plan document only. Get owner approval on the plan.
4. **Claude**: implement Phase 0 (diagnostic edge function). One-PR scope. Owner runs it once and shares the output.
5. **Claude**: implement Phase 1 (data model + seed). One-PR scope. Reviewed against the multi-tenancy checklist.
6. **Claude**: implement Phase 2 (Paychex client + worker sync). Sync the test caregiver. Verify in Paychex App Hub that the Worker record appears as expected.
7. **Claude**: implement Phase 3 (timesheet generation + OT engine). Run the cron in shadow mode for 1-2 weeks; owner spot-checks the produced drafts against actual TC payroll for those weeks.
8. **Claude**: implement Phase 4 (approval UI). Back office runs 1-2 cycles of approval flow without submitting. Catches any UX issues.
9. **Owner**: confirm Paychex Payroll API scope is enabled. Without this, Phase 5 cannot proceed.
10. **Claude**: implement Phase 5 (submission + webhook). Run two pay periods in dry-run. Owner reviews Preview output. On owner sign-off, flip `PAYCHEX_DRY_RUN` off and submit one real payroll run.
11. **Claude**: implement Phase 6 (W-2 onboarding flow) for the next new hire.

After Phase 6 ships, this document graduates to `docs/runbooks/payroll-runbook.md` (a new doc covering day-to-day operation, exception handling, and what-to-do-when scenarios).

