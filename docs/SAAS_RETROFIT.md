# SaaS Retrofit — Multi-Org Strategy and Implementation Plan

**Status doc**: `docs/SAAS_RETROFIT_STATUS.md` (current phase, decisions locked, PRs shipped)

---

## Purpose of this document

The Tremendous Care caregiver portal is today a single-tenant application used by one home-care agency. We are refactoring it into a multi-tenant SaaS product sold to other home-care agencies while keeping Tremendous Care's production instance stable throughout the transition.

This document is the durable source of truth for that effort. It exists so that any contributor — human or AI — opening the repo can understand the vision, the constraints, and the sequence of work without having to reconstruct them from chat history.

If you are about to make any change touching schema, auth, secrets, branding, pipeline configuration, or cross-entity queries, read this first.

---

## Vision in one paragraph

One codebase, one Supabase project, one deployment, sold as one product with feature toggles. Customer-facing it can appear as "Recruiting Starter / Scheduling Starter / Full CRM" based on per-org `features_enabled` flags, but internally it is the same application with the same data model. Each customer organization is a row in `organizations`; their data is isolated via an `org_id` column on every tenant-sensitive table plus RLS policies that filter on the org_id claim in the user's JWT. Integrations (RingCentral, Microsoft, DocuSign, Anthropic) use per-org secrets stored in Supabase Vault, accessed through the `communication_routes`-style lookup pattern. Hosting is managed SaaS with a subdomain per customer (`{slug}.example.com`), HIPAA-eligible via Supabase Team plan with BAAs in place for all sub-processors.

---

## Why refactor, not rebuild

The accumulated value in the codebase is not in the parts multi-tenancy touches. The hard parts are:

- Scheduling math (conflict detection, availability matching, recurrence expansion, timezone handling) — well-tested in `src/lib/scheduling/`.
- The automation rule engine (`src/lib/automations.js`) and action item engine (`src/lib/actionItemEngine.js`).
- The AI context assembler (`supabase/functions/ai-chat/context/assembler.ts`), event bus, and outcome detection.
- 73+ migrations of schema decisions and 1,293+ tests locking in business behavior.
- Integration gotchas with RingCentral, DocuSign, Microsoft, and Supabase that took real calendar time to discover.

Multi-tenancy, by contrast, is mechanical: add `org_id`, rewrite RLS policies, route secrets per org, make hardcoded config data-driven. A rebuild throws away the hard-won assets to solve a rote problem. A refactor keeps every test and every lesson learned.

The only scenario in which rebuild would be correct is a fundamental architecture change (move off Supabase, different data model, split into services). None of those are warranted.

---

## Non-negotiable rules during the retrofit

These are also listed in `CLAUDE.md` so they load into every session. Duplicated here for completeness:

1. **Production safety first.** Tremendous Care's operations depend on this app. Every schema change is additive. No `DROP`s, no `DELETE`s, no destructive migrations. Columns change state as `nullable → backfilled → NOT NULL → RLS tightened`. Every PR touching schema, auth, or secrets ships with an explicit rollback plan in its description.
2. **Every new table gets `org_id uuid REFERENCES organizations(id)`.** No exceptions.
3. **Every new query is org-scoped.** Either explicit `WHERE org_id = ...` or an RLS policy that enforces it. Never cross-tenant reads.
4. **Every new secret uses the per-org lookup pattern.** See `communication_routes` + the `public.get_route_ringcentral_jwt(p_category TEXT)` RPC (migrations `20260414213447`, `20260414221401`) for the reference. No new single-account env vars for tenant-sensitive integrations.
5. **No new hardcoded Tremendous Care branding, URLs, phases, or pipeline config.** Configurable strings belong in `organizations.settings`.
6. **When in doubt, pause and ask the owner.** Surprise is worse than delay.

---

## Architecture target

### Tenancy model
- Row-based multi-tenancy. Single Supabase project. One database. Every tenant-sensitive table carries `org_id`.
- One user belongs to one org (for now). The design leaves room for a user to belong to multiple orgs later; the current auth hook picks the deterministic first membership by `created_at`.

