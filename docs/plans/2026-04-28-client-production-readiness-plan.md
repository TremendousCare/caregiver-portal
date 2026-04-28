# Client Side Production Readiness Plan (with Caregiver Baseline)

Date: April 28, 2026
Owner: Engineering
Scope: Admin portal client experience, with caregiver portal used as a quality/reference baseline

## 1) Executive summary

The caregiver side is currently more production-mature than the client side in three key ways:

1. **State model clarity**: caregiver workflow cleanly separates onboarding and active roster states.
2. **UI/UX boundaries**: caregiver detail surfaces phase-specific UI conditionally, reducing mixed signals.
3. **Operational readiness**: caregiver flows have more explicit nudges/hand-offs for lifecycle transitions.

The client side is functional, but currently treats `won` as still part of the active/pipeline operating view. This causes UI overlap (e.g., "Client Pipeline Progress" and `Won` badges coexisting after conversion), creates ambiguous ownership after conversion, and risks reporting drift.

## 2) Current-state findings (code-based)

### 2.1 Lifecycle boundary is currently blurred for clients

- `activeClients` includes all non-archived, non-lost clients, which means `won` clients stay in the same active set as pipeline leads.
- Multiple screens consume this same set for dashboard/sidebar metrics and list rendering.
- Result: converted clients still inherit pipeline artifacts and urgency framing.

### 2.2 Detail page always renders pipeline progress UI

- `ClientDetail` always renders `ClientProgressOverview` and `ClientPhaseDetail` regardless of whether phase is terminal (`won`, `lost`, `nurture`).
- `ClientProgressOverview` intentionally renders pipeline title/progress bar plus terminal badges in one area.
- This is likely why users still see pipeline context after conversion.

### 2.3 Phase model mixes lifecycle status with operational stages

- `CLIENT_PHASES` combines pipeline phases (`new_lead` → `proposal`) and status phases (`won`, `lost`, `nurture`).
- This structure is valid for a single selector, but without explicit UI guards it leaks pipeline UI into post-conversion states.

### 2.4 Caregiver side establishes a stronger pattern to reuse

- Caregiver context has explicit `onboardingCaregivers` vs `rosterCaregivers` and views are routed separately.
- Caregiver detail flow uses conditional nudges and sectioning, which makes lifecycle transitions clearer.

## 3) Production readiness goals (client)

1. **Hard-separate lifecycle views**
   - Pipeline = pre-conversion revenue funnel.
   - Active client = post-conversion service delivery.

2. **Make status transitions explicit and auditable**
   - Conversion should trigger deterministic UI/state transitions.
   - Add event logging and metrics for conversion and onboarding handoff.

3. **Preserve backward compatibility and rollout safety**
   - No destructive schema changes required for phase 1.
   - Feature-flag behavior changes where feasible.

## 4) Recommended implementation plan (small, reviewable diffs)

## Phase 0 — Stabilize definitions (no behavior changes)

**Deliverable:** shared lifecycle policy doc + acceptance criteria.

- Define canonical client lifecycle segments:
  - `pipeline`: `new_lead`, `initial_contact`, `consultation`, `assessment`, `proposal`
  - `post_conversion`: `won`
  - `closed`: `lost`, `archived`
  - `nurture`: optional separate bucket
- Define exactly which widgets are legal in each segment.
- Freeze this into docs before UI changes.

## Phase 1 — UI separation in Client Detail (lowest risk, highest UX gain)

**Deliverable:** converted clients no longer see pipeline progress widgets.

1. Add `isPipelinePhase` / `isTerminalPhase` helper(s) in `src/features/clients/utils.js`.
2. In `ClientDetail`:
   - show `ClientProgressOverview` and `ClientPhaseDetail` only for pipeline phases.
   - for `won`, replace with a dedicated "Client Onboarding" section.
3. Keep `ClientProfileCard`, `CarePlanPanel`, `ServicePlansPanel`, and `ClientSchedulePanel` available for won clients.
4. Ensure `lost` and `archived` avoid conversion/onboarding prompts.

**Acceptance criteria**
- A `won` client does not show "Client Pipeline Progress".
- A `won` client does not show phase tabs for new lead/contact/consult/assessment/proposal.
- No regression for pipeline clients.

## Phase 2 — Data segmentation for dashboard/sidebar metrics

**Deliverable:** dashboard and sidebar distinguish pipeline workload vs active service load.

1. In `ClientContext`, add derived sets:
   - `pipelineClients`
   - `convertedClients` (won)
   - `nurtureClients`
2. Update `ClientDashboard` stats cards to avoid counting `won` inside active pipeline counts.
3. Update `ClientSidebarExtra` labels and counts:
   - "Pipeline Leads"
   - "Converted Clients"
   - "Archived"

**Acceptance criteria**
- "Active Leads" reflects only pipeline phases.
- Conversion totals match phase counts exactly.

## Phase 3 — Routing + IA (information architecture) hardening

**Deliverable:** clearer navigation parity with caregiver side.

1. Add dedicated route/filter preset for converted clients (e.g., `/clients?view=active` or sidebar section).
2. Keep pipeline board/list defaults separate from active client operations.
3. Ensure links from automations/notifications deep-link to the right view context.

## Phase 4 — Production safeguards and observability

**Deliverable:** safer release and post-release confidence.

1. Add/expand unit tests for:
   - phase segmentation helpers
   - dashboard counts
   - detail conditional rendering
2. Add analytics/structured logs for:
   - client converted
   - onboarding panel viewed
   - phase reverted from won to pipeline (if allowed)
3. Add release checklist with smoke tests for the top 10 lifecycle scenarios.

## 5) Suggested ticket breakdown (ordered)

1. **Ticket A:** Lifecycle segmentation helpers + tests.
2. **Ticket B:** Hide pipeline widgets for `won` in detail page.
3. **Ticket C:** Introduce onboarding panel placeholder for converted clients.
4. **Ticket D:** Context-derived groups and dashboard/sidebar metric corrections.
5. **Ticket E:** Navigation split for pipeline vs converted.
6. **Ticket F:** Observability instrumentation + runbook updates.

Each ticket should target <250 LOC changed and be releasable independently.

## 6) Risk assessment

### Primary risks
- Existing users may rely on old mixed layout behavior.
- Filters and counts may temporarily diverge if only part of segmentation is shipped.
- Automations keyed by phase may surface links into the wrong context if routing updates lag.

### Mitigations
- Release in phases above (UI-first, then data segmentation).
- Add temporary feature flag for converted-client detail rendering.
- Add QA matrix for every phase + archived permutation.

## 7) Rollback strategy

- Keep each phase in isolated PRs.
- If regression appears, revert only the affected PR:
  - Phase 1 rollback restores previous detail rendering.
  - Phase 2 rollback restores previous metric derivations.
- No schema migration is required for phases 0–3, so rollback is code-only.

## 8) Immediate next step (this week)

Ship **Phase 1** first. It directly addresses your reported production concern (mixed pipeline/active visuals after conversion) with minimal blast radius and no schema changes.
