// Payload builder tests for the dispatch-lead-notifications worker.
//
// The SMS body and Teams Adaptive Card are user-visible strings; a
// regression in formatting (a stray "undefined", a swapped first/last
// name, a missing tel: prefix) is easy to introduce and hard to spot
// from the dispatcher's structured logs alone. These tests pin down
// the contract:
//   • SMS includes name, phone (formatted), profile URL, source.
//   • Teams card includes a click-to-call button when phone is present.
//   • Overnight tag fires only when the queue row is >30 min old.
//   • Lead name falls back through several columns so we never say
//     "New Lead: undefined".

import { describe, it, expect } from 'vitest';
import {
  buildSmsBody,
  buildTeamsAdaptiveCard,
  buildToastRow,
  buildOvernightTag,
  formatPhoneForDisplay,
  normalizePhoneE164,
  leadProfileUrl,
} from '../../../supabase/functions/_shared/helpers/leadNotifications.ts';

const LA_TZ = 'America/Los_Angeles';

const baseLead = {
  id: 'lead_abc',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+17025551234',
  email: 'jane@example.com',
  city: 'Henderson',
  state: 'NV',
  care_needs: 'Live-in care',
  referral_source: 'Web form',
  hours_needed: '40/wk',
  budget_range: '$5-7k/mo',
  start_date_preference: 'ASAP',
  referral_detail: 'Google search "live-in caregiver Henderson"',
  contact_name: '',
  care_recipient_name: '',
};

const baseQueueRow = {
  id: 'queue_xyz',
  org_id: 'org_1',
  lead_id: 'lead_abc',
  scheduled_for: '2026-05-23T15:00:00Z',
  created_at: '2026-05-23T15:00:00Z',
};

const profileUrl = leadProfileUrl(
  'https://caregiver-portal.vercel.app',
  'lead_abc',
);

describe('formatPhoneForDisplay', () => {
  it('formats E.164 US numbers', () => {
    expect(formatPhoneForDisplay('+17025551234')).toBe('+1 (702) 555-1234');
  });

  it('formats 10-digit numbers as (XXX) YYY-ZZZZ', () => {
    expect(formatPhoneForDisplay('7025551234')).toBe('(702) 555-1234');
  });

  it('returns the original value when it cannot be parsed', () => {
    expect(formatPhoneForDisplay('not-a-phone')).toBe('not-a-phone');
  });

  it('returns empty string for null/undefined', () => {
    expect(formatPhoneForDisplay(null)).toBe('');
    expect(formatPhoneForDisplay(undefined)).toBe('');
  });
});

describe('normalizePhoneE164', () => {
  it('normalizes 10-digit US numbers to +1 prefix', () => {
    expect(normalizePhoneE164('7025551234')).toBe('+17025551234');
  });

  it('normalizes 11-digit numbers starting with 1', () => {
    expect(normalizePhoneE164('17025551234')).toBe('+17025551234');
  });

  it('normalizes already-E.164 numbers', () => {
    expect(normalizePhoneE164('+17025551234')).toBe('+17025551234');
  });

  it('returns null for invalid input', () => {
    expect(normalizePhoneE164('123')).toBe(null);
    expect(normalizePhoneE164('')).toBe(null);
    expect(normalizePhoneE164(null)).toBe(null);
  });
});

describe('leadProfileUrl', () => {
  it('builds an absolute URL to the client detail page', () => {
    expect(leadProfileUrl('https://caregiver-portal.vercel.app', 'abc'))
      .toBe('https://caregiver-portal.vercel.app/clients/abc');
  });

  it('strips trailing slashes from the base URL', () => {
    expect(leadProfileUrl('https://caregiver-portal.vercel.app/', 'abc'))
      .toBe('https://caregiver-portal.vercel.app/clients/abc');
  });

  it('URL-encodes the lead id so weird ids do not break the link', () => {
    expect(leadProfileUrl('https://x.com', 'abc/def'))
      .toBe('https://x.com/clients/abc%2Fdef');
  });
});

