# Agent Platform — Vision

**Status**: Vision document — locked directives below. Implementation plan and tracker spawned.
**Plan**: `docs/AGENT_PLATFORM.md` (full phased plan)
**Tracker**: `docs/AGENT_PLATFORM_STATUS.md` (current phase, decisions, shipped PRs)
**Prerequisite for Phase 0 (foundation refactor)**: none — runs in parallel with SaaS Phase B–C/D as additive scaffolding.
**Prerequisite for Phase 2+ (new live agents for Tremendous Care)**: SaaS Phase B5 baked on every AI-tier table (`events`, `action_outcomes`, `ai_suggestions`, `context_memory`, `autonomy_config`, plus the new `agents` table) — i.e., RLS actually enforces tenant isolation, not just permissive policies.
**Prerequisite for multi-tenant agent rollout (selling agents to other agencies)**: SaaS Phases C–D shipped (per-org secrets, configurable phases/branding/feature toggles) — gates customer #2, not Tremendous Care's own use.

---

## Vision

Tremendous Care is becoming a vertically-integrated home-care operating system where specialized AI agents — scheduling, recruiting, intake, care coordination, and more — autonomously deliver completed business outcomes for home-care agencies. We replace legacy CRMs (HHAeXchange, AxisCare, MatrixCare, WellSky) by being a system of *action* rather than a system of record. The agent platform is the moat; the underlying CRM is the substrate; per-agency learning and measurable per-task outcomes are the wedge.

---

## What this doc is (and isn't)

This is the vision and prime-directive layer. It owns *why* and *what*. The spawned docs (`AGENT_PLATFORM.md`, `AGENT_PLATFORM_STATUS.md`) own *how* and *when*. Re-read this file before any change to schema, agent identity, secrets, autonomy thresholds, audit log shape, or pricing posture.

This doc is updated when:
- A prime directive needs to change — pause and discuss with the owner before editing.
- A new agent is added to the ambitions list.
- A decision is locked or re-opens.

The spawned docs are updated freely as implementation proceeds.

---

## Prime directives (non-negotiable)

These hold no matter how the plan evolves. Re-opening any of them requires explicit owner discussion.

1. **Agent identity is data, not code.** Every agent is a row in an `agents` table with a manifest: org_id, slug, name, version, system_prompt, tool_allowlist, autonomy_profile, context_recipe, model, max_iterations, kill_switch, shadow_mode, outcome_definition. Adding a new agent or splitting an existing one is config, not a new edge function. Operators edit agent behavior from a Settings UI without redeploy.

2. **Outcomes are verified by third-party signals, never self-reported.** An agent never marks its own action complete. Completion comes from external evidence recorded in the `events` bus — caregiver clock-in, signed envelope, inbound SMS reply, confirmed shift assignment, paid invoice, start-of-care date. Each agent's `outcome_definition` is explicit about *which* event types count as a verified outcome and over what window. Documented per-agent escape clauses are allowed (e.g., "operator-confirmed completion" for actions with no third-party signal), but each escape clause is an explicit field, not a default.

3. **The audit log is billing-grade from day one.** Tamper-evident, signed, exportable, reproducible months later. Every agent action and every claimed outcome must be defensible in a customer dispute. This is a hard prerequisite for any per-task pricing model. The existing `events` table is *not* sufficient — a dedicated `agent_actions` log with hash-chained signing is required.

4. **Memory is per-agent by default, org-shared by explicit promotion.** Each agent owns its own memory slice (`context_memory.agent_id` set). Two promotion channels:
   - *Auto-promotion*: when the consolidation pipeline detects a system-wide pattern (semantic memory: success rates; procedural memory: SOPs from repeated corrections), it writes the new memory with `agent_id = NULL` (org-level) + tag `shareable`. All agents in the org read these.
   - *Manual promotion*: an entity-level fact ("Maria prefers Spanish texts at 9am") starts in the agent that observed it. An operator (or the agent itself, with a confidence threshold) flips it to `shareable`; other agents in the same org pick it up at context-assembly time via UNION read.

   No direct cross-agent LLM-to-LLM calls. Agents communicate only through (a) the shared org memory pool and (b) the `agent_requests` queue. Cross-org learning remains off by default; revisit with explicit owner approval and a privacy review.

5. **Trust is earned in stages, by data, not opinion.** Every agent action has an autonomy level (L1 suggest → L2 confirm → L3 notify-then-auto → L4 auto). Promotion is gated on:
   - **Per-transition thresholds.** L1→L2 cheap, L3→L4 expensive. Each transition has its own `min_consecutive_approvals` and `min_success_rate_pct`.
   - **Fixed-window success rate.** Success rate is computed over the last N actions in a sliding window, not lifetime — so a quiet week of trivial approvals cannot promote a critical action.
   - **Minimum sample size.** No promotion past L1 with fewer than 30 verified outcomes. No promotion past L3 with fewer than 100.
   - **Per-org and per-agent ceilings.** Org admins can cap any agent's max autonomy below the system default. Cap changes propagate within seconds.
   - **Auto-demote on harm.** A single high-severity incident (operator override marked "harmful") demotes by one level immediately and locks promotion for a cool-down window.

