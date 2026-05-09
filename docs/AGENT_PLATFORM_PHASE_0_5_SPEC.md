# Agent Platform — Phase 0.5 spec

**Phase**: 0.5 — Settings UI for agent manifest editing
**Status**: Spec only. No implementation in this PR.
**Implementation gate**: cleanup PR #291 baked ≥ 7 days. Earliest implementation start: **2026-05-17** (cleanup merged 2026-05-09; gate is calendar-driven for this phase because we're touching live agents).
**Bake gate before Phase 1**: 0.5 shipped and baked ≥ 7 days.

This document is the implementation contract for Phase 0.5. It does **not** restate strategic decisions — those live in `docs/AGENT_PLATFORM_VISION.md` ("Strategic decisions locked"). It does not restate the high-level phase description — that lives in `docs/AGENT_PLATFORM.md` → "Phase 0.5". Read both before this doc.

The doc closes with a sign-off gate (§9) listing decisions the owner must lock before implementation begins.

---

## 1. Goals & non-goals

### Goals

1. An admin (logged-in user with `user_roles.role = 'admin'`) can flip `kill_switch` and `shadow_mode` on any of the three production agents from a Settings panel, no deploy.
2. An admin can edit `system_prompt`, `tool_allowlist`, `autonomy_profile`, `context_recipe`, `model`, and `max_iterations` on any agent. Each save increments `agents.version`, writes a snapshot row to `agent_versions`, and requires a confirmation dialog with a diff preview.
3. An admin can view the version history for any agent and revert to a prior version. Revert creates a new version (N+1) with the prior version's content — never edits or deletes a historical row.
4. Concurrent edits from two admins do not silently overwrite each other.
5. Every save and revert is captured in `agent_versions` with `changed_by` populated from the JWT.
6. The runtime continues to behave correctly on a mid-flight `kill_switch` flip — the existing defense-in-depth check inside `runAgent` already covers this; the UI just needs to communicate it clearly.

### Non-goals

- **No new manifest fields.** Schema is set as of Phase 0.1 (see `supabase/migrations/20260502000000_agent_platform_phase_0_1_agents_table.sql`). Phase 0.5 only edits what's already there.
- **No new agents.** Phase 0.5 edits the three seeded agents (`recruiting`, `proactive_planner`, `inbound_router`). Adding a new agent is out of scope; it lives in Phase 2+ when each new agent ships behind its own manifest seed migration.
- **No autonomy_profile wrapped UI.** Per VISION doc, the wrapped UI lands in Phase 1.4. Phase 0.5 ships raw JSON editing for `autonomy_profile` and `context_recipe`.
- **No hash-chain / Ed25519 signing of `agent_versions`.** That's Phase 1.1 (`agent_actions`).
- **No markdown-mirror prompt files in `docs/agent-prompts/`.** Per VISION doc — locked to (a) "column is authoritative." Markdown mirrors deferred until/unless a customer asks for PR-review on prompt changes.
- **No `ai_suggestions` per-agent filter UI.** That's mentioned in `docs/AGENT_PLATFORM.md:724` as part of Phase 0.5 but functionally belongs to the human-in-the-loop UI (`AISuggestionsCenter` / equivalent), not the manifest editor. Splitting it into its own ticket keeps this PR focused. **Decision needed (§9 D7).**

---

## 2. Schema verification

The Phase 0.1 migration is sufficient for everything Phase 0.5 does. No schema changes needed. Confirming the relevant columns:

### `public.agents` (defined: `20260502000000_agent_platform_phase_0_1_agents_table.sql`)

