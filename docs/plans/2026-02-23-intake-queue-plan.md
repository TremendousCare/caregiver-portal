# Unified Intake Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the synchronous client-intake-webhook with a queue-based system that never drops form submissions, and extend it to handle caregiver intake from WordPress and Indeed.

**Architecture:** A slim webhook Edge Function stores raw payloads in an `intake_queue` table (~100ms response). A pg_cron job calls an `intake-processor` Edge Function every 2 minutes to process the queue — mapping fields, deduplicating, creating records, and firing automations. A public `/apply` page provides a direct intake form for Indeed applicants.

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), PostgreSQL (pg_cron, pg_net), React (Vite), Vitest

---

## Task 1: Create `intake_queue` table and pg_cron job

**Files:**
- Create: `supabase/migrations/20260223_intake_queue.sql`

**Step 1: Write the migration**

```sql
-- ═══════════════════════════════════════════════════════════════
-- Unified Intake Queue
-- Decouples form submission from record processing.
-- All intake sources (WordPress, Indeed, Google Ads, Meta) feed
-- into this queue. A cron job processes entries every 2 minutes.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Create the queue table ──
CREATE TABLE IF NOT EXISTS intake_queue (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('client', 'caregiver')),
  raw_payload JSONB NOT NULL,
  api_key_label TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'processed', 'error', 'duplicate')),
  error_detail TEXT,
  result_id   TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Index for the processor query: pending items ordered by creation
CREATE INDEX idx_intake_queue_pending
  ON intake_queue (created_at ASC)
  WHERE status = 'pending';

-- Index for admin/debugging: recent entries
CREATE INDEX idx_intake_queue_recent
  ON intake_queue (created_at DESC);

-- RLS: service_role only (no browser access needed)
ALTER TABLE intake_queue ENABLE ROW LEVEL SECURITY;

-- ── 2. Schedule the processor cron job (every 2 minutes) ──
SELECT cron.schedule(
  'process-intake-queue',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/intake-processor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);
```

**Step 2: Review the migration carefully**

Verify:
- Table columns match the design doc
- CHECK constraints cover all valid statuses and entity types
- Cron pattern matches existing automation-cron job (uses vault secrets)
- RLS is enabled (service_role only)

**Step 3: Commit**

```bash
git add supabase/migrations/20260223_intake_queue.sql
git commit -m "feat: add intake_queue table and pg_cron job"
```

---

## Task 2: Write tests for intake processing utilities

**Files:**
- Create: `src/lib/__tests__/intakeQueue.test.js`

**Step 1: Write tests for caregiver field mapping**

Tests should cover:
- Maps Forminator name fields (first_name, last_name) correctly
- Maps email, phone fields
- Stores subject + message as initial note content
- Handles Forminator underscore format (name_1_first_name, email_1, phone_1)
- Handles camelCase aliases (firstName, lastName)
- Handles full name splitting ("Kevin Nash" → first_name: "Kevin", last_name: "Nash")
- Skips metadata fields (form_id, consent, _wp_nonce, etc.)
- Handles Indeed apply form fields (standard snake_case)

