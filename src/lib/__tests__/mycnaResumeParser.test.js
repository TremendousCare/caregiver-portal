import { describe, it, expect } from 'vitest';
import {
  normalizeState,
  mapResumeToCaregiver,
  buildNoteText,
  buildResumeNote,
  validateResume,
  findDuplicates,
  processExtractedResume,
} from '../mycnaResumeParser.js';

// Sample modeled on the real Tina Dalby mycnajobs PDF the team shared.
const SAMPLE_TINA = {
  firstName: 'Tina',
  lastName: 'Dalby',
  city: 'Garden Grove',
  state: 'California',
  zipCode: '92841',
  phone: '(714) 412-9788',
  email: 'tinadalby56@gmail.com',
  yearsExperience: 10,
  lastEmployer: 'visiting angels',
  willingToTravelMiles: 10,
  canLegallyDrive: true,
  availability: ['Full-Time', 'Part-Time', 'Day Shift', 'Night Shift', 'Weekdays', 'Weekends'],
  certifications: [
    { type: 'CHHA', attended: 'Cerritos.', date: '6/21/2022', licenseNumber: '7516062295' },
  ],
  specializations: [
    'Alzheimers / Dementia', 'Handicapped Patients', 'Hospice Patients',
    'Special Meal Prep', 'Childcare Experience', 'Geriatric Experience',
    'Homecare Experience', 'Assisted Living Experience', 'Hospital Experience',
    'Finger Printing Complete', 'CPR Certification', 'First Aid Certification',
    'TB Test / Chest X-Ray', 'Dogs Acceptable',
  ],
  whyHireMe: 'I have many years of experience, patience knowledge on the habits of seniors. Talking to them creating good trusting relationships.',
  whyCaregiver: 'I have a gift and compassion for seniors.',
};

// ═══════════════════════════════════════════════════════════════
// normalizeState
// ═══════════════════════════════════════════════════════════════

describe('normalizeState', () => {
  it('converts full state name to 2-letter abbreviation', () => {
    expect(normalizeState('California')).toBe('CA');
    expect(normalizeState('new york')).toBe('NY');
    expect(normalizeState('TEXAS')).toBe('TX');
  });

  it('returns 2-letter input uppercased untouched', () => {
    expect(normalizeState('CA')).toBe('CA');
    expect(normalizeState('ny')).toBe('NY');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeState('')).toBe('');
    expect(normalizeState(null)).toBe('');
    expect(normalizeState(undefined)).toBe('');
  });

  it('preserves unrecognized values rather than dropping them', () => {
    expect(normalizeState('Bavaria')).toBe('Bavaria');
  });

  it('handles multi-word state names with leading/trailing whitespace', () => {
    expect(normalizeState('  North Carolina ')).toBe('NC');
    expect(normalizeState('District of Columbia')).toBe('DC');
  });
});

// ═══════════════════════════════════════════════════════════════
// mapResumeToCaregiver
// ═══════════════════════════════════════════════════════════════

