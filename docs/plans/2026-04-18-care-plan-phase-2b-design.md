# Care Plan — Phase 2b Design

**Status:** Design phase. Implementation plan lives in `2026-04-18-care-plan-phase-2b-plan.md`.
**Prior art:** PR #163 (rename `care_plans` → `service_plans`), PR #164 (Phase 2a — schema + read-only panel).

---

## 1. Vision

The Care Plan is the **canonical knowledge document** for each client — a living record of who they are, their health, their routines, and the care they receive. It has three audiences, each with different needs:

| Audience | What they need | How the plan serves them |
|---|---|---|
| **Admins** (office staff) | Accurate intake, publish versions, update when things change | Primary editors. See every field. |
| **Caregivers** (in-home aides) | Know what to do this shift, who this person is, what matters to them | Read-only on most fields. Have their own task list + observation logging surfaces derived from the plan. |
| **Family** (via Communication Hub) | Reassurance that their loved one is doing well — in natural, warm language, not clinical jargon | Never see raw fields. See AI-generated daily/weekly digests built from plan + caregiver observations. |

The plan is also the **input to an AI layer** that produces:
- A natural-language **intake snapshot** when the plan is first published (so an admin or caregiver can read one paragraph and understand the client)
- Ongoing **family digests** that blend the plan's "who they are" with day-to-day caregiver observations

This design goal — "can AI write a warm, accurate sentence from this field?" — is the single most important test for every field we add.

---

## 2. Why not just copy Wellsky

Wellsky's intake screens have ~20 sidebar sections, many single-field pages, heavy nesting, and a taxonomy built around billing/compliance rather than caregiving narrative. We use them as a **data reference** — the things they capture are largely the right things to capture — but their **information architecture is wrong for us** because:

1. **They optimize for compliance**, we optimize for care quality + family communication.
2. **Their sections are one-to-one with CMS forms**, ours should group information the way humans think about a person.
3. **Their fields are mostly freeform textareas**, ours need structure so AI can reason across days and families can see change over time.
4. **They have no narrative layer**, we want every section to produce narratable output.

Design principles that fall out of this:

- **Structure > freeform** whenever a sensible enum exists. Textareas only where truly needed.
- **"Why" next to "what"** where it helps AI tell a better story (e.g., mobility decline → likely cause).
- **Every save logs a change event** (`events` table, `event_type='care_plan_field_changed'`) so AI can query "what changed this week."
- **Audiences are first-class.** Every section declares its visibility tier; caregivers + family never see admin-only content.
- **Collapse > expand.** Favor fewer, richer sections over many thin ones.

---

## 3. Section taxonomy

11 editable sections + 1 AI-generated snapshot = 12 total. Visibility tiers: **A** = admin, **C** = caregiver, **F** = family (via digest only, never as raw fields).

| # | Id | Label | Tiers | Purpose |
|---|---|---|---|---|
| 0 | `snapshot` | Snapshot | A / C / F | AI-generated narrative summary of everything below. Read-only for humans. |
| 1 | `whoTheyAre` | Who They Are | A / C / F | The person, not the patient. Demographics + personal context. |
| 2 | `healthProfile` | Health Profile | A / C | Medical picture: diagnoses, medications, allergies, sensory status, functional limits. |
| 3 | `cognitionBehavior` | Cognition & Behavior | A / C | Dementia, mood, symptoms, triggers, what calms. |
| 4 | `dailyLiving` | Daily Living (ADLs) | A / C / F | Per-activity cards (ambulation, bathing, dressing, toileting, nutrition) + task list. |
| 5 | `homeAndLife` | Home & Life (IADLs) | A / C / F | Housekeeping, laundry, meal prep, medication reminders, errands/driving + task list. |
| 6 | `dailyRhythm` | Daily Rhythm | A / C / F | Routine (morning/afternoon/evening), activities, favorite places, sleep. |
| 7 | `homeEnvironment` | Home Environment | A / C | Safety, equipment/assistive devices, pets, emergency response. |
| 8 | `careTeam` | Care Team | A / C | PCP, hospital, specialists, responsible parties, emergency contacts. |
| 9 | `goalsOrders` | Goals & Orders | A / C | Care goals, safety measures, activity restrictions, DNR, prognosis, service plan link. |
| 10 | `matchCriteria` | Match Criteria | A | Caregiver matching preferences/requirements. Used by matching engine. |

