# SaaS Retrofit — Status Tracker

**Full plan**: `docs/SAAS_RETROFIT.md`
**Prime directives**: `CLAUDE.md` → "Strategic Context: Becoming Multi-Tenant SaaS"

This file is the living tracker. Update it in the same PR that advances the retrofit. Keep it short and scannable — a new contributor should be able to see in ten seconds where the retrofit stands today.

---

## Current phase

**Between Phase A (shipped) and Phase B (not yet started).**
**Phase A** shipped 2026-04-23 via PR #186 (`claude/phase-a-auth-foundation-M94Sk`); access token hook enabled in Supabase Dashboard; every staff and caregiver JWT now carries `org_id`, `org_slug`, `org_role`. Bake period clean — no auth-related incidents reported.
**Phase B** is targeted to begin within the week.
**In flight (independent of the retrofit phases)**: Paychex Flex payroll integration (`docs/plans/2026-04-25-paychex-integration-plan.md`). After the 2026-04-25 audit of `developer.paychex.com`, the integration was confirmed to use **partner-level OAuth credentials** that do not require per-org secret storage — Paychex no longer pioneers Phase C. Per-org secret persistence (Vault vs `org_secrets` table) returns to retrofit Phase C kickoff for a coherent decision across RingCentral, DocuSign, Microsoft, and Anthropic.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| A | Auth foundation | Shipped | 2026-04-23 | PR #186; `organizations`, `org_memberships`, JWT hook live |
| B | Tenant isolation on every table | Not started | — | `org_id` + RLS, one table at a time. Targeted to begin within the week. |
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
