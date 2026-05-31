import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the OAuth callback edge function.
// Both bugs covered here are real regressions surfaced on
// 2026-05-30 during the live sandbox smoke test:
//
//   1. SETTINGS_PATH was set to "/admin/settings", but the SPA
//      route is `<Route path="settings">` mounted at the root, so
//      the 302 landed on a path the catch-all bounced to `/`,
//      stripping our ?qb=...  query param. The owner saw the
//      OAuth round-trip complete but never got a success or
//      failure toast — connect attempts failed invisibly.
//
//   2. The token-exchange catch always redirected with the same
//      generic `qb_error=token_exchange_failed`, even when Intuit
//      returned a useful `{"error":"invalid_client"|"invalid_grant"
//      |...}` body. With no way to see Intuit's error code, the
//      only diagnostic was a postgres-side dump of vault contents.
//      Surfacing the Intuit code as `qb_error=intuit_<code>` makes
//      the failure self-describing in the URL bar.

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(__dirname, '../../../supabase/functions/quickbooks-oauth-callback/index.ts'),
  'utf-8',
);

describe('QuickBooks OAuth callback edge function', () => {
  describe('SETTINGS_PATH', () => {
    it('points at "/settings" (matches AdminApp.jsx route mount)', () => {
      expect(src).toMatch(/const SETTINGS_PATH = "\/settings";/);
    });

    it('never references the broken "/admin/settings" path again', () => {
      // Comment-only references to /admin/settings are OK in the
      // explanation above; we only care that no JS literal still
      // points there. Strip line comments before checking.
      const code = src
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(code).not.toMatch(/\/admin\/settings/);
    });
  });

  describe('Intuit error code propagation', () => {
    it('parses Intuit\'s `"error":"..."` field with a permissive character set', () => {
      // Some OAuth servers use uppercase or hyphens in error codes
      // (e.g. `invalid-grant`). Lock the widened regex so we can't
      // narrow it back to lowercase-only without a deliberate change.
      expect(src).toMatch(
        /msg\.match\(\/"error"\\s\*:\\s\*"\(\[a-zA-Z0-9_-\]\+\)"\/\)/,
      );
    });

    it('redirects with `qb_error=intuit_<code>` when Intuit returned a code, otherwise the generic fallback', () => {
      expect(src).toMatch(
        /intuitErr \? `intuit_\$\{intuitErr\[1\]\}` : "token_exchange_failed"/,
      );
    });

    it('also attaches `qb_detail` with a truncated Intuit response so the failure is debuggable from the URL bar', () => {
      // The detail is the bit after " — " in the helper's error
      // message (or the whole message if the helper didn't format
      // it that way), capped at 300 chars.
      expect(src).toMatch(/const bodyMatch = msg\.match\(\/ — \(\.\+\)\$\/\);/);
      expect(src).toMatch(/const detail = \(bodyMatch\?\.\[1\] \?\? msg\)\.slice\(0, 300\)/);
      expect(src).toMatch(/dest\.searchParams\.set\("qb_error", errorCode\);/);
      expect(src).toMatch(/dest\.searchParams\.set\("qb_detail", detail\);/);
    });
  });

  describe('redirect helper split', () => {
    it('exposes both buildRedirect and buildRedirectUrl so error paths can attach extra params', () => {
      expect(src).toMatch(/function buildRedirectUrl\(portalBase: string\): URL/);
      expect(src).toMatch(
        /function buildRedirect\(portalBase: string, key: string, value: string\): Response/,
      );
    });
  });
});