6. **Agents must be instantly killable, per agent, per org, without a deploy.** Customers own a kill switch on every agent. A misbehaving agent for one org never threatens production for another. Shadow mode (run-without-acting) is a separate setting on the same row — every new agent ships in shadow mode for ≥7 days before its first L1 action.

7. **Coarse first, then split — but only when data tells you to.** Each agent starts as one row covering its business domain (intake, recruiting, scheduling, care coordination). Split into sub-agents only when one of three signals fires: (a) the system prompt grows past coherent length (~2,500 tokens), (b) the success rate diverges by sub-task type (one workflow at 90%, another at 40%), or (c) the tool allowlist needs to fork. The split is mechanical when agents are first-class data: copy the manifest, narrow prompt + tools, route specific event triggers to the new sub-agent.

8. **Every directive in `docs/SAAS_RETROFIT.md` still applies.** Org-scoped queries, additive schema changes, per-org secret lookups, no hardcoded branding — all of it carries forward into the agent platform layer.

---

## Agent ambitions

The agents we plan to build, ordered by current priority. Ambitions, not commitments — the list is allowed to grow and re-order as we learn.

| Agent | Status | Notes |
|-------|--------|-------|
| **Recruiting Agent** | Exists, migrates in Phase 0 | Today's AI chat. Sources, screens, advances candidates through the pipeline. Becomes the first row in the `agents` table during platform extraction. Behavior must be indistinguishable from today's after migration (verified by replay parity harness). |
| **Intake / Lead Management Agent** | **Wedge — first new agent** | Moves new client leads through inquiry → assessment → start-of-care. Chosen as the wedge because the team is struggling here today (highest internal pain), the blast radius is smaller than scheduling, and the success outcome is clean (`start_of_care_date` set). Ships in Phase 2. |
| **Scheduling Agent** | Next after Intake | Fills open shifts, handles call-offs, manages caregiver-shift matching, learns availability patterns. Highest stakes and biggest external demo wow-factor — but moved behind Intake because Intake delivers more internal value sooner and de-risks the runtime before we expose Scheduling's larger blast radius. Outcome: verified clock-in. |
| **Care Coordination Agent** | Planned | Ongoing client care management, family communication, escalations, visit follow-ups. Heavy memory + cross-agent dependency; ships after the inter-agent dispatch layer. |
| **(More)** | Speculative | Compliance, retention, family communication, QA/supervision, billing reconciliation, onboarding, training, voice. List expands as the platform matures. |

---

## Strategic decisions locked

