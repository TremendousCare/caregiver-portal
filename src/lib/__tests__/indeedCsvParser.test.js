import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  splitName,
  splitLocation,
  mapIndeedRow,
  buildIndeedNote,
  validateIndeedRow,
  processIndeedCsv,
} from '../indeedCsvParser.js';

// ═══════════════════════════════════════════════════════════════
// parseCsv
// ═══════════════════════════════════════════════════════════════

describe('parseCsv', () => {
  it('parses a simple CSV with header row', () => {
    const csv = 'name,email,phone\nJohn Doe,john@test.com,5551234567';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('John Doe');
    expect(rows[0].email).toBe('john@test.com');
    expect(rows[0].phone).toBe('5551234567');
  });

  it('handles quoted fields with commas', () => {
    const csv = 'name,title\nJohn Doe,"Caregiver, Part-Time"';
    const rows = parseCsv(csv);
    expect(rows[0].title).toBe('Caregiver, Part-Time');
  });

  it('handles escaped quotes inside quoted fields', () => {
    const csv = 'name,notes\nJohn Doe,"Said ""hello"" today"';
    const rows = parseCsv(csv);
    expect(rows[0].notes).toBe('Said "hello" today');
  });

  it('skips empty rows', () => {
    const csv = 'name,email\nJohn,john@test.com\n\n,,\nJane,jane@test.com';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it('returns empty array for header-only CSV', () => {
    expect(parseCsv('name,email')).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(parseCsv('')).toHaveLength(0);
  });

  it('normalizes header names to lowercase', () => {
    const csv = 'Name,EMAIL,Phone\nJohn,john@test.com,555';
    const rows = parseCsv(csv);
    expect(rows[0]).toHaveProperty('name');
    expect(rows[0]).toHaveProperty('email');
    expect(rows[0]).toHaveProperty('phone');
  });

  it('handles Windows-style line endings (\\r\\n)', () => {
    const csv = 'name,email\r\nJohn,john@test.com\r\nJane,jane@test.com';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it('trims whitespace from values', () => {
    const csv = 'name,email\n  John Doe  ,  john@test.com  ';
    const rows = parseCsv(csv);
    expect(rows[0].name).toBe('John Doe');
    expect(rows[0].email).toBe('john@test.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// splitName
// ═══════════════════════════════════════════════════════════════

describe('splitName', () => {
  it('splits a simple two-part name', () => {
    expect(splitName('John Doe')).toEqual({ firstName: 'John', lastName: 'Doe' });
  });

  it('handles single name (first only)', () => {
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
  });

  it('handles multi-part last name', () => {
    expect(splitName('Mary Jane Watson')).toEqual({ firstName: 'Mary', lastName: 'Jane Watson' });
  });

  it('handles empty string', () => {
    expect(splitName('')).toEqual({ firstName: '', lastName: '' });
  });

  it('trims whitespace', () => {
    expect(splitName('  John   Doe  ')).toEqual({ firstName: 'John', lastName: 'Doe' });
  });

  it('handles ALL CAPS names', () => {
    expect(splitName('LENETTE FARRIS')).toEqual({ firstName: 'LENETTE', lastName: 'FARRIS' });
  });
});

// ═══════════════════════════════════════════════════════════════
// splitLocation
// ═══════════════════════════════════════════════════════════════

describe('splitLocation', () => {
  it('splits "City, ST" format', () => {
    expect(splitLocation('Anaheim, CA')).toEqual({ city: 'Anaheim', state: 'CA' });
  });

  it('splits multi-word city', () => {
    expect(splitLocation('Huntington Beach, CA')).toEqual({ city: 'Huntington Beach', state: 'CA' });
  });

  it('handles city with zip in state part', () => {
    expect(splitLocation('Santa Ana, CA 92705')).toEqual({ city: 'Santa Ana', state: 'CA' });
  });

  it('handles city only (no comma)', () => {
    expect(splitLocation('Anaheim')).toEqual({ city: 'Anaheim', state: '' });
  });

  it('handles empty string', () => {
    expect(splitLocation('')).toEqual({ city: '', state: '' });
  });

  it('handles null/undefined', () => {
    expect(splitLocation(null)).toEqual({ city: '', state: '' });
    expect(splitLocation(undefined)).toEqual({ city: '', state: '' });
  });
});

// ═══════════════════════════════════════════════════════════════
// mapIndeedRow
// ═══════════════════════════════════════════════════════════════

describe('mapIndeedRow', () => {
  const sampleRow = {
    name: 'Jaquelyn Neri',
    email: 'jaquelynnerivkudo_6hp@indeedemail.com',
    phone: "'+1 657 557 4368",
    status: 'Awaiting Review',
    'candidate location': 'Anaheim, CA',
    'relevant experience': 'Caregiver',
    education: '',
    'job title': 'Caregiver \u2013 Weekly Pay | Flexible Shifts | Hiring in Orange County',
    'job location': 'Santa Ana, CA 92705',
    date: '2026-04-11',
    'interest level': '',
    source: 'Sponsored Job Link',
  };

  it('maps name into firstName and lastName', () => {
    const { caregiverData } = mapIndeedRow(sampleRow);
    expect(caregiverData.firstName).toBe('Jaquelyn');
    expect(caregiverData.lastName).toBe('Neri');
  });

  it('normalizes phone number (strips +1 and formatting)', () => {
    const { caregiverData } = mapIndeedRow(sampleRow);
    expect(caregiverData.phone).toBe('6575574368');
  });

  it('skips @indeedemail.com masked emails', () => {
    const { caregiverData } = mapIndeedRow(sampleRow);
    expect(caregiverData.email).toBe('');
  });

  it('keeps real email addresses', () => {
    const { caregiverData } = mapIndeedRow({ ...sampleRow, email: 'jaquelyn@gmail.com' });
    expect(caregiverData.email).toBe('jaquelyn@gmail.com');
  });

  it('splits candidate location into city and state', () => {
    const { caregiverData } = mapIndeedRow(sampleRow);
    expect(caregiverData.city).toBe('Anaheim');
    expect(caregiverData.state).toBe('CA');
  });

  it('sets source to Indeed', () => {
    const { caregiverData } = mapIndeedRow(sampleRow);
    expect(caregiverData.source).toBe('Indeed');
  });

  it('sets sourceDetail from row source field', () => {
    const { caregiverData } = mapIndeedRow(sampleRow);
    expect(caregiverData.sourceDetail).toBe('Sponsored Job Link');
  });

  it('sets applicationDate from row date field', () => {
    const { caregiverData } = mapIndeedRow(sampleRow);
    expect(caregiverData.applicationDate).toBe('2026-04-11');
  });

  it('builds note text with experience info', () => {
    const { noteText } = mapIndeedRow(sampleRow);
    expect(noteText).toContain('Imported from Indeed CSV');
    expect(noteText).toContain('Experience: Caregiver');
    expect(noteText).toContain('Sponsored Job Link');
  });

  it('omits empty fields from note', () => {
    const { noteText } = mapIndeedRow(sampleRow);
    expect(noteText).not.toContain('Education:');
  });

  it('handles row with missing fields', () => {
    const { caregiverData } = mapIndeedRow({ name: 'Kevin Nash', phone: "'+1 586 872 0673" });
    expect(caregiverData.firstName).toBe('Kevin');
    expect(caregiverData.lastName).toBe('Nash');
    expect(caregiverData.phone).toBe('5868720673');
    expect(caregiverData.email).toBe('');
    expect(caregiverData.city).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// buildIndeedNote
// ═══════════════════════════════════════════════════════════════

describe('buildIndeedNote', () => {
  it('creates a note object with correct structure', () => {
    const note = buildIndeedNote('Test note');
    expect(note.text).toBe('Test note');
    expect(note.type).toBe('auto');
    expect(note.author).toBe('Indeed Import');
    expect(typeof note.timestamp).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════
// validateIndeedRow
// ═══════════════════════════════════════════════════════════════

describe('validateIndeedRow', () => {
  it('passes with name and phone', () => {
    expect(validateIndeedRow({ firstName: 'John', lastName: 'Doe', phone: '5551234567', email: '' }))
      .toEqual({ valid: true });
  });

  it('passes with name and email only', () => {
    expect(validateIndeedRow({ firstName: 'John', lastName: 'Doe', phone: '', email: 'john@test.com' }))
      .toEqual({ valid: true });
  });

  it('fails with no name', () => {
    const result = validateIndeedRow({ firstName: '', lastName: '', phone: '555', email: 'a@b.com' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('name');
  });

  it('fails with name but no contact info', () => {
    const result = validateIndeedRow({ firstName: 'John', lastName: 'Doe', phone: '', email: '' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('phone');
  });
});

// ═══════════════════════════════════════════════════════════════
// processIndeedCsv (end-to-end)
// ═══════════════════════════════════════════════════════════════

describe('processIndeedCsv', () => {
  const fullCsv = [
    'name,email,phone,status,candidate location,relevant experience,education,job title,job location,date,interest level,source',
    "Jaquelyn Neri,jaquelynnerivkudo_6hp@indeedemail.com,'+1 657 557 4368,Awaiting Review,\"Anaheim, CA\",Caregiver,,\"Caregiver \u2013 Weekly Pay | Flexible Shifts\",\"Santa Ana, CA 92705\",2026-04-11,,Sponsored Job Link",
    "LENETTE FARRIS,lenettehibbleryzfw8_tj2@indeedemail.com,'+1 661 504 4880,Awaiting Review,\"Huntington Beach, CA\",Telemarketer,Some College - CNA,\"Caregiver \u2013 Weekly Pay | Flexible Shifts\",\"Santa Ana, CA 92705\",2026-04-10,,Indeed",
    "Kevin Nash,kevinnasheuepx_pkt@indeedemail.com,'+1 586 872 0673,Awaiting Review,\"Newport Beach, CA\",,,,2026-04-10,,Indeed",
  ].join('\n');

  it('processes all valid rows', () => {
    const { records, skipped } = processIndeedCsv(fullCsv);
    expect(records).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it('maps first row correctly', () => {
    const { records } = processIndeedCsv(fullCsv);
    const first = records[0].caregiverData;
    expect(first.firstName).toBe('Jaquelyn');
    expect(first.lastName).toBe('Neri');
    expect(first.phone).toBe('6575574368');
    expect(first.city).toBe('Anaheim');
    expect(first.state).toBe('CA');
    expect(first.source).toBe('Indeed');
  });

  it('creates notes for each record', () => {
    const { records } = processIndeedCsv(fullCsv);
    records.forEach((r) => {
      expect(r.note.type).toBe('auto');
      expect(r.note.author).toBe('Indeed Import');
      expect(r.note.text).toContain('Imported from Indeed CSV');
    });
  });

  it('includes education in note when present', () => {
    const { records } = processIndeedCsv(fullCsv);
    expect(records[1].note.text).toContain('Education: Some College - CNA');
  });

  it('skips rows with no name', () => {
    const badCsv = 'name,email,phone\n,test@test.com,5551234567';
    const { records, skipped } = processIndeedCsv(badCsv);
    expect(records).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('name');
  });

  it('skips rows with no contact info', () => {
    const badCsv = 'name,email,phone\nJohn Doe,,';
    const { records, skipped } = processIndeedCsv(badCsv);
    expect(records).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('phone');
  });

  it('handles empty CSV', () => {
    const { records, skipped } = processIndeedCsv('name,email\n');
    expect(records).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});