### Auth
- Supabase Auth (email + password) remains the identity layer.
- A custom access token hook (`public.custom_access_token_hook`) reads the user's row from `org_memberships` and attaches `org_id`, `org_slug`, and `org_role` to every issued JWT.
- Frontend reads the claims from the session token. Edge functions read them from `request.headers.authorization`.
- RLS policies filter using `(auth.jwt() ->> 'org_id')::uuid` as the tenant predicate.

### Role vocabulary
`admin | member | caregiver`. The `user_roles` table stays as-is during the transition (it is authoritative for Tremendous Care). `org_memberships.role` is the new canonical location going forward. `caregiver` covers PWA users linked via `caregivers.user_id`.

### Secrets
- Per-org credentials stored in Supabase Vault, namespaced by org.
- Edge functions look up secrets via an RPC that takes `(org_id, secret_name)` and returns the value. Generalizes the existing `public.get_route_ringcentral_jwt(p_category TEXT)` RPC.
- Fallback to env vars remains during the transition for Tremendous Care only, gated on `org_id = <tremendous_care_uuid>`.

### Hosting and domains
- Managed SaaS. Vercel for frontend, Supabase for DB + auth + edge functions.
- Subdomain per customer: `{slug}.<product-domain>`. DNS via wildcard CNAME, SSL via Vercel's automatic wildcard cert.
- "Bring your own domain" is a later paid-tier feature, not in scope for initial launch.

### Feature gating
- `organizations.settings.features_enabled` is an object such as `{recruiting: true, scheduling: true, crm: true}`.
- Frontend hides navigation and routes for disabled features.
- Edge functions and cron jobs check `features_enabled` before processing an org's data.

### Configurable pipeline phases
- New tables: `pipeline_phases` (per-org, per-pipeline-type, ordered) and `pipeline_phase_tasks`.
- Tremendous Care's current phases in `src/lib/constants.js` become seed data for org #1.
- Frontend consumes phases via a `usePipelineConfig()` hook; no more static `PHASES` imports.
- Phase-related logic (`getCurrentPhase`, `actionItemEngine`, briefing groupings) takes phases as a parameter.

### Observability and audit
- The existing `events` table is 90% of an audit log. Extend it with `org_id` on every event.
- Every tenant-sensitive mutation writes an event with actor, org_id, before/after. This is required for B2B security reviews.

### Compliance
- Supabase Team plan minimum before first paying customer (HIPAA-eligible, BAA available).
- BAAs in place with all sub-processors handling PHI-adjacent data: RingCentral, SendGrid, DocuSign, Microsoft, Anthropic.
- Per-org data export and hard-delete capabilities built into the schema from day one.

---

## Five-phase rollout

Each phase is preceded by a bake period on `main` — at least 5–7 days — before the next phase begins. Phases are sequential, not parallel. Do not start phase N+1 before phase N has shipped and baked.

### Phase A — Auth foundation (Weeks 1–2)

**Goal**: Put `org_id` into every JWT. Change no behavior.

- New migration creates `organizations` and `org_memberships` tables.
- Tremendous Care is seeded as the first (and only) org, slug `tremendous-care`.
- Backfill: every existing `user_roles` entry and every caregiver with a `user_id` gets a membership row.
- New migration creates `public.custom_access_token_hook` that reads membership and adds `org_id`, `org_slug`, `org_role` claims to the JWT.
- Manual step: enable the hook in Supabase Dashboard → Authentication → Hooks.
- `src/shared/context/AppContext.jsx` reads the claims and exposes `currentOrgId`, `currentOrgSlug`, `currentOrgRole`.
- New helper `getOrgClaims()` in `src/lib/supabase.js`.
- Tests for claim parsing.
- **No other code reads `currentOrgId` yet.** Scaffold only.

