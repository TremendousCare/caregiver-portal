# Agent Platform — Status Tracker

**Full plan**: `docs/AGENT_PLATFORM.md`
**Vision and prime directives**: `docs/AGENT_PLATFORM_VISION.md`
**Upstream dependency**: `docs/SAAS_RETROFIT_STATUS.md` (Phase B5 gates new live agents)

This file is the living tracker. Update it in the same PR that advances the platform. Keep it short and scannable — a new contributor should be able to see in ten seconds where the agent platform stands today.

---

## Current phase

**Phase 0 — Foundation refactor** *(planned, not yet started)*

**Status**: Planning. No PRs shipped. Vision and plan docs locked 2026-04-30.

**What it produces**: `agents` table, `agent_id` stamp on existing AI rows, `agentRuntime.ts` shared helper, behavioral parity test harness, edge-function cutover for the three existing agents (`recruiting`, `proactive_planner`, `inbound_router`), Settings UI for manifest editing.

**What it does NOT produce**: any new live agent. Phase 0 is pure additive scaffolding.

**Parallel context**: SaaS retrofit Phase B is in progress (B2b baked, B3 next). Phase 0 is intentionally safe to run in parallel — it's additive scaffolding that produces no behavior change.

**Gate to Phase 1**: Phase 0.5 shipped and baked ≥ 7 days.
**Gate to Phase 2**: SaaS Phase B5 baked on every AI-tier table + Phase 1 baked ≥ 14 days.

---

## Phases

| Phase | Name | Status | Shipped | Notes |
|-------|------|--------|---------|-------|
| 0 | Foundation refactor | Planned | — | `agents` table, runtime extraction, parity harness, edge function cutover. Five PRs. Parallel-safe with SaaS B–D. |
| 1 | Trust & safety primitives | Not started | — | `agent_actions` audit log + Ed25519 chain, autonomy v2, kill switch / shadow mode hardening, metrics dashboard. Four PRs. |
| 2 | Intake agent | Not started | — | First new live agent. Wedge. Gated on SaaS B5 + Phase 1 bake. |
| 3 | Scheduling agent | Not started | — | Second live agent. Largest blast radius. ≥ 21-day shadow mode. |
| 4 | Inter-agent dispatch | Not started | — | `agent_requests` queue. First hand-off: Intake → Scheduling. |
| 5 | Care coordination agent | Not started | — | Third live agent. Heavy memory + cross-agent. |
| 6 | Marketplace, billing, voice, mobile | Not started | — | Sellable. SaaS Phase E + Phase 5 gate. |

Bake at least 7–14 days on `main` between phases. Phases are sequential.

---

## Decisions locked

Authoritative list lives in `docs/AGENT_PLATFORM_VISION.md` ("Strategic decisions locked") and `docs/AGENT_PLATFORM.md` ("Decisions locked"). Summary:

- **Refactor, don't rebuild.** ~75–80% of the agent platform kernel already exists; promote it to first-class data instead of starting over.
- **Intake is the wedge.** First new production agent. Scheduling is second. (Vision doc revised 2026-04-30.)
- **Coarse-first agent granularity.** One agent per business domain at launch; split when data signals it.
- **Memory is per-agent by default; org-shared via tagged promotion.** Cross-org learning stays off.
- **Outcomes are third-party-verified by default.** Per-agent escape clauses are explicit fields.
- **Pricing direction (soft):** per-completed-outcome (shifts filled, caregivers onboarded, clients started). Specific tiers open.
- **Trust is earned in stages by data.** Promotion v2: per-transition thresholds + fixed-window success rate + minimum sample size + auto-demote on harm.
- **Kill switch + shadow mode per (agent × org), without a deploy.**
- **Phase 0–1 run in parallel with SaaS Phase B–D.** Phase 2 gates on SaaS Phase B5 baked on AI-tier tables. Multi-tenant rollout gates on SaaS Phases C–D.
- **Recruiting agent migrates onto the platform**; behavior parity verified by replay harness, not vibes.
- **Three legacy agents become rows in `agents`** at Phase 0.1: `recruiting`, `proactive_planner`, `inbound_router`.

---

## Decisions still open

- **Where the per-agent system prompt template lives at edit time** — column-of-truth vs file-of-truth. Revisit at Phase 0.5.
- **`agent_requests` storage backend** — Postgres through Phase 5; revisit at Phase 6.
- **Per-task pricing tiers, base subscription, free tier rules.** Direction locked, numbers open. Revisit before Phase 6.
- **Voice agent: build vs partner.**
- **Mobile-native caregiver app.** Affects scheduling outcome verification quality.
- **Per-agent metering granularity exposure** (cost per outcome shown to customers vs internal-only).
- **Cross-org learning opt-in design.** Off by default; revisit if a customer asks.
- **SaaS product brand name.** Carried over from `docs/SAAS_RETROFIT_STATUS.md`.

---

## Shipped PRs

| Date | PR | Phase | Summary |
|------|----|----|---------|
| 2026-04-30 | (this PR) | — | Vision doc refined, full plan and tracker docs spawned. No code. |

(Add a row when each Phase 0 PR ships.)

---

## How to update this file

- **Phase starts**: flip `Status` to `In progress`, note target completion.
- **PR merges**: add a row to "Shipped PRs" with date, PR number, phase, one-line summary. Update the phase status table.
- **Phase completes**: flip `Status` to `Shipped`, fill `Shipped` column with the date. Advance "Current phase" to the next one. Note bake start.
- **Decision locked**: move from "still open" to the locked list in `docs/AGENT_PLATFORM_VISION.md` (strategic) or `docs/AGENT_PLATFORM.md` (operational), summarize here.

The platform is sequential. If this file says a later phase is in progress while an earlier one is not shipped, something has gone wrong — stop and reconcile with the owner.
