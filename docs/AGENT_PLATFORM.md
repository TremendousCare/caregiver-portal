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

| Phase | Name | Gate | New agents in production |
|---|---|---|---|
| **0** | Foundation refactor | None — parallel to SaaS Phase B/C/D | None |
| **1** | Trust & safety primitives | Phase 0 baked | None |
| **2** | Intake agent (the wedge) | SaaS Phase B5 baked + Phase 1 baked | +1 (Intake) |
| **3** | Scheduling agent | Phase 2 baked ≥30 days | +1 (Scheduling) |
| **4** | Inter-agent dispatch | Phase 3 baked | None new (enables hand-offs) |
| **5** | Care coordination agent | Phase 4 baked | +1 (Care Coordination) |
| **6** | Marketplace, billing, voice, mobile | SaaS Phase E + Phase 5 baked | Self-serve unlocked |

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
  - Routes confirmed suggestions through the existing `executeSuggestion`.
  - If `shadow_mode = true`, suggestions are inserted with status `shadow` and never executed; outcomes are still tracked for grading.
  - Records cost and outcome telemetry stamped with `agent_id`.
- New test file `src/lib/__tests__/agentRuntime.test.js` and a behavioral parity harness:
  - Replay the last 30 days of `ai-chat` invocations through both the legacy code path and `runAgent` with the recruiting manifest.
  - Diff the resulting suggestions, tool calls, and final replies. Allow ≤ 2% per-character drift on free-text replies; require 100% match on tool calls and suggestion writes.
- The legacy edge functions stay live and untouched in this PR. Parity is verified before any cutover.

**Exit criteria**: parity harness green; `runAgent` produces identical results to the existing `ai-chat`, `ai-planner`, and `message-router` paths on a 30-day replay.

**Rollback**: delete the runtime file and the harness. Nothing has been wired in yet.

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

## Phase 2 — Intake agent (the wedge)

**Goal**: Ship the first new production agent. Move new client leads through inquiry → assessment → start-of-care faster and more reliably than the team does today, with verified outcomes.

**Gate**: SaaS Phase B5 baked on every AI-tier table (`events`, `action_outcomes`, `ai_suggestions`, `context_memory`, `autonomy_config`, `agents`, `agent_actions`, `agent_versions`). Phase 1 baked ≥ 14 days. RLS enforces tenant isolation; permissive policies dropped on AI-tier tables.

### Why intake over scheduling

Locked in `AGENT_PLATFORM_VISION.md`. Restated for the implementer:

- **Highest internal pain.** The team is struggling here today. Internal pain is the cleanest place to ship — the people grading the agent are the people feeling the gap.
- **Smaller blast radius.** A bad scheduling agent affects clock-ins and shift coverage (downstream of pay, compliance, client SLAs). A bad intake agent affects lead conversion (recoverable, manual fallback well-understood).
- **Cleanest outcome signal.** `clients.start_of_care_date` is set or it isn't. No interpretation. Compare to scheduling, where "shift filled" depends on "and it was actually worked", "and it wasn't no-showed", "and the right caregiver showed up".
- **De-risks scheduling.** The runtime gets exercised on a lower-stakes domain first.

### Sliced into ~5 sequential PRs

#### 2.1 — Intake agent manifest + tool allowlist

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

#### 2.2 — Intake-specific context layer + system prompt

- New context-assembler layer file `ai-chat/context/layers/intake.ts` (or refactor the existing situational layer to accept a per-agent slice).
- The system prompt is intake-specific: emphasis on lead quality assessment, qualification questions, scheduling assessments, identifying urgency signals, distinguishing prospects from referral sources, escalation triggers (e.g., "client mentioned hospice").
- Prompt drafted in collaboration with the operator who handles intake today. Captured as a checked-in markdown file `docs/agent-prompts/intake.md` so it's reviewable and diffable; the manifest references the rendered string.

**Exit criteria**: manifest's `system_prompt` field reflects the file contents. Operator has reviewed and approved the prompt.

**Rollback**: revert the prompt; agent stays in shadow mode regardless.

#### 2.3 — Intake agent edge function shell

- New edge function `supabase/functions/intake-agent/index.ts`. ~50 lines: validates the request, looks up the org, calls `runAgent(supabase, "intake", request)`. Same shape as the Phase 0.4 shells.
- Cron registration: `intake-agent` runs every 30 min.
- Event subscriptions: hook from `inbound_sms_log` and `email_received` for client channel triggers.

**Exit criteria**: function deploys, cron fires, event triggers reach the runtime, shadow-mode suggestions land in `ai_suggestions` with `status = 'shadow'` and `agent_id = intake`.

**Rollback**: pause the cron, remove the event subscription. Function stays deployed, dormant.

#### 2.4 — Shadow mode bake (≥ 14 days)

- Intake agent runs in shadow mode for ≥ 14 days against real Tremendous Care client traffic.
- Daily review by the operator and the owner: open the per-agent metrics dashboard, scan the shadow suggestions, mark agreements / disagreements / harmful suggestions in a new "shadow review" UI.
- Calibration target before promotion to L1: ≥ 70% agreement on action choice, ≥ 80% appropriateness on drafted message tone, zero harmful suggestions in the last 7 days.
- Any harmful suggestion automatically extends the bake by 7 days from the date of the harm.

**Exit criteria**: 14 consecutive days with no harmful suggestion, agreement and tone calibration above thresholds, owner sign-off.

