# Sequence Enrollment & Response Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add enrollment tracking, auto-cancel on client response, and manual start/stop UI so clients don't receive stale drip messages after engaging.

**Architecture:** New `client_sequence_enrollments` table tracks active/past enrollments. The existing 30-min `automation-cron` gets response-detection logic that checks RingCentral (SMS + calls) and Outlook (email) before executing each step. `fireClientSequences()` is refactored to create enrollment records instead of executing directly. A new `ClientSequences` component on the client detail page provides manual start/stop/re-enroll.

**Tech Stack:** React (Vite), Supabase (Postgres + Edge Functions + RLS), Vitest, CSS Modules

---

### Task 1: Database Migration — `client_sequence_enrollments` table + `stop_on_response` column

**Files:**
- Create: `supabase/migrations/20260222_sequence_enrollments.sql`

**Step 1: Write the migration SQL**

```sql
-- ═══════════════════════════════════════════════════════════════
-- Sequence Enrollments table + stop_on_response toggle
-- ═══════════════════════════════════════════════════════════════

-- 1. Enrollments table
CREATE TABLE IF NOT EXISTS client_sequence_enrollments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sequence_id TEXT NOT NULL REFERENCES client_sequences(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed')),
  current_step INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_by TEXT NOT NULL DEFAULT 'system',
  start_from_step INTEGER NOT NULL DEFAULT 0,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT CHECK (cancel_reason IN ('response_detected', 'manual', 'phase_changed') OR cancel_reason IS NULL),
  cancelled_by TEXT,
  completed_at TIMESTAMPTZ,
  last_step_executed_at TIMESTAMPTZ
);

-- Partial unique index: only one active enrollment per client per sequence
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_active_unique
  ON client_sequence_enrollments (client_id, sequence_id)
  WHERE status = 'active';

-- Index for cron queries: find all active enrollments efficiently
CREATE INDEX IF NOT EXISTS idx_enrollments_status
  ON client_sequence_enrollments (status)
  WHERE status = 'active';

-- Index for client profile lookups
CREATE INDEX IF NOT EXISTS idx_enrollments_client
  ON client_sequence_enrollments (client_id, started_at DESC);

-- RLS: all authenticated users full access (team tool pattern)
ALTER TABLE client_sequence_enrollments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'client_sequence_enrollments' AND policyname = 'Authenticated users full access'
  ) THEN
    CREATE POLICY "Authenticated users full access"
      ON client_sequence_enrollments FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Enable Realtime for UI updates
ALTER PUBLICATION supabase_realtime ADD TABLE client_sequence_enrollments;

-- 2. Add stop_on_response to client_sequences
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'client_sequences' AND column_name = 'stop_on_response'
  ) THEN
    ALTER TABLE client_sequences ADD COLUMN stop_on_response BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END $$;
```

**Step 2: Run the migration against production Supabase**

Run via Supabase MCP `apply_migration` tool with:
- `project_id`: `zocrnurvazyxdpyqimgj`
- `name`: `sequence_enrollments`
- `query`: (the SQL above)

**Step 3: Verify the migration**

Run via Supabase MCP `execute_sql`:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'client_sequence_enrollments' ORDER BY ordinal_position;
```

Expected: 13 columns matching the schema above.

Also verify:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'client_sequences' AND column_name = 'stop_on_response';
```

Expected: 1 row.

**Step 4: Commit**

```bash
git add supabase/migrations/20260222_sequence_enrollments.sql
git commit -m "feat: add client_sequence_enrollments table and stop_on_response column"
```

---

### Task 2: Tests — Enrollment helper functions

**Files:**
- Create: `src/lib/__tests__/clientSequences.test.js`

**Step 1: Write failing tests for the enrollment helper functions**

These test pure functions that will be extracted from automations.js:

```javascript
import { describe, it, expect, vi } from 'vitest';

// Mock supabase
vi.mock('../../lib/supabase', () => ({
  supabase: {},
  isSupabaseConfigured: () => false,
}));

// Mock storage (needed by utils.js)
vi.mock('../../features/clients/storage', () => ({
  getClientPhaseTasks: () => ({}),
}));

import {
  resolveClientMergeFields,
  normalizeSequenceAction,
  shouldAutoEnroll,
} from '../../features/clients/sequenceHelpers';

// ─── resolveClientMergeFields ───

describe('resolveClientMergeFields', () => {
  const client = {
    firstName: 'Maria',
    lastName: 'Garcia',
    phone: '555-1234',
    email: 'maria@test.com',
  };

  it('replaces all merge fields', () => {
    const template = 'Hi {{first_name}} {{last_name}}, call us at {{phone}} or email {{email}}';
    const result = resolveClientMergeFields(template, client);
    expect(result).toBe('Hi Maria Garcia, call us at 555-1234 or email maria@test.com');
  });

  it('handles missing fields gracefully', () => {
    const result = resolveClientMergeFields('Hi {{first_name}}', { firstName: '' });
    expect(result).toBe('Hi ');
  });

  it('returns template unchanged if no merge fields', () => {
    const result = resolveClientMergeFields('Hello there!', client);
    expect(result).toBe('Hello there!');
  });
});

// ─── normalizeSequenceAction ───

describe('normalizeSequenceAction', () => {
  it('normalizes sms variants', () => {
    expect(normalizeSequenceAction('sms')).toBe('send_sms');
    expect(normalizeSequenceAction('send_sms')).toBe('send_sms');
  });

  it('normalizes email variants', () => {
    expect(normalizeSequenceAction('email')).toBe('send_email');
    expect(normalizeSequenceAction('send_email')).toBe('send_email');
  });

  it('normalizes task variants', () => {
    expect(normalizeSequenceAction('task')).toBe('create_task');
    expect(normalizeSequenceAction('create_task')).toBe('create_task');
  });

  it('passes through unknown types', () => {
    expect(normalizeSequenceAction('unknown')).toBe('unknown');
  });
});

// ─── shouldAutoEnroll ───

describe('shouldAutoEnroll', () => {
  it('returns true when no active enrollment exists', () => {
    expect(shouldAutoEnroll([])).toBe(true);
  });

  it('returns false when active enrollment exists', () => {
    const existing = [{ id: 1, status: 'active' }];
    expect(shouldAutoEnroll(existing)).toBe(false);
  });

  it('returns true when only cancelled/completed enrollments exist', () => {
    const existing = [
      { id: 1, status: 'cancelled' },
      { id: 2, status: 'completed' },
    ];
    expect(shouldAutoEnroll(existing)).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/lib/__tests__/clientSequences.test.js`

Expected: FAIL — `sequenceHelpers` module does not exist yet.

**Step 3: Commit the failing tests**

```bash
git add src/lib/__tests__/clientSequences.test.js
git commit -m "test: add failing tests for client sequence enrollment helpers"
```

---

### Task 3: Extract sequence helper functions

**Files:**
- Create: `src/features/clients/sequenceHelpers.js`
- Modify: `src/features/clients/automations.js`

**Step 1: Create `sequenceHelpers.js` with extracted + new functions**

```javascript
// ═══════════════════════════════════════════════════════════════
// Sequence Helper Functions (exported for testing)
// ═══════════════════════════════════════════════════════════════

/**
 * Simple merge field substitution for client templates.
 */
export function resolveClientMergeFields(template, client) {
  return template
    .replace(/\{\{first_name\}\}/g, client.firstName || '')
    .replace(/\{\{last_name\}\}/g, client.lastName || '')
    .replace(/\{\{phone\}\}/g, client.phone || '')
    .replace(/\{\{email\}\}/g, client.email || '');
}

/**
 * Normalize action_type from sequence steps.
 */
export function normalizeSequenceAction(actionType) {
  switch (actionType) {
    case 'send_sms': case 'sms': return 'send_sms';
    case 'send_email': case 'email': return 'send_email';
    case 'create_task': case 'task': return 'create_task';
    default: return actionType;
  }
}

/**
 * Check whether a client should be auto-enrolled in a sequence.
 * Returns true if there are no active enrollments for this sequence.
 *
 * @param {Array} existingEnrollments - Rows from client_sequence_enrollments
 */
export function shouldAutoEnroll(existingEnrollments) {
  if (!existingEnrollments || existingEnrollments.length === 0) return true;
  return !existingEnrollments.some((e) => e.status === 'active');
}
```

