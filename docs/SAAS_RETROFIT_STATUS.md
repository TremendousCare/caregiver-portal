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
- ✅ **B2a shipped 2026-04-30 via PR #235** — membership integrity. Backfilled `org_memberships` for the 4 active users created since Phase A's one-time backfill (1 staff admin, 2 PWA caregivers, 1 unknown) and installed an `AFTER INSERT ON auth.users` trigger that auto-creates a membership pointing to `tremendous-care` for every future signup. Closes the leak that would otherwise lock new users out at B5 enforcement.
- ✅ **B2b shipped 2026-04-30 via PR #236 + hotfix PR #237** — added 160 org-scoped permissive RLS policies (`tenant_isolation_<table>_<select|insert|update|delete>`) on the 40 in-scope B1 tables, alongside the existing permissives. Skips `email_accounts` and `email_routing` (RLS enabled, zero policies, service-role-only — a permissive policy there would *open* access). Strict / fail-closed predicate `org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid`. Pure additive: TC's existing `is_staff()` / `current_user_caregiver_id()` policies still grant in parallel, so behavior is unchanged today; the new policies become the only enforcers when permissives drop in B5. **Bake started 2026-04-30**, target B3 kickoff 2026-05-05 to 2026-05-07.
  - **Hotfix lesson**: the original sanity check used `polname LIKE 'tenant_isolation\_%'` which caught 4 pre-existing Paychex policies (`tenant_isolation_payroll_runs`, `_timesheets`, `_timesheet_shifts`, `_payroll_exports_read`) and aborted the deploy with `expected 160, found 164`. Postgres rolled the transaction back cleanly — production was never modified. PR #237 tightened every B2b filter (migration sanity check, rollback drop loop, verify SQL) to a suffix-anchored regex `^tenant_isolation_.*_(select|insert|update|delete)$`. **Lesson locked**: any future B5/B-cleanup work must use the same suffix-anchored filter, never a prefix-only `LIKE`. Vitest spec asserts the regex form is present so a regression cannot ship.
- ⏳ B3 — update edge functions, cron jobs, and frontend insert paths to set `org_id` explicitly. Audit the one user-JWT edge function (`paychex-backfill-employee-ids`). Add `org_id` to events-table writes. Opens after B2b bakes ≥5 days clean.
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
| B | Tenant isolation on every table | In progress | — | `org_id` + RLS, one table at a time. Kickoff 2026-04-26. B1 shipped 2026-04-28 (PR #218); B2a shipped 2026-04-30 (PR #235); B2b shipped 2026-04-30 (PR #236 + hotfix #237) — bake to 2026-05-05/07. B3 (edge function org-scoping) next. |
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
- **B2b policy naming and filter pattern** (locked 2026-04-30 after hotfix PR #237): every B2b policy is named `tenant_isolation_<table>_<select|insert|update|delete>`. Every WHERE clause that targets B2b policies — sanity checks, rollback scripts, verification SQL, and any future B5 cleanup — uses the suffix-anchored regex `^tenant_isolation_.*_(select|insert|update|delete)$`, **never** a prefix-only `LIKE 'tenant_isolation\_%'`. Reason: the Paychex payroll work shipped four pre-existing `tenant_isolation_*` policies without per-command suffixes; the broader filter caught them and either inflated counts or (in the rollback case) would have dropped them. Vitest specs assert the regex form so a regression cannot ship.

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
| 2026-04-30 | #235 | B2a | Membership integrity: backfilled `org_memberships` for 4 orphan users (created post-Phase-A) and installed an `AFTER INSERT ON auth.users` trigger so every future signup gets a membership pointing to `tremendous-care`. SECURITY DEFINER + locked search_path + explicit `EXECUTE` grant to `supabase_auth_admin`. Migration aborts deploy if any active user is left without a membership. Verified post-deploy: zero orphans, trigger fires for new caregivers, Juliana's JWT now carries `org_id`. |
| 2026-04-30 | #236 | B2b | Org-scoped permissive RLS policies (`tenant_isolation_<table>_<select\|insert\|update\|delete>`) on the 40 in-scope B1 tables, alongside the existing permissives. 160 policies (40 × 4 commands). Strict / fail-closed predicate `org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid`. Skips `email_accounts` and `email_routing` (zero-policy / service-role-only — adding a permissive policy would have *opened* access). Pure additive: behavior unchanged today; new policies become the only enforcers in B5. Initial deploy aborted on a sanity-check false-positive — see hotfix PR #237. |
| 2026-04-30 | #237 | B2b (hotfix) | Tightened the `tenant_isolation_*` filter in the B2b sanity check, rollback script, and verify SQL from a prefix-only `LIKE 'tenant_isolation\_%'` to a suffix-anchored regex `^tenant_isolation_.*_(select\|insert\|update\|delete)$`. Original filter wrongly counted 4 pre-existing Paychex policies (`tenant_isolation_payroll_runs`, `_timesheets`, `_timesheet_shifts`, `_payroll_exports_read`) → guard fired, transaction rolled back, production untouched. Same broad filter shipped in the rollback script — would have **dropped the Paychex policies** if ever run; latent foot-gun closed. Vitest spec now asserts the regex form to prevent regression. Verified post-deploy: 160 B2b policies present, all pre-existing policies (incl. Paychex) intact, all functional smoke tests green. |

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one.
- **Decision locked**: move from "still open" to the locked list in `docs/SAAS_RETROFIT.md`, summarize here.

The retrofit is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