describe('mapResumeToCaregiver', () => {
  it('maps the canonical mycnajobs sample into caregiverData', () => {
    const { caregiverData } = mapResumeToCaregiver(SAMPLE_TINA, { fileName: 'tina.pdf' });
    expect(caregiverData.firstName).toBe('Tina');
    expect(caregiverData.lastName).toBe('Dalby');
    expect(caregiverData.phone).toBe('7144129788'); // normalized
    expect(caregiverData.email).toBe('tinadalby56@gmail.com');
    expect(caregiverData.city).toBe('Garden Grove');
    expect(caregiverData.state).toBe('CA');
    expect(caregiverData.source).toBe('mycnajobs');
    expect(caregiverData.sourceDetail).toBe('mycnajobs.com');
    expect(caregiverData.applicationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('strips a leading 1 from US phone numbers via normalizePhone', () => {
    const { caregiverData } = mapResumeToCaregiver({
      ...SAMPLE_TINA,
      phone: '1-714-412-9788',
    });
    expect(caregiverData.phone).toBe('7144129788');
  });

  it('returns empty strings for missing fields', () => {
    const { caregiverData } = mapResumeToCaregiver({});
    expect(caregiverData.firstName).toBe('');
    expect(caregiverData.lastName).toBe('');
    expect(caregiverData.phone).toBe('');
    expect(caregiverData.email).toBe('');
    expect(caregiverData.city).toBe('');
    expect(caregiverData.state).toBe('');
  });

  it('trims whitespace from string fields', () => {
    const { caregiverData } = mapResumeToCaregiver({
      ...SAMPLE_TINA,
      firstName: '  Tina  ',
      lastName: ' Dalby ',
      city: '  Garden Grove ',
      email: '  tina@x.com  ',
    });
    expect(caregiverData.firstName).toBe('Tina');
    expect(caregiverData.lastName).toBe('Dalby');
    expect(caregiverData.city).toBe('Garden Grove');
    expect(caregiverData.email).toBe('tina@x.com');
  });

  it('survives null extraction without throwing', () => {
    expect(() => mapResumeToCaregiver(null)).not.toThrow();
    const { caregiverData } = mapResumeToCaregiver(null);
    expect(caregiverData.firstName).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// buildNoteText
// ═══════════════════════════════════════════════════════════════

describe('buildNoteText', () => {
  it('includes a header that names the source and file', () => {
    const note = buildNoteText(SAMPLE_TINA, 'tina.pdf');
    expect(note).toMatch(/Imported from mycnajobs.com \(tina.pdf\)/);
  });

  it('includes years of experience and last employer', () => {
    const note = buildNoteText(SAMPLE_TINA);
    expect(note).toMatch(/Experience: 10 years/);
    expect(note).toMatch(/Last employer: visiting angels/);
  });

  it('uses singular "year" for 1 year of experience', () => {
    const note = buildNoteText({ ...SAMPLE_TINA, yearsExperience: 1 });
    expect(note).toMatch(/Experience: 1 year(?!s)/);
  });

  it('omits zero or null numeric fields rather than printing 0', () => {
    const note = buildNoteText({
      ...SAMPLE_TINA,
      yearsExperience: 0,
      willingToTravelMiles: null,
    });
    expect(note).not.toMatch(/Experience: 0/);
    expect(note).not.toMatch(/Willing to travel: 0/);
    expect(note).not.toMatch(/Willing to travel: null/);
  });

  it('lists every certification with its sub-fields', () => {
    const note = buildNoteText(SAMPLE_TINA);
    expect(note).toMatch(/CHHA/);
    expect(note).toMatch(/Attended: Cerritos\./);
    expect(note).toMatch(/Date: 6\/21\/2022/);
    expect(note).toMatch(/License #: 7516062295/);
  });

  it('joins specializations with commas', () => {
    const note = buildNoteText(SAMPLE_TINA);
    expect(note).toMatch(/Specializations: Alzheimers \/ Dementia, Handicapped Patients/);
  });

  it('preserves the candidate\'s free-text essays verbatim', () => {
    const note = buildNoteText(SAMPLE_TINA);
    expect(note).toContain(SAMPLE_TINA.whyHireMe);
    expect(note).toContain(SAMPLE_TINA.whyCaregiver);
  });

  it('handles a sparse resume without crashing', () => {
    const note = buildNoteText({});
    expect(note).toMatch(/Imported from mycnajobs.com/);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildResumeNote
// ═══════════════════════════════════════════════════════════════

describe('buildResumeNote', () => {
  it('wraps note text in the canonical note shape', () => {
    const before = Date.now();
    const n = buildResumeNote('hello');
    const after = Date.now();
    expect(n.text).toBe('hello');
    expect(n.type).toBe('auto');
    expect(n.author).toBe('mycnajobs Import');
    expect(n.timestamp).toBeGreaterThanOrEqual(before);
    expect(n.timestamp).toBeLessThanOrEqual(after);
  });
});

// ═══════════════════════════════════════════════════════════════
// validateResume
// ═══════════════════════════════════════════════════════════════

describe('validateResume', () => {
  it('passes when name and phone are present', () => {
    const r = validateResume({ firstName: 'Tina', lastName: '', phone: '7144129788', email: '' });
    expect(r.valid).toBe(true);
  });

  it('passes when name and email are present', () => {
    const r = validateResume({ firstName: '', lastName: 'Dalby', phone: '', email: 'a@b.com' });
    expect(r.valid).toBe(true);
  });

  it('fails when both names are missing', () => {
    const r = validateResume({ firstName: '', lastName: '', phone: '7144129788', email: 'a@b.com' });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Missing name');
  });

  it('fails when both phone and email are missing', () => {
    const r = validateResume({ firstName: 'Tina', lastName: 'Dalby', phone: '', email: '' });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Missing phone and email');
  });
});

// ═══════════════════════════════════════════════════════════════
// findDuplicates
// ═══════════════════════════════════════════════════════════════

describe('findDuplicates', () => {
  it('flags a phone match as duplicate', () => {
    const records = [
      { caregiverData: { firstName: 'Tina', lastName: 'Dalby', phone: '7144129788', email: 'tina@x.com' } },
    ];
    const existing = [{ phone: '(714) 412-9788', email: 'someone-else@y.com' }];
    const result = findDuplicates(records, existing);
    expect(result[0].isDuplicate).toBe(true);
    expect(result[0].dupReason).toBe('Phone already exists');
  });

  it('flags an email match as duplicate (case-insensitive)', () => {
    const records = [
      { caregiverData: { firstName: 'Tina', lastName: 'Dalby', phone: '5550000000', email: 'Tina@X.com' } },
    ];
    const existing = [{ phone: '9999999999', email: 'tina@x.com' }];
    const result = findDuplicates(records, existing);
    expect(result[0].isDuplicate).toBe(true);
    expect(result[0].dupReason).toBe('Email already exists');
  });

  it('does not flag a record with no overlap', () => {
    const records = [
      { caregiverData: { firstName: 'Tina', lastName: 'Dalby', phone: '7144129788', email: 'tina@x.com' } },
    ];
    const existing = [{ phone: '5550000000', email: 'jane@y.com' }];
    const result = findDuplicates(records, existing);
    expect(result[0].isDuplicate).toBe(false);
    expect(result[0].dupReason).toBeNull();
  });

  it('handles an empty existing list', () => {
    const records = [
      { caregiverData: { firstName: 'Tina', lastName: 'Dalby', phone: '7144129788', email: 'tina@x.com' } },
    ];
    const result = findDuplicates(records, []);
    expect(result[0].isDuplicate).toBe(false);
  });

  it('skips existing entries with no phone or email', () => {
    const records = [
      { caregiverData: { firstName: 'Tina', lastName: 'Dalby', phone: '7144129788', email: 'tina@x.com' } },
    ];
    const existing = [{ phone: '', email: '' }];
    const result = findDuplicates(records, existing);
    expect(result[0].isDuplicate).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// processExtractedResume — end-to-end
// ═══════════════════════════════════════════════════════════════

describe('processExtractedResume', () => {
  it('returns a record for the canonical sample', () => {
    const result = processExtractedResume(SAMPLE_TINA, 'tina.pdf');
    expect(result.record).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(result.record.caregiverData.firstName).toBe('Tina');
    expect(result.record.caregiverData.phone).toBe('7144129788');
    expect(result.record.note.author).toBe('mycnajobs Import');
    expect(result.record.fileName).toBe('tina.pdf');
    expect(result.record.extracted).toEqual(SAMPLE_TINA);
  });

  it('returns skipped when name is missing', () => {
    const result = processExtractedResume(
      { ...SAMPLE_TINA, firstName: '', lastName: '' },
      'no-name.pdf',
    );
    expect(result.record).toBeUndefined();
    expect(result.skipped).toEqual({ fileName: 'no-name.pdf', reason: 'Missing name' });
  });

  it('returns skipped when phone and email are both missing', () => {
    const result = processExtractedResume(
      { ...SAMPLE_TINA, phone: '', email: '' },
      'no-contact.pdf',
    );
    expect(result.record).toBeUndefined();
    expect(result.skipped.reason).toBe('Missing phone and email');
  });

  it('uses (unnamed) when no fileName is supplied', () => {
    const result = processExtractedResume({ ...SAMPLE_TINA, firstName: '', lastName: '' });
    expect(result.skipped.fileName).toBe('(unnamed)');
  });
});
