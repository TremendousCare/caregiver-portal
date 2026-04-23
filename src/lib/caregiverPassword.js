// Generates memorable temporary passwords for admin-initiated caregiver
// invites. The admin hands these to the caregiver out-of-band; the
// caregiver can change it later via "Forgot password?". We avoid
// visually ambiguous characters (0/O, 1/l/I) to cut read-aloud mistakes.

const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const ALL = LOWER + UPPER + DIGITS;

function randomInt(maxExclusive) {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function pick(charset) {
  return charset.charAt(randomInt(charset.length));
}

export function generateCaregiverPassword(length = 12) {
  if (length < 10) throw new Error('Password length must be at least 10.');
  // Guarantee at least one of each character class so the result
  // satisfies any reasonable password policy.
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  const rest = [];
  for (let i = required.length; i < length; i += 1) {
    rest.push(pick(ALL));
  }
  const chars = [...required, ...rest];
  // Fisher-Yates shuffle so the required classes aren't always at the start.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
