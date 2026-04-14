import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BROADCAST_TEMPLATE,
  DEFAULT_REPLY_INSTRUCTION,
  buildMergeFields,
  renderTemplate,
  renderDefaultBroadcastMessage,
  validateBroadcastDraft,
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
