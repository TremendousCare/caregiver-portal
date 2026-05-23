// Structural assertions on the org-settings-update edge function's
// new lead_notifications section validator (PR 2 of the lead-notif
// feature).
//
// The edge function whitelists known sections + per-key validators;
// this spec locks in that the lead_notifications section is registered
// with the right keys and validation rules. A keys-list regression
// (e.g. dropping `teams_webhook_url` accidentally) breaks the Settings
// UI saves silently — these checks catch that early.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EDGE_FN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/functions/org-settings-update/index.ts',
);

describe('org-settings-update: lead_notifications section validator', () => {
  const source = readFileSync(EDGE_FN_PATH, 'utf-8');

  it('registers lead_notifications in SECTION_SCHEMAS', () => {
    expect(source).toMatch(/lead_notifications:\s*LEAD_NOTIFICATIONS_KEYS/);
  });

  it('declares a LEAD_NOTIFICATIONS_KEYS validator map', () => {
    expect(source).toMatch(
      /const LEAD_NOTIFICATIONS_KEYS:\s*Record<string,\s*\(v:\s*unknown\)\s*=>\s*boolean>\s*=/,
    );
  });

  describe('per-key validators', () => {
    it('enabled is validated as boolean', () => {
      expect(source).toMatch(/enabled:\s*isBoolean/);
    });

    it('sms_recipient_emails is validated as email array', () => {
      expect(source).toMatch(/sms_recipient_emails:\s*isEmailArray/);
    });

    it('teams_webhook_url is validated as HTTPS URL or empty string', () => {
      expect(source).toMatch(/teams_webhook_url:\s*isHttpsUrlOrEmpty/);
    });

    it('toast_recipient_emails is validated as email array', () => {
      expect(source).toMatch(/toast_recipient_emails:\s*isEmailArray/);
    });

    it('quiet_hours_start_hour is validated as 0-23 integer', () => {
      expect(source).toMatch(/quiet_hours_start_hour:\s*isHourNumber/);
    });

    it('quiet_hours_end_hour is validated as 0-23 integer', () => {
      expect(source).toMatch(/quiet_hours_end_hour:\s*isHourNumber/);
    });

    it('quiet_hours_timezone is validated as IANA tz string', () => {
      expect(source).toMatch(/quiet_hours_timezone:\s*isIanaTimezone/);
    });
  });

  describe('validator implementations', () => {
    it('isHourNumber rejects values outside 0..23 inclusive', () => {
      expect(source).toMatch(/function isHourNumber[\s\S]*?v >= 0 && v <= 23/);
    });

    it('isHttpsUrlOrEmpty accepts empty string explicitly', () => {
      expect(source).toMatch(/function isHttpsUrlOrEmpty[\s\S]*?if \(v === ""\) return true/);
    });

    it('isHttpsUrlOrEmpty requires https:// prefix', () => {
      expect(source).toMatch(/function isHttpsUrlOrEmpty[\s\S]*?\^https:\\\/\\\//);
    });

    it('isEmailArray rejects empty strings and non-string entries', () => {
      expect(source).toMatch(/function isEmailArray[\s\S]*?Array\.isArray\(v\)/);
      expect(source).toMatch(/function isEmailArray[\s\S]*?typeof s === "string"/);
      expect(source).toMatch(/function isEmailArray[\s\S]*?\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$/);
    });

    it('isIanaTimezone allows UTC as an explicit special case', () => {
      expect(source).toMatch(/function isIanaTimezone[\s\S]*?v === "UTC"/);
    });
  });

  it('does not leak the previously-defined isStringArray helper that was unused', () => {
    // Defensive: if a future PR re-adds it without using it, the test
    // signals dead code review needed.
    expect(source).not.toMatch(/function isStringArray\b/);
  });
});
