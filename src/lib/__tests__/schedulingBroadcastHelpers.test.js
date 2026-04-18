import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BROADCAST_TEMPLATE,
  DEFAULT_REPLY_INSTRUCTION,
  DEFAULT_CONFIRMATION_TEMPLATE,
  buildMergeFields,
  renderTemplate,
  renderDefaultBroadcastMessage,
  renderConfirmationMessage,
  validateBroadcastDraft,
  parseYesNoResponse,
} from '../../features/scheduling/broadcastHelpers';

// ─── Test data ─────────────────────────────────────────────────

// Use a local-time Date → ISO to avoid timezone drift in CI
function localIso(y, mo, d, h, mi = 0) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

const baseShift = {
  id: 'shift-1',
  clientId: 'client-a',
  assignedCaregiverId: null,
  startTime: localIso(2026, 5, 4, 8), // Mon May 4 2026 8:00 local
  endTime: localIso(2026, 5, 4, 12), // Mon May 4 2026 12:00 local
  status: 'open',
  locationAddress: '123 Main St, Bellevue, WA',
};

const baseCaregiver = {
  id: 'cg-maria',
  firstName: 'Maria',
  lastName: 'Garcia',
};

const baseClient = {
  id: 'client-a',
  firstName: 'Alice',
  lastName: 'Johnson',
  careRecipientName: 'Alice Johnson',
  address: '123 Main St',
  city: 'Bellevue',
  state: 'WA',
  zip: '98004',
};

// ─── Constants ─────────────────────────────────────────────────

describe('DEFAULT_BROADCAST_TEMPLATE', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_BROADCAST_TEMPLATE).toBe('string');
    expect(DEFAULT_BROADCAST_TEMPLATE.length).toBeGreaterThan(0);
  });

  it('includes the key merge fields', () => {
    expect(DEFAULT_BROADCAST_TEMPLATE).toContain('{{firstName}}');
    expect(DEFAULT_BROADCAST_TEMPLATE).toContain('{{clientName}}');
    expect(DEFAULT_BROADCAST_TEMPLATE).toContain('{{location}}');
    expect(DEFAULT_BROADCAST_TEMPLATE).toContain('{{timeRange}}');
    expect(DEFAULT_BROADCAST_TEMPLATE).toContain('{{replyInstruction}}');
  });
});

// ─── buildMergeFields ──────────────────────────────────────────

describe('buildMergeFields', () => {
  it('returns default placeholders for empty input', () => {
    const fields = buildMergeFields({});
    expect(fields.firstName).toBe('');
    expect(fields.clientName).toBe('your client');
    expect(fields.location).toBe('their home');
    expect(fields.replyInstruction).toBe(DEFAULT_REPLY_INSTRUCTION);
  });

  it('fills caregiver name fields', () => {
    const fields = buildMergeFields({ caregiver: baseCaregiver });
    expect(fields.firstName).toBe('Maria');
    expect(fields.lastName).toBe('Garcia');
  });

  it('fills client name', () => {
    const fields = buildMergeFields({ client: baseClient });
    expect(fields.clientName).toBe('Alice Johnson');
  });

  it('uses care recipient name when different from client', () => {
    const fields = buildMergeFields({
      client: { ...baseClient, careRecipientName: 'Grandma Alice' },
    });
    expect(fields.careRecipient).toBe('Grandma Alice');
  });

  it('falls back to "your client" when no client provided', () => {
    const fields = buildMergeFields({});
    expect(fields.clientName).toBe('your client');
    expect(fields.careRecipient).toBe('your client');
  });

  it('formats dayOfWeek, dateLabel, startTime, endTime, timeRange, duration', () => {
    const fields = buildMergeFields({ shift: baseShift });
    expect(fields.dayOfWeek).toBe('Mon');
    expect(fields.dateLabel).toBe('May 4');
    expect(fields.startTime).toBe('8:00a');
    expect(fields.endTime).toBe('12:00p');
    expect(fields.timeRange).toBe('8:00a-12:00p');
    expect(fields.duration).toBe('4h');
  });

  it('formats a fractional duration', () => {
    const shift = {
      ...baseShift,
      startTime: localIso(2026, 5, 4, 8),
      endTime: localIso(2026, 5, 4, 9, 30),
    };
    const fields = buildMergeFields({ shift });
    expect(fields.duration).toBe('1.5h');
  });

  it('formats a sub-hour duration in minutes', () => {
    const shift = {
      ...baseShift,
      startTime: localIso(2026, 5, 4, 8),
      endTime: localIso(2026, 5, 4, 8, 45),
    };
    const fields = buildMergeFields({ shift });
    expect(fields.duration).toBe('45m');
  });

  it('prefers shift.locationAddress when set', () => {
    const fields = buildMergeFields({ shift: baseShift, client: baseClient });
    expect(fields.location).toBe('123 Main St, Bellevue, WA');
  });

  it('falls back to client address fields when shift has no locationAddress', () => {
    const shift = { ...baseShift, locationAddress: null };
    const fields = buildMergeFields({ shift, client: baseClient });
    expect(fields.location).toContain('123 Main St');
    expect(fields.location).toContain('Bellevue');
  });

  it('falls back to "their home" when neither shift nor client has an address', () => {
    const shift = { ...baseShift, locationAddress: null };
    const client = { firstName: 'Alice', lastName: 'Johnson' };
    const fields = buildMergeFields({ shift, client });
    expect(fields.location).toBe('their home');
  });

  it('handles missing shift times gracefully', () => {
    const fields = buildMergeFields({ shift: { clientId: 'c1' }, client: baseClient });
    expect(fields.dayOfWeek).toBe('');
    expect(fields.timeRange).toBe('');
    expect(fields.duration).toBe('');
  });
});

