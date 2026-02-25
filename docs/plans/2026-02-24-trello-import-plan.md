# Trello Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Import 5 caregivers from a Trello board JSON export into the portal's Active Roster as deployed/active caregivers.

**Architecture:** A standalone Node.js script (`scripts/trello-import.js`) reads a Trello JSON export, parses caregiver data from cards, and inserts directly into the Supabase `caregivers` table. A separate config file (`scripts/trello-import-config.js`) holds all mappings so future batches only need config changes. The script uses `@supabase/supabase-js` (already installed) with a service role key for direct DB access.

**Tech Stack:** Node.js, @supabase/supabase-js, Vitest (tests)

**Branch:** `feature/trello-import` (already created, design doc committed)

**Design Doc:** `docs/plans/2026-02-24-trello-import-design.md`

---

### Task 1: Create Config File

**Files:**
- Create: `scripts/trello-import-config.js`

**Step 1: Create the scripts directory and config file**

Create `scripts/trello-import-config.js` with all configurable mappings:

```javascript
// scripts/trello-import-config.js
// Configurable mappings for Trello import. Edit this file to change
// which lists are imported, how fields map, and what statuses are set.

/** Which Trello lists to import. Use exact list names from the board. */
const TARGET_LISTS = ['Deployed'];

/** Cards to skip by exact card title. */
const SKIP_CARDS = ['Chris Nash'];

/**
 * Per-list config: what employment_status and board_status to set.
 * Keys must match TARGET_LISTS entries exactly.
 */
const LIST_CONFIG = {
  'Deployed': {
    employment_status: 'active',
    board_status: 'deployed',
  },
  'Ready for Deployment': {
    employment_status: 'inactive',
    board_status: 'ready',
  },
  'Reserve Pool : Last Resort': {
    employment_status: 'inactive',
    board_status: 'reserve',
  },
  // Pipeline lists (for future rounds)
  'Phone Interview': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'intake',
  },
  'Virtual Interview': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'interview',
  },
  'Offer Out': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'interview',
  },
  'Onboarding': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'onboarding',
  },
  'I-9 Verification': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'verification',
  },
  'Orientation': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'orientation',
  },
};

/**
 * Trello checklist item name -> portal task ID.
 * If a Trello item isn't listed here, it's logged as unmapped.
 */
const CHECKLIST_TASK_MAP = {
  // Onboarding checklist
  'HCA Registered': 'hca_linked',
  'IRS Form I9': 'i9_form',
  'IRS Form W4': 'w4_form',
  'Employee Handbook Acknowledgement': 'employee_handbook',
  'Wage and Employment Notice': 'wage_notice',
  'Employee Agreement': 'employment_agreement',
  'Employee Emergency Contact': 'emergency_contact',
  'Direct Deposit Authorization': 'direct_deposit',
  'TB Test': 'tb_test',
  'Copy of Driver\'s License': 'docs_uploaded',
  'Training': 'training_assigned',
  // Orientation checklist
  'IRS Form I9 Identification Validation': 'i9_validation',
  'Questionnaire': 'questionnaire_done',
  'Scrub Top Size': 'scrubs_distributed',
};

/**
 * Trello checklist items that have no portal equivalent.
 * These are noted in the import note instead of mapped.
 */
const UNMAPPED_CHECKLIST_ITEMS = [
  'Copy of Automobile Insurance',
  'Social Media Check',
  'Social Media',
  'Social Media/Internet Search',
  'Bing/Google Search',
  'Complete Onboarding',
  'Scrub Top Size: M',
];

module.exports = {
  TARGET_LISTS,
  SKIP_CARDS,
  LIST_CONFIG,
  CHECKLIST_TASK_MAP,
  UNMAPPED_CHECKLIST_ITEMS,
};
```

**Step 2: Commit**

```bash
git add scripts/trello-import-config.js
git commit -m "feat: add Trello import config with field mappings"
```

---

### Task 2: Write Parsing Tests

**Files:**
- Create: `src/lib/__tests__/trelloImport.test.js`
- Create: `src/lib/trelloParser.js` (empty placeholder so import works)

These tests cover the core parsing logic: name parsing, description parsing, checklist mapping, and notes conversion. We write them first (TDD), then implement.

**Step 1: Create empty placeholder module**

Create `src/lib/trelloParser.js`:

