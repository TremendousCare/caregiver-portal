import { describe, it, expect } from 'vitest';
import {
  groupCheckboxFields,
  isRadioGroupMember,
  getRequiredGroupViolations,
  normalizeCheckboxGroups,
} from '../esignCheckboxGroups.js';

const checkbox = (id, group = '', required = false, page = 1) => ({
  id, type: 'checkbox', group, required, page, x: 0, y: 0, w: 14, h: 14,
});

describe('groupCheckboxFields', () => {
  it('groups checkboxes by their group name', () => {
    const fields = [
      checkbox('a', 'status'),
      checkbox('b', 'status'),
      checkbox('c', 'other'),
    ];
    const groups = groupCheckboxFields(fields);
    expect(groups.get('status').map((f) => f.id)).toEqual(['a', 'b']);
    expect(groups.get('other').map((f) => f.id)).toEqual(['c']);
  });

  it('ignores ungrouped checkboxes (undefined, empty string, whitespace)', () => {
    const fields = [
      { id: 'a', type: 'checkbox', page: 1 },
      checkbox('b', ''),
      checkbox('c', '   '),
      checkbox('d', 'real'),
    ];
    const groups = groupCheckboxFields(fields);
    expect([...groups.keys()]).toEqual(['real']);
    expect(groups.get('real').map((f) => f.id)).toEqual(['d']);
  });

  it('ignores non-checkbox field types even if they have a group property', () => {
    const fields = [
      { id: 's', type: 'signature', group: 'status' },
      checkbox('a', 'status'),
    ];
    const groups = groupCheckboxFields(fields);
    expect(groups.get('status').map((f) => f.id)).toEqual(['a']);
  });

  it('preserves field declaration order within a group', () => {
    const fields = [
      checkbox('third', 'g'),
      checkbox('first', 'g'),
      checkbox('second', 'g'),
    ];
    expect(groupCheckboxFields(fields).get('g').map((f) => f.id))
      .toEqual(['third', 'first', 'second']);
  });

  it('returns an empty Map when given null or empty fields', () => {
    expect(groupCheckboxFields(null).size).toBe(0);
    expect(groupCheckboxFields([]).size).toBe(0);
  });
});

describe('isRadioGroupMember', () => {
  it('is true for a checkbox in a group with 2+ members', () => {
    const fields = [checkbox('a', 'g'), checkbox('b', 'g')];
    expect(isRadioGroupMember(fields[0], fields)).toBe(true);
  });

  it('is false for a single-member group (renders as a normal checkbox)', () => {
    const fields = [checkbox('only', 'lonely')];
    expect(isRadioGroupMember(fields[0], fields)).toBe(false);
  });

  it('is false for ungrouped checkboxes', () => {
    const fields = [checkbox('a', ''), checkbox('b', 'g'), checkbox('c', 'g')];
    expect(isRadioGroupMember(fields[0], fields)).toBe(false);
  });

  it('is false for non-checkbox fields with a group property', () => {
    const sig = { id: 's', type: 'signature', group: 'g' };
    const fields = [sig, checkbox('a', 'g'), checkbox('b', 'g')];
    expect(isRadioGroupMember(sig, fields)).toBe(false);
  });
});

describe('getRequiredGroupViolations', () => {
  it('reports a violation when a required group has zero selections', () => {
    const fields = [
      checkbox('single', 'status', true),
      checkbox('married', 'status', false),
      checkbox('hoh', 'status', false),
    ];
    const violations = getRequiredGroupViolations(fields, {});
    expect(violations).toHaveLength(1);
    expect(violations[0].groupName).toBe('status');
    expect(violations[0].fieldId).toBe('single');
  });

  it('passes when any member of a required group is checked', () => {
    const fields = [
      checkbox('single', 'status', true),
      checkbox('married', 'status', false),
    ];
    expect(getRequiredGroupViolations(fields, { married: true })).toEqual([]);
  });

  it('accepts the string "true" as a checked value (mobile/DOM fallback)', () => {
    const fields = [checkbox('a', 'g', true), checkbox('b', 'g')];
    expect(getRequiredGroupViolations(fields, { a: 'true' })).toEqual([]);
  });

  it('does not report violations for optional groups', () => {
    const fields = [checkbox('a', 'opts'), checkbox('b', 'opts')];
    expect(getRequiredGroupViolations(fields, {})).toEqual([]);
  });

  it('independently reports violations across multiple groups', () => {
    const fields = [
      checkbox('a1', 'status', true),
      checkbox('a2', 'status', false),
      checkbox('b1', 'consent', true),
      checkbox('b2', 'consent', false),
    ];
    const violations = getRequiredGroupViolations(fields, { a2: true });
    expect(violations.map((v) => v.groupName)).toEqual(['consent']);
  });

  it('considers a group required when any member is marked required', () => {
    // Second member is required; first is not. Group is still required.
    const fields = [checkbox('a', 'g', false), checkbox('b', 'g', true)];
    const violations = getRequiredGroupViolations(fields, {});
    expect(violations).toHaveLength(1);
  });

  it('handles null/undefined values', () => {
    const fields = [checkbox('a', 'g', true)];
    expect(getRequiredGroupViolations(fields, null)).toHaveLength(1);
    expect(getRequiredGroupViolations(fields, undefined)).toHaveLength(1);
  });
});

