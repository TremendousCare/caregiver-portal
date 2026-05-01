/**
 * Tests for getBookingUrlFromOrgSettings — locks the JSON path inside
 * organizations.settings where the per-org Microsoft Bookings public URL
 * lives. If the migration that seeds it (20260504000000) ever changes
 * shape, these tests force the helper and the migration to stay in sync.
 */

import { describe, it, expect } from 'vitest';
import {
  getBookingUrlFromOrgSettings,
  getBookingsBusinessIdFromOrgSettings,
  BOOKINGS_SETTINGS_KEY,
  BOOKINGS_PUBLIC_URL_KEY,
  BOOKINGS_BUSINESS_ID_KEY,
  phoneDigits,
  normalizeEmail,
  matchCustomerToCaregiver,
  graphDateTimeToIso,
  normalizeGraphAppointment,
} from '../../../supabase/functions/_shared/helpers/bookings.ts';

describe('getBookingUrlFromOrgSettings', () => {
  it('returns the public URL when shape is correct', () => {
    const url = getBookingUrlFromOrgSettings({
      bookings: {
        public_url: 'https://outlook.office.com/book/Foo@bar.com/',
        business_id: 'Foo@bar.com',
      },
    });
    expect(url).toBe('https://outlook.office.com/book/Foo@bar.com/');
  });

  it('returns empty string when settings is null', () => {
    expect(getBookingUrlFromOrgSettings(null)).toBe('');
  });

  it('returns empty string when settings is undefined', () => {
    expect(getBookingUrlFromOrgSettings(undefined)).toBe('');
  });

  it('returns empty string when settings is not an object', () => {
    expect(getBookingUrlFromOrgSettings('not an object')).toBe('');
    expect(getBookingUrlFromOrgSettings(42)).toBe('');
  });

  it('returns empty string when bookings block is missing', () => {
    expect(getBookingUrlFromOrgSettings({})).toBe('');
    expect(getBookingUrlFromOrgSettings({ paychex: {} })).toBe('');
  });

  it('returns empty string when bookings block is not an object', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: null })).toBe('');
    expect(getBookingUrlFromOrgSettings({ bookings: 'string' })).toBe('');
  });

  it('returns empty string when public_url is missing', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: { business_id: 'x' } })).toBe('');
  });

  it('returns empty string when public_url is not a string', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: { public_url: null } })).toBe('');
    expect(getBookingUrlFromOrgSettings({ bookings: { public_url: 42 } })).toBe('');
  });

  it('does not crash on deeply unexpected shapes', () => {
    expect(getBookingUrlFromOrgSettings({ bookings: { public_url: { nested: 'oops' } } })).toBe('');
  });

  it('exports the JSON path constants', () => {
    expect(BOOKINGS_SETTINGS_KEY).toBe('bookings');
    expect(BOOKINGS_PUBLIC_URL_KEY).toBe('public_url');
    expect(BOOKINGS_BUSINESS_ID_KEY).toBe('business_id');
  });
});

describe('getBookingsBusinessIdFromOrgSettings', () => {
  it('returns the business_id when shape is correct', () => {
    expect(
      getBookingsBusinessIdFromOrgSettings({
        bookings: { business_id: 'foo@bar.com' },
      }),
    ).toBe('foo@bar.com');
  });

  it('returns empty string for null/missing/wrong-typed shapes', () => {
    expect(getBookingsBusinessIdFromOrgSettings(null)).toBe('');
    expect(getBookingsBusinessIdFromOrgSettings(undefined)).toBe('');
    expect(getBookingsBusinessIdFromOrgSettings({})).toBe('');
    expect(getBookingsBusinessIdFromOrgSettings({ bookings: null })).toBe('');
    expect(getBookingsBusinessIdFromOrgSettings({ bookings: { business_id: 42 } })).toBe('');
  });
});

