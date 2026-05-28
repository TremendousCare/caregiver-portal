// Frontend role classifiers — mirror the DB-side helpers exactly.
//
// Why this file exists: Phase 1 of the Executive module introduced
// the 'owner' role tier. The DB helpers public.is_admin() /
// is_staff() were updated to treat 'owner' as satisfying admin /
// staff (owners ARE admins, hierarchical). The frontend did NOT get
// the matching update — every `role === 'admin'` literal check
// flipped to `false` for the two seeded owners, silently revoking
// their access to every admin-gated UI element including the
// Executive section itself.
//
// Rule for callers: never write `role === 'admin'` in app code.
// Always go through one of these helpers so the next role addition
// is a one-file change.

const STAFF_ROLES  = ['admin', 'member', 'owner'];
const ADMIN_ROLES  = ['admin', 'owner'];
const OWNER_ROLES  = ['owner'];

export function isStaffRole(role) {
  return STAFF_ROLES.includes(role);
}

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

export function isOwnerRole(role) {
  return OWNER_ROLES.includes(role);
}
