# Care Coordinator Agent — Change-of-Condition Detector (v1 Spec)

**Status:** Design draft for owner review, 2026-05-31. Not yet implementation-approved.
**Working branch:** `claude/focused-cannon-NgMWQ`
**Related:** `docs/AGENT_PLATFORM_VISION.md`, `docs/TASKS_AND_FOLLOWUPS.md`, `docs/RLS_GOTCHAS.md`, `docs/SAAS_RETROFIT.md` (Phase B compliance), Context Layer section of `CLAUDE.md`.

---

## 0. Owner Decisions (locked 2026-05-31)

1. **Don't gate on the SaaS retrofit.** Build the agent and make it great. Apply retrofit hygiene only where it's free and non-blocking (e.g. `org_id` columns) — do not pull in RLS-tightening complexity or per-org-secret machinery that raises error risk.
2. **First deliverable = the Change-of-Condition Detector.** Read-only clinical surveillance. (Care-plan fidelity and coordination comms are later loops, out of scope for v1.)
3. **Autonomy ceiling = decide later, from data.** v1 is strictly read-only / suggest. Instrument dismissals from day one so the autonomy decision is data-driven.
4. **Triage audience = office staff** (Kevin / Jessica), who decide whether to escalate to a nurse. No dedicated clinical-reviewer role assumed.
5. **Back-office only in v1.** Caregivers keep logging observations exactly as they do today; the detector works silently on top. No caregiver-PWA changes.

---

## 1. Problem & Goal

Caregivers already log a dense, structured stream of what happens on every shift — task completions (done / partial / not done), refusals, mood, vitals, concerns, and free-text notes (`care_plan_observations`). Today that stream is **reviewed by a human, shift by shift, if at all.** Subtle deterioration — eating less, new pain, needing more help with transfers, growing confusion — is exactly the kind of pattern that's invisible in any single shift but obvious across a few days. Catching it early is the single highest-leverage thing a care coordinator does: the validated home-care/SNF playbooks (INTERACT, "Stop and Watch," SBAR) cut avoidable hospital transfers **17–24%** by doing precisely this.

**Goal:** An AI agent that continuously reads each client's recent observations *against their care-plan baseline*, detects clusters that suggest a change of condition, and surfaces a triage-ready **care signal** — with the supporting evidence and a nurse-ready SBAR draft — to the office team. Nothing is sent or changed automatically; a human decides what to do.

**Why we can do this better than the market:** ShiftCare/AlayaCare-style products scan *unstructured notes against generic rules*. We have (a) a structured, per-task observation stream and (b) a versioned, per-client clinical baseline (the care plan). Reasoning over the *delta between expected and observed, per client* is more precise and more explainable than generic note-scanning.

### Non-goals (explicit, v1)

- **Not a diagnosis engine.** It recommends a human review; it never asserts a clinical condition or instructs care.
- **No outward actions.** No SMS, no family messages, no phase/plan changes, no scheduling. (Those are later loops, gated on accuracy data.)
- **No caregiver-facing UI.** No in-shift prompts. Back-office only.
- **No ML risk model.** v1 is LLM reasoning over structured deltas against the care plan — explainable and right-sized for current data volume. Statistical hospitalization models are a future option once we have the volume.
- **Not the family digest.** Family-facing `care_plan_digests` remain a separate, future surface (see §11). The detector's analysis core is designed so it *can* feed digests later, but v1 ships staff-only signals.

---

## 2. The Clinical Model

The detector reasons against the **"Stop and Watch"** early-warning rubric — a checklist designed for non-clinical front-line staff, which maps cleanly onto our observation stream:

| Stop-and-Watch signal | Our observation source |
|---|---|
| **S**eems different / **T**alks less | `mood` rating drop; `shift_note`; `general` |
| **O**verall needs more help | `task_completion: partial / not_done` on tasks normally `done` |
| **P**ain | `concern` / `shift_note` free-text; mood |
| **A**te less / **D**rank less | `refusal` or `not_done` on feeding/nutrition tasks; notes |
| **N**o bowel movement | `concern` / `shift_note` |
| **W**eight change | `vital`; `concern` |
| **A**gitated / more confused | `mood`; `concern`; medication-related `shift_note` |
| **C**hange in skin | `concern`; `shift_note` |
| **H**elp walking / transfers | `task_completion` on ambulation/transfer tasks |

Two principles make the output trustworthy:

1. **Baseline-relative, not absolute.** A client whose care plan says "frequently refuses meals, needs 2-person transfer" must not trip the same wire as one who is independent and suddenly cannot transfer. The published care-plan version (`care_plan_versions.data` + `care_plan_tasks`) *is* the per-client baseline; the agent reads it as context.
2. **Clusters, not points.** A single isolated `partial` is noise. A cluster across multiple Stop-and-Watch categories, especially trending worse over recent shifts, is signal. **Default to silence.** (See §8, calibration.)

**Worked example (real data, 2026-05-31 shift for Blerta Nash):** in one shift — `Transfer bed→chair: not_done (refused)`, `Transfer rollator→car: partial`, `Prepare meals: refusal ("not hungry, feels unwell")`, meds `shift_note ("wasn't sure she takes BP meds")`, shift_note `("feeling unwell, stomach hurts")`. Against a baseline of relative independence, that is **four Stop-and-Watch categories lit (needs-more-help + ate-less + pain + confusion), multiple off-baseline, same shift** → a high-confidence `urgent` signal recommending nurse review, with an auto-drafted SBAR. That catch is the entire justification for the feature.

---

## 3. Current-State Inventory (what we extend, not rebuild)

| Asset | What it is | We reuse it for |
|---|---|---|
| `care_plan_observations` (mig `20260420010000`, +`20260603120000`) | Per-shift caregiver log. Types: `task_completion` (done/partial/not_done), `refusal`, `shift_note`, `mood`, `concern`, `positive`, `vital`, `general`. Linked to `version_id`, `task_id`, `shift_id`, `caregiver_id`, `logged_at`. Org-scoped, staff RLS. | **The detector's primary input stream.** |
| `care_plan_versions.data` + `care_plan_tasks` | Versioned, published clinical baseline (diagnoses, meds, fall risk, cognition triggers, ADL/IADL task expectations). | **The per-client baseline context.** |
| `care_plan_digests` (`concerns` jsonb, severity info/watch/urgent) | Scaffolded family-facing summary table; **generator never built.** | Future shared-analysis sibling (§11). Not written in v1. |
| `agents` manifest table | Per-agent model / version / tool-allowlist / kill-switch. Already powers the recruiting agent. | New row: `care-coordinator`. |
| `_shared/operations/agentRuntime.ts` | Claude tool-loop wrapper: cost tracking, kill-switch, `agent_actions` audit. | The detector's execution path. |
| `ai-chat/context/assembler.ts` (6 composable layers) | Modular system-prompt builder. | Add two layers: `carePlanBaseline`, `recentObservations`. |
| `care-plan-snapshot` edge fn (`prompt.ts`) | Existing care-plan→narrative Claude call (the "Generate snapshot" button). | Pattern reference for prompt + model invocation. |
| `events` / `action_outcomes` | Append-only bus + outcome tracking. | Instrument every signal create / acknowledge / dismiss → feeds the autonomy decision. |
| `automation-cron` + pg_cron | Existing scheduled-job pattern. | The detector's sweep trigger (§5). |
| `public.default_org_id()`, `public.is_staff()` | Phase-B org default + staff RLS helpers. | New table's org_id default + RLS. |

---

## 4. New Schema — `care_signals`

The detector's only write target: a triage worklist. Additive, org-scoped from day one (cheap retrofit hygiene), staff-only RLS via `is_staff()`.

```sql
CREATE TABLE IF NOT EXISTS care_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) DEFAULT public.default_org_id(),
  client_id         text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  care_plan_id      uuid REFERENCES care_plans(id) ON DELETE SET NULL,

  severity          text NOT NULL CHECK (severity IN ('info','watch','urgent')),
  -- Stop-and-Watch categories that fired, e.g. ['ate_less','pain','needs_more_help'].
  categories        text[] NOT NULL DEFAULT '{}',
  summary           text NOT NULL,            -- one-line headline for the worklist
  -- SBAR draft for the nurse hand-off. { situation, background, assessment, recommendation }.
  sbar              jsonb,
  -- Traceability: the exact observation rows that triggered this signal.
  -- [{ observation_id, logged_at, type, rating, note, task_name }]
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Window the detector analyzed, for reproducibility.
  window_start      timestamptz,
  window_end        timestamptz,

  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','acknowledged','dismissed','actioned')),
  disposition_note  text,                     -- why dismissed / what was done
  dispositioned_by  text,
  dispositioned_at  timestamptz,

  -- Provenance for prompt A/B and post-hoc QA.
  agent_id          uuid REFERENCES agents(id),
  model             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_care_signals_open
  ON care_signals (org_id, status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_signals_client
  ON care_signals (client_id, created_at DESC);
```

**Dedup discipline:** the detector must not re-flag the same cluster every run. Before writing, it checks for an `open` signal on the same client whose evidence overlaps the same observation window; if found, it updates rather than duplicates. (Implementation detail in §5.)

