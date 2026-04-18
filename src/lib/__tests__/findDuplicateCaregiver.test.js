import { describe, it, expect } from 'vitest';
import { findDuplicateCaregiver } from '../utils';

const makeCg = (overrides = {}) => ({
  id: crypto.randomUUID(),
  firstName: 'Jane',
  lastName: 'Doe',
  phone: '9495551234',
  archived: false,
  ...overrides,
});

describe('findDuplicateCaregiver', () => {
  it('returns null when there is no match', () => {
    const existing = [makeCg({ firstName: 'Other', lastName: 'Person', phone: '7145550000' })];
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '9495551234' },
      existing
    );
    expect(result).toBeNull();
  });

  it('matches on exact first name, last name, and phone', () => {
    const target = makeCg({ firstName: 'Jane', lastName: 'Doe', phone: '9495551234' });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '9495551234' },
      [target]
    );
    expect(result).toBe(target);
  });

  it('is case-insensitive on name', () => {
    const target = makeCg({ firstName: 'Jane', lastName: 'Doe' });
    const result = findDuplicateCaregiver(
      { firstName: 'JANE', lastName: 'doe', phone: '9495551234' },
      [target]
    );
    expect(result).toBe(target);
  });

  it('ignores whitespace in names', () => {
    const target = makeCg({ firstName: 'Jane', lastName: 'Doe' });
    const result = findDuplicateCaregiver(
      { firstName: '  Jane ', lastName: 'Doe  ', phone: '9495551234' },
      [target]
    );
    expect(result).toBe(target);
  });

  it('normalizes phone formatting (parens, dashes, spaces)', () => {
    const target = makeCg({ phone: '9495551234' });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '(949) 555-1234' },
      [target]
    );
    expect(result).toBe(target);
  });

  it('strips leading US country code "1" when normalizing', () => {
    const target = makeCg({ phone: '9495551234' });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '+1 949 555 1234' },
      [target]
    );
    expect(result).toBe(target);
  });

  it('does NOT match if only name matches but phone differs', () => {
    const target = makeCg({ firstName: 'Jane', lastName: 'Doe', phone: '1111111111' });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '9495551234' },
      [target]
    );
    expect(result).toBeNull();
  });

  it('does NOT match if only phone matches but name differs', () => {
    const target = makeCg({ firstName: 'Someone', lastName: 'Else', phone: '9495551234' });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '9495551234' },
      [target]
    );
    expect(result).toBeNull();
  });

  it('returns null when input is missing firstName', () => {
    const target = makeCg();
    expect(findDuplicateCaregiver({ firstName: '', lastName: 'Doe', phone: '9495551234' }, [target])).toBeNull();
  });

  it('returns null when input is missing lastName', () => {
    const target = makeCg();
    expect(findDuplicateCaregiver({ firstName: 'Jane', lastName: '', phone: '9495551234' }, [target])).toBeNull();
  });

  it('returns null when input is missing phone', () => {
    const target = makeCg();
    expect(findDuplicateCaregiver({ firstName: 'Jane', lastName: 'Doe', phone: '' }, [target])).toBeNull();
  });

  it('ignores archived caregivers', () => {
    const archived = makeCg({ archived: true });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '9495551234' },
      [archived]
    );
    expect(result).toBeNull();
  });

  it('returns the first non-archived match when multiple archived dups exist', () => {
    const active = makeCg({ id: 'active' });
    const archived = makeCg({ id: 'archived', archived: true });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '9495551234' },
      [archived, active]
    );
    expect(result).toBe(active);
  });

  it('handles caregivers with missing phone gracefully', () => {
    const cg = makeCg({ phone: '' });
    const result = findDuplicateCaregiver(
      { firstName: 'Jane', lastName: 'Doe', phone: '9495551234' },
      [cg]
    );
    expect(result).toBeNull();
  });
});
