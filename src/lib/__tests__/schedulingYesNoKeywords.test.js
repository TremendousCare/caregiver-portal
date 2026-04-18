import { describe, it, expect } from 'vitest';
import {
  parseYesNoResponse,
  YES_KEYWORDS,
  NO_KEYWORDS,
} from '../../../supabase/functions/_shared/helpers/yesNoKeywords.ts';
import { parseYesNoResponse as parseFromBroadcastHelpers } from '../../features/scheduling/broadcastHelpers';

// ─── Keyword lists ─────────────────────────────────────────────

describe('YES_KEYWORDS / NO_KEYWORDS', () => {
  it('has no overlap between yes and no', () => {
    const overlap = [...YES_KEYWORDS].filter((k) => NO_KEYWORDS.has(k));
    expect(overlap).toEqual([]);
  });

  it('contains the common ways caregivers type YES', () => {
    for (const k of ['yes', 'y', 'yep', 'yeah', 'sure', 'ok', 'accept']) {
      expect(YES_KEYWORDS.has(k)).toBe(true);
    }
  });

  it('contains the common ways caregivers type NO', () => {
    for (const k of ['no', 'n', 'nope', 'nah', 'decline', 'pass', 'busy']) {
      expect(NO_KEYWORDS.has(k)).toBe(true);
    }
  });

  it('all keywords are lowercase (parseYesNoResponse lowercases the first word before lookup)', () => {
    for (const k of YES_KEYWORDS) expect(k).toBe(k.toLowerCase());
    for (const k of NO_KEYWORDS) expect(k).toBe(k.toLowerCase());
  });
});

// ─── parseYesNoResponse ────────────────────────────────────────

describe('parseYesNoResponse', () => {
  it('returns "maybe" for null / undefined / empty input', () => {
    expect(parseYesNoResponse(null)).toBe('maybe');
    expect(parseYesNoResponse(undefined)).toBe('maybe');
    expect(parseYesNoResponse('')).toBe('maybe');
    expect(parseYesNoResponse('   ')).toBe('maybe');
  });

  it('classifies "yes"/"y"/"yeah" as yes', () => {
    expect(parseYesNoResponse('yes')).toBe('yes');
    expect(parseYesNoResponse('Y')).toBe('yes');
    expect(parseYesNoResponse('Yeah')).toBe('yes');
  });

  it('classifies "no"/"n"/"nope" as no', () => {
    expect(parseYesNoResponse('no')).toBe('no');
    expect(parseYesNoResponse('N')).toBe('no');
    expect(parseYesNoResponse('Nope')).toBe('no');
  });

  it('ignores trailing punctuation and extra words', () => {
    expect(parseYesNoResponse('yes!')).toBe('yes');
    expect(parseYesNoResponse('YES please')).toBe('yes');
    expect(parseYesNoResponse('no thanks')).toBe('no');
    expect(parseYesNoResponse('yep, ill be there')).toBe('yes');
  });

  it('keeps apostrophes so "can\'t" is recognized as no', () => {
    expect(parseYesNoResponse("can't")).toBe('no');
    expect(parseYesNoResponse("Can't make it")).toBe('no');
  });

  it('returns "maybe" for ambiguous replies', () => {
    expect(parseYesNoResponse('maybe')).toBe('maybe');
    expect(parseYesNoResponse('let me check')).toBe('maybe');
    expect(parseYesNoResponse('123')).toBe('maybe');
    expect(parseYesNoResponse('...')).toBe('maybe');
  });

  it('handles non-string input gracefully', () => {
    expect(parseYesNoResponse(42)).toBe('maybe');
    expect(parseYesNoResponse({})).toBe('maybe');
    expect(parseYesNoResponse([])).toBe('maybe');
  });
});

// ─── Drift guard ───────────────────────────────────────────────
// The React broadcast helper and the edge function operation both
// re-export this module. If either side forks its own copy, this
// identity check will break — a deliberate canary.

describe('drift guard: broadcastHelpers.parseYesNoResponse === shared module', () => {
  it('is the same function reference', () => {
    expect(parseFromBroadcastHelpers).toBe(parseYesNoResponse);
  });
});
