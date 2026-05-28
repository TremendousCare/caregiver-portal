// Structural assertions on migration 20260528000100_exec_staff_members.
//
// Locks in: table shape, org_id discipline, RLS posture (staff read,
// owner write), end_date >= hire_date guard, idempotent seed of
// Kevin and Blerta.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260528000100_exec_staff_members.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260528000100_exec_staff_members_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('exec_staff_members migration', () => {
  describe('table shape', () => {
    it('is created idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.staff_members/);
    });

    it('carries NOT NULL org_id with FK + default_org_id() default', () => {
      expect(sql).toMatch(
        /staff_members[\s\S]*?org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s*\n?\s*REFERENCES public\.organizations\(id\) ON DELETE CASCADE/,
      );
    });

    it('UNIQUE (org_id, email) is the canonical key', () => {
      expect(sql).toMatch(/UNIQUE \(org_id, email\)/);
    });

    it('hire_date NOT NULL, end_date nullable', () => {
      expect(sql).toMatch(/hire_date\s+date NOT NULL/);
      expect(sql).toMatch(/end_date\s+date,/);
    });

    it('guards end_date >= hire_date when present', () => {
      expect(sql).toMatch(/CHECK \(end_date IS NULL OR end_date >= hire_date\)/);
    });

    it('active defaults to true', () => {
      expect(sql).toMatch(/active\s+boolean NOT NULL DEFAULT true/);
    });
  });

  describe('indexes', () => {
    it('has a partial index for active staff lookups', () => {
      expect(sql).toMatch(/idx_staff_members_org_active[\s\S]*?\(org_id, active\)[\s\S]*?WHERE active/);
    });

    it('has a hire_date index for the lifecycle generator', () => {
      expect(sql).toMatch(/idx_staff_members_hire_date[\s\S]*?\(org_id, hire_date\)[\s\S]*?WHERE active/);
    });
  });

  describe('updated_at trigger', () => {
    it('wires touch_updated_at on staff_members', () => {
      expect(sql).toMatch(
        /CREATE TRIGGER staff_members_touch_updated_at[\s\S]*?BEFORE UPDATE ON public\.staff_members[\s\S]*?EXECUTE FUNCTION public\.touch_updated_at\(\)/,
      );
    });
  });

  describe('RLS posture', () => {
    it('enables RLS on the table', () => {
      expect(sql).toMatch(/ALTER TABLE public\.staff_members\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('SELECT gates on is_staff() + org_id (everyone on the team)', () => {
      expect(sql).toMatch(
        /CREATE POLICY staff_members_staff_select[\s\S]*?USING \(public\.is_staff\(\) AND org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid\)/,
      );
    });

    it('INSERT/UPDATE/DELETE gate on is_owner() + org_id', () => {
      ['insert', 'update', 'delete'].forEach((cmd) => {
        const re = new RegExp(`CREATE POLICY staff_members_owner_${cmd}[\\s\\S]*?public\\.is_owner\\(\\) AND org_id = nullif\\(\\(auth\\.jwt\\(\\) ->> 'org_id'\\), ''\\)::uuid`);
        expect(sql).toMatch(re);
      });
    });

    it('drops policies first for idempotent re-runs', () => {
      expect(sql).toMatch(/DROP POLICY IF EXISTS staff_members_staff_select/);
      expect(sql).toMatch(/DROP POLICY IF EXISTS staff_members_owner_insert/);
      expect(sql).toMatch(/DROP POLICY IF EXISTS staff_members_owner_update/);
      expect(sql).toMatch(/DROP POLICY IF EXISTS staff_members_owner_delete/);
    });
  });

  describe('seed', () => {
    it('seeds Kevin', () => {
      expect(sql).toMatch(/INSERT INTO public\.staff_members[\s\S]*?'kevinnash@tremendouscareca\.com'[\s\S]*?'Kevin', 'Nash'/);
    });

    it('seeds Blerta', () => {
      expect(sql).toMatch(/INSERT INTO public\.staff_members[\s\S]*?'blertanash@tremendouscareca\.com'[\s\S]*?'Blerta', 'Nash'/);
    });

    it('seeds are idempotent via ON CONFLICT DO NOTHING', () => {
      const seedBlocks = sql.match(/INSERT INTO public\.staff_members[\s\S]*?ON CONFLICT \(org_id, email\) DO NOTHING/g) ?? [];
      expect(seedBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it('guards against default_org_id() returning NULL during seed', () => {
      expect(sql).toMatch(/WHERE public\.default_org_id\(\) IS NOT NULL/);
    });
  });

  describe('rollback', () => {
    it('drops the table and its policies', () => {
      expect(rollbackSql).toMatch(/DROP TABLE IF EXISTS public\.staff_members/);
      ['select', 'insert', 'update', 'delete'].forEach((cmd) => {
        const re = new RegExp(`DROP POLICY IF EXISTS staff_members_(staff|owner)_${cmd}`);
        expect(rollbackSql).toMatch(re);
      });
    });
  });
});
