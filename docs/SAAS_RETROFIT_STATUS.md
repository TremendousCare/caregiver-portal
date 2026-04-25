# SaaS Retrofit — Status Tracker

**Full plan**: `docs/SAAS_RETROFIT.md`
**Prime directives**: `CLAUDE.md` → "Strategic Context: Becoming Multi-Tenant SaaS"

This file is the living tracker. Update it in the same PR that advances the retrofit. Keep it short and scannable — a new contributor should be able to see in ten seconds where the retrofit stands today.

---

## Current phase

**Between Phase A (shipped) and Phase B (not yet started).**
**Phase A** shipped 2026-04-23 via PR #186 (`claude/phase-a-auth-foundation-M94Sk`); access token hook enabled in Supabase Dashboard; every staff and caregiver JWT now carries `org_id`, `org_slug`, `org_role`. Bake period clean — no auth-related incidents reported.
**Phase B** is targeted to begin within the week.
**In flight (counts toward Phase C kickoff)**: Paychex Phase 1.5 — `getOrgSecret(orgId, secretName)` helper, `org_secrets` table, `get_org_secret` RPC, with RingCentral as the conversion proof-of-pattern. Tracked in `docs/plans/2026-04-25-paychex-integration-plan.md`. This pioneers retrofit Phase C's per-org secret pattern without waiting for full Phase C kickoff, because the Paychex worker-sync work needs it.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| A | Auth foundation | Shipped | 2026-04-23 | PR #186; `organizations`, `org_memberships`, JWT hook live |
| B | Tenant isolation on every table | Not started | — | `org_id` + RLS, one table at a time. Targeted to begin within the week. |
| C | Per-org secrets and integrations | In flight (partial) | — | `getOrgSecret` + `org_secrets` table piloted via Paychex Phase 1.5 with RingCentral as first consumer |
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
- ~~Vault entries vs `org_secrets` table~~ — locked: **Supabase Vault holds the secret values**, mirroring the existing `communication_routes` + `get_route_ringcentral_jwt` pattern. A small `org_secrets` table holds the `(org_id, secret_name) → vault_secret_name` mapping for auditability and listing — but no ciphertext. Read access is via `public.get_org_secret(p_org_id uuid, p_secret_name text)` SECURITY DEFINER RPC, service-role only. Set/clear go through admin-only SECURITY DEFINER RPCs. TC env-var fallback is gated inside `get_org_secret` to `org_id = (SELECT id FROM organizations WHERE slug = 'tremendous-care')`. Decision made at Paychex Phase 1.5 kickoff (2026-04-25) after auditing the existing pattern. Moves to "Decisions locked" once Phase 1.5 ships.
- Multi-org membership before launch, or defer
- Concrete `features_enabled` SKUs
- Pricing tiers

---

## Shipped PRs

| Date | PR | Phase | Summary |
|------|----|----|---------|
| 2026-04-23 | #186 | A | Auth foundation: `organizations`, `org_memberships`, `custom_access_token_hook`, AppContext plumbing for `currentOrgId`/`currentOrgSlug`/`currentOrgRole`. Hook enabled in Supabase Dashboard post-merge. |
| 2026-04-25 | #201 | — | Plan documentation for the Paychex Flex W-2 payroll integration (`docs/plans/2026-04-25-paychex-integration-plan.md`). Not a retrofit phase change, but the integration's Phase 1.5 contributes the per-org secret pattern that Phase C will generalize. |

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one.
- **Decision locked**: move from "still open" to the locked list in `docs/SAAS_RETROFIT.md`, summarize here.

The retrofit is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
