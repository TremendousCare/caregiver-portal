# Active Roster (v12.0) — Design Document

**Date**: 2026-02-23
**Status**: Approved
**Branch**: `feature/active-roster-v12`

## Summary

Add an "Active Roster" tab to the sidebar for managing caregivers who have completed onboarding. Simple table view with inline-editable status, availability, and assignment fields. Manual transition from onboarding to active roster with a nudge when all tasks are complete.

## Data Model

Six new columns on the existing `caregivers` table. No new tables.

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `employment_status` | TEXT | `'onboarding'` | Lifecycle stage: `onboarding` / `active` / `on_leave` / `inactive` / `terminated` |
| `employment_status_changed_at` | BIGINT | null | When status last changed (ms timestamp) |
| `employment_status_changed_by` | TEXT | null | Who changed it |
| `availability_type` | TEXT | `''` | `full_time` / `part_time` / `weekends_only` / `prn` |
| `current_assignment` | TEXT | `''` | Free text, e.g. "Mrs. Johnson, M/W/F 8am-2pm" |
| `cpr_expiry_date` | DATE | null | CPR certification expiry |

`hca_expiration` already exists in the schema.

`employment_status` is separate from the existing `archived` boolean. Archived = removed from pipeline (ghosted, withdrew). Employment status = lifecycle after onboarding.

Flow: `onboarding` -> `active` -> `on_leave` / `inactive` / `terminated`

## Navigation

Add "Active Roster" as the 4th sidebar nav item after Caregiver Board:

```
Dashboard
Caregiver Board
Active Roster        <- NEW
New Caregiver
```

Pipeline Overview phase counts filter to `employment_status = 'onboarding'` only.

New `view === 'roster'` conditional in App.jsx renders `ActiveRoster` component.

## Active Roster View

Table layout (not cards) for fast operational scanning.

**Header**: "Active Roster" title + count badge
**Filter bar**: Search box + status filter dropdown + availability filter

**Table columns**:
- Name (clickable -> opens CaregiverDetail)
- Phone
- Status (inline dropdown: Active / On Leave / Inactive / Terminated)
- Availability (inline dropdown: Full-time / Part-time / Weekends Only / PRN)
- Current Assignment (inline editable text)
- HCA Expiry (color coded: green >90d, amber <90d, red expired)
- CPR Expiry (color coded: same thresholds)

**Not included in v1**: Bulk actions, analytics cards, export, calendar integration.

## Onboarding-to-Roster Transition

Manual with a nudge. When all orientation tasks are 100% complete and `employment_status` is still `'onboarding'`, CaregiverDetail shows a banner:

> "All onboarding tasks complete. Ready to move to Active Roster?" [Move to Active Roster]

Clicking sets `employment_status = 'active'`, `employment_status_changed_at = Date.now()`, `employment_status_changed_by = currentUserName`.

## Integration with Existing Features

- **CaregiverDetail**: Nudge banner + new editable fields in ProfileCard (employment status, availability, current assignment, CPR expiry)
- **AI Chatbot**: No new tools needed. `search_caregivers` and `update_caregiver_field` work automatically with new fields.
- **Automation Engine**: No changes. `update_field` action can set new fields if rules are created later.
- **Dashboard**: Pipeline stat cards and phase counts filter to `employment_status = 'onboarding'` only.
- **Storage layer**: Add field mappings to `dbToCaregiver` and `caregiverToDb`.

## Files Changed

| File | Change |
|------|--------|
| `supabase/schema.sql` | Add 6 columns (migration) |
| `src/lib/storage.js` | Field mappings |
| `src/lib/constants.js` | Employment status + availability constants |
| `src/components/Sidebar.jsx` | Add roster nav item |
| `src/App.jsx` | Add `view === 'roster'` render block |
| `src/features/caregivers/ActiveRoster.jsx` | **New file** |
| `src/features/caregivers/CaregiverDetail.jsx` | Nudge banner + profile fields |
| `src/features/caregivers/Dashboard.jsx` | Filter pipeline stats to onboarding only |
| `src/shared/context/CaregiverContext.jsx` | Add `rosterCaregivers` memo |
| `src/lib/__tests__/` | New test file(s) |

10 files, 1 new component, 1 migration. No new Edge Functions. No new integrations.
