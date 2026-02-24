# Active Roster (v12.0) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "Active Roster" tab to the sidebar for managing caregivers who have completed onboarding, with inline-editable status, availability, and assignment fields.

**Architecture:** New route `/roster` renders an `ActiveRoster` component. New fields added to the existing `caregivers` table via migration. Pipeline phase counts filtered to `employment_status === 'onboarding'` only. Manual transition via nudge banner in CaregiverDetail.

**Tech Stack:** React + React Router, Supabase (Postgres migration), Vitest, CSS Modules

---

### Task 1: Add Constants for Employment Status and Availability

**Files:**
- Modify: `src/lib/constants.js`

**Step 1: Add employment status and availability constants**

Add to the end of `src/lib/constants.js` (before the closing of the file):

```javascript
// ─── Employment Status (Active Roster) ──────────────────────
export const EMPLOYMENT_STATUSES = [
  { id: 'onboarding', label: 'Onboarding', color: '#6B7280', bg: '#F3F4F6' },
  { id: 'active', label: 'Active', color: '#15803D', bg: '#F0FDF4' },
  { id: 'on_leave', label: 'On Leave', color: '#A16207', bg: '#FFFBEB' },
  { id: 'inactive', label: 'Inactive', color: '#DC2626', bg: '#FEF2F2' },
  { id: 'terminated', label: 'Terminated', color: '#6B7280', bg: '#F3F4F6' },
];

// ─── Availability Types (Active Roster) ─────────────────────
export const AVAILABILITY_TYPES = [
  { id: 'full_time', label: 'Full-time' },
  { id: 'part_time', label: 'Part-time' },
  { id: 'weekends_only', label: 'Weekends Only' },
  { id: 'prn', label: 'PRN (As Needed)' },
];
```

**Step 2: Commit**

```bash
git add src/lib/constants.js
git commit -m "feat: add employment status and availability constants for Active Roster"
```

---

### Task 2: Add Database Migration

**Files:**
- Modify: `supabase/schema.sql` (for reference)
- Run: SQL migration via Supabase MCP

**Step 1: Apply migration to add 6 new columns**

Apply this migration named `add_active_roster_fields`:

```sql
-- Active Roster v12.0: Add employment lifecycle fields
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS employment_status TEXT DEFAULT 'onboarding';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS employment_status_changed_at BIGINT;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS employment_status_changed_by TEXT;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS availability_type TEXT DEFAULT '';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS current_assignment TEXT DEFAULT '';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS cpr_expiry_date DATE;

-- Index for fast roster queries
CREATE INDEX IF NOT EXISTS idx_caregivers_employment_status ON caregivers (employment_status);
```

**Step 2: Update `supabase/schema.sql` reference**

Add the 6 new columns to the `CREATE TABLE` statement in `supabase/schema.sql` (after `archive_phase` and before `archived_by`):

```sql
  employment_status TEXT DEFAULT 'onboarding',
  employment_status_changed_at BIGINT,
  employment_status_changed_by TEXT,
  availability_type TEXT DEFAULT '',
  current_assignment TEXT DEFAULT '',
  cpr_expiry_date DATE,
```

**Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add active roster fields to caregivers table (migration applied)"
```

---

### Task 3: Update Storage Layer Field Mappings

**Files:**
- Modify: `src/lib/storage.js`

**Step 1: Add fields to `dbToCaregiver`**

In `dbToCaregiver`, add after the `archivedBy` line (before `createdAt`):

```javascript
  employmentStatus: row.employment_status || 'onboarding',
  employmentStatusChangedAt: row.employment_status_changed_at,
  employmentStatusChangedBy: row.employment_status_changed_by,
  availabilityType: row.availability_type || '',
  currentAssignment: row.current_assignment || '',
  cprExpiryDate: row.cpr_expiry_date,
```

**Step 2: Add fields to `caregiverToDb`**

In `caregiverToDb`, add after the `archived_by` line (before `created_at`):

```javascript
  employment_status: cg.employmentStatus || 'onboarding',
  employment_status_changed_at: cg.employmentStatusChangedAt || null,
  employment_status_changed_by: cg.employmentStatusChangedBy || null,
  availability_type: cg.availabilityType || '',
  current_assignment: cg.currentAssignment || '',
  cpr_expiry_date: cg.cprExpiryDate || null,
