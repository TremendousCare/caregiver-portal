# Paychex Flex Payroll Integration — Implementation Plan

**Date:** 2026-04-25
**Branch:** `claude/paychex-multi-org-refactor-lpDA8`
**Related docs:** `docs/SAAS_RETROFIT.md`, `docs/SAAS_RETROFIT_STATUS.md`, `CLAUDE.md`
**Status:** Planning. No code written yet.

---

## Purpose

This document is the durable plan for adding Paychex Flex payroll processing to the Tremendous Care caregiver portal. It exists so any contributor — human or AI — opening the repo can pick up the work without reconstructing context from chat history.

The integration is being built **after** the SaaS retrofit's Phase A has shipped to `main` and baked successfully (organizations, org_memberships, custom access token hook, AppContext plumbing all live). Every TC user's JWT now carries `org_id`, `org_slug`, and `org_role` claims. Phase B (org_id on every existing table) is targeted to begin within the week. All new tables, queries, secrets, and configuration in this plan respect the six prime directives in `CLAUDE.md`. If you have not read `CLAUDE.md` and `docs/SAAS_RETROFIT.md`, read those first.

**Sequencing note**: Paychex Phase 2 (worker sync) consumes `getOrgSecret(orgId, secretName)`. That helper is generalized in a separate, prerequisite PR (Paychex Phase 1.5 below) so the secret-storage pattern is decided and baked once, used by all integrations going forward, and not re-litigated inside a payroll PR. Phase 1.5 also serves as the concrete forcing function for the still-open "Vault entries vs `org_secrets` table" decision in retrofit Phase C.

## Vision in one paragraph

A back-office user opens the Accounting section every Monday morning, reviews the prior week's timesheets generated automatically from `shifts` and `clock_events`, resolves any flagged exceptions, previews the submission, and clicks one button to push the payroll run to Paychex Flex. Caregivers are paid Friday. The owner never logs into Paychex unless investigating an exception. The system is multi-org-ready from the first migration — Tremendous Care is org #1, but every table, query, and secret is structured so a future agency can be onboarded by inserting an `organizations` row, populating `organizations.settings.paychex`, and storing per-org credentials, with no code changes required.

## Status of Paychex access

Confirmed by screenshots from the owner on 2026-04-25:

- The portal app is registered inside Paychex Flex App Hub under company **Tremendous Care, ID 70125496**, status **Connected**. This is the Flex In-App API path, not `developer.paychex.com`. It is production, not sandbox.
- **Company and Worker APIs**: enabled with **Read and Write** scope (GET, POST, PATCH, DELETE). Sufficient to read/create/update/delete worker records.
- **Payroll and Check APIs**: NOT enabled. The portal shows "Need Access? Your Paychex representative can help." This scope is required for Phase 5 (payroll submission).

There is **no separate sandbox**. All worker writes hit real production data. Mitigation: the first synced caregiver is a designated test record ("Test Caregiver — Do Not Pay") and a `PAYCHEX_DRY_RUN` environment flag intercepts writes during development.

The owner is contacting Paychex to enable the Payroll and Check API scope. **This scope unblocks Phase 5 (direct API submission) only. The integration delivers full operational value without it.**

Without Phase 5, the Phase 4 Approval UI's "Submit Run" action produces a structured CSV (and on-screen line-by-line preview) of the approved payroll run that the back-office user uploads or pastes into Paychex Flex manually — i.e. the current workflow, but with all the upstream automation (timesheet generation, OT classification, exception detection, approval gating, audit log) in place. Phase 5 graduates that final step from "export and paste" to "one-click direct submission." It is documented in this plan in full so that the work is ready to ship the day Paychex enables the scope, but it is **not on the critical path** for getting the integration live.

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

- **Per-org credential storage mechanism (Vault vs `org_secrets` table)**: locked decision deferred to the Phase 1.5 PR that introduces `getOrgSecret`. That PR makes the choice, ships the helper, and converts one existing integration onto it before Paychex consumes it. Both implementations sit behind the same `getOrgSecret(orgId, secretName)` signature so Paychex code is identical regardless.
- **Multi-state expansion timing**: when do we add OT rules for other US states? Defer until the second org with non-CA caregivers is signing.
- **Off-cycle payroll** (bonuses, corrections, terminations mid-period): out of scope for v1. Manual via Paychex UI. Add to v2 backlog.
- **Year-end W-2 generation**: handled automatically by Paychex once workers are synced. No work required from us; document in the runbook.
- **Caregiver-facing pay stub view**: Paychex provides employee self-service. Out of scope for v1 unless owner wants pay stubs surfaced inside the caregiver PWA.