| Column | Type | Edited by Phase 0.5 UI? | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `org_id` | uuid | no | RLS scope |
| `slug` | text | no | Stable identifier; uniqueness `(org_id, slug)`. Renaming an agent in this UI is out of scope. |
| `name` | text | **yes** | Display name (e.g. "Recruiting Agent") |
| `version` | integer | no (incremented by save) | CHECK ≥ 1 |
| `system_prompt` | text | **yes** | CHECK length > 0 |
| `tool_allowlist` | text[] | **yes** | Subset of registry tool names |
| `autonomy_profile` | jsonb | **yes** | Raw JSON in 0.5 (wrapped UI deferred to Phase 1.4) |
| `context_recipe` | jsonb | **yes** | Raw JSON; assembler doesn't honor `enabledLayers` yet, but the field is editable for future-proofing |
| `model` | text | **yes** | Free-text — the manifest already accepts e.g. `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`. **Decision needed (§9 D2).** |
| `max_iterations` | integer | **yes** | CHECK ≥ 1 |
| `kill_switch` | boolean | **yes** | Single-toggle save (no version increment) |
| `shadow_mode` | boolean | **yes** | Single-toggle save (no version increment) |
| `outcome_definition` | jsonb | edge case | Phase 1.x metrics dashboard reads this. Editable in 0.5 for completeness. **Decision needed (§9 D6).** |
| `triggers` | jsonb | no | Cron schedules + invocation modes; tightly coupled to deployed cron jobs. Editing this from the UI without redeploying the cron entries is dangerous. **Read-only display in 0.5.** |
| `created_at`, `updated_at` | timestamptz | no | `updated_at` trigger already in place (`tg_agents_set_updated_at`) |
| `created_by`, `updated_by` | text | no (auto) | Set on save from JWT |

Constraints and indexes already in place:
- UNIQUE `(org_id, slug)` — agents_slug_per_org_unique
- CHECK `version >= 1`, CHECK `max_iterations >= 1`, slug regex, model nonempty, system_prompt nonempty
- Index `idx_agents_org_id`, `idx_agents_slug`, `idx_agents_kill_switch (org_id, kill_switch) WHERE kill_switch = false` (kill-switch-on agents are rare; the partial index keeps the hot lookup fast)
- RLS strict / fail-closed: `org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid`

### `public.agent_versions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `org_id` | uuid | RLS scope |
| `agent_id` | uuid FK CASCADE | |
| `agent_slug` | text | Denormalized for forensics if `agents` row vanishes |
| `version` | integer | UNIQUE `(agent_id, version)` |
| `snapshot` | jsonb | Full agents row minus `created_at`/`updated_at` (per the seed: `to_jsonb(a) - 'created_at' - 'updated_at'`) |
| `change_summary` | text | Human-typed summary, optional but encouraged in UI |
| `changed_by` | text | From JWT (e.g. `user:184e7230-...`) |
| `changed_at` | timestamptz | |

**No DB-side trigger writes to `agent_versions` on `agents` UPDATE.** This is intentional — the application owns the snapshot transaction so the diff/save flow can:
1. Read current row (under lock or with version match),
2. Validate the input,
3. Write `agent_versions` row with prior snapshot OR new snapshot — see §3.4 below for the chosen approach,
4. UPDATE `agents` (incrementing `version`),

all in one transaction. A DB trigger that auto-snapshotted on every UPDATE would also fire on the no-op `kill_switch` toggles, creating noise.

### Proposed Phase 0.5 helper RPC

A single Postgres function, `public.update_agent_manifest_v1`, is called from the UI. It:
- Takes `(p_agent_id uuid, p_expected_version int, p_updates jsonb, p_change_summary text)`,
- Verifies `agents.version = p_expected_version` (optimistic lock),
- Writes the **new** snapshot to `agent_versions` (after applying updates), incrementing version,
- Updates `agents` with the new manifest values,
- Returns the new version number,
- All inside a transaction.

Optimistic lock is enforced by a `WHERE id = ? AND version = ?` clause; if zero rows match, the function raises `agent_version_conflict` (sqlstate `'P0001'`) and the UI surfaces a "another admin saved version N+1, refresh and retry" dialog. **Decision needed (§9 D3).**

A second RPC `public.toggle_agent_flag_v1(p_agent_id, p_flag, p_value)` handles the immediate `kill_switch` / `shadow_mode` toggles without touching `version` — these are operational levers, not manifest edits. Per the design intent that toggles are "single-click" and don't need confirmation, they don't write to `agent_versions`. **Decision needed (§9 D4).**

A third RPC `public.revert_agent_to_version_v1(p_agent_id, p_target_version, p_change_summary)` handles revert. It loads the target snapshot, applies it as the new content (excluding non-revertable fields like `id`, `org_id`, `slug`, `kill_switch`, `shadow_mode`, version metadata), increments version, and writes a new `agent_versions` row marked with `change_summary = "Reverted to version N"`.

All three RPCs run with `SECURITY DEFINER` and explicit role checks against `user_roles.role = 'admin'`. RLS on `agents`/`agent_versions` is org-scoped — the RPC must verify the JWT org_id matches the agent's org_id before writing. (The same pattern as the payroll-export-run flow.)

