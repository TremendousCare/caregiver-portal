# Commercial Sale Roadmap

> **Status**: Planning — no changes to codebase yet
> **Goal**: Make the Caregiver Portal sellable as a multi-tenant SaaS product
> **Created**: 2026-04-10

## Current State

The app is a **single-tenant** system built for Tremendous Care. Every layer assumes one organization. To sell this commercially, we need data isolation, configurable branding, billing, and self-service onboarding.

---

## Phase 1: Data Isolation & Multi-Tenancy Foundation

**Priority: CRITICAL — this is the security foundation**

### Database Changes
- [ ] Create `organizations` table (id, name, slug, settings, created_at)
- [ ] Create `user_organizations` table (user_id, org_id, role)
- [ ] Add `org_id` column (nullable initially) to ALL data tables:
  - `caregivers`, `clients`, `boards`, `board_cards`
  - `app_settings`, `app_data`
  - `context_memory`, `events`, `context_snapshots`
  - `action_outcomes`, `ai_suggestions`
  - `automation_rules`, `action_item_rules`, `autonomy_config`
  - `survey_templates`, `esign_templates`
  - `message_routing_queue`
- [ ] Backfill existing data with Tremendous Care's org_id
- [ ] Make `org_id` NOT NULL after backfill
- [ ] Add foreign key constraints to organizations table

### RLS Policy Rewrite
- [ ] Replace all "authenticated full access" policies with org-scoped policies
- [ ] Pattern: `USING (org_id = (auth.jwt() ->> 'org_id')::uuid)`
- [ ] Test that tenant A cannot read/write tenant B's data
- [ ] Add org_id to JWT claims via Supabase auth hook

### Auth Changes
- [ ] Remove legacy password auth (`LEGACY_PASSWORD` in AuthGate.jsx)
- [ ] Add org_id to user metadata on signup/invite
- [ ] Support org-level user invitations
- [ ] Add role-based access: admin, manager, viewer

---

## Phase 2: Configurable Identity & Branding

**Priority: HIGH — removes hardcoded single-company assumptions**

### Frontend Branding
- [ ] Create `TenantContext` provider that loads org settings
- [ ] Replace all hardcoded "Tremendous Care" references (15+ locations):
  - AuthGate.jsx (login screen)
  - Sidebar.jsx (logo/nav)
  - SigningPage.jsx (e-sign branding)
  - ApplyPage.jsx (application page)
  - UploadPage.jsx (footer)
  - SurveyPage.jsx (survey branding)
- [ ] Make logo, colors, company name configurable per org
- [ ] Move SMS/email templates to org-scoped database rows

### Business Logic Configurability
- [ ] Move PHASES from constants.js → org-scoped `pipeline_config` table
- [ ] Move DEFAULT_PHASE_TASKS → org-scoped `task_templates` table
- [ ] Move CHASE_SCRIPTS → org-scoped `script_templates` table
- [ ] Move GREEN_LIGHT_ITEMS → org-scoped `checklist_config` table
- [ ] Make compliance items configurable (currently CA-specific)
- [ ] Allow custom fields per org

---

## Phase 3: Edge Functions & AI Tenant Scoping

**Priority: HIGH — AI and automations must be org-aware**

- [ ] Pass org_id to all Edge Functions (ai-chat, ai-planner, message-router, etc.)
- [ ] Scope context assembler queries by org_id
- [ ] Scope context_memory, events, context_snapshots by org_id
- [ ] Scope automation-cron and outcome-analyzer by org_id
- [ ] Per-org AI business context (currently single `ai_business_context` setting)
- [ ] Per-org autonomy configuration
- [ ] Per-org integration credentials (RingCentral, DocuSign, etc.)

---

## Phase 4: Billing & Subscription Management

**Priority: MEDIUM — needed before first sale, not before first demo**

- [ ] Integrate Stripe for subscription billing
- [ ] Create billing tables: `subscriptions`, `usage_metrics`, `invoices`
- [ ] Define plan tiers (e.g., Starter, Professional, Enterprise)
- [ ] Feature gates based on plan:
  - Caregiver/client limits
  - AI chat usage limits
  - Automation features
  - Number of users
  - Integrations (DocuSign, RingCentral, etc.)
- [ ] Billing settings page in admin UI
- [ ] Usage tracking and metering
- [ ] Trial period support

---

## Phase 5: Self-Service Onboarding

**Priority: MEDIUM — needed for scale, not for first customers**

- [ ] Org signup flow (create account → create org → invite team)
- [ ] Onboarding wizard (configure pipeline, upload logo, set templates)
- [ ] Default templates per industry vertical (home care, staffing, etc.)
- [ ] Seed data for new orgs (sample phases, tasks, scripts)
- [ ] Admin dashboard for org management (super-admin level)

---

## Phase 6: Enterprise Features (Future)

- [ ] SSO / SAML integration
- [ ] Audit logging per org
- [ ] Data export / portability
- [ ] Custom domain support (whitelabel)
- [ ] API access for integrations
- [ ] Multi-region data residency
- [ ] SLA monitoring

---

## Architecture Decisions to Make

### Multi-Tenancy Strategy
**Option A: Shared database, org_id column (recommended)**
- Pros: Simpler ops, easier to maintain, lower cost
- Cons: Noisy neighbor risk, RLS complexity
- Best for: Early stage, <100 tenants

**Option B: Schema-per-tenant**
- Pros: Better isolation, simpler queries
- Cons: Migration complexity, higher ops burden
- Best for: Enterprise customers with strict isolation needs

**Option C: Database-per-tenant**
- Pros: Complete isolation, easy to reason about
- Cons: Expensive, complex deployment, hard to manage
- Best for: Regulated industries only

**Recommendation**: Start with Option A (shared DB + org_id). Supabase RLS is built for this pattern. Move high-value enterprise customers to Option B/C later if needed.

### Pricing Model Ideas
- **Per-seat**: $X/user/month (simple, predictable)
- **Per-caregiver**: $X/active caregiver/month (usage-based)
- **Tiered**: Fixed tiers with feature + volume limits
- **Hybrid**: Base platform fee + per-seat + usage overages

---

## Key Risks & Considerations

1. **Data migration**: Existing Tremendous Care data needs clean org_id backfill
2. **Integration credentials**: Each org needs their own RingCentral, DocuSign, etc. accounts
3. **AI costs**: Claude API calls scale with tenants — need usage tracking and limits
4. **Compliance**: Different states/regions have different caregiver regulations
5. **Support**: Multi-tenant means multi-customer support burden
6. **Testing**: Every feature needs testing with org isolation in mind

---

## Effort Estimates

| Phase | Effort | Can Demo Without? |
|-------|--------|-------------------|
| 1. Data Isolation | 2-3 weeks | No |
| 2. Configurable Identity | 1-2 weeks | No |
| 3. Edge Function Scoping | 1-2 weeks | No |
| 4. Billing | 2-3 weeks | Yes (manual billing) |
| 5. Self-Service Onboarding | 1-2 weeks | Yes (manual setup) |
| 6. Enterprise Features | Ongoing | Yes |

**Minimum viable commercial product: Phases 1-3 (~5-7 weeks)**
Billing can start manual. Onboarding can be white-glove for first customers.

---

## Design Principles for Commercial Readiness

1. **Add org_id to every new table from now on** — even before we start the migration
2. **Stop hardcoding company-specific text** — use settings/config for any new strings
3. **Keep business logic data-driven** — phases, tasks, templates should be DB rows, not code
4. **Design APIs org-aware** — even if we only have one org today
5. **Test with isolation in mind** — "can tenant A see tenant B's data?" should be a test case
