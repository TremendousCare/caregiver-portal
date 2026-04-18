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

/**
 * Caregivers eligible to appear in the shift-assignment picker:
 * active roster plus applicants still in onboarding. Archived
 * caregivers are excluded. Roster caregivers come first so the
 * default ordering surfaces fully-cleared caregivers ahead of
 * applicants.
 */
export const getSchedulableCaregivers = (caregivers) => {
  return [
    ...getRosterCaregivers(caregivers),
    ...getOnboardingCaregivers(caregivers),
  ];
};

/**
 * True when a caregiver is still working through onboarding and has not
 * been cleared for the active roster. Mirrors getOnboardingCaregivers so
 * picker-row badges stay consistent with the underlying filter.
 */
export const isOnboardingCaregiver = (caregiver) => {
  if (!caregiver) return false;
  if (caregiver.archived) return false;
  return !caregiver.employmentStatus || caregiver.employmentStatus === 'onboarding';
};