Tests should also cover:
- Placeholder detection (test pings with "First Name" as value)
- Phone normalization (strips non-digits, handles +1 prefix)
- Dedup key generation (normalized phone + lowercased email)
- Queue entry status transitions

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/lib/__tests__/intakeQueue.test.js`
Expected: FAIL (functions not yet defined)

**Step 3: Commit failing tests**

```bash
git add src/lib/__tests__/intakeQueue.test.js
git commit -m "test: add intake queue processing tests (red)"
```

---

## Task 3: Implement intake processing utilities

**Files:**
- Create: `src/lib/intakeProcessing.js`

**Step 1: Implement the utility functions to make tests pass**

This file contains pure functions (no Supabase dependency) that are shared between tests and referenced by the Edge Function:

- `mapCaregiverFields(rawPayload)` — maps incoming form fields to caregiver table columns. Returns `{ caregiverData, unmappedFields }`. Handles Forminator hyphen format, underscore format, camelCase, standard snake_case, and full-name splitting.
- `mapClientFields(rawPayload)` — reuses the existing FIELD_MAP logic from `client-intake-webhook`. Returns `{ clientData, unmappedFields }`.
- `isPlaceholderData(data)` — detects test pings.
- `normalizePhone(phone)` — strips non-digits, removes leading "1" from 11-digit numbers.
- `buildInitialNote(source, label, unmappedFields, extraText)` — creates the standard auto-note object `{ text, type: 'auto', timestamp, author: 'Intake Webhook' }`.

Caregiver field mapping table:

| Incoming Field | Caregivers Column |
|---------------|-------------------|
| first_name, firstName, text_1, name_1_first_name | first_name |
| last_name, lastName, text_2, name_1_last_name | last_name |
| email, email_1, user_email | email |
| phone, phone_1, phone_number | phone |
| address, address_1_street_address, street_address | address |
| city, address_1_city | city |
| state, address_1_state | state |
| zip, address_1_zip, postal_code, zip_code | zip |
| name, full_name, fullname, name-1 | _full_name (split) |
| subject | _note_subject |
| message, comments, notes, textarea-1, textarea_1, your message | _note_message |

Fields tagged `_note_subject` and `_note_message` get combined into the initial note, not stored as columns.

**Step 2: Run tests to verify they pass**

Run: `npm test -- --run src/lib/__tests__/intakeQueue.test.js`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/lib/intakeProcessing.js src/lib/__tests__/intakeQueue.test.js
git commit -m "feat: add intake processing utilities with tests"
```

---

## Task 4: Build slim `intake-webhook` Edge Function

**Files:**
- Create: `supabase/functions/intake-webhook/index.ts`

**Step 1: Write the slim webhook**

This replaces `client-intake-webhook` in function. The OLD function stays deployed (same URL), but we'll deploy the NEW one alongside it. The Forminator webhook URL can later be updated to point to the new function.

Actually — deploy as the SAME slug `client-intake-webhook` so the existing Forminator URL keeps working with zero config changes. The function signature stays the same (same URL, same API key), it just becomes much faster.

The function does exactly 3 things:
1. Parse body (JSON or form-urlencoded, same as current)
2. Validate API key against `app_settings.intake_webhook_keys`
3. INSERT into `intake_queue` with entity_type from the API key config
4. Return 200

Key details:
- The `entity_type` comes from the API key config entry. If the key doesn't have `entity_type`, default to `'client'` (backward compatible with the existing key).
- The `source` comes from the API key config `source` field.
- CORS headers must match the current function (needed for the /apply page).
- Handle GET requests the same way (health check + Meta webhook verification).
- Handle empty body / test pings the same way (return 200 "webhook is active").
- Handle form-urlencoded content type (Forminator sends this).

**Step 2: Review the function**

Check:
- CORS headers match current function
- API key validation logic matches current function exactly
- GET handler preserved (health check + Meta verification)
- Empty body handler preserved
- Returns 200/201 for successful queue insert
- Returns 401 for invalid API key
- Error handling returns 500 with detail

**Step 3: Commit**

```bash
git add supabase/functions/intake-webhook/index.ts
git commit -m "feat: add slim intake-webhook Edge Function (queue-based)"
```

---

## Task 5: Build `intake-processor` Edge Function

**Files:**
- Create: `supabase/functions/intake-processor/index.ts`

**Step 1: Write the queue processor**

Called by pg_cron every 2 minutes. Processes up to 20 pending entries per cycle.