---

## 5. Detection Pipeline

```
trigger ──> assemble ──> reason (Claude) ──> dedup ──> write care_signal ──> surface
```

**5.1 Trigger.** Two paths, mirroring the `follow_up_tasks` pattern:
- **Cron sweep (primary for v1):** reuse the `automation-cron` / pg_cron pattern. Every N hours, for each active client with new observations since last sweep, run the detector. Simpler and safer to ship first than per-shift event wiring, and it naturally supports the cross-shift *trajectory* analysis.
- **(Later) event-driven:** hook shift-completion to run the detector for just that client for near-real-time signals. Deferred until cron path is proven.

**5.2 Assemble context** (two new assembler layers):
- `carePlanBaseline` — published `care_plan_versions.data` summarized + `care_plan_tasks` expectations (what's normal for *this* client; diagnoses, fall risk, cognition triggers, meds).
- `recentObservations` — last ~7 days of `care_plan_observations` for the client, grouped by shift (reuse `groupObservationsByShift` / `formatObservation` from `carePlanObservationFormatting.js`), plus a short per-task trend ("meals: 3 of last 4 shifts refused/partial").

**5.3 Reason.** One Claude call per client via `agentRuntime`, system prompt = Stop-and-Watch rubric + baseline-relative + cluster-not-point + default-to-silence + SBAR output contract. Output is structured JSON: `{ signal: bool, severity, categories[], summary, sbar{}, evidence_observation_ids[] }`. If `signal: false`, write nothing.

**5.4 Dedup & write.** Resolve `evidence_observation_ids` to full evidence rows. Check for an overlapping `open` signal on the client; update-or-insert. Stamp `agent_id`, `model`, window.

**5.5 Surface.** §7.

---

## 6. The Agent

- **Manifest row** in `agents`: slug `care-coordinator`, its own model (default to a current Claude model), version, tool-allowlist, `is_active` kill-switch. Independent of the recruiting agent.
- **Tools (read-only in v1):** `get_care_plan_baseline(client_id)`, `get_recent_observations(client_id, days)`, `write_care_signal(...)`. No outward-action tools registered. This is the structural enforcement of "read-only / suggest" — the agent *cannot* send anything because the tools don't exist in its allowlist.
- **Cost & audit:** inherited from `agentRuntime` (`agent_actions` dual-write with token/duration/model).
- **Decision-support framing baked into the prompt:** always phrase as "recommend a nurse review"; never assert diagnosis or instruct clinical action.

---

## 7. Surfacing & Triage (office-staff)

- **Client page — "Care Signals" panel**, adjacent to the existing "Recent Activity" / care-plan log (same place staff already look). Each signal: severity chip, one-line summary, Stop-and-Watch category tags, expandable evidence (the actual observation rows, with shift + timestamp + caregiver), and the SBAR draft (copy-to-clipboard for pasting into a note or handing to a nurse).
- **AI briefing** (existing chat-open briefing): "N clients flagged for review today," linking to each.
- **Triage actions** (the only writes a human makes in v1): **Acknowledge**, **Dismiss** (requires a reason), **Mark actioned** (free-text what was done, e.g. "called family / nurse visit scheduled"). Each writes `status` + disposition fields **and** an `events` + `action_outcomes` row.
- **Icons:** `lucide-react` only — no emoji glyphs in rendered UI (per `CLAUDE.md`). Note the existing `formatObservation` helper returns glyph hints (`✓`, `⚠`); the new panel must map these to lucide components, not render the glyphs.

**SBAR draft shape** (`care_signals.sbar`):
- **Situation:** what changed, when ("Blerta refused meals and reported abdominal pain on the 5/31 morning shift").
- **Background:** relevant baseline ("66F, retired; care plan notes fall risk, BP meds; normally independent with meals").
- **Assessment:** the cluster ("New pain + reduced intake + reduced mobility + medication confusion across one shift — possible acute change").
- **Recommendation:** "Recommend nurse phone check-in today; consider PCP contact if symptoms persist." (Always a *recommendation to a human*, never an order.)

---

## 8. Calibration — the make-or-break

Alert fatigue kills these products. Design bias: **precision over recall in v1.** Better to miss a borderline case than train staff to ignore the panel.

- **Require clusters.** Default thresholds: `info` rarely surfaced; `watch` = ≥2 categories OR a clear single-category trend across ≥3 shifts; `urgent` = ≥3 categories off-baseline in a short window, or any explicit acute concern (new pain + functional drop).
- **Baseline suppression.** Behaviors the care plan documents as normal for the client are down-weighted.
- **One signal per cluster.** Dedup (§4, §5.4) prevents re-flagging.
- **Dismissal is training data, not deletion.** Every dismiss with reason is retained and feeds prompt tuning + the eventual autonomy decision.
- **Tunable, not hardcoded-per-customer.** Thresholds live in config (an `organizations.settings` key or the agent manifest), not literals — keeps the multi-tenant door open for free.
- **Shadow/QA period:** ship behind a feature flag for Tremendous Care; measure staff agreement (acknowledged+actioned vs dismissed) before widening sensitivity.

---

## 9. Feedback Loop & Instrumentation (enables "decide autonomy later")

The owner deferred the autonomy ceiling "to data." That decision is only possible if v1 *collects* the data:

- Every signal create → `events` (`event_type: care_signal_created`) + `action_outcomes` (pending).
- Every disposition → updates the `action_outcomes` row (`acknowledged` / `actioned` / `dismissed`) — i.e. **did the human agree the signal was worth surfacing?**
- This yields a per-severity, per-category **precision rate** over time. When that rate is high and stable for a given action type, *that's* the evidence to graduate specific later-loop actions (family update drafts, follow-up task creation) up the autonomy ladder. Clinical escalation itself should likely stay human-confirmed indefinitely.

---

## 10. Safety, HIPAA, Scope

- **Decision support, not diagnosis** — enforced in prompt + UI copy. Protects a non-technical owner from clinical-liability framing.
- **PHI in transit:** care plans + observations are PHI; sending them to Claude makes prompt content PHI. Confirm Anthropic data-handling / BAA posture before health data hits the model. (The per-org-secret pattern is the eventual home for the provider key, but that's retrofit machinery we are *not* pulling in for v1 — flag, don't build.)
- **Kill switch:** `agents.is_active = false` halts the detector instantly, no redeploy.
- **No destructive ops, additive schema only** (per `CLAUDE.md` / Prime Directives).

---

## 11. Relationship to Family Digests (future, not v1)

`care_plan_digests` is scaffolded for *family-facing* warm summaries with a `concerns` array — a different audience (reassurance) than care signals (staff action). They share one input (`care_plan_observations`) and overlapping analysis (concern detection). **Design intent:** factor the observation-analysis core so a future digest generator and the detector share it — detector emits staff `care_signals`, digest emits family `concerns`. v1 builds only the detector; we note the seam so we don't paint into a corner.

---

## 12. Retrofit Hygiene — do vs. defer

| Do now (free / non-blocking) | Defer (complexity / error risk) |
|---|---|
| `org_id` on `care_signals` via `default_org_id()` | Per-org secret lookup for the Anthropic key |
| `is_staff()` RLS on the new table | Tightened cross-tenant RLS audits beyond the new table |
| Tunable thresholds in `settings` (no hardcoded branding) | Configurable-pipeline / branding work (Phase D) |

---

## 13. Testing

- **Unit (Vitest, per `CLAUDE.md`):** Stop-and-Watch mapping, severity scoring, baseline-suppression, dedup/window logic, SBAR assembly, evidence resolution. New business logic gets tests before merge.
- **Fixture replay:** a library of real anonymized shift-observation sets (incl. the Blerta 5/31 cluster) with expected severities — guards against calibration regressions when we tune the prompt.
- **RLS reproduction:** per `RLS_GOTCHAS.md`, run the exact frontend `care_signals` query under `SET LOCAL ROLE authenticated` before merging the migration.

---

## 14. Milestones (within v1)

1. **M1 — Schema + agent manifest + read tools.** `care_signals` migration, `care-coordinator` agent row, read-only tools. No UI.
2. **M2 — Detector core + prompt + cron sweep.** Analysis runs, writes signals; behind a feature flag. Fixture-replay tests green.
3. **M3 — Client-page Care Signals panel + triage (ack/dismiss/actioned) + instrumentation.**
4. **M4 — Briefing integration + calibration tuning** from real shadow-period agreement data.

Each milestone is its own PR with CI (tests + build) green and a rollback note.

---

## 15. Open Questions for Owner

1. **Detection cadence:** is a few-hour cron sweep acceptable for v1, or do you want near-real-time per-shift detection from the start? (Cron is simpler/safer; real-time is more work.)
2. **History depth:** analyze the last 7 days of observations by default? Or a different window (e.g., since last published care-plan version)?
3. **Provider/BAA:** can you confirm the Anthropic data-handling posture so we're clear to send PHI to the model, or should we plan a de-identification step first?
4. **Escalation artifact:** is "copy the SBAR draft to clipboard" enough for v1, or do you want a one-click "create a follow-up task from this signal" (reusing `follow_up_tasks`) — still human-initiated, but tighter?
