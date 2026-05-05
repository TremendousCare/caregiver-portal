// Pure resolution logic for picking an email sender from a
// communication_routes row. Mirrors the behavior in
// supabase/functions/outlook-integration/index.ts (resolveRoute) so we
// can unit-test the rules without booting an edge function or Postgres.
//
// The contract: given a category and the route rows the UI loaded,
// return { mailbox, fromName } if a route is eligible to send email,
// or null if the caller should fall back to the global default mailbox.

function normalizeAddress(s) {
  return typeof s === 'string' ? s.replace(/^"|"$/g, '').trim().toLowerCase() : '';
}

export function resolveEmailRoute(category, routes) {
  if (!category || typeof category !== 'string') return null;
  const trimmed = category.trim();
  if (!trimmed) return null;
  if (!Array.isArray(routes)) return null;

  const row = routes.find((r) => r && r.category === trimmed);
  if (!row) return null;
  if (row.is_active === false) return null;

  const addr = normalizeAddress(row.email_from_address);
  if (!addr.includes('@')) return null;

  const name = typeof row.email_from_name === 'string' && row.email_from_name.trim()
    ? row.email_from_name.trim()
    : null;

  return { mailbox: addr, fromName: name };
}

// Filter routes to those a given action type can use. SMS needs phone
// number + JWT secret; email needs an address. Used by the per-step
// dropdown in SequenceSettings and by AutomationSettings to gray out
// rows that aren't configured for the chosen action.
export function eligibleRoutesFor(actionType, routes) {
  if (!Array.isArray(routes)) return [];
  return routes.filter((r) => {
    if (!r) return false;
    if (actionType === 'send_sms') {
      return !!(r.sms_from_number && r.sms_vault_secret_name);
    }
    if (actionType === 'send_email') {
      return !!normalizeAddress(r.email_from_address).includes('@');
    }
    return false;
  });
}