```

**Step 3: Commit**

```bash
git add src/lib/storage.js
git commit -m "feat: add active roster field mappings to storage layer"
```

---

### Task 4: Write Tests for Roster Utilities

**Files:**
- Create: `src/lib/__tests__/activeRoster.test.js`

**Step 1: Write the test file**

```javascript
import { describe, it, expect } from 'vitest';
import { EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../constants';

// ─── Utility functions to test ───
// These will be used by ActiveRoster component
export const getExpiryStatus = (dateStr) => {
  if (!dateStr) return { label: 'Not set', color: '#6B7280', level: 'none' };
  const expiry = new Date(dateStr + 'T00:00:00');
  const daysUntil = Math.ceil((expiry - new Date()) / 86400000);
  if (daysUntil < 0) return { label: `Expired ${Math.abs(daysUntil)}d ago`, color: '#DC2626', level: 'expired' };
  if (daysUntil <= 90) return { label: `${daysUntil}d remaining`, color: '#D97706', level: 'warning' };
  return { label: `${daysUntil}d remaining`, color: '#15803D', level: 'ok' };
};

export const isOnboardingComplete = (caregiver, getOverallProgress) => {
  return getOverallProgress(caregiver) === 100;
};

export const getRosterCaregivers = (caregivers) => {
  return caregivers.filter(
    (cg) => !cg.archived && cg.employmentStatus && cg.employmentStatus !== 'onboarding'
  );
};

export const getOnboardingCaregivers = (caregivers) => {
  return caregivers.filter(
    (cg) => !cg.archived && (!cg.employmentStatus || cg.employmentStatus === 'onboarding')
  );
};

// ─── Constants tests ───

describe('EMPLOYMENT_STATUSES', () => {
  it('has 5 statuses', () => {
    expect(EMPLOYMENT_STATUSES).toHaveLength(5);
  });

  it('includes onboarding as first status', () => {
    expect(EMPLOYMENT_STATUSES[0].id).toBe('onboarding');
  });

  it('includes active status', () => {
    expect(EMPLOYMENT_STATUSES.find((s) => s.id === 'active')).toBeDefined();
  });

  it('each status has id, label, color, bg', () => {
    for (const s of EMPLOYMENT_STATUSES) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('label');
      expect(s).toHaveProperty('color');
      expect(s).toHaveProperty('bg');
    }
  });
});

describe('AVAILABILITY_TYPES', () => {
  it('has 4 types', () => {
    expect(AVAILABILITY_TYPES).toHaveLength(4);
  });

  it('each type has id and label', () => {
    for (const t of AVAILABILITY_TYPES) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('label');
    }
  });
});

// ─── getExpiryStatus tests ───

describe('getExpiryStatus', () => {
  it('returns "Not set" for null input', () => {
    const result = getExpiryStatus(null);
    expect(result.level).toBe('none');
    expect(result.label).toBe('Not set');
  });

  it('returns expired for past dates', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 30);
    const dateStr = pastDate.toISOString().split('T')[0];
    const result = getExpiryStatus(dateStr);
    expect(result.level).toBe('expired');
    expect(result.color).toBe('#DC2626');
  });

  it('returns warning for dates within 90 days', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 45);
    const dateStr = soon.toISOString().split('T')[0];
    const result = getExpiryStatus(dateStr);
    expect(result.level).toBe('warning');
    expect(result.color).toBe('#D97706');
  });

  it('returns ok for dates more than 90 days out', () => {
    const far = new Date();
    far.setDate(far.getDate() + 180);
    const dateStr = far.toISOString().split('T')[0];
    const result = getExpiryStatus(dateStr);
    expect(result.level).toBe('ok');
    expect(result.color).toBe('#15803D');
  });
});

// ─── Filtering tests ───

