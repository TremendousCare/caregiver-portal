import { describe, it, expect } from 'vitest';
import { isFilled } from '../../features/care-plans/SectionEditor';

// `isFilled` powers the "X / Y filled" counter in the accordion
// headers. It must return false for empty primitives but recognize
// the YN / PRN structured shapes as filled when they carry an answer.

describe('isFilled', () => {
  it('null and undefined are unfilled', () => {
    expect(isFilled(null)).toBe(false);
    expect(isFilled(undefined)).toBe(false);
  });

  it('empty and whitespace strings are unfilled', () => {
    expect(isFilled('')).toBe(false);
    expect(isFilled('   ')).toBe(false);
  });

  it('non-empty strings are filled', () => {
    expect(isFilled('hello')).toBe(true);
    expect(isFilled('0')).toBe(true);
  });

  it('empty arrays are unfilled, non-empty arrays are filled', () => {
    expect(isFilled([])).toBe(false);
    expect(isFilled(['Shower'])).toBe(true);
    expect(isFilled([{ method: 'Shower', level: 'Setup only' }])).toBe(true);
  });

  it('booleans always count as filled (false IS an answer)', () => {
    expect(isFilled(true)).toBe(true);
    expect(isFilled(false)).toBe(true);
  });

  it('numbers count as filled', () => {
    expect(isFilled(0)).toBe(true);
    expect(isFilled(7)).toBe(true);
  });

  it('YN shape: filled when answer is set', () => {
    expect(isFilled({ answer: 'Yes', note: '' })).toBe(true);
    expect(isFilled({ answer: 'No', note: 'maybe later' })).toBe(true);
    expect(isFilled({ answer: null, note: 'note without answer' })).toBe(false);
    expect(isFilled({ answer: '', note: '' })).toBe(false);
  });

  it('PRN shape: filled when flag is set', () => {
    expect(isFilled({ flag: 'P' })).toBe(true);
    expect(isFilled({ flag: 'R', option: 'Female' })).toBe(true);
    expect(isFilled({ flag: null })).toBe(false);
  });

  it('generic object: filled when at least one key has a non-empty value', () => {
    expect(isFilled({ a: null, b: '' })).toBe(false);
    expect(isFilled({ a: null, b: 'value' })).toBe(true);
  });
});
