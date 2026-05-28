// Structural assertions on migration 20260528000000_exec_owner_role.
//
// Locks in: CHECK-constraint expansion on both role tables, owner
// backfill targeting the right three emails, is_admin/is_staff
// updated to include 'owner', new is_owner() helper has the right
// shape, sanity DO block fails the deploy when something is missing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260528000000_exec_owner_role.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260528000000_exec_owner_role_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('exec_owner_role migration', () => {
  describe('CHECK constraint expansion', () => {
    it('expands user_roles.role to allow owner', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.user_roles[\s\S]*?ADD CONSTRAINT user_roles_role_check\s+CHECK \(role IN \('admin', 'member', 'owner'\)\)/,
      );
    });

    it('expands org_memberships.role to allow owner', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.org_memberships[\s\S]*?ADD CONSTRAINT org_memberships_role_check\s+CHECK \(role IN \('admin', 'member', 'owner', 'caregiver'\)\)/,
      );
    });

    it('drops each constraint first (idempotent)', () => {
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS user_roles_role_check/);
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS org_memberships_role_check/);
    });
  });

  describe('owner backfill', () => {
    it('promotes the three correct emails in user_roles', () => {
      expect(sql).toMatch(/UPDATE public\.user_roles[\s\S]*?SET role = 'owner'/);
      expect(sql).toMatch(/'nashkevi1@gmail\.com'/);
      expect(sql).toMatch(/'kevinnash@tremendouscareca\.com'/);
      expect(sql).toMatch(/'blertanash@tremendouscareca\.com'/);
    });

    it('promotes through org_memberships via auth.users join', () => {
      expect(sql).toMatch(
        /UPDATE public\.org_memberships m[\s\S]*?SET role = 'owner'[\s\S]*?FROM auth\.users u[\s\S]*?WHERE m\.user_id = u\.id/,
      );
    });

    it('uses lower() so case-mismatched emails still backfill', () => {
      // Both update statements lower the email before matching
      const userRolesUpdate = sql.match(/UPDATE public\.user_roles[\s\S]*?(?=UPDATE|CREATE OR REPLACE)/)?.[0] ?? '';
      const orgMembershipsUpdate = sql.match(/UPDATE public\.org_memberships[\s\S]*?(?=CREATE OR REPLACE)/)?.[0] ?? '';
      expect(userRolesUpdate).toMatch(/lower\(email\)/);
      expect(orgMembershipsUpdate).toMatch(/lower\(u\.email\)/);
    });
  });

  describe('is_admin update', () => {
    it('now matches role IN (admin, owner)', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.is_admin\(\)[\s\S]*?role IN \('admin', 'owner'\)/,
      );
    });

    it('keeps STABLE SECURITY DEFINER with pinned search_path (RLS_GOTCHAS rule 1)', () => {
      const isAdminBlock = sql.match(/CREATE OR REPLACE FUNCTION public\.is_admin\(\)[\s\S]*?\$\$;/)?.[0] ?? '';
      expect(isAdminBlock).toMatch(/STABLE/);
      expect(isAdminBlock).toMatch(/SECURITY DEFINER/);
      expect(isAdminBlock).toMatch(/SET search_path TO 'public'/);
    });
  });

  describe('is_staff update', () => {
    it('now matches role IN (admin, member, owner)', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.is_staff\(\)[\s\S]*?role IN \('admin', 'member', 'owner'\)/,
      );
    });

    it('keeps STABLE SECURITY DEFINER with pinned search_path', () => {
      const isStaffBlock = sql.match(/CREATE OR REPLACE FUNCTION public\.is_staff\(\)[\s\S]*?\$\$;/)?.[0] ?? '';
      expect(isStaffBlock).toMatch(/STABLE/);
      expect(isStaffBlock).toMatch(/SECURITY DEFINER/);
      expect(isStaffBlock).toMatch(/SET search_path TO 'public'/);
    });
  });

  describe('is_owner helper', () => {
    it('is created STABLE SECURITY DEFINER per RLS_GOTCHAS rule 1', () => {
      const isOwnerBlock = sql.match(/CREATE OR REPLACE FUNCTION public\.is_owner\(\)[\s\S]*?\$\$;/)?.[0] ?? '';
      expect(isOwnerBlock).toMatch(/STABLE/);
      expect(isOwnerBlock).toMatch(/SECURITY DEFINER/);
      expect(isOwnerBlock).toMatch(/SET search_path TO 'public'/);
    });

    it("matches role = 'owner' exactly", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.is_owner\(\)[\s\S]*?role = 'owner'/,
      );
    });

    it('revokes PUBLIC and grants authenticated + service_role', () => {
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.is_owner\(\) FROM PUBLIC/);
      expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.is_owner\(\) TO authenticated, service_role/);
    });
  });

  describe('sanity checks', () => {
    it('asserts is_owner exists and is SECURITY DEFINER', () => {
      expect(sql).toMatch(/proname = 'is_owner'[\s\S]*?prosecdef = true/);
    });

    it('verifies is_admin and is_staff are still STABLE SECURITY DEFINER', () => {
      expect(sql).toMatch(/proname = 'is_admin'[\s\S]*?prosecdef = true[\s\S]*?provolatile = 's'/);
      expect(sql).toMatch(/proname = 'is_staff'[\s\S]*?prosecdef = true[\s\S]*?provolatile = 's'/);
    });
  });

  describe('rollback', () => {
    it('downgrades owners back to admin in both tables', () => {
      expect(rollbackSql).toMatch(/UPDATE public\.user_roles[\s\S]*?SET role = 'admin'[\s\S]*?WHERE role = 'owner'/);
      expect(rollbackSql).toMatch(/UPDATE public\.org_memberships[\s\S]*?SET role = 'admin'[\s\S]*?WHERE role = 'owner'/);
    });

    it('drops is_owner', () => {
      expect(rollbackSql).toMatch(/DROP FUNCTION IF EXISTS public\.is_owner\(\)/);
    });

    it('restores the pre-migration shape of is_admin and is_staff', () => {
      expect(rollbackSql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.is_admin\(\)[\s\S]*?role = 'admin'/,
      );
      expect(rollbackSql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.is_staff\(\)[\s\S]*?role IN \('admin', 'member'\)/,
      );
    });

    it('restores the original CHECK constraints', () => {
      expect(rollbackSql).toMatch(/CHECK \(role IN \('admin', 'member'\)\)/);
      expect(rollbackSql).toMatch(/CHECK \(role IN \('admin', 'member', 'caregiver'\)\)/);
    });

    it('demotes BEFORE tightening the CHECK so the update does not violate the constraint', () => {
      const demoteIndex = rollbackSql.indexOf("SET role = 'admin'");
      const tightenIndex = rollbackSql.search(/ADD CONSTRAINT user_roles_role_check/);
      expect(demoteIndex).toBeGreaterThan(-1);
      expect(tightenIndex).toBeGreaterThan(-1);
      expect(demoteIndex).toBeLessThan(tightenIndex);
    });
  });
});
