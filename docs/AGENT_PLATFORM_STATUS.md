# Agent Platform — Status Tracker

**Full plan**: `docs/AGENT_PLATFORM.md`
**Vision and prime directives**: `docs/AGENT_PLATFORM_VISION.md`
**Process source-of-truth**: `docs/AGENT_PLATFORM_PROCESS.md`
**Upstream dependency**: `docs/SAAS_RETROFIT_STATUS.md` (Phase B5 gates Phase 2 start)

This file is the living tracker. Update it in the same PR that advances the platform. Keep it short and scannable — a new contributor should be able to see in ten seconds where the agent platform stands today.

---

## Current phase

**Phase 0.4 — Edge function cutover (recruiting / planner / router → `runAgent`)** *(ready to start)*

**Status**: Phase 0.3 shipped 2026-05-01 via PR #247. **No mandatory pre-bake before 0.4.** Decision (2026-05-01, owner): inter-phase bakes are evidence-driven, not calendar-driven. Phase 0.3 has zero production callers (the runtime sits in `_shared/operations/` and no edge function imports it yet), so a calendar-only bake before 0.4 has nothing to verify. Bakes still apply where they buy real insurance — specifically, **after** 0.4 ships before removing the `*_legacy.ts` rollback siblings, and **before** any phase that exposes new behavior to caregivers (Phase 2 sub-phases each bake ≥ 14 days as designed).

**What 0.3 delivered (2026-05-01)**: `_shared/operations/agentRuntime.ts` (orchestrator) + `agentRuntime/manifest.ts` (typed loader, requires `orgId` — fixed during review per Codex P1 because `agents.unique = (org_id, slug)`) + `agentRuntime/anthropic.ts` (retry helper) + `agentRuntime/handlers.ts` (chat / planner / router internal handlers). Three test files: `agentRuntime.test.js` (Layer A unit, 62 specs), `agentRuntimeParity.test.js` (Layer B byte-equal parity, 22 specs across 11 fixtures), `agentRuntimeLive.test.js` (Layer C live Anthropic smoke, 3 specs, gated on `ANTHROPIC_API_KEY` and now configured in repo secrets). 87 runtime specs total.

**Parity strategy revision (2026-05-01)**: The original "30-day replay against legacy code" framing in `docs/AGENT_PLATFORM.md` Phase 0.3 was replaced with a three-layer strategy after auditing what's actually persisted in production. `ai-chat` doesn't persist chat sessions, planner/router inputs have moved on since they were captured. With Anthropic mocked and identical inputs, byte-equal parity (Layer B) replaces the 2%-drift hedge from the original plan; Layer C catches mock-vs-reality drift via a small live API spend (~$0.10/PR). Full rationale in `docs/AGENT_PLATFORM.md` → Phase 0.3 → "Parity strategy".

**Parallel context**:
- SaaS retrofit Phase B is in progress (B2b baked, B3 next). Phase 0.x is intentionally safe to run in parallel.
- Owner is implementing the Microsoft 365 Bookings webhook integration (per `docs/AGENT_PLATFORM_PROCESS.md` → "Microsoft 365 Bookings integration spec"); needed by Phase 2.2.

**Pre-merge readiness checklist for Phase 0.4** (replaces the prior calendar-bake gate):
1. Edge functions deploy cleanly in Deno (Layer A/B run in Node — Layer C is the only check that exercises the real edge runtime).
2. Manual smoke test post-deploy: chatbot UI responds (recruiting agent), inbound SMS gets classified (router), planner cron drops a suggestion at next 14:00 UTC tick.
3. `agent_id` populates on every new row in `events` / `action_outcomes` / `ai_suggestions` / `context_memory` (the 20 unstamped post-0.2 rows we saw in audit should stop accumulating).
4. Token cost within ±10% of pre-cutover baseline.
5. `*_legacy.ts` rollback siblings ship in the PR with a feature flag (env var or `app_settings`) controlling which path runs — flip-without-redeploy required.

**Gate to Phase 1**: Phase 0.5 shipped and baked ≥ 7 days.
**Gate to Phase 2 (Recruiting graduation)**: SaaS Phase B5 baked on every AI-tier table + Phase 1.5 baked ≥ 7 days with ≥ 100 graded suggestions in the calibration set.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| 0.1 | `agents` + `agent_versions` tables, seed 3 agents, RLS | **Shipped** | 2026-04-30 (PR #240) | 3 agents seeded for Tremendous Care, 8 RLS policies, 36 Vitest specs. |
| 0.2 | `agent_id` columns + deterministic backfill on 4 AI-tier tables | **Shipped** | 2026-04-30 (PR #244) | 3,847 ai_suggestions + 11 action_outcomes stamped. 29 Vitest specs. |
| 0.3 | `agentRuntime.ts` + parity harness | **Shipped** | 2026-05-01 (PR #247) | `runAgent` + manifest loader + retry helper + chat/planner/router handlers. Three-layer parity harness: 62 Layer A unit specs + 22 Layer B byte-equal fixture specs + 3 Layer C live Anthropic specs (gated on `ANTHROPIC_API_KEY`, configured in repo secrets). Pure additive — legacy edge functions untouched. Codex P1 caught + fixed: `loadManifest` requires `orgId` (agents.unique = (org_id, slug)). |
| 0.4 | Edge function cutover (recruiting/planner/router → `runAgent`) | **Ready to start** | — | No pre-bake required (0.3 had zero production callers — bakes are evidence-driven not calendar-driven). Pre-merge readiness checklist above. Post-merge: bake ≥ 7 days before removing `*_legacy.ts` siblings; nightly drift check via Layer C on PRs. |
| 0.5 | Settings UI for manifest editing | Not started | — | Kill switch + shadow mode + prompt + allowlist edits, no deploy. |
| 1.1 | `agent_actions` billing-grade audit log | Not started | — | Hash-chained Ed25519-signed records, daily verifier cron. |
| 1.2 | Tightened autonomy promotion algorithm v2 | Not started | — | Per-transition thresholds + sliding window + min sample size + auto-demote on harm. |
| 1.3 | Per-(agent × org) kill switch + shadow mode hardening | Not started | — | Defense in depth; toggles audited. |
| 1.4 | Per-agent metrics dashboard | Not started | — | "Is this agent earning its keep?" surface. |
| **1.5** | **Retrospective grading UI** | Not started | — | New phase (added 2026-04-30). Calibrates accumulated `ai_suggestions` for Phase 2. |
| **2** | **Recruiting Agent: Autonomous Funnel Orchestration** | Not started | — | Wedge. 6 sub-phases: 2.1 funnel state machine, 2.2 Stage 1 + bookings webhook, 2.3 Stage 2-3 with bookings live, 2.4 Stage 4-5, 2.5 Stage 6, 2.6 Stage 7 + handoff. |
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

(Add a row when each subsequent PR ships.)

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one. Note bake start.
- **Decision locked**: move from "still open" to the locked list in `docs/AGENT_PLATFORM_VISION.md` (strategic) or `docs/AGENT_PLATFORM.md` (operational), summarize here.
- **Process change**: update `docs/AGENT_PLATFORM_PROCESS.md` in the same PR that ships the change.

The platform is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
