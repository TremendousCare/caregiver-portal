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
- Edge Functions deploy via CLI: `npx supabase functions deploy <name> --no-verify-jwt`
- If a deploy breaks production, Vercel dashboard allows instant rollback to previous deployment

### Testing

- **Framework**: Vitest (config in `vitest.config.js`)
- **Test location**: `src/lib/__tests__/`
- **Commands**: `npm test` (CI), `npm run test:watch` (dev), `npm run test:ui` (browser UI)
- **Current coverage**: 74 tests across utils, automations, actionEngine
- **Rule**: New utility/business logic functions MUST have tests before merging

### CI Pipeline

GitHub Actions runs on every PR to `main` (`.github/workflows/ci.yml`):
1. Install dependencies
2. Run all tests
3. Build the app

If any step fails, the PR is blocked.

## Project Overview

- **Supabase Project ID**: `zocrnurvazyxdpyqimgj`
- **Production URL**: `https://caregiver-portal.vercel.app`
- **Stack**: React 18 + Vite + Supabase + Vercel

## Key Conventions

- **Notes format**: Array of objects `{text, type, timestamp, author, outcome, direction}` — never strings
- **Tasks format**: Flat `{taskId: {completed, completedAt, completedBy}}` — never nested
- **AI chat deploys via CLI**, not MCP tool: `npx supabase functions deploy ai-chat --no-verify-jwt`
- **Edge Functions not in git** (except ai-chat): outlook-integration, docusign-integration, execute-automation, automation-cron, sharepoint-docs, get-communications

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

**Phase 2 (NEXT)**: Outcome tracking
- New table: `action_outcomes` (tracks whether actions worked)
- Outcome detection: did they respond? did they advance?
- Daily analysis job generates semantic memories
- Confidence gates: only create patterns with 30+ data points

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

1. **Everything is data, not code** — Autonomy levels, memories, SOPs are all database rows editable from Settings UI. No redeploy needed for behavior changes.
2. **Graceful degradation** — If context assembler fails, falls back to original static prompt. If briefing fails, shows static quick actions.
3. **Token budget discipline** — Dynamic layers are capped. Total system prompt stays under 13% of 200K context window.
4. **Phased memory activation** — Episodic memory (zero risk) → Outcome recording (data collection) → Semantic patterns (only with statistical significance).
5. **Append-only events** — Events table is never updated. Memories use `superseded_by` chain instead of updates.
6. **Fire-and-forget observability** — Event logging and memory storage never block the main response path.
