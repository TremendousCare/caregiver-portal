import { describe, it, expect } from 'vitest';
import { resolveMailbox } from '../mailboxResolver';

describe('resolveMailbox', () => {
  const GLOBAL = 'system@tremendouscareca.com';

  it('uses the per-admin mailbox_email override when present', () => {
    expect(
      resolveMailbox({
        adminEmail: 'daniela.hernandez@tremendouscareca.com',
        userRolesRow: { mailbox_email: 'daniela.hernandez@tremendouscareca.com' },
        globalMailbox: GLOBAL,
      }),
    ).toBe('daniela.hernandez@tremendouscareca.com');
  });

  it('falls back to the admin login email when no mailbox_email override', () => {
    expect(
      resolveMailbox({
        adminEmail: 'Kevin.Nash@tremendouscareca.com',
        userRolesRow: { mailbox_email: null },
        globalMailbox: GLOBAL,
      }),
    ).toBe('kevin.nash@tremendouscareca.com');
  });

  it('accepts a raw admin email not found in user_roles (system callers)', () => {
    expect(
      resolveMailbox({
        adminEmail: 'outsider@example.com',
        userRolesRow: null,
        globalMailbox: GLOBAL,
      }),
    ).toBe('outsider@example.com');
  });

  it('falls back to the global mailbox when no adminEmail is passed', () => {
    expect(
      resolveMailbox({ adminEmail: null, userRolesRow: null, globalMailbox: GLOBAL }),
    ).toBe(GLOBAL);
  });

  it('returns null when no adminEmail and no usable global mailbox', () => {
    expect(
      resolveMailbox({ adminEmail: null, userRolesRow: null, globalMailbox: '' }),
    ).toBeNull();
    expect(
      resolveMailbox({ adminEmail: null, userRolesRow: null, globalMailbox: 'not-an-email' }),
    ).toBeNull();
  });

  it('lowercases and trims mailbox addresses', () => {
    expect(
      resolveMailbox({
        adminEmail: '  Daniela.Hernandez@TremendousCareCA.com  ',
        userRolesRow: { mailbox_email: '  Daniela.Hernandez@TremendousCareCA.com  ' },
        globalMailbox: GLOBAL,
      }),
    ).toBe('daniela.hernandez@tremendouscareca.com');
  });

  it('ignores empty string admin_email and uses global fallback', () => {
    expect(
      resolveMailbox({ adminEmail: '', userRolesRow: null, globalMailbox: GLOBAL }),
    ).toBe(GLOBAL);
  });
});
