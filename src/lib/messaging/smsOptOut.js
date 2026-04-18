// ═══════════════════════════════════════════════════════════════
// SMS Opt-Out Keyword Detection (TCPA Compliance)
//
// Pure function that classifies an inbound SMS body as an opt-out,
// opt-in, or neither. Used by the RingCentral webhook to auto-set
// the caregiver/client `sms_opted_out` flag.
//
// Keywords follow the CTIA / major-carrier standards:
//   Opt-out: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT
//   Opt-in:  START, UNSTOP, SUBSCRIBE, YES (in response to confirmation)
//
// We match on the FIRST token of the message (trimmed, uppercased)
// so a message that starts with a keyword counts, but casual use of
// "stop" inside a longer sentence does not. "STOP please" counts;
// "please don't stop texting me" does not.
// ═══════════════════════════════════════════════════════════════

const OPT_OUT_KEYWORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
]);

const OPT_IN_KEYWORDS = new Set([
  'START',
  'UNSTOP',
  'SUBSCRIBE',
]);

/**
 * Classify an inbound SMS message.
 *
 * @param {string} messageText  the raw inbound SMS body
 * @returns {'opt_out' | 'opt_in' | null}
 */
export function detectSmsOptOutIntent(messageText) {
  if (typeof messageText !== 'string') return null;
  const trimmed = messageText.trim();
  if (!trimmed) return null;

  // Take the first whitespace-separated token. Strip trailing punctuation
  // so "STOP." or "STOP!" still counts.
  const firstToken = trimmed.split(/\s+/)[0] || '';
  const cleaned = firstToken.replace(/[^\p{L}\p{N}]+$/u, '').toUpperCase();

  if (OPT_OUT_KEYWORDS.has(cleaned)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(cleaned)) return 'opt_in';
  return null;
}

/**
 * Standard TCPA-compliant confirmation message sent once when a
 * recipient successfully opts out. Carriers expect exactly one
 * final outbound message.
 */
export const OPT_OUT_CONFIRMATION_MESSAGE =
  'You have been unsubscribed and will no longer receive messages from Tremendous Care. Reply START to resubscribe.';

/**
 * Standard confirmation message when a recipient opts back in.
 */
export const OPT_IN_CONFIRMATION_MESSAGE =
  'You are resubscribed to Tremendous Care messages. Reply STOP to unsubscribe at any time.';
