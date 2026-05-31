import { describe, it, expect } from 'vitest';
import { isReservedRoute, isOfficeRoute } from '../routeScope';

describe('isReservedRoute', () => {
  it('matches caregiver routes (exact and nested)', () => {
    expect(isReservedRoute('/care')).toBe(true);
    expect(isReservedRoute('/care/shifts')).toBe(true);
  });

  it('matches BD routes', () => {
    expect(isReservedRoute('/bd')).toBe(true);
    expect(isReservedRoute('/bd/leads')).toBe(true);
  });

  it('matches public token surfaces', () => {
    expect(isReservedRoute('/apply')).toBe(true);
    expect(isReservedRoute('/upload/abc123')).toBe(true);
    expect(isReservedRoute('/sign/tok')).toBe(true);
    expect(isReservedRoute('/survey/tok')).toBe(true);
  });

  it('does NOT match admin routes that merely start with a reserved word', () => {
    // `/caregiver/:id` is an ADMIN route — it must not be treated as the
    // caregiver PWA. This is the exact bug the App.jsx comment warns about.
    expect(isReservedRoute('/caregiver/123')).toBe(false);
    expect(isReservedRoute('/applications')).toBe(false);
  });

  it('does not match office routes', () => {
    expect(isReservedRoute('/')).toBe(false);
    expect(isReservedRoute('/dashboard')).toBe(false);
    expect(isReservedRoute('/clients')).toBe(false);
  });

  it('handles empty/missing input', () => {
    expect(isReservedRoute()).toBe(false);
    expect(isReservedRoute('')).toBe(false);
  });
});

describe('isOfficeRoute', () => {
  it('is the inverse of isReservedRoute', () => {
    expect(isOfficeRoute('/')).toBe(true);
    expect(isOfficeRoute('/dashboard')).toBe(true);
    expect(isOfficeRoute('/caregiver/123')).toBe(true);
    expect(isOfficeRoute('/care')).toBe(false);
    expect(isOfficeRoute('/bd')).toBe(false);
    expect(isOfficeRoute('/apply')).toBe(false);
  });
});
