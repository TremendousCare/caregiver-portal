import { describe, it, expect } from 'vitest';
import {
  buildAuthorizeUrl,
  parseTokenResponse,
  expiriesFromTokenResponse,
  QB_AUTH_BASE_URL,
  QB_TOKEN_URL,
  QB_DEFAULT_SCOPES,
} from '../../../supabase/functions/_shared/helpers/quickbooks.ts';

describe('QuickBooks OAuth helpers (shared between init/callback/refresh-cron)', () => {
  describe('constants', () => {
    it('points at Intuit appcenter for authorize', () => {
      expect(QB_AUTH_BASE_URL).toBe('https://appcenter.intuit.com/connect/oauth2');
    });

    it('points at the platform token endpoint for code exchange', () => {
      expect(QB_TOKEN_URL).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens');
    });

    it('requests accounting + identity scopes by default — and intentionally not payments', () => {
      expect(QB_DEFAULT_SCOPES).toContain('com.intuit.quickbooks.accounting');
      expect(QB_DEFAULT_SCOPES).toContain('openid');
      expect(QB_DEFAULT_SCOPES).toContain('profile');
      expect(QB_DEFAULT_SCOPES).toContain('email');
      // Payments scope deliberately not included; see CLAUDE.md
      // discussion + chat decision on 2026-05-29.
      expect(QB_DEFAULT_SCOPES).not.toContain('com.intuit.quickbooks.payment');
    });

    it('cannot be mutated by callers', () => {
      // Object.freeze on a const array is the cheapest guard against
      // a refactor that pushes 'com.intuit.quickbooks.payment' into
      // the default scope set without an explicit decision.
      expect(() => {
        QB_DEFAULT_SCOPES.push('com.intuit.quickbooks.payment');
      }).toThrow();
    });
  });

  describe('buildAuthorizeUrl', () => {
    const baseOpts = {
      clientId: 'AB_test_client_id_123',
      redirectUri: 'https://example.supabase.co/functions/v1/quickbooks-oauth-callback',
      state: '11111111-2222-3333-4444-555555555555',
    };

    it('produces a URL pointing at Intuit appcenter', () => {
      const url = buildAuthorizeUrl(baseOpts);
      expect(url.startsWith(QB_AUTH_BASE_URL + '?')).toBe(true);
    });

    it('embeds client_id, response_type=code, redirect_uri, state and default scopes', () => {
      const url = new URL(buildAuthorizeUrl(baseOpts));
      expect(url.searchParams.get('client_id')).toBe(baseOpts.clientId);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('redirect_uri')).toBe(baseOpts.redirectUri);
      expect(url.searchParams.get('state')).toBe(baseOpts.state);
      const scope = url.searchParams.get('scope');
      expect(scope).toBe(QB_DEFAULT_SCOPES.join(' '));
    });

    it('honors a custom scope set when explicitly passed', () => {
      const url = new URL(
        buildAuthorizeUrl({ ...baseOpts, scopes: ['com.intuit.quickbooks.accounting'] }),
      );
      expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    });

    it('URL-encodes the redirect_uri so registered URIs with special chars round-trip', () => {
      const tricky = 'https://example.com/cb?foo=bar&baz=qux';
      const url = new URL(buildAuthorizeUrl({ ...baseOpts, redirectUri: tricky }));
      // URLSearchParams handles the encoding for us; the round-trip
      // through .get must return the exact original string.
      expect(url.searchParams.get('redirect_uri')).toBe(tricky);
    });
  });

  describe('parseTokenResponse', () => {
    const validRaw = {
      access_token: 'eyJ.access.tok',
      refresh_token: 'AB1.refresh.tok',
      expires_in: 3600,
      x_refresh_token_expires_in: 8640000,
      token_type: 'bearer',
    };

    it('accepts a well-formed Intuit response', () => {
      expect(parseTokenResponse(validRaw)).toMatchObject(validRaw);
    });

    it('defaults token_type to bearer when omitted', () => {
      const { token_type: _omit, ...rest } = validRaw;
      const parsed = parseTokenResponse(rest);
      expect(parsed.token_type).toBe('bearer');
    });

    it.each([
      ['non-object payload', 'not an object'],
      ['null payload', null],
    ])('rejects %s', (_label, raw) => {
      expect(() => parseTokenResponse(raw)).toThrow(/not an object/);
    });

    it.each([
      ['access_token', { ...validRaw, access_token: '' }, /access_token/],
      ['refresh_token', { ...validRaw, refresh_token: undefined }, /refresh_token/],
      ['expires_in (zero)', { ...validRaw, expires_in: 0 }, /expires_in/],
      [
        'x_refresh_token_expires_in (string)',
        { ...validRaw, x_refresh_token_expires_in: '8640000' },
        /x_refresh_token_expires_in/,
      ],
    ])('throws when %s is missing or invalid', (_label, raw, pattern) => {
      expect(() => parseTokenResponse(raw)).toThrow(pattern);
    });
  });

  describe('expiriesFromTokenResponse', () => {
    it('returns absolute timestamps offset from the injectable now', () => {
      const now = new Date('2026-05-29T12:00:00Z').getTime();
      const { accessExpiresAt, refreshExpiresAt } = expiriesFromTokenResponse(
        { expires_in: 3600, x_refresh_token_expires_in: 8640000 },
        now,
      );
      expect(accessExpiresAt.toISOString()).toBe('2026-05-29T13:00:00.000Z');
      // 8,640,000s = 100 days.
      expect(refreshExpiresAt.toISOString()).toBe('2026-09-06T12:00:00.000Z');
    });

    it('defaults nowMs to Date.now when omitted', () => {
      const before = Date.now();
      const { accessExpiresAt } = expiriesFromTokenResponse({
        expires_in: 60,
        x_refresh_token_expires_in: 600,
      });
      const after = Date.now();
      const t = accessExpiresAt.getTime();
      expect(t).toBeGreaterThanOrEqual(before + 60_000);
      expect(t).toBeLessThanOrEqual(after + 60_000);
    });
  });
});