---

## 3. Behavior contract (per-action)

### 3.1 Kill switch toggle

- **Trigger**: admin clicks toggle in agent list row OR detail view header.
- **Saved immediately**: no confirmation dialog.
- **Effect on running invocations**: the existing `runAgent()` loads the manifest at the start of every invocation and checks `kill_switch`. If a cron agent is mid-flight when the flip happens, the next iteration of its tool-use loop hits the killed manifest. The chat agent picks up the new value on the next request (no in-flight chat session is gradient-killed mid-loop, but pending requests will see it). **No behavior change from Phase 0.4.**
- **UI feedback**: optimistic update + toast. On failure, revert and show error.
- **Audit**: written to `events` table (event_type = `agent_kill_switch_toggled`, payload = `{flag: 'kill_switch', value: true|false, prior_value: ...}`, agent_id stamped). **Decision needed (§9 D5).** Not written to `agent_versions` (operational lever, not manifest change).

### 3.2 Shadow mode toggle

Identical to kill switch, but for `shadow_mode`. The runtime behavior is already implemented (Phase 0.3): when `shadow_mode=true`, every would-be side-effect routes to `ai_suggestions` with `status='shadow'` instead of executing. UI surfaces the warning "Shadow mode: this agent's actions will be staged for review, not executed."

### 3.3 Manifest field edit (system_prompt, tool_allowlist, autonomy_profile, context_recipe, model, max_iterations, name, outcome_definition)