Processing flow per entry:
1. Fetch pending entries: `SELECT * FROM intake_queue WHERE status = 'pending' AND attempts < 3 ORDER BY created_at ASC LIMIT 20`
2. For each entry:
   a. Parse `raw_payload` and `entity_type`
   b. Map fields using the appropriate mapper (client vs caregiver)
   c. Check for placeholder data — if detected, mark as `processed` with note "test ping"
   d. Validate minimum fields (need at least one of: first_name, last_name, phone, email)
   e. Deduplicate: check existing records by email (ilike) then phone (normalized)
   f. If duplicate: set status='duplicate', add note to existing record
   g. If new: INSERT into clients or caregivers table
   h. Fire automations (invoke `execute-automation` for matching rules)
   i. Fire sequences (for clients only — check `client_sequences` table)
   j. Set status='processed', result_id=new record ID, processed_at=now()
3. On any error per entry: increment attempts, set error_detail, log to console

Key details for CAREGIVER record creation:
```typescript
const newCaregiver = {
  id: crypto.randomUUID(),
  first_name: data.first_name || "",
  last_name: data.last_name || "",
  phone: data.phone || "",
  email: data.email || "",
  address: data.address || "",
  city: data.city || "",
  state: data.state || "",
  zip: data.zip || "",
  source: entry.source || "Website",       // e.g. "wordpress", "indeed"
  source_detail: entry.api_key_label || "", // e.g. "Caregiver Application"
  application_date: new Date().toISOString().split('T')[0], // today YYYY-MM-DD
  initial_notes: noteMessage || "",
  phase_timestamps: { new_lead: Date.now() },
  tasks: {},
  notes: [initialNote],
  created_at: Date.now(),
  archived: false,
};
```

Key details for CLIENT record creation:
Reuse the exact same client record structure from the current `client-intake-webhook`. Copy the field mapping, client record builder, and automation/sequence firing logic.

Automation firing pattern (matches existing):
```typescript
// Query automation_rules for matching trigger
const { data: rules } = await supabase
  .from("automation_rules")
  .select("*")
  .eq("trigger_type", entityType === "client" ? "new_client" : "new_caregiver")
  .eq("enabled", true);

// For each matching rule, invoke execute-automation
for (const rule of rules) {
  // Check entity_type filter if present
  if (rule.entity_type && rule.entity_type !== entityType) continue;
  // Evaluate conditions
  // Invoke execute-automation
}
```

**Step 2: Review the function**

