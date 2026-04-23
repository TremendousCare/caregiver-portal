import { describe, it, expect } from 'vitest';
import { getOrgClaims } from '../supabase';

// ─── Helpers ──────────────────────────────────────────────────
// Build a JWT-shaped string. Signature portion is irrelevant —
// getOrgClaims never verifies; it only parses the payload.
function toBase64Url(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeToken(payloadObj, { badPayload = null } = {}) {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = badPayload !== null
    ? badPayload
    : toBase64Url(JSON.stringify(payloadObj));
  const signature = 'sig';
  return `${header}.${payload}.${signature}`;
}

function sessionWith(token) {
  return { access_token: token };
}

// ─── Tests ────────────────────────────────────────────────────
describe('getOrgClaims', () => {
  it('returns all three claims on a well-formed JWT', () => {
    const token = makeToken({
      sub: 'user-uuid',
      email: 'a@b.com',
      org_id: '11111111-2222-3333-4444-555555555555',
      org_slug: 'tremendous-care',
      org_role: 'admin',
    });
    const claims = getOrgClaims(sessionWith(token));
    expect(claims).toEqual({
      orgId: '11111111-2222-3333-4444-555555555555',
      orgSlug: 'tremendous-care',
      orgRole: 'admin',
    });
  });

  it('returns nulls when the session is null or undefined', () => {
    const empty = { orgId: null, orgSlug: null, orgRole: null };
    expect(getOrgClaims(null)).toEqual(empty);
    expect(getOrgClaims(undefined)).toEqual(empty);
    expect(getOrgClaims({})).toEqual(empty);
  });

  it('returns nulls when access_token is missing or non-string', () => {
    const empty = { orgId: null, orgSlug: null, orgRole: null };
    expect(getOrgClaims({ access_token: null })).toEqual(empty);
    expect(getOrgClaims({ access_token: 12345 })).toEqual(empty);
    expect(getOrgClaims({ access_token: '' })).toEqual(empty);
  });

  it('returns nulls when the JWT does not have three parts', () => {
    const empty = { orgId: null, orgSlug: null, orgRole: null };
    expect(getOrgClaims(sessionWith('not-a-jwt'))).toEqual(empty);
    expect(getOrgClaims(sessionWith('one.two'))).toEqual(empty);
    expect(getOrgClaims(sessionWith('a.b.c.d'))).toEqual(empty);
  });

  it('returns nulls when the payload is not valid base64', () => {
    const token = makeToken(null, { badPayload: '!!!not base64!!!' });
    expect(getOrgClaims(sessionWith(token))).toEqual({
      orgId: null, orgSlug: null, orgRole: null,
    });
  });

  it('returns nulls when the decoded payload is not valid JSON', () => {
    const token = makeToken(null, { badPayload: toBase64Url('not json{') });
    expect(getOrgClaims(sessionWith(token))).toEqual({
      orgId: null, orgSlug: null, orgRole: null,
    });
  });

  it('returns nulls for all three when the payload has no org claims', () => {
    const token = makeToken({ sub: 'u', email: 'a@b.com' });
    expect(getOrgClaims(sessionWith(token))).toEqual({
      orgId: null, orgSlug: null, orgRole: null,
    });
  });

  it('returns only the claims that are present', () => {
    const token = makeToken({
      sub: 'u',
      org_id: 'abc-123',
    });
    expect(getOrgClaims(sessionWith(token))).toEqual({
      orgId: 'abc-123',
      orgSlug: null,
      orgRole: null,
    });
  });

  it('tolerates base64url payloads that need padding', () => {
    // A payload whose base64 encoding is not a multiple of 4 chars
    // after stripping padding — exercises the `===`.slice() path.
    const token = makeToken({ org_id: 'x', org_slug: 'y', org_role: 'z' });
    const claims = getOrgClaims(sessionWith(token));
    expect(claims.orgId).toBe('x');
    expect(claims.orgSlug).toBe('y');
    expect(claims.orgRole).toBe('z');
  });

  it('does not throw on any malformed input', () => {
    expect(() => getOrgClaims(sessionWith('.'))).not.toThrow();
    expect(() => getOrgClaims(sessionWith('..'))).not.toThrow();
    expect(() => getOrgClaims({ access_token: {} })).not.toThrow();
  });
});
