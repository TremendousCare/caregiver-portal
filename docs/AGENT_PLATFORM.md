# Agent Platform — Plan and Implementation Strategy

**Vision doc**: `docs/AGENT_PLATFORM_VISION.md` (prime directives, locked decisions, ambitions)
**Status doc**: `docs/AGENT_PLATFORM_STATUS.md` (current phase, decisions, shipped PRs)

---

## Purpose of this document

The Tremendous Care portal already runs three implicit agents (recruiting `ai-chat`, proactive `ai-planner`, inbound `message-router`) on a shared kernel that is roughly 75–80% of an agent platform. This document is the durable source of truth for the work that turns that kernel into a first-class agent platform — promoting agents to data, scoping their reach, hardening trust and safety, and shipping the first new production agent (Intake).

If you are about to make any change touching agent identity, agent runtime, autonomy thresholds, audit log shape, memory scoping, or agent-to-agent communication, read this first.

---

## Vision in one paragraph

Every agent is a row in `agents` with a manifest (system prompt, tool allowlist, autonomy profile, context recipe, kill switch, outcome definition). One generic runtime loads the manifest and executes — no new edge function per agent. Agents communicate only through the shared org memory pool and an `agent_requests` queue, never directly. Every agent action is recorded in a billing-grade signed audit log. Outcomes are verified by third-party signals (clock-in, signed envelope, inbound reply, start-of-care date), never self-reported. Trust is earned in stages by data, with kill switch and shadow mode available without a deploy. The platform serves Tremendous Care first; the same code paths serve customer #2 the day SaaS Phase C–D have baked.

---

## Why refactor, not rebuild

The accumulated value in the kernel is real and the seams are already in the right places:

- **Tool registry with risk levels** (`ai-chat/registry.ts`, 40 tools, self-registration with `riskLevel: "auto" | "confirm"`).
- **Modular context assembler** (`ai-chat/context/assembler.ts`, 6 layers, token budget, layer-level health diagnostics, graceful trim-on-overflow).
- **Memory tiers with confidence + supersede chain + drift detection** (`context_memory` + `consolidation.ts`).
- **Append-only event bus and verified outcome tracking** (`events`, `action_outcomes`, with auto-detection from inbound signals).
- **Graduated autonomy framework** (`autonomy_config` table + `recordAutonomyOutcome`, with auto-promotion/demotion).
- **One execution path for all suggestions** (`executeSuggestion` in `_shared/operations/routing.ts`, 1,194 lines — the single chokepoint that makes agents-as-data tractable).
- **Per-invocation cost telemetry already on every action**.

A rebuild throws all of that away. A refactor stamps the existing rows with `agent_id`, lifts the runtime into a generic helper, and lets the existing three agents become the first three rows — for ~2 weeks of work instead of ~6 months.

The only scenario in which rebuild would be correct is a fundamental change in agent execution model (multi-step planner-executor split, ReAct chains, evaluator-graders running in parallel). None of those are warranted today; we can adopt any of them later as additional layers because the manifest already abstracts model + max_iterations + system_prompt.

---

## Non-negotiable rules during the platform build

These are also captured in `docs/AGENT_PLATFORM_VISION.md` as prime directives. Duplicated here for completeness:

1. **Agent identity is data, not code.** New agent = new row. No new edge function.
2. **Outcomes are third-party-verified by default.** Per-agent escape clauses are explicit fields on the manifest.
3. **The audit log is billing-grade.** Tamper-evident, hash-chained, signed, exportable.
4. **Memory is per-agent by default; org-shared via tagged promotion.** No direct LLM-to-LLM calls.
5. **Trust is earned in stages, by data.** Per-transition thresholds, fixed-window success rate, minimum sample size, auto-demote on harm.
6. **Kill switch + shadow mode per (agent × org), without a deploy.**
7. **Coarse first, split when data signals it.**
8. **Every directive in `docs/SAAS_RETROFIT.md` still applies.**
9. **Production safety first.** Tremendous Care operations run on this app today. Additive schema, no destructive migrations, every PR ships with a rollback plan.
10. **When in doubt, pause and ask the owner.** Surprise is worse than delay.

---

## Architecture target

### Agents as first-class data

New table `agents`. Manifest fields:

| Field | Type | Purpose |
|---|---|---|
| `id` | uuid | PK |
| `org_id` | uuid | Owner organization (Prime Directive #8) |
| `slug` | text | Stable identifier, e.g. `recruiting`, `intake`, `scheduling` |
| `name` | text | Display name |
| `version` | int | Bumps on system prompt or tool allowlist change |
| `system_prompt` | text | The full system prompt template (with substitution slots) |
| `tool_allowlist` | text[] | Tool names this agent may use |
| `autonomy_profile` | jsonb | Per-action autonomy levels and ceilings |
| `context_recipe` | jsonb | Which context-assembler layers to load and in what order |
| `model` | text | Default `claude-sonnet-4-5` (or per-agent override) |
| `max_iterations` | int | Agentic-loop ceiling |
| `kill_switch` | bool | If true, agent is dormant — no actions, no suggestions |
| `shadow_mode` | bool | If true, agent runs and logs intended actions but takes none |
| `outcome_definition` | jsonb | Which event types count as a verified outcome, over what window, with which escape clauses |
| `triggers` | jsonb | Cron schedules and event-type subscriptions that invoke this agent |
| `created_at`, `updated_at`, `created_by`, `updated_by` | metadata |

### One runtime, many agents

`supabase/functions/_shared/operations/agentRuntime.ts` exposes one entry point:

```ts
runAgent(supabase, agentSlug, request): AgentResult
```

It loads the manifest, applies the kill switch and shadow mode, builds the context-assembler call from the recipe, filters the tool registry by allowlist, runs the agentic loop, executes confirmed suggestions through `executeSuggestion`, records outcomes, and writes the audit-log entry. The existing edge functions (`ai-chat`, `ai-planner`, `message-router`) become thin shells that translate their HTTP/cron surface into a `runAgent` call.

### Agent-stamped writes

Every row written by an agent carries `agent_id`:
- `events.agent_id`
- `action_outcomes.agent_id`
- `ai_suggestions.agent_id`
- `context_memory.agent_id` (NULL means org-level shared)
- `agent_actions.agent_id` (new audit log)

### Memory scoping

Read query at context-assembly time:

```sql
SELECT * FROM context_memory
WHERE org_id = :current_org
  AND superseded_by IS NULL
  AND (agent_id = :current_agent
       OR agent_id IS NULL                   -- org-level facts
       OR 'shareable' = ANY(tags));          -- explicitly promoted
```

Write defaults:
- Episodic memory → private to writing agent
- Semantic memory from consolidation → org-level (`agent_id = NULL`) + tag `shareable`
- Procedural memory (SOPs from corrections) → org-level + tag `shareable`
- Preference memory (operator preferences) → org-level + tag `shareable`

### Inter-agent dispatch

New table `agent_requests`. Agent A inserts a row; agent B's trigger consumes it. Fields: `from_agent_id`, `to_agent_slug`, `request_type`, `payload`, `status`, `result`, `created_at`, `processed_at`. No direct LLM-to-LLM tool calls. First production use case: recruiting agent → intake agent handoff when an inbound caregiver lead is actually a referring family ("can you find someone for my mom?"). Second: intake → scheduling when a client signs SOC.

### Billing-grade audit log

New table `agent_actions`. Every action an agent takes (suggested, confirmed, executed, auto-executed, rejected, expired) writes one row. Fields include the prior row's hash so the chain is tamper-evident. Signed with a per-org key. Exportable as CSV/JSON. This sits alongside `events`, not replacing it — `events` is the operational bus; `agent_actions` is the receipt drawer.

### Per-(agent × org) controls

The kill switch and shadow mode live on the `agents` row. Because every agent is per-org, the controls are automatically per-(agent × org). Toggling either takes effect within the next `runAgent` call (≤ 2 minutes for cron-driven agents, immediate for chat-driven).

### Promotion algorithm v2

Replaces today's "consecutive_approvals threshold". New `autonomy_profile` shape:

```jsonc
{
  "send_sms": {
    "current_level": "L2",
    "max_level": "L3",
    "transitions": {
      "L1_to_L2": { "min_consecutive": 5,  "min_success_rate": 80, "min_sample": 10  },
      "L2_to_L3": { "min_consecutive": 10, "min_success_rate": 90, "min_sample": 30  },
      "L3_to_L4": { "min_consecutive": 30, "min_success_rate": 95, "min_sample": 100 }
    },
    "lookback_window": 50,
    "demote_on_harm": true,
    "harm_lockout_hours": 168
  }
}
```

The existing `autonomy_config` rows continue to work via a compatibility shim while the migration to `autonomy_profile` proceeds.

---

## Phased rollout — overview

Revised 2026-04-30 after process discovery (`docs/AGENT_PLATFORM_PROCESS.md`):
- **Recruiting is the wedge**, not intake. The recruiting agent already runs in production (the AI chat). The team uses the chat. Months of `ai_suggestions` data have accumulated under "implicit shadow mode" — suggestions firing without operator action — which is gold for calibration.
- **Phase 1.5 (retrospective grading UI)** inserted between trust-and-safety primitives and the first agent transformation, because that backlog of ungraded suggestions is exactly the calibration set Phase 2's autonomy work needs.
- **Phase 2 is now "Recruiting Agent: Autonomous Funnel Orchestration"** — transforming the existing copilot into a per-caregiver orchestrator that drives the application → orientation funnel autonomously, inserting humans only at the three locked gates (interview, doc review, orientation).
- **Intake (client lead management)** moves to Phase 3, **Scheduling** to Phase 4, etc.

| Phase | Name | Gate | New agents in production |
|---|---|---|---|
| **0** | Foundation refactor | None — parallel to SaaS Phase B/C/D | None (existing 3 migrate onto runtime) |
| **1** | Trust & safety primitives | Phase 0 baked | None |
| **1.5** | Retrospective grading UI | Phase 1.4 shipped | None |
| **2** | Recruiting Agent: Autonomous Funnel Orchestration | SaaS Phase B5 baked + Phase 1.5 baked | +0 (existing recruiting agent transforms) |
| **3** | Intake (client lead management) agent | Phase 2 stages 1–6 graduated to L1+ | +1 (Intake) |
| **4** | Scheduling agent | Phase 3 baked ≥30 days | +1 (Scheduling) |
| **5** | Inter-agent dispatch (`agent_requests` queue) | Phase 4 baked | None new (enables hand-offs) |
| **6** | Care coordination agent | Phase 5 baked | +1 (Care Coordination) |
| **7** | Marketplace, billing, voice, mobile | SaaS Phase E + Phase 6 baked | Self-serve unlocked |

Bake at least 7–14 days on `main` between phases. Phases are sequential, not parallel. Do not start phase N+1 before phase N has shipped and baked.

---

## Phase 0 — Foundation refactor

**Goal**: Promote agents to first-class data and route the existing three agents through a single runtime. Zero behavior change.

**Gate**: None. Runs in parallel with SaaS retrofit Phase B/C/D as additive scaffolding. No live agent work depends on Phase 0.

### Sliced into ~5 sequential PRs

#### 0.1 — `agents` table + manifest seed

- New migration creates `agents` (manifest fields per the architecture target above).
- RLS enabled, fail-closed, scoped to `org_id` claim. The `agents` table itself follows the SaaS retrofit's strict RLS posture (`org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid`). `service_role` bypasses, as elsewhere.
- Seed three rows for Tremendous Care: `recruiting`, `proactive_planner`, `inbound_router`. Each row's `system_prompt`, `tool_allowlist`, `model`, `max_iterations`, `context_recipe`, and `triggers` are extracted *as data* from the existing edge functions. The current `autonomy_config` rows for `inbound_routing`, `ai_chat`, and `proactive` contexts re-key into `autonomy_profile` JSONB entries on the matching agent row, with an inline back-compat view so legacy queries still work during bake.
- `kill_switch = false`, `shadow_mode = false`, `version = 1` for each.

**Exit criteria**: three rows present, all manifest fields populated, RLS denies cross-tenant reads in the test harness.

**Rollback**: drop the `agents` table and its policies. Nothing else depends on it yet.

#### 0.2 — `agent_id` columns + backfill

- Add `agent_id uuid REFERENCES agents(id)` (nullable) to `events`, `action_outcomes`, `ai_suggestions`, `context_memory`.
- Backfill heuristics:
  - `ai_suggestions.source_type = 'inbound_sms' | 'inbound_email'` → inbound_router agent.
  - `ai_suggestions.source_type = 'proactive' | 'event_triggered'` → proactive_planner agent.
  - All other ai-chat-originated suggestions and action_outcomes (where `source = 'ai_chat'`) → recruiting agent.
  - `context_memory` rows that are pure pattern detections (`source = 'outcome_analysis'`) → `agent_id = NULL` (org-level), tag `shareable`.
  - All other `context_memory` rows currently observed by today's monolithic ai-chat → recruiting agent.
- Indexes on `(agent_id, created_at DESC)` and `(org_id, agent_id)` per table.
- `agent_id` stays nullable through Phase 0–1; flips to NOT NULL with a default at the start of Phase 2 once every insert path has been audited.

**Exit criteria**: every row in those four tables has `agent_id` set (or explicitly NULL for org-level memories). Counts reconcile between tables.

**Rollback**: drop the `agent_id` columns. Pure additive — nothing else reads them in this PR.

#### 0.3 — `agentRuntime.ts` + behavioral parity test harness

- New file `supabase/functions/_shared/operations/agentRuntime.ts`. Exposes `runAgent(supabase, agentSlug, request)`. Internally:
  - Loads the manifest from `agents` (cached for the life of the request).
  - Returns immediately if `kill_switch = true`.
  - Builds the system prompt from `system_prompt` + the context-assembler layers named in `context_recipe`.
  - Filters the tool registry by `tool_allowlist`.
  - Runs the agentic loop with `model` and `max_iterations` from the manifest.
  - Routes confirmed suggestions through the existing `executeSuggestion` (Phase 0.4 wires the call site; 0.3 ships the helper unwired).
  - If `shadow_mode = true`, the runtime intercepts confirm-tier tool calls so they never reach the side-effect path; the AgentResult status flips from `ok` to `shadow`. Auto-tier (read-only) tools pass through unchanged.
  - Records cost and outcome telemetry stamped with `agent_id`.
- Sub-modules under `supabase/functions/_shared/operations/agentRuntime/`:
  - `manifest.ts` — typed manifest loader, `AgentNotFoundError`, derived helpers (`levelForAction`, `isToolAllowed`, `recipeLayers`).
  - `anthropic.ts` — single retry-with-backoff helper used by every handler (matches today's `callClaudeWithRetry` semantics: retries on 429/500/503/529, exponential backoff, fetchImpl injectable for tests).
  - `handlers.ts` — three internal handlers (`runChatHandler`, `runPlannerHandler`, `runRouterHandler`) that map each agent's invocation surface to a deterministic flow byte-equal with the legacy edge function paths.

##### Parity strategy (revised 2026-05-01 from earlier "30-day replay" framing)

The plan originally called for replaying the last 30 days of legacy `ai-chat`/`ai-planner`/`message-router` invocations through both code paths and diffing results. After auditing what Tremendous Care actually persists, that target as stated isn't achievable: `ai-chat` doesn't persist chat sessions (only post-action artifacts), `ai-planner` inputs (full pipeline snapshots, recent_outcomes windows, business_context) have all moved on, and `message-router` reads live entity state at processing time so old queue rows can't be replayed against contemporaneous state. The plan's "≤ 2% per-character drift on free-text replies" allowance was also a hedge against LLM non-determinism that disappears once the LLM call is mocked.

The revised parity strategy is three layers:

- **Layer A — unit tests on `agentRuntime` itself.** ~58 specs in `src/lib/__tests__/agentRuntime.test.js`. Mock Anthropic + mock supabase. Verifies manifest dispatch, kill_switch, tool allowlist filtering, agentic loop with `max_iterations`, shadow mode (confirm-tier short-circuit, auto-tier passthrough, status flip), agent-stamped writes, cost telemetry across iterations, retry behaviour on 429/503/529, friendly fallback replies on transport failures, and shape validation. Fast, deterministic, no network.

- **Layer B — fixture-driven byte-equal parity.** ~22 specs in `src/lib/__tests__/agentRuntimeParity.test.js` driven by `src/lib/__tests__/fixtures/agentRuntime/fixtures.js`. For each fixture, mock Anthropic returns a canned response; the test asserts the body sent to Anthropic AND the returned `AgentResult` are byte-equal to the fixture's recorded expectations. Fixtures encode "this is what the legacy edge function does for input X" once, and never drift. Coverage floor: ≥ 3 fixtures per agent shape (router / planner / chat).

- **Layer C — live API smoke.** 3 specs in `src/lib/__tests__/agentRuntimeLive.test.js`, gated on `ANTHROPIC_API_KEY`. Makes ~$0.10 of real Claude calls per run to catch mock-vs-reality drift (malformed tool definitions, response shape changes, model deprecations). Transient 429/503/529 → ONE retry inside `callAnthropic`; if the retry also returns transient, the test logs a warning and PASSES so Anthropic outages don't block PR merges. Wired into the GitHub Actions PR workflow via `secrets.ANTHROPIC_API_KEY`.

**Why this is the right framing**: the goal of Phase 0.3 is to give 0.4 cutover confidence that flipping the edge functions over to `runAgent` produces identical behaviour. With Anthropic mocked and identical inputs, "≤ 2% drift" becomes the wrong bar — 100% byte-equal is achievable and is the only bar that proves the runtime is a no-op refactor at the model interface. The fixtures are the documented behavioural contract; the live API layer is the real-world tripwire.

##### Pure additive — legacy code untouched

The legacy edge functions (`ai-chat/index.ts`, `ai-planner/index.ts`, `message-router/index.ts`) and `_shared/operations/routing.ts` are NOT modified in this PR. Phase 0.4 is the cutover.

**Exit criteria**: all three layers green in CI. ≥ 50 tests across the three test files (target met: 83 with Layer C running, 80 with Layer C skipped). Byte-equal parity locked for ≥ 3 fixtures per agent shape.

**Rollback**: delete `supabase/functions/_shared/operations/agentRuntime.ts`, the `agentRuntime/` sub-folder, the three test files, and the fixture module. Revert the `ANTHROPIC_API_KEY` env addition in `.github/workflows/ci.yml`. Pure additive — nothing has been wired in to production paths yet.

#### 0.4 — Edge function cutover

- Refactor `ai-chat`, `ai-planner`, and `message-router` to be thin shells that translate their request shape into `runAgent(supabase, "recruiting" | "proactive_planner" | "inbound_router", request)`.
- Each shell preserves its existing HTTP surface so the frontend, cron, and webhook contracts are unchanged.
- Per the SaaS retrofit's strict-RLS audit, every Supabase query inside `runAgent` runs as `service_role` for now (matches the rest of the codebase). User-JWT call paths are documented but not yet introduced.
- Bake ≥ 7 days. The parity harness from 0.3 runs nightly via a new GitHub Action and fails CI if drift exceeds threshold.

**Exit criteria**: all three legacy code paths now route through `runAgent`. Parity harness green for 7 consecutive days. Token cost and latency within ±5% of pre-cutover baseline.

**Rollback**: each edge function keeps its old code in a `*_legacy.ts` sibling for one bake cycle; flip the entry point back if drift is detected.

#### 0.5 — Settings UI for agent manifest editing

- New admin-only Settings page: list of agents, per-agent detail view, edit kill switch / shadow mode / system prompt / tool allowlist / autonomy profile.
- Editing the system prompt or tool allowlist increments `version` and writes a row to a new `agent_versions` history table (one row per change, full snapshot, who/when).
- Saving a kill switch or shadow mode change is immediate; saving a manifest change requires confirmation and shows a diff.
- Version history is read-only and exportable.

**Exit criteria**: an operator (admin role) can flip kill switch and shadow mode, edit prompts, and revert to a prior version, entirely from the UI.

**Rollback**: hide the page; the underlying tables stay (additive).

---

## Phase 1 — Trust & safety primitives

**Goal**: Make the platform safe to put a new live agent on top of. Build the audit log, tighten autonomy promotion, and surface per-agent metrics.

**Gate**: Phase 0.5 shipped and baked ≥ 7 days. Still safe to run in parallel with SaaS Phase B/C/D — no new agent capabilities ship.

### Sliced into ~4 sequential PRs

#### 1.1 — `agent_actions` billing-grade audit log

- New table `agent_actions`. Columns: `id`, `org_id`, `agent_id`, `agent_version`, `action_type`, `entity_type`, `entity_id`, `phase` (suggested | confirmed | executed | auto_executed | rejected | expired | shadow), `actor`, `payload` (jsonb), `outcome_id` (FK to action_outcomes when applicable), `created_at`, `prev_hash` (text), `row_hash` (text), `signature` (text).
- `row_hash` is a SHA-256 of `(prev_hash || canonical(payload) || created_at_ns || agent_id || phase)`.
- `signature` is the row hash signed with a per-org Ed25519 key. Keys live in Supabase Vault (extending the Phase C secrets pattern; until C ships, a single Tremendous Care key in env var with a sentinel comment to flip on Phase C).
- A daily cron (`agent-actions-verify`) walks the chain and alerts on any broken hash or invalid signature.
- Every `runAgent` invocation that would write to `events` or `action_outcomes` also writes to `agent_actions`. The two are inserted in the same transaction.
- Export endpoint: `GET /functions/v1/agent-actions-export?agent_id=...&from=...&to=...` returns NDJSON with full chain verification metadata.

**Exit criteria**: every agent action in the last 7 days appears in `agent_actions` with valid hash chain and signature. Verification cron green for 7 consecutive days. Export tested end-to-end on a Tremendous Care sample.

**Rollback**: stop dual-writing; `agent_actions` becomes read-only history. Hash-chain breaks are alerted, not auto-repaired.

#### 1.2 — Tightened autonomy promotion algorithm

- Add `autonomy_profile` JSONB to the `agents` row (already in the manifest schema from Phase 0.1, but unused until now).
- New helper in `_shared/operations/autonomy.ts`:
  - `evaluatePromotion(agentId, actionType, recentOutcomes)` — returns `{ shouldPromote, shouldDemote, newLevel, reason }`.
  - Reads from `autonomy_profile` instead of the legacy `autonomy_config` consecutive-counter.
  - Computes success rate over the last `lookback_window` actions (default 50).
  - Enforces `min_consecutive`, `min_success_rate`, and `min_sample` per transition.
  - Refuses to promote past `max_level`.
  - Fires immediate one-level demote + lockout on any action with `outcome_detail.severity = 'harmful'`.
- `recordAutonomyOutcome` becomes a thin wrapper that calls `evaluatePromotion` and applies the result.
- The legacy `autonomy_config` table stays writeable but its values are no longer read by the runtime — they become a back-compat view materialized from `autonomy_profile`.
- Settings UI gains a "promotion history" panel per (agent × action) showing the last 100 evaluations with reason.

**Exit criteria**: every (agent × action) has its current level computed by the new algorithm. The legacy table reflects the same levels via the materialized view. No level changes during bake unless data warrants it.

**Rollback**: feature flag `autonomy_v2_enabled` (default true). Flipping it false reverts to the legacy `recordAutonomyOutcome` path.

#### 1.3 — Per-(agent × org) kill switch + shadow mode hardening

- Phase 0 already has `kill_switch` and `shadow_mode` columns on `agents`. This PR hardens the enforcement and observability:
  - Kill switch is checked at the very top of `runAgent` and inside `executeSuggestion` (defense in depth — a kill flip mid-loop must take effect).
  - Shadow mode rerouting:
    - Any tool call with `riskLevel = "auto"` runs read-only methods only and returns a synthetic result.
    - Any tool call with `riskLevel = "confirm"` produces an `ai_suggestions` row with `status = 'shadow'` and no execution path.
    - Outcome detection still runs against shadow rows so we can grade the agent against reality without affecting it.
  - New "shadow vs reality" report: weekly job compares shadow suggestions against operator actions for the same entity in the same window. Surfaces agreement rate, disagreement detail, and confidence calibration.
- Kill switch and shadow mode toggles write to `agent_actions` (auditable governance changes).

**Exit criteria**: a synthetic test flips the kill switch on the recruiting agent in production; the next chat invocation returns immediately with a "agent is dormant" response and writes a `kill_switch_engaged` row to `agent_actions`. Toggling back restores normal behavior.

**Rollback**: kill switch and shadow mode revert to no-op flags; controls remain in the schema for future use.

#### 1.4 — Per-agent metrics dashboard

- New admin page `/settings/agents/{slug}/metrics`:
  - Token cost (input/output) and latency, daily / weekly / 30-day.
  - Suggestion volume by status (pending, approved, rejected, executed, auto-executed, expired, shadow).
  - Verified-outcome rate, by action type, with the moving-window success rate that drives promotion.
  - Cost per verified outcome (tokens × price ÷ verified outcomes).
  - Drift events from the consolidation pipeline.
- All charts read from `agent_actions` and `action_outcomes` — no extra writes.
- Export to CSV.

**Exit criteria**: dashboard renders for all three Phase 0 agents with at least 14 days of data. Owner can answer "is this agent earning its keep?" in under a minute.

**Rollback**: hide the page.

---

## Phase 1.5 — Retrospective grading UI

**Goal**: Convert the months of accumulated `ai_suggestions` (currently ungraded — "implicit shadow mode") into a calibration set for Phase 2's autonomy work.

**Gate**: Phase 1.4 shipped. Still no new agents in production.

**Why this exists**: the proactive_planner and inbound_router agents have been firing suggestions into `ai_suggestions` for months, but operators don't act on them. As of process discovery (2026-04-30): 3,847 stamped suggestions, 0 graded. That backlog is gold for calibration if we can grade it. Without grading, Phase 1.2's promotion-v2 algorithm has no data to drive autonomy decisions on the recruiting funnel agent in Phase 2.

### Sliced into one PR (small)

#### 1.5.1 — `ai_suggestion_grades` table + grading UI

- New table `ai_suggestion_grades`:
  ```
  id              uuid PK
  org_id          uuid (default_org_id())
  suggestion_id   uuid REFERENCES ai_suggestions(id) ON DELETE CASCADE
  verdict         text CHECK (verdict IN ('good', 'bad', 'harmful'))
  rationale       text
  graded_by       text
  graded_at       timestamptz default now()
  ```
- RLS strict / fail-closed (`tenant_isolation_ai_suggestion_grades_*`).
- New admin-only Settings page `/settings/agents/grading`:
  - Filterable list of `ai_suggestions` (by agent, source_type, action_type, date, ungraded-only).
  - Each row shows: title, drafted content, action params, intent, autonomy level, status — and three buttons (good / bad / harmful) plus a free-text rationale.
  - Verdict writes a row to `ai_suggestion_grades`. Re-grading supersedes the prior verdict (additive — old grades stay for audit).
  - Bulk-grade pattern: select N rows, apply the same verdict (with rationale).
- Phase 1.2's autonomy-v2 algorithm reads grades alongside live approvals as input. A "harmful" verdict counts as an immediate one-level demote on the corresponding action.
- Optional: keyboard shortcuts (g/b/h) for fast review.

**Exit criteria**: grading page renders, owner can grade ≥ 50 suggestions in an afternoon, verdicts persist, autonomy-v2 algorithm reads them.

**Rollback**: hide the page; the table stays (additive).

---

## Phase 2 — Recruiting Agent: Autonomous Funnel Orchestration

**Goal**: Transform the existing recruiting agent from copilot into autonomous funnel orchestrator. Drive every caregiver from CSV upload to verified orientation completion within the time targets (5d gold / 7d good / 14d acceptable). Humans intervene only at the three locked gates: virtual interview, onboarding-document accuracy review, orientation.

**Gate**: SaaS Phase B5 baked on every AI-tier table (`events`, `action_outcomes`, `ai_suggestions`, `context_memory`, `autonomy_config`, `agents`, `agent_actions`, `agent_versions`). Phase 1.5 baked ≥ 7 days with ≥ 100 graded suggestions in the calibration set.

**Why this is the wedge**: locked in `AGENT_PLATFORM_VISION.md` (revised 2026-04-30). Restated:
- Recruiting agent (AI chat) is already in active production use by the owner.
- Months of accumulated suggestions data exist for calibration.
- Existing chat UI surface — no new review habit needed for the team.
- Improvements show up in software people already open, building trust before Phase 3 asks for new review behavior.
- Outcome signal is clean: orientation conductor checks `onboarding_complete` task = win.

**Process source-of-truth**: `docs/AGENT_PLATFORM_PROCESS.md`. The Phase 2 sub-phases below enact the funnel described there. Process changes update that doc and re-shape the corresponding sub-phase or `funnel_stages` row.

### Sliced into 6 sub-phases (stage-by-stage)

The funnel has 6 stages (Stage 1 Screening → Stage 2 Triage → Stage 3 Booking → Stage 4 Interview → Stage 5 Verification → Stage 6 Onboarding Docs → Stage 7 Orientation). Each sub-phase below ships **one stage's orchestrator** in shadow mode for ≥ 14 days, calibrates against operator behavior + grading UI, then promotes to L1 confirm-everything, then climbs autonomy as data permits.

This is intentionally slow and visible. We graduate the funnel **stage by stage**, not in a single big-bang cutover.

#### 2.1 — Funnel state machine (data-as-process)

- New tables `funnel_stages` and `funnel_transitions` per the schema sketched in `docs/AGENT_PLATFORM_PROCESS.md` ("Funnel state machine" section).
- Seed Tremendous Care's 6 stages from the as-is process. Each stage row:
  - `pipeline_phase` mapping (NULL/intake/interview/verification/onboarding/orientation)
  - `human_gate` flag (true for Stage 4, Stage 6 review, Stage 7)
  - `enter_action`, `wait_until`, `on_timeout`, `on_failure` — all data, all editable.
- New Settings UI page `/settings/agents/funnel` for editing stages + transitions.
- Recruiting agent's manifest gains a `funnel_slug = 'recruiting_v1'` reference.
- No orchestrator loop yet — this PR is data + UI only. The agent does not consume the funnel rows yet.
- Vitest: schema validation, seed correctness, UI roundtrip (create-edit-revert).

**Exit criteria**: 6 stages + N transitions seeded, editable from the UI, version-history (similar to `agent_versions`) recording every change.

**Rollback**: drop the two tables. Agent doesn't read them yet, so nothing else breaks.

#### 2.2 — Stage 1 (Screening) orchestrator + Microsoft 365 Bookings webhook foundation

- Recruiting orchestrator (cron + event-triggered) for Stage 1 only:
  - On new caregiver: send screening survey (or rely on existing automation rule, with the agent acting as an observer + escalator).
  - On survey response received: classify pass / flag / DQ from the survey JSON.
  - On no response in N days: escalate per `funnel_stages.on_timeout`.
- New edge function `bookings-webhook` ready to receive M365 Bookings webhook events (`booking_created`, `booking_rescheduled`, `booking_cancelled`, `booking_completed`). Writes events to the `events` bus. (Owner is implementing the M365 integration in parallel; the webhook endpoint is ready when they're ready.)
- Ships in shadow mode for ≥ 14 days. Calibration: agent's classify-pass-flag-DQ judgments grade out at ≥ 80% agreement vs. operator + zero harmful in 7 consecutive days. Then promote to L1.
- The hard auto-DQ (legal-to-work = no) graduates to L4 from day one because it's deterministic and safe.

**Exit criteria**: orchestrator green in shadow mode for 14 days, calibration thresholds met, owner sign-off, then promote to L1 for non-DQ actions.

**Rollback**: pause the orchestrator cron, kill_switch on the recruiting agent. The agent reverts to copilot mode.

#### 2.3 — Stage 2 (Triage) orchestrator + Stage 3 (Booking) orchestrator with bookings integration live

- Triage: pass routes to booking; flag escalates with operator alert; DQ archives with reason.
- Booking: agent generates the M365 booking link, sends via SMS or email per caregiver preference, watches for `booking_created` event.
- On no booking after N days: escalate per the timeout rule. Templates already exist (`Virtual Interview`).
- Ships in shadow mode for ≥ 14 days. Same promotion gating.

**Exit criteria**: caregiver can flow Stage 1 → 2 → 3 entirely under agent orchestration in shadow mode without operator intervention; booking events arrive cleanly from M365.

**Rollback**: pause Stage 2 + 3 orchestrators independently.

#### 2.4 — Stage 4 (Interview) post-meeting orchestrator + Stage 5 (Verification / HCA) orchestrator

- Interview itself stays human (locked gate). After interview:
  - Read interview recording, transcript, interview survey from M365.
  - Compute initial advancement decision (pass / fail / borderline). Agent surfaces the recommendation; human approves.
- Verification (HCA) handles 3 sub-paths:
  - Branch A (HCA confirmed) → advance to Stage 6.
  - Branch B (claims HCA, no PER ID verified) → guidance SMS, chase weekly.
  - Branch C (no HCA) → CareAcademy enrollment, background check, weekly chase, monthly escalation.
- The post-interview judgment runs in shadow for ≥ 21 days (longer because consequences are bigger).

**Exit criteria**: Stage 4 advancement recommendations grade ≥ 80% agreement with operator decisions; Stage 5 chase pattern reduces stuck-in-Pending-HCA dropouts by a measurable amount.

#### 2.5 — Stage 6 (Onboarding Documents) orchestrator

- Two parallel tracks:
  - Track A: send unsigned document request via existing `document_upload_tokens` flow. Watch SharePoint upload events. Chase missing.
  - Track B: send 6-document e-signature packet. Watch `esign_envelopes` status transitions. Chase stuck signatures.
- Detect "all complete" state. Surface for human accuracy review (locked gate).
- After human review, advance to Stage 7.

**Exit criteria**: stuck-document failure mode reduced; doc completion within X days from packet send sustained.

#### 2.6 — Stage 7 (Orientation) orchestrator + handoff signal

- Schedule orientation (per-caregiver as-needed today; user willing to move to weekly cadence — decide before this sub-phase).
- Send confirmation, day-before reminder, day-of reminder.
- After orientation, observe `onboarding_complete` task completion. **Win event recorded.**
- Handoff signal: emit `agent_request` (Phase 5) to scheduling agent (when Phase 4 ships) — until then, set caregiver to `archive_phase = 'won'` with `archive_reason = 'onboarding_complete'` and emit a "ready for scheduling" alert to the operator UI.

**Exit criteria**: end-to-end caregiver onboarding completion under recruiting agent orchestration, sustained for 30 days at L1+ with green metrics. Recruiting agent is **graduated**.

### Recruiting graduation success criteria (from VISION_DOC + owner)

Phase 2 is "shipped" when:
- **Onboarding completion rate** improves by an owner-defined target percentage (initial target TBD; baseline from current 30/60/90-day data) for caregivers who entered the funnel post-graduation.
- **N actions per week** auto-execute with zero rejections in the prior 30-day rolling window. (N to be set per action type.)
- **Friction metric**: median operator decisions per onboarded caregiver drops monotonically over the 6 sub-phase rollout.
- **Latency metric**: time-to-first-agent-action on a new caregiver drops to < 1 hour during business hours.
- **Zero harmful incidents** in the 30 days preceding graduation.

These metrics live in the per-agent dashboard from Phase 1.4. Phase 2 is the first time the dashboard tells a story end-to-end.

---

## Phase 3 — Intake (client lead management) agent

**Goal**: Ship the second new production agent (first new agent = recruiting graduation in Phase 2). Move new client leads through inquiry → assessment → start-of-care faster and more reliably than the team does today, with verified outcomes.

**Gate**: Phase 2 stages 1–6 graduated to L1+ with green metrics ≥ 30 days. Phase 2 graduation already required SaaS Phase B5 baked on every AI-tier table; that requirement carries forward.

### Why intake before scheduling (not the wedge anymore, but still ahead of scheduling)

Locked in `AGENT_PLATFORM_VISION.md` (revised 2026-04-30). Restated for the implementer:

- **Smaller blast radius than scheduling.** A bad scheduling agent affects clock-ins and shift coverage (downstream of pay, compliance, client SLAs). A bad intake agent affects lead conversion (recoverable, manual fallback well-understood).
- **Cleanest outcome signal.** `clients.start_of_care_date` is set or it isn't. No interpretation. Compare to scheduling, where "shift filled" depends on "and it was actually worked", "and it wasn't no-showed", "and the right caregiver showed up".
- **De-risks scheduling.** Once recruiting + intake are live, the runtime + per-(agent×org) controls + audit log + autonomy-v2 algorithm are battle-tested across two domains before scheduling exposes its larger blast radius.
- **No new domain to discover.** The agent platform's runtime, manifest semantics, and grading pipeline are all proven by the time intake ships. Phase 3 is "another agent on the same rails," not "another platform iteration."

### Sliced into ~5 sequential PRs

#### 3.1 — Intake agent manifest + tool allowlist

- New row in `agents` for org=Tremendous Care, slug=`intake`, version=1, kill_switch=true (off until 2.5), shadow_mode=true.
- `tool_allowlist` (initial cut, narrow):
  - Reads: `get_client_detail`, `search_clients`, `list_stale_clients`, `get_client_pipeline_stats`, `get_action_items`, `get_inbound_messages`, `search_emails`, `get_email_thread`, `get_sms_history`, `get_call_log`, `get_call_recording`, `get_call_transcription`.
  - Writes (gated by autonomy): `add_client_note`, `update_client_field`, `update_client_phase`, `complete_client_task`, `send_sms` (client-only), `send_email` (client-only), `create_calendar_event` (assessment scheduling).
  - Explicitly **not allowed**: any caregiver-side write tool, `send_docusign_envelope`, `send_esign_envelope`, `update_board_status` (caregiver-only).
- `outcome_definition`:
  ```jsonc
  {
    "primary": {
      "event_type": "client_phase_changed",
      "from_phase_in": ["new_lead", "initial_contact", "consultation", "in_home_assessment", "proposal"],
      "to_phase": "won",
      "window_days": 30
    },
    "secondary": [
      { "event_type": "calendar_event_created", "subject_contains": "assessment", "window_hours": 48 },
      { "event_type": "client_phase_changed", "to_phase": "consultation", "window_days": 7 }
    ],
    "escape_clauses": [
      "operator_confirmed_completion (used only when phase advancement happens via dispatcher action that the agent prepared)"
    ]
  }
  ```
- `context_recipe`: same six layers as the recruiting agent (identity, situational, memories, threads, viewing, guidelines), but the identity layer narrows pipeline stats to clients only and the guidelines layer is intake-specific.
- `triggers`:
  - Cron: every 30 min, scan stale clients in pre-`won` phases for follow-up suggestions.
  - Event: `client_created`, `inbound_sms_log` (client-channel), `email_received` (client-channel), `client_phase_changed` to `consultation` or `in_home_assessment`.

**Exit criteria**: row present, manifest validated, kill switch on, shadow mode on. No invocations yet.

**Rollback**: delete the row.

#### 3.2 — Intake-specific context layer + system prompt

- New context-assembler layer file `ai-chat/context/layers/intake.ts` (or refactor the existing situational layer to accept a per-agent slice).
- The system prompt is intake-specific: emphasis on lead quality assessment, qualification questions, scheduling assessments, identifying urgency signals, distinguishing prospects from referral sources, escalation triggers (e.g., "client mentioned hospice").
- Prompt drafted in collaboration with the operator who handles intake today. Captured as a checked-in markdown file `docs/agent-prompts/intake.md` so it's reviewable and diffable; the manifest references the rendered string.

**Exit criteria**: manifest's `system_prompt` field reflects the file contents. Operator has reviewed and approved the prompt.

**Rollback**: revert the prompt; agent stays in shadow mode regardless.

#### 3.3 — Intake agent edge function shell

- New edge function `supabase/functions/intake-agent/index.ts`. ~50 lines: validates the request, looks up the org, calls `runAgent(supabase, "intake", request)`. Same shape as the Phase 0.4 shells.
- Cron registration: `intake-agent` runs every 30 min.
- Event subscriptions: hook from `inbound_sms_log` and `email_received` for client channel triggers.

**Exit criteria**: function deploys, cron fires, event triggers reach the runtime, shadow-mode suggestions land in `ai_suggestions` with `status = 'shadow'` and `agent_id = intake`.

**Rollback**: pause the cron, remove the event subscription. Function stays deployed, dormant.

#### 3.4 — Shadow mode bake (≥ 14 days)

- Intake agent runs in shadow mode for ≥ 14 days against real Tremendous Care client traffic.
- Daily review by the operator and the owner: open the per-agent metrics dashboard, scan the shadow suggestions, mark agreements / disagreements / harmful suggestions in a new "shadow review" UI.
- Calibration target before promotion to L1: ≥ 70% agreement on action choice, ≥ 80% appropriateness on drafted message tone, zero harmful suggestions in the last 7 days.
- Any harmful suggestion automatically extends the bake by 7 days from the date of the harm.

**Exit criteria**: 14 consecutive days with no harmful suggestion, agreement and tone calibration above thresholds, owner sign-off.

**Rollback**: extend bake; flip kill switch on if the agent is generating noise that costs more than it saves to review.

#### 3.5 — Promote intake agent to L1, then data-driven climb

- Flip `shadow_mode = false`, `kill_switch = false`. Initial autonomy levels:
  - `add_client_note`: L4 (auto, low risk)
  - `complete_client_task`: L1 (suggest)
  - `update_client_phase`: L1 (suggest)
  - `update_client_field`: L1 (suggest)
  - `send_sms`: L1 (suggest)
  - `send_email`: L1 (suggest)
  - `create_calendar_event`: L1 (suggest)
- Per-action ceilings from the manifest's `autonomy_profile.transitions`. Promotion is data-driven from this point.
- Weekly review of `agent_actions` log + outcomes dashboard. Owner can demote any action manually at any time.
- After 30 days at L1+ with green metrics, intake agent is considered shipped.

**Exit criteria**: agent live, no harmful incidents, verified-outcome rate trending positive, cost per outcome under operator's manual-cost baseline.

**Rollback**: flip kill switch, file an incident, post-mortem before re-enabling.

---

## Phase 4 — Scheduling agent

**Goal**: Ship the third new production agent. Fill open shifts, handle call-offs, match caregivers to shifts. The biggest external demo, the largest blast radius.

**Gate**: Phase 3 baked ≥ 30 days at L1 or higher with green metrics. Recruiting (Phase 2) and Intake (Phase 3) running cleanly is the prerequisite — scheduling does not get to be the proving ground.

### Sliced into ~5 sequential PRs (mirrors Phase 3)

#### 4.1 — Scheduling agent manifest

- New row, slug=`scheduling`. Initial kill_switch on, shadow_mode on.
- `tool_allowlist` (initial cut):
  - Reads: `get_caregiver_detail`, `search_caregivers`, `check_availability`, `check_compliance`, plus new scheduling-specific reads: `list_open_shifts`, `get_shift_offers`, `get_caregiver_availability`, `match_caregivers_to_shift`.
  - Writes: `send_sms` (caregiver-only, gated), `create_calendar_event`, plus new: `create_shift_offer`, `assign_caregiver_to_shift`, `update_shift_status`.
  - Explicitly **not allowed**: any client-side write tool, `send_docusign_envelope`, payroll/timesheet writes.
- `outcome_definition`:
  ```jsonc
  {
    "primary": {
      "event_type": "clock_event_recorded",
      "clock_type": "clock_in",
      "shift_match": "agent_assigned_caregiver",
      "window_minutes_after_shift_start": 15
    },
    "invalidators": [
      "shift_no_show_recorded",
      "dispatcher_reassigned_after_agent_action (within 60 min of agent action)"
    ],
    "escape_clauses": []
  }
  ```
  Note the *invalidator* concept: a verified outcome can be retroactively voided by a no-show or dispatcher override. This is stricter than intake on purpose — scheduling outcomes need to survive the dispatcher's veto to count.
- `context_recipe`: identity narrowed to scheduling (open shifts, caregiver availability, recent assignments), no client phase data.
- `triggers`:
  - Cron: every 15 min during business hours, every hour off-hours.
  - Event: `shift_created`, `shift_offer_declined`, `inbound_sms_log` matched to a shift offer, `caregiver_call_off_recorded`.

#### 4.2 — Scheduling-specific tools and context

- New tools registered: `list_open_shifts`, `get_shift_offers`, `get_caregiver_availability`, `match_caregivers_to_shift`, `create_shift_offer`, `assign_caregiver_to_shift`, `update_shift_status`. Each goes through the existing tool registry pattern with explicit `riskLevel`. The matching tool reuses `src/lib/scheduling/availabilityMatching.js`.
- New context layer `ai-chat/context/layers/scheduling.ts`: open shifts in next 7 days, caregiver availability heatmap, last 30 days of fill rate by day-of-week and shift-type.

#### 4.3 — Scheduling agent edge function shell

Same pattern as 2.3. Cron + event triggers configured.

#### 4.4 — Shadow mode bake (≥ 21 days, longer than intake because higher stakes)

Same pattern as 2.4 with stricter calibration: ≥ 80% agreement on assignment choice, zero harmful suggestions for 14 consecutive days, no shift-coverage regression vs. dispatcher baseline.

#### 4.5 — Promote scheduling to L1, then data-driven climb

Same pattern as 2.5. Initial L1 across all writes — scheduling does not get the auto-note bypass that intake had. After 60 days at L1 with green metrics, scheduling agent is shipped.

---

## Phase 5 — Inter-agent dispatch

**Goal**: Enable agent-to-agent hand-offs without direct LLM calls. Unlocks Phase 6 and beyond. Three production agents (recruiting, intake, scheduling) running cleanly is the prerequisite — dispatch is built only after we know we have agents that need to talk.

**Gate**: Phase 4 baked ≥ 30 days.

- New table `agent_requests`. Columns: `id`, `org_id`, `from_agent_id`, `to_agent_slug`, `request_type`, `payload`, `status` (pending | claimed | processed | failed | expired), `claimed_at`, `processed_at`, `result`, `created_at`, `expires_at`.
- New helper `_shared/operations/agentRequests.ts` with `enqueueAgentRequest()` and `claimNextRequest()`. Queue semantics: at-least-once, idempotency-key on `payload.idempotency_key`, exponential backoff on retries.
- Each agent's `triggers` manifest gains an `agent_requests` subscription option.
- First production hand-off: **Recruiting agent → Scheduling agent** (recruiting agent already needs this in Phase 2.6 — until Phase 5 ships, recruiting just sets archive_phase=won and emits an alert). After Phase 5, recruiting enqueues a typed request to scheduling for first-shift seeding.
- Second hand-off: Intake agent → Scheduling agent. When intake confirms a SOC date, intake enqueues a request for scheduling to seed initial shifts. Scheduling consumes, suggests an initial schedule, and (in shadow mode for first 30 days) returns a result.
- Audit: every hand-off writes to `agent_actions` on both sides (`enqueued_agent_request` from sender, `processed_agent_request` from receiver). The chain links them via `agent_actions.linked_action_id`.

**Exit criteria**: Recruiting → Scheduling and Intake → Scheduling hand-offs both work end-to-end. Both sides shadow-mode for the new paths. No degradation of any agent's outcome rates.

**Rollback**: pause the queue cron, hand-offs queue but do not process; agents fall back to independent operation (recruiting reverts to "set archive_phase=won and alert").

---

## Phase 6 — Care coordination agent

**Goal**: Fourth new production agent. Ongoing client care management, family communication, escalations, visit follow-ups.

**Gate**: Phase 5 baked ≥ 30 days, Recruiting/Intake → Scheduling hand-offs live and green.

Sliced like Phases 2, 3, and 4. Notable differences:

- Heavy reliance on `agent_requests` from the start. Care coordination consumes hand-offs from intake (post-SOC) and scheduling (post-clock-in patterns) and emits hand-offs back to scheduling (caregiver-fit issues) and intake (re-engagement of paused clients).
- Outcome definition centered on retention milestones: 30-day, 90-day, 180-day client retention; satisfaction survey responses; escalation resolution time.
- Memory consumption tilts heavier on org-shared (preferences, family communication preferences, cultural context) than intake or scheduling did.

---

## Phase 7 — Marketplace, billing, voice, mobile

**Goal**: Make the platform sellable to other agencies and unlock vertical differentiators.

**Gate**: SaaS Phase E shipped + Phase 6 baked.

- **Marketplace UI**: agent catalog, per-org install/configure/test in sandbox, version pinning, cost preview.
- **Per-task billing**: meter `agent_actions` rows with `phase = 'verified_outcome'` per agent per org, integrate with Stripe + QBO. Dispute resolution surface: customer can flag a charge, the audit log + `outcome_definition` produces the receipt.
- **Voice agent**: outbound recruiting calls, intake interviews, caregiver check-ins. Build vs partner decision deferred per vision doc.
- **Mobile-native caregiver experience**: clock-in, shift questions, escalations. Required to fully realize scheduling's verified-outcome model.
- **State Medicaid + EVV integrations**: vertical moat.

This phase is intentionally less detailed in this doc — it spans 12+ months and architectural decisions inside it depend on Phase 0–5 outcomes.

---

## Anti-patterns (do not do)

- **Adding a new agent by writing a new edge function.** Every new agent is a row in `agents`. The runtime does not change.
- **Bypassing the `agent_id` stamp on writes.** Every `events`, `action_outcomes`, `ai_suggestions`, `context_memory`, or `agent_actions` row written by an agent must carry the agent's id (or NULL for org-level memory, explicitly).
- **Reading another agent's memory directly.** Cross-agent reads happen through the documented UNION clause (own + org-level + shareable), never via direct queries against another agent's slice.
- **Direct LLM-to-LLM tool calls between agents.** Use `agent_requests`. Always.
- **Self-reported outcomes.** An agent never marks its own action complete. Every `verified_outcome` row in `agent_actions` must reference an external event id from the `events` bus.
- **Promoting on consecutive approvals alone.** All transitions go through the v2 algorithm: per-transition thresholds + fixed-window success rate + minimum sample size.
- **Skipping shadow mode on a new agent.** Every new agent ships in shadow mode for ≥ 7 days before its first L1 action. Scheduling needs ≥ 21.
- **Touching `agent_actions` directly outside the runtime.** The hash chain is the receipt. Dual-writes happen only in `runAgent` and `executeSuggestion`. Manual edits invalidate the chain and trip the verifier.
- **Adding Tremendous-Care-specific strings to a manifest.** Manifests are per-org. If Tremendous Care's intake prompt mentions "Tremendous Care", the manifest field is OK — but tools, context layers, and runtime code stay org-agnostic.
- **Skipping the rollback plan.** Every agent-platform PR ships with rollback in the description, same rule as the SaaS retrofit.
- **Parallel phase work.** Phase 0 → 1 → 2 → 3 → 4 → 5 → 6, sequential. Do not start phase N+1 before phase N has shipped and baked.

---

## Key coupling hot spots to watch

These were identified during the agent platform survey:

- **`supabase/functions/ai-chat/index.ts`** is monolithic today (~520 lines, 40 tools, hardcoded recruiting context). Phase 0.4 thins it to a `runAgent("recruiting", ...)` shell. Care needed: the existing rate limiter, JWT auth, briefing handler, and confirmed-action handler all live in this file. They become helpers in `_shared/operations/`, not deletions.
- **`supabase/functions/_shared/operations/routing.ts`** is 1,194 lines. `executeSuggestion` is the single execution path; do not fork it per agent. The classifier prompt inside it is recruiting-flavored and will bleed into other agents — Phase 0.3 extracts the classifier into a per-agent setting in the manifest.
- **`supabase/functions/ai-chat/context/assembler.ts`** reads all caregivers and clients into the system prompt. At multi-org scale and per-agent scoping, this fans out token cost. Phase 0.3 narrows reads via the `context_recipe` and per-agent identity layer.
- **`autonomy_config` table** is global today. Phase 0.1 re-keys its rows into per-agent `autonomy_profile` JSONB. Phase 1.2 makes the JSONB authoritative; the table becomes a back-compat view.
- **`ai_suggestions` is the human-in-the-loop UI surface.** Multiple agents writing to it must not collide on the existing Settings UI's filtering. Phase 0.2 adds `agent_id`; Phase 0.5 adds per-agent filtering in the UI.
- **`automation-cron`** and **`outcome-analyzer`** iterate global data. Phase 0 leaves them untouched (they predate the platform); Phase 4 considers whether they themselves become agents.
- **`ai-planner` daily run is idempotent on `app_settings.last_planner_run`.** Once promoted to a manifest-driven agent, idempotency moves to the runtime layer.

---

## Decisions locked

Authoritative list lives in `docs/AGENT_PLATFORM_VISION.md` under "Strategic decisions locked". Operational decisions specific to the plan:

- **Three legacy agents migrate, do not rebuild.** Behavior parity verified by replay harness in Phase 0.3, gated CI in Phase 0.4.
- **Recruiting graduation is the wedge** (revised 2026-04-30). Intake is second. Scheduling is third. Care coordination is fourth.
- **Onboarding-complete task = win signal.** The orientation conductor (human) checks an `onboarding_complete` task; the agent observes that as the verified third-party outcome. Agent never marks its own work done.
- **Process is data, not code.** Funnel stages, transitions, timeouts, branching rules, message templates, human gates, time targets all live in editable rows. The runtime is the only thing in code. See `docs/AGENT_PLATFORM_PROCESS.md`.
- **Phase 1.5 retrospective grading UI** ships before Phase 2. Months of accumulated `ai_suggestions` data become Phase 2's calibration set.
- **`agent_id = NULL` on memory means org-level shared.** Tag `shareable` on a non-NULL row also makes it cross-agent readable. Both are intentional, both are documented.
- **`agent_actions` is hash-chained Ed25519-signed per-org.** Until SaaS Phase C ships per-org Vault secrets, Tremendous Care uses a single env-var key with a sentinel comment for cutover.
- **Promotion algorithm v2 is the only autonomy algorithm after Phase 1.2.** The legacy `autonomy_config` table becomes a back-compat view.
- **Coarse first, split when data signals it.** No premature sub-agent splits during Phase 2–6.
- **Shadow mode is mandatory for every new agent**, ≥ 7 days minimum, longer per agent risk profile (recruiting per-stage 14, intake 14, scheduling 21).
- **Per-agent edge function shells stay**, even though the runtime is shared. They preserve the HTTP/cron contract and make per-agent deploy/observability cleaner. They are 30–60 lines each, not 500.
- **Microsoft 365 Bookings integration uses Graph API webhooks**. Required by Phase 2.2 (Stage 3 Booking orchestrator). Owner is implementing in parallel with infra phases. Spec in `docs/AGENT_PLATFORM_PROCESS.md` → "Microsoft 365 Bookings integration spec."

---

## Decisions still open

- **Where the per-agent system prompt template lives at edit time.** Two options: (a) the `agents.system_prompt` text column is authoritative, the markdown file in `docs/agent-prompts/{slug}.md` is a mirror that ops manually updates; (b) the markdown file is authoritative and a CI step pushes it into the column. Lean (b) for diffability; revisit at Phase 0.5.
- **Per-org Anthropic API keys before SaaS Phase C ships.** Tremendous Care can use the env var. The first paying customer needs Phase C done. The agent platform must not introduce a parallel secrets store; we use whatever Phase C delivers.
- **Whether `agent_requests` lives in Postgres or a real queue (PGMQ, SQS, Redis).** Postgres is fine through Phase 5; revisit at Phase 6 marketplace scale.
- **Voice agent build vs partner.** Open per the vision doc.
- **Mobile-native caregiver app.** Open per the vision doc; affects scheduling outcome verification quality.
- **Whether the per-agent settings UI exposes the autonomy profile JSONB directly or wraps it.** Direct JSON is faster to ship; wrapped UI is safer. Likely wrapped UI by Phase 1.4.

---

## Related artifacts in the repo

- `docs/AGENT_PLATFORM_VISION.md` — vision, prime directives, locked strategic decisions.
- `docs/AGENT_PLATFORM_PROCESS.md` — recruiting/onboarding process source-of-truth (as-is and target state, survey rules, document flows, M365 Bookings integration spec, time targets, human gates, open process questions).
- `docs/AGENT_PLATFORM_STATUS.md` — current phase, shipped PRs, decision log.
- `docs/SAAS_RETROFIT.md` — multi-tenancy retrofit plan; Phase B5 is the gate for Phase 2.
- `docs/SAAS_RETROFIT_STATUS.md` — current SaaS phase.
- `supabase/functions/_shared/operations/routing.ts` — today's implicit agent runtime; the basis for `agentRuntime.ts` in Phase 0.3.
- `supabase/functions/ai-chat/registry.ts` — tool registry; tool allowlist filtering is layered on top of this in Phase 0.3.
- `supabase/functions/ai-chat/context/assembler.ts` — context layer system; per-agent recipes built on top in Phase 0.3.
- `supabase/migrations/20260222142326_context_layer_phase1_v2.sql` — `context_memory` + `events` foundation.
- `supabase/migrations/20260311200407_inbound_routing_autonomy.sql` — `autonomy_config` + `ai_suggestions` foundation.
- `supabase/migrations/20260320233021_proactive_planner_infrastructure.sql` — proactive context for autonomy.
- `CLAUDE.md` — production safety rules and prime directives, always loaded.
