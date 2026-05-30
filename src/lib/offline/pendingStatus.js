// ─── Pending-aware shift status ───
// When a clock event is queued offline, the shift's row in the database
// still shows its old status (the server hasn't been told yet). These
// pure helpers let the UI reflect the caregiver's reality: if they've
// queued a clock-in, treat the shift as in_progress locally so the button
// flips to "Clock out" and the care-plan checklist unlocks.

// Apply queued events (oldest first) on top of the DB status.
export function effectiveShiftStatus(dbStatus, pendingEntries = []) {
  let status = dbStatus;
  const ordered = [...pendingEntries].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const e of ordered) {
    if (e.eventType === 'in' && (status === 'assigned' || status === 'confirmed')) {
      status = 'in_progress';
    } else if (e.eventType === 'out' && status === 'in_progress') {
      status = 'completed';
    }
  }
  return status;
}

// Which clock action (if any) is available given an effective status.
export function nextClockAction(effectiveStatus) {
  if (effectiveStatus === 'assigned' || effectiveStatus === 'confirmed') return 'in';
  if (effectiveStatus === 'in_progress') return 'out';
  return null;
}

// Is a clock event of this type already queued for this shift? Prevents
// double-queuing the same action.
export function hasPendingEvent(pendingEntries = [], eventType) {
  return pendingEntries.some((e) => e.eventType === eventType && e.status !== 'failed');
}
