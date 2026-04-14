// ═══════════════════════════════════════════════════════════════
// Scheduling — Eligibility Ranking
//
// Pure function that ranks caregivers for a proposed shift. This
// is the "brain" of the Phase 4c smart matching UX: given the
// proposed time, the target client, and per-caregiver data
// (availability rows, existing shifts, ongoing assignments), it
// returns a sorted array of candidates with metadata about
// eligibility and ranking reasons.
//
// The same function will be called by the AI in Phase 8 when it
// decides who to offer a shift to. Keeping it pure means the AI's
// decisions are traceable and testable exactly like the UI's.
//
// Sort order:
//   1. Eligible first (not filtered out)
//   2. Role tier (primary > backup > float > other)
//   3. Hours scheduled this week ASC (fewer first — load balance)
//   4. Name ASC (deterministic tiebreaker)
// ═══════════════════════════════════════════════════════════════

import { isAvailable } from '../../lib/scheduling/availabilityMatching';
import { detectConflicts } from '../../lib/scheduling/conflictDetection';

// Role tier constants — lower is better
export const ROLE_TIER_PRIMARY = 0;
export const ROLE_TIER_BACKUP = 1;
export const ROLE_TIER_FLOAT = 2;
export const ROLE_TIER_NONE = 3;

/**
 * Friendly label for a role tier, used in the picker's reason text.
 */
export function roleTierLabel(tier) {
  switch (tier) {
    case ROLE_TIER_PRIMARY:
      return 'Primary';
    case ROLE_TIER_BACKUP:
      return 'Backup';
    case ROLE_TIER_FLOAT:
      return 'Float';
    case ROLE_TIER_NONE:
    default:
      return '';
  }
}

/**
 * Convert a caregiver_assignments.role string into a tier number.
 */
function roleToTier(role) {
  switch (role) {
    case 'primary':
      return ROLE_TIER_PRIMARY;
    case 'backup':
      return ROLE_TIER_BACKUP;
    case 'float':
      return ROLE_TIER_FLOAT;
    default:
      return ROLE_TIER_NONE;
  }
}

/**
 * For a given caregiver and target client, find the best (lowest)
 * role tier across their active assignments for that client.
 * Returns ROLE_TIER_NONE if no active assignment exists.
 */
function bestTierForCaregiver(caregiverId, clientId, assignmentsByCaregiverId) {
  const rows = assignmentsByCaregiverId[caregiverId] || [];
  let best = ROLE_TIER_NONE;
  for (const row of rows) {
    if (row.clientId !== clientId) continue;
    if (row.status !== 'active') continue;
    const tier = roleToTier(row.role);
    if (tier < best) best = tier;
  }
  return best;
}

/**
 * Compute the total duration (in hours) of blocking shifts for a
 * caregiver within [weekStart, weekEnd]. "Blocking" here means the
 * shift is actually consuming the caregiver's schedule; cancelled
 * and no_show shifts don't count.
 */
export function sumHoursInWindow(shifts, weekStart, weekEnd) {
  if (!Array.isArray(shifts) || shifts.length === 0) return 0;
  const ws = weekStart instanceof Date ? weekStart.getTime() : new Date(weekStart).getTime();
  const we = weekEnd instanceof Date ? weekEnd.getTime() : new Date(weekEnd).getTime();
  let totalMs = 0;
  for (const shift of shifts) {
    if (!shift || !shift.startTime || !shift.endTime) continue;
    if (shift.status === 'cancelled' || shift.status === 'no_show') continue;
    const start = new Date(shift.startTime).getTime();
    const end = new Date(shift.endTime).getTime();
    // Clip to window
    const clippedStart = Math.max(start, ws);
    const clippedEnd = Math.min(end, we);
    if (clippedEnd > clippedStart) totalMs += clippedEnd - clippedStart;
  }
  return totalMs / (60 * 60 * 1000);
}

/**
 * Compute the [start, end] of the calendar week containing a date.
 * Week starts on Sunday 00:00 local time and ends Saturday 23:59:59.999.
 */