**Step 2: Update `automations.js` to import from `sequenceHelpers.js`**

In `src/features/clients/automations.js`:

- Remove the local `resolveClientMergeFields` function (lines 116-122)
- Remove the local `normalizeSequenceAction` function (lines 261-268)
- Add import at top: `import { resolveClientMergeFields, normalizeSequenceAction } from './sequenceHelpers';`

**Step 3: Run tests to verify they pass**

Run: `npm test -- --run src/lib/__tests__/clientSequences.test.js`

Expected: PASS (3 suites, all green)

**Step 4: Run full test suite**

Run: `npm test`

Expected: All existing tests still pass (no regressions from the extract).

**Step 5: Commit**

```bash
git add src/features/clients/sequenceHelpers.js src/features/clients/automations.js src/lib/__tests__/clientSequences.test.js
git commit -m "refactor: extract sequence helpers for testability, add enrollment check"
```

---

### Task 4: Refactor `fireClientSequences()` to use enrollment records

**Files:**
- Modify: `src/features/clients/automations.js` (lines 130-258)

**Step 1: Write tests for the new enrollment-based flow**

Add to `src/lib/__tests__/clientSequences.test.js`:

```javascript
// ─── buildEnrollmentRecord ───

import { buildEnrollmentRecord } from '../../features/clients/sequenceHelpers';

describe('buildEnrollmentRecord', () => {
  it('creates a record with correct defaults', () => {
    const record = buildEnrollmentRecord('client-1', 'seq-1', 'admin@test.com');
    expect(record.client_id).toBe('client-1');
    expect(record.sequence_id).toBe('seq-1');
    expect(record.status).toBe('active');
    expect(record.current_step).toBe(0);
    expect(record.started_by).toBe('admin@test.com');
    expect(record.start_from_step).toBe(0);
  });

  it('respects startFromStep parameter', () => {
    const record = buildEnrollmentRecord('client-1', 'seq-1', 'admin@test.com', 3);
    expect(record.current_step).toBe(3);
    expect(record.start_from_step).toBe(3);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/lib/__tests__/clientSequences.test.js`

Expected: FAIL — `buildEnrollmentRecord` not exported yet.

**Step 3: Add `buildEnrollmentRecord` to `sequenceHelpers.js`**

```javascript
/**
 * Build an enrollment record for inserting into client_sequence_enrollments.
 *
 * @param {string} clientId
 * @param {string} sequenceId
 * @param {string} startedBy - User email or 'system'
 * @param {number} [startFromStep=0] - Which step to begin from
 * @returns {Object} Row data for insert
 */
export function buildEnrollmentRecord(clientId, sequenceId, startedBy, startFromStep = 0) {
  return {
    client_id: clientId,
    sequence_id: sequenceId,
    status: 'active',
    current_step: startFromStep,
    started_by: startedBy,
    start_from_step: startFromStep,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/lib/__tests__/clientSequences.test.js`

Expected: PASS

**Step 5: Rewrite `fireClientSequences()` in `automations.js`**

Replace the entire function (lines 130-258) with enrollment-based logic:

