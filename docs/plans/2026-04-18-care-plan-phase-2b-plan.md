# Care Plan — Phase 2b Implementation Plan

**Design doc:** `2026-04-18-care-plan-phase-2b-design.md` (read first).
**Branch:** `claude/care-plan-editor-phase-2b`
**Stacked on:** `main` (PR #164 already merged)
**Target PR:** #165 (or whatever next number)

---

## Summary of work

Turn the read-only care plan panel from PR #164 into an editable one with proper field definitions, drawer-based section editing, task CRUD, typed-name publish flow, and AI snapshot contract (stubbed). Also adds two scaffolding tables (`care_plan_observations`, `care_plan_digests`) for Phase 2d / Phase 3 without shipping their UIs.

---

## Files — new

| File | Purpose |
|---|---|
| `supabase/migrations/20260420010000_care_plan_observations_and_digests.sql` | Schema for observations + digests tables + RLS |
| `supabase/functions/care-plan-snapshot/index.ts` | Stubbed edge function for AI snapshot contract |
| `src/features/care-plans/FieldRenderer.jsx` | Dispatches on field type → form control |
| `src/features/care-plans/FieldRenderer.module.css` | Styles for all field types |
| `src/features/care-plans/SectionEditor.jsx` | Slide-in drawer for editing a section's fields |
| `src/features/care-plans/SectionEditor.module.css` | Drawer styles |
| `src/features/care-plans/TaskEditor.jsx` | Add/edit/delete rows for ADL/IADL task lists |
| `src/features/care-plans/TaskEditor.module.css` | Task editor styles |
| `src/features/care-plans/PublishModal.jsx` | Publish-version dialog with signature capture |
| `src/features/care-plans/PublishModal.module.css` | Modal styles |
| `src/features/care-plans/snapshotClient.js` | Client helper for calling the snapshot edge function |
| `src/features/care-plans/useAutosave.js` | Debounced autosave hook (1s) with "Saved" indicator state |
| `src/lib/__tests__/carePlanSections.fields.test.js` | Validate field defs (type integrity, required fields, no duplicate ids) |
| `src/lib/__tests__/carePlanStorageMutations.test.js` | Mock Supabase and test saveDraft / publish / new-draft / task CRUD |
| `src/lib/__tests__/carePlanFieldRenderer.test.js` | Field type → control dispatch |
| `src/lib/__tests__/carePlanAutosave.test.js` | Debounce + save state transitions |

## Files — modified

| File | Change |
|---|---|
| `src/features/care-plans/sections.js` | Replace 16-section list with 11-section taxonomy; add full `fields` arrays for every section; add `tiers` per section; add `FIELD_TYPES` constant; update helpers (`sectionIdForCategory`, `sectionUsesTasks`) to match new ids |
| `src/features/care-plans/storage.js` | Add `saveDraft`, `publishVersion`, `createNewDraftVersion`, `createTask`, `updateTask`, `deleteTask`; add event logging on each mutation |
| `src/features/care-plans/CarePlanPanel.jsx` | Make interactive: Edit buttons on section cards, Publish button in header, new-draft prompt on edit-after-publish, autosave indicator, snapshot regen button (feature-flagged) |
| `src/features/care-plans/CarePlanPanel.module.css` | New styles for interactive states |
| `src/features/clients/ClientDetail.jsx` | TODO comment noting payment info should move out of care plan |

No new frontend dependencies needed (we already have React 18, existing drawer / modal patterns).

---

## Schema migration

**File:** `supabase/migrations/20260420010000_care_plan_observations_and_digests.sql`

Two tables, both additive, RLS admin-only initially.

```sql
-- care_plan_observations
create table if not exists public.care_plan_observations (
  id uuid primary key default gen_random_uuid(),
  care_plan_id uuid not null references public.care_plans(id) on delete cascade,
  version_id uuid not null references public.care_plan_versions(id) on delete restrict,
  task_id uuid references public.care_plan_tasks(id) on delete set null,
  shift_id uuid references public.shifts(id) on delete set null,
  caregiver_id text references public.caregivers(id) on delete set null,
  observation_type text not null check (observation_type in
    ('task_completion','mood','concern','positive','vital','general')),
  rating text,
  note text,
  logged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_care_plan_observations_plan on public.care_plan_observations(care_plan_id, logged_at desc);
create index idx_care_plan_observations_caregiver on public.care_plan_observations(caregiver_id, logged_at desc);
create index idx_care_plan_observations_shift on public.care_plan_observations(shift_id);

alter table public.care_plan_observations enable row level security;
create policy care_plan_observations_staff_all on public.care_plan_observations
  for all using (public.is_staff()) with check (public.is_staff());

create trigger trg_care_plan_observations_touch before update on public.care_plan_observations
  for each row execute function public.touch_updated_at();
```

```sql
-- care_plan_digests
create table if not exists public.care_plan_digests (
  id uuid primary key default gen_random_uuid(),
  care_plan_id uuid not null references public.care_plans(id) on delete cascade,
  client_id text not null references public.clients(id) on delete cascade,
  period_type text not null check (period_type in ('daily','weekly','monthly','adhoc')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  narrative text not null,
  highlights jsonb default '[]'::jsonb,
  concerns jsonb default '[]'::jsonb,
  model text,
  generated_at timestamptz not null default now(),
  delivered_to_family_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_care_plan_digests_client on public.care_plan_digests(client_id, period_end desc);
create index idx_care_plan_digests_plan on public.care_plan_digests(care_plan_id, period_end desc);

alter table public.care_plan_digests enable row level security;
create policy care_plan_digests_staff_all on public.care_plan_digests
  for all using (public.is_staff()) with check (public.is_staff());

create trigger trg_care_plan_digests_touch before update on public.care_plan_digests
  for each row execute function public.touch_updated_at();
```

**Deployment:** after this PR merges, trigger the Deploy Database Migrations workflow (dry run first). Additive only — no risk to existing data.

---

## Sections module (`src/features/care-plans/sections.js`)

Full rewrite from the 16-section stub in PR #164 to the 11-section taxonomy. Shape:

```js
export const FIELD_TYPES = {
  TEXT: 'text',
  TEXTAREA: 'textarea',
  DATE: 'date',
  NUMBER: 'number',
  SELECT: 'select',
  MULTISELECT: 'multiselect',
  BOOLEAN: 'boolean',
  YN: 'yn',
  PHONE: 'phone',
  EMAIL: 'email',
  LIST: 'list',
  PRN: 'prn',
  LEVEL_PICK: 'levelPick',
};

export const VISIBILITY_TIERS = {
  ADMIN: 'admin',
  CAREGIVER: 'caregiver',
  FAMILY: 'family',
};

export const SECTIONS = [
  {
    id: 'snapshot',
    label: 'Snapshot',
    description: 'AI-generated narrative summary of this client.',
    order: 0,
    tiers: ['admin', 'caregiver', 'family'],
    isAutoGenerated: true,
    fields: [
      { id: 'narrative', label: 'Narrative', type: FIELD_TYPES.TEXTAREA, readOnly: true },
    ],
  },
  {
    id: 'whoTheyAre',
    label: 'Who They Are',
    description: 'The person, not the patient. Personal context.',
    order: 1,
    tiers: ['admin', 'caregiver', 'family'],
    fields: [
      // demographics
      { id: 'fullName', label: 'Full name', type: FIELD_TYPES.TEXT, required: true },
      { id: 'preferredName', label: 'Preferred name / goes by', type: FIELD_TYPES.TEXT },
      { id: 'dateOfBirth', label: 'Date of birth', type: FIELD_TYPES.DATE, cms485: true },
      { id: 'gender', label: 'Gender', type: FIELD_TYPES.SELECT,
        options: ['Female', 'Male', 'Non-binary', 'Prefer not to say'] },
      { id: 'pronouns', label: 'Pronouns', type: FIELD_TYPES.TEXT, placeholder: 'she/her' },
      // relationships
      { id: 'maritalStatus', label: 'Marital status', type: FIELD_TYPES.SELECT,
        options: ['Single', 'Married', 'Partnered', 'Widowed', 'Divorced', 'Separated'] },
      { id: 'spouseName', label: 'Spouse / partner name', type: FIELD_TYPES.TEXT,
        conditional: { field: 'maritalStatus', in: ['Married', 'Partnered'] } },
      { id: 'livesWith', label: 'Lives with', type: FIELD_TYPES.SELECT,
        options: ['Alone', 'Spouse/partner', 'Children', 'Extended family', 'ALF', 'SNF', 'Other'] },
      // identity
      { id: 'languages', label: 'Languages spoken', type: FIELD_TYPES.MULTISELECT,
        options: ['English', 'Spanish', 'Mandarin', 'Cantonese', 'Tagalog', 'Vietnamese',
                  'Korean', 'French', 'Russian', 'Arabic', 'Other'] },
      { id: 'religion', label: 'Religion / faith', type: FIELD_TYPES.TEXT },
      { id: 'attendsServices', label: 'Attends religious services', type: FIELD_TYPES.BOOLEAN },
      // context
      { id: 'pastProfession', label: 'Past profession / career', type: FIELD_TYPES.TEXT },
      { id: 'lifeContext', label: 'Life context',
        type: FIELD_TYPES.TEXTAREA,
        help: 'One or two sentences — the kind of thing you\'d tell a new caregiver to help them understand this person.',
        placeholder: 'e.g., "Retired Navy veteran, widowed 2019, grandfather of 4, loves woodworking"' },
      { id: 'interests', label: 'Interests & hobbies', type: FIELD_TYPES.TEXTAREA },
    ],
  },
  // ... 9 more sections, see below
];
```

**The other 9 sections follow the same pattern.** Field lists for each are listed in the design doc; the coder expands them into full `fields: [...]` arrays. Target ~15-25 fields per section average. ADL/IADL sections set `usesTasksTable: true` and have fewer top-level fields since most content lives in `care_plan_tasks`.

Helpers to export:
- `getSectionById(id)` — exists, keep.
- `sortedSections()` — exists, keep.
- `sectionUsesTasks(section)` — exists, keep. Returns true for `dailyLiving` and `homeAndLife`.
- `sectionIdForCategory(category)` — **update**: old `adl.*` → `dailyLiving`, old `iadl.*` → `homeAndLife`.
- `visibleSectionsForTier(tier)` — new. Returns sections where `tiers.includes(tier)`.
- `getFieldById(sectionId, fieldId)` — new. Used by change-event logging.

---

## Storage layer (`src/features/care-plans/storage.js`)

Existing mutations (`createCarePlan`) stay. Add:

### `saveDraft(versionId, sectionId, fieldPatch, { userId })`

Merges `fieldPatch` into `data[sectionId]` on the version row. Only works if `status === 'draft'`.

- Read current `data` jsonb
- Deep-merge `fieldPatch` into `data[sectionId]`
- Update row with new `data`, `updated_at`, `updated_by` (if column exists — add if not in migration)
- For each changed field, emit event: `event_type='care_plan_field_changed'`, payload `{versionId, section, field, old, new, userId}`
- Return updated version

### `publishVersion(versionId, { reason, agencySignedName, clientSignedName, clientSignedMethod, userId })`

- Fail if not draft
- Set `status='published'`, `published_at=now()`, `published_by=userId`, `version_reason`, `agency_signed_name/at`, `client_signed_name/at`, `client_signed_method`
- Emit event: `event_type='care_plan_version_published'`
- Return updated version

### `createNewDraftVersion(carePlanId, { fromVersionId, reason, userId })`

- Read `fromVersionId`'s data + tasks
- Compute next `version_number` (max + 1)
- Insert new row with `status='draft'`, `data` cloned, `version_reason=reason`, `created_by=userId`
- Clone tasks to the new version
- Update `care_plans.current_version_id` to new version
- Emit event: `event_type='care_plan_version_created'`
- Return new version

### Task CRUD

- `createTask(versionId, task)` — insert row, emit event
- `updateTask(taskId, patch)` — partial update, emit event
- `deleteTask(taskId)` — hard delete (tasks on archived versions would break history, but we only delete from drafts), emit event. Guard: reject if task belongs to a published version.

### Event helper

Import `logEvent` from `supabase/functions/ai-chat/context/events.ts` — wait, that's edge-function side. Frontend mutations need a frontend event logger. Check `src/lib/eventLog.js` or equivalent, create if missing. Payload shape matches the `events` table's `payload` jsonb column.

---

## UI — panel interactivity (`CarePlanPanel.jsx`)

Changes to existing panel:

1. Remove the "Read-only preview" badge.
2. Each `SectionCard` gets an "Edit" button (hidden for auto-generated `snapshot` section; instead shows "Regenerate" if feature flag on).
3. Clicking Edit on a section whose version is `draft` → opens `SectionEditor` drawer for that section.
4. Clicking Edit on a section whose version is `published` → shows confirm prompt: "Editing this plan will start a new draft version (v{n+1}). Continue?" → on confirm, calls `createNewDraftVersion`, then opens `SectionEditor` on the new draft.
5. Panel header gains:
   - "Publish version" button when current version is draft and has at least one non-empty section. Opens `PublishModal`.
   - "Regenerate snapshot" button (behind `care_plan_snapshot_ai` flag).
   - "Saved" indicator that flickers during autosave — consumes state from `useAutosave` hook at the panel level (drawer pushes its state up).

---

## UI — SectionEditor drawer (`SectionEditor.jsx`)

Slide-in from the right, matching `src/features/scheduling/ShiftDrawer.jsx` pattern.

Props: `{ section, version, onClose, onSaved, currentUser }`

- Header: section label + "Editing v{n} draft" + Close button
- Body: list of `FieldRenderer` components, one per field in `section.fields`
- For ADL/IADL sections (`section.usesTasksTable`): after the structured fields, render `<TaskEditor versionId={version.id} sectionId={section.id} />`
- Footer: "Saved just now" indicator + permanent Close button (no explicit Save — autosave handles it)

Each `FieldRenderer` change → `useAutosave` debounces for 1s → calls `saveDraft(versionId, sectionId, { [fieldId]: newValue }, { userId })`. Indicator states: `idle` → `pending` (change queued) → `saving` (RPC in flight) → `saved` (brief 2s confirmation) → `idle`.

---

## UI — FieldRenderer (`FieldRenderer.jsx`)

Pure dispatcher — reads `field.type`, renders the appropriate control.

```jsx
function FieldRenderer({ field, value, onChange, disabled }) {
  switch (field.type) {
    case FIELD_TYPES.TEXT: return <TextField ... />;
    case FIELD_TYPES.TEXTAREA: return <TextareaField ... />;
    case FIELD_TYPES.DATE: return <DateField ... />;
    case FIELD_TYPES.NUMBER: return <NumberField ... />;
    case FIELD_TYPES.SELECT: return <SelectField ... />;
    case FIELD_TYPES.MULTISELECT: return <MultiselectField ... />;
    case FIELD_TYPES.BOOLEAN: return <ToggleField ... />;
    case FIELD_TYPES.YN: return <YNField ... />;  // radio + conditional note
    case FIELD_TYPES.PHONE: return <PhoneField ... />;
    case FIELD_TYPES.EMAIL: return <EmailField ... />;
    case FIELD_TYPES.LIST: return <ListField field={field} ... />;
    case FIELD_TYPES.PRN: return <PRNField ... />;
    case FIELD_TYPES.LEVEL_PICK: return <LevelPickField ... />;
    default: return <UnknownField field={field} />;
  }
}
```

Conditional fields: if `field.conditional` is set (e.g., `{ field: 'maritalStatus', in: ['Married'] }`), `FieldRenderer` reads sibling values from the drawer's state and renders nothing if condition fails.

CMS-485 badge: small "485" pill next to label when `field.cms485 === true`.

---

## UI — TaskEditor (`TaskEditor.jsx`)

Renders under the structured fields on ADL/IADL sections. Shows existing tasks grouped by category (using `TASK_CATEGORIES` helper), and an "Add task" button per category.

Each task row: inline-editable (task name, description) + chip controls (shifts, days, priority) + safety notes textarea + delete button.

Add task: opens a small inline form or a mini-modal with required fields (category, name, shifts, days), submit → `createTask`. New task appears in the list.

---

## UI — PublishModal (`PublishModal.jsx`)

Opens from panel header's "Publish version" button. Pattern matches `src/features/scheduling/ShiftCreateModal.jsx`.

Fields:

- **Version reason** (select with common reasons + "Other" → shows textarea):
  - Initial intake
  - Post-hospitalization update
  - Quarterly review
  - Condition change
  - Family request
  - Care team review
  - Other
- **Agency signature** — typed name, required, prefilled from `currentUser.displayName || currentUser.email`
- **Client signature** — typed name, optional
- **Client signature method** (radio, required): In person / Verbal / Family on behalf / Not collected
- Confirmation text: "This version becomes immutable once published. To make changes later, a new draft will be started."

Submit → `publishVersion` → close modal → toast "v{n} published" → panel re-renders from realtime.

---

## AI snapshot contract

**Edge function:** `supabase/functions/care-plan-snapshot/index.ts`

Stub implementation in this PR. Real implementation in Phase 3.

```ts
// Pseudocode
Deno.serve(async (req) => {
  const { versionId, regenerate } = await req.json();
  const supabase = createClient(/* service role */);

  // Load version + tasks + sections
  const { data: version } = await supabase
    .from('care_plan_versions')
    .select('id, care_plan_id, data, generated_summary, status')
    .eq('id', versionId)
    .single();

  if (!regenerate && version.generated_summary) {
    return json({ narrative: version.generated_summary, cached: true });
  }

  // STUB — real implementation calls Claude in Phase 3
  const narrative = 'Snapshot generation coming in Phase 3. ' +
    'This is a placeholder for the AI-generated summary of this care plan.';

  await supabase
    .from('care_plan_versions')
    .update({
      generated_summary: narrative,
      data: { ...version.data, snapshot: { narrative } },
    })
    .eq('id', versionId);

  await supabase.from('events').insert({
    event_type: 'care_plan_snapshot_generated',
    entity_type: 'care_plan',
    entity_id: version.care_plan_id,
    actor: 'system:ai',
    payload: { versionId, model: 'stub', cached: false },
  });

  return json({ narrative, model: 'stub', generatedAt: new Date().toISOString() });
});
```

**Frontend client:** `src/features/care-plans/snapshotClient.js` — thin wrapper that calls the edge function via `supabase.functions.invoke('care-plan-snapshot', { body: { versionId, regenerate } })`.

**Feature flag:** `import.meta.env.VITE_FEATURE_CARE_PLAN_SNAPSHOT_AI === 'true'` gates the button's render. Default off until Phase 3.

---

## Autosave hook (`useAutosave.js`)

```js
// Pseudocode
export function useAutosave(saveFn, { delay = 1000 } = {}) {
  const [state, setState] = useState('idle'); // 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const latestRef = useRef(null);

  const trigger = useCallback((payload) => {
    latestRef.current = payload;
    setState('pending');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setState('saving');
      try {
        await saveFn(latestRef.current);
        setState('saved');
        setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } catch (e) {
        setError(e);
        setState('error');
      }
    }, delay);
  }, [saveFn, delay]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { trigger, state, error };
}
```

Drawer-level: one `useAutosave` per drawer instance, `saveFn` = `(patch) => saveDraft(versionId, sectionId, patch, { userId })`.

---

## Testing

New / updated test files (all under `src/lib/__tests__/`):

1. **`carePlanSections.fields.test.js`** — 25-30 tests
   - Every section has unique id, contiguous order
   - Every field has unique id within its section
   - Every `select` / `multiselect` has non-empty options
   - Every `conditional` refers to a sibling field that exists
   - `cms485` fields are present in expected sections
   - `tiers` is a non-empty subset of `{ admin, caregiver, family }`
   - `snapshot` is auto-generated and has only one field
   - ADL/IADL sections are flagged `usesTasksTable: true`

2. **`carePlanStorageMutations.test.js`** — 20-25 tests
   - `saveDraft` merges only the patched field, doesn't clobber others
   - `saveDraft` rejects on published version
   - `saveDraft` emits one event per changed field
   - `publishVersion` writes all signature fields, sets published_at
   - `publishVersion` rejects on already-published
   - `createNewDraftVersion` increments number, clones data + tasks
   - `createNewDraftVersion` updates `care_plans.current_version_id`
   - `createTask` / `updateTask` / `deleteTask` happy paths + edge cases
   - `deleteTask` rejects on published version

3. **`carePlanFieldRenderer.test.js`** — 15-20 tests
   - Every FIELD_TYPES value has a renderer
   - Unknown type renders fallback
   - Conditional field hides when condition fails
   - CMS-485 badge appears when flagged

4. **`carePlanAutosave.test.js`** — 6-8 tests
   - Debounces rapid changes
   - State transitions: idle → pending → saving → saved → idle
   - Error sets state to `error`
   - Cleanup on unmount doesn't fire stale save

Existing tests (`carePlanSections.test.js`, `carePlanStorageMappers.test.js`) may need minor updates to match the new 11-section list — keep them passing.

**Target:** +70-85 new tests, 1,640+ total.

---

## Deployment order

1. Open PR from `claude/care-plan-editor-phase-2b` → `main`.
2. CI runs: tests + build. Must pass.
3. Vercel preview deploy — test the editor, publish flow, autosave indicator, snapshot stub.
4. Code review / self-review with `/review` skill if helpful.
5. Merge to `main`.
6. Trigger Deploy Database Migrations workflow (dry run first, then for real).
7. Edge function `care-plan-snapshot` auto-deploys via `deploy-edge-functions.yml`.
8. Production verification: open a client's Care Plan section, edit a field, publish, verify event logged.

**Rollback plan:** Vercel instant rollback for frontend. Migration is additive (no DROP, no ALTER of existing tables), so even if we merge and wish we hadn't, there's no data loss. Edge function stub has no external side effects.

---

## Out of scope (reminders)

Repeated from the design doc for anyone reading only the plan:

- Caregiver-facing view — Phase 2d
- Observation logging UI — Phase 2d (schema ships here)
- Real AI snapshot — Phase 3 (contract ships here)
- Family digest generation — Phase 3 (schema ships here)
- CMS-485 export — future
- iPad intake wizard — Phase 2c
- Payment section — moves to client profile, later PR
- Archive/restore UI — future

---

## Implementation order (work plan)

Build in this order to keep each step testable:

1. **Migration file.** Write + locally run via `supabase db push` against a scratch DB if desired. Commit.
2. **Expand `sections.js`** with all 11 sections + full field defs + helpers. Write `carePlanSections.fields.test.js`. Tests pass.
3. **Extend `storage.js`** with the 6 new mutations + event logging. Write `carePlanStorageMutations.test.js` with Supabase mocks. Tests pass.
4. **Build `FieldRenderer`** component + 13 sub-components. Write `carePlanFieldRenderer.test.js`. Tests pass.
5. **Build `useAutosave` hook.** Write `carePlanAutosave.test.js`. Tests pass.
6. **Build `SectionEditor` drawer.** Wire to `useAutosave` + `saveDraft`. Manual test in Vercel preview.
7. **Build `TaskEditor`.** Wire into SectionEditor for ADL/IADL sections. Manual test.
8. **Build `PublishModal`.** Wire to `publishVersion`. Manual test.
9. **Make `CarePlanPanel` interactive.** Edit buttons, Publish button, new-draft prompt, saved indicator. Manual test.
10. **Write edge function stub + `snapshotClient.js`.** Add Regenerate button behind feature flag. Manual test.
11. **Full test run** (`npm test`). Build (`npm run build`). Both green.
12. **Open PR.** Address review comments.

Each step is independently committable; a reader should be able to bisect.

