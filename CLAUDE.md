# Tremendous Care — Caregiver Portal

## CRITICAL: Production Safety Rules

This app is **live in production** and used by a real team. The owner is non-technical. Claude must act as the **senior developer, architect, and deployment manager** — proactively enforcing best practices and preventing mistakes that could break production.

### Development Workflow (MANDATORY)

1. **NEVER push directly to `main`** — Always create a feature branch (`feature/description`)
2. **ALWAYS open a Pull Request** — PRs trigger CI (tests + build) and Vercel preview deploys
3. **NEVER merge a PR with failing CI** — If tests or build fail, fix them first
4. **Run `npm test` before committing** — Catch issues locally before pushing
5. **Run `npm run build` before pushing** — Verify the production build works
6. **Write tests for new business logic** — Any new utility function or business rule gets a test
7. **Discuss plans before major features** — The user wants to understand and approve the approach

### Database Safety (MANDATORY)

- **NEVER DROP tables or DELETE rows** as part of development work
- **NEVER run destructive migrations** without explicit user approval
- **Add columns as nullable** — old code must continue working
- **All schema changes must be reviewed** before execution

### Deployment Rules

- `main` branch auto-deploys to production via Vercel — treat it as sacred
- Vercel preview deploys are created for every PR — use them to test before merging
- Edge Functions **auto-deploy on merge to `main`** via GitHub Actions (`.github/workflows/deploy-edge-functions.yml`). Workflow deploys every function under `supabase/functions/` (except `_shared/`) using the `SUPABASE_ACCESS_TOKEN` GitHub secret. No manual CLI deploys needed for committed functions — just merge and the workflow runs.
- Manual deploy is still available for urgent hotfixes: `npx supabase functions deploy <name> --no-verify-jwt`. If you must do this, `git pull origin main` first to avoid drift, then commit the code before you go home.
- **Database migrations** are applied via the manual `Deploy Database Migrations` GitHub Actions workflow (`.github/workflows/deploy-migrations.yml`). After merging a PR with new files in `supabase/migrations/`, trigger the workflow from the Actions tab — first with `dry_run=true` to confirm the pending list, then `dry_run=false` to apply. Runs `supabase db push --include-all`, so any migration that uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` is idempotent and safe to re-run. Do NOT copy-paste SQL into the Supabase Dashboard for migrations that exist in the repo — the workflow keeps the deployed schema in sync with `main`.
- If a deploy breaks production, Vercel dashboard allows instant rollback to previous deployment (frontend). For edge functions, re-run the Deploy Edge Functions workflow on an earlier commit via the GitHub Actions UI.

### Testing

- **Framework**: Vitest (config in `vitest.config.js`)
- **Test location**: `src/lib/__tests__/`
- **Commands**: `npm test` (CI), `npm run test:watch` (dev), `npm run test:ui` (browser UI)
- **Current coverage**: 1,859+ tests across 66 test files (utils, automations, actionEngine, actionItemEngine, bulkMessaging, recording, outcomeTracking, scheduling conflict detection, availability matching, recurrence expansion, eligibility ranking, broadcast helpers, service plan helpers, shift helpers, schedule view helpers, clock event mutations, no-show eligibility, shift variance, and more)
- **Rule**: New utility/business logic functions MUST have tests before merging

### CI Pipeline

GitHub Actions runs on every PR to `main` (`.github/workflows/ci.yml`):
1. Install dependencies
2. Run all tests
3. Build the app

If any step fails, the PR is blocked.

---

## Strategic Context: Becoming Multi-Tenant SaaS

The portal is currently single-tenant for Tremendous Care. We are actively refactoring it into a multi-tenant SaaS to sell to other home-care agencies. Every change from this point forward must be made with multi-tenancy in mind.

- **Full plan**: `docs/SAAS_RETROFIT.md`
- **Current phase and status**: `docs/SAAS_RETROFIT_STATUS.md`

Read both before starting any work on schema, auth, secrets, branding, or pipeline phases. If you are unsure whether a change is tenancy-relevant, assume it is and check the plan.

### Prime Directives (non-negotiable)

1. **Production safety.** Tremendous Care operations run on this app today. Every schema change is additive. No `DROP`s, no `DELETE`s, no destructive migrations. Column changes stage as `nullable → backfill → NOT NULL → RLS tightened`. Every PR that touches schema, auth, or secrets ships with an explicit rollback plan in the PR description.

2. **Every new table gets `org_id uuid REFERENCES organizations(id)`.** Nullable at creation, defaulted to Tremendous Care's org for the backfill step, then `NOT NULL` once every row has a value. No exceptions — even tables that feel "obviously single-org" get the column.

3. **Every new query is org-scoped.** Either `WHERE org_id = <current_org>` or it relies on an RLS policy that enforces it. Never introduce cross-tenant reads. This includes edge functions and cron jobs.

4. **Every new secret uses the per-org lookup pattern.** See `communication_routes` + the `public.get_route_ringcentral_jwt(p_category TEXT)` RPC (migrations `20260414213447`, `20260414221401`) for the reference implementation. Do not add new single-account env vars for tenant-sensitive integrations (messaging, email, calendar, e-sign, AI providers).

5. **No new hardcoded Tremendous Care branding, URLs, phases, or pipeline config.** Configurable strings belong in `organizations.settings` (or the specific data-driven home they warrant). Hardcoding a string that will vary per customer is a regression even if nothing breaks today.

6. **When in doubt on any of the above, pause and ask before writing code.** The owner prefers discussion to surprise. A half-finished retrofit PR that merges is worse than a PR that sits for a day while we talk.

### Rollout Phasing (summary)

Work proceeds in five sequential phases, each preceded by a bake period on `main` before the next begins. Current phase is tracked in `docs/SAAS_RETROFIT_STATUS.md`.

- **Phase A** — Auth foundation (`organizations`, `org_memberships`, JWT access token hook). No behavior change.
- **Phase B** — Add `org_id` to every table, backfill, then tighten RLS one table at a time.
- **Phase C** — Per-org secrets for RingCentral, Microsoft, DocuSign, Anthropic. Generalize the `communication_routes` pattern.
- **Phase D** — Configurable pipeline phases, per-org branding, feature toggles.
- **Phase E** — Self-serve onboarding, invite flow, HIPAA/BAA artifacts, billing integration.

Phases are not parallelizable. Do not start Phase B work before Phase A is shipped and baked.

---

## Project Overview

- **Supabase Project ID**: `zocrnurvazyxdpyqimgj`
- **Production URL**: `https://caregiver-portal.vercel.app`
- **Stack**: React 18 + Vite + Supabase + Vercel

