import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mapCaregiverFields,
  mapClientFields,
  isPlaceholderData,
  normalizePhone,
  buildInitialNote,
} from '../intakeProcessing.js';

// ═══════════════════════════════════════════════════════════════
// normalizePhone
// ═══════════════════════════════════════════════════════════════

describe('normalizePhone', () => {
  it('strips dashes from phone number', () => {
    expect(normalizePhone('555-123-4567')).toBe('5551234567');
  });

  it('strips parentheses, spaces, and country code prefix', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('5551234567');
  });

  it('strips leading 1 from 11-digit US number', () => {
    expect(normalizePhone('15551234567')).toBe('5551234567');
  });

  it('returns already-clean 10-digit number unchanged', () => {
    expect(normalizePhone('5551234567')).toBe('5551234567');
  });

  it('handles dots as separators', () => {
    expect(normalizePhone('555.123.4567')).toBe('5551234567');
  });

  it('returns empty string for empty input', () => {
    expect(normalizePhone('')).toBe('');
  });

  it('handles short numbers without stripping', () => {
    expect(normalizePhone('1234')).toBe('1234');
  });

  it('does not strip leading 1 from 10-digit number starting with 1', () => {
    // 10-digit number starting with 1 should stay as-is
    expect(normalizePhone('1234567890')).toBe('1234567890');
  });
});

// ═══════════════════════════════════════════════════════════════
// isPlaceholderData
// ═══════════════════════════════════════════════════════════════