## Architecture — multi-org from day one

### Where the Paychex company ID lives

`organizations.settings.paychex.company_id` (jsonb). Tremendous Care's row gets `"70125496"` set by a one-line UPDATE in the seed migration. Code reads it via the standard `useOrgSettings()` hook on the frontend or by selecting `organizations.settings -> 'paychex'` in edge functions. **Never hardcoded in source.**

Display string also stored: `organizations.settings.paychex.company_display`. For TC: `"70125496 - Tremendous Care"`. Used in the admin UI ("Connected to Paychex Flex Company: ...").

### Where Paychex API credentials live

Credentials are read via `getOrgSecret(orgId, secretName)` from `supabase/functions/_shared/orgSecrets.ts`. **This helper is shipped and baked in Phase 1.5 before any Paychex code consumes it.** Paychex Phase 2 calls `getOrgSecret(currentOrgId, 'paychex_client_id')` and `getOrgSecret(currentOrgId, 'paychex_client_secret')` and is otherwise unaware of where those values are stored.

For Tremendous Care during the transition, the helper falls back to environment variables (`PAYCHEX_CLIENT_ID`, `PAYCHEX_CLIENT_SECRET`) gated on `org_id = (SELECT id FROM organizations WHERE slug = 'tremendous-care')`. For any other org it queries the persistence layer chosen in Phase 1.5 (Vault entry or `org_secrets` row). The Paychex codebase contains zero references to either env vars or the persistence mechanism — both are implementation details of `getOrgSecret`.

This means **no new env vars for tenant-sensitive data going forward**. The TC env vars are a transition allowance explicitly permitted by directive 4 in `CLAUDE.md`.

### How edge functions read org context

Every payroll edge function reads `org_id` from the JWT via the existing `getOrgClaims(session)` helper pattern (`src/lib/supabase.js`, server-side equivalent in `_shared`). Cron jobs that touch payroll iterate `organizations` first, then for each org with `features_enabled.payroll === true`, perform per-org work with that org's credentials and settings.

### RLS on new tables

Every new payroll table is born with row-level security. Predicate: `(auth.jwt() ->> 'org_id')::uuid = org_id`. Policies are defined in the migration that creates the table — not as a follow-up. New tables do not need the existing-table backfill dance Phase B uses.

### Events table integration

Every payroll-related action writes to the existing `events` table: `timesheet_generated`, `timesheet_approved`, `timesheet_adjusted`, `payroll_run_submitted`, `payroll_run_completed`, `payroll_run_failed`, `paychex_worker_synced`, `paychex_worker_sync_failed`. The `events` table does not yet have an `org_id` column — Phase B of the SaaS retrofit adds it.

Payroll events written during the gap before Phase B ships will not include `org_id`. Phase B's backfill SQL derives `org_id` deterministically from the event payload using these mappings (document this in the Phase B PR description so the recipe is preserved):

| Event types | Source for org_id |
|---|---|
| `timesheet_generated`, `timesheet_approved`, `timesheet_adjusted` | `timesheets.org_id` joined on `payload->>'timesheet_id'` |
| `payroll_run_submitted`, `payroll_run_completed`, `payroll_run_failed` | `payroll_runs.org_id` joined on `payload->>'payroll_run_id'` |
| `paychex_worker_synced`, `paychex_worker_sync_failed` | `caregivers.org_id` joined on `payload->>'caregiver_id'` |

Every payload shape above must include the corresponding ID field as a top-level key from the very first write so the backfill is mechanical. This is enforced by the `logEvent(...)` call sites in the payroll edge functions; review during Phase 1.5 / Phase 2 PRs.

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
| `paychex_worker_id` | text | Paychex Worker ID once synced. Null until first sync. Scoped per Paychex company. |
| `paychex_sync_status` | text | One of `not_started`, `pending`, `active`, `error`. Default `not_started`. |
| `paychex_last_synced_at` | timestamptz | Timestamp of last successful sync. |
| `paychex_sync_error` | text | Last error message. Cleared on successful sync. |
| `w4_completed_at` | timestamptz | Timestamp when W-4 was filed in Paychex. |
| `i9_completed_at` | timestamptz | Timestamp when I-9 was completed. |
| `direct_deposit_completed_at` | timestamptz | Timestamp when direct deposit was set up. |