Exit criteria:
- Every staff and caregiver user logs in and their JWT carries `org_id = <tremendous_care_uuid>`.
- Every existing Tremendous Care flow works unchanged.
- `npm test` green.

Rollback plan:
- Frontend broken: Vercel instant rollback.
- Hook misbehaving: toggle off in Supabase Dashboard; existing sessions unaffected.
- Migration broken: run DOWN script to drop new tables; nothing else depends on them yet.

### Phase B — Tenant isolation on every table (Weeks 3–5)

**Goal**: Add `org_id` to every tenant-sensitive table, backfill, then tighten RLS one table at a time.

- For each target table:
  1. Add `org_id uuid REFERENCES organizations(id)` (nullable).
  2. Backfill with `<tremendous_care_uuid>` for every existing row.
  3. Set `NOT NULL` with a default of `<tremendous_care_uuid>` during transition.
  4. Add a new RLS policy: `USING (org_id = (auth.jwt() ->> 'org_id')::uuid)`.
  5. Keep the existing permissive policy in place during bake (policies OR together).
  6. After bake, drop the permissive policy.

Target tables (incomplete; full list finalized at phase kickoff):
`caregivers`, `clients`, `events`, `context_memory`, `automation_rules`, `automation_log`, `shifts`, `shift_offers`, `care_plans`, `caregiver_availability`, `caregiver_assignments`, `action_outcomes`, `action_item_rules`, `docusign_envelopes`, `esign_envelopes`, `caregiver_documents`, `boards`, `board_cards`, `message_templates`, `communication_routes`, `team_members`, `user_roles`, `survey_templates`, `survey_responses`, `context_snapshots`, `client_sequences`, `client_sequence_enrollments`, `call_transcriptions`, `inbound_sms_log`, `ai_suggestions`, `document_upload_tokens`, `caregiver_surveys`, `email_accounts`, `route_webhook_subscriptions`, `autonomy_config`.

- Update every Supabase query in the frontend contexts (`src/shared/context/*.jsx`) to filter on `org_id` via RLS (no client-side WHERE needed once RLS is enforcing).
- Update every edge function query. Cron jobs (`automation-cron`, `outcome-analyzer`) iterate per-org explicitly.
- Event logging (`supabase/functions/ai-chat/context/events.ts`) includes `org_id` on every event.

Exit criteria:
- Every tenant-sensitive table has `NOT NULL org_id` and an enforcing RLS policy.
- Tremendous Care users see all Tremendous Care data and nothing else (trivially true today because there is only one org).
- Test-harness migration creates a second "test-org" and verifies cross-tenant isolation.

Rollback plan per table: keep the permissive RLS policy in place until the new policy has baked for days. If the new policy misbehaves, the old one takes over. Once stable, drop the permissive policy.

### Phase C — Per-org secrets and integrations (Weeks 6–8)

**Goal**: Replace single-account env vars with per-org Vault lookups for all tenant-sensitive third-party integrations.

- New table `org_secrets` or namespaced Vault entries (decision at phase kickoff).
- RPC `get_org_secret(org_id uuid, secret_name text) returns text` — generalizes `get_route_ringcentral_jwt`.
- Update `supabase/functions/_shared/helpers/ringcentral.ts`, `outlook-integration`, `sharepoint-docs`, `execute-automation`, `ai-chat`, `care-plan-snapshot`, `ai-planner`, `call-transcription`.
- Fallback to env vars gated on `org_id = <tremendous_care_uuid>` — preserves Tremendous Care's current behavior while new orgs use Vault.
- Audit cron jobs for per-org iteration with per-org secrets.

Exit criteria:
- A second (test) org can be provisioned with its own RingCentral JWT, Microsoft secret, DocuSign account, Anthropic key, and send/receive messages/email/e-sign.
- Tremendous Care continues to use existing env vars unchanged.

### Phase D — Configurable phases, branding, feature toggles (Weeks 9–11)

**Goal**: De-hardcode per-org configuration.

