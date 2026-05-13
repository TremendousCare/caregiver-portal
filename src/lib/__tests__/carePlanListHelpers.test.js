import { describe, it, expect } from 'vitest';
import { moveRowDown, moveRowUp } from '../../features/care-plans/listHelpers';

// Pure-function tests for the LIST row reorder helpers used by the
// emergency-contacts call-order UI on the Care Team section.

describe('moveRowUp', () => {
  it('swaps row with the one above it', () => {
    const rows = [{ n: 'A' }, { n: 'B' }, { n: 'C' }];
    expect(moveRowUp(rows, 1)).toEqual([{ n: 'B' }, { n: 'A' }, { n: 'C' }]);
    expect(moveRowUp(rows, 2)).toEqual([{ n: 'A' }, { n: 'C' }, { n: 'B' }]);
  });

  it('is a no-op when called on the first row', () => {
    const rows = [{ n: 'A' }, { n: 'B' }];
    expect(moveRowUp(rows, 0)).toBe(rows);
  });

  it('is a no-op for out-of-range indices', () => {
    const rows = [{ n: 'A' }, { n: 'B' }];
    expect(moveRowUp(rows, -1)).toBe(rows);
    expect(moveRowUp(rows, 99)).toBe(rows);
  });

  it('returns a new array reference (does not mutate input)', () => {
    const rows = [{ n: 'A' }, { n: 'B' }];
    const out = moveRowUp(rows, 1);
    expect(out).not.toBe(rows);
    expect(rows).toEqual([{ n: 'A' }, { n: 'B' }]);
  });

  it('safely returns input when rows is not an array', () => {
    expect(moveRowUp(null, 1)).toBe(null);
    expect(moveRowUp(undefined, 1)).toBe(undefined);
  });
});

describe('moveRowDown', () => {
  it('swaps row with the one below it', () => {
    const rows = [{ n: 'A' }, { n: 'B' }, { n: 'C' }];
    expect(moveRowDown(rows, 0)).toEqual([{ n: 'B' }, { n: 'A' }, { n: 'C' }]);
    expect(moveRowDown(rows, 1)).toEqual([{ n: 'A' }, { n: 'C' }, { n: 'B' }]);
  });

  it('is a no-op when called on the last row', () => {
    const rows = [{ n: 'A' }, { n: 'B' }];
    expect(moveRowDown(rows, 1)).toBe(rows);
  });

  it('is a no-op for out-of-range indices', () => {
    const rows = [{ n: 'A' }, { n: 'B' }];
    expect(moveRowDown(rows, -1)).toBe(rows);
    expect(moveRowDown(rows, 99)).toBe(rows);
  });

  it('returns a new array reference (does not mutate input)', () => {
    const rows = [{ n: 'A' }, { n: 'B' }];
    const out = moveRowDown(rows, 0);
    expect(out).not.toBe(rows);
    expect(rows).toEqual([{ n: 'A' }, { n: 'B' }]);
  });
});