These three onboarding timestamps are flags only. The actual W-4 / I-9 / bank data lives in Paychex.

**Uniqueness**: `paychex_worker_id` is unique per Paychex company, not globally. Once Phase B of the retrofit adds `org_id` to `caregivers`, add a unique constraint on `(org_id, paychex_worker_id)` (partial, `WHERE paychex_worker_id IS NOT NULL`). Do **not** add a global unique constraint on `paychex_worker_id` alone — that breaks the day a second org with its own Paychex company joins. Until `caregivers.org_id` exists, no DB-level uniqueness is added; application code in `paychex-sync-worker` enforces it via lookup-before-write.

### New tables

**`timesheets`** — one per caregiver per pay period. Source of truth for what gets paid.

Key columns: `id uuid PK`, `org_id uuid NOT NULL REFERENCES organizations(id)`, `caregiver_id text REFERENCES caregivers(id)`, `pay_period_start date`, `pay_period_end date`, `status text` (one of `draft | pending_approval | approved | exported | submitted | paid | rejected | blocked`), `regular_hours numeric(6,2)`, `overtime_hours numeric(6,2)`, `double_time_hours numeric(6,2)`, `mileage_total numeric(8,2)`, `mileage_reimbursement numeric(10,2)`, `gross_pay numeric(10,2)`, `approved_by text`, `approved_at timestamptz`, `exported_at timestamptz` (set when included in a CSV export run), `submitted_at timestamptz` (set when submitted via Phase 5 API), `paychex_check_id text` (Phase 5 only; nullable indefinitely without it), `block_reason text` (when status = blocked), `notes text`, `created_at timestamptz`. UNIQUE constraint on `(org_id, caregiver_id, pay_period_start)` — org-scoped composite ensures uniqueness even after multi-org expansion.

The `exported` and `submitted` statuses are distinct: `exported` means the data was packaged in a CSV that the back office downloaded (the path that ships in Phase 4); `submitted` means the data was sent directly to Paychex via API (Phase 5 only). A timesheet can move `approved → exported → paid` (manual entry path) or `approved → submitted → paid` (API path).

**`timesheet_shifts`** — junction table linking timesheets to the shifts they cover, with the per-shift hour classification.

Key columns: `timesheet_id uuid REFERENCES timesheets(id) ON DELETE CASCADE`, `shift_id uuid REFERENCES shifts(id)`, `hours_worked numeric(5,2)`, `hour_classification text` (one of `regular | overtime | double_time`), `mileage numeric(6,2)`, PRIMARY KEY `(timesheet_id, shift_id)`. Inherits org isolation via the parent timesheet's RLS.

**`payroll_runs`** — a batch of timesheets submitted together to Paychex.

Key columns: `id uuid PK`, `org_id uuid NOT NULL`, `pay_period_start date`, `pay_period_end date`, `pay_date date`, `status text` (one of `draft | exported | submitted | processing | completed | failed`), `submission_mode text` (one of `csv_export | api_direct`), `timesheet_count int`, `total_gross numeric(12,2)`, `total_mileage numeric(10,2)`, `csv_export_url text` (Supabase Storage path for the generated CSV; nullable for `api_direct` runs), `paychex_payperiod_id text` (Phase 5 only), `submitted_by text`, `submitted_at timestamptz`, `completed_at timestamptz` (manually set by user marking the run as paid in CSV mode; webhook-driven in API mode), `error_details jsonb`, `created_at timestamptz`. UNIQUE constraint on `(org_id, pay_period_start, pay_date)` to prevent duplicate runs.

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

### Phase 1.5 — Generalize `getOrgSecret` (1 day, separate PR, prerequisite to Phase 2)

Goal: ship the per-org secret lookup helper as a baked, reviewed, in-use pattern **before** any Paychex code consumes it. This is the forcing function for the still-open Vault-vs-`org_secrets`-table decision in retrofit Phase C.

