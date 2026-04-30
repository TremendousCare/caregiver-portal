# Invoicing — architecture and rollout plan

The portal generates client invoices weekly from completed shifts and
exports them to QuickBooks via CSV. This document captures the data
model, the math, and the phased rollout. It is the single source of
truth for invoicing — Phase 2/3/4 work updates this file as it ships.

## Status

**Phase 1 — Foundation** (this PR). Adds the schema (`invoices`,
`invoice_shifts`, `invoice_runs`, plus three additive columns on
`clients`), the pure-function `buildInvoice` math engine + tests, the
read-only "This Week" preview tab in Accounting, and the
`features_enabled.invoicing` flag turned on for Tremendous Care.
**Nothing is persisted in invoicing tables yet.** The preview rebuilds
the rollup live each time the tab opens.

Phases 2 → 4 are unstarted. See "Rollout plan" below.

## Data model

### Additive columns on `clients`

```sql
default_billable_rate    numeric(10,2)   -- nullable; client-level fallback
default_billable_ot_rate numeric(10,2)   -- nullable; per-client OT rate
payer_type               text            -- nullable; freeform: private_pay,
                                         -- medicaid, ltc_insurance, va, other
```

Per-shift `billable_rate` (on `shifts`) remains the primary source of
truth. The new client columns provide a fallback when a shift's rate
is not set, and the OT rate column lets a client charge a non-1.5×
overtime premium.

### `invoices`

One row per (org, client, billing period). Mirrors `timesheets` —
same status ladder, same audit columns:

```
draft → pending_approval → approved → exported → sent → paid
                                      ↘ rejected ↘ blocked
```

Snapshotted at draft time:
- `regular_hours`, `overtime_hours`, `double_time_hours`
- `regular_rate` (NULL when shifts have varying rates → "Mixed" UI)
- `ot_rate`
- `subtotal`, `total` (equal in v1; tax/discount land on the same
  fields in a future phase without breaking the wire)

Audit columns: `approved_by/at`, `exported_at`, `sent_at`, `paid_at`,
`last_edited_by/at/reason`, `block_reason`, `notes`.

Unique constraint: `(org_id, client_id, billing_period_start)`.

### `invoice_shifts`

Junction from invoice → shift. Snapshots `hours_worked`,
`hour_classification` (regular | overtime | double_time), and
`billable_rate_applied` so a later edit to `shifts.billable_rate` does
not retroactively rewrite an issued invoice.

Tenant isolation is inherited via the parent invoice (subquery RLS),
so we cannot get into a state where the junction's org disagrees with
its parent — same pattern as `timesheet_shifts`.

### `invoice_runs`

Batch wrapper for a billing cycle's exported set. Mirrors
`payroll_runs` nearly 1:1: one row per (org, billing_period_start,
invoice_date), `status`, `export_mode` (`csv_export` for the QBO path
today, `qbo_api` reserved for a future direct-integration mode),
`csv_export_url`, `total_hours`, `total_amount`.

## Tenant isolation

Every invoicing table satisfies the SaaS retrofit Phase B
prime directives (CLAUDE.md → "Strategic Context: Becoming
Multi-Tenant SaaS"):

1. `org_id uuid NOT NULL DEFAULT public.default_org_id() REFERENCES
   organizations(id)`.
2. Index on `org_id`.
3. Four `tenant_isolation_<table>_<select|insert|update|delete>`
   permissive policies with the strict, fail-closed predicate
   `org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid`.
4. `service_role_full_access_<table>` policy so the Phase 2 cron and
   edge functions can write via the service role.

## Invoice math (`src/lib/invoicing/invoiceBuilder.js`)

Pure function. Takes `{ orgId, client, billingPeriodStart,
billingPeriodEnd, shiftLineItems[] }` and returns
`{ invoice, invoice_shifts, exceptions, meta }` (or `null` for an
empty period).

Rate resolution per shift, in priority order:
1. `shifts.billable_rate` (per-shift override).
2. `clients.default_billable_rate` (client-level fallback).
3. → emit `client_missing_rate` block exception.

OT rate (applies to overtime + double_time hours):
1. `clients.default_billable_ot_rate` (per-client OT rate).
2. → 1.5 × resolved regular rate, plus a `client_missing_ot_rate`
   warn exception.

Hour classification (regular / overtime / double_time) is sourced
from `timesheet_shifts` when available so caregiver-OT and
client-billing-OT stay aligned. When the upstream timesheet has not
yet been generated, the preview falls back to scheduled duration as
regular hours; the row is flagged in `meta.missingClassificationShiftIds`
and the UI shows a "preview is provisional" cue.

Double-time hours bill at the OT rate in v1. A separate DT rate can
be added additively if a future client requires it.

## Phased rollout

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Foundation: schema, math engine + tests, read-only preview UI, feature flag on for Tremendous Care | **In progress (this PR)** |
| 2 | Cron + draft persistence + approval workflow (mirrors payroll: weekly Wednesday cron, per-row inline edits, "Approve All Clean", `block` exceptions gate approval) | Not started |
| 3 | Generate Invoice Run + QuickBooks CSV export. Per-org invoice numbering via an `org_invoice_sequences` helper table. | Not started |
| 4 | Native payment tracking (`invoice_payments`, mark-as-paid, partial payments, aging report) | Deferred — only if you decide to leave QBO as the A/R system of record |

Future, deferred work:
- Medicaid authorizations and EVV-formatted claim CSV.
- Per-service-type rate cards (different rates for personal care vs
  companion vs live-in on the same client).
- Auto-email invoices to clients (PDF generation).
- Stripe Connect for native card payments.
- Direct QuickBooks Online API integration (`export_mode = 'qbo_api'`
  on `invoice_runs`).

## Conventions to honor when extending

1. **Every new invoicing query filters by `org_id` explicitly.** The
   B2b RLS policies enforce isolation at the DB layer, but the
   explicit filter is a second line of defense and necessary today
   (the older permissive policies still grant in parallel until the
   B5 cleanup).
2. **Snapshot, don't recompute.** When an invoice is approved, every
   rate / hour / classification used to compute its total is
   snapshotted onto the invoice row and its junction rows. Later
   edits to the underlying client / shift do not retroactively
   rewrite an issued invoice. This is the same pattern payroll uses
   and is non-negotiable for an audited financial system.
3. **Schema is additive.** New status values, new exception codes, new
   columns. Never `DROP` and never `DELETE` rows as part of a feature
   PR. Schema changes follow the standard
   `nullable → backfill → NOT NULL` ladder for any tightening.
4. **The math is in pure functions.** UI components and cron edge
   functions both consume `buildInvoice`; nothing in
   `src/lib/invoicing/` reaches the network. New tests live in
   `src/lib/invoicing/__tests__/`.