describe('normalizeCheckboxGroups', () => {
  it('keeps the first checked member and clears the rest', () => {
    const fields = [
      checkbox('a', 'g'),
      checkbox('b', 'g'),
      checkbox('c', 'g'),
    ];
    const { values, corrections } = normalizeCheckboxGroups(fields, {
      a: true, b: true, c: true,
    });
    expect(values).toEqual({ a: true, b: false, c: false });
    expect(corrections).toEqual([
      { groupName: 'g', keptFieldId: 'a', clearedFieldIds: ['b', 'c'] },
    ]);
  });

  it('uses field declaration order to pick the winner, not value-insertion order', () => {
    const fields = [checkbox('first', 'g'), checkbox('second', 'g')];
    const { values } = normalizeCheckboxGroups(fields, { second: true, first: true });
    expect(values).toEqual({ first: true, second: false });
  });

  it('leaves a group untouched when it already has exactly one selection', () => {
    const fields = [checkbox('a', 'g'), checkbox('b', 'g')];
    const { values, corrections } = normalizeCheckboxGroups(fields, { b: true });
    expect(values).toEqual({ b: true });
    expect(corrections).toEqual([]);
  });

  it('leaves a group untouched when it has zero selections', () => {
    const fields = [checkbox('a', 'g'), checkbox('b', 'g')];
    const { values, corrections } = normalizeCheckboxGroups(fields, {});
    expect(values).toEqual({});
    expect(corrections).toEqual([]);
  });

  it('does not touch ungrouped checkboxes, even if multiple are true', () => {
    const fields = [checkbox('a', ''), checkbox('b', ''), checkbox('c', 'g'), checkbox('d', 'g')];
    const { values, corrections } = normalizeCheckboxGroups(fields, {
      a: true, b: true, c: true, d: true,
    });
    expect(values.a).toBe(true);
    expect(values.b).toBe(true);
    expect(values.c).toBe(true);
    expect(values.d).toBe(false);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].groupName).toBe('g');
  });

  it('normalizes independently across multiple groups', () => {
    const fields = [
      checkbox('a1', 'g1'), checkbox('a2', 'g1'),
      checkbox('b1', 'g2'), checkbox('b2', 'g2'),
    ];
    const { values, corrections } = normalizeCheckboxGroups(fields, {
      a1: true, a2: true, b1: true, b2: true,
    });
    expect(values).toEqual({ a1: true, a2: false, b1: true, b2: false });
    expect(corrections.map((c) => c.groupName).sort()).toEqual(['g1', 'g2']);
  });

  it('treats string "true" the same as boolean true when picking winners', () => {
    const fields = [checkbox('a', 'g'), checkbox('b', 'g')];
    const { values, corrections } = normalizeCheckboxGroups(fields, { a: 'true', b: true });
    expect(values).toEqual({ a: 'true', b: false });
    expect(corrections[0].keptFieldId).toBe('a');
  });

  it('does not mutate the input values object', () => {
    const fields = [checkbox('a', 'g'), checkbox('b', 'g')];
    const input = { a: true, b: true };
    normalizeCheckboxGroups(fields, input);
    expect(input).toEqual({ a: true, b: true });
  });

  it('passes through an empty values object unchanged', () => {
    const fields = [checkbox('a', 'g'), checkbox('b', 'g')];
    const { values } = normalizeCheckboxGroups(fields, {});
    expect(values).toEqual({});
  });
});