- **Trigger**: admin clicks "Edit" on the detail view, modifies fields, clicks "Save".
- **Validation**:
  - `system_prompt`: nonempty (CHECK constraint).
  - `tool_allowlist`: each entry must be a known tool name. The full registry of valid tools is the union of registered tools across the three current agents; we expose this as a query against `getToolDefinitions()` from each shell. **Decision needed (§9 D1.**
  - `autonomy_profile`: valid JSON, must be an object. Each key should be a string action name; each value an object with at least `current_level` ∈ `{L1, L2, L3, L4}`. Validation is best-effort in 0.5 (Phase 1.2 hardens this with the v2 promotion algorithm).
  - `context_recipe`: valid JSON, must be an object. No deeper validation in 0.5.
  - `model`: nonempty string. Optionally validated against an allowed-models list. **Decision needed (§9 D2).**
  - `max_iterations`: integer ≥ 1.
  - `name`: nonempty.
  - `outcome_definition`: valid JSON, must be an object.
- **Confirmation dialog** opens on Save with a per-field diff. See §4 for diff format.
- **On confirm**: the UI calls `update_agent_manifest_v1(p_agent_id, p_expected_version, p_updates, p_change_summary)`.
- **On version conflict** (`P0001 agent_version_conflict`): the UI shows "Version conflict: another admin saved version {N}. Reload and re-apply your changes." with a "Reload" button. The unsaved edits are preserved in local state until the admin reloads.
- **On success**: the UI refreshes the agent detail view and shows a toast `"Saved as version {N+1}"`.
- **On failure** (validation, RLS, runtime): error surfaced inline; nothing written.
- **Audit**: `agent_versions` row inserted by the RPC. `events` row optional; the version history table is the canonical audit trail.

### 3.4 Snapshot semantics — what the snapshot represents

The Phase 0.1 seed wrote each agent's initial state as a "version 1" snapshot (`Initial seed (Phase 0.1)`). The convention: the snapshot in row `version=N` represents the agent's state at version N. So:

| Update | New `agents.version` | New `agent_versions` row | Snapshot content |
|---|---|---|---|
| Save manifest edit | N → N+1 | version N+1 | The post-edit state (i.e. matches `agents` after the update) |
| Revert to version K | current → current+1 | version current+1 | The same content as `agent_versions` row K, but with version = current+1 |

This means `agent_versions` is a **forward-looking** record: row N reflects the state when version became N. To compute a diff between two adjacent versions, the UI loads both snapshots and renders the difference. To compute a diff between the current edit form and the live state, the UI loads only the current `agents` row.

### 3.5 Revert action

- **Trigger**: admin clicks "Revert" button on a row in the version history view.
- **Confirmation dialog**: shows a diff between current `agents` state and the target version's snapshot. "This will create version {N+2} with the content of version {K}."
- **`change_summary` defaults to** `"Reverted to version {K}"`. Editable.
- **RPC call**: `revert_agent_to_version_v1(p_agent_id, p_target_version, p_change_summary)`.
- **Excluded fields** (revert does not change these even if the historical snapshot has a different value):
  - `id`, `org_id`, `slug`, `created_at`, `created_by` — identity/lineage
  - `kill_switch`, `shadow_mode` — operational levers, not manifest content
  - `version`, `updated_at`, `updated_by` — managed by the RPC
- **Result**: a new `agent_versions` row at version current+1 with the reverted content. The historical row at K stays exactly as it was.

---

## 4. Diff format

For the confirmation dialog and revert preview:

| Field | Diff style |
|---|---|
| `system_prompt` | Line-level unified diff (red/green like a code review). |
| `name`, `model` | Inline before/after on a single line. |
| `max_iterations` | Inline before/after. |
| `tool_allowlist` | Two-column list with added/removed indicators. |
| `autonomy_profile`, `context_recipe`, `outcome_definition` | JSON property diff: render as a tree, highlight changed keys, expand subtrees with deeper changes. Alternatively (simpler), render canonical JSON.stringify(obj, null, 2) on both sides and unified-diff that. **Decision needed (§9 D8).** |

The diff renderer is a pure function (`renderManifestDiff(current, proposed)`); it accepts the two row objects and returns React elements. Vitest covers it with snapshot tests.

---

## 5. UI mockups

### 5.1 Agent list view

Rendered as a `SettingsCard` titled "AI Agents" inside `AdminSettings` (slot it between `AutonomySettings` and `BusinessContextSettings` so per-agent autonomy lives next to global autonomy). Three rows, one per agent:

```
┌────────────────────────────────────────────────────────────────────────┐
│ AI Agents                                                              │
│ Edit per-agent manifests, kill switches, and version history.          │
├────────────────────────────────────────────────────────────────────────┤
│ Recruiting Agent              [v1]  ●live    [ Kill ]  [ Shadow ]   ▸ │
│ recruiting · 40 tools · sonnet-4.5                                     │
│                                                                        │
│ Proactive Planner             [v1]  ●live    [ Kill ]  [ Shadow ]   ▸ │
│ proactive_planner · 10 tools · sonnet-4.5 · cron 0 14 * * *            │
│                                                                        │
│ Inbound Message Router        [v1]  ●live    [ Kill ]  [ Shadow ]   ▸ │
│ inbound_router · 14 tools · haiku-4.5                                  │
└────────────────────────────────────────────────────────────────────────┘
```

- `[v1]` chip — current version. Clicking it scrolls to version history within the detail view.
- `●live` / `●dormant` / `●shadow` indicator — single dot, color-coded.
- `[ Kill ]` / `[ Shadow ]` — toggle buttons (state-aware). Live toggles, no confirm.
- `▸` chevron — expands into the detail view (in-page accordion or modal — **decision needed §9 D9**).

### 5.2 Agent detail view

When expanded, the row reveals an editor:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Recruiting Agent                                              [Save…]  │
│ slug: recruiting · org: Tremendous Care · version 1 · last edit: —     │
├────────────────────────────────────────────────────────────────────────┤
│ Display name:  ┌──────────────────────────────┐                        │
│                │ Recruiting Agent              │                       │
│                └──────────────────────────────┘                        │
│                                                                        │
│ Model:         ┌──────────────────────────────┐                        │
│                │ claude-sonnet-4-5-20250929   │  (or dropdown — D2)    │
│                └──────────────────────────────┘                        │
│                                                                        │
│ Max iterations:  ┌─────┐                                               │
│                  │  5  │                                               │
│                  └─────┘                                               │
│                                                                        │
│ System prompt:                                            [Edit ↗]     │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ You are the Tremendous Care AI Assistant — a smart recruiter ... │   │
│ │ ...                                                              │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│ Tool allowlist (40 of N tools):                          [Edit ↗]     │
│ ☑ search_caregivers   ☑ get_caregiver_detail  ☑ get_pipeline_stats    │
│ ☑ list_stale_leads    ☑ check_compliance      ☑ add_note              │
│ ☐ search_clients      ...                                              │
│                                                                        │
│ Autonomy profile (raw JSON):                              [Edit ↗]     │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ {                                                                │   │
│ │   "search_caregivers": {"current_level": "L4"},                  │   │
│ │   ...                                                            │   │
│ │ }                                                                │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│ Context recipe (raw JSON):                                [Edit ↗]     │
│ ...                                                                    │
│                                                                        │
│ Triggers (read-only):                                                  │
│   invocation_modes: chat, briefing, confirmed_action                   │
│   http_endpoint: /functions/v1/ai-chat                                 │
│   cron: —                                                              │
│                                                                        │
│ Outcome definition (raw JSON):                            [Edit ↗]     │
│ ...                                                                    │
│                                                                        │
│ ▸ Version history (1)                                                  │
└────────────────────────────────────────────────────────────────────────┘
```

`[Edit ↗]` per field opens a modal (or expands inline) with a textarea / multi-select / number input as appropriate. Saving the modal stages the change locally; clicking the top-level `[Save…]` button opens the unified diff confirmation dialog and (on confirm) issues the RPC call.

`Triggers` is read-only display because mutating it without redeploying cron entries causes drift. A dedicated trigger-management UI is Phase 1+ work.

### 5.3 Version history

Expanding the version history accordion reveals a table:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Version  Date              Author      Summary              Actions    │
├────────────────────────────────────────────────────────────────────────┤
│   v3     2026-05-22 10:15  user:Kevin  Added send_email...  [Diff] [Revert] │
│   v2     2026-05-19 14:02  user:Kevin  Tightened L1 → L2... [Diff] [Revert] │
│   v1     2026-04-30 18:00  system      Initial seed (P 0.1) [Diff] [—]      │
└────────────────────────────────────────────────────────────────────────┘
```

- `[Diff]` opens a modal showing version K vs K-1 (or vs current state, switchable).
- `[Revert]` opens the revert confirmation dialog. Disabled on the current version row.
- `[—]` (no revert) on version 1 because reverting to your own initial state is a no-op.

---

## 6. Component breakdown

All under `src/components/agentManifest/` (new directory):

| File | Purpose |
|---|---|
| `AgentManifestSettings.jsx` | Top-level component, exported and slotted into `AdminSettings.jsx` between `AutonomySettings` and `BusinessContextSettings`. Lists the 3 agents, manages expanded-row state. |
| `AgentManifestRow.jsx` | One row in the list. Displays agent header chip, status indicators, kill/shadow toggles, expand chevron. |
| `AgentManifestEditor.jsx` | Detail view shown when a row is expanded. Renders all editable fields, manages local edit state. |
| `ManifestFieldEdit.jsx` | Per-field edit modal (textarea for prompt, multi-select for allowlist, JSON textarea for autonomy/context/outcome, number input for max_iterations, etc.). |
| `ManifestDiff.jsx` | Pure renderer: takes `(current: AgentRow, proposed: AgentRow) → React element`. Used in the save confirmation dialog and revert preview. |
| `AgentVersionHistory.jsx` | Accordion table of `agent_versions` rows. Includes Diff button (opens `ManifestDiff` against version K-1 or current) and Revert button. |
| `RevertConfirmationDialog.jsx` | Dialog for revert action. Shows diff, edit-able change summary field. |
| `SaveConfirmationDialog.jsx` | Dialog for manifest save. Shows diff of current vs proposed, edit-able change summary field. |
| `useAgents.js` (hook) | Loads agents row-by-slug; reuses existing supabase query helpers. |
| `useAgentVersions.js` (hook) | Loads `agent_versions` for one agent_id, ordered by version DESC. |
| `useUpdateAgent.js` (hook) | Mutation that calls `update_agent_manifest_v1` RPC. |
| `useToggleAgentFlag.js` (hook) | Mutation that calls `toggle_agent_flag_v1` RPC. |
| `useRevertAgent.js` (hook) | Mutation that calls `revert_agent_to_version_v1` RPC. |

DB-layer helpers live in:
- `src/lib/queries/agents.js` (new) — typed wrappers for `get_agents`, `get_agent_versions`, plus the three RPC calls.

Migration:
- `supabase/migrations/2026XXXXXXXXXX_phase_0_5_agent_manifest_rpcs.sql` — defines `update_agent_manifest_v1`, `toggle_agent_flag_v1`, `revert_agent_to_version_v1`, with `SECURITY DEFINER` and admin-role checks. `+_rollback/...down.sql` drops them.

The new RPCs are the sole write path the UI uses. Direct INSERT/UPDATE on `agents` from the frontend remains blocked by the strict RLS UPDATE policy (which gates on `org_id` only — so client-side updates would technically pass for same-org rows; the RPCs add the admin-role gate and the version-conflict check). **The frontend should not issue raw UPDATE on `agents`** even though RLS allows it; this is a conventional discipline reinforced by code review.

---

## 7. Test plan

### Unit (Vitest, ~30-40 specs total)

- `ManifestDiff` renders correctly for: prompt diff with no changes, prompt diff with line additions, prompt diff with line removals, mixed; tool allowlist diff (added, removed, no change); JSON diff variants.
- Validators: `validateAutonomyProfile`, `validateContextRecipe`, `validateToolAllowlist` cover happy path + each rejection mode.
- Hooks: mocked supabase mutation succeeds; on `P0001` error, hook surfaces version conflict; on RLS error, hook surfaces "permission denied".
- RPC contract tests in `agentManifestRpcs.test.js` (mirrors the migration test pattern from Phase 0.1 / 0.2): verify the migration creates the three functions with the right signatures and `SECURITY DEFINER` mode.

### Integration (one specs in `agentManifestE2E.test.js`)

End-to-end save flow:
1. Mock supabase RPC layer.
2. Render `<AgentManifestEditor agent={recruiting} />`.
3. User types into prompt textarea → save.
4. SaveConfirmationDialog appears with diff.
5. User confirms.
6. Assert RPC called with the right args.
7. Refetch returns version=2; assert UI shows v2 chip.

### Manual smoke (pre-merge checklist on staging or preview)

- [ ] Flip kill_switch on `proactive_planner`. Verify next cron tick is skipped (check `events` for absence of `ai_planner` invocation).
- [ ] Flip kill_switch off. Verify next cron tick runs.
- [ ] Edit `system_prompt` on `recruiting`. Verify confirmation dialog shows diff, version increments to 2 on save, history shows v2 row.
- [ ] Two-tab concurrent edit: edit prompt in tab A, edit prompt in tab B without reloading; save in A first; save in B should hit version conflict, show reload dialog. After reload, B re-applies changes and saves to v3.
- [ ] Revert recruiting v1 → produces v3 with v1 content. Verify history shows v3 with summary "Reverted to version 1".
- [ ] Verify non-admin user sees "Settings unavailable" or the AgentManifestSettings card is not rendered.
- [ ] On the chat shell, after editing the system prompt and saving, the next chat invocation uses the new prompt (validates `runAgent` reads the manifest at invocation time, not at module load).

---

## 8. Slicing plan

Two PRs (recommended):

### PR A — read-only foundation + toggles
- Migration: `toggle_agent_flag_v1` RPC.
- Components: `AgentManifestSettings`, `AgentManifestRow`, read-only `AgentManifestEditor` (no edit modals yet), kill/shadow toggle wires, version history accordion (read-only — no diff or revert yet).
- Tests: hooks for `useAgents`, `useAgentVersions`, `useToggleAgentFlag`. Smoke: kill switch flip works.
- Risk surface: tiny. The `kill_switch` and `shadow_mode` columns are already honored by `runAgent` (Phase 0.3); we're just exposing them in the UI.

### PR B — full manifest editing + revert
- Migration: `update_agent_manifest_v1` + `revert_agent_to_version_v1` RPCs.
- Components: `ManifestFieldEdit`, `ManifestDiff`, `SaveConfirmationDialog`, `RevertConfirmationDialog`, full editor wires, hooks for `useUpdateAgent` and `useRevertAgent`.
- Tests: diff renderer snapshots, validators, integration save-flow test, version-conflict path.
- Risk surface: medium. This is the first UI that mutates the agent manifest live. The agents are seeded with `kill_switch=false`, so editing the recruiting prompt and saving immediately changes Kevin's daily-driver chat behavior. **Pre-merge requirement: enable `shadow_mode` on the agent being edited during smoke tests, then disable.**

**Why two PRs (not one):**
- PR A is genuinely low-risk (read-only + toggles, both already DB-wired). It can ship and bake on its own, giving us a 3-4 day signal that the read path is correct before we ship write paths.
- The bake gate to Phase 1 is "0.5 shipped + 7 days." If PR A merges and bakes for 4 days while PR B is in review, the total Phase 0.5 timeline doesn't lengthen — both PRs can be in flight overlapping.
- Risk asymmetry: a bug in PR A surfaces as "the list view crashes" — annoying, no production impact. A bug in PR B can write a malformed `system_prompt` to a live agent. Splitting puts the risky write path in a smaller, more reviewable diff.

If the owner prefers a single PR for simplicity, I'd argue against — but it's a defensible call. **Decision needed (§9 D10).**

---

## 9. Sign-off — decisions needed before implementation

The following must be locked by the owner before PR A starts. Most are small UX or implementation choices; a few are architecturally significant.

| ID | Decision | Recommendation | Notes |
|---|---|---|---|
| **D1** | How to populate the tool-allowlist multi-select universe? | **Hard-code the union of currently-registered tools per agent into a const, validated against the registry on each save.** | Dynamic registry queries from the frontend would require adding a registry-introspection edge function. Hard-coding is fine for 0.5 (3 agents); when Phase 2+ adds new agents, we revisit. |
| **D2** | Free-text `model` input or curated dropdown? | **Free-text with a non-blocking warning if the model isn't in the known-good list.** | Curated dropdown means a config update + redeploy when Anthropic ships a new model. Free-text gives ops flexibility; the warning catches typos. |
| **D3** | Optimistic locking on save: version conflict on mismatch, OR last-write-wins? | **Optimistic lock with conflict surface.** Recommended unequivocally — last-write-wins on a manifest editor with audit trail is unsafe. | Conflict UX must be obvious and recoverable (preserve unsaved edits + reload). |
| **D4** | Should `kill_switch` / `shadow_mode` toggles write to `agent_versions`? | **No.** They're operational levers, not manifest content. Audit them via `events` instead. | Otherwise version churns every time someone tests by toggling. |
| **D5** | Should `kill_switch` / `shadow_mode` toggles write an `events` row? | **Yes.** event_type = `agent_flag_toggled`, agent_id stamped. | Cheap audit, helps when investigating "why did the cron go silent at 3pm." |
| **D6** | Is `outcome_definition` editable in Phase 0.5? | **Yes, raw JSON.** The Phase 1.x metrics dashboard reads this. Editing it pre-1.x is harmless because no consumer reads it yet. | If we wait until Phase 1.x, we'd need to pop a follow-up PR mid-phase. |
| **D7** | Add `ai_suggestions` per-agent filter to existing AISuggestionsCenter? | **Defer to a separate PR after 0.5.** It's mentioned in PLAN doc as 0.5 scope but functionally lives in the suggestions UI, not the manifest editor. Splitting keeps both diffs focused. | If owner prefers to bundle, add it to PR B (small ~50 line diff in the suggestions filter). |
| **D8** | JSON diff style for `autonomy_profile` / `context_recipe` / `outcome_definition`? | **Canonical-JSON unified diff** (simpler to ship). Tree-style JSON diff is nicer but ~3x more code to build right. | Phase 1.4 wraps these in a typed UI anyway, so the raw-JSON diff is short-lived. |
| **D9** | Detail view UX: in-page accordion or full-screen modal? | **In-page accordion** matching AutomationSettings / ActionItemRuleSettings pattern in `AdminSettings.jsx`. | Consistent with the rest of the settings page. |
| **D10** | One PR or two (PR A read-only + toggles, PR B full edit + revert)? | **Two PRs.** Risk asymmetry and bake compression argue for splitting. | Owner can override; if so, single PR is fine but the diff will be ~600 lines. |

---

## 10. References

- `docs/AGENT_PLATFORM_VISION.md` → "Strategic decisions locked" → "Refactor, don't rebuild" + "Kill switch + shadow mode per (agent × org), without a deploy."
- `docs/AGENT_PLATFORM.md` → "Phase 0.5 — Settings UI for agent manifest editing"
- `docs/AGENT_PLATFORM_STATUS.md` → "Phases" table → row 0.5
- `supabase/migrations/20260502000000_agent_platform_phase_0_1_agents_table.sql` — schema source of truth
- PR #240 — `agents` + `agent_versions` introduced
- PR #254 — Phase 0.4 cutover (the surface this UI controls)
- PR #291 — Phase 0.4 cleanup (closed the rollback path; manifest is now the only behavior surface)
