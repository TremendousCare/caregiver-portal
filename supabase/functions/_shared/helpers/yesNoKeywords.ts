// ═══════════════════════════════════════════════════════════════
// Yes / No / Maybe SMS reply classification
//
// Single source of truth for the first-word keyword sets the portal
// uses to decide whether a caregiver's SMS reply to a shift offer is
// an accept, a decline, or ambiguous. Imported from:
//
//   1. supabase/functions/_shared/operations/shiftOfferMatching.ts
//      (edge function that runs when an inbound SMS arrives)
//   2. src/features/scheduling/broadcastHelpers.js
//      (browser-side preview / manual classification)
//
// Prior to this file existing, both callers kept their own private
// copy of the keyword sets, with a comment warning "if you change
// one list, change the other." Drift was a real risk.
// ═══════════════════════════════════════════════════════════════

export type YesNoResponse = 'yes' | 'no' | 'maybe';

export const YES_KEYWORDS: ReadonlySet<string> = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay', 'accept', 'accepted',
  'yeahh', 'ya', 'affirmative', 'absolutely', 'yesyes',
]);

export const NO_KEYWORDS: ReadonlySet<string> = new Set([
  'no', 'n', 'nope', 'nah', 'cant', "can't", 'cannot', 'decline', 'declined',
  'pass', 'unable', 'busy',
]);

/**
 * Classify a caregiver's reply text.
 *
 * Rules (deliberately simple so the result is predictable):
 *   - "yes" if the first word (letters + apostrophe only) is in YES_KEYWORDS
 *   - "no"  if the first word is in NO_KEYWORDS
 *   - "maybe" otherwise — including empty / null input
 *
 * Case-insensitive. Keeps apostrophes so "can't" stays intact.
 */
export function parseYesNoResponse(text: string | null | undefined): YesNoResponse {
  if (!text || typeof text !== 'string') return 'maybe';
  const trimmed = text.trim();
  if (!trimmed) return 'maybe';
  const match = trimmed.match(/^[a-zA-Z']+/);
  if (!match) return 'maybe';
  const firstWord = match[0].toLowerCase();
  if (YES_KEYWORDS.has(firstWord)) return 'yes';
  if (NO_KEYWORDS.has(firstWord)) return 'no';
  return 'maybe';
}