- **Replace, don't layer.** We replace incumbent CRMs (HHAeXchange, AxisCare, MatrixCare, WellSky), not integrate alongside them. The CRM substrate must stand on its own.
- **Intake agent is the wedge** (revised 2026-04-30). First new agent ships for Intake. Scheduling moves to second. Rationale: highest internal pain today, smallest blast radius among the candidates, cleanest outcome signal (start-of-care date), and de-risks the runtime before we expose Scheduling.
- **Recruiting agent migrates onto the platform**, not rebuilt. Behavior must be indistinguishable from today's AI chat after migration. Indistinguishability is verified by a replay-parity harness, not a vibe check.
- **Coarse-first agent granularity.** One agent per business domain at launch. Split into sub-agents only when data signals it (see Prime Directive #7). The split is reversible — agents-as-data make this cheap.
- **Per-agent memory by default; cross-agent via tagged promotion.** See Prime Directive #4. Cross-org learning remains off by default.
- **Outcome verification is third-party-by-default.** See Prime Directive #2. Per-agent escape clauses are allowed but must be explicit fields on the agent manifest, not silent defaults.
- **Pricing direction (soft, not locked):** per-completed-outcome — shifts filled (verified clock-in), caregivers onboarded (signed envelope + first shift completed), clients started (start-of-care date set). The architecture commits to *making outcomes countable, third-party-verified, and disputable*; specific tier prices and base subscription remain open.

---

## Decisions still open

Captured here so they don't accidentally close by default.

- **Per-task pricing tiers.** Direction is locked (per-completed-outcome). Specific dollar amounts, base subscription minimums, free tier rules, and dispute-resolution SLAs remain open. Revisit before Phase 6 (marketplace + billing).
- **"Outcome verified" definition per agent.** Each agent ships with an explicit `outcome_definition` field on its manifest. Wording is locked at agent kickoff; changes ratchet (you can tighten it, you can't loosen it without a versioned audit trail). Open question: does a human dispatcher nudge invalidate a Scheduling agent claim? Lean conservative — yes, it does, until we have data.
- **Cross-org learning opt-in design.** Aggregation level, consent flow, governance. Off by default; revisit if and when a customer asks for it.
- **Voice agent: build vs partner.** Outbound recruiting calls, intake interviews, caregiver check-ins.
- **Mobile-native vs web-responsive caregiver experience.** Affects clock-in (which is a verified-outcome signal for Scheduling), shift questions, escalations.
- **Policy-engine rule templates.** Whether one customer's policy rules can be templated for others (with consent).
- **SaaS product brand name** (deferred from `docs/SAAS_RETROFIT_STATUS.md`).
- **Per-agent metering granularity.** Per-action token cost is logged today; per-outcome cost requires Phase 1's audit log work. Whether we expose cost-per-outcome to customers (transparency moat) or keep it internal (margin) is open.

---

## Dependencies

Refined 2026-04-30 — the original "wait for all of A–E" framing was too coarse. The honest dependency chain:

- **Phase 0 (foundation refactor)** — runs in parallel with SaaS Phase B–C/D. Pure additive scaffolding: introduces the `agents` table, stamps `agent_id` on existing AI rows, refactors today's three implicit agents (`ai-chat` recruiting, `ai-planner` proactive, `message-router` inbound) into manifest-driven runtime calls. No behavior change, no new agents. Safe before any retrofit milestone.
- **Phase 1 (trust & safety primitives)** — same parallelism rules as Phase 0. Builds kill switch + shadow mode + billing-grade audit log + tightened promotion algorithm. Still no new agents in production.
- **Phase 2+ (new live agents for Tremendous Care)** — gated on **SaaS Phase B5 baked** on every AI-tier table (`events`, `action_outcomes`, `ai_suggestions`, `context_memory`, `autonomy_config`, plus the new `agents` table). Enforcing RLS is the safety floor; without it a second tenant's agents could read first tenant's data the moment customer #2 signs up. We do not ship a live agent we'd have to re-isolate later.
- **Multi-tenant rollout (selling agents to other agencies)** — gated on **SaaS Phases C and D**. C delivers per-org secrets (each agency brings its own Anthropic key, RingCentral JWT, DocuSign account). D delivers configurable pipeline phases, per-org branding, feature toggles. Without C, customer #2 can't run an agent that needs Anthropic. Without D, customer #2 sees Tremendous Care's pipeline labels.
- **Self-serve agent purchase + per-task billing** — gated on **SaaS Phase E** and on agent-platform Phase 6.

This means Phase 0–1 can begin immediately and Phase 2 (Intake agent) can ship for Tremendous Care once SaaS Phase B5 has baked on the AI-tier tables. See `docs/AGENT_PLATFORM.md` for the precise gating per phase.

---

## Areas of work

Phasing and sequencing live in `docs/AGENT_PLATFORM.md`. The named territories below describe scope, not order.

- **Agent platform** — promote agents to first-class data; generic runtime that loads agents by manifest; per-agent context-layer recipes; per-agent tool allowlists.
- **Outcome-driven learning** — per-agent success criteria, per-agent semantic memory, per-org pattern detection with confidence and minimum-sample thresholds, drift detection.
- **Trust & safety** — billing-grade audit log (`agent_actions` with hash-chained signing), per-org policy engine, per-agent kill switch, shadow mode for new agent rollouts, dispute resolution surface, tightened autonomy promotion algorithm.
- **First two production agents** — recruiting (migrated) + intake (new wedge). Each independently shippable, separately licensable.
- **Inter-agent dispatch** — `agent_requests` queue, hand-off patterns, no direct LLM-to-LLM calls.
- **Marketplace + self-serve** — agent catalog UI, per-org install/configure/test in sandbox, Stripe billing integration, onboarding wizard.
- **Vertical differentiation** — voice agent, mobile-first caregiver experience, native integrations (EVV, state Medicaid portals, payroll, background checks).

---

## Anti-goals

Things we are explicitly **not** trying to be.

- A general-purpose AI platform. Vertical home-care opinions are the moat.
- A horizontal CRM with AI bolted on. The agent platform is the product; the CRM is its substrate.
- A self-service prompt builder. Agents are productized, evaluated, versioned, and accountable. We do not ship "build your own agent" tooling at launch.
- A black box. Every agent action is auditable, every claimed outcome is reproducible, every customer can export their data and audit trail.

---

## How this doc evolves

- Owner-only updates to **prime directives** and **decisions locked**. Other contributors propose; owner approves.
- New agents added to **ambitions** freely; reordering requires a sentence of rationale in the commit.
- **Decisions still open** are moved into **decisions locked** only with explicit owner sign-off.
- When agent-platform work formally begins, this file is referenced (not duplicated) by `docs/AGENT_PLATFORM.md`. This vision file remains source of truth for *why*; the plan doc owns *how*.
