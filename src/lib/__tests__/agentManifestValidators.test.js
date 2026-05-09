// Phase 0.5 PR B — validator unit tests.

import { describe, it, expect } from 'vitest';
import {
  validateName,
  validateSystemPrompt,
  validateMaxIterations,
  validateModel,
  validateToolAllowlist,
  validateAutonomyProfile,
  validateJsonObject,
  parseJsonText,
} from '../../components/agentManifest/validators';

describe('validateName', () => {
  it('accepts a normal name', () => {
    expect(validateName('Recruiting Agent')).toEqual({ ok: true });
  });
  it('rejects empty / whitespace-only', () => {
    expect(validateName('').ok).toBe(false);
    expect(validateName('   ').ok).toBe(false);
  });
  it('rejects non-string', () => {
    expect(validateName(null).ok).toBe(false);
    expect(validateName(123).ok).toBe(false);
  });
  it('rejects > 200 characters', () => {
    expect(validateName('x'.repeat(201)).ok).toBe(false);
  });
});

describe('validateSystemPrompt', () => {
  it('accepts non-empty', () => {
    expect(validateSystemPrompt('You are an AI...').ok).toBe(true);
  });
  it('rejects empty (DB CHECK)', () => {
    expect(validateSystemPrompt('').ok).toBe(false);
    expect(validateSystemPrompt('   ').ok).toBe(false);
  });
});

describe('validateMaxIterations', () => {
  it('accepts integers >= 1', () => {
    expect(validateMaxIterations(1).ok).toBe(true);
    expect(validateMaxIterations(5).ok).toBe(true);
    expect(validateMaxIterations(50).ok).toBe(true);
  });
  it('rejects 0 / negative', () => {
    expect(validateMaxIterations(0).ok).toBe(false);
    expect(validateMaxIterations(-1).ok).toBe(false);
  });
  it('rejects > 50 (cost guard)', () => {
    expect(validateMaxIterations(51).ok).toBe(false);
  });
  it('rejects non-integer', () => {
    expect(validateMaxIterations(1.5).ok).toBe(false);
    expect(validateMaxIterations('5').ok).toBe(true); // coerced via Number()
    expect(validateMaxIterations('abc').ok).toBe(false);
  });
});

describe('validateModel', () => {
  it('accepts known-good models silently', () => {
    const r = validateModel('claude-sonnet-4-5-20250929');
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });
  it('locked D2: free-text accepted with non-blocking warning if unknown', () => {
    const r = validateModel('claude-future-7-9-20290101');
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/not in the known-good list/);
  });
  it('rejects empty', () => {
    expect(validateModel('').ok).toBe(false);
  });
});

describe('validateToolAllowlist', () => {
  const known = ['send_sms', 'send_email', 'add_note', 'update_phase'];

  it('accepts a subset of known tools', () => {
    expect(validateToolAllowlist(['send_sms', 'add_note'], known).ok).toBe(true);
  });
  it('accepts an empty list', () => {
    expect(validateToolAllowlist([], known).ok).toBe(true);
  });
  it('rejects unknown tools', () => {
    const r = validateToolAllowlist(['send_telepath'], known);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/send_telepath/);
  });
  it('rejects duplicates', () => {
    const r = validateToolAllowlist(['send_sms', 'send_sms'], known);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Duplicate/);
  });
  it('rejects non-array', () => {
    expect(validateToolAllowlist('send_sms', known).ok).toBe(false);
  });
});

describe('validateAutonomyProfile', () => {
  it('accepts the seed shape', () => {
    const profile = {
      send_sms: { current_level: 'L2' },
      add_note: { current_level: 'L4' },
    };
    expect(validateAutonomyProfile(profile).ok).toBe(true);
  });
  it('accepts empty object', () => {
    expect(validateAutonomyProfile({}).ok).toBe(true);
  });
  it('rejects array', () => {
    expect(validateAutonomyProfile([]).ok).toBe(false);
  });
  it('rejects missing current_level', () => {
    const r = validateAutonomyProfile({ send_sms: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing "current_level"/);
  });
  it('rejects invalid level', () => {
    const r = validateAutonomyProfile({ send_sms: { current_level: 'L9' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/L1, L2, L3, or L4/);
  });
});

describe('validateJsonObject', () => {
  it('accepts plain objects', () => {
    expect(validateJsonObject({ a: 1 }).ok).toBe(true);
  });
  it('accepts null/undefined (column has DEFAULT)', () => {
    expect(validateJsonObject(null).ok).toBe(true);
    expect(validateJsonObject(undefined).ok).toBe(true);
  });
  it('rejects array', () => {
    expect(validateJsonObject([]).ok).toBe(false);
  });
  it('rejects scalar', () => {
    expect(validateJsonObject(42).ok).toBe(false);
  });
});

describe('parseJsonText', () => {
  it('parses valid JSON object', () => {
    expect(parseJsonText('{"x": 1}')).toEqual({ ok: true, value: { x: 1 } });
  });
  it('treats empty/whitespace as {}', () => {
    expect(parseJsonText('')).toEqual({ ok: true, value: {} });
    expect(parseJsonText('   ')).toEqual({ ok: true, value: {} });
  });
  it('rejects invalid JSON', () => {
    const r = parseJsonText('{not json}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid JSON/);
  });
  it('rejects arrays + scalars + null', () => {
    expect(parseJsonText('[1,2]').ok).toBe(false);
    expect(parseJsonText('42').ok).toBe(false);
    expect(parseJsonText('null').ok).toBe(false);
    expect(parseJsonText('"x"').ok).toBe(false);
  });
});