## Key Conventions

- **Notes format**: Array of objects `{text, type, timestamp, author, outcome, direction}` — never strings
- **Tasks format**: Flat `{taskId: {completed, completedAt, completedBy}}` — never nested
- **AI chat** edge function is in `supabase/functions/ai-chat/` and auto-deploys via GitHub Actions like all other functions. No manual CLI deploys needed.
- **All Edge Functions are in git** under `supabase/functions/` and auto-deploy on merge to `main`. The `_shared/` directory contains shared helpers imported by multiple functions.
- **pg_cron jobs**: automation-cron (every 30min, job 1), outcome-analyzer (every 4h, job 2)

---

## Context Layer Architecture (Phase 1 — Foundation)

The AI assistant has a **context layer** — a memory and awareness system that makes it proactively intelligent. This is the foundation for building a Goldman Sachs / Palantir-level autonomous recruiting system.

### Architecture Overview

```
Frontend (AIChatbot.jsx)
  │
  ├─ requestType: "briefing"  →  Fast briefing (no Claude call)
  └─ messages[]               →  Full chat with context-assembled prompt
                                    │
                           ┌────────┴────────┐
                           │ Context Assembler │
                           │ (6 modular layers)│
                           └────────┬────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              context_memory     events      context_snapshots
              (episodic/         (unified     (session
               semantic/          event        continuity)
               procedural)        bus)
```

### Database Tables (Supabase)

**`context_memory`** — Stores all AI memories
- `memory_type`: `episodic` (per-entity facts), `semantic` (learned patterns), `procedural` (SOPs), `preference` (user prefs)
- `entity_type` / `entity_id`: Links memory to a caregiver/client or system-wide
- `confidence`: 0.0-1.0 — semantic memories below 0.7 are "preliminary"
- `source`: `ai_observation`, `user_correction`, `outcome_analysis`, `manual`
- `tags`: Array for searchable categorization
- `superseded_by`: Points to replacement memory (old memories are kept, not deleted)
- `expires_at`: Optional TTL for transient memories
- **Migration**: `supabase/migrations/20260221_context_layer.sql`

**`events`** — Unified event bus (everything that happens)
- `event_type`: `note_added`, `phase_changed`, `task_completed`, `sms_sent`, `sms_received`, `email_sent`, `docusign_sent`, `docusign_completed`, `caregiver_created`, `client_created`, `automation_fired`, `calendar_event_created`, etc.
- `entity_type` / `entity_id`: Which entity the event relates to
- `actor`: `user:Jessica`, `system:automation`, `system:ai`
- `payload`: JSONB with event-specific data
- Events are **append-only** — never updated or deleted

**`action_outcomes`** — Tracks side-effect actions and their outcomes (Phase 2)
- `action_type`: `sms_sent`, `email_sent`, `docusign_sent`, `phase_changed`, `calendar_event_created`, `task_completed`
- `outcome_type`: `null` (pending) → `response_received`, `no_response`, `completed`, `advanced`, `declined`, `expired`
- `entity_id` is `text` (matches `caregivers.id`), NOT `uuid` (unlike `context_memory.entity_id` which is uuid)
- Expiry windows: SMS/email 7d, DocuSign 14d, calendar 21d
- **Migration**: `supabase/migrations/20260222_action_outcomes.sql`