// ─── renderTemplate ────────────────────────────────────────────

describe('renderTemplate', () => {
  it('replaces single-word placeholders', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'Maria' })).toBe('Hello Maria');
  });

  it('replaces multiple placeholders in one template', () => {
    const out = renderTemplate('{{greeting}}, {{name}}!', {
      greeting: 'Hi',
      name: 'Maria',
    });
    expect(out).toBe('Hi, Maria!');
  });

  it('tolerates whitespace inside braces', () => {
    expect(renderTemplate('Hi {{ name }}', { name: 'Maria' })).toBe('Hi Maria');
  });

  it('leaves unknown placeholders as empty strings (never raw braces)', () => {
    const out = renderTemplate('Hi {{name}}, {{unknownField}}', { name: 'Maria' });
    expect(out).not.toContain('{{');
    expect(out).toBe('Hi Maria, ');
  });

  it('handles null / undefined values safely', () => {
    expect(renderTemplate('A:{{a}} B:{{b}}', { a: null, b: undefined })).toBe('A: B:');
  });

  it('handles non-string template input', () => {
    expect(renderTemplate(null, {})).toBe('');
    expect(renderTemplate(undefined, {})).toBe('');
  });

  it('handles missing fields object', () => {
    expect(renderTemplate('Hi {{name}}', undefined)).toBe('Hi ');
  });
});

// ─── renderDefaultBroadcastMessage ─────────────────────────────

describe('renderDefaultBroadcastMessage', () => {
  it('produces a complete message using the default template', () => {
    const text = renderDefaultBroadcastMessage({
      shift: baseShift,
      caregiver: baseCaregiver,
      client: baseClient,
    });
    expect(text).toContain('Maria');
    expect(text).toContain('Mon');
    expect(text).toContain('May 4');
    expect(text).toContain('8:00a-12:00p');
    expect(text).toContain('Alice Johnson');
    expect(text).toContain('123 Main St');
    expect(text).toContain('Reply YES');
  });

  it('accepts a custom template', () => {
    const text = renderDefaultBroadcastMessage({
      shift: baseShift,
      caregiver: baseCaregiver,
      client: baseClient,
      template: 'Yo {{firstName}} — {{timeRange}} with {{clientName}}?',
    });
    expect(text).toBe('Yo Maria — 8:00a-12:00p with Alice Johnson?');
  });

  it('handles missing caregiver gracefully', () => {
    const text = renderDefaultBroadcastMessage({
      shift: baseShift,
      client: baseClient,
    });
    expect(text).toContain('Alice Johnson');
    expect(text).not.toContain('{{');
  });
});

// ─── validateBroadcastDraft ───────────────────────────────────

