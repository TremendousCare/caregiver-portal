// Structural assertions on migration 20260524000000.
//
// Adds system_default_tasks (universal recurring tasks per org) and a
// sibling FK column on care_plan_observations. These invariants are
// easy to drop in a future refactor; this spec locks them in.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260524000000_system_default_tasks.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260524000000_system_default_tasks_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('system_default_tasks migration', () => {
  describe('system_default_tasks table', () => {
    it('is created idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.system_default_tasks/);
    });

    it('carries NOT NULL org_id with FK + default_org_id() default (Prime Directive #2)', () => {
      expect(sql).toMatch(
        /system_default_tasks[\s\S]*?org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s*\n?\s*REFERENCES public\.organizations\(id\)/,
      );
      expect(sql).toMatch(/idx_system_default_tasks_org/);
    });

    it('mirrors the care_plan_tasks shape (so the runtime union is trivial)', () => {
      expect(sql).toMatch(/category\s+text NOT NULL/);
      expect(sql).toMatch(/task_name\s+text NOT NULL/);
      expect(sql).toMatch(/shifts\s+text\[\] NOT NULL DEFAULT ARRAY\['all'\]::text\[\]/);
      expect(sql).toMatch(/days_of_week\s+int\[\] NOT NULL DEFAULT ARRAY\[\]::int\[\]/);
      expect(sql).toMatch(/priority\s+text NOT NULL DEFAULT 'standard'/);
      expect(sql).toMatch(/CHECK \(priority IN \('critical', 'standard', 'optional'\)\)/);
    });

    it('adds is_active (so admins can disable a default without losing history)', () => {
      expect(sql).toMatch(/is_active\s+boolean NOT NULL DEFAULT true/);
    });

    it('UNIQUE (org_id, task_name) makes the seed idempotent', () => {
      expect(sql).toMatch(/UNIQUE \(org_id, task_name\)/);
    });

    it('reuses the public.touch_updated_at() trigger helper', () => {
      expect(sql).toMatch(
        /system_default_tasks_touch_updated_at[\s\S]*?EXECUTE FUNCTION public\.touch_updated_at\(\)/,
      );
    });
  });

  describe('care_plan_observations sibling column', () => {
    it('adds system_default_task_id as a nullable FK with ON DELETE SET NULL', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.care_plan_observations[\s\S]*?ADD COLUMN IF NOT EXISTS system_default_task_id uuid[\s\S]*?REFERENCES public\.system_default_tasks\(id\) ON DELETE SET NULL/,
      );
    });

    it('adds the XOR CHECK constraint (task_id and system_default_task_id never both set)', () => {
      expect(sql).toMatch(/care_plan_observations_task_source_xor/);
      expect(sql).toMatch(/CHECK \(task_id IS NULL OR system_default_task_id IS NULL\)/);
    });

    it('CHECK addition is idempotent via a pg_constraint guard', () => {
      // The CHECK has no IF NOT EXISTS form, so the migration wraps
      // the ALTER in a DO block that checks pg_constraint first.
      // Catches accidental hard-fail on re-run.
      expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint[\s\S]*?conname = 'care_plan_observations_task_source_xor'/);
    });

    it('indexes system_default_task_id for the indexLatestTaskCompletions lookup', () => {
      expect(sql).toMatch(/idx_care_plan_observations_system_default_task/);
    });
  });

  describe('RLS', () => {
    it('enables RLS on system_default_tasks', () => {
      expect(sql).toMatch(/ALTER TABLE public\.system_default_tasks ENABLE ROW LEVEL SECURITY/);
    });

    it('SELECT is gated on org_id match only (caregivers AND staff can read)', () => {
      expect(sql).toMatch(
        /system_default_tasks_authenticated_select[\s\S]*?FOR SELECT[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
      );
      // Caregivers see system defaults too — there should NOT be an
      // is_staff() check on the SELECT policy.
      const selectPolicy = sql.match(/system_default_tasks_authenticated_select[\s\S]*?(?=DROP POLICY|CREATE POLICY system_default_tasks_staff_)/);
      expect(selectPolicy).toBeTruthy();
      expect(selectPolicy[0]).not.toMatch(/public\.is_staff\(\)/);
    });

    it('writes are gated on is_staff() + tenant org match', () => {
      for (const cmd of ['insert', 'update', 'delete']) {
        const policy = new RegExp(`system_default_tasks_staff_${cmd}[\\s\\S]*?public\\.is_staff\\(\\)[\\s\\S]*?org_id = nullif\\(\\(auth\\.jwt\\(\\) ->> 'org_id'\\), ''\\)::uuid`);
        expect(sql).toMatch(policy);
      }
    });

    it('no inline EXISTS subqueries (RLS recursion gotcha)', () => {
      expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+user_roles/);
    });
  });

  describe('seed', () => {
    it('seeds the three canonical defaults per org', () => {
      // Each seed is a SELECT-from-organizations so future orgs get
      // the defaults automatically when added.
      for (const name of ['Hand hygiene', 'Caregiver break', 'Caregiver lunch']) {
        expect(sql).toContain(name);
      }
    });

    it('hand hygiene is critical (infection control), break/lunch are standard', () => {
      expect(sql).toMatch(/'Hand hygiene'[\s\S]*?'critical'/);
      expect(sql).toMatch(/'Caregiver break'[\s\S]*?'standard'/);
      expect(sql).toMatch(/'Caregiver lunch'[\s\S]*?'standard'/);
    });

    it('every seed uses ON CONFLICT DO NOTHING (idempotent)', () => {
      const conflicts = sql.match(/ON CONFLICT \(org_id, task_name\) DO NOTHING/g);
      expect(conflicts).toHaveLength(3);
    });

    it('uses caregiver.* category prefix (distinct from adl.* / iadl.*)', () => {
      expect(sql).toContain("'caregiver.hygiene'");
      expect(sql).toContain("'caregiver.break'");
      expect(sql).toContain("'caregiver.lunch'");
    });
  });

  describe('sanity check', () => {
    it('verifies the seed count post-migration (loud failure on regression)', () => {
      expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*?expected 3 seeded defaults/);
    });

    it('skips gracefully when default_org_id() returns NULL (non-prod sandboxes)', () => {
      expect(sql).toMatch(/RAISE NOTICE[\s\S]*?default_org_id\(\) returned NULL/);
    });
  });

  describe('rollback', () => {
    it('drops the policies, the CHECK, the sibling column, and the table', () => {
      expect(rollbackSql).toContain('system_default_tasks_authenticated_select');
      expect(rollbackSql).toContain('system_default_tasks_staff_insert');
      expect(rollbackSql).toContain('care_plan_observations_task_source_xor');
      expect(rollbackSql).toMatch(/DROP COLUMN IF EXISTS system_default_task_id/);
      expect(rollbackSql).toMatch(/DROP TABLE IF EXISTS public\.system_default_tasks/);
    });

    it('drops the CHECK constraint before the column (avoids dangling constraint)', () => {
      const checkIdx = rollbackSql.indexOf('DROP CONSTRAINT IF EXISTS care_plan_observations_task_source_xor');
      const colIdx = rollbackSql.indexOf('DROP COLUMN IF EXISTS system_default_task_id');
      expect(checkIdx).toBeGreaterThanOrEqual(0);
      expect(colIdx).toBeGreaterThan(checkIdx);
    });
  });
});
