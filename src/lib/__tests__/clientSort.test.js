import { describe, it, expect } from 'vitest';
import {
  sortClientsByName,
  compareClientsByName,
  clientDisplayName,
} from '../clientSort';

describe('sortClientsByName', () => {
  it('sorts by last name, case-insensitive', () => {
    const out = sortClientsByName([
      { id: '1', firstName: 'Janette', lastName: 'Clark' },
      { id: '2', firstName: 'Alexander', lastName: 'Barr' },
      { id: '3', firstName: 'Coye', lastName: 'sloan' },
    ]);
    expect(out.map((c) => c.id)).toEqual(['2', '1', '3']);
  });

  it('breaks ties on last name with first name', () => {
    const out = sortClientsByName([
      { id: '1', firstName: 'Mark', lastName: 'Fricker' },
      { id: '2', firstName: 'Phyllis', lastName: 'Fricker' },
    ]);
    expect(out.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('falls back to first name when last name is missing', () => {
    // "Angel" (last) sorts before "Johnny" (first-only client) which
    // sorts before "Smith" (last).
    const out = sortClientsByName([
      { id: '1', firstName: 'Jane', lastName: 'Smith' },
      { id: '2', firstName: 'Johnny' },
      { id: '3', firstName: 'Adrienne', lastName: 'Angel' },
    ]);
    expect(out.map((c) => c.id)).toEqual(['3', '2', '1']);
  });

  it('returns an empty array for non-array input', () => {
    expect(sortClientsByName(null)).toEqual([]);
    expect(sortClientsByName(undefined)).toEqual([]);
    expect(sortClientsByName('nope')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = [
      { id: '1', firstName: 'Zed', lastName: 'Z' },
      { id: '2', firstName: 'Ann', lastName: 'A' },
    ];
    const snapshot = input.slice();
    sortClientsByName(input);
    expect(input).toEqual(snapshot);
  });

  it('compareClientsByName is stable for identical names via id tiebreak', () => {
    const a = { id: 'a', firstName: 'Sam', lastName: 'Lee' };
    const b = { id: 'b', firstName: 'Sam', lastName: 'Lee' };
    expect(compareClientsByName(a, b)).toBeLessThan(0);
    expect(compareClientsByName(b, a)).toBeGreaterThan(0);
    expect(compareClientsByName(a, a)).toBe(0);
  });
});

describe('clientDisplayName', () => {
  it('renders "Last, First" when both are present', () => {
    expect(
      clientDisplayName({ firstName: 'Janette', lastName: 'Clark' }),
    ).toBe('Clark, Janette');
  });

  it('renders just the last name when first is missing', () => {
    expect(clientDisplayName({ lastName: 'Clark' })).toBe('Clark');
  });

  it('renders just the first name when last is missing', () => {
    expect(clientDisplayName({ firstName: 'Johnny' })).toBe('Johnny');
  });

  it('falls back to the id when both names are missing', () => {
    expect(clientDisplayName({ id: 'abc-123' })).toBe('abc-123');
  });

  it('returns empty string for empty input', () => {
    expect(clientDisplayName({})).toBe('');
    expect(clientDisplayName(null)).toBe('');
  });

  it('trims whitespace from names', () => {
    expect(
      clientDisplayName({ firstName: '  Jane  ', lastName: '  Doe ' }),
    ).toBe('Doe, Jane');
  });
});