describe('validateBroadcastDraft', () => {
  const goodDraft = {
    recipientIds: ['cg-1'],
    template: 'Hi there',
  };

  it('accepts a valid draft', () => {
    expect(validateBroadcastDraft(goodDraft)).toBeNull();
  });

  it('rejects missing draft', () => {
    expect(validateBroadcastDraft(null)).toBeTruthy();
  });

  it('rejects empty recipient list', () => {
    expect(validateBroadcastDraft({ ...goodDraft, recipientIds: [] })).toMatch(/caregiver/i);
  });

  it('rejects missing template', () => {
    expect(validateBroadcastDraft({ ...goodDraft, template: '' })).toMatch(/empty/i);
    expect(validateBroadcastDraft({ ...goodDraft, template: '   ' })).toMatch(/empty/i);
  });

  it('rejects template longer than 1600 chars', () => {
    const big = 'x'.repeat(1601);
    expect(validateBroadcastDraft({ ...goodDraft, template: big })).toMatch(/too long/i);
  });

  it('accepts template right at the 1600 limit', () => {
    const big = 'x'.repeat(1600);
    expect(validateBroadcastDraft({ ...goodDraft, template: big })).toBeNull();
  });
});

// ─── parseYesNoResponse (Phase 5b) ─────────────────────────────

describe('parseYesNoResponse', () => {
  it('returns "maybe" for null / undefined / empty', () => {
    expect(parseYesNoResponse(null)).toBe('maybe');
    expect(parseYesNoResponse(undefined)).toBe('maybe');
    expect(parseYesNoResponse('')).toBe('maybe');
    expect(parseYesNoResponse('   ')).toBe('maybe');
  });

  it('recognizes plain YES variants', () => {
    expect(parseYesNoResponse('yes')).toBe('yes');
    expect(parseYesNoResponse('Yes')).toBe('yes');
    expect(parseYesNoResponse('YES')).toBe('yes');
    expect(parseYesNoResponse('y')).toBe('yes');
    expect(parseYesNoResponse('Y')).toBe('yes');
    expect(parseYesNoResponse('yep')).toBe('yes');
    expect(parseYesNoResponse('yeah')).toBe('yes');
    expect(parseYesNoResponse('yup')).toBe('yes');
    expect(parseYesNoResponse('sure')).toBe('yes');
    expect(parseYesNoResponse('ok')).toBe('yes');
    expect(parseYesNoResponse('okay')).toBe('yes');
    expect(parseYesNoResponse('accept')).toBe('yes');
  });

  it('recognizes NO variants', () => {
    expect(parseYesNoResponse('no')).toBe('no');
    expect(parseYesNoResponse('No')).toBe('no');
    expect(parseYesNoResponse('NO')).toBe('no');
    expect(parseYesNoResponse('n')).toBe('no');
    expect(parseYesNoResponse('nope')).toBe('no');
    expect(parseYesNoResponse('nah')).toBe('no');
    expect(parseYesNoResponse('cant')).toBe('no');
    expect(parseYesNoResponse("can't")).toBe('no');
    expect(parseYesNoResponse('decline')).toBe('no');
    expect(parseYesNoResponse('pass')).toBe('no');
  });

  it('parses the first word even with trailing punctuation', () => {
    expect(parseYesNoResponse('Yes!')).toBe('yes');
    expect(parseYesNoResponse('YES.')).toBe('yes');
    expect(parseYesNoResponse('no,')).toBe('no');
    expect(parseYesNoResponse('sure!')).toBe('yes');
    expect(parseYesNoResponse('nope.')).toBe('no');
  });

  it('parses the first word from multi-word replies', () => {
    expect(parseYesNoResponse('Yes please')).toBe('yes');
    expect(parseYesNoResponse('yes I can')).toBe('yes');
    expect(parseYesNoResponse('no sorry')).toBe('no');
    expect(parseYesNoResponse("can't sorry")).toBe('no');
  });

  it('ignores leading whitespace', () => {
    expect(parseYesNoResponse('   yes')).toBe('yes');
    expect(parseYesNoResponse('\n\nyes')).toBe('yes');
  });

  it('returns "maybe" for ambiguous replies', () => {
    expect(parseYesNoResponse('maybe')).toBe('maybe');
    expect(parseYesNoResponse('let me check')).toBe('maybe');
    expect(parseYesNoResponse('I need to look')).toBe('maybe');
    expect(parseYesNoResponse('call me')).toBe('maybe');
    expect(parseYesNoResponse('what time again?')).toBe('maybe');
  });

  it('returns "maybe" for non-string input', () => {
    expect(parseYesNoResponse(42)).toBe('maybe');
    expect(parseYesNoResponse({})).toBe('maybe');
    expect(parseYesNoResponse([])).toBe('maybe');
  });
});

