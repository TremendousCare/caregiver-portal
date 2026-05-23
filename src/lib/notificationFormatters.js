// Pure helpers for the in-portal notification bell + dropdown.
// Isolated so vitest can exercise them without a React tree.

/**
 * Format a notification's `created_at` ISO string as a short
 * relative time label suitable for the bell dropdown.
 *
 * Examples (assuming `now` is fixed):
 *   "just now"   — within 60 seconds
 *   "5m ago"     — under an hour
 *   "3h ago"     — under a day
 *   "yesterday"  — exactly 1 day ago
 *   "5d ago"     — older
 *
 * Returns an empty string for null / undefined / unparseable input,
 * which the bell renders as a non-blank cell to avoid layout shift.
 */
export function formatNotificationTimeAgo(iso, now = new Date()) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  return `${diffDay}d ago`;
}

/**
 * Compose the toast string the NotificationContext pops when a new
 * realtime row arrives. Title + ": " + message is the canonical
 * format; both are optional so we gracefully degrade.
 */
export function composeNotificationToast(row) {
  if (!row) return 'New notification';
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const message = typeof row.message === 'string' ? row.message.trim() : '';
  if (title && message) return `${title}: ${message}`;
  if (title) return title;
  if (message) return message;
  return 'New notification';
}