**Dropped from PR #164's initial 16-section list:** `demographics`, `decisionMaking`, `healthcareProviders`, `medicalProfile`, `medications`, `functionalStatus`, `adlTasks`, `iadlTasks`, `nutrition`, `routines`, `homeSafety`, `goalsOfCare`, `servicePlan`, `snapshot` (kept but moved to index 0), plus additions of `whoTheyAre`, `healthProfile`, `cognitionBehavior`, `dailyLiving`, `homeAndLife`, `dailyRhythm`, `homeEnvironment`, `careTeam`, `goalsOrders`, `matchCriteria`.

The existing `care_plan_tasks.category` values (e.g., `adl.bathing`, `iadl.housework`) **still work** — they now route to `dailyLiving` or `homeAndLife` via the `sectionIdForCategory` helper. No data migration needed.

**Moved out of the care plan:** `payment` section → belongs in client profile, not clinical care plan. Will surface elsewhere in a later PR. Leaving a TODO comment in `ClientDetail.jsx`.

---

## 4. Per-section detail

Full field definitions live in `src/features/care-plans/sections.js` (to be expanded in this PR). Below is the design intent — what each section covers and why. Field-level specifics go in the code, not in this doc, because they'll evolve.

### Section 0 — Snapshot (AI-generated)

- One field: `narrative` (string, 2-4 paragraphs).
- Generated on-demand via "Regenerate snapshot" button in the panel header.
- Regeneration reads every other section + recent events, calls an edge function, writes to `care_plan_versions.generated_summary` and `data.snapshot.narrative`.
- **In this PR:** endpoint contract + button + loading state + result storage. Edge function returns a stub string ("Snapshot generation coming in Phase 3"). Behind a feature flag `care_plan_snapshot_ai`.

### Section 1 — Who They Are

The person as a human being. Feeds AI's voice for family narratives.

- Full name, preferred name, DOB, age (computed), gender, pronouns
- Marital status, spouse/partner name, lives with
- Languages (array), religion, attends services (bool)
- Past profession, brief life context (one freeform sentence — "retired Navy veteran, widowed 2019, grandfather of 4")
- Personal interests / hobbies (multiselect + freeform)

### Section 2 — Health Profile

The medical picture. Kept factual and structured.

- Primary diagnoses (structured list: condition + year + status)
- Other conditions (multiselect from common list + freeform)
- Most recent hospitalization (date + reason + outcome)
- Allergies (structured list: allergen + reaction severity + notes)
- **Medications** (structured list, first-class): name, dose, frequency, route, PRN flag, reason, prescriber, start date
- Sensory status: hearing (good/impaired/aided/deaf), vision (good/impaired/corrective/blind), speech (normal/impaired/nonverbal), swallowing (normal/impaired/dysphagia)
- Functional limitations (multiselect: amputation, hearing, ambulation, bowel/bladder, paralysis, speech, contracture, endurance, legally blind, dyspnea)

### Section 3 — Cognition & Behavior

Drives shift planning differently than physical health, so kept separate.

- Diagnosed disorders (freeform, multi-line)
- Dementia level (none / mild / moderate / severe / end-stage)
- Can be left alone (yes / no / short periods only) + duration if short periods
- Wanderer (yes / no) + elopement history
- Symptom checklist (multiselect: mood changes, memory loss, hallucinations, anxiety, agitation, sundowning, poor judgment, etc.)
- Triggers (freeform — what upsets them)
- What calms them (freeform — gold for family narratives + caregiver guidance)

### Section 4 — Daily Living (ADLs)

Per-activity cards, each with a consistent shape: **current ability** (structured) + **task list** (from `care_plan_tasks`) + **safety notes** (freeform).

Subsections within this section (rendered as stacked cards in the editor):