// ─── renderConfirmationMessage (Phase 5b) ──────────────────────

describe('renderConfirmationMessage', () => {
  it('uses the default confirmation template', () => {
    const text = renderConfirmationMessage({
      shift: {
        startTime: new Date(2026, 4, 4, 8).toISOString(),
        endTime: new Date(2026, 4, 4, 12).toISOString(),
        locationAddress: '123 Main St',
      },
      caregiver: { firstName: 'Maria' },
      client: { firstName: 'Alice', lastName: 'Johnson' },
    });
    expect(text).toContain("You're confirmed");
    expect(text).toContain('Mon');
    expect(text).toContain('May 4');
    expect(text).toContain('Alice Johnson');
    expect(text).toContain('123 Main St');
    expect(text).toContain('Maria');
  });

  it('accepts a custom template', () => {
    const text = renderConfirmationMessage({
      shift: {
        startTime: new Date(2026, 4, 4, 8).toISOString(),
        endTime: new Date(2026, 4, 4, 12).toISOString(),
      },
      caregiver: { firstName: 'Maria' },
      client: { firstName: 'Alice', lastName: 'Johnson' },
      template: 'All set, {{firstName}}! See you {{dayOfWeek}}.',
    });
    expect(text).toBe('All set, Maria! See you Mon.');
  });

  it('gracefully handles missing data', () => {
    const text = renderConfirmationMessage({
      shift: null,
      caregiver: null,
      client: null,
    });
    // Should still produce a valid string with placeholders filled with fallbacks
    expect(typeof text).toBe('string');
    expect(text).not.toContain('{{');
  });
});

describe('DEFAULT_CONFIRMATION_TEMPLATE', () => {
  it('includes the key merge fields', () => {
    expect(DEFAULT_CONFIRMATION_TEMPLATE).toContain('{{firstName}}');
    expect(DEFAULT_CONFIRMATION_TEMPLATE).toContain('{{dayOfWeek}}');
    expect(DEFAULT_CONFIRMATION_TEMPLATE).toContain('{{timeRange}}');
    expect(DEFAULT_CONFIRMATION_TEMPLATE).toContain('{{clientName}}');
    expect(DEFAULT_CONFIRMATION_TEMPLATE).toContain('{{location}}');
  });
});

// ─── Explicit timezone for outbound SMS ─────────────────────────
// When a scheduler on a non-PT laptop previews or sends a broadcast,
// the time labels should render in PT — same zone as availability
// matching and recurrence expansion — not in the scheduler's local
// zone. Passing `timezone` to buildMergeFields produces stable output.

describe('buildMergeFields — explicit timezone', () => {
  const tz = 'America/Los_Angeles';

  it('08:00 PDT (15:00 UTC) renders as 8:00a in PT', () => {
    const shift = {
      startTime: '2026-05-04T15:00:00.000Z',
      endTime: '2026-05-04T19:00:00.000Z',
    };
    const fields = buildMergeFields({ shift, timezone: tz });
    expect(fields.dayOfWeek).toBe('Mon');
    expect(fields.dateLabel).toBe('May 4');
    expect(fields.startTime).toBe('8:00a');
    expect(fields.endTime).toBe('12:00p');
    expect(fields.timeRange).toBe('8:00a-12:00p');
    expect(fields.duration).toBe('4h');
  });

  it('08:00 PST (16:00 UTC) also renders as 8:00a in PT (stable across DST)', () => {
    const shift = {
      startTime: '2026-01-05T16:00:00.000Z',
      endTime: '2026-01-05T20:00:00.000Z',
    };
    const fields = buildMergeFields({ shift, timezone: tz });
    expect(fields.startTime).toBe('8:00a');
    expect(fields.endTime).toBe('12:00p');
  });

  it('the same UTC instant renders different wall-clocks in different zones', () => {
    const shift = {
      startTime: '2026-05-04T06:00:00.000Z', // Sun 23:00 PDT = Mon 15:00 JST
      endTime: '2026-05-04T07:00:00.000Z',
    };
    const pt = buildMergeFields({ shift, timezone: 'America/Los_Angeles' });
    const jst = buildMergeFields({ shift, timezone: 'Asia/Tokyo' });
    expect(pt.startTime).toBe('11:00p');
    expect(jst.startTime).toBe('3:00p');
    expect(pt.dayOfWeek).toBe('Sun');
    expect(jst.dayOfWeek).toBe('Mon');
  });
});