```javascript
/**
 * Create enrollment records when a client enters a sequence trigger phase.
 * The cron job handles step execution. Immediate (delay=0) steps for
 * the first step are still executed here for instant first-touch.
 *
 * @param {Object} client - Client data (camelCase from the app)
 */
export async function fireClientSequences(client) {
  if (!isSupabaseConfigured()) return;

  try {
    const phase = getClientPhase(client) || 'new_lead';

    // Fetch enabled sequences that trigger on this phase
    const { data: sequences, error: seqError } = await supabase
      .from('client_sequences')
      .select('*')
      .eq('trigger_phase', phase)
      .eq('enabled', true);

    if (seqError || !sequences || sequences.length === 0) return;

    // Get auth session for Edge Function calls
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const clientPayload = {
      id: client.id,
      first_name: client.firstName || '',
      last_name: client.lastName || '',
      phone: client.phone || '',
      email: client.email || '',
      phase,
    };

    for (const sequence of sequences) {
      const steps = sequence.steps || [];
      if (steps.length === 0) continue;

      // Check for existing active enrollment
      const { data: existing } = await supabase
        .from('client_sequence_enrollments')
        .select('id, status')
        .eq('sequence_id', sequence.id)
        .eq('client_id', client.id)
        .eq('status', 'active')
        .limit(1);

      if (!shouldAutoEnroll(existing || [])) {
        // Already enrolled — add note and skip
        const currentNotes = Array.isArray(client.notes) ? client.notes : [];
        supabase
          .from('clients')
          .update({
            notes: [...currentNotes, {
              text: `Client re-entered ${phase} but is already active in "${sequence.name}" — skipping auto-enrollment.`,
              type: 'auto',
              timestamp: Date.now(),
              author: 'System',
            }],
          })
          .eq('id', client.id)
          .then(() => {})
          .catch(() => {});
        continue;
      }

      // Create enrollment record
      const enrollmentRecord = buildEnrollmentRecord(client.id, sequence.id, 'system');

      const { data: enrollment, error: enrollError } = await supabase
        .from('client_sequence_enrollments')
        .insert(enrollmentRecord)
        .select('id')
        .single();

      if (enrollError) {
        console.warn('Enrollment insert error:', enrollError);
        continue;
      }

      // Execute step 0 immediately if delay_hours === 0 (instant first-touch)
      const firstStep = steps[0];
      if ((firstStep.delay_hours || 0) === 0) {
        const actionType = normalizeSequenceAction(firstStep.action_type);
        const resolvedTemplate = resolveClientMergeFields(firstStep.template || '', client);

        if (actionType === 'send_sms' || actionType === 'send_email') {
          supabase.functions.invoke('execute-automation', {
            body: {
              rule_id: `seq_${sequence.id}_step_0`,
              caregiver_id: client.id,
              entity_type: 'client',
              action_type: actionType,
              message_template: resolvedTemplate,
              action_config: actionType === 'send_email'
                ? { subject: resolveClientMergeFields(firstStep.subject || 'Message from Tremendous Care', client) }
                : {},
              rule_name: `${sequence.name} - Step 1`,
              caregiver: clientPayload,
            },
            headers: { Authorization: `Bearer ${session.access_token}` },
          }).catch((err) => console.warn('Sequence step 0 fire error:', err));
        } else if (actionType === 'create_task') {
          const currentNotes = Array.isArray(client.notes) ? client.notes : [];
          supabase
            .from('clients')
            .update({
              notes: [...currentNotes, {
                text: resolvedTemplate,
                type: 'task',
                timestamp: Date.now(),
                author: 'Automation',
                outcome: `Sequence: ${sequence.name}, Step 1`,
              }],
            })
            .eq('id', client.id)
            .then(() => {})
            .catch((err) => console.warn('Sequence task note error:', err));
        }

        // Log step 0 as executed + update enrollment
        const nowMs = Date.now();
        supabase
          .from('client_sequence_log')
          .insert({
            sequence_id: sequence.id,
            client_id: client.id,
            step_index: 0,
            action_type: actionType,
            status: 'executed',
            scheduled_at: nowMs,
            executed_at: nowMs,
          })
          .then(() => {})
          .catch((err) => console.warn('Sequence log insert error:', err));

        // Advance enrollment to step 1
        supabase
          .from('client_sequence_enrollments')
          .update({
            current_step: 1,
            last_step_executed_at: new Date().toISOString(),
          })
          .eq('id', enrollment.id)
          .then(() => {})
          .catch(() => {});

        // If sequence only has 1 step, mark completed
        if (steps.length === 1) {
          supabase
            .from('client_sequence_enrollments')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', enrollment.id)
            .then(() => {})
            .catch(() => {});
        }
      }

      // Enqueue remaining delayed steps to client_sequence_log
      const startIdx = (firstStep.delay_hours || 0) === 0 ? 1 : 0;
      const baseTime = Date.now();
      for (let i = startIdx; i < steps.length; i++) {
        const step = steps[i];
        const scheduledAt = baseTime + ((step.delay_hours || 0) * 60 * 60 * 1000);
        supabase
          .from('client_sequence_log')
          .insert({
            sequence_id: sequence.id,
            client_id: client.id,
            step_index: i,
            action_type: normalizeSequenceAction(step.action_type),
            status: 'pending',
            scheduled_at: scheduledAt,
          })
          .then(() => {})
          .catch((err) => console.warn('Sequence log enqueue error:', err));
      }
    }
  } catch (err) {
    console.warn('fireClientSequences error:', err);
  }
}
```