**`context_snapshots`** — Session continuity (one per user)
- `user_id`: Current user name
- `session_summary`: Last AI response summary
- `active_threads`: Array of `{topic, status}` from the conversation
- Upserted at end of each chat conversation

### Context Assembler (`supabase/functions/ai-chat/context/assembler.ts`)

Modular system prompt builder with **6 independent layers**:

| Layer | Source | Tokens | Dynamic? |
|-------|--------|--------|----------|
| 1. Identity & Pipeline Stats | caregivers/clients arrays | ~300 | Per-request |
| 2. Situational Awareness | `events` table (last 24h) | ~400-600 | Per-request |
| 3. Relevant Memory | `context_memory` table | ~300-500 | Per-request |
| 4. Active Threads | `context_snapshots` table | ~150-200 | Per-request |
| 5. Entity Profile | Caregiver/client data | ~1500-2000 | If viewing entity |
| 6. Tool Guidelines | Static text | ~3500 | Static |

**Each layer is an independent async function** — add/remove/modify layers without affecting others.

### Event Logging (`supabase/functions/ai-chat/context/events.ts`)

Three utilities:
- `logEvent(supabase, eventType, entityType, entityId, actor, payload)` — Fire-and-forget event logging
- `storeMemory(supabase, memoryType, content, options)` — Store a new memory
- `saveContextSnapshot(supabase, userId, summary, threads)` — Upsert session state

Events are automatically logged:
- After every successful tool execution (in the agentic loop)
- After confirmed actions (phase changes, SMS sends, etc.)
- Session snapshots saved at end of each conversation

### Briefing System (`supabase/functions/ai-chat/context/briefing.ts`)

When chat opens, frontend calls `requestType: "briefing"` — returns structured data with **no Claude call**:
- Checks for inbound messages needing response
- Finds stale caregivers/clients (3+ days no activity)
- Identifies new applications
- Retrieves last session context
- Generates time-of-day greeting
- Returns contextual quick action buttons

### Frontend Integration (`src/shared/components/AIChatbot.jsx`)

- Fetches briefing on chat open (once per session)
- Renders contextual alerts (urgent/info/suggestion items)
- Quick actions are dynamic based on what needs attention
- Falls back to static quick actions if briefing fails

### Phased Rollout Plan

**Phase 1 (CURRENT — Built)**: Context layer foundation
- Episodic memory (per-entity interaction history)
- Unified event bus
- Session continuity
- Proactive briefing on chat open
- Contextual quick actions

**Phase 2 (COMPLETE)**: Outcome tracking
- New table: `action_outcomes` (tracks whether actions worked)
- Outcome detection: did they respond? did they advance?
- Cron job (every 4h) detects no-response, correlates inbound SMS, generates semantic memories
- Confidence gates: only create patterns with 30+ data points
- Briefing shows pending actions and recent successes
- Code: `outcomes.ts` (logAction, detectOutcome), `outcome-analyzer/index.ts` (cron)

**Phase 3**: Graduated autonomy
- New table: `autonomy_config` (per-action autonomy levels)
- 4 levels: L1 Suggest → L2 Confirm → L3 Notify → L4 Auto
- Settings UI for managing autonomy levels
- Auto-promotion based on success rates

**Phase 4**: Proactive OODA loop
- Cron-triggered morning briefings
- Event-driven action suggestions
- AI-initiated follow-up recommendations

**Phase 5**: Client pipeline extension
- Client-specific memory and context layers
- Client-caregiver matching intelligence

### Key Design Principles

## Environment Gotchas (Windows)

- **`preview_start` does not work** — all runtimeExecutable configs fail with "spawn npx ENOENT". Use `Bash` background task + Chrome tools or Vercel preview deploys instead.
- **Git rebase can leave stale state** — if `.git/rebase-merge` exists but `head-name` is missing, remove the directory: `rm -rf .git/rebase-merge`
- **`context_memory.superseded_by` has FK constraint** — when superseding memories, INSERT new row first, THEN UPDATE old row to point to it
- **`now()` cannot be used in partial index predicates** — not IMMUTABLE. Filter at query time instead.

### Key Design Principles

1. **Everything is data, not code** — Autonomy levels, memories, SOPs are all database rows editable from Settings UI. No redeploy needed for behavior changes.
2. **Graceful degradation** — If context assembler fails, falls back to original static prompt. If briefing fails, shows static quick actions.
3. **Token budget discipline** — Dynamic layers are capped. Total system prompt stays under 13% of 200K context window.
4. **Phased memory activation** — Episodic memory (zero risk) → Outcome recording (data collection) → Semantic patterns (only with statistical significance).
5. **Append-only events** — Events table is never updated. Memories use `superseded_by` chain instead of updates.
6. **Fire-and-forget observability** — Event logging and memory storage never block the main response path.
