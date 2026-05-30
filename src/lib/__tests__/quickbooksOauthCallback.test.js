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
    it('parses Intuit\'s `"error":"..."` field out of the thrown message', () => {
      // The regex must match Intuit's JSON-body error code, allow
      // optional whitespace around the colon (Intuit sometimes
      // formats with no space), and be case-insensitive so a
      // future error string casing change doesn\'t silently break.
      expect(src).toMatch(/msg\.match\(\/"error"\\s\*:\\s\*"\(\[a-z_\]\+\)"\/i\)/);
    });

    it('redirects with `qb_error=intuit_<code>` when Intuit returned a code, otherwise the generic fallback', () => {
      expect(src).toMatch(/intuitErr \? `intuit_\$\{intuitErr\[1\]\}` : "token_exchange_failed"/);
      expect(src).toMatch(/buildRedirect\(portalBase, "qb_error", errorCode\)/);
    });
  });
});
