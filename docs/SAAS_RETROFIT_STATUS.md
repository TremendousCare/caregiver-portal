# SaaS Retrofit — Status Tracker

**Full plan**: `docs/SAAS_RETROFIT.md`
**Prime directives**: `CLAUDE.md` → "Strategic Context: Becoming Multi-Tenant SaaS"

This file is the living tracker. Update it in the same PR that advances the retrofit. Keep it short and scannable — a new contributor should be able to see in ten seconds where the retrofit stands today.

---

## Current phase

**Phase A — Auth foundation**
**Status**: In progress
**Target**: Weeks 1–2 of the retrofit
**Open PR**: `claude/phase-a-auth-foundation-M94Sk` — introduces `organizations` + `org_memberships` tables, `public.custom_access_token_hook`, and AppContext plumbing (`currentOrgId`/`currentOrgSlug`/`currentOrgRole`). Scaffolding only; no behavior change. Requires manual Supabase Dashboard step to enable the hook after merge.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| A | Auth foundation | In progress | — | `organizations`, `org_memberships`, JWT hook |
| B | Tenant isolation on every table | Not started | — | `org_id` + RLS, one table at a time |
| C | Per-org secrets and integrations | Not started | — | Generalize `communication_routes` pattern |
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
- Vault entries vs `org_secrets` table
- Multi-org membership before launch, or defer
- Concrete `features_enabled` SKUs
- Pricing tiers

---

## Shipped PRs

*(None yet. First entry below will be the documentation PR that establishes this plan.)*

| Date | PR | Phase | Summary |
|------|----|----|---------|
| — | — | — | — |

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one.
- **Decision locked**: move from "still open" to the locked list in `docs/SAAS_RETROFIT.md`, summarize here.

The retrofit is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