**Step 6: Run full test suite**

Run: `npm test`

Expected: All tests pass.

**Step 7: Run build**

Run: `npm run build`

Expected: Clean build, no errors.

**Step 8: Commit**

```bash
git add src/features/clients/automations.js src/features/clients/sequenceHelpers.js src/lib/__tests__/clientSequences.test.js
git commit -m "feat: refactor fireClientSequences to use enrollment records"
```

---

### Task 5: Add `stop_on_response` toggle to SequenceSettings UI

**Files:**
- Modify: `src/features/clients/SequenceSettings.jsx`

**Step 1: Add the toggle to the SequenceForm**

In the `SequenceForm` component, after the trigger phase selector and before the steps editor, add:

```jsx
{/* Stop on Response Toggle */}
<div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
  <label className={forms.fieldLabel} style={{ margin: 0 }}>
    Stop on client response
  </label>
  <button
    type="button"
    onClick={() => setForm((f) => ({ ...f, stopOnResponse: !f.stopOnResponse }))}
    style={{
      width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
      background: form.stopOnResponse ? '#10B981' : '#D1D5DB',
      position: 'relative', transition: 'background 0.2s',
    }}
  >
    <span style={{
      position: 'absolute', top: 2, left: form.stopOnResponse ? 22 : 2,
      width: 20, height: 20, borderRadius: '50%', background: '#fff',
      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    }} />
  </button>
  <span style={{ fontSize: 12, color: '#6B7280' }}>
    {form.stopOnResponse
      ? 'Sequence will auto-cancel when client responds via SMS, email, or call'
      : 'Sequence will continue regardless of client responses (e.g., newsletters)'}
  </span>
</div>
```

**Step 2: Update form state initialization**

In the form's initial state and the `handleEdit` function, ensure `stopOnResponse` defaults:

- New sequence: `stopOnResponse: true`
- Edit existing: `stopOnResponse: sequence.stop_on_response !== false`

**Step 3: Update `handleSave` to include `stop_on_response`**

In the Supabase upsert payload, add: `stop_on_response: form.stopOnResponse`

**Step 4: Add badge to SequenceList**

In the sequence list table rows, add a small badge after the step count:

```jsx
<span style={{
  fontSize: 11, padding: '2px 6px', borderRadius: 4,
  background: seq.stop_on_response !== false ? '#D1FAE5' : '#E0E7FF',
  color: seq.stop_on_response !== false ? '#065F46' : '#3730A3',
}}>
  {seq.stop_on_response !== false ? '🔔 Stops on response' : '📬 Continuous'}
</span>
```

**Step 5: Run build**

Run: `npm run build`

Expected: Clean build.

**Step 6: Commit**

```bash
git add src/features/clients/SequenceSettings.jsx
git commit -m "feat: add stop_on_response toggle to sequence settings UI"
```

---

### Task 6: Client Profile — Sequences Section component

**Files:**
- Create: `src/features/clients/client/ClientSequences.jsx`
- Create: `src/features/clients/client/clientSequences.module.css`

**Step 1: Build the ClientSequences component**

This component shows active sequences, start/stop controls, and past enrollment history. Key elements:

1. **Data loading**: Query `client_sequence_enrollments` filtered by `client_id`, joined with `client_sequences` for name/steps
2. **Active enrollments section**: Card per active enrollment with progress indicator + Stop button
3. **Start Sequence area**: Button that opens a dropdown of available sequences, with step picker
4. **Past enrollments section**: Collapsible history with re-enroll shortcut
5. **Supabase Realtime subscription**: Listen for changes to `client_sequence_enrollments` for this client

