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
- **Current coverage**: 181 tests across utils, automations, actionEngine, actionItemEngine, bulkMessaging, recording, outcomeTracking
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
- **Edge Functions not in git** (except ai-chat and outcome-analyzer): outlook-integration, docusign-integration, execute-automation, automation-cron, sharepoint-docs, get-communications
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

### Gold Standard Maturity Assessment (March 2026)

**Current Level: 2.5 / 5** (between "Assisted" and "Structured")
**Architectural Readiness: ~80%** — foundation supports gold standard; gaps are additive, not structural.

The industry gold standard for production agentic AI (as of March 2026) is defined by five maturity levels:

| Level | Name | Description |
|-------|------|-------------|
| 1 | Basic | Single LLM call, no structure, no logging |
| 2 | Assisted | RAG + basic tooling, still a monolith |
| **3** | **Structured** | **Sandwich pattern + decomposition + deterministic routing** |
| 4 | Production | Full orchestration + observability + eval harnesses + human gates |
| 5 | Autonomous | Self-optimizing with continuous improvement from trace data |

**What we have that's strong:**
- Context assembly (6-layer modular, graceful degradation) — **Grade: A**
- Memory system (4 types, confidence gates, superseding chains, 30+ observation threshold) — **Grade: A-**
- Outcome tracking (action-outcome correlation, semantic memory generation) — **Grade: A**
- Tool registry (preview/confirm split, risk-level gating, modular handlers) — **Grade: A**
- Observability (append-only events, context health reporting, fire-and-forget) — **Grade: B+**

**Critical gaps to close (in priority order):**

| Gap | Impact | Effort | Target Phase |
|-----|--------|--------|-------------|
| **Sandwich Pattern** (preflight → LLM → verify) | High — biggest reliability gain | Medium — extends existing tool handlers | Phase 2.5 |
| **Output Verification** (validate tool results before feeding back to Claude) | High — prevents hallucination amplification | Low — add schema checks to registry | Phase 2.5 |
| **Deterministic Intent Router** (code-based routing before Claude) | Medium — adds predictability | Low — extend existing requestType pattern | Phase 2.5 |
| **Reflection/Self-Correction** (verify-your-work step before final response) | Medium — critical for high-stakes outputs | Low — one additional agentic loop iteration | Phase 3 |
| **Error Recovery** (retry with different approach on tool failure) | Medium — silent failures currently | Medium | Phase 3 |
| **Evaluation Harness** (replay historical interactions, compare outputs) | Medium — required for safe iteration | Medium — events table has the data | Phase 4 |
| **Multi-Agent Decomposition** | Low for now — premature at current scale | High | Phase 4+ (only when volume justifies) |

### Key Agentic Patterns Reference

Every feature and enhancement should be evaluated against these five foundational patterns:

1. **Reflection** — Agent self-critiques before finalizing output. Reserve deep reflection for high-stakes outputs (care plans, financial, compliance). Limit loops for low-risk outputs.
2. **ReAct** (Reason + Act) — Interleave thinking and doing in small steps. Creates audit trails. Our agentic loop already does this; enhance with per-step policies.
3. **Tool Use** — Ground the agent in real data, not probability. Each agent should access only the tools it needs (principle of least privilege).
4. **Planning** — Create explicit plans for complex multi-step tasks. Plans should be inspectable and overridable by humans.
5. **Multi-Agent Collaboration** — Specialist agents for distinct domains, coordinated by deterministic orchestrator. Only add agents when justified by complexity.

### The Sandwich Pattern (Priority Implementation)

The single most important pattern for production reliability:

```
Code (Preflight)  →  LLM (Creative Work)  →  Code (Verify)
```

- **Preflight**: Validate inputs, check data integrity, enforce business rules, prepare context
- **LLM**: Reasoning, generation, analysis
- **Verify**: Check output against source of truth, validate format, enforce constraints, catch hallucinations

Apply to every tool execution: validate inputs before calling the tool, verify results after. Our existing preview/confirm handler structure naturally extends to support this.

### Two-Layer Model (Target Architecture)

The gold standard production pattern separates concerns:

- **Layer 1 — Deterministic Orchestration**: Routes tasks between agents using conventional code. No LLM needed for routing. Predictable, debuggable, auditable.
- **Layer 2 — Bounded Agent Execution**: Each agent has narrow scope, automated evaluation at each step, LLM creativity contained within guardrails.

Our current `requestType` branching (briefing vs. chat) is the seed of Layer 1. Extend it with more deterministic routes before hitting Claude.

### Phased Rollout Plan (Updated with Gold Standard Alignment)

**Phase 1 (COMPLETE)**: Context layer foundation
- Episodic memory (per-entity interaction history)
- Unified event bus
- Session continuity
- Proactive briefing on chat open
- Contextual quick actions
- *Gold standard: Establishes observability and RAG foundation (Level 2)*