This phase is a contribution to the SaaS retrofit, not the Paychex integration. It is sequenced inside this plan because Paychex Phase 2 is the immediate consumer; landing it as part of payroll work would couple two unrelated decisions.

Decision required from the owner before this phase starts: Vault entries vs dedicated `org_secrets` table. Recommendation: **`org_secrets` table** (`id`, `org_id`, `secret_name`, `secret_value` (encrypted with `pgcrypto`), `created_at`, `updated_at`, UNIQUE `(org_id, secret_name)`, RLS denies direct row access — only the SECURITY DEFINER RPC reads it). Reasons: easier to audit (row-per-secret, queryable), easier to rotate per-org, no Vault GUI dependency for non-engineering admins, integrates with the existing migration pattern. Vault remains an option if the owner prefers; the helper signature is identical either way.

New files:
- Migration `YYYYMMDDHHMMSS_create_org_secrets.sql` — `org_secrets` table with RLS denying direct access, plus `pgcrypto` extension if not already enabled.
- Migration `YYYYMMDDHHMMSS_get_org_secret_rpc.sql` — `public.get_org_secret(p_org_id uuid, p_secret_name text) returns text` SECURITY DEFINER. Falls back to env vars when `org_id = (SELECT id FROM organizations WHERE slug = 'tremendous-care')`.
- `supabase/functions/_shared/orgSecrets.ts` — TypeScript wrapper that calls the RPC. Single function: `export async function getOrgSecret(supabase, orgId, secretName): Promise<string>`.
- Conversion of one existing integration onto the helper as the proof-of-pattern. Recommended: **RingCentral** (already has the closest parallel via `get_route_ringcentral_jwt`). The conversion is a thin shim: existing call sites change from reading env vars directly to calling `getOrgSecret(supabase, orgId, 'ringcentral_jwt')`. Env-var fallback for TC is preserved; behavior identical.
- Tests: `src/lib/__tests__/orgSecrets.test.js` covers signature, error paths, and mock RPC.

Exit criteria: helper exists, RPC works, RingCentral is calling it in production with no behavior change for TC, the org_secrets table is empty (TC still uses env vars), and docs/SAAS_RETROFIT.md Phase C is updated to mark this decision locked.

Rollback: revert the PR. Existing integrations were not modified to depend on the helper at the call site beyond a single thin shim that can be swapped back in one commit. Migration down-scripts drop `org_secrets` and the RPC.

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

### Phase 4 — Approval UI and CSV export (4 days)

Goal: the Accounting > Payroll page goes live. Back office can review, edit, approve, and **export** timesheets as a CSV ready to upload or paste into Paychex Flex's existing manual entry interface. **This phase delivers the full operational value of the integration without requiring Paychex's Payroll API scope.**

The "Submit Run" action in this phase generates a CSV (and on-screen line-by-line preview) of the approved payroll run, marks the constituent timesheets `exported`, marks the run `exported`, and writes the export event. The back-office user then enters the data into Paychex Flex (current workflow) and clicks "Mark as Paid" once payroll has been confirmed processed in Paychex — flipping the run to `completed` and timesheets to `paid`. This is the manual reconciliation path; Phase 5 graduates it to API-driven.

New files:
- `src/features/accounting/AccountingPage.jsx` — top-level page with sub-tab routing.
- `src/features/accounting/PayrollTab.jsx` — three-view payroll content.
- `src/features/accounting/payroll/ThisWeekView.jsx`
- `src/features/accounting/payroll/PayrollRunsView.jsx`
- `src/features/accounting/payroll/PayrollSettingsView.jsx`
- `src/features/accounting/payroll/TimesheetRow.jsx`
- `src/features/accounting/payroll/ExceptionBadge.jsx`
- `src/features/accounting/payroll/SubmissionPreview.jsx` — line-by-line preview of what will be exported, with column headers matching Paychex Flex's manual entry columns.
- `src/lib/payroll/csvExport.js` — pure function: list of approved timesheets → CSV string in the exact column order Paychex Flex's manual entry accepts. Tested in `__tests__`.
- `supabase/functions/payroll-export-run/index.ts` — server-side: receives a list of approved timesheet IDs, validates org-scoping, generates CSV, uploads to Supabase Storage with a signed URL, marks run + timesheets as `exported`, writes `events`. Returns the signed URL.
- Module CSS files for each.
- Route + sidebar entry in `AppShell.jsx`.

