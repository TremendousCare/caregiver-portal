import { describe, it, expect } from 'vitest';
import { resolveEmailRoute, eligibleRoutesFor } from '../routeResolver';

const ROUTES = [
  {
    category: 'general',
    label: 'General',
    is_active: true,
    is_default: true,
    sms_from_number: null,
    sms_vault_secret_name: null,
    email_from_address: null,
    email_from_name: null,
  },
  {
    category: 'onboarding',
    label: 'Onboarding (TAS)',
    is_active: true,
    sms_from_number: '+15555550123',
    sms_vault_secret_name: 'ringcentral_jwt_onboarding',
    email_from_address: 'daniela.hernandez@tremendouscareca.com',
    email_from_name: 'Daniela Hernandez',
  },
  {
    category: 'scheduling',
    label: 'Scheduling (OC)',
    is_active: true,
    is_default: false,
    sms_from_number: '+15555550199',
    sms_vault_secret_name: 'ringcentral_jwt_scheduling',
    email_from_address: 'juliana.gurule@tremendouscareca.com',
    email_from_name: 'Juliana Gurule',
  },
  {
    category: 'inactive_route',
    label: 'Inactive',
    is_active: false,
    email_from_address: 'someone@tremendouscareca.com',
    email_from_name: 'Someone',
  },
];

describe('resolveEmailRoute', () => {
  it('returns mailbox + fromName for a configured active route', () => {
    expect(resolveEmailRoute('scheduling', ROUTES)).toEqual({
      mailbox: 'juliana.gurule@tremendouscareca.com',
      fromName: 'Juliana Gurule',
    });
  });

  it('returns the onboarding route when category=onboarding', () => {
    expect(resolveEmailRoute('onboarding', ROUTES)).toEqual({
      mailbox: 'daniela.hernandez@tremendouscareca.com',
      fromName: 'Daniela Hernandez',
    });
  });

  it('returns null when category is empty / null / missing', () => {
    expect(resolveEmailRoute(null, ROUTES)).toBeNull();
    expect(resolveEmailRoute('', ROUTES)).toBeNull();
    expect(resolveEmailRoute('   ', ROUTES)).toBeNull();
  });

  it('returns null for an unknown category', () => {
    expect(resolveEmailRoute('does_not_exist', ROUTES)).toBeNull();
  });

  it('returns null for a route with no email_from_address (e.g. general)', () => {
    expect(resolveEmailRoute('general', ROUTES)).toBeNull();
  });

  it('returns null for an inactive route even if email is configured', () => {
    expect(resolveEmailRoute('inactive_route', ROUTES)).toBeNull();
  });

  it('returns null if routes is not an array', () => {
    expect(resolveEmailRoute('scheduling', null)).toBeNull();
    expect(resolveEmailRoute('scheduling', undefined)).toBeNull();
  });

  it('lowercases the resolved mailbox address', () => {
    const upper = [{ ...ROUTES[2], email_from_address: 'Juliana.Gurule@TremendousCareCA.com' }];
    expect(resolveEmailRoute('scheduling', upper)?.mailbox)
      .toBe('juliana.gurule@tremendouscareca.com');
  });

  it('returns fromName=null when route has no email_from_name', () => {
    const noName = [{ ...ROUTES[2], email_from_name: '' }];
    expect(resolveEmailRoute('scheduling', noName)).toEqual({
      mailbox: 'juliana.gurule@tremendouscareca.com',
      fromName: null,
    });
  });
});

describe('eligibleRoutesFor', () => {
  it('returns SMS-configured routes for send_sms', () => {
    const cats = eligibleRoutesFor('send_sms', ROUTES).map((r) => r.category);
    expect(cats.sort()).toEqual(['onboarding', 'scheduling']);
  });

  it('returns email-configured routes for send_email', () => {
    const cats = eligibleRoutesFor('send_email', ROUTES).map((r) => r.category);
    // inactive_route has an email but is_active=false; eligibleRoutesFor
    // does not check is_active because UI loaders already filter by it.
    // Here ROUTES contains inactive_route to assert resolveEmailRoute
    // behavior; for eligibility the function is action-type only.
    expect(cats.sort()).toEqual(['inactive_route', 'onboarding', 'scheduling']);
  });

  it('excludes routes lacking the action-relevant config', () => {
    // general has neither SMS nor email config
    expect(eligibleRoutesFor('send_sms', [ROUTES[0]])).toEqual([]);
    expect(eligibleRoutesFor('send_email', [ROUTES[0]])).toEqual([]);
  });

  it('returns [] for unknown action types', () => {
    expect(eligibleRoutesFor('create_task', ROUTES)).toEqual([]);
    expect(eligibleRoutesFor(undefined, ROUTES)).toEqual([]);
  });

  it('returns [] when routes is not an array', () => {
    expect(eligibleRoutesFor('send_sms', null)).toEqual([]);
  });
});
