// Pure mailbox resolution logic shared by frontend + mirrored in the
// outlook-integration edge function. Given the current admin (or null),
// their user_roles row, and the global fallback mailbox setting,
// decides which M365 mailbox to read/send from.
//
// Resolution order:
//   1. user_roles.mailbox_email (per-admin override)
//   2. the admin's login email (if the admin is known)
//   3. admin_email passed through as-is (if it looks like an email)
//   4. global app_settings.outlook_mailbox fallback
//   5. null — caller must error

export function resolveMailbox({ adminEmail, userRolesRow, globalMailbox }) {
  const normalize = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  const global = normalize(globalMailbox);

  const admin = normalize(adminEmail);
  if (admin) {
    if (userRolesRow && userRolesRow.mailbox_email) {
      return normalize(userRolesRow.mailbox_email);
    }
    if (userRolesRow) {
      return admin;
    }
    if (admin.includes('@')) {
      return admin;
    }
  }

  return global.includes('@') ? global : null;
}
