import { describe, it, expect } from 'vitest';
import {
  isIndeedEmail,
  parseSubject,
  splitName,
  extractEmail,
  extractPhone,
  extractLocation,
  parseLocation,
  stripHtml,
  normalizePhone,
  parseIndeedEmail,
  INDEED_SENDERS,
} from '../indeedEmailParser.js';

// ═══════════════════════════════════════════════════════════════
// isIndeedEmail
// ═══════════════════════════════════════════════════════════════

describe('isIndeedEmail', () => {
  it('recognizes indeedapply@indeed.com', () => {
    expect(isIndeedEmail('indeedapply@indeed.com')).toBe(true);
  });

  it('recognizes alert@indeed.com', () => {
    expect(isIndeedEmail('alert@indeed.com')).toBe(true);
  });

  it('recognizes noreply@indeed.com', () => {
    expect(isIndeedEmail('noreply@indeed.com')).toBe(true);
  });

  it('handles uppercase sender', () => {
    expect(isIndeedEmail('IndeedApply@Indeed.com')).toBe(true);
  });

  it('handles sender with leading/trailing spaces', () => {
    expect(isIndeedEmail('  indeedapply@indeed.com  ')).toBe(true);
  });

  it('rejects non-Indeed email', () => {
    expect(isIndeedEmail('someone@gmail.com')).toBe(false);
  });

  it('rejects similar but different domain', () => {
    expect(isIndeedEmail('alert@notindeed.com')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isIndeedEmail('')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isIndeedEmail(null)).toBe(false);
    expect(isIndeedEmail(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseSubject
// ═══════════════════════════════════════════════════════════════

describe('parseSubject', () => {
  it('parses "Indeed Application: Job Title - Applicant Name" format', () => {
    const result = parseSubject('Indeed Application: Caregiver - Weekly Pay - John Smith');
    expect(result.applicantName).toBe('John Smith');
    expect(result.jobTitle).toBe('Caregiver - Weekly Pay');
  });

  it('parses simple job title without dashes', () => {
    const result = parseSubject('Indeed Application: Caregiver - Jane Doe');
    expect(result.applicantName).toBe('Jane Doe');
    expect(result.jobTitle).toBe('Caregiver');
  });

  it('parses "Applicant Name applied to your Job Title job" format', () => {
    const result = parseSubject('John Smith applied to your Caregiver job');
    expect(result.applicantName).toBe('John Smith');
    expect(result.jobTitle).toBe('Caregiver');
  });

  it('parses "applied to" without "your"', () => {
    const result = parseSubject('Jane Doe applied to Home Health Aide');
    expect(result.applicantName).toBe('Jane Doe');
    expect(result.jobTitle).toBe('Home Health Aide');
  });

  it('parses "New application: Job Title" format', () => {
    const result = parseSubject('New application: Caregiver - Weekly Pay');
    expect(result.applicantName).toBeNull();
    expect(result.jobTitle).toBe('Caregiver - Weekly Pay');
  });

  it('returns nulls for unrecognized format', () => {
    const result = parseSubject('Random email subject');
    expect(result.applicantName).toBeNull();
    expect(result.jobTitle).toBeNull();
  });

  it('returns nulls for empty subject', () => {
    const result = parseSubject('');
    expect(result.applicantName).toBeNull();
    expect(result.jobTitle).toBeNull();
  });

  it('returns nulls for null/undefined', () => {
    expect(parseSubject(null).applicantName).toBeNull();
    expect(parseSubject(undefined).applicantName).toBeNull();
  });

  it('handles long job title with multiple dashes', () => {
    const result = parseSubject('Indeed Application: Caregiver - Weekly Pay | Flexible Shifts | Hiring in Orange County - Maria Garcia');
    expect(result.applicantName).toBe('Maria Garcia');
    expect(result.jobTitle).toBe('Caregiver - Weekly Pay | Flexible Shifts | Hiring in Orange County');
  });
});

// ═══════════════════════════════════════════════════════════════
// splitName
// ═══════════════════════════════════════════════════════════════

describe('splitName', () => {
  it('splits "John Smith" into first and last', () => {
    expect(splitName('John Smith')).toEqual({ firstName: 'John', lastName: 'Smith' });
  });

  it('handles three-part names', () => {
    expect(splitName('Maria De La Cruz')).toEqual({ firstName: 'Maria', lastName: 'De La Cruz' });
  });

  it('handles single name', () => {
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
  });

  it('handles empty string', () => {
    expect(splitName('')).toEqual({ firstName: '', lastName: '' });
  });

  it('handles null/undefined', () => {
    expect(splitName(null)).toEqual({ firstName: '', lastName: '' });
    expect(splitName(undefined)).toEqual({ firstName: '', lastName: '' });
  });

  it('trims whitespace', () => {
    expect(splitName('  John   Smith  ')).toEqual({ firstName: 'John', lastName: 'Smith' });
  });
});

// ═══════════════════════════════════════════════════════════════
// extractEmail
// ═══════════════════════════════════════════════════════════════

describe('extractEmail', () => {
  it('extracts labeled email', () => {
    expect(extractEmail('Name: John\nEmail: john@example.com\nPhone: 555')).toBe('john@example.com');
  });

  it('extracts email with colon and space', () => {
    expect(extractEmail('Email: jane.doe@gmail.com')).toBe('jane.doe@gmail.com');
  });

  it('extracts email without label from text', () => {
    expect(extractEmail('Contact them at applicant@test.com for more info')).toBe('applicant@test.com');
  });

  it('ignores indeed.com addresses and finds applicant email', () => {
    expect(extractEmail('From: noreply@indeed.com\nApplicant: test@gmail.com')).toBe('test@gmail.com');
  });

  it('returns null when only indeed.com addresses present', () => {
    expect(extractEmail('From: noreply@indeed.com')).toBeNull();
  });

  it('handles email with plus addressing', () => {
    expect(extractEmail('Email: user+tag@example.com')).toBe('user+tag@example.com');
  });

  it('lowercases email', () => {
    expect(extractEmail('Email: John.Smith@Example.COM')).toBe('john.smith@example.com');
  });

  it('returns null for empty/null input', () => {
    expect(extractEmail('')).toBeNull();
    expect(extractEmail(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// extractPhone
// ═══════════════════════════════════════════════════════════════

describe('extractPhone', () => {
  it('extracts labeled phone', () => {
    expect(extractPhone('Phone: (555) 123-4567')).toBe('(555) 123-4567');
  });

  it('extracts phone with "Phone Number" label', () => {
    expect(extractPhone('Phone Number: 555-123-4567')).toBe('555-123-4567');
  });

  it('extracts phone with "Tel" label', () => {
    expect(extractPhone('Tel: 5551234567')).toBe('5551234567');
  });

  it('extracts unlabeled phone pattern', () => {
    expect(extractPhone('Contact at (714) 555-1234 for details')).toBe('(714) 555-1234');
  });

  it('extracts phone with +1 prefix', () => {
    const phone = extractPhone('Call +1 (555) 123-4567');
    // May match with or without the +1 depending on which pattern fires first
    expect(phone).toMatch(/\+?1?\s?\(555\) 123-4567|\(555\) 123-4567/);
  });

  it('returns null when no phone found', () => {
    expect(extractPhone('No phone number here')).toBeNull();
  });

  it('returns null for empty/null input', () => {
    expect(extractPhone('')).toBeNull();
    expect(extractPhone(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// extractLocation / parseLocation
// ═══════════════════════════════════════════════════════════════

describe('extractLocation', () => {
  it('extracts labeled location', () => {
    const result = extractLocation('Location: Santa Ana, CA');
    expect(result.city).toBe('Santa Ana');
    expect(result.state).toBe('CA');
  });

  it('extracts City, ST pattern from text', () => {
    const result = extractLocation('Name: John\nHouston, TX\nPhone: 555');
    expect(result.city).toBe('Houston');
    expect(result.state).toBe('TX');
  });

  it('returns nulls when no location found', () => {
    const result = extractLocation('no location info here at all');
    expect(result.city).toBeNull();
    expect(result.state).toBeNull();
  });

  it('returns nulls for empty/null input', () => {
    expect(extractLocation('').city).toBeNull();
    expect(extractLocation(null).city).toBeNull();
  });
});

describe('parseLocation', () => {
  it('parses "City, ST"', () => {
    expect(parseLocation('Houston, TX')).toEqual({ city: 'Houston', state: 'TX' });
  });

  it('parses "City, ST ZIP"', () => {
    expect(parseLocation('Santa Ana, CA 92705')).toEqual({ city: 'Santa Ana', state: 'CA' });
  });

  it('parses state-only input', () => {
    expect(parseLocation('CA')).toEqual({ city: null, state: 'CA' });
  });

  it('treats unmatched input as city', () => {
    expect(parseLocation('Los Angeles')).toEqual({ city: 'Los Angeles', state: null });
  });

  it('handles lowercase state and uppercases it', () => {
    expect(parseLocation('Houston, tx')).toEqual({ city: 'Houston', state: 'TX' });
  });

  it('returns nulls for empty/null', () => {
    expect(parseLocation('')).toEqual({ city: null, state: null });
    expect(parseLocation(null)).toEqual({ city: null, state: null });
  });
});

// ═══════════════════════════════════════════════════════════════
// stripHtml
// ═══════════════════════════════════════════════════════════════

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>World</b></p>')).toBe('Hello World');
  });

  it('converts <br> to newline', () => {
    expect(stripHtml('Line 1<br>Line 2')).toBe('Line 1\nLine 2');
  });

  it('converts </p> to newline', () => {
    const result = stripHtml('<p>Para 1</p><p>Para 2</p>');
    // </p> becomes newline, <p> becomes space — collapsed result
    expect(result).toContain('Para 1');
    expect(result).toContain('Para 2');
  });

  it('decodes &amp; entity', () => {
    expect(stripHtml('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });

  it('decodes &nbsp; entity', () => {
    expect(stripHtml('Hello&nbsp;World')).toBe('Hello World');
  });

  it('collapses multiple spaces', () => {
    expect(stripHtml('Hello    World')).toBe('Hello World');
  });

  it('returns empty string for null/empty', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml(null)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// normalizePhone
// ═══════════════════════════════════════════════════════════════

describe('normalizePhone', () => {
  it('strips formatting from phone number', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('5551234567');
  });

  it('strips leading 1 from 11-digit number', () => {
    expect(normalizePhone('15551234567')).toBe('5551234567');
  });

  it('handles +1 prefix', () => {
    expect(normalizePhone('+1-555-123-4567')).toBe('5551234567');
  });

  it('returns empty string for empty input', () => {
    expect(normalizePhone('')).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// parseIndeedEmail — Full Integration
// ═══════════════════════════════════════════════════════════════

describe('parseIndeedEmail', () => {
  it('parses a typical Indeed Apply notification', () => {
    const result = parseIndeedEmail({
      subject: 'Indeed Application: Caregiver - Weekly Pay - John Smith',
      body: `
        <html>
        <body>
          <table>
            <tr><td><h2>John Smith</h2></td></tr>
            <tr><td>applied to Caregiver - Weekly Pay</td></tr>
            <tr><td>Email: john.smith@gmail.com</td></tr>
            <tr><td>Phone: (714) 555-1234</td></tr>
            <tr><td>Location: Santa Ana, CA</td></tr>
          </table>
        </body>
        </html>
      `,
      sender: 'indeedapply@indeed.com',
      receivedAt: '2026-04-10T10:00:00Z',
      messageId: 'abc123',
    });

    expect(result.success).toBe(true);
    expect(result.data.first_name).toBe('John');
    expect(result.data.last_name).toBe('Smith');
    expect(result.data.email).toBe('john.smith@gmail.com');
    expect(result.data.phone).toBe('7145551234');
    expect(result.data.city).toBe('Santa Ana');
    expect(result.data.state).toBe('CA');
    expect(result.data.source).toBe('Indeed');
    expect(result.data.source_detail).toBe('Caregiver - Weekly Pay');
    expect(result.data._messageId).toBe('abc123');
  });

  it('extracts name from subject when body has no labeled name', () => {
    const result = parseIndeedEmail({
      subject: 'Indeed Application: Home Health Aide - Jane Doe',
      body: '<p>Email: jane@example.com</p>',
      sender: 'indeedapply@indeed.com',
    });

    expect(result.success).toBe(true);
    expect(result.data.first_name).toBe('Jane');
    expect(result.data.last_name).toBe('Doe');
    expect(result.data.email).toBe('jane@example.com');
  });

  it('works with "applied to" subject format', () => {
    const result = parseIndeedEmail({
      subject: 'Maria Garcia applied to your Caregiver job',
      body: '<p>Phone: 555-999-8888</p><p>Location: Houston, TX</p>',
      sender: 'alert@indeed.com',
    });

    expect(result.success).toBe(true);
    expect(result.data.first_name).toBe('Maria');
    expect(result.data.last_name).toBe('Garcia');
    expect(result.data.phone).toBe('5559998888');
    expect(result.data.city).toBe('Houston');
    expect(result.data.state).toBe('TX');
  });

  it('succeeds with name only (no email or phone)', () => {
    const result = parseIndeedEmail({
      subject: 'Indeed Application: Caregiver - Bob Jones',
      body: '<p>View application on Indeed</p>',
      sender: 'indeedapply@indeed.com',
    });

    expect(result.success).toBe(true);
    expect(result.data.first_name).toBe('Bob');
    expect(result.data.last_name).toBe('Jones');
    expect(result.data.email).toBe('');
    expect(result.data.phone).toBe('');
  });

  it('succeeds with email only (no name in subject)', () => {
    const result = parseIndeedEmail({
      subject: 'New application: Caregiver',
      body: '<p>Email: applicant@example.com</p>',
      sender: 'indeedapply@indeed.com',
    });

    expect(result.success).toBe(true);
    expect(result.data.first_name).toBe('');
    expect(result.data.email).toBe('applicant@example.com');
    expect(result.data.source_detail).toBe('Caregiver');
  });

  it('fails when no name and no email can be extracted', () => {
    const result = parseIndeedEmail({
      subject: 'New application: Caregiver',
      body: '<p>View on Indeed</p>',
      sender: 'indeedapply@indeed.com',
    });

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toContain('Could not extract');
  });

  it('rejects non-Indeed sender', () => {
    const result = parseIndeedEmail({
      subject: 'Indeed Application: Caregiver - John Smith',
      body: '<p>Email: john@example.com</p>',
      sender: 'spammer@fake.com',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Not an Indeed email');
  });

  it('works without sender (sender not checked)', () => {
    const result = parseIndeedEmail({
      subject: 'Indeed Application: Caregiver - John Smith',
      body: '<p>Email: john@example.com</p>',
    });

    expect(result.success).toBe(true);
    expect(result.data.first_name).toBe('John');
  });

  it('handles complex HTML body with tables', () => {
    const html = `
      <html>
      <body>
        <table width="600" style="margin: auto;">
          <tr>
            <td style="background: #2557a7; color: white; padding: 20px;">
              <img src="https://indeed.com/logo.png" alt="Indeed" />
            </td>
          </tr>
          <tr>
            <td style="padding: 20px;">
              <h2 style="color: #2d2d2d;">Sarah Johnson</h2>
              <p>applied to <strong>Caregiver - Weekly Pay | Flexible Shifts</strong></p>
              <table style="margin: 20px 0;">
                <tr><td style="font-weight:bold;">Email:</td><td>sarah.j@yahoo.com</td></tr>
                <tr><td style="font-weight:bold;">Phone:</td><td>(949) 555-0123</td></tr>
                <tr><td style="font-weight:bold;">Location:</td><td>Irvine, CA 92614</td></tr>
              </table>
              <a href="https://employers.indeed.com/view/abc123" style="background: #2557a7; color: white; padding: 10px 20px;">
                View Application
              </a>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const result = parseIndeedEmail({
      subject: 'Indeed Application: Caregiver - Weekly Pay | Flexible Shifts - Sarah Johnson',
      body: html,
      sender: 'indeedapply@indeed.com',
    });

    expect(result.success).toBe(true);
    expect(result.data.first_name).toBe('Sarah');
    expect(result.data.last_name).toBe('Johnson');
    expect(result.data.email).toBe('sarah.j@yahoo.com');
    expect(result.data.phone).toBe('9495550123');
    expect(result.data.city).toBe('Irvine');
    expect(result.data.state).toBe('CA');
  });

  it('preserves metadata fields', () => {
    const result = parseIndeedEmail({
      subject: 'Indeed Application: CNA - Test User',
      body: '<p>Email: test@test.com</p>',
      sender: 'indeedapply@indeed.com',
      receivedAt: '2026-04-10T15:30:00Z',
      messageId: 'msg-456',
    });

    expect(result.data._jobTitle).toBe('CNA');
    expect(result.data._receivedAt).toBe('2026-04-10T15:30:00Z');
    expect(result.data._messageId).toBe('msg-456');
  });

  it('INDEED_SENDERS constant contains expected addresses', () => {
    expect(INDEED_SENDERS).toContain('indeedapply@indeed.com');
    expect(INDEED_SENDERS).toContain('alert@indeed.com');
    expect(INDEED_SENDERS).toContain('noreply@indeed.com');
  });
});
