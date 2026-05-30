import { describe, it, expect } from 'vitest';
import { validatePasswordChange, MIN_PASSWORD_LEN } from '../passwordChange';

describe('validatePasswordChange', () => {
  it('cannot submit with empty fields', () => {
    expect(validatePasswordChange().canSubmit).toBe(false);
    expect(validatePasswordChange({}).canSubmit).toBe(false);
  });

  it('flags a too-short new password', () => {
    const r = validatePasswordChange({ current: 'oldpassword1', password: 'short', confirm: 'short' });
    expect(r.tooShort).toBe(true);
    expect(r.canSubmit).toBe(false);
  });

  it('flags mismatched confirmation', () => {
    const r = validatePasswordChange({ current: 'oldpassword1', password: 'newpassword1', confirm: 'newpassword2' });
    expect(r.mismatch).toBe(true);
    expect(r.canSubmit).toBe(false);
  });

  it('flags a new password identical to the current one', () => {
    const r = validatePasswordChange({ current: 'samepassword1', password: 'samepassword1', confirm: 'samepassword1' });
    expect(r.sameAsOld).toBe(true);
    expect(r.canSubmit).toBe(false);
  });

  it('allows submit when current is set, new is long enough, matches, and differs', () => {
    const r = validatePasswordChange({ current: 'oldpassword1', password: 'brandnewpass', confirm: 'brandnewpass' });
    expect(r).toMatchObject({ tooShort: false, mismatch: false, sameAsOld: false, canSubmit: true });
  });

  it('requires the current password to be present', () => {
    const r = validatePasswordChange({ current: '', password: 'brandnewpass', confirm: 'brandnewpass' });
    expect(r.canSubmit).toBe(false);
  });

  it('uses a 10-char minimum', () => {
    expect(MIN_PASSWORD_LEN).toBe(10);
    expect(validatePasswordChange({ current: 'x'.repeat(10), password: '1234567890', confirm: '1234567890' }).canSubmit).toBe(true);
  });
});
