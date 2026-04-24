import { describe, it, expect } from 'vitest';
import { caregiverToDb, dbToCaregiver } from '../storage';

// Regression test for the bug where manual phase moves (onboarding →
// orientation, Interview → pending, etc.) silently reverted hours
// later. Root cause: saveCaregiver upserts the whole caregiver row
// and pulled phase_override from whatever the client had in local
// state. Any other tab/user/edge-function that still had stale
// pre-change state would write the old phase_override back.
//
// Contract: phase_override must NOT be serialized by caregiverToDb.
// Writes to phase_override go through setCaregiverPhaseOverride (a
// targeted UPDATE), so concurrent whole-row upserts can't clobber it.

describe('phase_override persistence (stale-state protection)', () => {
  it('caregiverToDb does not include phase_override in the serialized row', () => {
    const cg = {
      id: 'cg-1',
      firstName: 'Test',
      lastName: 'User',
      tasks: {},
      notes: [],
      phaseTimestamps: {},
      phaseOverride: 'orientation',
    };
    const row = caregiverToDb(cg);
    expect(row).not.toHaveProperty('phase_override');
  });

  it('caregiverToDb still includes phase_override-adjacent fields (tasks, notes, phase_timestamps)', () => {
    const cg = {
      id: 'cg-2',
      firstName: 'Test',
      lastName: 'User',
      tasks: { task1: true },
      notes: [{ text: 'hi' }],
      phaseTimestamps: { orientation: 123 },
      phaseOverride: 'orientation',
    };
    const row = caregiverToDb(cg);
    expect(row.tasks).toEqual({ task1: true });
    expect(row.notes).toEqual([{ text: 'hi' }]);
    expect(row.phase_timestamps).toEqual({ orientation: 123 });
  });

  it('dbToCaregiver still maps phase_override from the DB row', () => {
    const row = {
      id: 'cg-3',
      first_name: 'Test',
      last_name: 'User',
      tasks: {},
      notes: [],
      phase_timestamps: {},
      phase_override: 'orientation',
    };
    const cg = dbToCaregiver(row);
    expect(cg.phaseOverride).toBe('orientation');
  });

  it('stale-state round-trip does NOT revert phase_override', () => {
    // Scenario: User A moves Caregiver X from onboarding → orientation.
    // DB now has phase_override='orientation'.
    //
    // User B's browser (tab left open, realtime missed the echo) still
    // has phaseOverride=null in its local state. User B then adds a
    // note, which triggers saveCaregiver(changed) with stale state.
    //
    // Pre-fix: caregiverToDb emitted phase_override=null, upsert
    //          clobbered the manual override, UI "reverted" to the
    //          task-calculated phase (onboarding).
    // Post-fix: caregiverToDb omits phase_override entirely, so the
    //          UPSERT leaves the DB column untouched.
    const staleClientState = {
      id: 'cg-4',
      firstName: 'Test',
      lastName: 'User',
      tasks: {},
      notes: [{ text: 'just added by user B' }],
      phaseTimestamps: {},
      phaseOverride: null, // stale — User B missed the realtime event
    };
    const upsertPayload = caregiverToDb(staleClientState);
    expect(upsertPayload).not.toHaveProperty('phase_override');
    // The stale null does NOT leak into the payload, so Postgres
    // leaves the existing phase_override value intact.
  });
});