Check:
- Batch limit (20 per cycle) prevents runaway processing
- Retry logic (attempts < 3) prevents infinite loops
- Error isolation (one entry failing doesn't stop others)
- Client creation matches existing client-intake-webhook behavior exactly
- Caregiver creation sets all required fields with correct defaults
- Automation firing reuses existing patterns
- Console logging for each entry (processed/error/duplicate) for Supabase log visibility

**Step 3: Commit**

```bash
git add supabase/functions/intake-processor/index.ts
git commit -m "feat: add intake-processor Edge Function (cron worker)"
```

---

## Task 6: Build `/apply` public page

**Files:**
- Create: `src/features/apply/ApplyPage.jsx`
- Create: `src/features/apply/ApplyPage.module.css`
- Modify: `src/App.jsx` (add public route outside AuthGate)

**Step 1: Create the ApplyPage component**

A simple, clean application form. No authentication required. Fields:
- First Name (required)
- Last Name (required)
- Phone (required)
- Email (required)
- Address, City, State, Zip (optional)
- Message — "Tell us about yourself" (optional textarea)

On submit:
- POST to `https://zocrnurvazyxdpyqimgj.supabase.co/functions/v1/client-intake-webhook` (same endpoint) with the Indeed API key as `api_key` query param
- Show a "Thank you" confirmation on success
- Show error message on failure with retry option

Branding: Use Tremendous Care branding (company name, clean professional look). Match the general style of the existing portal but keep it simple — this is a public-facing page for applicants.

**Step 2: Add public route in App.jsx**

The `/apply` route must be OUTSIDE the `<AuthGate>` wrapper since it's a public page. Modify App.jsx to add a route check before AuthGate:

```jsx
// In App component, before the AuthGate return:
// Check if we're on the /apply route — render without auth
import { useLocation } from 'react-router-dom';
import { ApplyPage } from './features/apply/ApplyPage';

// Inside App():
const location = useLocation();
if (location.pathname === '/apply') {
  return (
    <Routes>
      <Route path="apply" element={<ApplyPage />} />
    </Routes>
  );
}

// ... existing AuthGate code
```

**Step 3: Run build to verify**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 4: Commit**

```bash
git add src/features/apply/ApplyPage.jsx src/features/apply/ApplyPage.module.css src/App.jsx
git commit -m "feat: add public /apply page for Indeed caregiver intake"
```

---

## Task 7: Generate API keys and update app_settings

**Step 1: Generate two new API keys**

Generate random webhook keys for:
- WordPress caregiver form: `wh_` + 32 random hex chars
- Indeed apply page: `wh_` + 32 random hex chars

**Step 2: Update app_settings in Supabase**

Update the `intake_webhook_keys` value to include all three keys with entity_type:

```sql
UPDATE app_settings
SET value = '[
  {"key": "wh_79d2178b716dbabb4262314e0112240f", "source": "wordpress", "label": "Client Multi-Step Form", "entity_type": "client", "enabled": true},
  {"key": "<new-caregiver-key>", "source": "wordpress", "label": "Caregiver Application", "entity_type": "caregiver", "enabled": true},
  {"key": "<new-indeed-key>", "source": "indeed", "label": "Indeed Apply Page", "entity_type": "caregiver", "enabled": true}
]'::jsonb
WHERE key = 'intake_webhook_keys';
```

**Step 3: Note the keys for Forminator config**

The user will need to:
- Re-enable the existing webhook on the client multi-step form (same URL, same key)
- Add a new webhook on the caregiver application form with URL: `https://zocrnurvazyxdpyqimgj.supabase.co/functions/v1/client-intake-webhook?api_key=<new-caregiver-key>`
- The /apply page will use the Indeed key (hardcoded in the ApplyPage component)

---

## Task 8: Deploy, apply migration, and test end-to-end

**Step 1: Run full test suite and build**

```bash
npm test
npm run build
```

Expected: All tests pass, build succeeds.

**Step 2: Create feature branch and PR**

```bash
git checkout -b feature/intake-queue
git push -u origin feature/intake-queue
gh pr create --title "feat: unified intake queue for reliable form processing" --body "..."
```

Wait for CI to pass and user approval before merging.

**Step 3: After merge — apply migration**

Apply the migration via Supabase MCP tool `apply_migration`. This creates the `intake_queue` table and schedules the pg_cron job.

**Step 4: After merge — deploy Edge Functions**

```bash
npx supabase functions deploy client-intake-webhook --no-verify-jwt
npx supabase functions deploy intake-processor --no-verify-jwt
```

Note: We deploy the new slim code as `client-intake-webhook` (same slug) so the existing Forminator URL keeps working.

**Step 5: After merge — update API keys**

Run the SQL from Task 7 to update `intake_webhook_keys` with the new keys.

**Step 6: End-to-end testing**

Test 1 — WordPress client form:
- Re-enable the webhook in Forminator on the client multi-step form
- Submit a test entry
- Verify: intake_queue gets a row with status='pending'
- Wait 2 minutes
- Verify: queue entry status='processed', new client appears in portal

Test 2 — WordPress caregiver form:
- Add webhook to Forminator caregiver form with new API key
- Submit a test entry
- Verify: intake_queue gets a row with entity_type='caregiver'
- Wait 2 minutes
- Verify: new caregiver appears in portal Phase 1

Test 3 — Indeed apply page:
- Navigate to https://caregiver-portal.vercel.app/apply
- Fill out and submit
- Verify: intake_queue gets a row with source='indeed'
- Wait 2 minutes
- Verify: new caregiver appears in portal

Test 4 — Duplicate detection:
- Submit the same email/phone again
- Verify: queue entry marked as 'duplicate', note added to existing record

Test 5 — Error retry:
- Submit invalid data (no identifying fields)
- Verify: queue entry attempts increment, eventually marked 'error'