```javascript
// src/lib/trelloParser.js
// Trello card parsing utilities for import script.
// Extracted as a testable module separate from the script runner.

function parseName(cardTitle) {
  // TODO: implement
  return { firstName: '', lastName: '', annotation: null };
}

function parseDescription(desc) {
  // TODO: implement
  return {};
}

function mapChecklists(checklists, taskMap) {
  // TODO: implement
  return { tasks: {}, unmapped: [] };
}

function convertComments(comments) {
  // TODO: implement
  return [];
}

function normalizePhone(phone) {
  // TODO: implement
  return '';
}

module.exports = { parseName, parseDescription, mapChecklists, convertComments, normalizePhone };
```

**Step 2: Write the failing tests**

Create `src/lib/__tests__/trelloImport.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const { parseName, parseDescription, mapChecklists, convertComments, normalizePhone } = await import('../trelloParser.js');

// ============================================================
// parseName
// ============================================================
describe('parseName', () => {
  it('parses simple two-part name', () => {
    const result = parseName('Elizabeth Nicasio');
    expect(result.firstName).toBe('Elizabeth');
    expect(result.lastName).toBe('Nicasio');
    expect(result.annotation).toBeNull();
  });

  it('parses three-part name (first middle last)', () => {
    const result = parseName('Bernadette Martinez Wallick');
    expect(result.firstName).toBe('Bernadette');
    expect(result.lastName).toBe('Martinez Wallick');
  });

  it('strips parenthetical annotation', () => {
    const result = parseName('Amanda Vega (On Medical Leave until April 2026)');
    expect(result.firstName).toBe('Amanda');
    expect(result.lastName).toBe('Vega');
    expect(result.annotation).toBe('On Medical Leave until April 2026');
  });

  it('preserves hyphenated last name without annotation', () => {
    const result = parseName('Folasade Famofo-Idowu');
    expect(result.firstName).toBe('Folasade');
    expect(result.lastName).toBe('Famofo-Idowu');
    expect(result.annotation).toBeNull();
  });

  it('handles dash-annotation like "On Call"', () => {
    const result = parseName('Aaliyah Navarro-On Call');
    expect(result.firstName).toBe('Aaliyah');
    expect(result.lastName).toBe('Navarro');
    expect(result.annotation).toBe('On Call');
  });

  it('handles dash-annotation like "Resigned"', () => {
    const result = parseName('Mia Lopez-Resigned');
    expect(result.firstName).toBe('Mia');
    expect(result.lastName).toBe('Lopez');
    expect(result.annotation).toBe('Resigned');
  });

  it('preserves real hyphenated names vs annotations using known annotations list', () => {
    // "Naomi Escobar-Medical leave car accident" is an annotation
    const result = parseName('Naomi Escobar-Medical leave car accident');
    expect(result.firstName).toBe('Naomi');
    expect(result.lastName).toBe('Escobar');
    expect(result.annotation).toBe('Medical leave car accident');
  });

  it('handles (Web) annotation', () => {
    const result = parseName('Seada Muhammed (Web)');
    expect(result.firstName).toBe('Seada');
    expect(result.lastName).toBe('Muhammed');
    expect(result.annotation).toBe('Web');
  });

  it('handles parenthetical with client codes like (SL)', () => {
    const result = parseName('Lina Nguyen (SL)');
    expect(result.firstName).toBe('Lina');
    expect(result.lastName).toBe('Nguyen');
    expect(result.annotation).toBe('SL');
  });

  it('handles single-word name gracefully', () => {
    const result = parseName('Madonna');
    expect(result.firstName).toBe('Madonna');
    expect(result.lastName).toBe('');
  });
});

// ============================================================
// normalizePhone
// ============================================================
describe('normalizePhone', () => {
  it('strips non-digits', () => {
    expect(normalizePhone('+1 (323)245-9452')).toBe('3232459452');
  });

  it('removes leading 1 from 11-digit number', () => {
    expect(normalizePhone('+17145489690')).toBe('7145489690');
  });

  it('handles 10-digit number with no formatting', () => {
    expect(normalizePhone('6574234447')).toBe('6574234447');
  });

  it('handles number with leading + but no country code padding', () => {
    expect(normalizePhone('+9495209613')).toBe('9495209613');
  });

  it('returns empty string for empty input', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

// ============================================================
// parseDescription - template format
// ============================================================
describe('parseDescription', () => {
  const templateDesc = `### **📋 APPLICANT INFORMATION**