describe('isPlaceholderData', () => {
  it('returns true when all fields are placeholder labels', () => {
    expect(
      isPlaceholderData({
        first_name: 'First Name',
        last_name: 'Last Name',
        email: 'Email Address',
        phone: 'Phone',
      })
    ).toBe(true);
  });

  it('returns true for empty data object', () => {
    expect(isPlaceholderData({})).toBe(true);
  });

  it('returns false for real data', () => {
    expect(
      isPlaceholderData({
        first_name: 'Maria',
        phone: '5551234567',
      })
    ).toBe(false);
  });

  it('returns true when only placeholder first_name is present', () => {
    expect(isPlaceholderData({ first_name: 'Your First Name' })).toBe(true);
  });

  it('returns false when at least one field has real data', () => {
    expect(
      isPlaceholderData({
        first_name: 'First Name',
        email: 'maria@example.com',
      })
    ).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(
      isPlaceholderData({
        first_name: 'FIRST NAME',
        last_name: 'LAST NAME',
      })
    ).toBe(true);
  });

  it('trims whitespace before checking', () => {
    expect(
      isPlaceholderData({
        first_name: '  First Name  ',
        email: '  Email  ',
      })
    ).toBe(true);
  });

  it('returns true for "Your Name" style placeholders', () => {
    expect(
      isPlaceholderData({
        first_name: 'Your Name',
      })
    ).toBe(true);
  });

  it('returns true for generic "Name" and "Email" placeholders', () => {
    expect(
      isPlaceholderData({
        first_name: 'Name',
        email: 'Email',
      })
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// mapCaregiverFields
// ═══════════════════════════════════════════════════════════════

describe('mapCaregiverFields', () => {
  // ── Standard snake_case fields ──

  it('maps standard snake_case fields to correct columns', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      last_name: 'Nash',
      email: 'kevin@example.com',
      phone: '555-123-4567',
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
    expect(result.caregiverData.last_name).toBe('Nash');
    expect(result.caregiverData.email).toBe('kevin@example.com');
    expect(result.caregiverData.phone).toBe('5551234567');
  });

  // ── Forminator underscore format ──

  it('maps Forminator underscore format fields', () => {
    const result = mapCaregiverFields({
      name_1_first_name: 'Maria',
      name_1_last_name: 'Garcia',
      email_1: 'maria@example.com',
      phone_1: '(555) 987-6543',
    });
    expect(result.caregiverData.first_name).toBe('Maria');
    expect(result.caregiverData.last_name).toBe('Garcia');
    expect(result.caregiverData.email).toBe('maria@example.com');
    expect(result.caregiverData.phone).toBe('5559876543');
  });

  // ── camelCase format ──

  it('maps camelCase fields', () => {
    const result = mapCaregiverFields({
      firstName: 'John',
      lastName: 'Doe',
    });
    expect(result.caregiverData.first_name).toBe('John');
    expect(result.caregiverData.last_name).toBe('Doe');
  });

  // ── Full name splitting ──

  it('splits full_name into first and last name', () => {
    const result = mapCaregiverFields({
      full_name: 'Kevin Nash',
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
    expect(result.caregiverData.last_name).toBe('Nash');
  });

  it('splits name field into first and last name', () => {
    const result = mapCaregiverFields({
      name: 'Maria Garcia Lopez',
    });
    expect(result.caregiverData.first_name).toBe('Maria');
    expect(result.caregiverData.last_name).toBe('Garcia Lopez');
  });

  it('handles single-word name gracefully', () => {
    const result = mapCaregiverFields({
      full_name: 'Madonna',
    });
    expect(result.caregiverData.first_name).toBe('Madonna');
    expect(result.caregiverData.last_name).toBe('');
  });

  // ── Forminator name-1 as object ──

  it('handles Forminator name-1 as object with sub-fields', () => {
    const result = mapCaregiverFields({
      'name-1': { 'first-name': 'Kevin', 'last-name': 'Nash' },
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
    expect(result.caregiverData.last_name).toBe('Nash');
  });

  it('handles Forminator name-1 as string (full name)', () => {
    const result = mapCaregiverFields({
      'name-1': 'Kevin Nash',
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
    expect(result.caregiverData.last_name).toBe('Nash');
  });

  // ── Subject and message fields ──

  it('stores subject in noteSubject (not as a column)', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      subject: 'Interested in caregiver position',
    });
    expect(result.noteSubject).toBe('Interested in caregiver position');
    expect(result.caregiverData.subject).toBeUndefined();
  });

  it('stores message in noteMessage (not as a column)', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      message: 'I have 5 years of experience',
    });
    expect(result.noteMessage).toBe('I have 5 years of experience');
    expect(result.caregiverData.message).toBeUndefined();
  });

  it('maps textarea-1 to noteMessage', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      'textarea-1': 'Please contact me about open positions',
    });
    expect(result.noteMessage).toBe('Please contact me about open positions');
  });

  it('maps textarea_1 to noteMessage', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      textarea_1: 'I am looking for work',
    });
    expect(result.noteMessage).toBe('I am looking for work');
  });

  it('maps comments to noteMessage', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      comments: 'Available immediately',
    });
    expect(result.noteMessage).toBe('Available immediately');
  });

  it('maps notes field to noteMessage', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      notes: 'I can start Monday',
    });
    expect(result.noteMessage).toBe('I can start Monday');
  });

  it('maps your_message to noteMessage', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      your_message: 'Reaching out about the position',
    });
    expect(result.noteMessage).toBe('Reaching out about the position');
  });

  // ── Address fields ──

  it('maps address fields correctly', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      address: '123 Main St',
      city: 'Los Angeles',
      state: 'CA',
      zip: '90001',
    });
    expect(result.caregiverData.address).toBe('123 Main St');
    expect(result.caregiverData.city).toBe('Los Angeles');
    expect(result.caregiverData.state).toBe('CA');
    expect(result.caregiverData.zip).toBe('90001');
  });

  it('maps Forminator address underscore format', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      address_1_street_address: '456 Oak Ave',
      address_1_city: 'Pasadena',
      address_1_state: 'CA',
      address_1_zip: '91101',
    });
    expect(result.caregiverData.address).toBe('456 Oak Ave');
    expect(result.caregiverData.city).toBe('Pasadena');
    expect(result.caregiverData.state).toBe('CA');
    expect(result.caregiverData.zip).toBe('91101');
  });

  // ── Metadata skipping ──

  it('skips metadata fields', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      form_id: '12345',
      consent: 'true',
      _wp_nonce: 'abc123',
      action: 'submit',
      'captcha-1': 'xyz',
      'html-1': '<div>test</div>',
      'section-1': 'Section 1',
      checkbox_1: 'yes',
      consent_1: 'agreed',
      form_title: 'Apply Now',
      entry_time: '2026-01-01',
      render_id: '999',
      form_module_id: '42',
      is_submit: 'true',
      _wp_http_referer: '/apply',
      nonce: 'nonce123',
      entry: 'entry-data',
      entry_id: 'eid-123',
      date_created_sql: '2026-01-01 00:00:00',
      submission_time: '1234567890',
      referer: 'https://example.com',
      api_key: 'secret',
      _field_map: '{}',
      page_id: '10',
      form_type: 'forminator',
      site_url: 'https://example.com',
      submission_id: 'sub-123',
      referer_url: 'https://example.com/form',
      current_url: 'https://example.com/form',
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
    expect(Object.keys(result.caregiverData)).toHaveLength(1);
    expect(Object.keys(result.unmappedFields)).toHaveLength(0);
  });

  // ── Empty/null handling ──

  it('handles empty string values gracefully', () => {
    const result = mapCaregiverFields({
      first_name: '',
      last_name: '',
      email: '',
    });
    expect(result.caregiverData).toEqual({});
    expect(result.unmappedFields).toEqual({});
  });

  it('handles null values gracefully', () => {
    const result = mapCaregiverFields({
      first_name: null,
      last_name: null,
    });
    expect(result.caregiverData).toEqual({});
    expect(result.unmappedFields).toEqual({});
  });

  it('handles undefined values gracefully', () => {
    const result = mapCaregiverFields({
      first_name: undefined,
      last_name: undefined,
    });
    expect(result.caregiverData).toEqual({});
    expect(result.unmappedFields).toEqual({});
  });

  // ── Unmapped fields ──

  it('returns unmapped fields for unknown keys', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      favorite_color: 'blue',
      shoe_size: '11',
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
    expect(result.unmappedFields).toEqual({
      favorite_color: 'blue',
      shoe_size: '11',
    });
  });

  // ── Phone normalization ──

  it('normalizes phone during mapping', () => {
    const result = mapCaregiverFields({
      phone: '+1 (555) 123-4567',
    });
    expect(result.caregiverData.phone).toBe('5551234567');
  });

  // ── First-match-wins ──

  it('uses first match when multiple aliases present', () => {
    const result = mapCaregiverFields({
      first_name: 'Kevin',
      firstName: 'John',
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
  });

  // ── Google Ads / generic field names ──

  it('maps user_email to email', () => {
    const result = mapCaregiverFields({
      user_email: 'user@example.com',
    });
    expect(result.caregiverData.email).toBe('user@example.com');
  });

  it('maps phone_number to phone', () => {
    const result = mapCaregiverFields({
      phone_number: '5551234567',
    });
    expect(result.caregiverData.phone).toBe('5551234567');
  });

  it('maps postal_code to zip', () => {
    const result = mapCaregiverFields({
      postal_code: '90210',
    });
    expect(result.caregiverData.zip).toBe('90210');
  });

  it('maps street_address to address', () => {
    const result = mapCaregiverFields({
      street_address: '789 Pine Blvd',
    });
    expect(result.caregiverData.address).toBe('789 Pine Blvd');
  });

  // ── Forminator hyphen format ──

  it('maps Forminator hyphen-format fields', () => {
    const result = mapCaregiverFields({
      'email-1': 'test@forminator.com',
      'phone-1': '5559991234',
    });
    expect(result.caregiverData.email).toBe('test@forminator.com');
    expect(result.caregiverData.phone).toBe('5559991234');
  });

  it('maps text-1 and text-2 to first_name and last_name', () => {
    const result = mapCaregiverFields({
      'text-1': 'Ana',
      'text-2': 'Martinez',
    });
    expect(result.caregiverData.first_name).toBe('Ana');
    expect(result.caregiverData.last_name).toBe('Martinez');
  });

  it('maps address-1 to address', () => {
    const result = mapCaregiverFields({
      'address-1': '100 Broadway',
    });
    expect(result.caregiverData.address).toBe('100 Broadway');
  });

  // ── Forminator text_1 / text_2 underscore format ──

  it('maps text_1 and text_2 to first_name and last_name', () => {
    const result = mapCaregiverFields({
      text_1: 'Carlos',
      text_2: 'Reyes',
    });
    expect(result.caregiverData.first_name).toBe('Carlos');
    expect(result.caregiverData.last_name).toBe('Reyes');
  });

  // ── zip_code alias ──

  it('maps zip_code to zip', () => {
    const result = mapCaregiverFields({
      zip_code: '60601',
    });
    expect(result.caregiverData.zip).toBe('60601');
  });

  // ── fullname alias ──

  it('maps fullname to first and last via full-name split', () => {
    const result = mapCaregiverFields({
      fullname: 'Anna Smith',
    });
    expect(result.caregiverData.first_name).toBe('Anna');
    expect(result.caregiverData.last_name).toBe('Smith');
  });

  // ── Forminator sub-field names ──

  it('maps first-name and last-name sub-field aliases', () => {
    const result = mapCaregiverFields({
      'first-name': 'Jose',
      'last-name': 'Rivera',
    });
    expect(result.caregiverData.first_name).toBe('Jose');
    expect(result.caregiverData.last_name).toBe('Rivera');
  });

  // ── Trims whitespace ──

  it('trims whitespace from string values', () => {
    const result = mapCaregiverFields({
      first_name: '  Kevin  ',
      email: '  kevin@example.com  ',
    });
    expect(result.caregiverData.first_name).toBe('Kevin');
    expect(result.caregiverData.email).toBe('kevin@example.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// mapClientFields
// ═══════════════════════════════════════════════════════════════

describe('mapClientFields', () => {
  // ── Standard client fields ──

  it('maps standard client fields', () => {
    const result = mapClientFields({
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@example.com',
      phone: '555-123-4567',
    });
    expect(result.clientData.first_name).toBe('John');
    expect(result.clientData.last_name).toBe('Smith');
    expect(result.clientData.email).toBe('john@example.com');
    expect(result.clientData.phone).toBe('5551234567');
  });

  // ── Client-specific fields ──

  it('maps care_recipient_name', () => {
    const result = mapClientFields({
      first_name: 'John',
      care_recipient_name: 'Grandma Rose',
    });
    expect(result.clientData.care_recipient_name).toBe('Grandma Rose');
  });

  it('maps relationship', () => {
    const result = mapClientFields({
      first_name: 'John',
      relationship: 'Son',
    });
    expect(result.clientData.relationship).toBe('Son');
  });

  it('maps care consultation relationship aliases', () => {
    const result = mapClientFields({
      first_name: 'John',
      i_m_interested_in_home_care_services_for: 'A Parent',
    });
    expect(result.clientData.relationship).toBe('A Parent');
  });

  it('maps hours_needed', () => {
    const result = mapClientFields({
      first_name: 'John',
      hours_needed: '40',
    });
    expect(result.clientData.hours_needed).toBe('40');
  });

  it('maps budget_range', () => {
    const result = mapClientFields({
      first_name: 'John',
      budget_range: '$20-30/hr',
    });
    expect(result.clientData.budget_range).toBe('$20-30/hr');
  });

  it('maps care_needs', () => {
    const result = mapClientFields({
      first_name: 'John',
      care_needs: 'Daily living assistance',
    });
    expect(result.clientData.care_needs).toBe('Daily living assistance');
  });

  it('maps insurance_info', () => {
    const result = mapClientFields({
      first_name: 'John',
      insurance_info: 'Medicare Part A',
    });
    expect(result.clientData.insurance_info).toBe('Medicare Part A');
  });

  it('maps contact_name', () => {
    const result = mapClientFields({
      first_name: 'John',
      contact_name: 'Jane Smith',
    });
    expect(result.clientData.contact_name).toBe('Jane Smith');
  });

  it('maps start_date_preference', () => {
    const result = mapClientFields({
      first_name: 'John',
      start_date_preference: 'ASAP',
    });
    expect(result.clientData.start_date_preference).toBe('ASAP');
  });

  // ── camelCase client fields ──

  it('maps camelCase client-specific fields', () => {
    const result = mapClientFields({
      firstName: 'John',
      lastName: 'Smith',
      careRecipientName: 'Grandma Rose',
      hoursNeeded: '20',
      budgetRange: '$25/hr',
    });
    expect(result.clientData.first_name).toBe('John');
    expect(result.clientData.last_name).toBe('Smith');
    expect(result.clientData.care_recipient_name).toBe('Grandma Rose');
    expect(result.clientData.hours_needed).toBe('20');
    expect(result.clientData.budget_range).toBe('$25/hr');
  });

  // ── Forminator underscore format ──

  it('maps Forminator underscore format for clients', () => {
    const result = mapClientFields({
      name_1_first_name: 'Sarah',
      name_1_last_name: 'Connor',
      email_1: 'sarah@example.com',
      phone_1: '5551234567',
    });
    expect(result.clientData.first_name).toBe('Sarah');
    expect(result.clientData.last_name).toBe('Connor');
    expect(result.clientData.email).toBe('sarah@example.com');
    expect(result.clientData.phone).toBe('5551234567');
  });

  // ── Forminator name-1 as object ──

  it('handles Forminator name-1 as object with sub-fields', () => {
    const result = mapClientFields({
      'name-1': { 'first-name': 'Sarah', 'last-name': 'Connor' },
    });
    expect(result.clientData.first_name).toBe('Sarah');
    expect(result.clientData.last_name).toBe('Connor');
  });

  // ── Address mapping ──

  it('maps Forminator address fields for clients', () => {
    const result = mapClientFields({
      first_name: 'John',
      address_1_street_address: '123 Main St',
      address_1_city: 'Los Angeles',
      address_1_state: 'CA',
      address_1_zip: '90001',
    });
    expect(result.clientData.address).toBe('123 Main St');
    expect(result.clientData.city).toBe('Los Angeles');
    expect(result.clientData.state).toBe('CA');
    expect(result.clientData.zip).toBe('90001');
  });

  it('maps zip_postal_code alias to zip', () => {
    const result = mapClientFields({
      first_name: 'John',
      zip_postal_code: '92618',
    });
    expect(result.clientData.zip).toBe('92618');
  });

  // ── textarea-1 maps to care_needs for clients ──

  it('maps textarea-1 to care_needs for clients', () => {
    const result = mapClientFields({
      first_name: 'John',
      'textarea-1': 'Need help with daily tasks',
    });
    expect(result.clientData.care_needs).toBe('Need help with daily tasks');
  });

  // ── message/comments/notes map to care_needs for clients ──

  it('maps message field to care_needs for clients', () => {
    const result = mapClientFields({
      first_name: 'John',
      message: 'Looking for in-home care',
    });
    expect(result.clientData.care_needs).toBe('Looking for in-home care');
  });

  // ── Unmapped fields ──

  it('returns unmapped fields for unknown client keys', () => {
    const result = mapClientFields({
      first_name: 'John',
      unknown_field: 'some value',
    });
    expect(result.unmappedFields).toEqual({ unknown_field: 'some value' });
  });

  // ── Skip fields ──

  it('skips metadata fields for clients', () => {
    const result = mapClientFields({
      first_name: 'John',
      form_id: '12345',
      _wp_nonce: 'abc',
      'captcha-1': 'xyz',
    });
    expect(result.clientData.first_name).toBe('John');
    expect(Object.keys(result.clientData)).toHaveLength(1);
    expect(Object.keys(result.unmappedFields)).toHaveLength(0);
  });

  // ── Empty/null handling ──

  it('handles empty values gracefully', () => {
    const result = mapClientFields({
      first_name: '',
      email: null,
      phone: undefined,
    });
    expect(result.clientData).toEqual({});
  });

  // ── Full name splitting ──

  it('splits full_name for clients', () => {
    const result = mapClientFields({
      full_name: 'John Smith',
    });
    expect(result.clientData.first_name).toBe('John');
    expect(result.clientData.last_name).toBe('Smith');
  });

  // ── Google Ads fields ──

  it('maps Google Ads fields for clients', () => {
    const result = mapClientFields({
      user_email: 'ads@example.com',
      phone_number: '5559998888',
      postal_code: '90210',
      street_address: '100 Sunset Blvd',
    });
    expect(result.clientData.email).toBe('ads@example.com');
    expect(result.clientData.phone).toBe('5559998888');
    expect(result.clientData.zip).toBe('90210');
    expect(result.clientData.address).toBe('100 Sunset Blvd');
  });

  // ── Meta/Facebook fields ──

  it('maps Meta/Facebook lead ad fields', () => {
    const result = mapClientFields({
      email_fb: 'meta@example.com',
      phone_number_fb: '5551112222',
      zip_code: '10001',
    });
    expect(result.clientData.email).toBe('meta@example.com');
    expect(result.clientData.phone).toBe('5551112222');
    expect(result.clientData.zip).toBe('10001');
  });
});

// ═══════════════════════════════════════════════════════════════
// buildInitialNote
// ═══════════════════════════════════════════════════════════════

describe('buildInitialNote', () => {
  let realDateNow;

  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = vi.fn(() => 1700000000000);
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it('creates correct note structure', () => {
    const note = buildInitialNote('wordpress', 'Contact Form');
    expect(note).toEqual({
      text: 'Caregiver created via wordpress (Contact Form).',
      type: 'auto',
      timestamp: 1700000000000,
      author: 'Intake Webhook',
    });
  });

  it('builds note without label when label is empty', () => {
    const note = buildInitialNote('webhook', '');
    expect(note.text).toBe('Caregiver created via webhook.');
  });

  it('builds note without label when label is null', () => {
    const note = buildInitialNote('webhook', null);
    expect(note.text).toBe('Caregiver created via webhook.');
  });

  it('includes unmapped fields summary when present', () => {
    const note = buildInitialNote('wordpress', 'Apply', {
      favorite_color: 'blue',
      shoe_size: '11',
    });
    expect(note.text).toContain('Additional form data:');
    expect(note.text).toContain('favorite_color: blue');
    expect(note.text).toContain('shoe_size: 11');
  });

  it('omits unmapped fields when empty object', () => {
    const note = buildInitialNote('wordpress', 'Apply', {});
    expect(note.text).not.toContain('Additional form data');
  });

  it('omits unmapped fields when null', () => {
    const note = buildInitialNote('wordpress', 'Apply', null);
    expect(note.text).not.toContain('Additional form data');
  });

  it('includes extra text when provided', () => {
    const note = buildInitialNote(
      'wordpress',
      'Apply',
      null,
      'Subject: I want to apply\nMessage: I have experience'
    );
    expect(note.text).toContain('Subject: I want to apply');
    expect(note.text).toContain('Message: I have experience');
  });

  it('includes both extra text and unmapped fields', () => {
    const note = buildInitialNote(
      'wordpress',
      'Apply',
      { extra_field: 'value' },
      'Subject: Hello'
    );
    expect(note.text).toContain('Subject: Hello');
    expect(note.text).toContain('extra_field: value');
  });

  it('always has type "auto" and author "Intake Webhook"', () => {
    const note = buildInitialNote('test', 'Test');
    expect(note.type).toBe('auto');
    expect(note.author).toBe('Intake Webhook');
  });

  it('uses Date.now() for timestamp', () => {
    const note = buildInitialNote('test', 'Test');
    expect(note.timestamp).toBe(1700000000000);
  });
});