describe('getRosterCaregivers', () => {
  const caregivers = [
    { id: '1', archived: false, employmentStatus: 'active' },
    { id: '2', archived: false, employmentStatus: 'onboarding' },
    { id: '3', archived: true, employmentStatus: 'active' },
    { id: '4', archived: false, employmentStatus: 'on_leave' },
    { id: '5', archived: false },  // no status = defaults to onboarding
  ];

  it('returns only non-archived, non-onboarding caregivers', () => {
    const result = getRosterCaregivers(caregivers);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['1', '4']);
  });

  it('excludes archived caregivers even if status is active', () => {
    const result = getRosterCaregivers(caregivers);
    expect(result.find((c) => c.id === '3')).toBeUndefined();
  });
});

describe('getOnboardingCaregivers', () => {
  const caregivers = [
    { id: '1', archived: false, employmentStatus: 'active' },
    { id: '2', archived: false, employmentStatus: 'onboarding' },
    { id: '3', archived: true, employmentStatus: 'onboarding' },
    { id: '4', archived: false },
  ];

  it('returns non-archived caregivers with onboarding or no status', () => {
    const result = getOnboardingCaregivers(caregivers);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['2', '4']);
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `npm test -- --run`
Expected: All new tests pass (the utility functions are defined inline in the test file for now)

**Step 3: Commit**

```bash
git add src/lib/__tests__/activeRoster.test.js
git commit -m "test: add Active Roster utility tests (constants, expiry, filtering)"
```

---

### Task 5: Extract Roster Utilities to a Shared Module

**Files:**
- Create: `src/lib/rosterUtils.js`
- Modify: `src/lib/__tests__/activeRoster.test.js`

**Step 1: Create `src/lib/rosterUtils.js`**

```javascript
// ─── Active Roster Utilities ─────────────────────────────────
// Pure functions for roster filtering and expiry date logic.

/**
 * Get color-coded expiry status for a date field.
 * @param {string|null} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {{ label: string, color: string, level: 'none'|'expired'|'warning'|'ok' }}
 */
export const getExpiryStatus = (dateStr) => {
  if (!dateStr) return { label: 'Not set', color: '#6B7280', level: 'none' };
  const expiry = new Date(dateStr + 'T00:00:00');
  const daysUntil = Math.ceil((expiry - new Date()) / 86400000);
  if (daysUntil < 0) return { label: `Expired ${Math.abs(daysUntil)}d ago`, color: '#DC2626', level: 'expired' };
  if (daysUntil <= 90) return { label: `${daysUntil}d remaining`, color: '#D97706', level: 'warning' };
  return { label: `${daysUntil}d remaining`, color: '#15803D', level: 'ok' };
};

/**
 * Filter caregivers to those on the active roster (not onboarding, not archived).
 */
export const getRosterCaregivers = (caregivers) => {
  return caregivers.filter(
    (cg) => !cg.archived && cg.employmentStatus && cg.employmentStatus !== 'onboarding'
  );
};

/**
 * Filter caregivers to those still in onboarding (not archived).
 */
export const getOnboardingCaregivers = (caregivers) => {
  return caregivers.filter(
    (cg) => !cg.archived && (!cg.employmentStatus || cg.employmentStatus === 'onboarding')
  );
};
```

**Step 2: Update test to import from module**

Replace the inline function definitions in `activeRoster.test.js` with imports:

```javascript
import { describe, it, expect } from 'vitest';
import { EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../constants';
import { getExpiryStatus, getRosterCaregivers, getOnboardingCaregivers } from '../rosterUtils';
```

Remove the three `export const` function definitions from the test file (keep all the `describe` blocks).

**Step 3: Run tests**

Run: `npm test -- --run`
Expected: All tests still pass

**Step 4: Commit**

```bash
git add src/lib/rosterUtils.js src/lib/__tests__/activeRoster.test.js
git commit -m "refactor: extract roster utilities to shared module"
```

---

### Task 6: Add `rosterCaregivers` and `onboardingCaregivers` to CaregiverContext

**Files:**
- Modify: `src/shared/context/CaregiverContext.jsx`

**Step 1: Add import**

At the top of the file, add to the imports from `../../lib/storage`:

No new import needed — the filtering will be inline (same pattern as `activeCaregivers`).

**Step 2: Add derived memos**

After the existing `archivedCaregivers` memo (around line 340), add:

```javascript
  const rosterCaregivers = useMemo(() =>
    caregivers.filter((cg) => !cg.archived && cg.employmentStatus && cg.employmentStatus !== 'onboarding'),
    [caregivers, tasksVersion]
  );
  const onboardingCaregivers = useMemo(() =>
    caregivers.filter((cg) => !cg.archived && (!cg.employmentStatus || cg.employmentStatus === 'onboarding')),
    [caregivers, tasksVersion]
  );
```

**Step 3: Expose in context value**

Add `rosterCaregivers, onboardingCaregivers` to the `<CaregiverContext.Provider value={{...}}>` object.

**Step 4: Commit**

```bash
git add src/shared/context/CaregiverContext.jsx
git commit -m "feat: add rosterCaregivers and onboardingCaregivers to context"
```

---

### Task 7: Update Pipeline Phase Counts to Filter by Onboarding Only

**Files:**
- Modify: `src/features/caregivers/CaregiverSidebarExtra.jsx`

**Step 1: Use `onboardingCaregivers` instead of `activeCaregivers` for phase counts**

In `CaregiverSidebarExtra`, change the destructured context:

```javascript
const { onboardingCaregivers, archivedCaregivers, filterPhase, setFilterPhase } = useCaregivers();
```

Then replace all instances of `activeCaregivers` with `onboardingCaregivers` in this file (there are ~4 occurrences — the phase count filters and collapsed view).

**Step 2: Run build to verify no errors**

Run: `npm run build`

**Step 3: Commit**

```bash
git add src/features/caregivers/CaregiverSidebarExtra.jsx
git commit -m "feat: filter pipeline phase counts to onboarding caregivers only"
```

---

### Task 8: Update DashboardPage Filter to Use Onboarding Caregivers

**Files:**
- Modify: `src/App.jsx`

**Step 1: Update DashboardPage function**

In the `DashboardPage` function, add `onboardingCaregivers` to the destructured context:

```javascript
const {
  activeCaregivers, archivedCaregivers, onboardingCaregivers, filterPhase, tasksVersion,
  bulkPhaseOverride, bulkAddNote, bulkBoardStatus, bulkArchive, bulkSms,
} = useCaregivers();
```

Then update the `filtered` memo to use `onboardingCaregivers` as the base for non-archived views:

```javascript
const filtered = useMemo(() => {
  const base = filterPhase === 'archived' ? archivedCaregivers : onboardingCaregivers;
  return base.filter((cg) => {
    ...existing filter logic...
  });
}, [onboardingCaregivers, archivedCaregivers, filterPhase, searchTerm, tasksVersion]);
```

Also update the `allCaregivers` prop passed to Dashboard:

```javascript
allCaregivers={filterPhase === 'archived' ? archivedCaregivers : onboardingCaregivers}
```

**Step 2: Commit**

```bash
git add src/App.jsx
git commit -m "feat: Dashboard pipeline shows only onboarding caregivers"
```

---

### Task 9: Create the ActiveRoster Component

**Files:**
- Create: `src/features/caregivers/ActiveRoster.jsx`

**Step 1: Create the component**

This is the main new file. It renders a table of roster caregivers with inline editing.

```jsx
import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../../lib/constants';
import { getExpiryStatus } from '../../lib/rosterUtils';
import layout from '../../styles/layout.module.css';
import cards from '../../styles/cards.module.css';
import btn from '../../styles/buttons.module.css';

// ─── Inline Editable Cell ───
function InlineSelect({ value, options, onChange }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '4px 8px', borderRadius: 6, border: '1px solid #E5E7EB',
        fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer',
        color: '#0F1724', fontWeight: 500,
      }}
    >
      <option value="">—</option>
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>{opt.label}</option>
      ))}
    </select>
  );
}

function InlineText({ value, placeholder, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  const commit = () => {
    if (draft !== (value || '')) onSave(draft);
    setEditing(false);
  };

  if (!editing) {
    return (
      <span
        onClick={() => { setDraft(value || ''); setEditing(true); }}
        style={{
          cursor: 'pointer', color: value ? '#0F1724' : '#9CA3AF',
          fontSize: 13, fontWeight: 500, display: 'inline-block', minWidth: 80,
          padding: '4px 8px', borderRadius: 6,
          border: '1px solid transparent',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.border = '1px solid #E5E7EB'; }}
        onMouseLeave={(e) => { e.currentTarget.style.border = '1px solid transparent'; }}
        title="Click to edit"
      >
        {value || placeholder || 'Click to set'}
      </span>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
      placeholder={placeholder}
      style={{
        padding: '4px 8px', borderRadius: 6, border: '1px solid #29BEE4',
        fontSize: 13, fontFamily: 'inherit', width: '100%', minWidth: 120,
        outline: 'none', fontWeight: 500,
      }}
    />
  );
}

function ExpiryBadge({ dateStr }) {
  const status = getExpiryStatus(dateStr);
  return (
    <span style={{
      fontSize: 12, fontWeight: 600, color: status.color,
      padding: '2px 8px', borderRadius: 6,
      background: status.level === 'expired' ? '#FEF2F2' : status.level === 'warning' ? '#FFFBEB' : status.level === 'ok' ? '#F0FDF4' : '#F3F4F6',
    }}>
      {status.label}
    </span>
  );
}

function StatusBadge({ status }) {
  const config = EMPLOYMENT_STATUSES.find((s) => s.id === status) || EMPLOYMENT_STATUSES[0];
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color: config.color,
      background: config.bg, padding: '3px 10px', borderRadius: 8,
      textTransform: 'uppercase', letterSpacing: '0.5px',
    }}>
      {config.label}
    </span>
  );
}

// ─── Main Component ───
export function ActiveRoster({ caregivers, onSelect, onUpdateCaregiver, showToast }) {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');

  // Roster statuses (exclude 'onboarding' from filter options)
  const rosterStatuses = EMPLOYMENT_STATUSES.filter((s) => s.id !== 'onboarding');

  const filtered = useMemo(() => {
    return caregivers.filter((cg) => {
      const matchSearch = !searchTerm ||
        `${cg.firstName} ${cg.lastName}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
        cg.phone?.includes(searchTerm) ||
        cg.currentAssignment?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchStatus = statusFilter === 'all' || cg.employmentStatus === statusFilter;
      const matchAvailability = availabilityFilter === 'all' || cg.availabilityType === availabilityFilter;
      return matchSearch && matchStatus && matchAvailability;
    });
  }, [caregivers, searchTerm, statusFilter, availabilityFilter]);

  const handleFieldUpdate = useCallback((cgId, field, value) => {
    onUpdateCaregiver(cgId, { [field]: value });
  }, [onUpdateCaregiver]);

  return (
    <div>
      {/* Header */}
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Active Roster</h1>
          <p className={layout.pageSubtitle}>
            {caregivers.length} caregiver{caregivers.length !== 1 ? 's' : ''} on the roster
          </p>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <input
          type="text"
          placeholder="Search by name, phone, or assignment..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            padding: '10px 16px', borderRadius: 10, border: '1px solid #E5E7EB',
            fontSize: 14, fontFamily: 'inherit', flex: '1 1 240px', minWidth: 200,
            outline: 'none', background: '#fff',
          }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: '10px 16px', borderRadius: 10, border: '1px solid #E5E7EB',
            fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          <option value="all">All Statuses</option>
          {rosterStatuses.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <select
          value={availabilityFilter}
          onChange={(e) => setAvailabilityFilter(e.target.value)}
          style={{
            padding: '10px 16px', borderRadius: 10, border: '1px solid #E5E7EB',
            fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          <option value="all">All Availability</option>
          {AVAILABILITY_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className={layout.emptyState}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>👥</div>
          <h3 style={{ color: '#0F1724', marginBottom: 8 }}>No caregivers on the roster yet</h3>
          <p style={{ color: '#7A8BA0', maxWidth: 400, margin: '0 auto' }}>
            Caregivers will appear here after they complete onboarding and are moved to the Active Roster.
          </p>
        </div>
      ) : (
        <div style={{
          background: '#fff', borderRadius: 16, border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.03)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }}>
                {['Name', 'Phone', 'Status', 'Availability', 'Current Assignment', 'HCA Expiry', 'CPR Expiry'].map((h) => (
                  <th key={h} style={{
                    padding: '12px 16px', textAlign: 'left', fontWeight: 700,
                    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px',
                    color: '#6B7280',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((cg) => (
                <tr
                  key={cg.id}
                  style={{ borderBottom: '1px solid #F3F4F6', transition: 'background 0.1s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#F9FAFB'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '12px 16px' }}>
                    <button
                      onClick={() => navigate(`/caregiver/${cg.id}`)}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        fontFamily: 'inherit', textAlign: 'left',
                      }}
                    >
                      <div style={{ fontWeight: 600, color: '#0F1724', fontSize: 14 }}>
                        {cg.firstName} {cg.lastName}
                      </div>
                      {cg.email && (
                        <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 2 }}>{cg.email}</div>
                      )}
                    </button>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#374151', fontWeight: 500 }}>
                    {cg.phone || '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <InlineSelect
                      value={cg.employmentStatus}
                      options={rosterStatuses}
                      onChange={(val) => handleFieldUpdate(cg.id, 'employmentStatus', val)}
                    />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <InlineSelect
                      value={cg.availabilityType}
                      options={AVAILABILITY_TYPES}
                      onChange={(val) => handleFieldUpdate(cg.id, 'availabilityType', val)}
                    />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <InlineText
                      value={cg.currentAssignment}
                      placeholder="Not assigned"
                      onSave={(val) => handleFieldUpdate(cg.id, 'currentAssignment', val)}
                    />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <ExpiryBadge dateStr={cg.hcaExpiration} />
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <ExpiryBadge dateStr={cg.cprExpiryDate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/features/caregivers/ActiveRoster.jsx
git commit -m "feat: create ActiveRoster component with inline editing table"
```

---

### Task 10: Add Route and Sidebar Entry for Active Roster

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/shared/layout/AppShell.jsx`

**Step 1: Add route page in App.jsx**

Import the component at the top:

```javascript
import { ActiveRoster } from './features/caregivers/ActiveRoster';
```

Add a new route page function (after `BoardPage`):

```javascript
function RosterPage() {
  const navigate = useNavigate();
  const { showToast } = useApp();
  const { rosterCaregivers, updateCaregiver } = useCaregivers();

  return (
    <ActiveRoster
      caregivers={rosterCaregivers}
      onSelect={(id) => navigate(`/caregiver/${id}`)}
      onUpdateCaregiver={updateCaregiver}
      showToast={showToast}
    />
  );
}
```

Add the route inside the `<Route element={<AppShell />}>` block, after the `board` route:

```jsx
<Route path="roster" element={<RosterPage />} />
```

**Step 2: Add sidebar entry in AppShell.jsx**

In the caregivers section items array, add after the `board` item:

```javascript
{ id: 'roster', path: '/roster', icon: '👥', label: 'Active Roster' },
```

**Step 3: Commit**

```bash
git add src/App.jsx src/shared/layout/AppShell.jsx
git commit -m "feat: add Active Roster route and sidebar navigation entry"
```

---

### Task 11: Add Onboarding Complete Nudge Banner to CaregiverDetail

**Files:**
- Modify: `src/features/caregivers/CaregiverDetail.jsx`

**Step 1: Add nudge banner**

Import `getOverallProgress` at the top:

```javascript
import { getCurrentPhase, isGreenLight, getOverallProgress } from '../../lib/utils';
```

Inside the component, after `const greenLight = isGreenLight(caregiver);`, add:

```javascript
const onboardingComplete = getOverallProgress(caregiver) === 100;
const showRosterNudge = onboardingComplete && (!caregiver.employmentStatus || caregiver.employmentStatus === 'onboarding') && !caregiver.archived;
```

In the JSX, after `<ArchiveBanner caregiver={caregiver} />`, add:

```jsx
{showRosterNudge && (
  <div style={{
    background: 'linear-gradient(135deg, #F0FDF4, #ECFDF5)', border: '1px solid #BBF7D0',
    borderRadius: 14, padding: '16px 20px', marginBottom: 20,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
  }}>
    <div>
      <div style={{ fontWeight: 700, color: '#15803D', fontSize: 15 }}>
        All onboarding tasks complete!
      </div>
      <div style={{ color: '#166534', fontSize: 13, marginTop: 4 }}>
        Ready to move this caregiver to the Active Roster?
      </div>
    </div>
    <button
      onClick={() => onUpdateCaregiver(caregiver.id, {
        employmentStatus: 'active',
        employmentStatusChangedAt: Date.now(),
        employmentStatusChangedBy: currentUser?.displayName || 'Unknown',
      })}
      style={{
        padding: '10px 20px', borderRadius: 10, border: 'none',
        background: '#15803D', color: '#fff', fontWeight: 700,
        fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
        boxShadow: '0 2px 8px rgba(21,128,61,0.3)',
      }}
    >
      Move to Active Roster
    </button>
  </div>
)}
```

**Step 2: Commit**

```bash
git add src/features/caregivers/CaregiverDetail.jsx
git commit -m "feat: add onboarding complete nudge banner for Active Roster transition"
```

---

### Task 12: Add New Fields to ProfileCard

**Files:**
- Modify: `src/features/caregivers/caregiver/ProfileCard.jsx`

**Step 1: Add new fields to `startEditing`**

In the `startEditing` function, add to the `setEditForm` call:

```javascript
employmentStatus: caregiver.employmentStatus || 'onboarding',
availabilityType: caregiver.availabilityType || '',
currentAssignment: caregiver.currentAssignment || '',
cprExpiryDate: caregiver.cprExpiryDate || '',
```

**Step 2: Add new fields to `profileFields` array**

Add these entries to the `profileFields` array (after 'Board Status' and before 'Years of Experience'):

```javascript
{ label: 'Employment Status', value: (() => { const EMPLOYMENT_STATUSES = [{ id: 'onboarding', label: 'Onboarding' }, { id: 'active', label: 'Active' }, { id: 'on_leave', label: 'On Leave' }, { id: 'inactive', label: 'Inactive' }, { id: 'terminated', label: 'Terminated' }]; const s = EMPLOYMENT_STATUSES.find((st) => st.id === caregiver.employmentStatus); return s ? s.label : 'Onboarding'; })() },
{ label: 'Availability Type', value: (() => { const types = [{ id: 'full_time', label: 'Full-time' }, { id: 'part_time', label: 'Part-time' }, { id: 'weekends_only', label: 'Weekends Only' }, { id: 'prn', label: 'PRN (As Needed)' }]; const t = types.find((ty) => ty.id === caregiver.availabilityType); return t ? t.label : null; })() },
{ label: 'Current Assignment', value: caregiver.currentAssignment || null },
{ label: 'CPR Expiry Date', value: caregiver.cprExpiryDate ? (() => { const exp = new Date(caregiver.cprExpiryDate + 'T00:00:00'); const du = Math.ceil((exp - new Date()) / 86400000); const ds = exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); if (du < 0) return `⚠️ Expired — ${ds}`; if (du <= 90) return `📅 ${ds} (${du} days)`; return `✅ ${ds}`; })() : null },
```

**Step 3: Add edit fields**

In the editing mode JSX, add the new fields. Use the same `EditField` pattern used by existing fields. Import `EMPLOYMENT_STATUSES` and `AVAILABILITY_TYPES` from constants:

```javascript
import { PHASES, EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../../../lib/constants';
```

Add the appropriate edit fields (select for status/availability, text input for assignment, date for CPR expiry) using the existing `EditField` component pattern in the file.

**Step 4: Commit**

```bash
git add src/features/caregivers/caregiver/ProfileCard.jsx
git commit -m "feat: add employment status, availability, assignment, CPR expiry to ProfileCard"
```

---

### Task 13: Run Tests and Build

**Step 1: Run all tests**

Run: `npm test -- --run`
Expected: All tests pass (existing + new activeRoster tests)

**Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 3: Fix any issues**

If tests or build fail, fix the issues before proceeding.

---

### Task 14: Final Commit and Push Branch

**Step 1: Check git status**

Run: `git status`
Verify all changes are committed, no stray files.

**Step 2: Push feature branch**

```bash
git push -u origin feature/active-roster-v12
```

**Step 3: Create PR**

Create PR with title: "feat: Active Roster (v12.0) — post-onboarding caregiver management"

Body should summarize:
- New Active Roster tab in sidebar
- Table view with inline editing (status, availability, assignment)
- Employment lifecycle fields (6 new columns)
- Nudge banner when onboarding complete
- Pipeline counts filtered to onboarding only
- Tests for roster utilities
