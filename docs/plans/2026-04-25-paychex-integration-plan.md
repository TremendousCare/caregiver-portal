# Paychex Flex Payroll Integration — Implementation Plan

**Date:** 2026-04-25
**Branch:** `claude/paychex-multi-org-refactor-lpDA8`
**Related docs:** `docs/SAAS_RETROFIT.md`, `docs/SAAS_RETROFIT_STATUS.md`, `CLAUDE.md`
**Status:** Phase 0 complete (PR #207 merged 2026-04-25; Phase 0 results captured by PR #209 merged 2026-04-25). Phase 1 in progress on branch `claude/paychex-phase-1-data-model`.

---

## Purpose

This document is the durable plan for adding Paychex Flex payroll processing to the Tremendous Care caregiver portal. It exists so any contributor — human or AI — opening the repo can pick up the work without reconstructing context from chat history.

The integration is being built **after** the SaaS retrofit's Phase A has shipped to `main` and baked successfully (organizations, org_memberships, custom access token hook, AppContext plumbing all live). Every TC user's JWT now carries `org_id`, `org_slug`, and `org_role` claims. Phase B (org_id on every existing table) is targeted to begin within the week. All new tables, queries, secrets, and configuration in this plan respect the six prime directives in `CLAUDE.md`. If you have not read `CLAUDE.md` and `docs/SAAS_RETROFIT.md`, read those first.

**Sequencing note (revised 2026-04-25 after `developer.paychex.com` audit)**: Paychex's API is structured so that **one partner app holds one set of OAuth credentials** (our `PAYCHEX_CLIENT_ID` / `PAYCHEX_CLIENT_SECRET`) and that single credential pair is granted access to **multiple Paychex client companies** via the `/management/requestclientaccess` flow. Per-tenant scoping happens at the `companyId` level, not at the credential level. **Therefore the Paychex OAuth credentials are partner-level (env-var, permanent) and not per-org.** Per-org Paychex configuration — `company_id`, `display_id`, pay period boundaries, mileage rate — lives entirely in `organizations.settings.paychex` (jsonb, RLS-protected). This is consistent with directive 4 in `CLAUDE.md`: those credentials are not "single-account credentials for a tenant-sensitive integration"; they are **partner credentials that span all tenants**. The earlier draft of this plan included a "Phase 1.5" to introduce a per-org secret helper as a Paychex prerequisite. **That phase is removed**: Paychex does not need per-org secret storage. The per-org secret persistence decision (Vault vs `org_secrets` table) returns to retrofit Phase C kickoff, where it can be made coherently across RingCentral, DocuSign, Microsoft, and Anthropic at once.

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

- **Paychex auth model**: partner-level. One App Hub registration, one `PAYCHEX_CLIENT_ID` / `PAYCHEX_CLIENT_SECRET` pair held in env vars permanently. Multi-org scoping happens via `companyId` per call. New agency onboarding follows the `/management/requestclientaccess` flow (see Architecture below). These env vars are an explicit allowance under directive 4 because the credentials are partner-spanning, not single-account.
- **Worker classification**: W-2 employees only at launch. No 1099 contractor flow.
- **Worker `employmentType` for TC**: all caregivers sync as `FULL_TIME`. TC hires every caregiver as full-time even though hours functionally vary by week (some weeks 20h, some 45h). This is a Paychex classification field, not a weekly hours indicator. Future orgs that mix FT/PT/seasonal can override per-caregiver via a `caregivers.paychex_employment_type` column added later (out of scope for v1; one-line additive migration when needed).
- **Worker `exemptionType` for TC**: all caregivers sync as `NON_EXEMPT` (hourly + OT-eligible).
- **Worker `workState` for TC**: `CA`. Sourced from `organizations.settings.payroll.default_work_state` so future multi-state orgs can override per-worker via `caregivers.work_state` column added later.
- **Pay period**: weekly. Specific day-of-week boundaries to be set per org in `organizations.settings.paychex.pay_period`. Tremendous Care: workweek runs Monday 00:00 → Sunday 23:59 (America/Los_Angeles), payroll is processed Monday morning, caregivers are paid the following **Wednesday** (confirmed by owner 2026-04-25; the earlier draft of this plan said Friday — that was a placeholder, not what TC actually does).
- **Overtime jurisdiction at launch**: California rules (daily >8h at 1.5x, daily >12h at 2x, weekly >40h at 1.5x, 7th consecutive day rules). Future orgs may need other states; the OT engine takes a jurisdiction parameter from day one even though only `CA` is implemented in v1.
- **Timezone for OT day boundaries**: `America/Los_Angeles`. Stored as a single constant in `src/lib/payroll/constants.js`. Future orgs that operate in other timezones will read this from `organizations.settings.timezone`.
- **Mileage**: tracked per-shift on `shifts.mileage`. Reimbursed as a non-taxable line item in Paychex (separate from wages). Rate stored in `organizations.settings.payroll.mileage_rate`. Tremendous Care reimburses at **$0.725/mi** as of 2026-04-25 (confirmed by owner; the earlier draft used $0.70 as a placeholder for the IRS 2026 standard rate, but TC's actual rate is $0.725).
- **Tax data storage**: all sensitive PII (SSN, bank account, W-4 elections) is sent directly to Paychex and **never stored locally**. The portal stores only `paychex_worker_id` and onboarding completion timestamps.
- **No `hire_date` column on `caregivers`**: TC does not have a meaningful hire date — caregivers can sit "active" in the pipeline for weeks before their first shift, and pay starts at the first shift. Forcing a `hire_date` field would require fabricating a value that doesn't reflect reality. Instead, the Phase 2 sync function computes the hire date dynamically from shift data when transitioning a worker from `IN_PROGRESS` to `ACTIVE` (see next bullet).
- **Two-stage worker lifecycle in Paychex** (confirmed with owner 2026-04-25): pre-hire onboarding is supported. When the back office triggers worker creation (manual button on the caregiver detail view, Phase 2), the Paychex worker is created with `currentStatus.statusType = IN_PROGRESS`, `statusReason = PENDING_HIRE`, and `effectiveDate = today + N days` where `N` defaults to 14 and is overridable per-org via `organizations.settings.payroll.default_pending_hire_date_offset_days`. This `effectiveDate` is a placeholder that lets Phase 6's Paychex-hosted onboarding flow run (W-4, I-9, direct deposit) while the worker is still pre-hire. When the caregiver's first non-cancelled shift transitions to `completed`, an automation (Phase 3+) PATCHes the worker to `currentStatus.statusType = ACTIVE`, `statusReason = HIRED`, `effectiveDate = first_shift.start_time::date` — which is the actual hire date for tax/W-2 purposes. Caregivers who never get a first shift never transition to ACTIVE and never appear in any Paychex bill.
- **Rehire handling**: rare for TC (owner-confirmed; happens when a previously terminated caregiver comes back). When the Phase 2 sync function detects an existing `caregivers.paychex_worker_id` whose Paychex `currentStatus.statusType = TERMINATED`, it does **not** auto-reactivate. Instead it returns a structured `rehire_detected` error with the worker's last termination date and reason; the back office reactivates the worker manually in Paychex Flex (their UI handles the rehire transitions, separation pay, etc. better than we should try to). Frequency-revisit trigger: if rehire becomes weekly we automate it; until then manual is correct.
- **Worker reads use the nonpii media type by default**: read flows fetch `application/vnd.paychex.workers.nonpii.v1+json` (or the matching nonpii variant per endpoint). Full-PII variants are used only when a specific operation needs it and the response is logged with PII-masked redaction. Keeps SSNs out of `paychex_api_log` by default.
- **Approval workflow**: every timesheet must be approved by a user with role `admin` or `member` (back-office) before it can be included in a payroll run. Caregivers themselves cannot approve their own timesheets.
- **Submission gating**: a payroll run cannot be submitted within 2 hours of the Paychex submission cutoff for that pay date. Hard block with a clear UI message.
- **Sidebar placement**: a new top-level `Accounting` nav item with `Payroll` as a sub-tab inside the Accounting page. Future tabs: `Invoicing`, `Expenses`, `Reports`. Gated behind `organizations.settings.features_enabled.payroll === true`.
- **Migration deployment**: SQL migrations apply to production via the manually-triggered `Deploy Database Migrations` workflow in GitHub Actions (`.github/workflows/deploy-migrations.yml`). The owner triggers a dry run first, reviews the listed pending migrations, then re-runs with `dry_run=false` to apply. Each schema-changing PR ships a matching down-script in `supabase/migrations/_rollback/` that the owner can paste into the Supabase Dashboard SQL editor for emergency rollback.
- **No emojis** in any payroll UI strings, code comments, or documentation.

## Decisions still open

- **Per-org credential storage mechanism (Vault vs `org_secrets` table)**: returns to retrofit Phase C kickoff (out of scope for this work). Paychex no longer needs this — its OAuth credentials are partner-level and live in env vars. The decision is made coherently across RingCentral, DocuSign, Microsoft, Anthropic when Phase C properly begins.
- **Multi-state expansion timing**: when do we add OT rules for other US states? Defer until the second org with non-CA caregivers is signing.
- **Off-cycle payroll** (bonuses, corrections, terminations mid-period): out of scope for v1. Manual via Paychex UI. Add to v2 backlog.
- **Year-end W-2 generation**: handled automatically by Paychex once workers are synced. No work required from us; document in the runbook.
- **Caregiver-facing pay stub view**: Paychex provides employee self-service. Out of scope for v1 unless owner wants pay stubs surfaced inside the caregiver PWA.

## Architecture — multi-org from day one

### Where Paychex IDs and configuration live

Two distinct identifiers live in `organizations.settings.paychex` (jsonb), set per org:

- **`display_id`**: the 8-digit human-readable Paychex Flex client number (TC: `"70125496"`). This is what the owner sees in Paychex Flex's UI and what gets supplied to `/management/requestclientaccess` during the onboarding flow. It is also what the back-office user types when verifying "yes, this is the right Paychex company."
- **`company_id`**: the long alphanumeric internal identifier Paychex returns from `/companies` (e.g. `"00H2A1IUK695XL45NDO6"`). This is what every API call uses (`/companies/{companyId}/workers` etc.). For TC it is discovered once during initial connect and stored; for new orgs it is discovered automatically the first time the portal calls `/companies?displayid=<their_display_id>` after the admin approves the integration in Paychex Flex.

Both **never hardcoded in source.** Frontend code reads them via the standard `useOrgSettings()` hook (or equivalent AppContext accessor); edge functions select `organizations.settings -> 'paychex'` server-side after deriving `org_id` from the JWT.

A display string is also stored: `organizations.settings.paychex.company_display` ("70125496 - Tremendous Care"). Used in admin UI ("Connected to Paychex Flex Company: …") and the dollar-typed confirmation modal.

### Where Paychex API credentials live

`PAYCHEX_CLIENT_ID` and `PAYCHEX_CLIENT_SECRET` live in **Supabase Edge Function secrets** (Project Settings → Edge Functions → Secrets in the Supabase Dashboard). They are **partner-level credentials**, shared across all orgs the portal serves, and stay as env vars permanently. Edge functions read them with `Deno.env.get(...)`. This is consistent with directive 4 because the credentials identify the entire Caregiver Portal SaaS to Paychex, not any single tenant; tenant scoping happens at the `companyId` layer per call.

This is the only Paychex secret the portal holds. Per-org Paychex configuration (`display_id`, `company_id`, pay periods, mileage rate) is non-secret jsonb in `organizations.settings.paychex`.

### How a new agency gets connected to Paychex (Phase E reference, documented here for completeness)

The multi-tenant onboarding flow uses `POST /management/requestclientaccess`. Conceptually:

1. New agency provides their 8-digit Paychex Flex `displayId` during signup.
2. Portal stores it in `organizations.settings.paychex.display_id`.
3. Portal edge function calls `/management/requestclientaccess` with that `displayId`. Response is `{ approvalLink: "https://myapps.paychex.com/#?clients=…&app=…" }`.
4. Portal emails or texts the `approvalLink` to the agency's Paychex Flex admin (the human who has admin rights inside Paychex).
5. Admin clicks the link, logs into Paychex Flex, navigates to Company Settings → Integrated Applications, locates the Caregiver Portal app showing "Access Requested," opens it, agrees to the Third-Party Terms of Use, clicks Save.
6. After approval, the portal calls `GET /companies?displayid=<their_display_id>`, captures the returned `companyId`, persists it to `organizations.settings.paychex.company_id`, and from then on operates on that org's Paychex data normally.

This entire flow ships in retrofit Phase E (self-serve onboarding). It is documented here so the Phase 2 worker-sync code is structured to consume `companyId` from `organizations.settings.paychex.company_id` (already true in this plan), making Phase E work with no Paychex code changes when it lands. **For Tremendous Care today**, the seed migration in Phase 1 inserts the known `display_id` ("70125496") and `company_id` (discovered manually in Phase 0 by hitting `GET /companies?displayid=70125496` once), bypassing the request-access flow because the connection has already been approved in Paychex App Hub.

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
- **Token acquisition** via client_credentials at `POST https://api.paychex.com/auth/oauth/v2/token` with `grant_type=client_credentials`, `client_id`, `client_secret` form-encoded. Token TTL is ~1 hour (`expires_in: 3599`). Cached in Deno KV until 5 minutes before expiry.
- **Vendor media types per call.** Every Paychex endpoint requires a specific `Accept` header (e.g. `application/vnd.paychex.companies.v1+json`, `application/vnd.paychex.workers.nonpii.v1+json`, `application/vnd.paychex.payroll.paycomponents.v1+json`). The shared client takes the media type as a per-call parameter; never defaults to `application/json`. Reads default to the `nonpii` variant where one exists.
- **PATCH path asymmetry**. Worker creation is `POST /companies/{companyId}/workers` with the body wrapped as a single-element array `[{...}]`. Worker updates are `PATCH /workers/{workerId}` (no `companyId` in path, body is a single object). The shared client encodes this asymmetry once.
- **Idempotency keys** on every write. Worker create: hash of `(workerCorrelationId, ISO date bucket)`. Payroll submission (Phase 5): `payroll_runs.id`. Retries cannot create duplicates.
- **Retry with exponential backoff**: 3 retries on 5xx or network errors at 2s, 4s, 8s. **No retry on 4xx.** **`423 Locked` is a hard fail with explicit handling**: the Paychex docs warn that a 423 may partially succeed and return a `workerId` that is invalid and must not be used. The client treats 423 as a non-retriable error, **never persists any `workerId` from a 423 response**, and surfaces a structured `client_account_locked` error so callers can requeue via cron rather than retrying immediately.
- **Logging**: every call writes a row to `paychex_api_log` before the response returns to the caller. Request/response bodies are stored verbatim except for SSN-redaction on full-PII worker variants (which we should rarely use; reads default to nonpii).
- **`PAYCHEX_DRY_RUN` env flag** — when true, write calls log the intended request to `paychex_api_log` with `dry_run = true` and return a synthetic success response without contacting Paychex.

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
    "display_id": "70125496",
    "company_id": "00M9LQF7LUBLSED1THE0",
    "company_display": "70125496 - TREMENDOUS CARE",
    "pay_period": { "frequency": "weekly", "ends_on": "sunday", "pay_day": "wednesday" },
    "default_employment_type": "FULL_TIME",
    "default_exemption_type": "NON_EXEMPT"
  },
  "payroll": {
    "mileage_rate": 0.725,
    "ot_jurisdiction": "CA",
    "timezone": "America/Los_Angeles",
    "default_work_state": "CA",
    "default_pending_hire_date_offset_days": 14
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

### Phase 0 — Verification and `company_id` discovery (half day, no schema changes) — COMPLETE 2026-04-25

Goal: confirm the API keys actually work against the real Paychex Flex company, surface any access issues before writing dependent code, and **discover TC's internal `companyId`** for use in the Phase 1 seed migration.

- New file: `supabase/functions/paychex-diagnostic/index.ts`. A throwaway-style edge function that:
  1. Calls `POST https://api.paychex.com/auth/oauth/v2/token` with `grant_type=client_credentials` + the `PAYCHEX_CLIENT_ID` / `PAYCHEX_CLIENT_SECRET` from `Deno.env`. Reports the returned `scope` so we know exactly what the credentials can do.
  2. Calls `GET https://api.paychex.com/companies?displayid=70125496` with `Accept: application/vnd.paychex.companies.v1+json`. Reports the returned `companyId` (the long alphanumeric like `"00H2A1IUK..."`). **This is the value that goes into the Phase 1 seed migration.**
  3. Calls `GET https://api.paychex.com/companies/{companyId}/workers?offset=0&limit=5` with `Accept: application/vnd.paychex.workers.nonpii.v1+json` (avoids pulling SSNs into the diagnostic output). Reports the worker count (`metadata.pagination.total`) and the first 5 worker shapes for schema inspection.
  4. Does **not** call any write endpoints. No worker creation in Phase 0.
- Returns a single structured JSON report with: scope, companyId, total worker count, sample worker shape, status codes for each call, request durations.
- Run once via the Supabase Functions UI by the owner. Output captured and pasted back to me for the Phase 1 seed migration values.
- No production data written. No schema changes. No DB tables touched.
- **Auth gating added during PR review**: the diagnostic is deployed with `--no-verify-jwt` (per the standard edge-functions deploy workflow), so the function additionally requires a `PAYCHEX_DIAGNOSTIC_TOKEN` env secret + matching `X-Diagnostic-Token` request header. Without this gate the public anon key alone could scrape Paychex company metadata and a 5-worker nonpii sample. The gate is removed when the function is deleted in Phase 1's cleanup.

Exit criteria: we can confirm we're talking to TC's real Paychex Flex company, the Company and Worker (read) scopes work as expected, we have the exact `companyId` value for the seed migration, and we know the exact JSON shape Paychex returns for workers.

Rollback: delete the function. Nothing else depends on it. Edge function deletion is a one-commit revert.

#### Phase 0 results (captured 2026-04-25)

PR #207 merged to `main`. The diagnostic was invoked from the Supabase Dashboard with successful results across all three calls:

| Field | Value |
|---|---|
| `displayId` | `70125496` |
| `companyId` | `00M9LQF7LUBLSED1THE0` |
| Paychex `legalName` | `TREMENDOUS CARE` (all caps; this is what the seed migration's `company_display` uses) |
| Granted OAuth scopes | `api-delegation ext-api read:company_people write:company_people` |
| Total workers in Paychex | 83 |
| OAuth token TTL | 3599 seconds (1 hour, matches the plan's assumption) |
| Token type | `Bearer` |

**Scope confirmation:** the granted scopes cover Worker read + write (sufficient for Phases 2, 3, 4, and 6). The Payroll and Check API scope is **not** present, confirming Phase 5 is correctly gated on a separate Paychex rep request. Phases 1-4 are unblocked; Phase 5 waits.

**Worker shape observations (for the Phase 2 mapping function):**
- Top-level fields observed on every worker: `workerId`, `employeeId`, `workerType`, `exemptionType`, `hireDate`, `name`, `organization`, `currentStatus`, `links`. `employmentType` is present on some workers and absent on others (existing Paychex records may pre-date the field; new TC syncs in Phase 2 always set it).
- `name` sub-fields: `familyName`, `givenName` always present. `middleName` and `preferredName` are optional. The mapping function in Phase 2 must tolerate missing values.
- `currentStatus.statusType` values seen in the sample: `ACTIVE`, `TERMINATED`. `statusReason` values seen: `HIRED`, `RESIGNED`, `DISCHARGED`, `TERMINATION`. New caregivers Phase 2 syncs will use `IN_PROGRESS` / `PENDING_HIRE` per the plan; status transitions are managed in Paychex Flex by the back office, not by the portal.
- `employeeId` is a short sequential integer (`"3"`, `"28"`, `"54"`, ...) Paychex assigns. **It is not the same as our `caregivers.id`**. The plan-mandated `workerCorrelationId = caregiver.id` linkage stays — that's how we round-trip from a Paychex worker back to our caregiver record. `employeeId` is informational only from our side.

**Cleanup tracked for Phase 1 PR**: the `paychex-diagnostic` function and the `PAYCHEX_DIAGNOSTIC_TOKEN` Edge Function secret should both be deleted when Phase 1 ships, since the seed migration captures the `companyId` permanently and the diagnostic has no further purpose. This is noted in the Phase 1 PR description as a follow-up item.

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

> **Note**: an earlier draft of this plan included a "Phase 1.5 — Generalize `getOrgSecret`" inserted here as a Paychex prerequisite. After the 2026-04-25 audit of `developer.paychex.com`, that phase was removed: Paychex's OAuth credentials are partner-level (env vars permanently) and Paychex Phase 2 has no per-org secret needs. The per-org secret persistence decision returns to retrofit Phase C kickoff, where it is made coherently across RingCentral, DocuSign, Microsoft, and Anthropic.

### Phase 2 — Paychex client and worker sync (2 days)

Goal: ship the shared Paychex API client and a per-caregiver sync edge function. One-way write to Paychex; reads are limited to the nonpii worker variant for verification. No `getOrgSecret` dependency — the OAuth credentials are partner-level env vars read directly via `Deno.env.get(...)`.

New files:
- `supabase/functions/_shared/paychex.ts` — OAuth2 client per the responsibilities listed in "Paychex API client" above (token caching, vendor media types, PATCH path asymmetry, idempotency keys, retries with 423 hard-fail, structured logging, dry-run honoring). Reads `PAYCHEX_CLIENT_ID` / `PAYCHEX_CLIENT_SECRET` from `Deno.env`.
- `supabase/functions/paychex-sync-worker/index.ts` — given `caregiver_id`, the function loads the caregiver, derives `org_id` from the JWT, loads `companyId` from `organizations.settings.paychex.company_id`, calls the worker mapping, then either `POST /companies/{companyId}/workers` (if `caregivers.paychex_worker_id` is null) or `PATCH /workers/{workerId}` (if it is set). On `200`, persists `paychex_worker_id`, `paychex_sync_status='active'`, `paychex_last_synced_at`. On `423`, sets `paychex_sync_status='error'` with `paychex_sync_error='client_account_locked'` and **does not persist the returned `workerId`** (the docs warn it is invalid in this case).
- `src/lib/paychex/workerMapping.js` — pure function: caregiver row + org settings + reference date → Paychex Worker payload (single object, the edge function wraps it in an array for POST per the API). Sets `workerCorrelationId = caregiver.id`, `workerType = 'EMPLOYEE'`, `employmentType` from `organizations.settings.paychex.default_employment_type` (TC: `FULL_TIME`), `exemptionType` from `default_exemption_type` (TC: `NON_EXEMPT`), and `currentStatus.{statusType: 'IN_PROGRESS', statusReason: 'PENDING_HIRE', effectiveDate: <today + organizations.settings.payroll.default_pending_hire_date_offset_days>}` for new workers (per the two-stage lifecycle decision). Name fields come from `caregivers.first_name` / `caregivers.last_name`. Does **not** include `legalId` (SSN) or `birthDate` — those come from the Phase 6 hosted onboarding flow. There is no `caregivers.hire_date` column to read from; the actual hire date is set later by the Phase 3+ promotion automation when the first non-cancelled shift completes.
- `src/lib/paychex/__tests__/workerMapping.test.js` — Vitest coverage for every caregiver field that maps to a Worker field, null/undefined handling, special characters in names, the `default_pending_hire_date_offset_days` calculation (e.g., reference date 2026-04-25 + 14 days → effectiveDate 2026-05-09), missing optional name fields (no middleName, no preferredName), and the `rehire_detected` branch that fires when a Paychex `currentStatus.statusType = TERMINATED` is seen on PATCH.

UI: a dev-only sync button is **not** added to the caregiver detail view in this phase. Verification happens via direct edge function invocation. UI lives in Phase 6.

Exit criteria: a designated test caregiver ("Test Caregiver — Do Not Pay") can be synced to Paychex via the edge function and the resulting Worker shows up in Paychex App Hub with `IN_PROGRESS` / `PENDING_HIRE` status. Sync status fields populate correctly. All API calls visible in `paychex_api_log`. Tests for the mapping function pass with ≥90% coverage. 423 handling verified via dry-run injection.

Rollback: revert the PR. The edge function ceases to exist; existing caregiver data is unchanged. The `paychex_worker_id` column on `caregivers` from Phase 1 stays — it is just unused. To clean up the test caregiver in Paychex Flex itself, the back-office user deletes it manually via the Paychex UI (Paychex's Worker DELETE endpoint is in the docs but we never need to call it from our side).

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
- **Trusting a `workerId` returned in a 423 "client account locked" response.** Paychex docs explicitly warn that 423 responses may include a `workerId` that is invalid. The shared client must drop any such ID on the floor and never persist it; the sync state machine moves to `error` and the cron retries later.
- **Defaulting Paychex requests to `Accept: application/json`.** Every Paychex endpoint requires a vendor-specific media type (`application/vnd.paychex.<resource>.v1+json`). Generic `application/json` may return ambiguous shapes or different field sets. The shared client refuses to send a request without an explicit vendor media type.
- **Hardcoding TC's `companyId` (the long alphanumeric).** That value is per-org and is discovered from Paychex's `/companies` endpoint. The 8-digit `display_id` (`70125496`) is also per-org. Both belong in `organizations.settings.paychex`, never in source.
- **Treating Paychex webhook deliveries as exactly-once.** Paychex retries failed deliveries every 5 minutes until 2XX. Our `paychex-webhook` edge function (Phase 5) must dedupe by Paychex's event identifier (logged in `paychex_api_log`) and treat repeat deliveries as no-ops.

## Testing strategy

- **Pure-function unit tests** for `overtimeRules.js`, `timesheetBuilder.js`, `workerMapping.js`, `exceptions.js`. Vitest. Aim ≥90% line coverage on business logic.
- **OT case matrix** (minimum 30 cases): standard week; daily OT thresholds (8h, 12h); weekly OT (40h); 7th consecutive day; rest day breaks; split shifts; shifts spanning midnight; daylight saving spring-forward and fall-back; missing clock-out; rate change mid-period; mileage with no hours; high-mileage anomaly.
- **Mapping function tests** for every caregiver field that maps to a Paychex Worker field, including null-handling and special characters.
- **RLS smoke tests** in a dedicated test migration that creates a second org and verifies a JWT for that org cannot read TC's payroll data.
- **End-to-end manual test plan** documented in the runbook (out of scope for this doc — created during Phase 4).
- **Sandbox-equivalent validation period**: two weeks of `PAYCHEX_DRY_RUN=true` against real shift data before any production submission. Owner spot-checks totals against current process.

## Open questions for the owner

These need owner input before or during the relevant phase. Listed in the order they become blocking.

1. **Paychex Flex manual entry column format**: owner shares a screenshot of the Paychex Flex manual payroll entry screen so Phase 4's CSV export columns match exactly. Affects `src/lib/payroll/csvExport.js`. Not blocking until Phase 4.
2. **Notification recipients**: which users receive the Monday "payroll ready to review" email? All `admin` + `member` role users in the org by default; owner can override at Phase 4.
3. **Test caregiver setup**: owner creates the "Test Caregiver — Do Not Pay" record in Paychex Flex before Phase 2 begins. Per the API behavior, we'll then run Phase 2's sync against that caregiver as the first end-to-end exercise.
4. **Paychex rep status (Phase 5 only)**: track the Payroll and Check API scope request. Phase 5 cannot start until the scope is enabled. The integration ships full value via Phase 4's CSV export without Phase 5.

**Resolved during the 2026-04-25 docs audit (no longer open):**
- ~~Paychex submission cutoff timing~~ — moved to Phase 5 design when that scope is granted.
- ~~Per-org credential storage approval~~ — Paychex auth is partner-level; per-org persistence decision returns to retrofit Phase C.
- ~~Vendor media type per endpoint~~ — confirmed required; client takes media type per call.
- ~~POST workers body shape~~ — array of worker objects; client wraps single worker in `[...]`.
- ~~PATCH worker URL~~ — `/workers/{workerId}`, no companyId in path.
- ~~423 handling~~ — never trust `workerId` from 423 response; documented in client and anti-patterns.
- ~~`employmentType` for TC~~ — all `FULL_TIME` (TC hires every caregiver as full-time even though hours functionally vary).

**Resolved 2026-04-25 in Phase 1 design conversation with owner:**
- ~~Pay period boundaries~~ — Mon→Sun workweek, Monday processing, **Wednesday** pay date. Seed migration writes this; Phase 4 Settings UI lets the back office change it without a redeploy.
- ~~Mileage rate~~ — **$0.725/mi**. Seed migration writes this; Phase 4 Settings UI lets the back office change it (e.g., when the IRS standard rate updates).
- ~~`hire_date` field on caregivers~~ — there isn't one and we are deliberately not adding one. New Paychex workers get `IN_PROGRESS / PENDING_HIRE` with `effectiveDate = today + default_pending_hire_date_offset_days` (default 14, configurable per org). The actual hire date is captured by the Phase 3+ promotion automation when the first non-cancelled shift completes; that PATCHes Paychex to `ACTIVE / HIRED` with the shift date.
- ~~Pre-shift Paychex onboarding~~ — yes, supported. The two-stage worker lifecycle (IN_PROGRESS → ACTIVE) lets Phase 6's Paychex-hosted W-4/I-9/direct-deposit flow run before the caregiver's first shift.
- ~~Rehire frequency~~ — rare for TC. Sync function returns a structured `rehire_detected` error and the back office reactivates manually in Paychex Flex; we automate it later if frequency increases.
- ~~Monday cron timing~~ — Phase 3's timesheet-generation cron runs at Monday 6 AM Pacific. Owner-confirmed acceptable.

## Immediate next actions

In strict order. Do not proceed past a step until it succeeds.

1. **Owner (in parallel, non-blocking)**: email Paychex rep to enable Payroll and Check API scope on the existing Caregiver Portal app in App Hub. Reference Company ID 70125496. This unblocks Phase 5 (optional enhancement) only — the integration ships full value without it.
2. **Owner**: confirm `PAYCHEX_CLIENT_ID` and `PAYCHEX_CLIENT_SECRET` are set in Supabase Edge Functions secrets (Project Settings → Edge Functions → Secrets). **Done.** Initial secret was rotated during Phase 0 verification (the original was rejected by Paychex with `Bad credentials`; the regenerated secret authenticated successfully on first try).
3. **Claude**: open a PR from `claude/paychex-multi-org-refactor-lpDA8` containing the docs revisions (this plan + the SAAS_RETROFIT_STATUS update). Owner reviews and merges. **Done** (PR #205, merged 2026-04-25).
4. **Claude**: on a fresh branch off `main` after step 3 merges, implement Phase 0 (Paychex diagnostic edge function). One-PR scope. Owner triggers the function via the Supabase Dashboard once after merge and pastes the JSON output back. The output supplies the `companyId` value for the Phase 1 seed migration. **Done** (PR #207, merged 2026-04-25). Captured `companyId = 00M9LQF7LUBLSED1THE0`, scopes `api-delegation ext-api read:company_people write:company_people`, 83 workers in Paychex. Worker schema observations recorded above under "Phase 0 results."
5. **Owner**: answer questions about pay period boundaries, mileage rate, hire-date semantics, pre-shift onboarding, and rehire frequency. **Done 2026-04-25** — answers captured under "Resolved 2026-04-25 in Phase 1 design conversation with owner" above.
6. **Claude**: on a fresh branch off `main`, implement Phase 1 (Paychex data model + seed migration). One-PR scope. Reviewed against the multi-tenancy checklist. The PR also deletes `supabase/functions/paychex-diagnostic/` (its purpose was to discover the `companyId` that this seed migration now persists permanently) and instructs the owner to remove the `PAYCHEX_DIAGNOSTIC_TOKEN` Edge Function secret after merge. After merge, owner triggers `Deploy Database Migrations` workflow (dry-run first, then apply). **In progress now.**
7. **Owner**: create the "Test Caregiver — Do Not Pay" record in Paychex Flex (open question 5). Required before step 8 can verify end-to-end.
8. **Claude**: on a fresh branch, implement Phase 2 (Paychex client + worker sync). One-PR scope. After merge and deploy, owner invokes `paychex-sync-worker` against the test caregiver. Verify the Worker record appears in Paychex Flex with `IN_PROGRESS` / `PENDING_HIRE` status.
9. **Claude**: on a fresh branch, implement Phase 3 (timesheet generation + OT engine). Run the cron in shadow mode for 1-2 weeks; owner spot-checks produced drafts against actual TC payroll for those weeks.
10. **Claude**: on a fresh branch, implement Phase 4 (approval UI + CSV export). **At this point the integration is operationally complete.** Back office runs 1-2 cycles end-to-end: review, approve, export CSV, manually enter into Paychex, mark as paid. Catches any UX issues.
11. **Bake**: 2-4 weeks of weekly payroll runs through the Phase 4 CSV path before considering Phase 5. Confirms numbers match Paychex's processing penny-for-penny in real conditions.
12. **Owner (only if Paychex enables the scope)**: confirm Paychex Payroll API scope is enabled.
13. **Claude (only if step 12 happens)**: implement Phase 5 (direct API submission + webhook). Run two pay periods in dry-run alongside the CSV export (compare line-by-line). Owner reviews Preview output. On owner sign-off, flip `PAYCHEX_DRY_RUN` off and submit one real payroll run.
14. **Claude**: implement Phase 6 (W-2 onboarding flow) for the next new hire. Can run in parallel with Phase 5 or independently — neither blocks the other.

After Phase 4 ships, this document graduates to `docs/runbooks/payroll-runbook.md` (a new doc covering day-to-day operation of the CSV export workflow, exception handling, and what-to-do-when scenarios). The runbook is updated again if/when Phase 5 ships.

