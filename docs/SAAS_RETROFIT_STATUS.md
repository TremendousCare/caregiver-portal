# SaaS Retrofit — Status Tracker

**Full plan**: `docs/SAAS_RETROFIT.md`
**Prime directives**: `CLAUDE.md` → "Strategic Context: Becoming Multi-Tenant SaaS"

This file is the living tracker. Update it in the same PR that advances the retrofit. Keep it short and scannable — a new contributor should be able to see in ten seconds where the retrofit stands today.

---

## Current phase

**Phase B — Tenant isolation on every table.**
**Status**: In progress (kickoff 2026-04-26).
**Phase A** shipped 2026-04-23 via PR #186 (`claude/phase-a-auth-foundation-M94Sk`); access token hook enabled in Supabase Dashboard; every staff and caregiver JWT now carries `org_id`, `org_slug`, `org_role`. Bake period clean — no auth-related incidents reported.
**Phase B progress** (sliced into ~5 PRs):
- ✅ **B1 shipped 2026-04-28 via PR #218** — `org_id` column + backfill + index on 42 tenant-sensitive tables, plus `public.default_org_id()` helper for the column DEFAULT. Pure additive schema; no behavior change.
- ⏳ **B2 next** — add org-scoped RLS policies alongside the existing permissive ones. Targeted to open after a short B1 verification window (1–3 days) on `main`.
- ⏳ B3 — update edge functions, cron jobs, and frontend insert paths to set `org_id` explicitly.
- ⏳ B4 — cross-tenant test harness: provision a real second org (e.g., `acme-test`) and verify isolation.
- ⏳ B5 — drop the permissive policies, sliced by domain. This is the only PR that flips real enforcement; each slice bakes 5–7 days before the next.

See `docs/SAAS_RETROFIT.md` → "Phase B" for the per-table pattern.
**In flight (independent of the retrofit phases)**: Paychex Flex payroll integration (`docs/plans/2026-04-25-paychex-integration-plan.md`). After the 2026-04-25 audit of `developer.paychex.com`, the integration was confirmed to use **partner-level OAuth credentials** that do not require per-org secret storage — Paychex no longer pioneers Phase C. Per-org secret persistence (Vault vs `org_secrets` table) returns to retrofit Phase C kickoff for a coherent decision across RingCentral, DocuSign, Microsoft, and Anthropic.
**Paychex integration progress**: Phases 0, 1, 2, 3 shipped (PRs #207, #211, #212, #216). Phase 3 cron auto-fired 2026-04-27 producing first real drafts; engine math verified by hand. Phase 4 (Approval UI + CSV export) starting in a fresh chat — handoff doc at `docs/handoff-paychex-phase-4.md`.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| A | Auth foundation | Shipped | 2026-04-23 | PR #186; `organizations`, `org_memberships`, JWT hook live |
| B | Tenant isolation on every table | In progress | — | `org_id` + RLS, one table at a time. Kickoff 2026-04-26. B1 (columns + backfill) shipped 2026-04-28 via PR #218; B2 (RLS) next. |
| C | Per-org secrets and integrations | Not started | — | Generalize `communication_routes` pattern. Decision (Vault vs `org_secrets` table) deferred to phase kickoff; Paychex does not require this work. |
| D | Configurable phases, branding, feature toggles | Not started | — | `pipeline_phases`, `organizations.settings` |
| E | Onboarding, compliance, billing | Not started | — | Signup, BAA, admin console, manual QBO |

Bake at least 5–7 days on `main` between phases.

---

## Decisions locked

Authoritative list lives in `docs/SAAS_RETROFIT.md` under "Decisions locked." Summary:

- Tremendous Care's slug: `tremendous-care`
- Role vocabulary: `admin | member | caregiver`
- One user = one org at launch
- Row-based tenancy, single Supabase project, RLS enforcement
- Managed SaaS only; subdomain per customer
- Manual QuickBooks invoicing at launch
- **Phase B `org_id` column default**: `DEFAULT public.default_org_id()` — a `STABLE` SQL helper returning the Tremendous Care id, not a hardcoded UUID literal and not a raw subquery (PG forbids subqueries in column DEFAULT clauses). Locked 2026-04-26, revised same day after PR review.
- **Phase B default lifecycle**: keep through Phases B–D for single-tenant safety; **drop the per-table defaults *and* the `public.default_org_id()` helper in Phase E** when explicit `org_id` becomes mandatory on every insert path. Locked 2026-04-26.
- **Phase B RLS posture**: strict / fail-closed. New policies are `USING (org_id = (auth.jwt() ->> 'org_id')::uuid)` — a missing claim denies. Edge functions using `service_role` bypass RLS unchanged; user-JWT edge calls are audited in PR B3. Locked 2026-04-26.
- **Phase B test harness location**: a real second org (`acme-test` or similar) is provisioned in production `organizations` to validate cross-tenant isolation. No `is_test_org` flag — multi-tenancy is the whole point. Locked 2026-04-26.

---

## Decisions still open

- SaaS product brand name (separate or shared with Tremendous Care)
- **Vault entries vs `org_secrets` table** — re-opened 2026-04-25. The 2026-04-25 Paychex audit revealed Paychex uses partner-level credentials and does not need per-org secret storage, so the decision no longer rides on a Paychex prerequisite. Defer to retrofit Phase C kickoff for a coherent decision across RingCentral, DocuSign, Microsoft, and Anthropic. Working recommendation when that phase begins: extend the existing `communication_routes` + Vault pattern (Vault holds values, a small mapping table holds `(org_id, secret_name) → vault_secret_name`).
- Multi-org membership before launch, or defer
- Concrete `features_enabled` SKUs
- Pricing tiers

---

## Shipped PRs

| Date | PR | Phase | Summary |
|------|----|----|---------|
| 2026-04-23 | #186 | A | Auth foundation: `organizations`, `org_memberships`, `custom_access_token_hook`, AppContext plumbing for `currentOrgId`/`currentOrgSlug`/`currentOrgRole`. Hook enabled in Supabase Dashboard post-merge. |
| 2026-04-25 | #201 | — | Plan documentation for the Paychex Flex W-2 payroll integration (`docs/plans/2026-04-25-paychex-integration-plan.md`). Not a retrofit phase change. (Initially scoped to pioneer Phase C via a `getOrgSecret` helper; revised on 2026-04-25 after the API audit confirmed Paychex auth is partner-level and does not need per-org secret storage.) |
| 2026-04-26 | #217 | B (kickoff) | Phase B kickoff docs: flipped status to In progress, locked 4 architectural decisions (`org_id` default via `public.default_org_id()` helper, default lifecycle through Phase E, strict RLS posture, real-second-org test harness), planned PR slicing. |
| 2026-04-28 | #218 | B1 | Added `org_id uuid REFERENCES organizations(id)` to 42 tenant-sensitive tables: backfilled to Tremendous Care, set `NOT NULL` with `DEFAULT public.default_org_id()`, indexed `org_id` on each. Pure additive schema; no RLS, query, or behavior changes. Codex caught a Postgres-forbids-subquery-in-DEFAULT bug pre-merge; fixed via STABLE helper function. |

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one.
- **Decision locked**: move from "still open" to the locked list in `docs/SAAS_RETROFIT.md`, summarize here.

The retrofit is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
