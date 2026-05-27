// Helpers for sorting and labeling clients in pickers and filters.
//
// Schedulers think and talk about clients by last name ("Smith's Tuesday
// shift"), so list-style UIs sort by last name with first name as the
// tiebreaker. A handful of legacy rows only have a first name — they sort
// by first name and display without a comma.

function normalize(value) {
  return (typeof value === 'string' ? value : '').trim();
}

function sortKey(client) {
  const last = normalize(client?.lastName);
  const first = normalize(client?.firstName);
  // Fall back to first name when last is missing so the row still lands
  // somewhere predictable instead of clumping at the top.
  return [(last || first).toLowerCase(), first.toLowerCase(), client?.id || ''];
}

export function compareClientsByName(a, b) {
  const [aPrimary, aSecondary, aId] = sortKey(a);
  const [bPrimary, bSecondary, bId] = sortKey(b);
  if (aPrimary < bPrimary) return -1;
  if (aPrimary > bPrimary) return 1;
  if (aSecondary < bSecondary) return -1;
  if (aSecondary > bSecondary) return 1;
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

export function sortClientsByName(clients) {
  if (!Array.isArray(clients)) return [];
  return [...clients].sort(compareClientsByName);
}

// Display as "Last, First" — matches how schedulers scan a list. Falls
// back gracefully when one name is missing so we never render an empty
// row or a stray comma.
export function clientDisplayName(client) {
  const last = normalize(client?.lastName);
  const first = normalize(client?.firstName);
  if (last && first) return `${last}, ${first}`;
  if (last) return last;
  if (first) return first;
  return client?.id || '';
}
