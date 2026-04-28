# SaaS Retrofit — Status Tracker

**Full plan**: `docs/SAAS_RETROFIT.md`
**Prime directives**: `CLAUDE.md` → "Strategic Context: Becoming Multi-Tenant SaaS"

This file is the living tracker. Update it in the same PR that advances the retrofit. Keep it short and scannable — a new contributor should be able to see in ten seconds where the retrofit stands today.

---

## Current phase

**Phase B — Tenant isolation on every table.**
**Status**: In progress (kickoff 2026-04-26).
**Phase A** shipped 2026-04-23 via PR #186 (`claude/phase-a-auth-foundation-M94Sk`); access token hook enabled in Supabase Dashboard; every staff and caregiver JWT now carries `org_id`, `org_slug`, `org_role`. Bake period clean — no auth-related incidents reported.
**Phase B kickoff scope**: add `org_id uuid REFERENCES organizations(id)` to every tenant-sensitive table, backfill, set `NOT NULL` with a Tremendous-Care default, then tighten RLS one domain at a time. Sliced into ~5 PRs (B1: schema columns + backfill; B2: org-scoped RLS alongside existing policies; B3: edge functions + cron + frontend insert paths; B4: cross-tenant test harness; B5: drop permissive policies, sliced by domain). See `docs/SAAS_RETROFIT.md` → "Phase B" for the per-table pattern.
**In flight (independent of the retrofit phases)**: Paychex Flex payroll integration (`docs/plans/2026-04-25-paychex-integration-plan.md`). After the 2026-04-25 audit of `developer.paychex.com`, the integration was confirmed to use **partner-level OAuth credentials** that do not require per-org secret storage — Paychex no longer pioneers Phase C. Per-org secret persistence (Vault vs `org_secrets` table) returns to retrofit Phase C kickoff for a coherent decision across RingCentral, DocuSign, Microsoft, and Anthropic.
**Paychex integration progress**: Phases 0, 1, 2, 3 shipped (PRs #207, #211, #212, #216). Phase 3 cron auto-fired 2026-04-27 producing first real drafts; engine math verified by hand. Phase 4 (Approval UI + CSV export) starting in a fresh chat — handoff doc at `docs/handoff-paychex-phase-4.md`.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| A | Auth foundation | Shipped | 2026-04-23 | PR #186; `organizations`, `org_memberships`, JWT hook live |
| B | Tenant isolation on every table | In progress | — | `org_id` + RLS, one table at a time. Kickoff 2026-04-26. Sliced into ~5 PRs. |
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
- **Phase B `org_id` column default**: `DEFAULT (SELECT id FROM organizations WHERE slug = 'tremendous-care')` — subselect, not a hardcoded UUID literal. Locked 2026-04-26.
- **Phase B default lifecycle**: keep through Phases B–D for single-tenant safety; **drop in Phase E** when explicit `org_id` becomes mandatory on every insert path. Locked 2026-04-26.
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

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one.
- **Decision locked**: move from "still open" to the locked list in `docs/SAAS_RETROFIT.md`, summarize here.

The retrofit is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
