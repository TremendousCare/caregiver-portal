// Phase 0.5 PR B — diff renderer unit tests.

import { describe, it, expect } from 'vitest';
import {
  diffManifest,
  isManifestUnchanged,
  buildUpdatePayload,
  unifiedLineDiff,
  fieldLabel,
  deepEqual,
} from '../../components/agentManifest/diff';

const baseAgent = {
  id: 'a1',
  org_id: 'o1',
  slug: 'recruiting',
  name: 'Recruiting Agent',
  version: 3,
  system_prompt: 'You are an AI.',
  tool_allowlist: ['send_sms', 'add_note'],
  autonomy_profile: { send_sms: { current_level: 'L2' } },
  context_recipe: { layers: ['identity', 'memories'] },
  model: 'claude-sonnet-4-5-20250929',
  max_iterations: 5,
  outcome_definition: { note: 'pending' },
  triggers: { invocation_modes: ['chat'] },
  kill_switch: false,
  shadow_mode: false,
};

describe('diffManifest', () => {
  it('returns empty diff when nothing changed', () => {
    const out = diffManifest(baseAgent, { ...baseAgent });
    expect(out).toEqual([]);
  });

  it('returns inline entry for name change', () => {
    const out = diffManifest(baseAgent, { ...baseAgent, name: 'New Name' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      field: 'name',
      kind: 'inline',
      before: 'Recruiting Agent',
      after: 'New Name',
    });
  });

  it('returns inline entry for max_iterations change', () => {
    const out = diffManifest(baseAgent, { ...baseAgent, max_iterations: 10 });
    expect(out[0]).toMatchObject({
      field: 'max_iterations',
      kind: 'inline',
      before: '5',
      after: '10',
    });
  });

  it('returns line-level diff for system_prompt change', () => {
    const before = { ...baseAgent, system_prompt: 'Line 1\nLine 2\nLine 3' };
    const after  = { ...baseAgent, system_prompt: 'Line 1\nLine 2 changed\nLine 3' };
    const out = diffManifest(before, after);
    expect(out).toHaveLength(1);
    expect(out[0].field).toBe('system_prompt');
    expect(out[0].kind).toBe('lines');
    const ops = out[0].lines.map(l => l.op);
    expect(ops).toContain('context');
    expect(ops).toContain('add');
    expect(ops).toContain('del');
  });

  it('returns added/removed columns for tool_allowlist change', () => {
    const out = diffManifest(
      baseAgent,
      { ...baseAgent, tool_allowlist: ['add_note', 'send_email'] },
    );
    expect(out[0]).toMatchObject({
      field: 'tool_allowlist',
      kind: 'allowlist',
    });
    expect(out[0].added).toEqual(['send_email']);
    expect(out[0].removed).toEqual(['send_sms']);
  });

  it('returns canonical-JSON line diff for autonomy_profile change', () => {
    const out = diffManifest(
      baseAgent,
      { ...baseAgent, autonomy_profile: { send_sms: { current_level: 'L3' } } },
    );
    expect(out[0]).toMatchObject({ field: 'autonomy_profile', kind: 'json' });
    expect(out[0].lines.some(l => l.op === 'add')).toBe(true);
    expect(out[0].lines.some(l => l.op === 'del')).toBe(true);
  });

  it('ignores changes to non-editable fields', () => {
    const out = diffManifest(
      baseAgent,
      {
        ...baseAgent,
        kill_switch: true,    // operational lever, not in EDITABLE_FIELDS
        shadow_mode: true,
        slug: 'changed',
        triggers: { invocation_modes: ['changed'] },
      },
    );
    expect(out).toEqual([]);
  });

  it('handles multiple field changes', () => {
    const out = diffManifest(
      baseAgent,
      { ...baseAgent, name: 'X', max_iterations: 7, model: 'claude-haiku-4-5-20251001' },
    );
    expect(out.map(e => e.field).sort()).toEqual(['max_iterations', 'model', 'name']);
  });
});

describe('isManifestUnchanged', () => {
  it('true when nothing changed', () => {
    expect(isManifestUnchanged(baseAgent, { ...baseAgent })).toBe(true);
  });
  it('false when one field changed', () => {
    expect(isManifestUnchanged(baseAgent, { ...baseAgent, name: 'X' })).toBe(false);
  });
});

describe('buildUpdatePayload', () => {
  it('includes only changed fields', () => {
    const payload = buildUpdatePayload(
      baseAgent,
      { ...baseAgent, name: 'X', max_iterations: 7 },
    );
    expect(Object.keys(payload).sort()).toEqual(['max_iterations', 'name']);
    expect(payload.name).toBe('X');
    expect(payload.max_iterations).toBe(7);
  });
  it('returns {} when nothing changed', () => {
    expect(buildUpdatePayload(baseAgent, { ...baseAgent })).toEqual({});
  });
  it('does NOT include non-editable changes (defense in depth — RPC also drops them)', () => {
    const payload = buildUpdatePayload(
      baseAgent,
      { ...baseAgent, kill_switch: true, shadow_mode: true, slug: 'x' },
    );
    expect(payload).toEqual({});
  });
});

describe('unifiedLineDiff', () => {
  it('returns all-context for identical inputs', () => {
    const out = unifiedLineDiff('a\nb\nc', 'a\nb\nc');
    expect(out.every(l => l.op === 'context')).toBe(true);
    expect(out.map(l => l.text)).toEqual(['a', 'b', 'c']);
  });
  it('marks added lines with op=add', () => {
    const out = unifiedLineDiff('a\nb', 'a\nNEW\nb');
    expect(out).toEqual([
      { op: 'context', text: 'a' },
      { op: 'add',     text: 'NEW' },
      { op: 'context', text: 'b' },
    ]);
  });
  it('marks deleted lines with op=del', () => {
    const out = unifiedLineDiff('a\nGONE\nb', 'a\nb');
    expect(out.find(l => l.op === 'del')).toMatchObject({ text: 'GONE' });
  });
  it('handles wholly different inputs as add+del', () => {
    const out = unifiedLineDiff('a\nb', 'x\ny');
    const ops = out.map(l => l.op);
    expect(ops).toContain('add');
    expect(ops).toContain('del');
  });
  it('handles empty before', () => {
    const out = unifiedLineDiff('', 'a\nb');
    // Empty string splits to ['']; the first iteration matches '' to ''
    // (context), then a/b are adds.
    const adds = out.filter(l => l.op === 'add').map(l => l.text);
    expect(adds).toEqual(['a', 'b']);
  });
  it('handles empty after', () => {
    const out = unifiedLineDiff('a\nb', '');
    const dels = out.filter(l => l.op === 'del').map(l => l.text);
    expect(dels).toEqual(['a', 'b']);
  });
});

describe('fieldLabel', () => {
  it('maps known fields to friendly labels', () => {
    expect(fieldLabel('system_prompt')).toBe('System prompt');
    expect(fieldLabel('tool_allowlist')).toBe('Tool allowlist');
    expect(fieldLabel('max_iterations')).toBe('Max iterations');
  });
  it('returns the field name unchanged for unknown', () => {
    expect(fieldLabel('zzz')).toBe('zzz');
  });
});

describe('deepEqual', () => {
  it('handles primitives, nested objects, and arrays', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});
