import { describe, it, expect } from 'vitest';
import { generateCaregiverPassword } from '../caregiverPassword';

describe('generateCaregiverPassword', () => {
  it('generates a 12-character password by default', () => {
    const pw = generateCaregiverPassword();
    expect(pw).toHaveLength(12);
  });

  it('honors the requested length', () => {
    expect(generateCaregiverPassword(16)).toHaveLength(16);
    expect(generateCaregiverPassword(10)).toHaveLength(10);
  });

  it('rejects lengths below 10', () => {
    expect(() => generateCaregiverPassword(9)).toThrow(/at least 10/);
  });

  it('contains at least one lowercase, uppercase, and digit', () => {
    for (let i = 0; i < 50; i += 1) {
      const pw = generateCaregiverPassword();
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it('never includes visually ambiguous characters (0, O, 1, l, I)', () => {
    for (let i = 0; i < 50; i += 1) {
      const pw = generateCaregiverPassword(16);
      expect(pw).not.toMatch(/[0O1lI]/);
    }
  });

  it('produces different passwords on repeat calls', () => {
    const seen = new Set();
    for (let i = 0; i < 20; i += 1) seen.add(generateCaregiverPassword());
    expect(seen.size).toBeGreaterThan(1);
  });
});
