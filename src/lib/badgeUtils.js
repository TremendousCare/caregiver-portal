/**
 * Compute due-date badge info for a card.
 * @param {string|null} dueDate — ISO date string (YYYY-MM-DD) or null
 * @returns {{ label: string, color: string, bg: string } | null}
 */
export function getDueDateBadge(dueDate) {
  if (!dueDate) return null;
  const due = new Date(dueDate + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffMs = due - now;
  const diffDays = Math.ceil(diffMs / 86400000);
  const dateStr = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  if (diffDays < 0) {
    return { label: `${dateStr} (overdue)`, color: '#DC3545', bg: '#FEF2F2' };
  }
  if (diffDays === 0) {
    return { label: `${dateStr} (today)`, color: '#D97706', bg: '#FFFBEB' };
  }
  if (diffDays <= 3) {
    return { label: `${dateStr} (${diffDays}d)`, color: '#D97706', bg: '#FFFBEB' };
  }
  return { label: dateStr, color: '#556270', bg: '#F0F3F7' };
}

/**
 * Compute HCA expiration badge info for a card.
 * Only returns a badge if expiring within 30 days or already expired.
 * @param {string|null} hcaExpiration — ISO date string (YYYY-MM-DD) or null
 * @returns {{ label: string, color: string, bg: string } | null}
 */
export function getHcaBadge(hcaExpiration) {
  if (!hcaExpiration) return null;
  const exp = new Date(hcaExpiration + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffMs = exp - now;
  const diffDays = Math.ceil(diffMs / 86400000);

  if (diffDays < 0) {
    return { label: 'HCA Expired', color: '#DC3545', bg: '#FEF2F2' };
  }
  if (diffDays <= 30) {
    return { label: `HCA ${diffDays}d`, color: '#D97706', bg: '#FFFBEB' };
  }
  return null; // Not expiring soon — no badge needed
}
