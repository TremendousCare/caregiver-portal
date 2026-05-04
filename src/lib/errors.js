// Map Postgres / Supabase error codes to user-friendly delete messages.
// Codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
export const describeDeleteError = (err, entity = 'record') => {
  const code = err?.code;
  const message = err?.message;

  if (code === '23503') {
    // foreign_key_violation — dependent rows in another table block the delete
    return `Cannot delete ${entity} — related records exist (timesheets, shifts, invoices, etc.). Archive instead.`;
  }
  if (code === '42501') {
    // insufficient_privilege — RLS or grant denied
    return `Permission denied — you don't have access to delete this ${entity}.`;
  }
  if (code === 'PGRST301' || code === 'PGRST116') {
    // PostgREST: row not found / no rows affected
    return `${entity[0].toUpperCase()}${entity.slice(1)} not found — it may have already been deleted.`;
  }
  if (code) {
    return `Failed to delete ${entity}: ${message || code}`;
  }
  // No code → likely a network/transport failure
  return `Failed to delete ${entity} — check your connection.`;
};