CSV column format: confirmed against Paychex Flex's manual entry screen during Phase 0 diagnostic (see open question #1 below — owner confirms the exact columns by sharing a screenshot of the entry screen). Reasonable expected columns: Worker ID, Worker Name, Pay Period Start, Pay Period End, Regular Hours, OT Hours, DT Hours, Mileage Reimbursement (line item, non-taxable). Stored once in `src/lib/payroll/csvExport.js` as a single source of truth.

Submission UX:
1. User clicks "Generate Payroll Run" on `ThisWeekView`. All approved timesheets for the current period are batched into a `payroll_runs` row in `draft` status.
2. Confirmation modal opens showing total caregiver count, total hours, total gross, and the dollar-typed confirmation field. Modal header shows `PRODUCTION` or `DRY-RUN` indicator.
3. On confirm, run is marked `exported`, CSV is generated server-side, and a download begins. The line-by-line preview stays visible for cross-referencing during manual entry.
4. After the user enters the data into Paychex Flex, they return to `PayrollRunsView`, open the run, and click "Mark as Paid in Paychex." This flips the run to `completed` and all member timesheets to `paid`. Audit event written.

Notification: a Monday 7 AM Pacific cron job sends an email and writes an `events` row when draft timesheets exist for the prior week, addressed to users with role `admin` or `member` in the org.

Exit criteria: a back-office user can complete a full week's review, approval, and CSV export flow on a Vercel preview deploy. CSV opens cleanly in Paychex Flex's import or matches its manual entry format exactly. Empty state, single-caregiver state, and 50+-caregiver state all render and perform acceptably. Approval and export write events to the `events` table.

Rollback: hide the sidebar entry behind a feature flag override. Route stays accessible to debug. Data is unchanged.

### Phase 5 — Direct API submission and webhook (3 days, OPTIONAL — gated on Payroll API scope)

**This phase is an enhancement, not a requirement. The integration is fully operational without it via the CSV export path shipped in Phase 4. Phase 5 is documented in full so the work is ready when Paychex enables the Payroll and Check API scope, but it is not on the critical path.**

**Cannot start until owner confirms Payroll and Check API scope is enabled by Paychex.**

Goal: graduate the final submission step from CSV-export-and-paste to direct API submission, with status surfaced back via webhook.

New files:
- `supabase/functions/payroll-submit-run/index.ts` — wraps DB transaction (mark run `submitted` before API call) and Paychex `/paydata` call. Idempotency key = `payroll_runs.id`.
- `supabase/functions/paychex-webhook/index.ts` — validates Paychex signature, updates `payroll_runs.status` and per-timesheet `paychex_check_id`, writes `events`.
- Submission UI: a second submission button ("Submit to Paychex via API") appears alongside the existing "Generate CSV" button on the Payroll Runs view. Confirmation modal requires the user to type the gross total. The CSV path remains available as a fallback indefinitely.
- Preview Submission view: reuses the Phase 4 line-by-line preview; the only difference is what the "Confirm" button does.
- `payroll_runs.submission_mode` is set to `api_direct` for runs submitted via this path; `csv_export` for runs that go via the Phase 4 path. Both modes coexist permanently — a back-office user can choose per-run.

Production cutover requires owner sign-off after a dry run on at least one full pay period using `PAYCHEX_DRY_RUN=true` (the CSV-mode export from Phase 4 also serves as the side-by-side comparison: API result should match CSV result penny for penny).

Exit criteria: a payroll run submits successfully via the live API for one pay period. Webhook updates status. Failure modes (rejected workers, validation errors) surface clearly in the UI and the user can fall back to CSV export for the same run with one click. Audit trail complete in `paychex_api_log` and `events`.

Rollback: void any in-flight submission via Paychex Flex UI directly. Code rollback via Vercel. The CSV export path remains available throughout. The `payroll_runs.status` machine permits a `failed` terminal state from any prior state, so a stuck record can be force-marked manually.

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