The component should:
- Call `supabase.from('client_sequence_enrollments').select('*, client_sequences(*)').eq('client_id', client.id).order('started_at', { ascending: false })` to load enrollments with sequence details
- Provide `startSequence(sequenceId, startFromStep)` — inserts enrollment record
- Provide `stopSequence(enrollmentId)` — updates to `cancelled`, `cancel_reason = 'manual'`
- Subscribe to Realtime on `client_sequence_enrollments` filtered by `client_id`

**Step 2: Create the CSS module**

Follow the existing pattern from `client.module.css` — card styles, progress bars, badges.

**Step 3: Run build**

Run: `npm run build`

Expected: Clean build (component not yet wired into ClientDetail).

**Step 4: Commit**

```bash
git add src/features/clients/client/ClientSequences.jsx src/features/clients/client/clientSequences.module.css
git commit -m "feat: add ClientSequences component for enrollment management"
```

---

### Task 7: Wire ClientSequences into ClientDetail

**Files:**
- Modify: `src/features/clients/ClientDetail.jsx` (lines 8, 165-170)

**Step 1: Import the new component**

Add at top of file:
```javascript
import { ClientSequences } from './client/ClientSequences';
```

**Step 2: Add between ClientProgressOverview and ClientPhaseDetail**

After `ClientProgressOverview` (line 170) and before `ClientPhaseDetail` (line 172), add:

```jsx
<ClientSequences
  client={client}
  currentUser={currentUser}
  showToast={showToast}
/>
```

**Step 3: Run build**

Run: `npm run build`

Expected: Clean build.

**Step 4: Commit**

```bash
git add src/features/clients/ClientDetail.jsx
git commit -m "feat: wire ClientSequences into client detail page"
```

---

### Task 8: Manual enrollment function in ClientContext

**Files:**
- Modify: `src/features/clients/automations.js`

**Step 1: Add `enrollClientInSequence()` export**

