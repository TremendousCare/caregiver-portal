# Phase 1.4 — Per-agent metrics dashboard — Handoff

**Created**: 2026-05-10 by previous Claude session that closed Phase 1.2 + 1.3.
**Audience**: the next Claude session that picks up Phase 1.4.
**Lifetime**: delete this file in the same PR that ships Phase 1.4. It's a one-shot context primer, not living documentation.

---

## TL;DR

Phase 1.2 + 1.3 just shipped (PRs #305 + #306, merged 2026-05-10). Migrations applied to production by the owner manually via the Deploy Database Migrations workflow. Phase 1.4 is **next** on the critical path to Phase 2 (recruiting agent autonomous funnel). It's pure UI: a per-agent metrics dashboard at `/settings/agents/{slug}/metrics` reading from `agent_actions` (Phase 1.1) and `action_outcomes`. **No schema changes, no new writes, read-only queries.**

You are working on `claude/phase-1.4` (create the branch off latest `main`).

---

## Required reading order

Read these first, in this order. Don't skip — the prime directives in the vision doc and CLAUDE.md hold for every PR.

1. **`CLAUDE.md`** — production safety rules, RLS rules, dev workflow, test conventions. Read every section.
2. **`docs/AGENT_PLATFORM_VISION.md`** — locked strategic decisions, prime directives. Pay attention to #3 (audit log is billing-grade) and #5 (autonomy promotion algorithm). Both feed into what 1.4 surfaces.
3. **`docs/AGENT_PLATFORM.md`** → Phase 1.4 section (around line 332). The full spec is short — five bullet points. The exit criteria says "owner can answer 'is this agent earning its keep?' in under a minute."
4. **`docs/AGENT_PLATFORM_STATUS.md`** — **STALE.** Currently says 1.2 is "Next" and 1.3/1.4 are "Not started". Reality: 1.2 + 1.3 are both shipped + merged + production-deployed. **Update STATUS.md as part of your 1.4 PR** (don't ship a separate docs PR). Add rows to the Shipped PRs table for #305 + #306, flip phase statuses, advance Current phase to 1.4 in progress.
5. **`docs/RLS_GOTCHAS.md`** — even though 1.4 is mostly read-only, the dashboard reads agent_actions + action_outcomes. Both are RLS'd. Don't write any new policies that gate on `is_admin()` over `user_roles` inline — use the SECURITY DEFINER helper pattern.

## Phase 1.4 spec (verbatim from AGENT_PLATFORM.md)

> - New admin page `/settings/agents/{slug}/metrics`:
>   - Token cost (input/output) and latency, daily / weekly / 30-day.
>   - Suggestion volume by status (pending, approved, rejected, executed, auto-executed, expired, shadow).
>   - Verified-outcome rate, by action type, with the moving-window success rate that drives promotion.
>   - Cost per verified outcome (tokens × price ÷ verified outcomes).
>   - Drift events from the consolidation pipeline.
> - All charts read from `agent_actions` and `action_outcomes` — no extra writes.
> - Export to CSV.
>
> **Exit criteria**: dashboard renders for all three Phase 0 agents with at least 14 days of data. Owner can answer "is this agent earning its keep?" in under a minute.
> **Rollback**: hide the page.

## Production state (verify before starting)

Run these in the Supabase SQL editor or via the MCP `execute_sql` tool to confirm Phase 1.3 + 1.2 actually landed:

```sql
-- Phase 1.2 — autonomy_profile v2 backfilled on all 3 agents
SELECT slug, jsonb_typeof(autonomy_profile->'send_sms'->'promotion_thresholds') AS has_v2
  FROM public.agents ORDER BY slug;
-- expect: all 3 rows return 'object'

-- Phase 1.2 — atomic update RPC exists
SELECT proname, prosecdef FROM pg_proc WHERE proname='update_autonomy_profile_entry_v1';
-- expect: 1 row, prosecdef=true

-- Phase 1.3 — read_only_mode column exists
SELECT data_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='agents' AND column_name='read_only_mode';
-- expect: boolean

-- Phase 1.3 — toggle RPC accepts the new flag
SELECT pg_get_functiondef('public.toggle_agent_flag_v1(uuid, text, boolean)'::regprocedure)
       LIKE '%read_only_mode%' AS extended;
-- expect: t

-- Phase 1.1 — agent_actions row count (drives 1.4 charts)
SELECT count(*), min(created_at), max(created_at) FROM public.agent_actions;
-- as of 2026-05-10 this was at 2 rows; expect substantially more by the time you check

-- Phase 0.2 — action_outcomes row count (verified outcomes)
SELECT count(*), count(*) FILTER (WHERE outcome_type IS NOT NULL) AS resolved FROM public.action_outcomes;
```

**If any of those don't match, STOP and reconcile with the owner before writing 1.4 code.** The dashboard depends on the schema being current.

---

## Branch + PR conventions (battle-tested over 1.2 + 1.3)

- **Branch**: `claude/phase-1.4`. Off latest `main`. Don't reuse the 1.2 or 1.3 branches.
- **One PR**, base `main`. Owner is non-technical → keep PR description structured (Summary / What ships / Why these design choices / Tests / Test plan / Rollback). Use the same template as PR #305 and PR #306.
- **CI gate**: `build-and-test` workflow runs vitest + `npm run build`. PR cannot merge with red CI.
- **Codex auto-reviews**: Codex posts P1/P2/P3 review comments within ~2 minutes of CI starting. Address all P1/P2 in the same PR before merging — the pattern is: investigate → fix → reply on the thread with a short technical explanation referencing the fix commit SHA → push the fix. P2s on PR #305 (autonomy v2): two found, both real bugs (repeated demote on stale harmful row; concurrent `autonomy_profile` write race). P2s on PR #306 (1.3): two found, both real (read_only didn't suppress assembler reads; flag-off couldn't restore raw executor). Expect ~2 P2s on 1.4 too.
- **PR Activity subscription**: ask the user "want me to subscribe to PR activity so I can autofix CI failures and respond to Codex review comments as they come in?" — they said yes both prior PRs.
- **Commit style**: HEREDOC-passed commit messages. Always include the `https://claude.ai/code/session_…` trailer (the harness injects it). Don't sign commits with co-author lines.

## Conventions inside this codebase

- **Tests**: vitest, in `src/lib/__tests__/`. The full suite is at **3,350 passing / 3 skipped** as of 2026-05-10 (post-1.3 merge). Add specs for new utility/business logic. Migrations get a structural test that asserts shape (no DROP/DELETE, idempotent, COMMENT attached, etc.) — see `src/lib/__tests__/agentPlatformPhase13Migrations.test.js` for the pattern.
- **Migrations**: file naming `YYYYMMDDhhmmss_<phase>_<short_description>.sql`. Every migration must be additive + idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` / `COALESCE`-with-default merges). DO smoke blocks at the bottom that `RAISE EXCEPTION` on bad post-state.
- **RPCs**: SECURITY DEFINER + `SET search_path = public` + REVOKE from PUBLIC + GRANT only to `service_role` (or `authenticated` if the RPC has its own admin gate). Inputs validated with explicit `RAISE EXCEPTION ... USING ERRCODE = '22023'` for bad shape, `'P0002'` for not-found.
- **Direct table writes from authenticated**: BLOCKED on `agents`, `agent_versions`, `agent_actions` (Phase 0.5 PR B + Phase 1.1.A lockdown). Only service_role can write. UI flows go through SECURITY DEFINER RPCs.
- **Per-agent context layer**: `assembleSystemPrompt` reads situational/memory/thread layers from Supabase before the chat loop runs. **Phase 1.3 added** a skip when `manifest.read_only_mode=true` (per-Codex P2 fix). Don't re-introduce reads inside read-only mode.

---

## Open design questions for the new session

The user is non-technical. Before writing code, **use `AskUserQuestion`** to lock these. Don't decide unilaterally — the briefing/CTO posture is "discuss before major features."

### Q1 — Charting library

**No chart library is currently installed.** `package.json` has zero chart deps (no recharts, no chart.js, no d3, no Apex). Options:

- **Recharts** — most popular React chart lib, declarative, unmaintained-ish lately but battle-tested. ~140 KB gzipped.
- **Chart.js + react-chartjs-2** — imperative-wrapped-in-React, very mature, good for line/bar/donut. ~80 KB gzipped.
- **Plain SVG / inline rendering** — no new dep, but you'll be writing chart primitives by hand. Not recommended for 1.4's scope (5 distinct chart types).
- **Tremor** — opinionated React dashboard component lib (lines, bars, big-number cards). ~120 KB. Fastest to ship.

**Recommendation to lead with**: Recharts. It's the safest default for an admin dashboard with 5 chart types and no current convention. If the owner wants to keep the bundle smaller, fall back to Chart.js.

### Q2 — Page placement / routing

The existing AI Agents settings UI is a `CollapsibleCard` slotted into `src/components/AdminSettings.jsx` line 2585. The 1.4 spec says `/settings/agents/{slug}/metrics` — implying a separate route. But this app's Settings is a single in-page accordion, not a router-based settings tree (per Phase 0.5 PR A spec §9 D9: "expansion is in-page accordion rather than full-screen modal"). Options:

- **Inline expansion under the existing agent row** — new "Metrics" tab inside the `AgentManifestRow` expanded body alongside the manifest editor + version history.
- **New top-level Settings card** — "Agent Metrics" as its own CollapsibleCard, with a per-agent dropdown selector.
- **Real route** — add a React Router route at `/settings/agents/{slug}/metrics`. Breaks the existing single-page-Settings convention.

**Recommendation to lead with**: inline tab under the existing row. Matches the 0.5 spec. Lets users compare manifest + metrics side by side. Less code than a new route.

### Q3 — Time window controls

Spec says "daily / weekly / 30-day." Three buttons? A date range picker? Or three side-by-side mini-charts?

**Recommendation to lead with**: a simple segmented control (Day / Week / 30d) that swaps the chart's window. Keeps initial UX simple. Date range picker is overkill for v1.

### Q4 — Token pricing source

"Cost per verified outcome (tokens × price ÷ verified outcomes)" requires a per-model price table somewhere. Sonnet 4.5 + Haiku 4.5 prices change. Options:

- Hardcode per-model prices in a constants file (with a comment about when they were last updated).
- Add an `app_settings` row `model_prices` (JSONB) editable from Settings UI.
- Read from `agent_actions.payload` if cost is already stamped there (it isn't today).

**Recommendation to lead with**: hardcode in `src/components/agentMetrics/modelPricing.js` with a TODO comment about moving to `app_settings` in a future phase. The prices change quarterly at most; not worth the data infra now.

### Q5 — CSV export scope

"Export to CSV" — but of what? Options:

- The currently-displayed charts as flat data rows (one CSV per chart).
- The raw `agent_actions` rows for the time window.
- Both.

**Recommendation to lead with**: raw `agent_actions` rows for the time window, with the metrics columns the dashboard computes (so the user gets the same numbers they see on screen). Single CSV per export click. Use the existing `agent-actions-export` edge function (Phase 1.1.C) — it already streams NDJSON; you'll need an `&format=csv` flag or a thin adapter.

### Q6 — Data source for "drift events"

Spec mentions "drift events from the consolidation pipeline." That pipeline doesn't exist yet — Phase 0/1 didn't ship any drift detection. **Confirm with the owner whether to**:

- Defer drift to Phase 1.5 or later (recommended — there's no source data).
- Fake it with `events` rows of a hypothetical `event_type='agent_drift_detected'` (no rows exist; chart will be empty).
- Build the consolidation pipeline as part of 1.4 (scope creep — say no).

**Recommendation to lead with**: defer. Surface a "Drift events: not yet instrumented" placeholder card so the section is visible but explicitly empty.

---

## Data sources (the schema you'll be querying)

### `public.agent_actions` (Phase 1.1)

15 columns + hash chain. Service-role-write-only. Auth'd users can SELECT.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `org_id` | uuid | RLS scope |
| `agent_id` | uuid | the (recruiting / proactive_planner / inbound_router) agent |
| `agent_version` | int | manifest version at action time |
| `action_type` | text | `send_sms` / `add_note` / etc |
| `phase` | text | enum: `suggested` / `confirmed` / `executed` / `auto_executed` / `rejected` / `expired` / `shadow` |
| `entity_type` | text | `caregiver` / `client` / NULL |
| `entity_id` | uuid | nullable |
| `actor` | text | `user:<email>` / `system:automation` / `system:ai_chat` |
| `payload` | jsonb | action-specific. Phase 1.2 adds `payload.severity='harmful'` for operator-flagged demotions |
| `outcome_id` | uuid | FK to action_outcomes when applicable |
| `created_at` | timestamptz | |
| `prev_hash` | text | SHA-256 chain |
| `row_hash` | text | SHA-256 chain |
| `signature` | text | Ed25519 |
| `chain_seq` | bigint | IDENTITY, strict ordering for chain walks (use this for `ORDER BY` not `created_at` — same-millisecond rows have identical timestamps) |

**Key facts for charts:**
- For latency: NOT in this table directly. Token cost + latency live in the chat handler's `cost: { input_tokens, output_tokens, iterations, duration_ms }` return value but aren't currently persisted anywhere. **You may need to add an additive migration to capture them** — either as new columns on `agent_actions.payload` (already jsonb, no schema change needed if the dual-write call sites write them) or a separate `agent_invocations` table. Discuss with the user before adding schema.
- For suggestion volume by status: pivot the `phase` column.
- For verified-outcome rate: join `agent_actions.outcome_id` → `action_outcomes.outcome_type` (NULL = pending; non-NULL = verified one way or another).

### `public.action_outcomes` (Phase 0.2 / Phase 2)

Tracks side-effect actions and their third-party-verified outcomes.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `org_id` | uuid | |
| `agent_id` | uuid | nullable on legacy rows pre-0.4; always set going forward |
| `action_type` | text | `sms_sent` / `email_sent` / `phase_changed` / `task_completed` / etc |
| `entity_type` | text | |
| `entity_id` | text | text NOT uuid here (matches `caregivers.id`) |
| `outcome_type` | text | NULL = pending. Non-NULL: `response_received` / `no_response` / `completed` / `advanced` / `declined` / `expired` |
| `outcome_detail` | jsonb | |
| `source` | text | `automation` / `manual` / `ai_chat` |
| `metadata` | jsonb | |
| `expires_at` | timestamptz | window for the outcome to land — SMS 7d, email 7d, DocuSign 14d, calendar 21d |
| `created_at` | timestamptz | |
| `resolved_at` | timestamptz | |

### `public.agents`

Read for the per-agent dropdown. Include `kill_switch` / `shadow_mode` / `read_only_mode` so the dashboard can show a status banner when the agent is in a non-live mode (recommended: greyed-out + "agent is in shadow mode — these metrics still update" banner).

### `public.events`

Optional source for governance/audit cards (kill switch toggles, autonomy promotions). `event_type` includes `agent_flag_toggled`, `agent_autonomy_promoted`, `agent_autonomy_demoted`. Useful for an "Operations history" card.

---

## What 1.4 should NOT do

- **No new writes to `agent_actions`** (the hash chain is sacrosanct — CEO constraint).
- **No new RLS policies that gate on `is_admin()` over `user_roles` inline** (Phase 0.5 incident — see RLS_GOTCHAS.md). If you need an admin check, call `public.is_admin()` (the SECURITY DEFINER helper).
- **No new agents.** This phase only surfaces metrics for the 3 existing agents.
- **No autonomy logic changes.** Phase 1.2 owns that.
- **No drift detection pipeline.** Defer per Q6 above.
- **No mobile UI work.** Admin dashboard, desktop-first.

---

## What "done" looks like

When 1.4 ships, you should be able to:

1. Open Settings → AI Agents → expand `recruiting` → click the Metrics tab.
2. See:
   - Token spend (today / 7-day / 30-day) — input + output split, with cost in dollars.
   - Suggestion volume bar chart by status.
   - Verified-outcome rate per action_type with sparkline.
   - Cost per verified outcome (single big-number card).
   - Drift placeholder ("not yet instrumented").
3. Click "Export CSV" and get a download of the time-window's `agent_actions` rows joined to `action_outcomes`.
4. Switch the time window (Day / Week / 30d) — charts re-render.
5. Switch agent (recruiting / proactive_planner / inbound_router) — same dashboard, different data.

Owner sign-off question: "Is this agent earning its keep?" — answerable in under a minute.

---

## Process gotchas this session learned the hard way

1. **`update_agent_manifest_v1` only touches manifest fields**, not flags. Adding a new flag (read_only_mode) to the agents table didn't require a migration to the manifest RPC. Same will be true for any new operational fields you might add.
2. **The vitest harness imports TypeScript directly from `supabase/functions/...`** — no compilation step needed. You can write specs that import the Deno code in `_shared/operations/`.
3. **Codex sometimes flags real bugs the prompt didn't surface** — don't dismiss P2s as nitpicks. Both PR #305 P2s and both PR #306 P2s were real bugs that would have caused data corruption / wrong behavior in production.
4. **The user's `git push` and `git pull` commands have retry built in** — don't add your own retry loop. Just push.
5. **Run `npm test` and `npm run build` BEFORE pushing** — caught issues locally save a CI cycle. The full suite takes ~30s; the build takes ~10s.
6. **`/settings/agents/{slug}/metrics` is a path the spec uses but this app doesn't actually have route-based Settings.** See Q2 — the inline tab is the right idiom.

---

## After 1.4 ships

Phase 1.5 (retrospective grading UI) is sequential after 1.4. It depends on 1.4's UI surface for placement. Then Phase 2 (recruiting agent autonomous funnel) gates on 1.5 baked + ≥100 graded suggestions. **Don't skip 1.5** even though it feels like it could be deferred — Phase 1.2's autonomy v2 needs grades as input.

When you're done with 1.4, write a similar handoff doc for 1.5 and delete this one in the same PR.

---

## First commands the new session should run

```bash
# Confirm you're starting from clean main
git checkout main && git pull origin main
git checkout -b claude/phase-1.4

# Sanity: tests and build pass on main
npm ci
npx vitest run --no-coverage 2>&1 | tail -5  # expect 3,350 passing
npm run build 2>&1 | tail -3                 # expect "✓ built in"

# Read the required docs (above)
# Then ask the user the 6 design questions via AskUserQuestion
# Then start implementing
```

Good luck. Stay frugal with the chart library — every KB matters in `AdminApp` (already 1.66 MB).