- **Pipeline phases as data** — three sub-steps:
  1. Phases as displayable strings (`pipeline_phases` table, seed Tremendous Care, replace `PHASES` imports with `usePipelineConfig()`).
  2. Phase-task associations as data (`pipeline_phase_tasks` table, rewire `actionItemEngine`).
  3. Phase transition rules as data (configurable inputs to the transition evaluator, which stays in code).
- **Branding**: `organizations.settings.branding` holds name, logo URL, portal domain, primary color, email sender name. Frontend reads from context. Edge functions read from org row.
- **Feature toggles**: `organizations.settings.features_enabled`. Frontend navigation and route guards respect it. Edge functions short-circuit for disabled features.

Exit criteria:
- Tremendous Care's UI looks identical (seed data mirrors constants.js).
- A test org with different phases, branding, and a disabled feature renders correctly.

### Phase E — Onboarding, compliance, billing (Weeks 12–14)

**Goal**: Make it sellable.

- Self-serve org signup flow: create org, invite first admin, pick slug, choose plan.
- Team member invite flow: admins invite by email, invitees get a signup link that lands them in the right `org_memberships` row.
- BAA signing flow: before an org can go "live," an admin must accept the BAA. Signature stored in `organizations.settings.baa`.
- Admin console: edit org settings, manage members, view usage.
- Ship with manual QuickBooks invoicing for the first 5–10 customers. Stripe/QBO integration is a future PR.
- Documentation: customer onboarding runbook, security posture doc, HIPAA checklist.
- **Drop the Phase B `org_id` defaults.** The `DEFAULT public.default_org_id()` clause that protected Tremendous Care during Phases B–D becomes a footgun once multiple paying customers exist (any insert path that forgets `org_id` would silently mis-attribute rows to Tremendous Care). Audit every insert path for explicit `org_id`, then `ALTER TABLE … ALTER COLUMN org_id DROP DEFAULT` on every tenant-sensitive table, then `DROP FUNCTION public.default_org_id()`.

Exit criteria:
- A new agency can sign up, be provisioned, invite their team, sign the BAA, and use the product end-to-end without owner intervention (other than optional white-glove onboarding).
- Tremendous Care is "org #1" on the SaaS platform. The `saas` branch has merged back into `main`.

---

## Anti-patterns (do not do)

- **Adding a table without `org_id`.** Even if it "belongs to Tremendous Care obviously." The column is cheap; missing it is expensive.
- **Adding a query without `org_id` scoping.** Either explicit `WHERE` or RLS enforcement. No exceptions.
- **New env var for a tenant-sensitive secret.** Use the per-org lookup pattern. If the pattern doesn't exist for your integration yet, extend it first.
- **New hardcoded string referencing Tremendous Care, `tremendouscareca.com`, specific pipeline phases, or specific users.** Find the configurable home and put it there.
- **`DROP TABLE`, `DROP COLUMN`, `ALTER ... DROP CONSTRAINT`, or `DELETE FROM` during the retrofit.** Additive only. Old unused columns stay until a dedicated cleanup PR after the retrofit is complete.
- **Parallel phase work.** Do not start Phase B before Phase A is shipped and baked. Phases are sequential.
- **Skipping the rollback plan.** Every schema/auth/secrets PR must document rollback in its description.
- **Merging without Vercel preview smoke test.** For schema or auth PRs, explicitly walk Tremendous Care's daily flows on the preview deploy before merging.

---

## Key coupling hot spots to watch

These were identified during initial codebase survey and will need explicit attention during the retrofit:

- **`src/features/caregivers/CaregiverDetail.jsx`** imports `AvailabilityEditor` and `CaregiverSchedulePanel` from scheduling. This couples recruiting UI to scheduling. In Phase D, when `features_enabled` becomes real, this import must be gated.
- **`src/features/scheduling/`** imports `isOnboardingCaregiver` from `src/lib/rosterUtils.js`. One recruiting-aware predicate in the otherwise-clean scheduling module. Generalize in Phase D.
- **`src/lib/automations.js` and `src/lib/actionItemEngine.js`** are shared plumbing used by both recruiting and clients. They must load per-org rules in Phase D.
- **`supabase/functions/ai-chat/context/assembler.ts`** reads all caregivers and clients into the system prompt. At multi-org scale the token budget breaks. Phase B scopes queries by org; longer-term in Phase D, briefings may need to be further narrowed.
- **`automation-cron` and `outcome-analyzer`** iterate all data globally. Phase B must add org-aware iteration — iterate orgs, then within each org iterate rules.