```javascript
/**
 * Manually enroll a client in a sequence.
 * Called from the ClientSequences UI component.
 *
 * @param {Object} client - Client data (camelCase)
 * @param {string} sequenceId - ID of the sequence to enroll in
 * @param {string} startedBy - Email of user who started it
 * @param {number} [startFromStep=0] - Which step to begin from
 * @returns {Object|null} The created enrollment record, or null on error
 */
export async function enrollClientInSequence(client, sequenceId, startedBy, startFromStep = 0) {
  if (!isSupabaseConfigured()) return null;

  try {
    const record = buildEnrollmentRecord(client.id, sequenceId, startedBy, startFromStep);
    const { data, error } = await supabase
      .from('client_sequence_enrollments')
      .insert(record)
      .select()
      .single();

    if (error) {
      console.warn('Manual enrollment error:', error);
      return null;
    }

    // If starting from step 0 and first step is immediate, execute it
    const { data: sequence } = await supabase
      .from('client_sequences')
      .select('*')
      .eq('id', sequenceId)
      .single();

    if (sequence) {
      const steps = sequence.steps || [];
      const firstStep = steps[startFromStep];
      if (firstStep && (firstStep.delay_hours || 0) === 0) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          const actionType = normalizeSequenceAction(firstStep.action_type);
          const resolvedTemplate = resolveClientMergeFields(firstStep.template || '', client);
          const clientPayload = {
            id: client.id,
            first_name: client.firstName || '',
            last_name: client.lastName || '',
            phone: client.phone || '',
            email: client.email || '',
            phase: getClientPhase(client) || 'new_lead',
          };

          if (actionType === 'send_sms' || actionType === 'send_email') {
            supabase.functions.invoke('execute-automation', {
              body: {
                rule_id: `seq_${sequenceId}_step_${startFromStep}`,
                caregiver_id: client.id,
                entity_type: 'client',
                action_type: actionType,
                message_template: resolvedTemplate,
                action_config: actionType === 'send_email'
                  ? { subject: resolveClientMergeFields(firstStep.subject || 'Message from Tremendous Care', client) }
                  : {},
                rule_name: `${sequence.name} - Step ${startFromStep + 1}`,
                caregiver: clientPayload,
              },
              headers: { Authorization: `Bearer ${session.access_token}` },
            }).catch((err) => console.warn('Manual enrollment step fire error:', err));
          }

          // Update enrollment to next step
          supabase
            .from('client_sequence_enrollments')
            .update({
              current_step: startFromStep + 1,
              last_step_executed_at: new Date().toISOString(),
            })
            .eq('id', data.id)
            .then(() => {})
            .catch(() => {});
        }
      }

      // Enqueue remaining delayed steps
      const baseTime = Date.now();
      const effectiveStart = (firstStep && (firstStep.delay_hours || 0) === 0) ? startFromStep + 1 : startFromStep;
      for (let i = effectiveStart; i < steps.length; i++) {
        const step = steps[i];
        const scheduledAt = baseTime + ((step.delay_hours || 0) * 60 * 60 * 1000);
        supabase
          .from('client_sequence_log')
          .insert({
            sequence_id: sequenceId,
            client_id: client.id,
            step_index: i,
            action_type: normalizeSequenceAction(step.action_type),
            status: 'pending',
            scheduled_at: scheduledAt,
          })
          .then(() => {})
          .catch(() => {});
      }
    }

    return data;
  } catch (err) {
    console.warn('enrollClientInSequence error:', err);
    return null;
  }
}

/**
 * Cancel a client's active enrollment (manual cancel from UI).
 *
 * @param {number} enrollmentId - The enrollment row ID
 * @param {string} cancelledBy - Email of user who cancelled
 */
export async function cancelClientEnrollment(enrollmentId, cancelledBy) {
  if (!isSupabaseConfigured()) return;

  try {
    // Get enrollment details for the auto-note
    const { data: enrollment } = await supabase
      .from('client_sequence_enrollments')
      .select('*, client_sequences(name)')
      .eq('id', enrollmentId)
      .single();

    // Cancel enrollment
    await supabase
      .from('client_sequence_enrollments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancel_reason: 'manual',
        cancelled_by: cancelledBy,
      })
      .eq('id', enrollmentId);

    // Cancel pending steps in sequence log
    if (enrollment) {
      await supabase
        .from('client_sequence_log')
        .update({ status: 'cancelled' })
        .eq('sequence_id', enrollment.sequence_id)
        .eq('client_id', enrollment.client_id)
        .eq('status', 'pending');

      // Add auto-note
      const { data: client } = await supabase
        .from('clients')
        .select('notes')
        .eq('id', enrollment.client_id)
        .single();

      const currentNotes = Array.isArray(client?.notes) ? client.notes : [];
      await supabase
        .from('clients')
        .update({
          notes: [...currentNotes, {
            text: `Sequence "${enrollment.client_sequences?.name || 'Unknown'}" manually cancelled by ${cancelledBy}.`,
            type: 'auto',
            timestamp: Date.now(),
            author: 'System',
          }],
        })
        .eq('id', enrollment.client_id);
    }
  } catch (err) {
    console.warn('cancelClientEnrollment error:', err);
  }
}
```

**Step 2: Run full test suite + build**

Run: `npm test && npm run build`

Expected: All pass.

**Step 3: Commit**

```bash
git add src/features/clients/automations.js
git commit -m "feat: add manual enrollClientInSequence and cancelClientEnrollment functions"
```

---

### Task 9: Response Detection in `automation-cron`

**Files:**
- Modify: `supabase/functions/automation-cron/index.ts` (Edge Function — deploy via Supabase MCP or CLI)

**Step 1: Add response detection job**

Add a new function within the cron that:

1. Queries all active enrollments where `stop_on_response = true` (join `client_sequences`)
2. For each enrollment, calls RingCentral (SMS inbound + call log) and Outlook (email search) to check for communication from the client since `last_step_executed_at`
3. If response found: updates enrollment to `cancelled` with `cancel_reason = 'response_detected'`, cancels pending `client_sequence_log` rows, adds auto-note

**Step 2: Add step execution job**

Add logic to execute pending sequence steps:

1. Query `client_sequence_log` where `status = 'pending'` and `scheduled_at <= now()`
2. For each pending step, verify the enrollment is still `active`
3. Execute the step via `execute-automation` Edge Function (or direct API calls for SMS/email)
4. Update `client_sequence_log` status to `executed`
5. Update `client_sequence_enrollments.current_step` and `last_step_executed_at`
6. If last step, mark enrollment `completed`

**Step 3: Deploy the updated Edge Function**

Run: `npx supabase functions deploy automation-cron --no-verify-jwt`

Or deploy via Supabase MCP if the function is not in git.

**Step 4: Test by checking cron logs**

Run via Supabase MCP `get_logs` with service `edge-function` to verify the cron runs cleanly.

**Step 5: Commit** (if Edge Function is in git)

```bash
git add supabase/functions/automation-cron/
git commit -m "feat: add response detection and step execution to automation-cron"
```

---

### Task 10: End-to-end testing & PR

**Files:**
- None new — validation only

**Step 1: Run full test suite**

Run: `npm test`

Expected: All tests pass (existing + new clientSequences tests).

**Step 2: Run build**

Run: `npm run build`

Expected: Clean build.

**Step 3: Manual E2E verification checklist**

Test in the Vercel preview deploy:

1. **Auto-enrollment**: Create a new client → verify enrollment record created in `client_sequence_enrollments`
2. **Manual enrollment**: Open client profile → click "Start Sequence" → pick a sequence → verify enrollment
3. **Manual cancel**: Click "Stop" on an active enrollment → verify status changes to `cancelled`
4. **Re-enrollment**: Click "Re-enroll" on a cancelled sequence → verify new active enrollment
5. **Start from step**: Re-enroll starting from step 2 → verify `current_step` and `start_from_step` = 2
6. **Stop on response toggle**: Create a sequence with `stop_on_response = false` → verify it shows "Continuous" badge
7. **Response detection**: Send a test SMS to a client enrolled in a `stop_on_response = true` sequence → wait for cron → verify auto-cancel

**Step 4: Open PR**

Create feature branch and PR:

```bash
git checkout -b feature/sequence-enrollment
git push -u origin feature/sequence-enrollment
gh pr create --title "feat: sequence enrollment & response detection" --body "$(cat <<'EOF'
## Summary
- New `client_sequence_enrollments` table for tracking active/past sequence enrollments
- Auto-cancel sequences when client responds via SMS, email, or call (30-min cron cycle)
- Manual start/stop sequences from client profile with step picker
- Re-enrollment support with enrollment history
- Per-sequence `stop_on_response` toggle (drip campaigns vs newsletters)
- `fireClientSequences()` refactored to create enrollment records instead of direct execution

## Test plan
- [ ] Auto-enrollment on phase entry creates enrollment record
- [ ] Manual enrollment from client profile works
- [ ] Manual cancel stops sequence and adds auto-note
- [ ] Re-enrollment creates new active enrollment
- [ ] Start-from-step picker works correctly
- [ ] Stop on response toggle saves and displays correctly
- [ ] Response detection cancels enrollment on inbound SMS/email/call
- [ ] Cron executes pending delayed steps on schedule
- [ ] All 185+ tests pass, build clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 5: Verify CI passes**

Wait for GitHub Actions CI to run. Fix any failures before requesting merge.

---

## Task Dependency Graph

```
Task 1 (Migration) ──────────────────────────────────────┐
Task 2 (Tests) ──→ Task 3 (Helpers) ──→ Task 4 (Refactor fireClientSequences)
                                    └──→ Task 5 (Settings UI toggle)
                                    └──→ Task 6 (ClientSequences component)
                                              ↓
                                         Task 7 (Wire into ClientDetail)
                                              ↓
                                         Task 8 (Manual enroll/cancel functions)
                                              ↓
                                         Task 9 (Cron response detection)
                                              ↓
                                         Task 10 (E2E test + PR)
```

Tasks 1, 2, and 5 can run in parallel. Tasks 6+7 depend on Task 3. Task 9 depends on Task 1 (table must exist). Task 10 is last.
