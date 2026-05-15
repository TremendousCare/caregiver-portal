# Agent Platform — Status Tracker

**Full plan**: `docs/AGENT_PLATFORM.md`
**Vision and prime directives**: `docs/AGENT_PLATFORM_VISION.md`
**Process source-of-truth**: `docs/AGENT_PLATFORM_PROCESS.md`
**Upstream dependency**: `docs/SAAS_RETROFIT_STATUS.md` (Phase B5 gates Phase 2 start)

This file is the living tracker. Update it in the same PR that advances the platform. Keep it short and scannable — a new contributor should be able to see in ten seconds where the agent platform stands today.

---

## Current phase

**Phase 1.5 — Retrospective grading UI** *(shipped 2026-05-12, PR #315 + hotfix #316)*
**Phase 1.5 follow-up — Agent loop closure** *(shipped 2026-05-15, PR #317 + PR #347)*
**Pipeline Health UI** *(spec drafted 2026-05-15, supersedes the AI Priorities feed — see `docs/AGENT_PLATFORM_PIPELINE_HEALTH_SPEC.md`)*
**Phase 1.6 — Call Intelligence** *(planned, scoped 2026-05-14, sequenced after the Pipeline Health UI ships)*

**Why this phase is gated on loop closure (locked 2026-05-12):** Discovery during 1.5 smoke testing revealed that the AI Priorities dashboard buttons today only **navigate** — they don't execute the suggested action, don't close the underlying `ai_suggestions` row, and don't write any `agent_actions` row. Combined with low chat usage, the autonomy v2 algorithm sees almost zero `phase='executed'` rows and a steady drip of `rejected` / `expired`. The promotion gates (`min_success_rate ≥ 0.8`) mathematically can't clear, so no action ever promotes past L1 — exactly the symptom we observe. The grading UI partially compensates (every graded `good` is a synthesized positive signal) but treats every suggestion as needing manual review forever — not a feasible long-term path.

The locked fix is the **passive linker** pattern: when an operator performs an action through a regular UI surface, the system looks for a matching pending suggestion server-side, closes it, and writes the audit row the algorithm reads. Zero UX change; the operator keeps working in their existing flow.

**Shipped (PR #317, 2026-05-12):** `closePendingSuggestion` shared helper, `close-pending-suggestion` edge function (JWT auth, service-role internal for the audit write), `agentLoopClosure.js` frontend caller (never throws — fire-and-forget), and the first wiring point in `SMSComposeBar.handleSend`. 14 new specs. After-merge, every operator-sent SMS through the compose bar closes any matching `send_sms` pending suggestion and writes a `phase='executed'` agent_actions row.

**Shipped (PR #347, 2026-05-15):** loop closure PR 2/2. Email compose, caregiver phase, client phase, task complete, caregiver note compose, client note compose — six wire-up sites across four action types. Calendar event creator was deferred because no operator-driven UI surface exists today (Outlook events are created only via AI suggestion approval, which already closes via `executeSuggestion`). Codex P2 caught + fixed in-PR: the add_note close was firing before `saveCaregiver` / `saveClient` durably persisted; fix returned the persist promise from `addNote` in both contexts and chained the close off it.

**UI strategy review (locked 2026-05-15):** Owner confirmed pattern C+D direction and locked the implementation shape during a focused conversation:
- **The AIPrioritiesPanel sidebar widget is retired.** "Lots of noise, nobody uses it." Same PR also deletes the unmounted `NotificationCenter` dead code.
- **The replacement is a new admin route `/pipeline-health`** — a daily-driver "where is my pipeline stuck, who needs me" surface. Phase-grouped table; days-in-phase as the primary stalled signal; days-since-any-activity as the secondary signal; AI suggestions surfaced as small inline badges (informational only — no action buttons; operators act through the regular UI which PR #347 already closes the loop on).
- **The digest view (`/agent-activity`) is deferred** as UI-B until Phase 2's recruiting orchestrator produces meaningful autonomous-action volume to digest. Design conversation revisits after Phase 2 ships.
- Full implementation contract: `docs/AGENT_PLATFORM_PIPELINE_HEALTH_SPEC.md`. Five §8 decisions still need owner sign-off before code lands.

**Scope of 1.5** (per `docs/AGENT_PLATFORM.md` → 1.5.1): new `ai_suggestion_grades` table (append-only — re-grading writes a new row, latest `graded_at` per suggestion is the current verdict), `upsert_ai_suggestion_grade_v1` SECURITY DEFINER RPC (admin-gated, JWT org-scoped), and an admin-only `/agent-grading` page with filtering (agent / source / action_type / time window / ungraded-only), three-button verdicts (good / bad / harmful), free-text rationale, bulk-grade across a multi-select, and `g` / `b` / `h` / `↑↓` keyboard shortcuts. Sits in the same `AI Agents` sidebar section as Agent Metrics.

**Scope of 1.6** (per `docs/AGENT_PLATFORM.md` → "Phase 1.6 — Call Intelligence"): a new `call_analyst` agent (extractor role only) that runs after every transcribed call and produces structured output (classified call type from editable taxonomy, summary, action items, red flags from editable taxonomy, memory candidates, sentiment, suggested phase change). Outputs flow into the shared kernel — `ai_suggestions` (action items as `task_create`, source=`call_analyst`) and `context_memory` (memory candidates with confidence ≥ 0.7) — so every existing and future domain agent reads the same rows at context-assembly time. Four sub-PRs: 1.6.1 taxonomy table + `context_memory.related_entity_id` additive schema + Settings UI editor; 1.6.2 agent manifest + `post-call-processor` extension + shadow bake; 1.6.3 profile surfaces (Recent Calls panel + AI Memories tab + inline AI suggestions above tasks); 1.6.4 recruiting / intake / scheduling context-recipe extension for cross-domain call retrieval.

**Why 1.6 before Phase 2** (locked 2026-05-14): the recruiting funnel orchestrator (Phase 2) makes dramatically better per-caregiver decisions with call context flowing. Building call intelligence inside Phase 2 would fragment it; deferring to Phase 7 would starve every intermediate phase of structured call signal. Phase 1.6 is shared infrastructure that every downstream agent inherits. Schema is voice-agent-compatible from day one so Phase 7's voice agent emits identical shapes — downstream consumers are agent-agnostic.

**Owner-locked 1.6 directives (2026-05-14):** suggest-only autonomy (L1) for V1 across every action type the call_analyst proposes; memory writes ship in the same PR as the per-profile Memories review UI (one-click delete + `source='human_corrected'` pin); no extraction denylist (admin-only AI surfaces today, revisit if caregivers get AI access in Phase 7); call types and red-flag categories live in editable rows (`call_taxonomy`), no hardcoded strings; structured-output schema is voice-agent-compatible from day one.

**Autonomy v2 integration (1.5)**: `recordAutonomyOutcomeV2` now fetches `ai_suggestion_grades` joined to `ai_suggestions` for the (agent_id, action_type) slice, dedupes to latest-grade-per-suggestion, and merges them into the lookback window. Verdict mapping: `good → phase=confirmed`, `bad → phase=rejected`, `harmful → phase=rejected + payload.severity='harmful'`. The pure `evaluatePromotion` evaluator is unchanged — grades enter the timeline at the data-feed layer. Grade fetch failure is non-fatal (falls back to actions-only).

**Exit criterion (locked):** owner can grade ≥ 50 suggestions in an afternoon, verdicts persist, autonomy-v2 algorithm reads them. **Additional exit criterion added 2026-05-12:** loop-closure PR 2 shipped + first organic `phase='executed'` agent_actions rows landing from regular operator flow (independent of grading UI input).

**Scope of 1.4** (per `docs/AGENT_PLATFORM.md` → 1.4): admin-only `/agent-metrics` page that surfaces token cost (input/output) + latency, suggestion volume by phase, verified-outcome rate by action type, cost per verified outcome, and a placeholder for drift events. Reads from `agent_actions` (Phase 1.1) and `action_outcomes` (Phase 0.2); no writes. Browser-side CSV export. Time window control (Day / Week / 30d). Per-agent dropdown for all three Phase 0 agents.

**Exit criterion (locked):** owner can answer "is this agent earning its keep?" in under a minute.

**Decisions for 1.5 (in PR):**
- **Route**: flat `/agent-grading` (matching Phase 1.4's `/agent-metrics` pattern), under the `AI Agents` sidebar section, admin-only via existing `<AdminOnly>` guard.
- **Append-only history, no UPDATE**: re-grading a suggestion writes a new row; the latest `graded_at` per `suggestion_id` is the current verdict. Old grades stay for audit. Mirrors `agent_versions` posture.
- **Write path lockdown**: RPC-only, mirrors `agent_actions` posture. `REVOKE INSERT, UPDATE, DELETE ... FROM authenticated`. `upsert_ai_suggestion_grade_v1` is `SECURITY DEFINER`, calls `public.is_admin()`, validates JWT `org_id` against the suggestion's org. Sanity DO-block fails the migration if the REVOKE didn't land.
- **Audit trail in events**: every grade insert also writes one `events` row (`event_type='ai_suggestion_graded'`) stamped with the suggestion's `agent_id`, so per-agent metrics can correlate grading activity with the agent under review. Grades do NOT write to `agent_actions` — that table's hash chain is locked to decisions made BY an agent; grading is an operator judgement ABOUT past decisions.
- **Autonomy merge at the data feed, not in the evaluator**: pure `evaluatePromotion` stays untouched. The stateful wrapper `recordAutonomyOutcomeV2` does the fetch + merge so any caller of the pure path can opt out of grade input.

**Decisions for 1.4 (locked 2026-05-12 with owner):**
- **Chart library**: Recharts. Declarative React composition matches the codebase style; tree-shaken bundle is ~140 KB raw / ~40 KB gzipped after compression of the AdminApp chunk. If we outgrow it for a specific chart we add a specialized library *just for that chart* rather than swapping wholesale.
- **Routing**: own sidebar section (`AI Agents → Agent Metrics`), admin-only, via the existing `<AdminOnly>` route guard. Cleaner than burying it inside the Settings accordion and gives a natural home for Phase 1.5's grading UI.
- **Time window**: segmented control (Day / Week / 30d).
- **Model pricing**: hardcoded per-model in `src/components/agentMetrics/modelPricing.js`. Move to `app_settings.model_prices` JSONB if/when finance needs to edit without a deploy.
- **CSV export**: browser-side from already-fetched dataset. The existing `agent-actions-export` edge function (Phase 1.1.C, NDJSON) stays the path for compliance dumps; the dashboard's CSV is for "what's on my screen, in a spreadsheet" use.
- **Drift events**: deferred. The consolidation pipeline that produces drift events doesn't exist yet; dashboard shows a "Not yet instrumented" placeholder card so the section is visible but explicitly empty.

**Cost capture (additive, shipped in this PR):** the token cost + latency + model that the chart depends on weren't persisted anywhere before — the chat / planner / router shells discarded `runAgent.cost` after returning their response. Phase 1.4 added a `payload._cost` field to every `recordAgentAction` call in the three shells (`ai-chat/shell.ts`, `ai-planner/shell.ts`, `message-router/shell.ts`). Shape: `{ input_tokens, output_tokens, duration_ms, model }`. No schema change required (payload is already jsonb). `AgentResult.agent` extended with a `model` field (set from manifest.model). Tests in `src/lib/__tests__/agentMetricsCostCapture.test.js` pin the contract.

---

## What 0.5 + 1.1 delivered (shipped 2026-05-09 → 2026-05-10)

### Phase 0.5 — Settings UI for agent manifest editing (closed 2026-05-09)
- PR #298 (PR A): read-only foundation + kill_switch / shadow_mode toggles + read-only version history + `toggle_agent_flag_v1` RPC
- PR #300 (PR B): full manifest editing (system_prompt, tool_allowlist, autonomy_profile, etc.) + version history with diff + revert + `update_agent_manifest_v1` + `revert_agent_to_version_v1` RPCs + `agent_table_write_lockdown` migration that revokes `INSERT/UPDATE/DELETE` on `agents` / `agent_versions` from `authenticated`
- Spec doc: `docs/AGENT_PLATFORM_PHASE_0_5_SPEC.md`. All 11 §9 decisions locked.
- Owner verified: post-deploy smoke green; admin can toggle / edit / revert; lockdown enforces RPC-only write path.

### Phase 1.1 — `agent_actions` audit log (closed 2026-05-10)
- PR #301 (1.1.A): `agent_actions` table (15 columns + hash chain + Ed25519 signature column + `chain_seq` IDENTITY for strict ordering) + `record_agent_action_v1` RPC + crypto helpers (`agentActionsCrypto.ts`) + `recordAgentAction` wrapper
- PR #302 (1.1.B): `agent-actions-verify` edge function + daily 13:30 UTC `pg_cron` + first dual-write call site (`agent-flag-toggle` wrapper edge function) + `agentActionsVerify.ts` helper + anon privilege cleanup
- PR #303 (1.1.C): dual-write extended to chat shell tool loop, chat shell confirmAction, planner shell suggestion creation, router shell classification, and `executeSuggestion` in routing.ts. Plus `agent-actions-export` edge function streaming NDJSON with full-chain verification + service-role auth gate + 50K row cap.
- **Tamper-evident audit log** of every agent action is now live in production. Daily cron walks the chain; chain breaks surface as `events.event_type='agent_actions_chain_break'`. Manual NDJSON export available for compliance dumps.
- Codex caught + fixed inline: 5 P1/P2s across the three PRs (chain-conflict race, JWT-org check, created_at hash drift, RPC over-grant, chain_seq strict ordering, export auth gate, full-chain verification semantics).

---

## What 0.4 delivered (shipped + closed 2026-05-09)

Edge function cutover: each of `ai-chat`, `ai-planner`, `message-router` now dispatches through `runAgent({ shape })` against the manifest, with `agent_id` stamped on every write to `events` / `action_outcomes` / `ai_suggestions` / `context_memory`.

**Rollout timeline:**
- 2026-05-04 ~19:00 UTC — `ai_planner` flag flipped → 5 days clean.
- 2026-05-09 ~05:20 UTC — `message_router` flag flipped → 12h clean before cleanup.
- 2026-05-09 ~16:15 UTC — `ai_chat` flag flipped → 1.5h clean before cleanup.
- 2026-05-09 ~17:50 UTC — cleanup PR #291 merged after live verification (router 85/0, planner proactive 25/0, planner event_triggered 195/0, chat events 11/0, chat action_outcomes 1/0). Owner authorized early merge after reviewing fresh stamping numbers — calendar gate at 2026-05-16 was advisory, not contractual; the actual gate was "is stamping clean across all three shells right now?" which it was.

Cleanup PR #291 removed:
- `supabase/functions/{ai-chat,ai-planner,message-router}/index_legacy.ts` × 3 (1,391 lines of rollback siblings)
- `supabase/functions/_shared/operations/cutoverFlag.ts` + its test (134 lines)
- Dead `classifyMessage()` in `_shared/operations/routing.ts` (only consumer was `index_legacy.ts`)
- `app_settings.agent_runtime_cutover` row (via migration `20260510000000_…_drop_cutover_flag.sql`)

Net diff: **−1,651 lines**. CI green, 2,915 tests passing.

---

## What 0.3 delivered (2026-05-01, retained for reference)

`_shared/operations/agentRuntime.ts` (orchestrator) + `agentRuntime/manifest.ts` (typed loader, requires `orgId` — fixed during review per Codex P1 because `agents.unique = (org_id, slug)`) + `agentRuntime/anthropic.ts` (retry helper) + `agentRuntime/handlers.ts` (chat / planner / router internal handlers). Three test files: `agentRuntime.test.js` (Layer A unit, 62 specs), `agentRuntimeParity.test.js` (Layer B byte-equal parity, 22 specs across 11 fixtures), `agentRuntimeLive.test.js` (Layer C live Anthropic smoke, 3 specs, gated on `ANTHROPIC_API_KEY` and now configured in repo secrets). 87 runtime specs total.

**Parity strategy revision (2026-05-01)**: The original "30-day replay against legacy code" framing in `docs/AGENT_PLATFORM.md` Phase 0.3 was replaced with a three-layer strategy after auditing what's actually persisted in production. `ai-chat` doesn't persist chat sessions, planner/router inputs have moved on since they were captured. With Anthropic mocked and identical inputs, byte-equal parity (Layer B) replaces the 2%-drift hedge from the original plan; Layer C catches mock-vs-reality drift via a small live API spend (~$0.10/PR). Full rationale in `docs/AGENT_PLATFORM.md` → Phase 0.3 → "Parity strategy".

**Parallel context**:
- SaaS retrofit Phase B is in progress (B2b baked, B3 next). Phase 0.x is intentionally safe to run in parallel.
- Owner is implementing the Microsoft 365 Bookings webhook integration (per `docs/AGENT_PLATFORM_PROCESS.md` → "Microsoft 365 Bookings integration spec"); needed by Phase 2.2.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| 0.1 | `agents` + `agent_versions` tables, seed 3 agents, RLS | **Shipped** | 2026-04-30 (PR #240) | 3 agents seeded for Tremendous Care, 8 RLS policies, 36 Vitest specs. |
| 0.2 | `agent_id` columns + deterministic backfill on 4 AI-tier tables | **Shipped** | 2026-04-30 (PR #244) | 3,847 ai_suggestions + 11 action_outcomes stamped. 29 Vitest specs. |
| 0.3 | `agentRuntime.ts` + parity harness | **Shipped** | 2026-05-01 (PR #247) | `runAgent` + manifest loader + retry helper + chat/planner/router handlers. Three-layer parity harness: 62 Layer A unit specs + 22 Layer B byte-equal fixture specs + 3 Layer C live Anthropic specs (gated on `ANTHROPIC_API_KEY`, configured in repo secrets). Pure additive — legacy edge functions untouched. Codex P1 caught + fixed: `loadManifest` requires `orgId` (agents.unique = (org_id, slug)). |
| 0.4 | Edge function cutover (recruiting/planner/router → `runAgent`) | **Shipped + closed** | 2026-05-04 (PR #254) + 2026-05-09 (cleanup PR #291) | All three shells flipped clean. Cleanup removed `*_legacy.ts` siblings, `cutoverFlag.ts` helper, dead `classifyMessage()`, and the `agent_runtime_cutover` row. Owner-authorized early cleanup merge after live verification showed zero unstamped across all three shells post-flip. |
| 0.5 | Settings UI for manifest editing | **Shipped + closed** | 2026-05-09 (PR #298 + #300) | Spec doc + 11 locked decisions in `docs/AGENT_PLATFORM_PHASE_0_5_SPEC.md`. PR A: read-only + toggles + version history. PR B: full edit + revert + lockdown migration. Compressed bake — manual smoke + DB-level verification stood in for the calendar bake per CEO directive. |
| 1.1 | `agent_actions` billing-grade audit log | **Shipped + closed** | 2026-05-10 (PRs #301 + #302 + #303) | Three-PR slicing: 1.1.A foundation (table + RPC + crypto), 1.1.B verifier + cron + first dual-write, 1.1.C dual-write everywhere + NDJSON export. Hash-chained SHA-256 + Ed25519 signing, `chain_seq` IDENTITY for strict ordering, daily 13:30 UTC verifier cron writes `events.event_type='agent_actions_chain_break'` on tampering. Service-role-gated NDJSON export at `/functions/v1/agent-actions-export`. Tamper-evident audit log of every agent action is live. |
| 1.2 | Tightened autonomy promotion algorithm v2 | **Shipped + closed** | 2026-05-10 (PR #305) | Per-transition thresholds + sliding window + min sample size + auto-demote on harm. `evaluatePromotion(agentId, actionType, recentOutcomes)` replaces legacy consecutive-counter; `update_autonomy_profile_entry_v1` RPC for atomic profile writes; `autonomy_profile` v2 backfilled on all 3 seed agents. Codex caught two P2s in-PR (repeated demote on stale harmful row; concurrent profile write race) — both fixed. |
| 1.3 | Per-(agent × org) kill switch + shadow mode hardening + read-only mode | **Shipped + closed** | 2026-05-10 (PR #306) | New `agents.read_only_mode` boolean — suppresses every tool call (auto + confirm tier) while keeping the agent loop alive. `toggle_agent_flag_v1` RPC extended to accept the new flag. Per-iteration recheck inside the chat handler so an admin clear takes effect mid-flight without restart. Codex caught two P2s in-PR (read_only didn't suppress assembler reads; flag-off couldn't restore raw executor) — both fixed. |
| 1.4 | Per-agent metrics dashboard | **Shipped + closed** | 2026-05-11 (PR #312) | Admin-only `/agent-metrics` page; Recharts; 4 charts + 1 drift placeholder; CSV export; cost/latency capture into `agent_actions.payload._cost` at all 3 shells. "Is this agent earning its keep?" surface. Two Codex P1s fixed in 4c211dd (action_outcomes join + column-name). |
| 1.5 | Retrospective grading UI | **Shipped + closed** | 2026-05-12 (PR #315 + hotfix #316) | `ai_suggestion_grades` table (append-only) + `upsert_ai_suggestion_grade_v1` SECURITY DEFINER RPC + admin-only `/agent-grading` page with filters, bulk grade, keyboard shortcuts. Autonomy v2 merges grades into lookback window via `mergeGradesIntoActions`. Codex P2 paginated-ungraded-fetch fix in PR. Hotfix #316 added missing `useMemo` import dropped during the Codex P2 rewrite. |
| **1.5 follow-up** | **Agent loop closure (passive linker)** | **Shipped + closed** | 2026-05-15 (PR #317 + PR #347) | Discovery: AI Priorities dashboard buttons today only navigate — no `agent_actions` rows ever land, autonomy v2 starves of positive signal. PR #317 shipped the SMS path (`closePendingSuggestion` shared helper, `close-pending-suggestion` edge function, frontend wrapper, SMSComposeBar wire-up). PR #347 shipped the remaining six wire-ups (email compose, caregiver phase, client phase, task complete, caregiver/client note composers) + Codex P2 fix (chain add_note close off persist promise so save failures don't write false-positive audit rows). Calendar event creator deferred — no operator-driven UI surface exists. UI strategy review locked same day (2026-05-15) → see "Pipeline Health UI" row below. |
| **Pipeline Health UI** | **Pattern C+D — daily-driver pipeline view, retires AI Priorities feed** | **Spec drafted, owner sign-off pending** | — | New admin route `/pipeline-health` with phase-grouped table, days-in-phase stalled signal, AI suggestions as informational inline badges only. Retires `AIPrioritiesPanel` widget + unmounted `NotificationCenter` dead code. No new schema, no new edge function — pure UI. Digest view `/agent-activity` deferred as UI-B until Phase 2 produces volume worth digesting. Spec: `docs/AGENT_PLATFORM_PIPELINE_HEALTH_SPEC.md`. Five §8 decisions pending. |
| **1.6** | **Call Intelligence (shared extractor agent)** | **Planned** | — | New `call_analyst` agent (extractor only) running after every transcribed call. 4 sub-PRs: 1.6.1 `call_taxonomy` + additive `context_memory.related_entity_id` + Settings UI; 1.6.2 manifest + `post-call-processor` extension + ≥14d shadow bake; 1.6.3 Recent Calls panel + AI Memories tab + inline AI suggestions above tasks; 1.6.4 recruiting/intake/scheduling context-recipe extension. Gates on 1.5 follow-up PR 2 baked + organic `phase='executed'` rows. Soft-preferred before Phase 2 but not strict-blocking. |
| **2** | **Recruiting Agent: Autonomous Funnel Orchestration** | Not started | — | Wedge. Gates updated 2026-05-12: now also requires loop-closure PR 2 baked + first organic `phase='executed'` rows in production audit log. Phase 1.6 (Call Intelligence) is soft-preferred to land first so the orchestrator launches with call context flowing. 6 sub-phases: 2.1 funnel state machine, 2.2 Stage 1 + bookings webhook, 2.3 Stage 2-3 with bookings live, 2.4 Stage 4-5, 2.5 Stage 6, 2.6 Stage 7 + handoff. |
| 3 | Intake (client lead management) agent | Not started | — | Second new agent. Same 5-PR pattern as before. |
| 4 | Scheduling agent | Not started | — | Third new agent. ≥ 21-day shadow bake. |
| 5 | Inter-agent dispatch (`agent_requests` queue) | Not started | — | First hand-offs: recruiting → scheduling, intake → scheduling. |
| 6 | Care coordination agent | Not started | — | Fourth new agent. Heavy memory + cross-agent. |
| 7 | Marketplace, billing, voice, mobile | Not started | — | Sellable. SaaS Phase E + Phase 6 gate. |

Bake at least 7–14 days on `main` between phases. Phases are sequential.

---

## Decisions locked

Authoritative list lives in `docs/AGENT_PLATFORM_VISION.md` ("Strategic decisions locked") and `docs/AGENT_PLATFORM.md` ("Decisions locked"). Summary of what's now firm after 2026-04-30 process discovery:

- **Refactor, don't rebuild.** ~75–80% of the agent platform kernel already exists; promote it to first-class data instead of starting over.
- **Recruiting graduation is the wedge** (revised 2026-04-30, supersedes earlier "intake is the wedge"). The recruiting agent transforms from copilot into autonomous funnel orchestrator. Intake is the second new agent, scheduling third.
- **Onboarding-complete task = recruiting win signal.** Orientation conductor checks the task; agent observes the third-party signal.
- **Process is data, not code.** Funnel stages, transitions, timeouts, branching rules, message templates, human gates, time targets all live in editable rows.
- **Time targets** for recruiting graduation: 5d gold / 7d good / 14d acceptable. Editable per-agent.
- **Human-required gates** (locked): virtual interview (Stage 4), document accuracy review (Stage 6), orientation (Stage 7).
- **Hard auto-disqualification**: only `legal_to_work_us = no`. Everything else is flag-for-judgment until calibration data justifies promotion.
- **Microsoft 365 Bookings integration**: required by Phase 2.2. Spec in `docs/AGENT_PLATFORM_PROCESS.md`. Owner is implementing in parallel with infra.
- **Retrospective grading UI** ships as Phase 1.5 before Phase 2.
- **Coarse-first agent granularity.** One agent per business domain at launch; split when data signals it.
- **Memory is per-agent by default; org-shared via tagged promotion.** Cross-org learning stays off.
- **Outcomes are third-party-verified by default.** Per-agent escape clauses are explicit fields.
- **Pricing direction (soft):** per-completed-outcome (caregivers onboarded, shifts filled, clients started). Specific tiers open.
- **Trust is earned in stages by data.** Promotion v2: per-transition thresholds + fixed-window success rate + minimum sample size + auto-demote on harm.
- **Kill switch + shadow mode per (agent × org), without a deploy.**
- **Phase 0–1 run in parallel with SaaS Phase B–D.** Phase 2 gates on SaaS Phase B5 baked on AI-tier tables. Multi-tenant rollout gates on SaaS Phases C–D.
- **Inter-phase bakes are evidence-driven, not calendar-driven** (locked 2026-05-01). When a phase has zero production callers (e.g. Phase 0.3 — pure additive scaffolding) a calendar-only bake has nothing to verify and is skipped. Bakes still apply where they buy real insurance: after a phase that changes production behavior, before removing rollback siblings, and before any phase that exposes new behavior to caregivers (Phase 2 sub-phases each retain ≥ 14-day shadow bakes per the original plan). Layer C nightly smoke against real Anthropic on every PR is the continuous tripwire that replaces calendar-based confidence.
- **Agent loop closure via passive linker is the operator-feedback path** (locked 2026-05-12). The autonomy v2 algorithm reads `agent_actions` for promotion/demotion signal. Operator UI surfaces (SMS compose, email compose, schedule create, phase change, task complete, note add) must call `closePendingSuggestionForAction({ entityType, entityId, actionType, params })` immediately after a successful write. The helper looks up the freshest non-expired pending `ai_suggestions` row matching (entity, action_type), CAS-transitions it to `executed`, and writes a `phase='executed'` audit row through the existing `recordAgentAction` chain. **The dashboard suggestion buttons themselves are NOT modified** — they remain navigation-only. Loop closure is passive, runs from the regular operator flow, and never blocks the primary action (failure is fire-and-forget). The closeable action_type allowlist mirrors the planner's emitted vocabulary: `send_sms`, `send_email`, `add_note`, `complete_task`, `update_phase`, `create_calendar_event`, `send_docusign_envelope`.
- **Long-term UI direction is pattern C+D, not the current "AI Priorities feed"** (locked direction 2026-05-12, implementation deferred). The current pattern (notification-style feed of suggestions with navigation buttons) is the classic CRM augmentation pattern (Salesforce Einstein, HubSpot AI) and it's hitting the known failure modes — notification fatigue, no feedback loop, "tab tax". Long-term destination is closer to pattern **C** (outcome-based dashboard: list caregivers by stage stalled, click in to see what the agent has tried) + pattern **D** (background-autonomous agent with daily digest of what it did, operator reviews / reverts). The current panel is not removed; it evolves into a sub-view of the outcomes dashboard. Decision driver: Phase 2 (recruiting funnel orchestrator) needs a UI to orchestrate against, and pattern C+D fits the autonomous-funnel model better than the current feed. The discussion + design lock happens after loop-closure PR 2 bakes 2-3 days with real audit-log data.

---

## Decisions still open

- **Where the per-agent system prompt template lives at edit time** — column-of-truth chosen for Phase 0.5; Settings UI is the editing surface. Markdown mirrors deferred until/unless a customer needs PR-review on prompt changes.
- **`agent_requests` storage backend** — Postgres through Phase 6; revisit at Phase 7.
- **Per-task pricing tiers, base subscription, free tier rules.** Direction locked, numbers open. Revisit before Phase 7.
- **Voice agent: build vs partner.**
- **Mobile-native caregiver app.** Affects scheduling outcome verification quality.
- **Per-agent metering granularity exposure** (cost per outcome shown to customers vs internal-only).
- **Cross-org learning opt-in design.** Off by default; revisit if a customer asks.
- **SaaS product brand name.** Carried over from `docs/SAAS_RETROFIT_STATUS.md`.
- **Open process questions** (do not block infra phases; gate Phase 2.1 design): pre-screening NULL pile cleanup, phase rename/disambiguation, Pending HCA sub-path data model, orientation cadence (as-needed → weekly?), re-engagement policy, action-item-rules seeding. Tracked in `docs/AGENT_PLATFORM_PROCESS.md` → "Open process questions".

---

## Shipped PRs

| Date | PR | Phase | Summary |
|------|----|----|---------|
| 2026-04-30 | #239 | — | Vision doc refined, full plan and tracker docs spawned. No code. |
| 2026-04-30 | #240 | 0.1 | `agents` + `agent_versions` tables, RLS, seed 3 agents (recruiting / proactive_planner / inbound_router). 36 Vitest specs. |
| 2026-04-30 | #244 | 0.2 | `agent_id` columns + deterministic backfill on `events`/`action_outcomes`/`ai_suggestions`/`context_memory`. 29 Vitest specs. |
| 2026-05-01 | #247 | 0.3 | `agentRuntime.ts` orchestrator + manifest loader + retry helper + chat/planner/router handlers. Three-layer parity harness (Layer A unit / Layer B byte-equal fixtures / Layer C live Anthropic smoke). 87 new specs across the runtime test files (total suite now 2,454 incl. Layer C). Codex P1 fixed in-PR: `loadManifest` requires `orgId` because `agents.unique = (org_id, slug)`. Pure additive — no edge function or production behavior change. |
| 2026-05-04 | #254 | 0.4 | Edge function cutover with feature-flag rollback. Each of `ai-chat` / `ai-planner` / `message-router` split into `index.ts` (Deno.serve dispatcher, reads `app_settings.agent_runtime_cutover`) + `shell.ts` (testable runtime path, calls `runAgent`) + `index_legacy.ts` (verbatim pre-0.4 code, kept as rollback sibling). Optional `agentId` parameter threaded through `logEvent` / `logAction` / `createSuggestion`; `executeSuggestion` reads `agent_id` from the suggestion row. 60 new specs across 5 files; full suite 2,543 passing. Default-off flag means merge is a no-op until SQL flip — flippable per-shell without redeploy. |
| 2026-05-09 | #291 | 0.4 cleanup | Removed the cutover flag and `*_legacy.ts` rollback siblings after planner flipped 5/4 + router and chat flipped 5/9 with zero unstamped post-flip across all three shells. Each `index.ts` is now a thin Deno wrapper around its `shell.ts`. Migration `20260510000000_…_drop_cutover_flag.sql` deletes the vestigial `app_settings.agent_runtime_cutover` row. Net diff −1,651 lines; 2,915 tests passing. Owner authorized early merge after live verification (planner proactive 25/0, planner event_triggered 195/0, router post-flip 85/0, chat events 11/0, chat action_outcomes 1/0). |
| 2026-05-09 | #292 | docs (0.5 spec) | Phase 0.5 spec doc + STATUS.md update to reflect 0.4 closed. Markdown only. |
| 2026-05-09 | #295 | docs (0.5 lock) | Locked all 11 §9 decisions on the spec doc. Codex P2 caught a stale "decisions needed" callout drift; fixed in the same PR. |
| 2026-05-09 | #298 | 0.5 PR A | Settings UI read-only foundation + kill_switch / shadow_mode toggles + read-only version history + `toggle_agent_flag_v1` RPC. New `src/components/agentManifest/` directory. 60 new specs. Codex P2 caught a row-lock-on-toggle race (duplicate audit rows on concurrent toggles); fixed via `FOR UPDATE` on the agent SELECT. |
| 2026-05-09 | #300 | 0.5 PR B | Full manifest editing (system_prompt, tool_allowlist, autonomy_profile, etc.) + version history with diff viewer + revert. `update_agent_manifest_v1` + `revert_agent_to_version_v1` RPCs. `agent_table_write_lockdown` migration revokes `INSERT/UPDATE/DELETE` on `agents` / `agent_versions` from `authenticated`. 119 new specs (3,101 passing). Codex P2 caught stale version-history after save; fixed via `currentVersion` refresh signal on the hook. |
| 2026-05-10 | #301 | 1.1.A | `agent_actions` table + `record_agent_action_v1` RPC + crypto helpers (canonical JSON, SHA-256 chain hash, Ed25519 sign/verify via Web Crypto). 77 new specs. Codex P1 caught two: (1) `created_at` drift between signed timestamp and stored DEFAULT now() — fixed by adding `p_created_at` parameter + ±5min anti-backdate bound. (2) `record_agent_action_v1` over-granted to `authenticated` — fixed by REVOKE + grant only to `service_role`. Pure infrastructure (no callers yet). |
| 2026-05-10 | #302 | 1.1.B | `agent-actions-verify` edge function + daily 13:30 UTC `pg_cron` + first dual-write call site (new `agent-flag-toggle` wrapper edge function). Anon privilege cleanup migration. `chain_seq` IDENTITY column added (Codex P1 fix for false `broken_chain_link` reports on same-millisecond rows). Frontend toggle path now routes through edge function for atomic toggle + audit dual-write. First production audit row: chain_seq=1 at 02:02 UTC on 2026-05-10. |
| 2026-05-10 | #303 | 1.1.C | Dual-write extended to chat shell tool loop, confirmAction, planner shell, router shell, and `executeSuggestion`. NDJSON export endpoint at `/functions/v1/agent-actions-export` with full-chain verification + service-role auth gate. Codex P1 + P2 caught: missing auth gate on export, false integrity reports on filtered exports — both fixed inline. 3,244 specs passing. **Phase 1.1 closed.** |
| 2026-05-10 | #305 | 1.2 | Autonomy promotion v2: `evaluatePromotion()` reading `autonomy_profile` jsonb (per-transition thresholds + sliding window + min sample size + auto-demote on harm). `update_autonomy_profile_entry_v1` SECURITY DEFINER RPC for atomic profile writes. v2 schema backfilled on all 3 seed agents. Codex caught two P2s in-PR (repeated demote on stale harmful row; concurrent profile write race) — both fixed. |
| 2026-05-10 | #306 | 1.3 | `agents.read_only_mode` boolean — suppresses every tool call while keeping the agent loop alive. `toggle_agent_flag_v1` extended to accept the new flag. Per-iteration recheck inside chat handler. Codex caught two P2s in-PR (read_only didn't suppress assembler reads; flag-off couldn't restore raw executor) — both fixed. |
| 2026-05-11 | #309 | docs | Phase 1.4 handoff doc for the next session. Markdown only. Deleted in this PR. |
| 2026-05-11 | #312 | 1.4 | Per-agent metrics dashboard: admin-only `/agent-metrics` route, Recharts visuals (token spend / latency / suggestion volume / verified-outcome rate / drift placeholder), CSV export, segmented Day/Week/30d window, cost capture into `agent_actions.payload._cost` at all 3 shells. Two Codex P1s fixed inline (4c211dd) — `action_outcomes` join shape + column-name typo. **Phase 1.4 closed.** |
| 2026-05-12 | #315 | 1.5 | Retrospective grading UI: `ai_suggestion_grades` table (append-only, RLS-strict, write lockdown), `upsert_ai_suggestion_grade_v1` SECURITY DEFINER RPC, admin-only `/agent-grading` page (filters, three-button verdicts, bulk grade, `g`/`b`/`h`/`↑↓` shortcuts), autonomy v2 merger via `mergeGradesIntoActions`. 37 new specs. Codex P2 paginated-ungraded-fetch fix shipped in same PR (3e4ef5c) — `loadSuggestions` gained `beforeIso` cursor, `fetchSuggestionsAndGrades` walks pages backward up to `MAX_UNGRADED_PAGES=5`. |
| 2026-05-12 | #316 | 1.5 hotfix | One-line `useMemo` import restoration in `useAgentGrading.js` — accidentally dropped during the Codex P2 rewrite (3e4ef5c). `/agent-grading` page crashed with "Something went wrong in Content" on first render due to unbound `useMemo` reference. ESLint `no-undef` not wired into CI, caught only by visual smoke. **Follow-up identified:** wire ESLint into CI + add renderHook smoke for `useAgentGrading`. **Phase 1.5 closed.** |
| 2026-05-12 | #317 | 1.5 follow-up | Agent loop closure PR 1/2 — SMS compose closes matching pending suggestions. New `closePendingSuggestion` shared helper (`_shared/operations/closeSuggestion.ts`), new `close-pending-suggestion` edge function (JWT auth + service-role internal), new `agentLoopClosure.js` frontend caller (never throws), one wire-up site in `SMSComposeBar.handleSend`. CAS-style status transition, payload sanitization, audit-failure fallback. 14 new specs; 3,528 total passing. |
| 2026-05-15 | #347 | 1.5 follow-up | Agent loop closure PR 2/2 — six wire-up sites across four action types: `send_email` (EmailComposeForm, shared caregiver/client), `update_phase` (ProgressOverview + ClientProgressOverview), `complete_task` (PhaseDetail caregiver checkbox, done-transitions only), `add_note` (ActivityLog + ClientActivityLog standalone composers only — SMS/email-derived notes covered by their own action_type to avoid double-counting). Calendar event creator deferred. Codex P2 caught + fixed in-PR: chain add_note close off the persist promise so save failures don't write false-positive audit rows. 31 new wire-up smoke specs; 4,020 total passing. **Phase 1.5 follow-up closed.** |

(Add a row when each subsequent PR ships.)

---

## Phase 0.4 rollout runbook (historical, 2026-05-04 → 2026-05-09)

> **This section is preserved for reference — the cutover and cleanup are both complete as of PR #291 (2026-05-09). Do not flip `agent_runtime_cutover`; the row no longer exists and the flag-reading code is gone. Edge functions now route directly through `runAgent` from their thin `index.ts` wrappers.**


The feature flag for Phase 0.4 lives in `public.app_settings.value` (jsonb) under key `agent_runtime_cutover`. Three independent boolean fields (`ai_chat`, `ai_planner`, `message_router`) gate which path each edge function runs. Default-off — owner flips per-shell with a one-line SQL `UPDATE`, no redeploy.

**Flip cadence (designed)**: planner first (lowest blast radius — daily cron) → router second (every-5-min cron, ~150 inbound SMS/day) → chat last (Kevin's daily driver, biggest UX surface). ≥48h bake between flips; ≥7 days clean from the last flip before opening the cleanup PR.

**Verification SQL after each flip:**
```sql
-- Planner (after next 14:00 UTC tick)
SELECT COUNT(*) FILTER (WHERE agent_id IS NOT NULL) AS stamped,
       COUNT(*) FILTER (WHERE agent_id IS NULL) AS unstamped
  FROM ai_suggestions
 WHERE source_type = 'proactive' AND created_at >= CURRENT_DATE;

-- Router (within ~15 min of inbound traffic)
SELECT COUNT(*) FILTER (WHERE agent_id IS NOT NULL), COUNT(*) FILTER (WHERE agent_id IS NULL)
  FROM ai_suggestions
 WHERE source_type IN ('inbound_sms','inbound_email')
   AND created_at >= '<flip_timestamp>';

-- Chat (after a deliberate session: briefing + read + write + multi-turn)
SELECT 'events' AS tbl,
       COUNT(*) FILTER (WHERE agent_id IS NOT NULL) AS stamped,
       COUNT(*) FILTER (WHERE agent_id IS NULL) AS unstamped
  FROM events
 WHERE created_at >= now() - interval '1 hour'
   AND event_type IN ('ai_chat_request','sms_sent','email_sent','note_added',
                       'phase_changed','task_completed','docusign_sent','calendar_event_created')
UNION ALL
SELECT 'action_outcomes',
       COUNT(*) FILTER (WHERE agent_id IS NOT NULL),
       COUNT(*) FILTER (WHERE agent_id IS NULL)
  FROM action_outcomes
 WHERE created_at >= now() - interval '1 hour';
```

**Rollback (per shell, no redeploy):**
```sql
UPDATE app_settings
   SET value = jsonb_set(value, '{<shell_name>}', 'false'::jsonb)
 WHERE key = 'agent_runtime_cutover';
```
Effective on the next request (cron tick or chat invocation).

**Cleanup PR** (PR #291, merged 2026-05-09) removed `index_legacy.ts` × 3, inlined each `shell.ts` into `index.ts`, deleted the `agent_runtime_cutover` row + `cutoverFlag.ts` helper. Phase 0.4 is **closed**. Phase 0.5 (Settings UI for manifest editing) is unblocked after a ≥7-day cleanup bake (earliest 2026-05-17).

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one. Note bake start.
- **Decision locked**: move from "still open" to the locked list in `docs/AGENT_PLATFORM_VISION.md` (strategic) or `docs/AGENT_PLATFORM.md` (operational), summarize here.
- **Process change**: update `docs/AGENT_PLATFORM_PROCESS.md` in the same PR that ships the change.

The platform is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