**Rollback**: extend bake; flip kill switch on if the agent is generating noise that costs more than it saves to review.

#### 2.5 — Promote intake agent to L1, then data-driven climb

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

## Phase 3 — Scheduling agent

**Goal**: Ship the second new production agent. Fill open shifts, handle call-offs, match caregivers to shifts. The biggest external demo, the largest blast radius.

**Gate**: Phase 2 baked ≥ 30 days at L1 or higher with green metrics.

### Sliced into ~5 sequential PRs (mirrors Phase 2)

#### 3.1 — Scheduling agent manifest

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

#### 3.2 — Scheduling-specific tools and context

- New tools registered: `list_open_shifts`, `get_shift_offers`, `get_caregiver_availability`, `match_caregivers_to_shift`, `create_shift_offer`, `assign_caregiver_to_shift`, `update_shift_status`. Each goes through the existing tool registry pattern with explicit `riskLevel`. The matching tool reuses `src/lib/scheduling/availabilityMatching.js`.
- New context layer `ai-chat/context/layers/scheduling.ts`: open shifts in next 7 days, caregiver availability heatmap, last 30 days of fill rate by day-of-week and shift-type.

#### 3.3 — Scheduling agent edge function shell

Same pattern as 2.3. Cron + event triggers configured.

#### 3.4 — Shadow mode bake (≥ 21 days, longer than intake because higher stakes)

Same pattern as 2.4 with stricter calibration: ≥ 80% agreement on assignment choice, zero harmful suggestions for 14 consecutive days, no shift-coverage regression vs. dispatcher baseline.

#### 3.5 — Promote scheduling to L1, then data-driven climb

Same pattern as 2.5. Initial L1 across all writes — scheduling does not get the auto-note bypass that intake had. After 60 days at L1 with green metrics, scheduling agent is shipped.

---

## Phase 4 — Inter-agent dispatch

**Goal**: Enable agent-to-agent hand-offs without direct LLM calls. Unlocks Phase 5 and beyond.

**Gate**: Phase 3 baked ≥ 30 days.

- New table `agent_requests`. Columns: `id`, `org_id`, `from_agent_id`, `to_agent_slug`, `request_type`, `payload`, `status` (pending | claimed | processed | failed | expired), `claimed_at`, `processed_at`, `result`, `created_at`, `expires_at`.
- New helper `_shared/operations/agentRequests.ts` with `enqueueAgentRequest()` and `claimNextRequest()`. Queue semantics: at-least-once, idempotency-key on `payload.idempotency_key`, exponential backoff on retries.
- Each agent's `triggers` manifest gains an `agent_requests` subscription option.
- First production hand-off: Intake agent → Scheduling agent. When intake confirms a SOC date, intake enqueues a request for scheduling to seed initial shifts. Scheduling consumes, suggests an initial schedule, and (in shadow mode for first 30 days) returns a result; intake's own SOC follow-up tasks reference the shift seeding result.
- Audit: every hand-off writes to `agent_actions` on both sides (`enqueued_agent_request` from sender, `processed_agent_request` from receiver). The chain links them via `agent_actions.linked_action_id`.

**Exit criteria**: Intake → Scheduling hand-off works end-to-end, both sides shadow-mode for the new path, no degradation of either agent's outcome rates.

**Rollback**: pause the queue cron, hand-offs queue but do not process; agents fall back to independent operation.

---

## Phase 5 — Care coordination agent

**Goal**: Third new production agent. Ongoing client care management, family communication, escalations, visit follow-ups.

**Gate**: Phase 4 baked ≥ 30 days, Intake → Scheduling hand-off live and green.

Sliced like Phases 2 and 3. Notable differences:

- Heavy reliance on `agent_requests` from the start. Care coordination consumes hand-offs from intake (post-SOC) and scheduling (post-clock-in patterns) and emits hand-offs back to scheduling (caregiver-fit issues) and intake (re-engagement of paused clients).
- Outcome definition centered on retention milestones: 30-day, 90-day, 180-day client retention; satisfaction survey responses; escalation resolution time.
- Memory consumption tilts heavier on org-shared (preferences, family communication preferences, cultural context) than intake or scheduling did.

---

## Phase 6 — Marketplace, billing, voice, mobile

**Goal**: Make the platform sellable to other agencies and unlock vertical differentiators.

**Gate**: SaaS Phase E shipped + Phase 5 baked.

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
- **Intake is the first new production agent.** Scheduling is second. Care coordination is third.
- **`agent_id = NULL` on memory means org-level shared.** Tag `shareable` on a non-NULL row also makes it cross-agent readable. Both are intentional, both are documented.
- **`agent_actions` is hash-chained Ed25519-signed per-org.** Until SaaS Phase C ships per-org Vault secrets, Tremendous Care uses a single env-var key with a sentinel comment for cutover.
- **Promotion algorithm v2 is the only autonomy algorithm after Phase 1.2.** The legacy `autonomy_config` table becomes a back-compat view.
- **Coarse first, split when data signals it.** No premature sub-agent splits during Phase 2–5.
- **Shadow mode is mandatory for every new agent**, ≥ 7 days minimum, longer per agent risk profile (intake 14, scheduling 21).
- **Per-agent edge function shells stay**, even though the runtime is shared. They preserve the HTTP/cron contract and make per-agent deploy/observability cleaner. They are 30–60 lines each, not 500.

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