---

## Decisions locked

Tracked here (authoritative) and mirrored in `docs/SAAS_RETROFIT_STATUS.md` for quick reference.

- **Tremendous Care's slug**: `tremendous-care`.
- **Role vocabulary**: `admin | member | caregiver`.
- **User-to-org cardinality**: one user = one org at launch. Auth hook picks deterministic first membership if multiple exist.
- **Tenancy model**: row-based multi-tenancy, single Supabase project, RLS-based isolation.
- **Hosting**: managed SaaS, Vercel + Supabase. No self-hosted option.
- **Domain model**: subdomain per customer initially; BYO-domain later.
- **Billing**: manual QuickBooks invoicing at launch; Stripe/QBO later.
- **Refactor vs rebuild**: refactor.
- **Phase B `org_id` column default** (locked 2026-04-26, revised 2026-04-26 after PR review): `DEFAULT public.default_org_id()` — a `STABLE` SQL function that returns `(SELECT id FROM organizations WHERE slug = 'tremendous-care')`. The original plan to inline the subselect was infeasible: PostgreSQL forbids subqueries inside column DEFAULT clauses (the expression must be variable-free). Function calls *are* allowed and `STABLE` lets PG cache within a statement. Same outcome as the original intent — keeps Tremendous Care's id out of 40+ migration files and resilient to any future identity reissue — without the planner restriction.
- **Phase B default lifecycle** (locked 2026-04-26): the `org_id` default stays through Phases B, C, and D as a single-tenant safety net so any code path that forgets to pass `org_id` still lands rows in Tremendous Care. **In Phase E** both the per-table defaults and the `public.default_org_id()` helper are dropped, and explicit `org_id` becomes mandatory on every insert path. A Phase E follow-up task tracks this.
- **Phase B RLS posture** (locked 2026-04-26): strict / fail-closed. New policies are `USING (org_id = (auth.jwt() ->> 'org_id')::uuid)` — a missing or unparseable claim denies access. `service_role` queries bypass RLS as usual. Edge functions that call Supabase with the user's JWT (rather than service_role) are audited in PR B3 to confirm none break under the strict policy.
- **Phase B test-harness placement** (locked 2026-04-26): a real second org (e.g., `acme-test`) is provisioned in the production `organizations` table to validate cross-tenant isolation. No `is_test_org` flag and no separate Supabase project — a second org row in production is precisely what multi-tenancy means, and the whole point of Phase B is making cross-tenant data invisible by default.

---

## Decisions still open

- Product brand name for the SaaS (separate from Tremendous Care, or shared). Revisit before Phase E.
- Whether to store per-org secrets as Vault entries vs a dedicated `org_secrets` table. Revisit at Phase C kickoff.
- Whether to support multi-org membership for a single user before launch, or defer. Currently deferred.
- Concrete list of `features_enabled` SKUs and what each gates. Revisit at Phase D kickoff.
- Exact pricing model and tiers. Revisit before Phase E.

---

## Related artifacts in the repo

- `CLAUDE.md` — prime directives, always loaded.
- `docs/SAAS_RETROFIT_STATUS.md` — current phase, PRs shipped, decisions log.
- `.github/pull_request_template.md` — retrofit-aware PR checklist.
- `supabase/migrations/20260414213447_communication_routes.sql` — reference pattern for category-based routing, generalized in Phase C for per-org secrets.
- `supabase/migrations/20260414221401_get_route_ringcentral_jwt_rpc.sql` — reference pattern for RPC-based secret lookup.