**Name: Elizabeth Nicasio**
**Full Address:** 11609 Stamy Rd La Mirada CA, 90638
**Phone No.** +6574234447
**Email:** [Elizabeth.nicasio@gmail.com](mailto:Elizabeth.nicasio@gmail.com)
**Pay Rate: $21.00**`;

  it('extracts phone from template format', () => {
    const result = parseDescription(templateDesc);
    expect(result.phone).toBe('6574234447');
  });

  it('extracts email from template format', () => {
    const result = parseDescription(templateDesc);
    expect(result.email).toBe('elizabeth.nicasio@gmail.com');
  });

  it('extracts address from template format', () => {
    const result = parseDescription(templateDesc);
    expect(result.address).toContain('11609 Stamy Rd');
  });

  it('extracts city and state', () => {
    const result = parseDescription(templateDesc);
    expect(result.city).toBe('La Mirada');
    expect(result.state).toBe('CA');
  });

  it('extracts zip code', () => {
    const result = parseDescription(templateDesc);
    expect(result.zip).toBe('90638');
  });

  const simpleDesc = 'Phone: +15868720633';

  it('extracts phone from simple format', () => {
    const result = parseDescription(simpleDesc);
    expect(result.phone).toBe('5868720633');
  });

  it('returns empty object for empty description', () => {
    const result = parseDescription('');
    expect(result.phone).toBeUndefined();
    expect(result.email).toBeUndefined();
  });

  const metaDesc = 'New Lead From META, Please Contact: First Name: Joy Last Name: Cuenca Email: joycue@outlook.com Phone: +17145489690 City: Beaumont Zip Code: 92840';

  it('extracts email from meta lead format', () => {
    const result = parseDescription(metaDesc);
    expect(result.email).toBe('joycue@outlook.com');
  });

  it('extracts phone from meta lead format', () => {
    const result = parseDescription(metaDesc);
    expect(result.phone).toBe('7145489690');
  });

  const hcaDesc = `**HCA PER ID:** 7517616665
**HCA Expiration:** 2027-08-07`;

  it('extracts HCA PER ID', () => {
    const result = parseDescription(hcaDesc);
    expect(result.per_id).toBe('7517616665');
  });

  it('extracts HCA expiration date', () => {
    const result = parseDescription(hcaDesc);
    expect(result.hca_expiration).toBe('2027-08-07');
  });
});

// ============================================================
// mapChecklists
// ============================================================
describe('mapChecklists', () => {
  const taskMap = {
    'HCA Registered': 'hca_linked',
    'IRS Form I9': 'i9_form',
    'Training': 'training_assigned',
  };

  it('maps completed checklist items to portal tasks', () => {
    const checklists = [{
      name: 'Onboarding',
      checkItems: [
        { name: 'HCA Registered', state: 'complete' },
        { name: 'IRS Form I9', state: 'complete' },
        { name: 'Training', state: 'incomplete' },
      ],
    }];
    const result = mapChecklists(checklists, taskMap);
    expect(result.tasks.hca_linked.completed).toBe(true);
    expect(result.tasks.i9_form.completed).toBe(true);
    expect(result.tasks.training_assigned.completed).toBe(false);
  });

  it('returns unmapped items', () => {
    const checklists = [{
      name: 'Onboarding',
      checkItems: [
        { name: 'HCA Registered', state: 'complete' },
        { name: 'Social Media Check', state: 'complete' },
      ],
    }];
    const result = mapChecklists(checklists, taskMap);
    expect(result.unmapped).toContain('Social Media Check');
  });

  it('handles empty checklists', () => {
    const result = mapChecklists([], taskMap);
    expect(result.tasks).toEqual({});
    expect(result.unmapped).toEqual([]);
  });

  it('handles multiple checklists (Onboarding + Orientation)', () => {
    const extendedMap = {
      ...taskMap,
      'Questionnaire': 'questionnaire_done',
    };
    const checklists = [
      {
        name: 'Onboarding',
        checkItems: [{ name: 'HCA Registered', state: 'complete' }],
      },
      {
        name: 'Orientation',
        checkItems: [{ name: 'Questionnaire', state: 'complete' }],
      },
    ];
    const result = mapChecklists(checklists, extendedMap);
    expect(result.tasks.hca_linked.completed).toBe(true);
    expect(result.tasks.questionnaire_done.completed).toBe(true);
  });
});

// ============================================================
// convertComments
// ============================================================
describe('convertComments', () => {
  it('converts Trello comments to portal notes format', () => {
    const comments = [{
      text: 'Offer Letter Sent',
      date: '2026-02-19T18:30:00.000Z',
      by: 'Janster Nieva',
    }];
    const notes = convertComments(comments);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('Offer Letter Sent');
    expect(notes[0].type).toBe('note');
    expect(notes[0].author).toBe('Janster Nieva (via Trello)');
    expect(notes[0].timestamp).toBe(new Date('2026-02-19T18:30:00.000Z').getTime());
  });

  it('handles empty comments array', () => {
    expect(convertComments([])).toEqual([]);
  });

  it('preserves comment ordering (newest first)', () => {
    const comments = [
      { text: 'Second', date: '2026-02-20T00:00:00Z', by: 'A' },
      { text: 'First', date: '2026-02-19T00:00:00Z', by: 'B' },
    ];
    const notes = convertComments(comments);
    // Trello exports comments newest-first, preserve that
    expect(notes[0].text).toBe('Second');
    expect(notes[1].text).toBe('First');
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose src/lib/__tests__/trelloImport.test.js`

