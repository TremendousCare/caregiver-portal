import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on Amy Dutton's communication-setup seed.
// The migration carries her live RingCentral extension ID and her
// auth.uid; if an edit accidentally swaps either of those, inbound
// call screen-pops would route to the wrong user. These specs
// catch that class of regression before deploy.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260518000000_seed_amy_dutton_communication_setup.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260518000000_seed_amy_dutton_communication_setup_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('Amy Dutton communication-setup seed migration', () => {
  describe('user_roles', () => {
    it('inserts Amy with her tremendouscareca.com email (lowercase)', () => {
      expect(sql).toMatch(/INSERT INTO public\.user_roles[\s\S]*'amy\.dutton@tremendouscareca\.com'/);
    });

    it("assigns role 'member' (not admin) and her own mailbox_email", () => {
      expect(sql).toMatch(/'amy\.dutton@tremendouscareca\.com',\s*'member',\s*'amy\.dutton@tremendouscareca\.com'/);
    });

    it('uses ON CONFLICT DO UPDATE so re-runs do not overwrite an admin-promotion done in the UI', () => {
      expect(sql).toMatch(/ON CONFLICT \(email\) DO UPDATE[\s\S]*COALESCE\(public\.user_roles\.role, EXCLUDED\.role\)/);
    });
  });

  describe('team_members', () => {
    it('inserts a directory row with display name "Amy Dutton" and BD job title', () => {
      expect(sql).toMatch(/'Amy Dutton',\s*'Business Development Representative'/);
    });

    it('stores her RingCentral phone number 949-867-1046 in personal_phone', () => {
      // Format-agnostic: accept any layout as long as the digits match.
      const digits = sql.replace(/\D/g, '');
      expect(digits).toContain('9498671046');
    });

    it('scopes the row to public.default_org_id() (multi-tenant requirement)', () => {
      expect(sql).toMatch(/public\.default_org_id\(\)/);
    });
  });

  describe('org_memberships', () => {
    it("references Amy's known auth.uid (matches the South OC territory seed)", () => {
      expect(sql).toContain('9228e867-30ca-4294-985b-871a994cc5fc');
    });

    it('sets her ringcentral_extension_id to the live RC user ID 62957689016', () => {
      expect(sql).toMatch(/ringcentral_extension_id\s*=\s*'62957689016'/);
    });

    it("bumps her org_memberships.role from the trigger-default 'caregiver' to 'member'", () => {
      expect(sql).toMatch(/role\s*=\s*'member'/);
    });

    it('guards the UPDATE behind an auth.users existence check so fresh dev DBs do not hard-fail', () => {
      expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM auth\.users WHERE id = v_user_id\)/);
    });
  });

  describe('rollback', () => {
    it('exists and references the same migration tag in updated_by', () => {
      expect(rollback).toContain('migration:20260518000000_seed_amy_dutton');
    });

    it('clears the extension binding and resets the role to caregiver', () => {
      expect(rollback).toMatch(/ringcentral_extension_id\s*=\s*NULL/);
      expect(rollback).toMatch(/role\s*=\s*'caregiver'/);
    });

    it("soft-archives team_members rather than DELETEing (production-safety policy)", () => {
      expect(rollback).toMatch(/UPDATE public\.team_members[\s\S]*is_active\s*=\s*false/);
      expect(rollback).not.toMatch(/DELETE FROM public\.team_members/);
    });
  });
});