describe('buildOvernightTag', () => {
  const tz = LA_TZ;

  it('returns empty string for a fresh queue row (<30 min old)', () => {
    const created = new Date('2026-05-23T15:00:00Z');
    const now = new Date('2026-05-23T15:10:00Z'); // 10 min later
    expect(buildOvernightTag(
      { ...baseQueueRow, created_at: created.toISOString() },
      now,
      tz,
    )).toBe('');
  });

  it('returns a "received Xpm last night" tag for older queue rows', () => {
    const created = new Date('2026-05-23T04:42:00Z'); // 9:42pm LA
    const now = new Date('2026-05-23T14:00:00Z');     // 7:00am LA next day
    const tag = buildOvernightTag(
      { ...baseQueueRow, created_at: created.toISOString() },
      now,
      tz,
    );
    expect(tag).toMatch(/^\(received .* last night\)$/);
    expect(tag).toMatch(/9:42/);
  });

  it('returns empty string when created_at is malformed', () => {
    const now = new Date('2026-05-23T14:00:00Z');
    expect(buildOvernightTag(
      { ...baseQueueRow, created_at: 'not a date' },
      now,
      tz,
    )).toBe('');
  });
});

describe('buildSmsBody', () => {
  it('includes name, city/state, care needs, source, phone, and profile URL', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const body = buildSmsBody(baseLead, baseQueueRow, now, LA_TZ, profileUrl);
    expect(body).toContain('New Lead: Jane Doe');
    expect(body).toContain('Henderson, NV');
    expect(body).toContain('Live-in care');
    expect(body).toContain('Source: Web form');
    expect(body).toContain('Call: +1 (702) 555-1234');
    expect(body).toContain('Profile: https://caregiver-portal.vercel.app/clients/lead_abc');
  });

  it('omits city/state when both are blank', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const body = buildSmsBody(
      { ...baseLead, city: '', state: '' },
      baseQueueRow,
      now,
      LA_TZ,
      profileUrl,
    );
    expect(body).not.toMatch(/, NV/);
    expect(body).not.toMatch(/, $/m);
  });

  it('falls back to contact_name when first/last are blank', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const body = buildSmsBody(
      { ...baseLead, first_name: '', last_name: '', contact_name: 'Bob Smith' },
      baseQueueRow,
      now,
      LA_TZ,
      profileUrl,
    );
    expect(body).toContain('New Lead: Bob Smith');
  });

  it('falls back to "(unnamed lead)" when every name field is empty', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const body = buildSmsBody(
      { ...baseLead, first_name: '', last_name: '', contact_name: '', care_recipient_name: '' },
      baseQueueRow,
      now,
      LA_TZ,
      profileUrl,
    );
    expect(body).toContain('New Lead: (unnamed lead)');
  });

  it('includes the overnight tag for queue rows >30 min old', () => {
    const created = '2026-05-23T04:42:00Z'; // 9:42pm LA
    const now = new Date('2026-05-23T14:00:00Z'); // 7am LA next day
    const body = buildSmsBody(
      baseLead,
      { ...baseQueueRow, created_at: created },
      now,
      LA_TZ,
      profileUrl,
    );
    expect(body).toMatch(/\(received .* last night\)/);
  });

  it('omits the overnight tag for fresh queue rows', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const body = buildSmsBody(baseLead, baseQueueRow, now, LA_TZ, profileUrl);
    expect(body).not.toMatch(/last night/);
  });

  it('does not contain the literal string "undefined"', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const body = buildSmsBody(
      { id: 'lead_xyz' }, // every optional field undefined
      { ...baseQueueRow, lead_id: 'lead_xyz' },
      now,
      LA_TZ,
      leadProfileUrl('https://caregiver-portal.vercel.app', 'lead_xyz'),
    );
    expect(body).not.toMatch(/undefined/);
  });
});

