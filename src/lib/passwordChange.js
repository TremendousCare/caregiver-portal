// ─── Password-change validation (pure) ───
// Shared 10-char minimum + match/different checks for the caregiver
// change-password form. Pure so the rules are unit-tested independently
// of the React component and its Supabase side effects.

export const MIN_PASSWORD_LEN = 10;

export function validatePasswordChange({ current = '', password = '', confirm = '' } = {}) {
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LEN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const sameAsOld = current.length > 0 && password.length > 0 && current === password;
  const canSubmit =
    current.length > 0 &&
    password.length >= MIN_PASSWORD_LEN &&
    password === confirm &&
    !sameAsOld;
  return { tooShort, mismatch, sameAsOld, canSubmit };
}