**Phase 2 (COMPLETE)**: Outcome tracking
- New table: `action_outcomes` (tracks whether actions worked)
- Outcome detection: did they respond? did they advance?
- Cron job (every 4h) detects no-response, correlates inbound SMS, generates semantic memories
- Confidence gates: only create patterns with 30+ data points
- Briefing shows pending actions and recent successes
- Code: `outcomes.ts` (logAction, detectOutcome), `outcome-analyzer/index.ts` (cron)
- *Gold standard: Establishes feedback loop and continuous improvement data (Level 2)*

**Phase 2.5 (NEW — Verification & Reliability)**: Sandwich pattern + routing
- Add preflight validation to tool handlers (verify inputs against Supabase before executing)
- Add post-execution verification (confirm tool actually succeeded, validate results)
- Add output schema validation before feeding tool results back to Claude
- Implement deterministic intent router (extend requestType pattern for common queries)
- Add error recovery to agentic loop (retry with different approach on tool failure)
- *Gold standard: This phase bridges us from Level 2 to Level 3 (Structured)*

**Phase 3**: Graduated autonomy + reflection
- New table: `autonomy_config` (per-action autonomy levels)
- 4 levels: L1 Suggest → L2 Confirm → L3 Notify → L4 Auto
- Settings UI for managing autonomy levels
- Auto-promotion based on success rates
- Add reflection step for high-stakes outputs (verify-your-work before final response)
- Human-in-the-loop gates for care plans, financial actions, compliance decisions
- Circuit breakers: halt execution when anomaly rates exceed threshold
- *Gold standard: Establishes human gates and self-correction (Level 3 → Level 4)*

**Phase 4**: Proactive OODA loop + evaluation
- Cron-triggered morning briefings
- Event-driven action suggestions
- AI-initiated follow-up recommendations
- Build evaluation harness (replay historical interactions from events table)
- Structured trace logging for metrics and performance analysis
- Self-optimization loop: trace → analyze → improve → deploy → trace again
- *Gold standard: Full observability and eval infrastructure (Level 4)*

**Phase 5**: Client pipeline + multi-agent (when scale justifies)
- Client-specific memory and context layers
- Client-caregiver matching intelligence
- Decompose into specialist agents only if volume/complexity demands it
- Deterministic orchestrator coordinates specialist agents
- Independent testing and scaling per agent
- *Gold standard: Multi-agent decomposition (Level 4 → Level 5)*

### Operating Model: Delegate, Review, Own

The gold standard for human-AI collaboration at Tremendous Care:
- **AI handles**: First-pass execution, data gathering, scheduling suggestions, status updates, SMS drafting, outcome tracking
- **Humans review**: Outputs for correctness, risk, and alignment before high-stakes actions
- **Humans own**: Architecture decisions, care plan approvals, financial sign-offs, compliance determinations

### Key Design Principles

## Environment Gotchas (Windows)

- **`preview_start` does not work** — all runtimeExecutable configs fail with "spawn npx ENOENT". Use `Bash` background task + Chrome tools or Vercel preview deploys instead.
- **Git rebase can leave stale state** — if `.git/rebase-merge` exists but `head-name` is missing, remove the directory: `rm -rf .git/rebase-merge`
- **`context_memory.superseded_by` has FK constraint** — when superseding memories, INSERT new row first, THEN UPDATE old row to point to it
- **`now()` cannot be used in partial index predicates** — not IMMUTABLE. Filter at query time instead.

### Key Design Principles

1. **Everything is data, not code** — Autonomy levels, memories, SOPs are all database rows editable from Settings UI. No redeploy needed for behavior changes.
2. **Graceful degradation** — If context assembler fails, falls back to original static prompt. If briefing fails, shows static quick actions. Every component must have a fallback path.
3. **Token budget discipline** — Dynamic layers are capped. Total system prompt stays under 13% of 200K context window.
4. **Phased memory activation** — Episodic memory (zero risk) → Outcome recording (data collection) → Semantic patterns (only with statistical significance).
5. **Append-only events** — Events table is never updated. Memories use `superseded_by` chain instead of updates. Every decision logged for compliance.
6. **Fire-and-forget observability** — Event logging and memory storage never block the main response path.
7. **Sandwich every LLM call** — Deterministic preflight (validate inputs, enforce rules) → LLM (creative work) → Deterministic verify (check output against source of truth). Never trust raw LLM output for high-stakes actions.
8. **Deterministic routing, creative execution** — Route tasks with code (predictable, auditable), let the LLM reason within bounded scope. Don't use the LLM for decisions that code can make reliably.
9. **Decompose before scaling** — Resist the monolith. When a single agent grows too complex to debug, split into specialist agents with explicit input/output contracts. But don't split prematurely — a well-structured single agent beats a poorly-coordinated multi-agent system.
10. **Verify before autonomy** — Never increase an agent's autonomy level without first adding verification. Phase 2.5 (sandwich pattern) must precede Phase 3 (graduated autonomy).
11. **Continuous improvement from production data** — Trace → Analyze → Improve → Deploy → Trace again. Feed failure patterns back into RAG, prompts, and tool design. Optimize based on real data, not programmer intuition.