describe('buildTeamsAdaptiveCard', () => {
  it('returns a valid Power-Automate-compatible payload shape', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const card = buildTeamsAdaptiveCard(baseLead, baseQueueRow, now, LA_TZ, profileUrl);
    expect(card.type).toBe('message');
    expect(card.attachments).toHaveLength(1);
    const attachment = card.attachments[0];
    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.content.type).toBe('AdaptiveCard');
    expect(attachment.content.version).toBe('1.4');
  });

  it('puts the lead name as the headline TextBlock', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const card = buildTeamsAdaptiveCard(baseLead, baseQueueRow, now, LA_TZ, profileUrl);
    const body = card.attachments[0].content.body;
    const headlineBlock = body.find((b) => b.text === 'Jane Doe');
    expect(headlineBlock).toBeDefined();
    expect(headlineBlock.size).toBe('ExtraLarge');
  });

  it('includes a FactSet covering Phone, Email, Location, Care Needs, Source', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const card = buildTeamsAdaptiveCard(baseLead, baseQueueRow, now, LA_TZ, profileUrl);
    const body = card.attachments[0].content.body;
    const factSet = body.find((b) => b.type === 'FactSet');
    expect(factSet).toBeDefined();
    const titles = factSet.facts.map((f) => f.title);
    expect(titles).toContain('Phone');
    expect(titles).toContain('Email');
    expect(titles).toContain('Location');
    expect(titles).toContain('Care Needs');
    expect(titles).toContain('Source');
  });

  it('omits FactSet rows for missing optional fields', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const card = buildTeamsAdaptiveCard(
      { ...baseLead, email: '', hours_needed: '', budget_range: '' },
      baseQueueRow,
      now,
      LA_TZ,
      profileUrl,
    );
    const factSet = card.attachments[0].content.body.find((b) => b.type === 'FactSet');
    const titles = factSet.facts.map((f) => f.title);
    expect(titles).not.toContain('Email');
    expect(titles).not.toContain('Hours');
    expect(titles).not.toContain('Budget');
  });

  it('renders an "Open Profile" action with the profile URL', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const card = buildTeamsAdaptiveCard(baseLead, baseQueueRow, now, LA_TZ, profileUrl);
    const actions = card.attachments[0].content.actions;
    const openAction = actions.find((a) => a.title === 'Open Profile');
    expect(openAction).toBeDefined();
    expect(openAction.url).toBe(profileUrl);
  });

  it('renders a "Call Now" tel: action when the lead has a phone', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const card = buildTeamsAdaptiveCard(baseLead, baseQueueRow, now, LA_TZ, profileUrl);
    const actions = card.attachments[0].content.actions;
    const callAction = actions.find((a) => a.title === 'Call Now');
    expect(callAction).toBeDefined();
    expect(callAction.url).toBe('tel:+17025551234');
  });

  it('omits the Call Now action when the lead has no phone', () => {
    const now = new Date('2026-05-23T15:00:00Z');
    const card = buildTeamsAdaptiveCard(
      { ...baseLead, phone: '' },
      baseQueueRow,
      now,
      LA_TZ,
      profileUrl,
    );
    const actions = card.attachments[0].content.actions;
    expect(actions.find((a) => a.title === 'Call Now')).toBeUndefined();
  });
});

describe('buildToastRow', () => {
  it('builds a notifications_user row for a recipient', () => {
    const row = buildToastRow('amy@example.com', baseLead, baseQueueRow, profileUrl);
    expect(row.org_id).toBe('org_1');
    expect(row.user_email).toBe('amy@example.com');
    expect(row.notification_type).toBe('new_lead');
    expect(row.lead_id).toBe('lead_abc');
    expect(row.title).toBe('New lead in pipeline');
    expect(row.message).toBe('Jane Doe');
    expect(row.link_url).toBe(profileUrl);
    expect(row.severity).toBe('info');
  });
});
