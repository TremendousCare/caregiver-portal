// Structural assertions on the lead-notification default-settings seed
// migration (PR 2 of the lead-notif feature).
//
// The migration pre-populates organizations.settings.lead_notifications
// for every org. For Tremendous Care specifically, it pre-fills the
// toast recipient list with the three users the owner named for V1.
// These checks lock in those defaults so a future PR doesn't quietly
// regress them.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260523000100_lead_notifications_default_settings.sql',
);

// Strip SQL line comments before structural matching so words in
// commentary (e.g. "Additive only — no DROP") don't trip whole-word
// assertions about the executable statements.
function stripComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

describe('lead notification default settings migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');
  const sqlStatements = stripComments(sql);

  it('defaults `enabled` to false so nothing fires until an admin opts in', () => {
    // Match in either the TC default block or the generic default block.
    expect(sql).toMatch(/'enabled',\s*false/);
  });

  describe('Tremendous Care defaults', () => {
    it('pre-populates Amy Dutton as a toast recipient', () => {
      expect(sql).toMatch(/'amy\.dutton@tremendouscareca\.com'/);
    });

    it('pre-populates Kevin Nash as a toast recipient', () => {
      expect(sql).toMatch(/'kevinnash@tremendouscareca\.com'/);
    });

    it('pre-populates Blerta Nash as a toast recipient', () => {
      expect(sql).toMatch(/'blertanash@tremendouscareca\.com'/);
    });

    it('targets the Tremendous Care org by slug, never by hardcoded UUID', () => {
      expect(sql).toMatch(/slug = 'tremendous-care'/);
      expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });
  });

  describe('quiet-hours defaults', () => {
    it('defaults quiet hours to 21:00 (9pm)', () => {
      expect(sql).toMatch(/'quiet_hours_start_hour',\s*21/);
    });

    it('defaults quiet-end hour to 7:00 (7am)', () => {
      expect(sql).toMatch(/'quiet_hours_end_hour',\s*7/);
    });

    it('defaults timezone to America/Los_Angeles', () => {
      expect(sql).toMatch(/'quiet_hours_timezone',\s*'America\/Los_Angeles'/);
    });
  });

  describe('idempotency', () => {
    it('merges defaults with existing values such that existing values win on conflict', () => {
      // The merge order is `default || existing` — right side wins on
      // duplicate keys in jsonb concat. That's the contract: re-running
      // the seed only fills missing keys, never overwrites edits.
      expect(sql).toMatch(/v_tc_default\s*\|\|\s*v_existing/);
      expect(sql).toMatch(/v_generic_default\s*\|\|\s*v_existing/);
    });

    it('skips the UPDATE when the merged value matches existing', () => {
      expect(sql).toMatch(/IF v_new <> v_existing THEN/);
    });

    it('uses jsonb concat, not jsonb_set, so the lead_notifications block is overwritten as a whole when needed', () => {
      expect(sql).toMatch(/jsonb_build_object\('lead_notifications', v_new\)/);
    });
  });

  it('aborts the migration if the Tremendous Care org is missing the block after seed', () => {
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]+?tremendous-care org is missing lead_notifications/);
  });

  it('is additive only — no DROP / DELETE / TRUNCATE in executable SQL', () => {
    expect(sqlStatements).not.toMatch(/\bDROP\b/i);
    expect(sqlStatements).not.toMatch(/\bDELETE FROM\b/i);
    expect(sqlStatements).not.toMatch(/\bTRUNCATE\b/i);
  });
});