Expected: All tests FAIL (functions return default/empty values)

**Step 4: Commit test file**

```bash
git add src/lib/__tests__/trelloImport.test.js src/lib/trelloParser.js
git commit -m "test: add failing tests for Trello import parsing"
```

---

### Task 3: Implement Parser Module

**Files:**
- Modify: `src/lib/trelloParser.js` (replace placeholder with full implementation)

**Step 1: Implement all parsing functions**

Replace the contents of `src/lib/trelloParser.js` with the full implementation:

- `parseName(cardTitle)` — Regex to strip `(...)` parenthetical, detect dash-annotations vs hyphenated names using a known-annotations list (On Call, Resigned, Medical leave, Moved, etc.), split remaining on first space for firstName/lastName
- `normalizePhone(phone)` — Strip non-digits, remove leading 1 if 11 digits, return 10-digit string
- `parseDescription(desc)` — Try template format first (`APPLICANT INFORMATION` header), then Meta Lead format, then simple phone-only format. Extract phone, email, address, city, state, zip, per_id, hca_expiration via regex
- `mapChecklists(checklists, taskMap)` — Iterate all checklist items, look up in taskMap, build `{ taskId: { completed: bool, completedBy: 'trello-import' } }` object, collect unmapped items
- `convertComments(comments)` — Map each to `{ text, type: 'note', timestamp: Date.parse(date), author: name + ' (via Trello)' }`

Key regex patterns for `parseDescription`:
- Phone: `/Phone(?:\s*No)?\.?\s*[:*]*\s*\+?([(\d][\d\s().+-]+\d)/i` and fallback `/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/`
- Email: `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/` (extract from markdown links too)
- Address: `/Full Address[:\s*]*(.+)/i` then parse city/state/zip from the matched line
- HCA PER ID: `/(?:HCA\s*)?PER\s*ID[:\s*]*(\d{7,})/i`
- HCA Expiry: `/(?:HCA\s*)?Expir(?:ation|es?)[:\s*]*([\d]{4}-[\d]{2}-[\d]{2})/i` and fallback `/(\d{2}\/\d{2}\/\d{4})/`

