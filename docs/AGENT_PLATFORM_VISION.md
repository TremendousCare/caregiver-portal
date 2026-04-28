# Agent Platform — Vision

**Status**: Vision document. No implementation in flight.
**Prerequisite**: SaaS multi-tenancy retrofit (`docs/SAAS_RETROFIT.md`) Phases A–E shipped and baked.
**Spawns when work begins**: `docs/AGENT_PLATFORM.md` (full plan) + `docs/AGENT_PLATFORM_STATUS.md` (living tracker).

---

## Vision

Tremendous Care is becoming a vertically-integrated home-care operating system where specialized AI agents — scheduling, recruiting, intake, care coordination, and more — autonomously deliver completed business outcomes for home-care agencies. We replace legacy CRMs (HHAeXchange, AxisCare, MatrixCare, WellSky) by being a system of *action* rather than a system of record. The agent platform is the moat; the underlying CRM is the substrate; per-agency learning and measurable per-task outcomes are the wedge.

---

## What this doc is (and isn't)

This is a vision document. It captures direction and prime directives, **not** a committed roadmap. Phasing, sequencing, and timelines are deliberately left soft. Specific implementation work begins only after the SaaS multi-tenancy retrofit (Phases A–E in `docs/SAAS_RETROFIT.md`) is shipped and baked.

Until then, this doc preserves intent. It is updated when:
- A prime directive needs to change — pause and discuss before editing.
- A new agent is added to the ambitions list.
- A decision is locked or re-opens.

When agent-platform implementation begins, this doc spawns:
- `docs/AGENT_PLATFORM.md` — full phased plan (mirrors `SAAS_RETROFIT.md`).
- `docs/AGENT_PLATFORM_STATUS.md` — living tracker (mirrors `SAAS_RETROFIT_STATUS.md`).

This vision file remains the upstream source of truth for *why* and *what*; the spawned docs cover *how* and *when*.

---

## Prime directives (non-negotiable)

These hold no matter how the plan evolves. Re-opening any of them requires explicit owner discussion.

1. **Agent identity is data, not code.** Every agent is a row in an `agents` table with a manifest (system prompt, tool allowlist, autonomy profile, context-layer recipe, success criteria). Adding a new agent is config, not a new edge function. Operators can edit agent behavior from a Settings UI without redeploy.

2. **Outcomes are verified by third-party signals, never self-reported.** An agent never marks its own action complete. Completion comes from external evidence recorded in the `events` bus — caregiver clock-in, signed envelope, inbound SMS reply, confirmed shift assignment. The agent has incentive to claim success; the architecture must not let it.

3. **The audit log is billing-grade from day one.** Tamper-evident, signed, exportable, reproducible months later. Every agent action and every claimed outcome must be defensible in a customer dispute. This is a hard prerequisite for any per-task pricing model.

4. **Per-org learning is the moat, not shared learning.** Each agency's agents get smarter on that agency's own data. Cross-org patterns are opt-in only and aggregated above the level of any individual customer's records. Customer data does not leak between tenants under any circumstance.

5. **Trust is earned in stages.** Every agent action has an autonomy level (L1 suggest → L2 confirm → L3 notify → L4 auto). Promotion is data-driven (consecutive successful approvals, success-rate thresholds), not opinion-driven. Org admins can cap any agent's ceiling.

6. **Agents must be instantly killable, per agent, per org.** Customers own a kill switch. A misbehaving agent for one org never threatens production for another. This must work without a deploy.

7. **Every directive in `docs/SAAS_RETROFIT.md` still applies.** Org-scoped queries, additive schema changes, per-org secret lookups, no hardcoded branding — all of it carries forward into the agent platform layer.

---

## Agent ambitions

The agents we plan to build, ordered by current priority. Ambitions, not commitments — the list is allowed to grow and re-order as we learn.

| Agent | Status | Notes |
|-------|--------|-------|
| **Scheduling Agent** | Wedge | Fills open shifts, handles call-offs, manages caregiver-shift matching, learns availability patterns. Highest stakes, biggest demo wow-factor. |
| **Recruiting Agent** | Exists, will migrate | The current AI chat. Sources, screens, advances candidates through pipeline. Becomes the first row in the `agents` table during platform extraction. |
| **Client Intake / Lead Management Agent** | Planned | Moves new client leads through inquiry → assessment → start-of-care. |
| **Care Coordination Agent** | Planned | Ongoing client care management, family communication, escalations, visit follow-ups. |
| **(More)** | Speculative | Compliance, retention, family communication, QA/supervision, billing reconciliation, onboarding, training, etc. List expands as the platform matures. |

---

## Strategic decisions locked

- **Replace, don't layer.** We replace incumbent CRMs (HHAeXchange, AxisCare, MatrixCare, WellSky), not integrate alongside them. The CRM substrate must stand on its own.
- **Scheduling agent is the wedge.** First production agent for non-Tremendous-Care customers.
- **Recruiting agent migrates onto the platform**, not rebuilt. Behavior should be indistinguishable from today's AI chat after migration.
- **Per-agency learning is private by default.** Cross-org learning is opt-in if and when it ships.

---

## Decisions still open

Captured here so they don't accidentally close by default.

- **Pricing model.** Lean: base CRM subscription + per-agent module. Per-completed-task is the more disruptive long-term play but operationally heavier (metering, disputes, no-show latency). May launch per-module and add per-task later.
- **"Task completed" definition per agent.** Especially scheduling: does a human dispatcher nudge invalidate the agent's completion claim? Define narrowly and conservatively to start.
- **Cross-org learning opt-in design.** Aggregation level, consent flow, governance.
- **Voice agent: build vs partner.** Outbound recruiting calls, intake interviews, caregiver check-ins.
- **Mobile-native vs web-responsive caregiver experience.** Affects clock-in, shift questions, escalations.
- **Policy-engine rule templates.** Whether one customer's policy rules can be templated for others (with consent).
- **SaaS product brand name** (deferred from `docs/SAAS_RETROFIT_STATUS.md`).

---

## Dependencies

Implementation work on the agent platform does not begin before all of the following are shipped and baked:

- **Phase B** — `org_id` + RLS on every AI table (`context_memory`, `events`, `action_outcomes`, `autonomy_config`, `context_snapshots`). Hard prerequisite. Without this, a second customer's data is readable by the first.
- **Phase C** — Per-org secrets, including per-org Anthropic API keys. Required so each agency can bring its own AI credentials and so usage is billable per-tenant.
- **Phase D** — Configurable pipeline phases, per-org branding, feature toggles. Required before any second customer can onboard.
- **Phase E** — Self-serve onboarding, BAA artifacts, billing integration. Required before self-serve sales.

Phases must ship in order; agent-platform work is downstream of all of them. See `docs/SAAS_RETROFIT_STATUS.md` for current phase.

---

## Areas of work (when the time comes)

Named territories, **not** sequenced phases. Order is deliberately unspecified at this stage.

- **Agent platform** — promote agents to first-class data; generic runtime that loads agents by manifest; per-agent context-layer recipes; per-agent tool allowlists.
- **Outcome-driven learning** — per-agent success criteria, per-agent semantic memory, per-org pattern detection with confidence thresholds.
- **Trust & safety** — billing-grade audit log, per-org policy engine, per-agent kill switch, shadow mode for new agent rollouts, dispute resolution surface.
- **First two production agents** — scheduling (new) + recruiting (migrated). Each independently shippable, separately licensable.
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