- **Ambulation & Transfers**: mobility level (independent / supervised / assist / dependent), aids used (cane/walker/wheelchair/geri-chair/scooter), fall risk (none/history/current), use of arms/hands (bilateral/left/right), gait belt used (yes/no), tasks list
- **Bathing & Grooming**: method (shower/bath/sponge), frequency, resists bathing (yes/no), uses shower bench, assistance level (independent/setup/partial/full), hygiene areas (dental/skin/nails/hair), tasks list
- **Dressing**: assistance level, upper body vs lower body differentiation, tasks list
- **Toileting & Elimination**: incontinence (none/urine/bowel/both), wears briefs, issues (constipation/diarrhea/urgency), devices (urinal/commode/catheter), tasks list
- **Nutrition & Meals**: diet type (regular/soft/pureed/low sodium/diabetic/etc.), special diet freeform, appetite (good/fair/poor), assistance with feeding, meal times (breakfast/lunch/dinner/snacks), favorite foods per meal (4 small textareas), dislikes, fluid encouragement/restriction, swallowing issues flag, tasks list

### Section 5 — Home & Life (IADLs)

Same card pattern. Subsections:

- **Housekeeping**: scope (light/heavy), frequency, task list
- **Laundry**: frequency, preferences, task list
- **Meal Prep**: cooking / preparation / feeding flags, task list
- **Medication Management**: needs reminders (y/n), who manages (client/caregiver/family/pharmacy), pill box set up (y/n, how many weeks), separate schedule sheet (y/n), task list
- **Errands & Transportation**: client drives (y/n) / needs caregiver to drive (y/n), vehicle (client's/aide's/other), errands flag, doctor's appointments flag, task list

Wellsky's "Observation" IADL is **not** included — clinical observations belong in the caregiver logging system (`care_plan_observations`), not in the plan's IADL list.

### Section 6 — Daily Rhythm

This section is *gold* for family narratives. Every field here reads warm when surfaced.

- Activities permitted (multiselect: bedrest BRP, exercises prescribed, up as tolerated, partial weight bearing, independent at home, transfer bed/chair, wheelchair, no restrictions)
- Morning routine (textarea — "waketime, coffee, meds, breakfast...")
- Afternoon routine (textarea)
- Evening routine (textarea — dinner, bedtime, night wakings)
- Activities at home (textarea — reading, board games, hobbies, music)
- Activities away from home (textarea — parks, outings, lunches)
- Favorite restaurants / shops (textarea)
- Family, friends, neighbors (textarea — who visits, who calls, who matters)
- Sleep patterns: bedtime, waketime, night wakings (freq + reason), naps

### Section 7 — Home Environment

Safety + logistics. Change-detected over time — a new loose rug is a narratable event.

- Safety checklist (Y/N + optional note per item): clutter-free stairs/walkways, adequate lighting, loose carpets/rugs, stair handrails, grab bars (shower/bathroom), security system, smoking in home, alcohol/substance use in home, pets in home, emergency response system, smoke detectors, CO detectors, fire extinguisher, signs of abuse/neglect
- Assistive devices present (multiselect: corrective lenses, hearing aids, dentures, cane, walker, wheelchair, rollator, grab bars, hospital bed, bedside commode, raised toilet seat, lift chair, oxygen, mechanical lift, ramp, other)
- Home type (house / apartment / ALF / SNF)
- Floors / stairs count
- Pets (type + count + caregiver comfort required)

### Section 8 — Care Team

Everyone involved in this person's care.

- Primary care physician (name, phone, address, email)
- Preferred hospital (name, phone)
- Home health provider (name, phone)
- Specialists (list: name, specialty, phone)
- Responsible Party — Primary (name, relationship, phone, email, address, POA flags: financial, healthcare, has HIPAA release)
- Responsible Party — Secondary (same fields)
- Emergency contacts (list: name, relationship, phone, role/notes)
- Family, friends, neighbors who support (list)

### Section 9 — Goals & Orders

The clinical "plan of care" header. CMS-485 required fields marked so a future export PR can hydrate form 485.