**Step 2: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose src/lib/__tests__/trelloImport.test.js`

Expected: All tests PASS

**Step 3: Run full test suite**

Run: `npm test`

Expected: No regressions (existing 321 passing tests still pass)

**Step 4: Commit**

```bash
git add src/lib/trelloParser.js
git commit -m "feat: implement Trello card parsing utilities"
```

---

### Task 4: Create the Import Script

**Files:**
- Create: `scripts/trello-import.js`

**Step 1: Write the import script**

Create `scripts/trello-import.js` that:

1. **Reads CLI args:** `--dry-run` (default) or `--execute`, plus `--file <path>` for Trello JSON path
2. **Loads config** from `scripts/trello-import-config.js`
3. **Loads Trello JSON** and builds lookup maps:
   - `listMap`: list ID → list name
   - `checklistsByCard`: card ID → checklist array
   - `commentsByCard`: card ID → comments array (from `actions` where `type === 'commentCard'`)
4. **Filters cards** to target lists, skips SKIP_CARDS
5. **For each card**, calls parser functions to build a caregiver row object:
   ```javascript
   {
     id: crypto.randomUUID(),
     first_name, last_name, phone, email,
     address, city, state, zip,
     per_id, hca_expiration, has_hca: per_id ? 'yes' : '',
     source: 'trello',
     source_detail: `${listName} list - Trello import ${new Date().toISOString().split('T')[0]}`,
     employment_status: listConfig.employment_status,
     employment_status_changed_at: Date.now(),
     employment_status_changed_by: 'trello-import',
     board_status: listConfig.board_status,
     phase_override: listConfig.phase_override || null,
     tasks: mappedTasks,
     notes: [importNote, ...convertedComments],
     created_at: Date.now(),
     application_date: cardCreationDate,
   }
   ```
6. **Dedup check (execute mode only):** Query Supabase for each caregiver's email (ilike) and normalized phone. If match found, log and skip.
7. **Dry-run mode:** Print formatted table of all caregivers with key fields. Print any unmapped checklist items. Print total count.
8. **Execute mode:** Initialize Supabase client with service role key from `SUPABASE_SERVICE_ROLE_KEY` env var. Insert one at a time. Log success/failure per record. Print summary at end.

Supabase client setup (service role for direct DB access):
```javascript
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://zocrnurvazyxdpyqimgj.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY  // MUST be set for execute mode
);
```

Script exits with error if `--execute` and no `SUPABASE_SERVICE_ROLE_KEY` is set.

**Step 2: Test dry-run locally**

Run: `node scripts/trello-import.js --dry-run --file "C:\Users\nashk\Downloads\JzkNX4cx - caregiver-roadmap.json"`

Expected: Prints table of 5 caregivers (Elizabeth Nicasio, Michael Atomre, Folasade Famofo-Idowu, Ciara Hinojoza, Bernadette Martinez Wallick) with parsed fields. No DB writes.

**Step 3: Commit**

```bash
git add scripts/trello-import.js
git commit -m "feat: add Trello import script with dry-run and execute modes"
```

---

### Task 5: Run Build and Full Tests

**Files:** None (validation only)

**Step 1: Run full test suite**

Run: `npm test`

Expected: All tests pass (no regressions)

**Step 2: Run build**

Run: `npm run build`

Expected: Build succeeds. The script and parser module shouldn't affect the Vite build, but verify.

**Step 3: Commit any fixes if needed**

---

### Task 6: Dry-Run Against Real Data

**Files:** None (execution only)

**Step 1: Run dry-run**

Run: `node scripts/trello-import.js --dry-run --file "C:\Users\nashk\Downloads\JzkNX4cx - caregiver-roadmap.json"`

**Step 2: Review output with user**

Present the parsed data for all 5 caregivers:
- Name, phone, email, address
- Number of tasks mapped (completed vs incomplete)
- Number of notes/comments
- Any unmapped checklist items
- Employment status and board status

**Step 3: Get user approval before execute**

Do NOT proceed to execute mode without explicit user approval of the dry-run output.

---

### Task 7: Execute Import (5 Test Caregivers)

**Files:** None (execution only)

**Step 1: Set environment variable**

The user needs to provide or set `SUPABASE_SERVICE_ROLE_KEY`. This can be found in Supabase Dashboard → Settings → API → service_role key.

**Step 2: Run execute**

Run: `SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/trello-import.js --execute --file "C:\Users\nashk\Downloads\JzkNX4cx - caregiver-roadmap.json"`

**Step 3: Verify in portal**

- Check Active Roster page — 5 new caregivers should appear with status "Active"
- Click into each one — verify name, phone, email, notes, task completion
- Check that existing caregivers are unaffected

**Step 4: Report results to user**

---

### Task 8: Push Branch and Open PR

**Files:** None (git operations only)

**Step 1: Push feature branch**

Run: `git push -u origin feature/trello-import`

**Step 2: Open PR**

```bash
gh pr create --title "Add Trello import script (Round 1: 5 deployed caregivers)" --body "$(cat <<'EOF'
## Summary
- Adds one-time Trello import script with configurable field mappings
- Parses caregiver data from Trello JSON export (name, phone, email, address, HCA, checklists, comments)
- Supports dry-run mode (preview) and execute mode (insert into Supabase)
- Round 1: imported 5 caregivers from Deployed list into Active Roster as active/deployed
- Config file allows future rounds by changing TARGET_LISTS

## Files Added
- `scripts/trello-import.js` — Main import script
- `scripts/trello-import-config.js` — Configurable mappings
- `src/lib/trelloParser.js` — Tested parsing utilities
- `src/lib/__tests__/trelloImport.test.js` — Parser unit tests
- `docs/plans/2026-02-24-trello-import-design.md` — Design doc
- `docs/plans/2026-02-24-trello-import-plan.md` — This implementation plan

## Test plan
- [ ] All parser unit tests pass (`npm test`)
- [ ] Dry-run outputs correct data for 5 deployed caregivers
- [ ] Execute inserts 5 caregivers into Active Roster
- [ ] Verify each caregiver in portal (name, phone, email, notes, tasks)
- [ ] No existing caregivers modified
- [ ] Build succeeds (`npm run build`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 3: Verify CI passes**

Wait for GitHub Actions CI to run. If it fails, fix and push.