1. **Paychex Flex manual entry column format**: owner shares a screenshot of the Paychex Flex manual payroll entry screen so Phase 4's CSV export columns match exactly. Affects `src/lib/payroll/csvExport.js`.
2. **Pay period boundaries**: confirm Sunday end-of-day cutoff and Friday pay date are correct for Tremendous Care today.
3. **Mileage rate**: confirm $0.70/mi for 2026 is the rate currently used. If TC reimburses at a different rate, set it accordingly in the seed migration.
4. **Per-org secret persistence (Vault vs `org_secrets` table)**: decision required at Phase 1.5 kickoff. Recommendation in this doc is `org_secrets` table; owner confirms or overrides.
5. **Notification recipients**: which users receive the Monday "payroll ready to review" email? All `admin` + `member` role users in the org by default; owner can override.
6. **Test caregiver setup**: owner creates the "Test Caregiver — Do Not Pay" record in Paychex Flex before Phase 2 begins.
7. **Paychex rep status (Phase 5 only)**: track the Payroll and Check API scope request. Phase 5 cannot start until the scope is enabled. The integration ships full value via Phase 4's CSV export without Phase 5.

## Immediate next actions

In strict order. Do not proceed past a step until it succeeds.

1. **Owner (in parallel, non-blocking)**: email Paychex rep to enable Payroll and Check API scope on the existing Caregiver Portal app in App Hub. Reference Company ID 70125496. This unblocks Phase 5 (optional enhancement) only — the integration ships full value without it.
2. **Owner**: answer the seven open questions above. Especially questions 1, 2, 3 — they go straight into the seed migration and CSV exporter.
3. **Owner**: confirm the persistence choice for Phase 1.5 (`org_secrets` table recommended, Vault as alternative).
4. **Claude**: open a draft PR from `claude/paychex-multi-org-refactor-lpDA8` containing this updated plan document only. Get owner approval on the plan.
5. **Claude**: separately, update `docs/SAAS_RETROFIT_STATUS.md` to reflect Phase A shipped and baked. Done in its own PR (one-line change to the status table) so the retrofit's source of truth is accurate before Phase 1.5 references it.
6. **Claude**: implement Phase 0 (Paychex diagnostic edge function). One-PR scope. Owner runs it once and shares the output.
7. **Claude**: implement Phase 1 (Paychex data model + seed). One-PR scope. Reviewed against the multi-tenancy checklist.
8. **Claude**: implement Phase 1.5 (`getOrgSecret` + `org_secrets` table + RingCentral conversion). One-PR scope. Bake on `main` for 3+ days. Counts toward retrofit Phase C; coordinate the SAAS_RETROFIT.md update in this PR.
9. **Claude**: implement Phase 2 (Paychex client + worker sync). Consumes the now-baked `getOrgSecret`. Sync the test caregiver. Verify in Paychex App Hub that the Worker record appears as expected.
10. **Claude**: implement Phase 3 (timesheet generation + OT engine). Run the cron in shadow mode for 1-2 weeks; owner spot-checks the produced drafts against actual TC payroll for those weeks.
11. **Claude**: implement Phase 4 (approval UI + CSV export). **At this point the integration is operationally complete.** Back office runs 1-2 cycles end-to-end: review, approve, export CSV, manually enter into Paychex, mark as paid. Catches any UX issues.
12. **Bake**: 2-4 weeks of weekly payroll runs through the Phase 4 CSV path before considering Phase 5. Confirms numbers match Paychex's processing penny-for-penny in real conditions.
13. **Owner (only if Paychex enables the scope)**: confirm Paychex Payroll API scope is enabled.
14. **Claude (only if step 13 happens)**: implement Phase 5 (direct API submission + webhook). Run two pay periods in dry-run alongside the CSV export (compare line-by-line). Owner reviews Preview output. On owner sign-off, flip `PAYCHEX_DRY_RUN` off and submit one real payroll run.
15. **Claude**: implement Phase 6 (W-2 onboarding flow) for the next new hire. Can run in parallel with Phase 5 or independently — neither blocks the other.

After Phase 4 ships, this document graduates to `docs/runbooks/payroll-runbook.md` (a new doc covering day-to-day operation of the CSV export workflow, exception handling, and what-to-do-when scenarios). The runbook is updated again if/when Phase 5 ships.