describe('phoneDigits', () => {
  it('returns last 10 digits stripping all formatting variants', () => {
    expect(phoneDigits('(555) 867-5309')).toBe('5558675309');
    expect(phoneDigits('+1 555-867-5309')).toBe('5558675309');
    expect(phoneDigits('555.867.5309')).toBe('5558675309');
    expect(phoneDigits('15558675309')).toBe('5558675309');
    expect(phoneDigits('+15558675309')).toBe('5558675309');
  });

  it('returns empty string for short or missing numbers', () => {
    expect(phoneDigits('')).toBe('');
    expect(phoneDigits(null)).toBe('');
    expect(phoneDigits(undefined)).toBe('');
    expect(phoneDigits('123')).toBe('');
    expect(phoneDigits('abc')).toBe('');
    // Non-string inputs
    expect(phoneDigits(5558675309)).toBe('');
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM  ')).toBe('foo@bar.com');
    expect(normalizeEmail('jane@example.com')).toBe('jane@example.com');
  });

  it('returns empty string for missing/non-string inputs', () => {
    expect(normalizeEmail('')).toBe('');
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail(42)).toBe('');
  });
});

describe('matchCustomerToCaregiver', () => {
  const caregivers = [
    { id: 'cg1', phone: '(555) 111-2222', email: 'a@example.com' },
    { id: 'cg2', phone: '+1 555 333 4444', email: 'B@Example.com' },
    { id: 'cg3', phone: null, email: 'c@example.com' },
  ];

  it('matches by phone when phone is present and unique', () => {
    const result = matchCustomerToCaregiver(
      { phone: '5551112222', email: 'unrelated@example.com' },
      caregivers,
    );
    expect(result.caregiver?.id).toBe('cg1');
    expect(result.matchMethod).toBe('phone');
  });

  it('falls back to email match when phone does not match', () => {
    const result = matchCustomerToCaregiver(
      { phone: '9999999999', email: 'b@example.com' },
      caregivers,
    );
    expect(result.caregiver?.id).toBe('cg2');
    expect(result.matchMethod).toBe('email');
  });

  it('email match is case-insensitive and trims', () => {
    const result = matchCustomerToCaregiver(
      { email: '  C@EXAMPLE.COM  ' },
      caregivers,
    );
    expect(result.caregiver?.id).toBe('cg3');
    expect(result.matchMethod).toBe('email');
  });

  it('returns unmatched when nothing matches', () => {
    const result = matchCustomerToCaregiver(
      { phone: '0000000000', email: 'nobody@example.com' },
      caregivers,
    );
    expect(result.caregiver).toBeNull();
    expect(result.matchMethod).toBe('unmatched');
  });

  it('returns unmatched when customer has no phone or email', () => {
    const result = matchCustomerToCaregiver({}, caregivers);
    expect(result.caregiver).toBeNull();
    expect(result.matchMethod).toBe('unmatched');
  });

  it('phone match wins over email match (phone is primary)', () => {
    const cgs = [
      { id: 'cg1', phone: '5551112222', email: 'a@example.com' },
      { id: 'cg2', phone: '5559999999', email: 'b@example.com' },
    ];
    const result = matchCustomerToCaregiver(
      { phone: '5551112222', email: 'b@example.com' },
      cgs,
    );
    expect(result.caregiver?.id).toBe('cg1');
    expect(result.matchMethod).toBe('phone');
  });

  it('handles caregivers with null phone/email gracefully', () => {
    const cgs = [{ id: 'cg1', phone: null, email: null }];
    const result = matchCustomerToCaregiver(
      { phone: '5551112222' },
      cgs,
    );
    expect(result.caregiver).toBeNull();
    expect(result.matchMethod).toBe('unmatched');
  });
});