export function weekBoundsContaining(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const dayOfWeek = d.getDay(); // 0=Sun
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayOfWeek, 0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/**
 * Convert per-caregiver availability rows into a helper-shape row
 * (snake_case keys) that the Phase 2 isAvailable() function expects.
 * The storage layer returns camelCase app objects.
 */
function toHelperAvailabilityRow(row) {
  return {
    id: row.id,
    type: row.type,
    day_of_week: row.dayOfWeek,
    start_time: row.startTime,
    end_time: row.endTime,
    start_date: row.startDate,
    end_date: row.endDate,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    reason: row.reason,
  };
}

/**
 * Convert an app-shape shift into the helper-shape the conflict
 * detector expects (snake_case start_time/end_time/client_id).
 */
function toHelperShiftRow(shift) {
  return {
    id: shift.id,
    client_id: shift.clientId,
    assigned_caregiver_id: shift.assignedCaregiverId,
    start_time: shift.startTime,
    end_time: shift.endTime,
    status: shift.status,
  };
}

/**
 * Main entry point: rank a list of caregivers for a proposed shift.
 *
 * @param {object} params
 * @param {object} params.proposed       { clientId, startTime, endTime, id? }
 * @param {object[]} params.caregivers   array of caregiver objects (with id, firstName, lastName)
 * @param {object} params.availabilityByCaregiverId  map of caregiverId → availability rows[]
 * @param {object} params.shiftsByCaregiverId        map of caregiverId → shifts[]
 * @param {object} params.assignmentsByCaregiverId   map of caregiverId → assignments[]
 * @param {Date}   params.weekStart      start of "this week" window
 * @param {Date}   params.weekEnd        end of "this week" window
 * @param {number} [params.travelBufferMinutes=30]
 *
 * @returns {object[]} ranked array. Each entry has:
 *   {
 *     caregiver,              // original caregiver object
 *     eligible,               // boolean: true if passes all filters
 *     tier,                   // role tier (ROLE_TIER_*)
 *     roleLabel,              // 'Primary' / 'Backup' / 'Float' / ''
 *     hoursThisWeek,          // number — sum of blocking hours in [weekStart, weekEnd]
 *     filterReason,           // null (eligible) or 'unavailable' / 'conflict' / 'no_availability_data'
 *     filterDetail,           // human-readable reason
 *     conflictingShifts,      // array of shifts causing conflicts (empty if eligible)
 *   }
 */
export function rankCaregiversForShift(params) {
  const {
    proposed,
    caregivers,
    availabilityByCaregiverId = {},
    shiftsByCaregiverId = {},
    assignmentsByCaregiverId = {},
    weekStart,
    weekEnd,
    travelBufferMinutes = 30,
  } = params || {};

  if (!proposed || !proposed.clientId || !proposed.startTime || !proposed.endTime) return [];
  if (!Array.isArray(caregivers)) return [];

  const proposedHelper = {
    start_time: proposed.startTime,
    end_time: proposed.endTime,
    client_id: proposed.clientId,
  };

  const results = caregivers.map((caregiver) => {
    const tier = bestTierForCaregiver(
      caregiver.id,
      proposed.clientId,
      assignmentsByCaregiverId,
    );

    // Compute hours this week
    const myShifts = shiftsByCaregiverId[caregiver.id] || [];
    const hoursThisWeek = sumHoursInWindow(myShifts, weekStart, weekEnd);

    // Availability check
    const myAvailabilityRows = (availabilityByCaregiverId[caregiver.id] || []).map(
      toHelperAvailabilityRow,
    );
    const availabilityResult = isAvailable(
      { start_time: proposed.startTime, end_time: proposed.endTime },
      myAvailabilityRows,
    );

    // Conflict check (only against this caregiver's other shifts)
    const myHelperShifts = myShifts.map(toHelperShiftRow);
    const conflicts = detectConflicts(proposedHelper, myHelperShifts, {
      travelBufferMinutes,
      excludeShiftId: proposed.id || null,
    });

    // Determine eligibility and reason
    let eligible = true;
    let filterReason = null;
    let filterDetail = null;

    if (!availabilityResult.available) {
      eligible = false;
      if (availabilityResult.reason === 'no_data') {
        filterReason = 'no_availability_data';
        filterDetail = 'No availability entered for this caregiver';
      } else if (availabilityResult.reason === 'unavailable_block') {
        filterReason = 'unavailable';
        filterDetail = 'Has a time-off block covering this slot';
      } else {
        filterReason = 'unavailable';
        filterDetail = 'Outside of weekly availability';
      }
    } else if (conflicts.length > 0) {
      eligible = false;
      filterReason = 'conflict';
      filterDetail = conflicts.length === 1
        ? 'Conflicts with another shift (travel buffer)'
        : `Conflicts with ${conflicts.length} other shifts`;
    }

    return {
      caregiver,
      eligible,
      tier,
      roleLabel: roleTierLabel(tier),
      hoursThisWeek,
      filterReason,
      filterDetail,
      conflictingShifts: conflicts,
    };
  });

  // Sort: eligible first, then tier asc, then hours asc, then name asc
  results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.hoursThisWeek !== b.hoursThisWeek) return a.hoursThisWeek - b.hoursThisWeek;
    const nameA = `${a.caregiver.firstName || ''} ${a.caregiver.lastName || ''}`.trim().toLowerCase();
    const nameB = `${b.caregiver.firstName || ''} ${b.caregiver.lastName || ''}`.trim().toLowerCase();
    return nameA.localeCompare(nameB);
  });

  return results;
}

/**
 * Split a ranked list into two groups for UI rendering:
 *   { eligible: [...], filtered: [...] }
 */
export function splitRankedList(ranked) {
  const eligible = [];
  const filtered = [];
  for (const entry of ranked || []) {
    (entry.eligible ? eligible : filtered).push(entry);
  }
  return { eligible, filtered };
}

/**
 * Generate a short human-readable reason string for an eligible
 * caregiver, shown in the picker row under their name.
 * Example: "Primary · 12 hrs this week"
 */
export function formatEligibleReason(entry) {
  if (!entry) return '';
  const parts = [];
  if (entry.roleLabel) parts.push(entry.roleLabel);
  else parts.push('Available');
  const hours = Math.round(entry.hoursThisWeek * 10) / 10;
  parts.push(`${hours} ${hours === 1 ? 'hr' : 'hrs'} this week`);
  return parts.join(' · ');
}