- Care goals (textarea — what we're helping them achieve)
- Safety measures (textarea)
- Activity restrictions (textarea)
- Start of care date (date, CMS-485)
- Prognosis (select: good / guarded / poor / unknown, CMS-485)
- DNR status (yes / no / unknown)
- Advance directive on file (yes / no / unknown)
- Service plan (link to `service_plans` row — read-only display, edit happens in ServicePlansPanel)

### Section 10 — Match Criteria

Admin-only. Drives caregiver matching. Preserves the Wellsky P/R/N ("Preferred / Required / Not-needed") pattern because it maps cleanly to our matching engine.

- Gender preference (female / male / no preference) with P/R flag
- Language required (multiselect) with P/R flag
- Experience required (dementia, hospice, incontinence, etc.) — each with P/R/N flag
- Certifications required (CNA, HHA, LVN/LPN, RN) — each with P/R/N flag
- Transfers: can handle client weight (Y/N), gait belt experience, Hoyer lift experience — each with P/R/N
- Pets: OK with cats (P/R/N), OK with dogs (P/R/N)
- Vehicle required (Y/N)
- OK with client smoking (Y/N)
- Insured automobile required (Y/N)
- OK with live-in shifts (Y/N)

---

## 5. Field type catalog

Field definitions in `sections.js` use a small set of types. Each field is `{ id, label, type, required?, cms485?, help?, placeholder?, options?, subfields?, conditional? }`.

| Type | Description | UI control |
|---|---|---|
| `text` | Single-line string | `<input type="text">` |
| `textarea` | Multi-line string | `<textarea>` |
| `date` | ISO date | `<input type="date">` |
| `number` | Numeric | `<input type="number">` |
| `select` | Single choice from `options` | `<select>` |
| `multiselect` | Multiple choices from `options` | Checkbox group or chip selector |
| `boolean` | True/false | Toggle or Y/N radio |
| `yn` | Y/N + optional note | Radio + conditional textarea |
| `phone` | Phone number | `<input type="tel">` with mask |
| `email` | Email address | `<input type="email">` |
| `list` | Array of sub-records; `subfields` defines each record's shape | Repeatable row group with add/remove |
| `prn` | Preferred / Required / Not-needed flag | Three-state pill |
| `levelPick` | Ability level: independent / setup / partial / full | Segmented control |

Any field can set `cms485: true` to mark it for the future CMS-485 export. The editor shows a small badge on those fields; export lives in a later PR.

---

## 6. Visibility tiers

Section-level only (field-level was considered and rejected as over-engineered for now).

- `tiers: ['admin']` — admin-only, hidden from caregiver portal and family digest prompts
- `tiers: ['admin', 'caregiver']` — admin-edit, caregiver read-only
- `tiers: ['admin', 'caregiver', 'family']` — same as above, plus AI may quote/paraphrase in family digests

The `tiers` array is defined on the section in `sections.js`. The caregiver portal (Phase 2d) filters sections by `tiers.includes('caregiver')`. The family digest AI prompt (Phase 3) only includes sections with `tiers.includes('family')`.

**RLS stays admin-only for this PR.** Caregiver-scoped SELECT policies are deferred to Phase 2d where they can be built alongside the caregiver UI.

---

## 7. AI snapshot contract

Shipping the contract now so section design is pressure-tested against "can AI produce a family-readable sentence from this?"

**Endpoint:** `POST /functions/v1/care-plan-snapshot`

**Request:**

```jsonc
{
  "versionId": "uuid",
  "regenerate": false  // if true, overwrites existing snapshot
}
```

**Response:**

```jsonc
{
  "narrative": "string — 2-4 paragraphs, warm tone, family-appropriate",
  "model": "claude-sonnet-4-6",
  "generatedAt": "ISO timestamp",
  "tokensUsed": 1234
}
```

**Behavior:**

- Reads version + all sections + tasks from the DB
- Builds a prompt that instructs the model to write warm, accurate, family-readable prose
- Only uses sections with `tiers.includes('family')`
- Writes result to `care_plan_versions.generated_summary` and to `data.snapshot.narrative`
- Logs an event: `event_type='care_plan_snapshot_generated'`

**This PR ships:**
- Edge function scaffold at `supabase/functions/care-plan-snapshot/index.ts`
- Stub implementation returns a canned string ("Snapshot generation coming in Phase 3")
- Feature flag `care_plan_snapshot_ai` (env var) gates the button's visibility
- Frontend wiring: button in panel header, loading state, optimistic update

Actual Claude integration + prompt engineering is deferred to Phase 3 where it can be iterated on with real data.

---

## 8. Schema scaffolding for future phases

To avoid painting into a corner, #2b adds two new tables **with schema only, no UI**. This is a small, additive migration that unblocks Phases 2d and 3 without requiring another schema change later.

### `care_plan_observations`

Caregiver-logged observations during a shift. One row per observation.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `care_plan_id` | uuid FK → `care_plans.id` | |
| `version_id` | uuid FK → `care_plan_versions.id` | the active version when logged |
| `task_id` | uuid FK → `care_plan_tasks.id` nullable | if observation is about a specific task |
| `shift_id` | uuid FK → `shifts.id` nullable | which shift this was logged during |
| `caregiver_id` | text FK → `caregivers.id` | |
| `observation_type` | text enum | `task_completion`, `mood`, `concern`, `positive`, `vital`, `general` |
| `rating` | text nullable | `done`, `partial`, `not_done`, or mood scale, etc. — shape depends on type |
| `note` | text | freeform details |
| `logged_at` | timestamptz default now() | |
| `created_at` / `updated_at` | timestamptz | standard |

RLS: admins can read all; caregivers can insert their own + read their own. No UI in this PR — just the table.

### `care_plan_digests`

AI-generated family-facing summaries.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `care_plan_id` | uuid FK → `care_plans.id` | |
| `client_id` | text FK → `clients.id` | denormalized for family hub queries |
| `period_type` | text enum | `daily`, `weekly`, `monthly`, `adhoc` |
| `period_start` / `period_end` | timestamptz | |
| `narrative` | text | the human-readable summary |
| `highlights` | jsonb | `[{text, ...}]` — positive moments |
| `concerns` | jsonb | `[{text, severity, ...}]` — things to flag |
| `model` | text | which model generated it |
| `generated_at` | timestamptz | |
| `delivered_to_family_at` | timestamptz nullable | when it was surfaced in the hub |
| `created_at` / `updated_at` | timestamptz | standard |

RLS: admins only for now. Family portal reads (Phase 3) will add scoped policies.

### No change-log table

Field-change history is handled by the existing `events` table with `event_type='care_plan_field_changed'` and payload `{section, field, old, new, versionId}`. Every `saveDraft` emits one event per changed field. No new table needed.

---

## 9. Out of scope for #2b

Explicitly deferred:

- **Caregiver-side view of the care plan** — Phase 2d. Includes caregiver-facing layout, RLS policies for caregiver read access, and observation logging UI.
- **Observation logging UI** — Phase 2d. Schema ships here; UI ships there.
- **Family digest generation + Family Communication Hub** — Phase 3. Schema ships here; everything else later.
- **Actual AI snapshot generation** — Phase 3. Contract + stub ship here.
- **iPad intake wizard** — Phase 2c. Uses the same schema and field defs, just a different UI shell.
- **CMS-485 form export** — future PR. Fields are marked but no export logic.
- **Archive / restore UI** for old versions — future. Schema supports it; UI deferred.
- **Advanced version compare / diff view** — future.
- **DocuSign integration** — typed-name signatures only, per user preference.

---

## 10. Open questions (for follow-ups, not blockers)

1. **Snapshot regeneration cost control.** If an admin mashes "Regenerate snapshot" repeatedly, we burn tokens. Add a 60-second cooldown button state? Log cost per generation? Punt to Phase 3 unless it becomes a problem.
2. **Version branching.** Current schema supports linear versioning (v1, v2, v3). No branching / what-if scenarios. Fine for now.
3. **Bulk import from Wellsky.** Not planned but worth keeping in mind — field shapes should be close enough that a CSV or API import could map cleanly.
4. **Caregiver-specific plan views.** Should caregivers see a "this shift" view that's filtered to just relevant sections (e.g., for a morning shift, show morning routine + AM medications + breakfast tasks)? Phase 2d design question.