describe('graphDateTimeToIso', () => {
  it('appends Z when no offset present', () => {
    expect(graphDateTimeToIso({ dateTime: '2026-05-12T14:30:00.0000000', timeZone: 'UTC' }))
      .toBe('2026-05-12T14:30:00.0000000Z');
  });

  it('keeps the offset when one is already present', () => {
    expect(graphDateTimeToIso({ dateTime: '2026-05-12T14:30:00Z' }))
      .toBe('2026-05-12T14:30:00Z');
    expect(graphDateTimeToIso({ dateTime: '2026-05-12T14:30:00-07:00' }))
      .toBe('2026-05-12T14:30:00-07:00');
  });

  it('returns null for missing/invalid inputs', () => {
    expect(graphDateTimeToIso(null)).toBeNull();
    expect(graphDateTimeToIso(undefined)).toBeNull();
    expect(graphDateTimeToIso({})).toBeNull();
    expect(graphDateTimeToIso({ dateTime: null })).toBeNull();
  });
});

describe('normalizeGraphAppointment', () => {
  const baseAppt = {
    id: 'AAMk-appt-123',
    serviceId: 'svc-1',
    serviceName: 'Caregiver Interview',
    staffMemberIds: ['staff-1', 'staff-2'],
    startDateTime: { dateTime: '2026-05-12T14:30:00.0000000', timeZone: 'UTC' },
    endDateTime: { dateTime: '2026-05-12T15:00:00.0000000', timeZone: 'UTC' },
    isLocationOnline: true,
    joinWebUrl: 'https://teams.microsoft.com/abc',
    customers: [
      {
        customerId: 'cust-1',
        name: 'Jane Doe',
        emailAddress: 'jane@example.com',
        phone: '(555) 867-5309',
        notes: 'Looking forward to it',
      },
    ],
  };

  it('flattens the appointment to the table contract', () => {
    const result = normalizeGraphAppointment(baseAppt);
    expect(result.graph_appointment_id).toBe('AAMk-appt-123');
    expect(result.service_id).toBe('svc-1');
    expect(result.service_name).toBe('Caregiver Interview');
    expect(result.staff_member_ids).toEqual(['staff-1', 'staff-2']);
    expect(result.start_at).toBe('2026-05-12T14:30:00.0000000Z');
    expect(result.end_at).toBe('2026-05-12T15:00:00.0000000Z');
    expect(result.status).toBe('booked');
    expect(result.customer_name).toBe('Jane Doe');
    expect(result.customer_email).toBe('jane@example.com');
    expect(result.customer_phone).toBe('(555) 867-5309');
    expect(result.customer_notes).toBe('Looking forward to it');
    expect(result.join_web_url).toBe('https://teams.microsoft.com/abc');
  });

  it('marks status cancelled when cancellationReason is set', () => {
    const result = normalizeGraphAppointment({
      ...baseAppt,
      cancellationReason: 'Customer requested',
    });
    expect(result.status).toBe('cancelled');
  });

  it('keeps status booked when cancellationReason is null/empty', () => {
    expect(normalizeGraphAppointment({ ...baseAppt, cancellationReason: null }).status)
      .toBe('booked');
    expect(normalizeGraphAppointment({ ...baseAppt, cancellationReason: '' }).status)
      .toBe('booked');
  });

  it('handles missing customers array', () => {
    const { customers, ...rest } = baseAppt;
    const result = normalizeGraphAppointment(rest);
    expect(result.customer_name).toBeNull();
    expect(result.customer_email).toBeNull();
    expect(result.customer_phone).toBeNull();
  });

  it('handles missing optional fields gracefully', () => {
    const result = normalizeGraphAppointment({ id: 'a' });
    expect(result.graph_appointment_id).toBe('a');
    expect(result.service_id).toBeNull();
    expect(result.staff_member_ids).toEqual([]);
    expect(result.start_at).toBeNull();
    expect(result.end_at).toBeNull();
    expect(result.status).toBe('booked');
  });

  it('filters non-string staff_member_ids', () => {
    const result = normalizeGraphAppointment({
      id: 'a',
      staffMemberIds: ['ok', null, 42, 'also-ok'],
    });
    expect(result.staff_member_ids).toEqual(['ok', 'also-ok']);
  });
});

